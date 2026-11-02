// Scheduled retention (data-retention policy §8): raw provider payloads of a disconnected connection are deleted
// 30 days after disconnect. Runs daily as the `retention.purge` worker job. The ledger is untouched; see the policy.

import { ownerOf, unlessDenied } from '@agfn/db'
import type { Kysely } from 'kysely'
import type { CoreTables } from '@agfn/db'
import { inactivityEmail } from '@agfn/auth'
import { PUBLIC_DEMO_CLIENT } from '@agfn/mcp'

export const RAW_KEEP_AFTER_DISCONNECT_DAYS = 30

export async function purgeRawPayloads(db: Kysely<CoreTables>, now: Date = new Date()): Promise<{ stamped: number; connections: number; rows: number }> {
  // Connections disconnected before the timestamp existed start their 30 days now.
  const stamped = await db.updateTable('connections').set({ disconnected_at: now.toISOString() }).where('status', '=', 'disconnected').where('disconnected_at', 'is', null).executeTakeFirst()
  const cutoff = new Date(now.getTime() - RAW_KEEP_AFTER_DISCONNECT_DAYS * 86_400_000).toISOString()
  const due = await db.selectFrom('connections').select('id').where('status', '=', 'disconnected').where('disconnected_at', '<=', cutoff).execute()
  let rows = 0
  let connections = 0
  for (const c of due) {
    const r = await db.deleteFrom('raw_records').where('connection_id', '=', c.id).executeTakeFirst()
    const n = Number(r.numDeletedRows ?? 0)
    if (n) connections++
    rows += n
  }
  return { stamped: Number(stamped.numUpdatedRows ?? 0), connections, rows }
}

/**
 * AI grants made on the "choose what this AI can see" step that never got bound to an OAuth consent (the person
 * closed the tab, or the client failed): revoked so they never show as connected AIs. Bound or used grants are never
 * touched. Runs daily (older than an hour) and when the person starts the same client again (older than now).
 */
export async function revokeUnboundOauthGrants(db: Kysely<CoreTables>, opts: { now?: Date; olderThanMs?: number; personId?: string; clientId?: string } = {}): Promise<number> {
  const anyDb = db as unknown as Kysely<Record<string, Record<string, unknown>>>
  const now = opts.now ?? new Date()
  const cutoff = new Date(now.getTime() - (opts.olderThanMs ?? 3_600_000)).toISOString()
  let q = anyDb
    .selectFrom('grants')
    .select('id')
    .where('kind', '=', 'oauth')
    .where('revoked_at', 'is', null)
    .where('last_used_at', 'is', null)
    .where('created_at', '<=', cutoff)
    // The public demo's connection never goes through consent (public-demo.ts): it isn't an abandoned sign-in.
    .where('client_id', '!=', PUBLIC_DEMO_CLIENT)
  if (opts.personId) q = q.where('person_id', '=', opts.personId)
  if (opts.clientId) q = q.where('client_id', '=', opts.clientId)
  const candidates = ((await q.execute().catch(unlessDenied([]))) as Array<{ id: string }>).map((r) => r.id)
  if (!candidates.length) return 0
  const bound = new Set(((await ownerOf(anyDb).selectFrom('oauthConsent').select('referenceId').where('referenceId', 'in', candidates).execute().catch(unlessDenied([]))) as Array<{ referenceId: string }>).map((r) => r.referenceId))
  const orphans = candidates.filter((id) => !bound.has(id))
  if (!orphans.length) return 0
  await anyDb.updateTable('grants').set({ revoked_at: now.toISOString(), revoked_by: 'system:never-connected', updated_at: now.toISOString() }).where('id', 'in', orphans).execute()
  await ownerOf(db).deleteFrom('oauth_pending_grants').where('grant_id', 'in', orphans).execute()
  return orphans.length
}

// ---------- 90-day inactivity notice (privacy policy: unused workspaces) ----------
// A workspace with no sign-in, AI call or change by a person for 90 days gets one service email to its owners, and
// another only after a further 90 days. Not marketing: no preference turns it off. Recorded in settings so a restart
// or a second machine never sends it twice.

export const INACTIVE_DAYS = 90
export const INACTIVITY_KEY = 'inactivity_notice'

type AnyDb = Kysely<Record<string, Record<string, unknown>>>
const maxOf = (...xs: Array<string | null | undefined>): string | null => xs.filter((x): x is string => Boolean(x)).sort().at(-1) ?? null
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v))

/** The latest sign-in, AI call or person/AI action in the workspace (never earlier than its creation). */
export async function lastActivity(db: Kysely<CoreTables>, workspaceId: string): Promise<string | null> {
  const anyDb = db as unknown as AnyDb
  const ws = await db.selectFrom('workspaces').select('created_at').where('id', '=', workspaceId).executeTakeFirst()
  const act = (await anyDb.selectFrom('activity_log').select((eb) => eb.fn.max('at').as('at')).where('workspace_id', '=', workspaceId).where('actor_kind', 'in', ['person', 'agent']).executeTakeFirst().catch(unlessDenied(undefined))) as { at?: unknown } | undefined
  const ai = (await anyDb.selectFrom('grants').select((eb) => eb.fn.max('last_used_at').as('at')).where('workspace_id', '=', workspaceId).executeTakeFirst().catch(unlessDenied(undefined))) as { at?: unknown } | undefined
  const users = (await db.selectFrom('memberships').innerJoin('people', 'people.id', 'memberships.person_id').select('people.auth_user_id').where('memberships.workspace_id', '=', workspaceId).where('memberships.revoked_at', 'is', null).execute())
    .map((r) => r.auth_user_id)
    .filter((x): x is string => Boolean(x))
  let signin: string | null = null
  if (users.length) {
    const s = (await ownerOf(anyDb).selectFrom('auth_session').select((eb) => [eb.fn.max('updatedAt').as('u'), eb.fn.max('createdAt').as('c')]).where('userId', 'in', users).executeTakeFirst().catch(unlessDenied(undefined))) as { u?: unknown; c?: unknown } | undefined
    signin = maxOf(iso(s?.u), iso(s?.c))
  }
  return maxOf(ws?.created_at, iso(act?.at), iso(ai?.at), signin)
}

export async function sendInactivityNotices(deps: { db: Kysely<CoreTables>; mailer: { send(m: { to: string; subject: string; text: string; html?: string }): Promise<void> }; baseUrl: string; now?: Date }): Promise<{ checked: number; notified: number }> {
  const { db } = deps
  const now = deps.now ?? new Date()
  const cutoff = new Date(now.getTime() - INACTIVE_DAYS * 86_400_000).toISOString()
  const workspaces = await db.selectFrom('workspaces').select('id').where('created_at', '<=', cutoff).execute()
  let notified = 0
  for (const { id } of workspaces) {
    const last = await lastActivity(db, id)
    if (last && last > cutoff) continue
    const prev = await db.selectFrom('settings').select('value_json').where('workspace_id', '=', id).where('key', '=', INACTIVITY_KEY).executeTakeFirst()
    const sentAt = prev ? (JSON.parse(prev.value_json) as { sentAt?: string }).sentAt : undefined
    if (sentAt && sentAt > cutoff) continue
    const owners = await db
      .selectFrom('memberships')
      .innerJoin('people', 'people.id', 'memberships.person_id')
      .select('people.email')
      .where('memberships.workspace_id', '=', id)
      .where('memberships.role', '=', 'owner')
      .where('memberships.revoked_at', 'is', null)
      .execute()
    const to = owners.map((o) => o.email).filter((e): e is string => Boolean(e) && !/(@|\.)invalid$/i.test(String(e)))
    if (!to.length) continue
    // Claim first: if two machines run the job, only the one whose write lands sends.
    const value = JSON.stringify({ sentAt: now.toISOString(), lastActivity: last })
    if (prev) {
      const r = await db.updateTable('settings').set({ value_json: value, updated_at: now.toISOString() }).where('workspace_id', '=', id).where('key', '=', INACTIVITY_KEY).where('value_json', '=', prev.value_json).executeTakeFirst()
      if (!Number(r.numUpdatedRows ?? 0)) continue
    } else {
      const ok = await db.insertInto('settings').values({ workspace_id: id, key: INACTIVITY_KEY, value_json: value, updated_at: now.toISOString() }).execute().then(() => true, () => false)
      if (!ok) continue
    }
    for (const email of to) await deps.mailer.send({ to: email, ...inactivityEmail({ baseUrl: deps.baseUrl }) })
    notified++
  }
  return { checked: workspaces.length, notified }
}
