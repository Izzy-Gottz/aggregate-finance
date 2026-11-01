// Postgres row-level security PROTOTYPE (docs/security/rls.md). Off unless AGFN_PG_RLS=1; SQLite never uses it.
//
// Every connection checked out of the pool is stamped with the caller's context in one round trip:
//   select set_config('agfn.workspace_id', $1, false), set_config('agfn.rls_bypass', $2, false) [, set_config('role', …)]
// The context comes from AsyncLocalStorage: a request runs inside withWorkspace(ws, …); cross-workspace work (worker
// jobs, migrations, auth lookups) runs inside withBypass(reason, …). No context at all stamps empty values, so the
// policies match nothing: fail closed.

import { AsyncLocalStorage } from 'node:async_hooks'
import { sql, type Kysely } from 'kysely'
import { perfCount } from './perf.ts'

export type RlsContext = { workspaceId: string } | { bypass: string }

const store = new AsyncLocalStorage<RlsContext>()

export function withWorkspace<T>(workspaceId: string, fn: () => T): T {
  return store.run({ workspaceId }, fn)
}

/** Cross-workspace work. `reason` is for code review and tracing ("worker:sync.all", "migrate"), not access. */
export function withBypass<T>(reason: string, fn: () => T): T {
  return store.run({ bypass: reason }, fn)
}

export function currentRlsContext(): RlsContext | undefined {
  return store.getStore()
}

export const rlsEnabled = (env: Record<string, string | undefined> = process.env) => env.AGFN_PG_RLS?.trim() === '1'

/** The phase-0 prototype tables (kept for tests that exercise a known subset). */
export const RLS_PROTOTYPE_TABLES = ['documents', 'activity_log', 'usage_daily'] as const

/**
 * Every table in the current schema with a workspace_id column. RLS covers all of them, found at boot, so a new
 * migration from any slice is protected automatically (docs/security/rls.md).
 */
export async function workspaceTables(db: Kysely<any>): Promise<string[]> {
  const r = await sql<{ table_name: string }>`
    select c.table_name from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
    where c.table_schema = current_schema() and c.column_name = 'workspace_id'
    order by c.table_name`.execute(db)
  return r.rows.map((x) => x.table_name)
}

/**
 * Tables with workspace_id that do NOT carry the current agfn_workspace policy with RLS forced on. Empty when fully
 * covered. A policy from before phase 2 (one that honors the bypass setting for anyone) counts as missing, so the next
 * boot replaces it.
 */
export async function tablesMissingRls(db: Kysely<any>): Promise<string[]> {
  const tables = await workspaceTables(db)
  if (!tables.length) return []
  const r = await sql<{ relname: string }>`
    select c.relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = current_schema()
    where c.relrowsecurity and c.relforcerowsecurity
      and exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'agfn_workspace'
        and pg_get_expr(p.polqual, p.polrelid) ilike '%current_user%')`.execute(db)
  const covered = new Set(r.rows.map((x) => x.relname))
  return tables.filter((t) => !covered.has(t))
}

interface PoolClientLike {
  query(text: string, params?: unknown[]): Promise<unknown>
  release(err?: unknown): void
}
interface PoolLike {
  connect(): Promise<PoolClientLike>
  end(): Promise<void>
}

/**
 * Wrap a pg Pool (or PGlite's stand-in) so every checkout carries the current context. Values are always overwritten,
 * so a pooled connection never keeps the previous request's workspace. `role` (optional) switches to a role that is
 * subject to RLS, for owners/superusers that would otherwise bypass it.
 */
export function rlsPool<P extends PoolLike>(pool: P, opts: { role?: string; appPool?: PoolLike } = {}): P {
  // What each physical connection is currently stamped with. Session settings persist on the connection, so a
  // checkout that needs the same context skips the extra statement (the common case: one tenant's request in a row).
  const stamped = new WeakMap<object, string>()
  const wrapped = Object.create(pool) as P
  wrapped.connect = async () => {
    const ctx = store.getStore()
    const ws = ctx && 'workspaceId' in ctx ? ctx.workspaceId : ''
    const bypass = ctx && 'bypass' in ctx ? 'on' : ''
    // Phase 2 (docs/security/rls.md): with a separate app login, requests check out from that pool, whose login is the
    // RLS-bound role itself, so no SET ROLE is involved and RESET ROLE can't escape it. Only withBypass work uses the
    // owner's pool. Without it (phase 1), bypass work runs as the login user and everything else SETs the RLS role.
    const fromApp = Boolean(opts.appPool) && !bypass
    const client = await (fromApp ? opts.appPool! : pool).connect()
    const role = opts.appPool ? '' : opts.role ? (bypass ? 'none' : opts.role) : ''
    const setsRole = !opts.appPool && Boolean(opts.role)
    const want = `${ws}\u0000${bypass}\u0000${role}`
    if (stamped.get(client) === want) return client
    try {
      perfCount('rlsStamp')
      await client.query(`select set_config('agfn.workspace_id', $1, false), set_config('agfn.rls_bypass', $2, false)${setsRole ? `, set_config('role', $3, false)` : ''}`, setsRole ? [ws, bypass, role] : [ws, bypass])
      stamped.set(client, want)
    } catch (err) {
      stamped.delete(client)
      client.release(err)
      throw err
    }
    return client
  }
  wrapped.end = async () => {
    await pool.end()
    await opts.appPool?.end()
  }
  return wrapped
}

const POLICY = 'agfn_workspace'
/** The role requests run as (AGFN_PG_RLS_ROLE, default agfn_app). Only a valid identifier, since it goes into DDL. */
export const appRoleName = (env: Record<string, string | undefined> = process.env) => {
  const r = env.AGFN_PG_RLS_ROLE || 'agfn_app'
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(r)) throw new Error('AGFN_PG_RLS_ROLE must be a plain lowercase Postgres role name')
  return r
}
// The bypass setting is honored only for roles other than the app role: SQL running as the app role (an injection,
// a bug) can set agfn.rls_bypass itself, so for it the setting means nothing. Bypass work runs as the owner.
const check = (appRole: string) => sql.raw(`workspace_id = current_setting('agfn.workspace_id', true) or (current_setting('agfn.rls_bypass', true) = 'on' and current_user <> '${appRole}')`)

/**
 * Enable RLS with the workspace policy on `tables` (idempotent). FORCE makes it apply to the table owner too, so the
 * app can keep connecting as the owner during the prototype. Run inside withBypass (it is DDL).
 */
export async function enableRls(db: Kysely<any>, tables: readonly string[], appRole = appRoleName()): Promise<void> {
  for (const t of tables) {
    const id = sql.id(t)
    await sql`alter table ${id} enable row level security`.execute(db)
    await sql`alter table ${id} force row level security`.execute(db)
    await sql`drop policy if exists ${sql.id(POLICY)} on ${id}`.execute(db)
    await sql`create policy ${sql.id(POLICY)} on ${id} using (${check(appRole)}) with check (${check(appRole)})`.execute(db)
  }
}

/** Which of `tables` currently have row-level security on (Postgres catalog). */
export async function rlsStatus(db: Kysely<any>, tables: readonly string[]): Promise<string[]> {
  if (!tables.length) return []
  const r = await sql<{ relname: string }>`select relname from pg_class where relrowsecurity and relkind = 'r' and relname in (${sql.join(tables.map((t) => sql.lit(t)))})`.execute(db)
  return r.rows.map((x) => x.relname)
}

/** Rollback: drop the policy and turn RLS off again. Data is untouched either way. */
export async function disableRls(db: Kysely<any>, tables: readonly string[]): Promise<void> {
  for (const t of tables) {
    const id = sql.id(t)
    await sql`drop policy if exists ${sql.id(POLICY)} on ${id}`.execute(db)
    await sql`alter table ${id} no force row level security`.execute(db)
    await sql`alter table ${id} disable row level security`.execute(db)
  }
}

/**
 * A role that RLS applies to (no superuser, no BYPASSRLS), with rights on the public schema. For tests and for
 * deployments whose connection user is a superuser (PGlite always is). Idempotent.
 */
export async function ensureAppRole(db: Kysely<any>, role = 'agfn_app'): Promise<void> {
  const exists = await sql<{ n: number }>`select count(*)::int as n from pg_roles where rolname = ${role}`.execute(db)
  if (!exists.rows[0]?.n) await sql`create role ${sql.id(role)} nologin nosuperuser nobypassrls`.execute(db)
  await sql`grant usage on schema public to ${sql.id(role)}`.execute(db)
  await sql`grant select, insert, update, delete on all tables in schema public to ${sql.id(role)}`.execute(db)
  await sql`alter default privileges in schema public grant select, insert, update, delete on tables to ${sql.id(role)}`.execute(db)
  await sql`grant usage, select on all sequences in schema public to ${sql.id(role)}`.execute(db)
  await sql`alter default privileges in schema public grant usage, select on sequences to ${sql.id(role)}`.execute(db)
  // The login must be able to switch into the role per checkout (rlsPool's set_config('role', …)). On PostgreSQL 16+ a
  // non-superuser creator gets ADMIN on the new role but not SET, so grant SET explicitly; superusers skip it.
  const su = await sql<{ su: boolean }>`select rolsuper as su from pg_roles where rolname = current_user`.execute(db)
  if (!su.rows[0]?.su) {
    const v = await sql<{ n: number }>`select current_setting('server_version_num')::int as n`.execute(db)
    if ((v.rows[0]?.n ?? 0) >= 160000) await sql`grant ${sql.id(role)} to current_user with set true, inherit false`.execute(db)
    else await sql`grant ${sql.id(role)} to current_user`.execute(db)
  }
}

/**
 * Enabled: every workspace_id table still missing the policy gets it (so new tables from any slice are covered at the
 * next boot, and a restart takes no locks on covered tables). Disabled: RLS left on by an earlier boot is turned off.
 * Boot doesn't call this directly: it goes through bootRls, which decides whether turning it off is allowed at all.
 */
export async function syncRlsPolicies(db: Kysely<any>, enabled: boolean): Promise<{ enabled: string[]; disabled: string[] }> {
  if (enabled) {
    const missing = await tablesMissingRls(db)
    await enableRls(db, missing)
    return { enabled: missing, disabled: [] }
  }
  const on = await rlsStatus(db, await workspaceTables(db))
  if (on.length) {
    await disableRls(db, on)
    console.warn(`[agfn] AGFN_PG_RLS is off: turned row-level security off again on ${on.length} table(s)`)
  }
  return { enabled: [], disabled: on }
}

export class RlsBootError extends Error {
  override name = 'RlsBootError'
}

/** A database URL on Neon (hosted Aggregate's provider). Unparseable URLs count as not Neon. */
function onNeon(url: string | undefined): boolean {
  if (!url) return false
  try {
    return /(^|\.)neon\.tech$/i.test(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * Whether this server is hosted Aggregate (AGFN_HOSTED=1, or its database is on Neon). The database check matters on
 * its own: a machine started without its config file has no AGFN_HOSTED but still has the database secret.
 */
export function isHostedDb(env: Record<string, string | undefined>, databaseUrl: string): boolean {
  return env.AGFN_HOSTED === '1' || onNeon(databaseUrl) || onNeon(env.AGFN_PG_APP_URL)
}

/** AGFN_PG_RLS as boot reads it: '1' on, 'off' (or '0') off on purpose, unset. Anything else is refused. */
export function rlsSetting(env: Record<string, string | undefined>): 'on' | 'off' | 'unset' {
  const v = env.AGFN_PG_RLS?.trim()
  if (v === undefined || v === '') return 'unset'
  if (v === '1') return 'on'
  if (v === 'off' || v === '0') return 'off'
  throw new RlsBootError(`AGFN_PG_RLS must be 1 (row-level security on) or off; got "${v.slice(0, 20)}". Refusing to start.`)
}

/**
 * What boot runs on Postgres. Fails closed: one server started with missing or wrong config must never turn tenant
 * isolation off for every server sharing the database.
 * - AGFN_PG_RLS=1: cover every workspace table, then check the catalog that every one has RLS forced on with the
 *   policy; any gap refuses to start.
 * - Hosted (AGFN_HOSTED=1 or a Neon database): anything but AGFN_PG_RLS=1 refuses to start.
 * - AGFN_PG_RLS=off (self-hosted only): the rollback, turns RLS off.
 * - Unset (self-hosted): fine while RLS is off; if an earlier boot turned it on, refuses to start rather than guess.
 */
export async function bootRls(db: Kysely<any>, env: Record<string, string | undefined>, databaseUrl: string): Promise<{ enabled: string[]; disabled: string[] }> {
  const setting = rlsSetting(env)
  const hosted = isHostedDb(env, databaseUrl)
  if (setting === 'on') {
    const r = await syncRlsPolicies(db, true)
    const gaps = await tablesMissingRls(db)
    if (gaps.length) throw new RlsBootError(`row-level security is not on for ${gaps.length} table(s) after boot (${gaps.slice(0, 5).join(', ')}${gaps.length > 5 ? ', …' : ''}). Refusing to start.`)
    return r
  }
  if (hosted) {
    throw new RlsBootError(
      setting === 'off'
        ? 'AGFN_PG_RLS=off is not allowed on hosted Aggregate (AGFN_HOSTED=1 or a Neon database): row-level security stays on. Refusing to start.'
        : 'AGFN_PG_RLS is not set, and this is hosted Aggregate (AGFN_HOSTED=1 or a Neon database), which requires AGFN_PG_RLS=1. Is this machine missing its [env] config? Refusing to start, so row-level security stays on for every server.',
    )
  }
  if (setting === 'off') return syncRlsPolicies(db, false)
  const on = await rlsStatus(db, await workspaceTables(db))
  if (on.length)
    throw new RlsBootError(
      `row-level security is on in this database (${on.length} table(s)) but AGFN_PG_RLS is not set. Set AGFN_PG_RLS=1 to keep it on, or AGFN_PG_RLS=off to turn it off on purpose. Refusing to start.`,
    )
  return { enabled: [], disabled: [] }
}
