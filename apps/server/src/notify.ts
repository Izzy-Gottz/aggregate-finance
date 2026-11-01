import type { Kysely } from 'kysely'
import { nowIso, type CoreTables } from '@agfn/db'
import { mondayEmail, reconnectEmail, refusedEmail, type Mailer } from '@agfn/auth'

/**
 * The Monday note and alerts (MASTER §3): short emails (a plain-text part and a calm HTML part, see @agfn/auth email.ts), sent to owners/admins who haven't turned
 * them off. Runs from the hourly `notify.tick` job; each send is recorded so restarts never send twice.
 */

export interface Digest {
  /** e.g. "Monday note · Oct 12" */
  subject: string
  /** Up to five short lines. */
  lines: string[]
}

export type DigestSource = (workspaceId: string, asOf: Date) => Promise<Digest | null>

export interface NotifyDeps {
  db: Kysely<CoreTables>
  mailer: Mailer
  baseUrl: string
  digest?: DigestSource
  now?: () => Date
}

/** Day of week (1 = Monday … 7 = Sunday), hour and date of an instant in a time zone. */
export function localClock(t: Date, timeZone: string): { weekday: number; hour: number; date: string } {
  let parts: Record<string, string>
  try {
    parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(t)
        .map((p) => [p.type, p.value]),
    )
  } catch {
    return localClock(t, 'America/New_York')
  }
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts['weekday'] ?? '') + 1
  return { weekday, hour: Number(parts['hour']), date: `${parts['year']}-${parts['month']}-${parts['day']}` }
}

/** ISO week key like "2026-W41" (weeks start Monday). */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400_000 + 1) / 7)
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

async function getSetting(db: Kysely<CoreTables>, ws: string, key: string): Promise<unknown> {
  const r = await db.selectFrom('settings').select('value_json').where('workspace_id', '=', ws).where('key', '=', key).executeTakeFirst()
  return r ? JSON.parse(r.value_json) : undefined
}

async function setSetting(db: Kysely<CoreTables>, ws: string, key: string, value: unknown): Promise<void> {
  const value_json = JSON.stringify(value)
  await db
    .insertInto('settings')
    .values({ workspace_id: ws, key, value_json, updated_at: nowIso() })
    .onConflict((oc) => oc.columns(['workspace_id', 'key']).doUpdateSet({ value_json, updated_at: nowIso() }))
    .execute()
}

/**
 * Owners and admins with an email. The Monday note skips anyone who turned it off in Preferences
 * (`prefs:<personId>`.mondayEmail, written by routes/settings.ts); reconnect alerts always go out.
 */
async function recipients(db: Kysely<CoreTables>, ws: string, kind: 'weekly' | 'alert'): Promise<Array<{ personId: string; email: string }>> {
  const rows = await db
    .selectFrom('memberships')
    .innerJoin('people', 'people.id', 'memberships.person_id')
    .select(['people.id as personId', 'people.email as email'])
    .where('memberships.workspace_id', '=', ws)
    .where('memberships.revoked_at', 'is', null)
    .where('memberships.role', 'in', ['owner', 'admin'])
    .execute()
  const out: Array<{ personId: string; email: string }> = []
  for (const r of rows) {
    if (kind === 'weekly') {
      const prefs = (await getSetting(db, ws, `prefs:${r.personId}`)) as { mondayEmail?: boolean } | undefined
      if (prefs?.mondayEmail === false) continue
    }
    out.push(r)
  }
  return out
}


export function createNotifier(deps: NotifyDeps) {
  const now = deps.now ?? (() => new Date())

  /** Sends the Monday note once per ISO week, on Mondays from 08:00 in the workspace's own time zone. */
  async function weekly(): Promise<number> {
    if (!deps.digest) return 0
    const t = now()
    let sent = 0
    const workspaces = await deps.db.selectFrom('workspaces').select(['id', 'time_zone']).execute()
    for (const { id, time_zone } of workspaces) {
      const local = localClock(t, time_zone ?? 'America/New_York')
      if (local.weekday !== 1 || local.hour < 8) continue
      const week = isoWeek(new Date(`${local.date}T12:00:00Z`))
      if ((await getSetting(deps.db, id, 'notify:digest_week')) === week) continue
      const d = await deps.digest(id, t)
      // Record first: a crash after sending must not send again next hour.
      await setSetting(deps.db, id, 'notify:digest_week', week)
      if (!d || d.lines.length === 0) continue
      for (const r of await recipients(deps.db, id, 'weekly')) {
        await deps.mailer.send({ to: r.email, ...mondayEmail({ subject: d.subject, lines: d.lines, baseUrl: deps.baseUrl }) })
        sent++
      }
    }
    return sent
  }

  /** One email per connection when it starts needing a fresh sign-in; resets when it's healthy again. */
  async function connectionAlerts(): Promise<number> {
    let sent = 0
    const rows = await deps.db.selectFrom('connections').select(['id', 'workspace_id', 'display_name', 'status']).where('status', 'in', ['needs_reauth', 'active']).execute()
    for (const c of rows) {
      const key = `notify:reauth:${c.id}`
      const already = (await getSetting(deps.db, c.workspace_id, key)) === true
      if (c.status === 'active') {
        if (already) await deps.db.deleteFrom('settings').where('workspace_id', '=', c.workspace_id).where('key', '=', key).execute()
        continue
      }
      if (already) continue
      await setSetting(deps.db, c.workspace_id, key, true)
      for (const r of await recipients(deps.db, c.workspace_id, 'alert')) {
        await deps.mailer.send({ to: r.email, ...reconnectEmail({ connectionName: c.display_name, connectionId: c.id, baseUrl: deps.baseUrl }) })
        sent++
      }
    }
    return sent
  }

  /**
   * "When an AI asks for something it can't see" (Preferences): one email per AI per day to the person who connected it,
   * listing what it was refused. Reads new `denied` rows from the activity log since the last tick.
   */
  async function blockedAsks(): Promise<number> {
    // activity_log/grants belong to S7's schema; read them untyped so notify doesn't depend on @agfn/mcp.
    const db = deps.db as unknown as Kysely<Record<string, Record<string, unknown>>>
    const today = now().toISOString().slice(0, 10)
    let sent = 0
    const workspaces = await deps.db.selectFrom('workspaces').select('id').execute()
    for (const { id: ws } of workspaces) {
      const last = Number((await getSetting(deps.db, ws, 'notify:blocked_seq')) ?? 0)
      const top = (await db.selectFrom('activity_log').select((eb) => eb.fn.max('seq').as('m')).where('workspace_id', '=', ws).executeTakeFirst()) as { m: number | string | null } | undefined
      const upto = Number(top?.m ?? 0)
      if (upto <= last) continue
      await setSetting(deps.db, ws, 'notify:blocked_seq', upto)
      // First run on an existing workspace: start from now instead of emailing about old history.
      if (last === 0 && (await getSetting(deps.db, ws, 'notify:blocked_started')) !== true) {
        await setSetting(deps.db, ws, 'notify:blocked_started', true)
        continue
      }
      const denied = (await db
        .selectFrom('activity_log')
        .select(['grant_id', 'action'])
        .where('workspace_id', '=', ws)
        .where('seq', '>', last)
        .where('seq', '<=', upto)
        .where('status', '=', 'denied')
        .where('grant_id', 'is not', null)
        .execute()) as Array<{ grant_id: string; action: string }>
      const byGrant = new Map<string, Set<string>>()
      for (const r of denied) {
        const what = r.action.slice(r.action.indexOf('.') + 1).replace(/_/g, ' ')
        byGrant.set(r.grant_id, (byGrant.get(r.grant_id) ?? new Set()).add(what))
      }
      for (const [grantId, whats] of byGrant) {
        const key = `notify:blocked:${grantId}`
        if ((await getSetting(deps.db, ws, key)) === today) continue
        const g = (await db.selectFrom('grants').select(['person_id', 'client_name', 'revoked_at']).where('id', '=', grantId).executeTakeFirst()) as
          | { person_id: string; client_name: string; revoked_at: string | null }
          | undefined
        if (!g || g.revoked_at) continue
        await setSetting(deps.db, ws, key, today)
        const prefs = (await getSetting(deps.db, ws, `prefs:${g.person_id}`)) as { blockedAsk?: boolean } | undefined
        if (prefs?.blockedAsk === false) continue
        const person = await deps.db.selectFrom('people').select('email').where('id', '=', g.person_id).executeTakeFirst()
        if (!person?.email) continue
        await deps.mailer.send({ to: person.email, ...refusedEmail({ client: g.client_name, what: [...whats], grantId, baseUrl: deps.baseUrl }) })
        sent++
      }
    }
    return sent
  }

  return { weekly, connectionAlerts, blockedAsks }
}
