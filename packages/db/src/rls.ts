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
 * covered. A policy that honors the bypass setting for anyone but this role counts as missing, so the next boot
 * replaces it, including after the owner role changes.
 */
export async function tablesMissingRls(db: Kysely<any>, opts: { people?: boolean } = {}): Promise<string[]> {
  const owner = await currentRole(db)
  const ownerLike = `%current_user = '${owner.replaceAll("'", "''")}'%`
  const tables = await workspaceTables(db)
  const missing: string[] = []
  if (tables.length) {
    const r = await sql<{ relname: string }>`
      select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = current_schema()
      where c.relrowsecurity and c.relforcerowsecurity
        and exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'agfn_workspace'
          and pg_get_expr(p.polqual, p.polrelid) ilike ${ownerLike})`.execute(db)
    const covered = new Set(r.rows.map((x) => x.relname))
    missing.push(...tables.filter((t) => !covered.has(t)))
  }
  // `people` carries its own membership policy (agfn_people), but it's applied one release AFTER the code that tolerates
  // it (the named bypass on the sign-in paths): tightening it while an old machine still serves would fail that
  // machine's sign-up inserts. So it's reported missing — and so applied/required — only when opts.people is set, which
  // bootRls derives from AGFN_PEOPLE_RLS. See docs/security/rls.md.
  if (opts.people) {
    const p = await sql<{ n: number }>`
      select count(*)::int as n from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = current_schema()
      where c.relname = ${PEOPLE_TABLE} and c.relrowsecurity and c.relforcerowsecurity
        and exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = ${PEOPLE_POLICY}
          and pg_get_expr(p.polqual, p.polrelid) ilike ${ownerLike})`.execute(db)
    if (!p.rows[0]?.n) missing.push(PEOPLE_TABLE)
  }
  return missing
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
// The bypass setting is honored only for the role that runs bypass work, named here so that a role added later starts
// closed. Any session can write the setting, so naming the role is what makes it mean anything. Neon's owner has
// BYPASSRLS and doesn't need it; a plain Postgres owner does.
const bypassClause = (owner: string) => `current_setting('agfn.rls_bypass', true) = 'on' and current_user = '${owner.replaceAll("'", "''")}'`
const check = (owner: string) => sql.raw(`workspace_id = current_setting('agfn.workspace_id', true) or (${bypassClause(owner)})`)

// `people` has no workspace_id: a person spans workspaces through memberships, so it can't use the workspace policy. Its
// own policy (agfn_people) shows a person row only to bypass work or to a request whose workspace the person is a current
// member of — so the app role with no workspace set (e.g. reached through SQL injection) reads no names or emails. The
// memberships lookup is itself RLS-scoped to the current workspace, which is exactly the set we want. Sign-in, invites
// and other cross-workspace reads run under bypass (auth lookups do), where the first clause covers them.
const PEOPLE_TABLE = 'people'
const PEOPLE_POLICY = 'agfn_people'
const peopleCheck = (owner: string) =>
  sql.raw(`(${bypassClause(owner)}) or exists (select 1 from memberships m where m.person_id = people.id and m.workspace_id = current_setting('agfn.workspace_id', true) and m.revoked_at is null)`)

const currentRole = async (db: Kysely<any>): Promise<string> => (await sql<{ r: string }>`select current_user as r`.execute(db)).rows[0]?.r as string

/**
 * Enable RLS with the workspace policy on `tables` (idempotent). FORCE makes it apply to the table owner too, so the
 * app can keep connecting as the owner during the prototype. Run inside withBypass (it is DDL), as the role that does
 * bypass work: that's the one the policy names.
 */
export async function enableRls(db: Kysely<any>, tables: readonly string[]): Promise<void> {
  const owner = await currentRole(db)
  // `people` carries its own membership policy; every workspace_id table carries the standard workspace one.
  for (const t of tables) await policyOn(db, t, owner, t === PEOPLE_TABLE ? { name: PEOPLE_POLICY, expr: peopleCheck(owner) } : { name: POLICY, expr: check(owner) })
}

const LOCK_TRIES = 5

/**
 * One table, in one transaction. Changing a policy waits for reads on the table, and every new query queues behind it,
 * so a short wait and a few tries keep one long read from stalling the table. `set local` holds through poolers too.
 */
async function policyOn(db: Kysely<any>, t: string, _owner: string, policy: { name: string; expr: ReturnType<typeof sql.raw> }): Promise<void> {
  const id = sql.id(t)
  const pid = sql.id(policy.name)
  for (let attempt = 1; ; attempt++) {
    try {
      await db.transaction().execute(async (tx) => {
        await sql`set local lock_timeout = '2s'`.execute(tx)
        const on = await sql<{ rls: boolean; forced: boolean; policies: number }>`
          select c.relrowsecurity as rls, c.relforcerowsecurity as forced, (select count(*)::int from pg_policy p where p.polrelid = c.oid and p.polname = ${policy.name}) as policies
          from pg_class c where c.oid = quote_ident(${t})::regclass`.execute(tx)
        const now = on.rows[0]
        if (!now?.rls) await sql`alter table ${id} enable row level security`.execute(tx)
        if (!now?.forced) await sql`alter table ${id} force row level security`.execute(tx)
        if (now?.policies) await sql`alter policy ${pid} on ${id} using (${policy.expr}) with check (${policy.expr})`.execute(tx)
        else await sql`create policy ${pid} on ${id} using (${policy.expr}) with check (${policy.expr})`.execute(tx)
      })
      return
    } catch (err) {
      if ((err as { code?: string }).code !== '55P03' || attempt === LOCK_TRIES) throw err
    }
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
    // `people` carries its own policy name; drop it too where present so the rollback leaves nothing behind.
    if (t === PEOPLE_TABLE) await sql`drop policy if exists ${sql.id(PEOPLE_POLICY)} on ${id}`.execute(db)
    await sql`alter table ${id} no force row level security`.execute(db)
    await sql`alter table ${id} disable row level security`.execute(db)
  }
}

/**
 * The same pool, with every checkout on the bypass side. For Better Auth: its tables hold sessions and OAuth tokens, and
 * requests never need them directly, so the app role has no rights on them. Closing belongs to the main handle.
 */
export function ownerPool<P extends PoolLike>(pool: P): P {
  const wrapped = Object.create(pool) as P
  wrapped.connect = () => withBypass('owner-pool', () => pool.connect())
  wrapped.end = async () => undefined
  return wrapped
}

const owners = new WeakMap<object, object>()

/** Remembers a handle's bypass-side twin, for ownerOf. */
export const registerOwner = (db: object, owner: object): void => void owners.set(db, owner)

/**
 * `db` on the bypass side, for the tables requests have no rights on (sign-in, links, tokens). Those carry no workspace,
 * so there's nothing for RLS to scope; grants keep requests away from them, and this is the one way through.
 */
export const ownerOf = <T extends object>(db: T): T => (owners.get(db) as T | undefined) ?? db

/**
 * For a `.catch` on a delete or revoke: a missing table or row is fine, but a refused one means tokens stay behind, so
 * it must fail where someone sees it. 42501 is Postgres's insufficient_privilege.
 */
export const unlessDenied =
  <T>(fallback: T) =>
  (err: unknown): T => {
    if ((err as { code?: string }).code !== '42501') return fallback
    console.error('[agfn] permission denied on a delete or revoke:', err instanceof Error ? err.message : String(err))
    throw err
  }

const FULL = ['SELECT', 'INSERT', 'UPDATE', 'DELETE']

/**
 * What the app role may do on tables with no workspace_id, which have no policy: grants are all that protects them.
 * Tables with workspace_id get full rights, because RLS scopes them. Anything else, including a new table, gets nothing.
 */
const APP_RIGHTS: Record<string, readonly string[]> = {
  people: ['SELECT', 'INSERT', 'UPDATE'],
  workspaces: ['SELECT', 'INSERT', 'UPDATE'],
  fx_rates: ['SELECT', 'INSERT', 'UPDATE'],
  rate_limit_counters: FULL,
  creator_links: ['SELECT'],
  creator_attributions: ['SELECT'],
}

type GrantChange = { table: string; add: string[]; drop: string[] }

/** What differs from what the role should hold, by what Postgres would actually allow, whoever granted it. */
async function grantChanges(db: Kysely<any>, role: string): Promise<GrantChange[]> {
  const owned = new Set(await workspaceTables(db))
  const rows = await sql<{ name: string; priv: string; has: boolean }>`
    select c.relname as name, r.priv, has_table_privilege(${role}, c.oid, r.priv) as has
    from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = current_schema()
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as r(priv)
    where c.relkind in ('r', 'p')`.execute(db)
  const byTable = new Map<string, GrantChange>()
  for (const { name, priv, has } of rows.rows) {
    const c = byTable.get(name) ?? { table: name, add: [], drop: [] }
    const want = (owned.has(name) ? FULL : (APP_RIGHTS[name] ?? [])).includes(priv)
    if (want && !has) c.add.push(priv)
    if (!want && has) c.drop.push(priv)
    byTable.set(name, c)
  }
  return [...byTable.values()].filter((c) => c.add.length || c.drop.length)
}

/**
 * Only what differs is changed, in one transaction, so a boot with nothing to do takes no locks and no request sees a
 * gap. A right that can't be removed (held through another role, or granted by someone else) refuses to start.
 */
async function syncAppGrants(db: Kysely<any>, role: string): Promise<void> {
  const changes = await grantChanges(db, role)
  if (changes.length)
    await db.transaction().execute(async (tx) => {
      for (const c of changes) {
        if (c.add.length) await sql`grant ${sql.raw(c.add.join(', '))} on ${sql.id(c.table)} to ${sql.id(role)}`.execute(tx)
        if (c.drop.length) await sql`revoke ${sql.raw(c.drop.join(', '))} on ${sql.id(c.table)} from ${sql.id(role)}`.execute(tx)
      }
    })
  const left = await grantChanges(db, role)
  if (left.length) throw new RlsBootError(`${role} doesn't hold the right rights on ${left.length} table(s) (${left.slice(0, 5).map((c) => c.table).join(', ')}). Refusing to start.`)
}

/**
 * A role that RLS applies to (no superuser, no BYPASSRLS), with rights on the public schema. For tests and for
 * deployments whose connection user is a superuser (PGlite always is). Idempotent. Run after migrations: a new table
 * gets its rights here, so a table that isn't listed stays closed to requests.
 */
export async function ensureAppRole(db: Kysely<any>, role = 'agfn_app'): Promise<void> {
  const exists = await sql<{ n: number }>`select count(*)::int as n from pg_roles where rolname = ${role}`.execute(db)
  if (!exists.rows[0]?.n) await sql`create role ${sql.id(role)} nologin nosuperuser nobypassrls`.execute(db)
  await sql`grant usage on schema public to ${sql.id(role)}`.execute(db)
  await sql`alter default privileges in schema public revoke select, insert, update, delete on tables from ${sql.id(role)}`.execute(db)
  await syncAppGrants(db, role)
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
export async function syncRlsPolicies(db: Kysely<any>, enabled: boolean, opts: { people?: boolean } = {}): Promise<{ enabled: string[]; disabled: string[] }> {
  if (enabled) {
    // `opts.people` gates the people policy (applied one release after the code that tolerates it; see tablesMissingRls).
    const missing = await tablesMissingRls(db, opts)
    await enableRls(db, missing)
    return { enabled: missing, disabled: [] }
  }
  // Include `people` in the rollback: it carries its own policy, so RLS left on there must come off too.
  const on = await rlsStatus(db, [...(await workspaceTables(db)), PEOPLE_TABLE])
  if (on.length) {
    await disableRls(db, on)
    console.warn(`[agfn] AGFN_PG_RLS is off: turned row-level security off again on ${on.length} table(s)`)
  }
  return { enabled: [], disabled: on }
}

export class RlsBootError extends Error {
  override name = 'RlsBootError'
}

const NEON_HOST = /(^|\.)neon\.tech$/i
/** Amazon RDS and Aurora endpoints (instance, cluster and proxy hosts all end this way). */
const RDS_HOST = /\.rds\.amazonaws\.com$/i
/** An RDS Proxy endpoint: `<name>.proxy-<id>.<region>.rds.amazonaws.com`. */
const RDS_PROXY_HOST = /\.proxy-[a-z0-9]+\.[a-z0-9-]+\.rds\.amazonaws\.com$/i

const hostOf = (url: string | undefined): string | null => {
  if (!url) return null
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

/**
 * A database URL on a managed Postgres that hosted Aggregate runs on: Neon today, Amazon RDS after the move. Either one
 * means hosted, so a machine started without its config still keeps row-level security on. Unparseable URLs count as
 * neither.
 */
function onManagedPostgres(url: string | undefined): boolean {
  const host = hostOf(url)
  return !!host && (NEON_HOST.test(host) || RDS_HOST.test(host))
}

/**
 * A Neon URL that routes through the connection pooler (its endpoint host carries the "-pooler" suffix, e.g.
 * `ep-x-pooler.…neon.tech`). The pooler is PgBouncer in transaction mode, so consecutive statements on one checked-out
 * "connection" can land on different backends. Our row-level-security context is a per-connection session setting
 * (`set_config('agfn.workspace_id', …, false)`); on the pooler it may not reach the backend that runs the next
 * statement — a workspace write then lands with the wrong or empty workspace, and a reused backend could even carry a
 * prior request's workspace into the next. RLS must use the direct (non-pooler) host. Unparseable URLs count as not a
 * pooler. */
export function isPoolerUrl(url: string | undefined): boolean {
  const host = hostOf(url)
  if (!host) return false
  // RDS Proxy multiplexes too: it pins a client to one database connection on SET statements, but our context is set
  // with set_config() inside a SELECT, which it doesn't treat as session state, so it could hand the next statement to
  // another backend.
  return (NEON_HOST.test(host) && /-pooler(\.|$)/i.test(host)) || RDS_PROXY_HOST.test(host)
}

/**
 * What looks like PgBouncer: a host named for it, or its default port 6432. Session mode is safe (docs/security/rls.md)
 * and self-hosters may run it, so this is refused only on hosted Aggregate, which connects directly.
 */
export function looksLikePgbouncer(url: string | undefined): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    return /pgbouncer/i.test(u.hostname) || u.port === '6432'
  } catch {
    return false
  }
}

/**
 * Whether this server is hosted Aggregate (AGFN_HOSTED=1, or its database is on Neon or Amazon RDS). The database check
 * matters on its own: a machine started without its config file has no AGFN_HOSTED but still has the database secret.
 */
export function isHostedDb(env: Record<string, string | undefined>, databaseUrl: string): boolean {
  return env.AGFN_HOSTED === '1' || onManagedPostgres(databaseUrl) || onManagedPostgres(env.AGFN_PG_APP_URL)
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
 * - Hosted (AGFN_HOSTED=1 or a Neon or RDS database): anything but AGFN_PG_RLS=1 refuses to start; so does any pooler.
 * - AGFN_PG_RLS=off (self-hosted only): the rollback, turns RLS off.
 * - Unset (self-hosted): fine while RLS is off; if an earlier boot turned it on, refuses to start rather than guess.
 */
export async function bootRls(db: Kysely<any>, env: Record<string, string | undefined>, databaseUrl: string): Promise<{ enabled: string[]; disabled: string[] }> {
  const setting = rlsSetting(env)
  const hosted = isHostedDb(env, databaseUrl)
  if (setting === 'on') {
    // RLS leans on per-connection session GUCs, so it can't run through a transaction pooler (Neon's "-pooler" host, RDS
    // Proxy; see isPoolerUrl), and hosted connects directly, never through PgBouncer. Guard both the main URL and the
    // separate app login (phase 2 routes workspace writes through AGFN_PG_APP_URL).
    const pooler = (url: string | undefined) => isPoolerUrl(url) || (hosted && looksLikePgbouncer(url))
    const pooled = pooler(databaseUrl) ? 'DATABASE_URL' : pooler(env.AGFN_PG_APP_URL) ? 'AGFN_PG_APP_URL' : null
    if (pooled)
      throw new RlsBootError(
        `${pooled} routes through a connection pooler (Neon's "-pooler" host, RDS Proxy, or PgBouncer), which breaks row-level security: the per-connection session context (set_config of agfn.workspace_id) can't be trusted to reach the backend running each statement, so a workspace write can land with the wrong or empty workspace. Use the database's direct host. Refusing to start.`,
      )
    // The people policy ships one release behind the code that tolerates it: apply and require it only once
    // AGFN_PEOPLE_RLS=1 is set, after every machine runs that code (a rolling restart with the flag on). Until then the
    // workspace policies are enforced as usual and people stays open, which old and new code both handle.
    const people = env.AGFN_PEOPLE_RLS === '1'
    const r = await syncRlsPolicies(db, true, { people })
    const gaps = await tablesMissingRls(db, { people })
    if (gaps.length) throw new RlsBootError(`row-level security is not on for ${gaps.length} table(s) after boot (${gaps.slice(0, 5).join(', ')}${gaps.length > 5 ? ', …' : ''}). Refusing to start.`)
    return r
  }
  if (hosted) {
    throw new RlsBootError(
      setting === 'off'
        ? 'AGFN_PG_RLS=off is not allowed on hosted Aggregate (AGFN_HOSTED=1 or a Neon or RDS database): row-level security stays on. Refusing to start.'
        : 'AGFN_PG_RLS is not set, and this is hosted Aggregate (AGFN_HOSTED=1 or a Neon or RDS database), which requires AGFN_PG_RLS=1. Is this machine missing its [env] config? Refusing to start, so row-level security stays on for every server.',
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
