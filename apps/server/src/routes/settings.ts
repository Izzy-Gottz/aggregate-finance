// Preferences, people and "export everything" (MASTER §3 Preferences). Mounted under /api after session auth.
// Shapes: apps/web/src/api/types.ts (Preferences, PersonRow).

import type { Format } from '@agfn/plaintext'
import { plainTextExport, PLAINTEXT_EXT } from '../plaintext.ts'
import { pruneExpiredExports } from '../exports.ts'
import { randomBytes } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { Kysely } from 'kysely'
import type { DataType } from '@agfn/contracts'
import { addMember, effectiveGrid, isTimeZone, type PermissionGrid } from '@agfn/auth'
import { nowIso, withBypass, withWorkspace, type CoreTables, type RolePreset } from '@agfn/db'
import { appendActivity, DbRateLimiter, peopleFromAuth, ToolError, type AgfnMcpHandle } from '@agfn/mcp'
import type { RequestPerson } from '../app.ts'
import type { Services } from '../services.ts'
import { REVIEWER_EMAIL_DOMAIN } from '@agfn/auth'
import { passkeysPossible } from '../config.ts'
import { isLastOwner, LastOwnerError, removeMember } from '../remove-member.ts'

type Env = { Variables: { person: RequestPerson } }
type UiRole = Exclude<RolePreset, 'custom'>
type Access = 'none' | 'view' | 'add'

export interface PersonRow {
  id: string
  name: string
  email: string
  role: UiRole
  entityIds: string[] | 'all'
  grid: Record<DataType, Access>
  pending: boolean
}

export interface Preferences {
  signIn: { passkeys: Array<{ id: string; name: string; addedAt: string }>; apple: boolean; google: boolean; email: string; noRecheck?: boolean }
  companies: Array<{ id: string; name: string; currency: string; fiscalYearStartMonth: number }>
  aiReviewMode: boolean
  notifications: { mondayEmail: boolean; blockedAsk: boolean }
  /** The workspace's time zone (IANA): which day balances and "today" fall on. Owners and admins can change it. */
  timeZone: string
  people: PersonRow[]
  recovery: { applicable: boolean; savedAt: string | null }
  theme: 'system' | 'light' | 'dark'
  /** False for the workspace's only owner (Leave would strand it). */
  canLeave: boolean
}

interface PersonalPrefs {
  mondayEmail: boolean
  blockedAsk: boolean
  theme: Preferences['theme']
}

const DEFAULT_PREFS: PersonalPrefs = { mondayEmail: true, blockedAsk: true, theme: 'light' }
const DATA_TYPES: DataType[] = ['balances', 'transactions', 'invoices', 'bills', 'buckets', 'payroll', 'equity', 'documents', 'reports', 'personal']
const ROLES: UiRole[] = ['owner', 'admin', 'finance', 'accountant', 'investor', 'employee']
const RECHECK_MS = 10 * 60_000
const EXPORT_TTL_MS = 60 * 60_000

function reply(status: number, body: Record<string, unknown>): never {
  throw new HTTPException(status as 400, { res: new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) })
}

function actor(c: Context<Env>): { workspaceId: string; personId: string } {
  const p = c.get('person')
  if (!p.workspaceId) reply(409, { error: 'onboarding', message: 'Create your first company to get started.' })
  return { workspaceId: p.workspaceId, personId: p.personId }
}

async function jsonBody(c: Context<Env>): Promise<Record<string, unknown>> {
  const v = (await c.req.json().catch(() => null)) as unknown
  if (!v || typeof v !== 'object' || Array.isArray(v)) reply(400, { message: 'Send a JSON object.' })
  return v as Record<string, unknown>
}

// ---------- helpers ----------

function gridToRow(grid: PermissionGrid): Record<DataType, Access> {
  return Object.fromEntries(DATA_TYPES.map((d) => [d, d === 'personal' ? 'none' : grid.add.includes(d) ? 'add' : grid.view.includes(d) ? 'view' : 'none'])) as Record<DataType, Access>
}

async function settingGet<T>(db: Kysely<CoreTables>, ws: string, key: string): Promise<T | null> {
  const r = await db.selectFrom('settings').select('value_json').where('workspace_id', '=', ws).where('key', '=', key).executeTakeFirst()
  return r ? (JSON.parse(r.value_json) as T) : null
}

async function settingPut(db: Kysely<CoreTables>, ws: string, key: string, value: unknown): Promise<void> {
  const v = JSON.stringify(value)
  await db
    .insertInto('settings')
    .values({ workspace_id: ws, key, value_json: v, updated_at: nowIso() })
    .onConflict((oc) => oc.columns(['workspace_id', 'key']).doUpdateSet({ value_json: v, updated_at: nowIso() }))
    .execute()
}

export function createSettings(s: Services) {
  const db = s.db
  const people = peopleFromAuth({ db, permissions: s.permissions, reauth: s.reauth, passkeysPossible: passkeysPossible(s.config.baseUrl), noRecheck: s.config.challenge === true })
  const anyDb = db as unknown as Kysely<Record<string, Record<string, unknown>>>
  const inviteLimiter = new DbRateLimiter(db)

  async function requireManager(a: { workspaceId: string; personId: string }): Promise<void> {
    if (!(await s.permissions.canManageWorkspace(a.workspaceId, a.personId))) reply(403, { error: 'forbidden', message: 'Only an owner or admin can do this.' })
  }

  /**
   * The same fresh check as deleting the account (app.ts): a passkey or the emailed link in the last 10 minutes (any
   * fresh sign-in for someone without a passkey). `method` tells the app which to offer, so someone who only signs in
   * by email is sent a link instead of a passkey prompt that can never succeed.
   */
  async function requireRecheck(personId: string): Promise<void> {
    if (await people.requireRecentPasskey(personId, RECHECK_MS)) return
    const person = await db.selectFrom('people').select('auth_user_id').where('id', '=', personId).executeTakeFirst()
    const passkey = person?.auth_user_id ? await anyDb.selectFrom('passkey').select('id').where('userId', '=', person.auth_user_id).limit(1).executeTakeFirst().catch(() => undefined) : undefined
    const method = passkey ? 'passkey' : 'email'
    reply(403, { error: 'recheck', method, fallback: 'email', message: method === 'passkey' ? 'Confirm it’s you with your passkey, or by email.' : 'Confirm it’s you: we’ll email you a link.' })
  }

  async function roleOf(ws: string, personId: string): Promise<RolePreset | null> {
    const t = nowIso()
    const r = await db.selectFrom('memberships').select(['role', 'expires_at']).where('workspace_id', '=', ws).where('person_id', '=', personId).where('revoked_at', 'is', null).execute()
    return r.find((m) => !m.expires_at || m.expires_at > t)?.role ?? null
  }

  async function personRows(ws: string, onlyPersonId?: string): Promise<PersonRow[]> {
    let q = db
      .selectFrom('memberships')
      .innerJoin('people', 'people.id', 'memberships.person_id')
      .select(['people.id as id', 'people.name as name', 'people.email as email', 'people.auth_user_id as auth_user_id', 'memberships.role as role', 'memberships.grid_json as grid_json'])
      .where('memberships.workspace_id', '=', ws)
      .where('memberships.revoked_at', 'is', null)
    if (onlyPersonId) q = q.where('people.id', '=', onlyPersonId)
    const rows = await q.orderBy('memberships.created_at').execute()
    return rows.map((r) => {
      const grid = effectiveGrid(r.role, r.grid_json)
      return { id: r.id, name: r.name, email: r.email, role: r.role === 'custom' ? 'employee' : r.role, entityIds: grid.entities, grid: gridToRow(grid), pending: !r.auth_user_id }
    })
  }

  async function companyIds(ws: string): Promise<Set<string>> {
    const rows = await db.selectFrom('entities').select('id').where('workspace_id', '=', ws).where('kind', '=', 'company').where('archived_at', 'is', null).execute()
    return new Set(rows.map((r) => r.id))
  }

  function parseEntityIds(v: unknown, companies: Set<string>): string[] | 'all' {
    if (v === 'all') return 'all'
    if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== 'string' || !companies.has(x))) reply(400, { message: 'Pick at least one company.' })
    return [...new Set(v as string[])]
  }

  async function preferences(a: { workspaceId: string; personId: string }): Promise<Preferences> {
    const person = await db.selectFrom('people').select(['email', 'auth_user_id']).where('id', '=', a.personId).executeTakeFirstOrThrow()
    let passkeys: Preferences['signIn']['passkeys'] = []
    let apple = false
    let google = false
    if (person.auth_user_id) {
      const pk = await anyDb.selectFrom('passkey').select(['id', 'name', 'createdAt']).where('userId', '=', person.auth_user_id).execute().catch(() => [])
      passkeys = pk.map((p) => ({ id: String(p.id), name: String(p.name ?? 'Passkey'), addedAt: new Date(p.createdAt as string | number | Date).toISOString() }))
      const accounts = await anyDb.selectFrom('auth_account').select('providerId').where('userId', '=', person.auth_user_id).execute().catch(() => [])
      apple = accounts.some((x) => x.providerId === 'apple')
      google = accounts.some((x) => x.providerId === 'google')
    }
    const visible = new Set((await s.permissions.entitiesFor(a.workspaceId, a.personId)).map((e) => e.id))
    const companies = (await db.selectFrom('entities').select(['id', 'name', 'base_currency', 'fiscal_year_start_month']).where('workspace_id', '=', a.workspaceId).where('kind', '=', 'company').where('archived_at', 'is', null).orderBy('created_at').execute())
      .filter((e) => visible.has(e.id))
      .map((e) => ({ id: e.id, name: e.name, currency: e.base_currency, fiscalYearStartMonth: e.fiscal_year_start_month }))
    const mine = { ...DEFAULT_PREFS, ...((await settingGet<Partial<PersonalPrefs>>(db, a.workspaceId, `prefs:${a.personId}`)) ?? {}) }
    const manager = await s.permissions.canManageWorkspace(a.workspaceId, a.personId)
    const ai = (s.mcp as Partial<AgfnMcpHandle> | undefined)?.control
    const aiSettings = ai ? await ai.aiSettings(a) : { reviewModeDefault: 'instant' as const }
    return {
      signIn: { passkeys, apple, google, email: person.email, ...(s.config.challenge ? { noRecheck: true } : {}) },
      companies,
      aiReviewMode: aiSettings.reviewModeDefault === 'review_all',
      notifications: { mondayEmail: mine.mondayEmail, blockedAsk: mine.blockedAsk },
      timeZone: (await db.selectFrom('workspaces').select('time_zone').where('id', '=', a.workspaceId).executeTakeFirst())?.time_zone ?? 'America/New_York',
      people: await personRows(a.workspaceId, manager ? undefined : a.personId),
      recovery: { applicable: s.config.selfHosted, savedAt: (await settingGet<{ at: string }>(db, a.workspaceId, 'recovery_saved_at'))?.at ?? null },
      theme: mine.theme,
      canLeave: !(await isLastOwner(db, a.workspaceId, a.personId)),
    }
  }

  async function updatePreferences(a: { workspaceId: string; personId: string }, b: Record<string, unknown>): Promise<Preferences> {
    if (b.companies !== undefined) {
      await requireManager(a)
      if (!Array.isArray(b.companies)) reply(400, { message: 'companies must be a list.' })
      const ids = await companyIds(a.workspaceId)
      for (const raw of b.companies as Array<Record<string, unknown>>) {
        if (!raw || typeof raw.id !== 'string' || !ids.has(raw.id)) reply(400, { message: 'Unknown company.' })
        const patch: Record<string, unknown> = {}
        if (raw.name !== undefined) {
          const name = String(raw.name).replace(/\s+/g, ' ').trim().slice(0, 80)
          if (!name) reply(400, { message: 'A company needs a name.' })
          patch.name = name
        }
        if (raw.fiscalYearStartMonth !== undefined) {
          const m = Number(raw.fiscalYearStartMonth)
          if (!Number.isInteger(m) || m < 1 || m > 12) reply(400, { message: 'Fiscal year starts in a month from 1 to 12.' })
          patch.fiscal_year_start_month = m
        }
        if (raw.currency !== undefined) {
          const cur = String(raw.currency).toUpperCase()
          if (!/^[A-Z]{3}$/.test(cur)) reply(400, { message: 'Currency is a 3-letter code like USD.' })
          const current = await db.selectFrom('entities').select('base_currency').where('id', '=', raw.id).executeTakeFirstOrThrow()
          if (cur !== current.base_currency) {
            // Changing home currency under existing books would silently re-denominate every total.
            const has = await db.selectFrom('accounts').select('id').where('entity_id', '=', raw.id).limit(1).executeTakeFirst()
            if (has) reply(409, { message: 'This company already has accounts, so its currency can’t change.' })
            patch.base_currency = cur
          }
        }
        if (Object.keys(patch).length) {
          // The only company's workspace was named after it (sign-up does that): a rename renames the workspace too,
          // so the switcher and invite emails don't keep the old name. A workspace named otherwise keeps its name.
          if (patch.name !== undefined) {
            const before = await db.selectFrom('entities').select('name').where('id', '=', raw.id).executeTakeFirstOrThrow()
            const ws = await db.selectFrom('workspaces').select('name').where('id', '=', a.workspaceId).executeTakeFirstOrThrow()
            const only = (await db.selectFrom('entities').select('id').where('workspace_id', '=', a.workspaceId).where('kind', '=', 'company').where('archived_at', 'is', null).execute()).length === 1
            if (only && before.name !== patch.name && ws.name === before.name) await db.updateTable('workspaces').set({ name: patch.name as string }).where('id', '=', a.workspaceId).execute()
          }
          await db.updateTable('entities').set(patch).where('id', '=', raw.id).where('workspace_id', '=', a.workspaceId).execute()
          await s.ledger.directoryChanged?.(a.workspaceId)
        }
      }
    }
    if (b.timeZone !== undefined) {
      await requireManager(a)
      if (!isTimeZone(b.timeZone)) reply(400, { message: 'Pick a time zone like America/New_York.' })
      await db.updateTable('workspaces').set({ time_zone: b.timeZone }).where('id', '=', a.workspaceId).execute()
      await s.ledger.directoryChanged?.(a.workspaceId)
    }
    if (b.aiReviewMode !== undefined) {
      const ai = (s.mcp as Partial<AgfnMcpHandle> | undefined)?.control
      if (!ai) reply(503, { message: 'The AI connection is not installed on this server yet.' })
      try {
        await ai.setReviewDefault(a, b.aiReviewMode ? 'review_all' : 'instant')
      } catch (err) {
        if (err instanceof ToolError) reply(err.hint === 'step_up_required' ? 403 : err.code === 'forbidden' ? 403 : 400, { error: err.hint === 'step_up_required' ? 'recheck' : err.code, message: err.message })
        throw err
      }
    }
    if (b.notifications !== undefined || b.theme !== undefined) {
      const mine = { ...DEFAULT_PREFS, ...((await settingGet<Partial<PersonalPrefs>>(db, a.workspaceId, `prefs:${a.personId}`)) ?? {}) }
      const n = (b.notifications ?? {}) as Record<string, unknown>
      if (typeof n.mondayEmail === 'boolean') mine.mondayEmail = n.mondayEmail
      if (typeof n.blockedAsk === 'boolean') mine.blockedAsk = n.blockedAsk
      if (b.theme !== undefined) {
        if (b.theme !== 'system' && b.theme !== 'light' && b.theme !== 'dark') reply(400, { message: 'Theme is system, light or dark.' })
        mine.theme = b.theme
      }
      await settingPut(db, a.workspaceId, `prefs:${a.personId}`, mine)
    }
    return preferences(a)
  }

  async function invite(a: { workspaceId: string; personId: string }, b: Record<string, unknown>, origin: string): Promise<PersonRow> {
    await requireManager(a)
    await requireRecheck(a.personId)
    const role = b.role as UiRole
    if (!ROLES.includes(role)) reply(400, { message: 'Pick a role.' })
    if (role === 'owner' && (await roleOf(a.workspaceId, a.personId)) !== 'owner') reply(403, { error: 'forbidden', message: 'Only an owner can add another owner.' })
    const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : ''
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) reply(400, { message: 'That email address doesn’t look right.' })
    // Reviewer accounts (reviewer.ts) live in one demo workspace only; nobody can add them anywhere else.
    if (email.endsWith(`@${REVIEWER_EMAIL_DOMAIN}`)) reply(400, { message: 'That address can’t be invited.' })
    const entityIds = parseEntityIds(b.entityIds, await companyIds(a.workspaceId))
    const existing = await db.selectFrom('people').innerJoin('memberships', 'memberships.person_id', 'people.id').select(['people.id', 'people.auth_user_id']).where('people.email', '=', email).where('memberships.workspace_id', '=', a.workspaceId).where('memberships.revoked_at', 'is', null).executeTakeFirst()
    if (existing?.auth_user_id) reply(409, { message: 'They’re already in this workspace.' })
    // Still pending (the first email lost, or it failed to send): inviting them again sends a fresh link.
    if (existing) return resend(a, existing.id, origin)
    const { personId } = await addMember(db, { workspaceId: a.workspaceId, email, role, ...(entityIds === 'all' ? {} : { grid: { entities: entityIds } }), invitedBy: a.personId })
    await sendInvite(a, email, origin)
    await appendActivity(db as never, { workspaceId: a.workspaceId, actorKind: 'person', personId: a.personId, actorLabel: await people.displayName(a.personId), action: 'people.invite', targetType: 'person', targetId: personId, status: 'ok', detail: `${email} as ${role}` }, new Date())
    return (await personRows(a.workspaceId, personId))[0]!
  }

  /**
   * Their sign-in link, by email. The invite record lets the email say who invited them (names never come from the URL).
   * The membership is already saved, so a failed send says so (502) and Re-send can try again.
   */
  async function sendInvite(a: { workspaceId: string; personId: string }, email: string, origin: string): Promise<void> {
    const inviteId = randomBytes(18).toString('base64url')
    const ws = await db.selectFrom('workspaces').select('name').where('id', '=', a.workspaceId).executeTakeFirstOrThrow()
    await settingPut(db, a.workspaceId, `invite:${inviteId}`, { email, inviterName: await people.displayName(a.personId), workspaceName: ws.name, expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() })
    try {
      await s.auth.api.signInMagicLink({ body: { email, callbackURL: `/?invite=${inviteId}` }, headers: new Headers({ origin }) })
    } catch (err) {
      if (err instanceof HTTPException) throw err
      console.warn('[agfn] invite email failed', { error: err instanceof Error ? err.message : 'unknown' })
      reply(502, { error: 'email_failed', message: 'They’re added, but the invite email didn’t send. Try Re-send.' })
    }
  }

  /** A fresh invite email for someone who hasn't joined yet (the older links keep working until they expire). */
  async function resend(a: { workspaceId: string; personId: string }, targetId: string, origin: string): Promise<PersonRow> {
    await requireManager(a)
    await requireRecheck(a.personId)
    const row = (await personRows(a.workspaceId, targetId))[0]
    if (!row) reply(404, { message: 'That person isn’t in this workspace.' })
    if (!row.pending) reply(409, { message: 'They’ve already joined.' })
    const wait = await inviteLimiter.hit(`invite-resend:${a.workspaceId}:${targetId}`, 5, 60 * 60_000, Date.now())
    if (wait) reply(429, { error: 'rate_limited', message: `Too many invite emails to them. Try again in ${Math.ceil(wait / 60_000)} min.` })
    await sendInvite(a, row.email, origin)
    await appendActivity(db as never, { workspaceId: a.workspaceId, actorKind: 'person', personId: a.personId, actorLabel: await people.displayName(a.personId), action: 'people.invite', targetType: 'person', targetId, status: 'ok', detail: `${row.email} re-sent` }, new Date())
    return row
  }

  /**
   * Take someone out of the workspace (remove-member.ts), or leave it yourself. Removing someone else takes an owner or
   * admin and a fresh re-check, and an owner to remove an owner; the last owner can't go either way.
   */
  async function removePerson(a: { workspaceId: string; personId: string }, targetId: string): Promise<{ ok: true }> {
    const self = targetId === a.personId
    if (!self) {
      await requireManager(a)
      await requireRecheck(a.personId)
    }
    const role = await roleOf(a.workspaceId, targetId)
    const member = await db.selectFrom('memberships').innerJoin('people', 'people.id', 'memberships.person_id').select('people.email').where('memberships.workspace_id', '=', a.workspaceId).where('memberships.person_id', '=', targetId).where('memberships.revoked_at', 'is', null).executeTakeFirst()
    if (!member) reply(404, { message: 'That person isn’t in this workspace.' })
    if (!self && role === 'owner' && (await roleOf(a.workspaceId, a.personId)) !== 'owner') reply(403, { error: 'forbidden', message: 'Only an owner can remove an owner.' })
    try {
      const r = await removeMember(
        { db, files: s.files, sync: s.sync, log: (m, f) => console.warn('[agfn]', m, f ?? ''), ...(s.mcp ? { revokeGrant: (workspaceId: string, pid: string, grantId: string) => s.mcp!.control.revokeGrant({ workspaceId, personId: pid }, grantId) } : {}) },
        a.workspaceId,
        targetId,
        { self },
      )
      await appendActivity(db as never, { workspaceId: a.workspaceId, actorKind: 'person', personId: a.personId, actorLabel: await people.displayName(a.personId), action: self ? 'people.leave' : 'people.remove', targetType: 'person', targetId, status: 'ok', detail: `${member.email}${r.grantsRevoked ? `, ${r.grantsRevoked} AI access revoked` : ''}${r.connectionsRevoked ? `, ${r.connectionsRevoked} Personal connections disconnected` : ''}` }, new Date())
    } catch (err) {
      if (err instanceof LastOwnerError) reply(409, { error: 'last_owner', message: err.message })
      throw err
    }
    return { ok: true }
  }

  async function updatePerson(a: { workspaceId: string; personId: string }, targetId: string, b: Record<string, unknown>): Promise<PersonRow> {
    await requireManager(a)
    await requireRecheck(a.personId)
    const m = await db.selectFrom('memberships').selectAll().where('workspace_id', '=', a.workspaceId).where('person_id', '=', targetId).where('revoked_at', 'is', null).executeTakeFirst()
    if (!m) reply(404, { message: 'That person isn’t in this workspace.' })
    const myRole = await roleOf(a.workspaceId, a.personId)
    let role: RolePreset = m.role
    if (b.role !== undefined) {
      if (!ROLES.includes(b.role as UiRole)) reply(400, { message: 'Pick a role.' })
      role = b.role as UiRole
    }
    if ((role === 'owner' || m.role === 'owner') && role !== m.role && myRole !== 'owner') reply(403, { error: 'forbidden', message: 'Only an owner can change who is an owner.' })
    if (m.role === 'owner' && role !== 'owner') {
      const owners = await db.selectFrom('memberships').select((eb) => eb.fn.countAll<number>().as('n')).where('workspace_id', '=', a.workspaceId).where('role', '=', 'owner').where('revoked_at', 'is', null).executeTakeFirstOrThrow()
      if (Number(owners.n) <= 1) reply(409, { message: 'A workspace needs at least one owner. Make someone else an owner first.' })
    }
    // A role change starts from the new preset; entityIds and grid then override it.
    const prev = b.role !== undefined && role !== m.role ? {} : ((m.grid_json ? JSON.parse(m.grid_json) : {}) as Partial<PermissionGrid>)
    const grid: Partial<PermissionGrid> = { ...prev }
    if (b.entityIds !== undefined) grid.entities = parseEntityIds(b.entityIds, await companyIds(a.workspaceId))
    if (b.grid !== undefined) {
      const g = b.grid as Record<string, unknown>
      if (!g || typeof g !== 'object') reply(400, { message: 'grid must be an object.' })
      const base = effectiveGrid(role, null)
      const view = new Set(base.view)
      const add = new Set(base.add)
      for (const d of DATA_TYPES) {
        if (d === 'personal' || g[d] === undefined) continue
        if (!['none', 'view', 'add'].includes(String(g[d]))) reply(400, { message: `Access for ${d} is none, view or add.` })
        view.delete(d)
        add.delete(d)
        if (g[d] === 'view' || g[d] === 'add') view.add(d)
        if (g[d] === 'add') add.add(d)
      }
      grid.view = [...view]
      grid.add = [...add]
    }
    const gridJson = Object.keys(grid).length ? JSON.stringify(grid) : null
    await db.updateTable('memberships').set({ role, grid_json: gridJson }).where('id', '=', m.id).execute()
    await appendActivity(db as never, { workspaceId: a.workspaceId, actorKind: 'person', personId: a.personId, actorLabel: await people.displayName(a.personId), action: 'people.update', targetType: 'person', targetId, status: 'ok', detail: `role ${role}` }, new Date())
    return (await personRows(a.workspaceId, targetId))[0]!
  }

  /**
   * Everything in the workspace as JSON: every table with a workspace_id, minus secrets, minus other people's Personal
   * spaces. Kept for an hour behind a one-person download link; never emailed.
   */
  async function exportAll(a: { workspaceId: string; personId: string }, format: 'json' | Format = 'json'): Promise<{ url: string }> {
    await requireManager(a)
    await requireRecheck(a.personId)
    await pruneExpiredExports(db, s.files, { workspaceId: a.workspaceId })
    if (format !== 'json') return plainText(a, format)
    const others = new Set(
      (await db.selectFrom('entities').select('id').where('workspace_id', '=', a.workspaceId).where('kind', '=', 'personal').where((eb) => eb.or([eb('owner_person_id', '!=', a.personId), eb('owner_person_id', 'is', null)])).execute()).map((r) => r.id),
    )
    const tables = await db.introspection.getTables()
    const SECRET_COL = /secret|_enc$|^key_hash$|token|password|verifier|private/i
    const SKIP_TABLE = /^(auth_|passkey|jwks|oauth|kysely_|rate_limit|jobs$|reauth)/i
    const out: Record<string, unknown[]> = {}
    for (const t of tables) {
      if (SKIP_TABLE.test(t.name) || !t.columns.some((c) => c.name === 'workspace_id')) continue
      const cols = t.columns.map((c) => c.name).filter((n) => !SECRET_COL.test(n))
      const hasEntity = cols.includes('entity_id')
      let rows = (await anyDb.selectFrom(t.name).select(cols).where('workspace_id', '=', a.workspaceId).execute()) as Array<Record<string, unknown>>
      rows = rows.filter((r) => !(hasEntity && typeof r.entity_id === 'string' && others.has(r.entity_id)) && !(t.name === 'entities' && others.has(String(r.id))))
      if (t.name === 'settings') rows = rows.filter((r) => !/^(connect_state|export|inbound_token|invite|prefs):/.test(String(r.key)) || String(r.key) === `prefs:${a.personId}`)
      out[t.name] = rows
    }
    const members = await db.selectFrom('memberships').innerJoin('people', 'people.id', 'memberships.person_id').select(['people.id', 'people.name', 'people.email']).where('memberships.workspace_id', '=', a.workspaceId).execute()
    out.people = members
    const payload = JSON.stringify({ format: 'aggregate-export', version: 1, exportedAt: nowIso(), workspaceId: a.workspaceId, tables: out }, null, 2)
    const token = randomBytes(24).toString('base64url')
    const key = `exports/${a.workspaceId}/${token}.json`
    await s.files.put(key, new TextEncoder().encode(payload))
    await settingPut(db, a.workspaceId, `export:${token}`, { personId: a.personId, key, expiresAt: new Date(Date.now() + EXPORT_TTL_MS).toISOString() })
    await sweepExports(a.workspaceId)
    await appendActivity(db as never, { workspaceId: a.workspaceId, actorKind: 'person', personId: a.personId, actorLabel: await people.displayName(a.personId), action: 'export.create', status: 'ok', detail: `${Object.values(out).reduce((n, r) => n + r.length, 0)} rows` }, new Date())
    return { url: `/api/export/${token}` }
  }

  /** Books as a Beancount or hledger journal: the companies, plus the exporter's own Personal space. */
  async function plainText(a: { workspaceId: string; personId: string }, format: Format): Promise<{ url: string }> {
    const mine = await db.selectFrom('entities').select(['id', 'kind', 'owner_person_id']).where('workspace_id', '=', a.workspaceId).where('archived_at', 'is', null).execute()
    const entityIds = mine.filter((e) => e.kind === 'company' || e.owner_person_id === a.personId).map((e) => e.id)
    const text = await plainTextExport(s, a.workspaceId, { format, entityIds })
    const token = randomBytes(24).toString('base64url')
    const key = `exports/${a.workspaceId}/${token}.${PLAINTEXT_EXT[format]}`
    await s.files.put(key, new TextEncoder().encode(text))
    await settingPut(db, a.workspaceId, `export:${token}`, { personId: a.personId, key, expiresAt: new Date(Date.now() + EXPORT_TTL_MS).toISOString() })
    await sweepExports(a.workspaceId)
    await appendActivity(db as never, { workspaceId: a.workspaceId, actorKind: 'person', personId: a.personId, actorLabel: await people.displayName(a.personId), action: 'export.create', status: 'ok', detail: `${format} journal` }, new Date())
    return { url: `/api/export/${token}` }
  }

  async function sweepExports(ws: string): Promise<void> {
    const rows = await db.selectFrom('settings').select(['key', 'value_json']).where('workspace_id', '=', ws).where('key', 'like', 'export:%').execute()
    for (const r of rows) {
      const v = JSON.parse(r.value_json) as { key: string; expiresAt: string }
      if (Date.parse(v.expiresAt) > Date.now()) continue
      await s.files.delete(v.key).catch(() => undefined)
      await db.deleteFrom('settings').where('workspace_id', '=', ws).where('key', '=', r.key).execute()
    }
  }

  async function download(a: { workspaceId: string; personId: string }, token: string): Promise<Response> {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) reply(404, { message: 'That export link isn’t valid.' })
    const meta = await settingGet<{ personId: string; key: string; expiresAt: string }>(db, a.workspaceId, `export:${token}`)
    if (meta && Date.parse(meta.expiresAt) <= Date.now()) await pruneExpiredExports(db, s.files, { workspaceId: a.workspaceId })
    if (!meta || meta.personId !== a.personId || Date.parse(meta.expiresAt) <= Date.now()) reply(404, { message: 'That export link expired. Export again.' })
    const bytes = await s.files.get(meta.key)
    if (!bytes) reply(404, { message: 'That export link expired. Export again.' })
    const ext = /\.(json|beancount|journal)$/.exec(meta.key)?.[1] ?? 'json'
    return new Response(new Uint8Array(bytes), {
      headers: { 'content-type': ext === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="aggregate-export-${nowIso().slice(0, 10)}.${ext}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    })
  }

  /** What this workspace costs to run (read-only): live counts for today plus daily rollups. */
  async function usage(a: { workspaceId: string; personId: string }, days: number): Promise<Record<string, unknown>> {
    await requireManager(a)
    return { today: await s.usage.snapshot(a.workspaceId), history: await s.usage.history(a.workspaceId, days) }
  }

  return { preferences, updatePreferences, invite, resend, removePerson, updatePerson, exportAll, download, usage }
}

export function settingsRoutes(s: Services): Hono<Env> {
  const app = new Hono<Env>()
  const api = createSettings(s)
  app.get('/preferences', async (c) => c.json(await api.preferences(actor(c))))
  app.patch('/preferences', async (c) => c.json(await api.updatePreferences(actor(c), await jsonBody(c))))
  app.post('/people', async (c) => c.json(await api.invite(actor(c), await jsonBody(c), s.config.baseUrl), 201))
  app.patch('/people/:id', async (c) => c.json(await api.updatePerson(actor(c), c.req.param('id'), await jsonBody(c))))
  app.delete('/people/:id', async (c) => c.json(await api.removePerson(actor(c), c.req.param('id'))))
  app.post('/people/:id/resend', async (c) => {
    const row = await api.resend(actor(c), c.req.param('id'), s.config.baseUrl)
    return c.json({ ok: true, sentTo: row.email })
  })
  app.post('/workspace/leave', async (c) => {
    const a = actor(c)
    return c.json(await api.removePerson(a, a.personId))
  })
  app.get('/usage', async (c) => c.json(await api.usage(actor(c), Math.min(400, Math.max(1, Number(c.req.query('days') ?? 30) || 30)))))
  app.post('/export', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { format?: unknown }
    const format = b.format === undefined || b.format === 'json' ? 'json' : b.format === 'beancount' || b.format === 'hledger' ? b.format : null
    if (!format) reply(400, { message: 'format is json, beancount or hledger.' })
    return c.json(await api.exportAll(actor(c), format))
  })
  app.get('/export/:token', async (c) => api.download(actor(c), c.req.param('token')))
  // The invite behind /?invite=<id>, for the welcome screen. Not workspace-scoped (the invitee may be in another one):
  // answers only before expiry, while the invited membership stands, and only to the invited email, or to someone
  // who signed in another way (Apple's Hide My Email, another address) while the invited person still hasn't joined:
  // then `claim: true`, and POST …/accept moves the invite to this account. Anything else is 404.
  async function openInvite(id: string, p: RequestPerson): Promise<{ workspaceId: string; workspaceName: string; inviterName: string; email: string; personId: string; claim: boolean } | null> {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) return null
    // The invitee may be in another workspace (or none yet): look the invite up under a narrow named bypass.
    const row = await withBypass('auth:invite', () => s.db.selectFrom('settings').select(['workspace_id', 'value_json']).where('key', '=', `invite:${id}`).executeTakeFirst())
    if (!row) return null
    const v = JSON.parse(row.value_json) as { email: string; inviterName: string; workspaceName: string; expiresAt: string }
    if (Date.parse(v.expiresAt) <= Date.now()) return null
    const invited = await withBypass('auth:invite', () =>
      s.db.selectFrom('memberships').innerJoin('people', 'people.id', 'memberships.person_id').select(['people.id as id', 'people.auth_user_id as auth_user_id']).where('memberships.workspace_id', '=', row.workspace_id).where('people.email', '=', v.email.toLowerCase()).where('memberships.revoked_at', 'is', null).executeTakeFirst(),
    )
    if (!invited) return null
    const base = { workspaceId: row.workspace_id, workspaceName: v.workspaceName, inviterName: v.inviterName, email: v.email.toLowerCase(), personId: invited.id }
    if (v.email.toLowerCase() === p.email.toLowerCase()) return invited.id === p.personId ? { ...base, claim: false } : null
    // Someone else's invite they hold the link to: only while it's unused, never for reviewer accounts.
    if (invited.auth_user_id || p.email.toLowerCase().endsWith(`@${REVIEWER_EMAIL_DOMAIN}`)) return null
    return { ...base, claim: true }
  }
  app.get('/invites/:id', async (c) => {
    const inv = await openInvite(c.req.param('id'), c.get('person'))
    if (!inv) return c.json({ message: 'No such invite.' }, 404)
    return c.json({ workspaceId: inv.workspaceId, workspaceName: inv.workspaceName, inviterName: inv.inviterName, ...(inv.claim ? { claim: true, invitedEmail: inv.email } : {}) })
  })
  // Join with this account instead: the invited (never signed-in) membership moves to the signed-in person, and the
  // invite's records go, so the link can't be used twice.
  app.post('/invites/:id/accept', async (c) => {
    const p = c.get('person')
    const id = c.req.param('id')
    const inv = await openInvite(id, p)
    if (!inv) return c.json({ message: 'No such invite.' }, 404)
    if (inv.claim) {
      await withWorkspace(inv.workspaceId, async () => {
        const db = s.db
        const mine = await db.selectFrom('memberships').select('id').where('workspace_id', '=', inv.workspaceId).where('person_id', '=', p.personId).where('revoked_at', 'is', null).executeTakeFirst()
        if (mine) await db.updateTable('memberships').set({ revoked_at: nowIso() }).where('workspace_id', '=', inv.workspaceId).where('person_id', '=', inv.personId).where('revoked_at', 'is', null).execute()
        else await db.updateTable('memberships').set({ person_id: p.personId }).where('workspace_id', '=', inv.workspaceId).where('person_id', '=', inv.personId).where('revoked_at', 'is', null).execute()
        const keys = (await db.selectFrom('settings').select(['key', 'value_json']).where('workspace_id', '=', inv.workspaceId).where('key', 'like', 'invite:%').execute()).filter((r) => {
          try {
            return String((JSON.parse(r.value_json) as { email?: unknown }).email ?? '').toLowerCase() === inv.email
          } catch {
            return false
          }
        })
        if (keys.length) await db.deleteFrom('settings').where('workspace_id', '=', inv.workspaceId).where('key', 'in', keys.map((r) => r.key)).execute()
        await appendActivity(db as never, { workspaceId: inv.workspaceId, actorKind: 'person', personId: p.personId, actorLabel: p.name || p.email, action: 'people.join', targetType: 'person', targetId: p.personId, status: 'ok', detail: `${p.email} accepted the invite for ${inv.email}` }, new Date())
      })
    }
    return c.json({ ok: true, workspaceId: inv.workspaceId })
  })
  return app
}

