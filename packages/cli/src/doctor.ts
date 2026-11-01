// agfn doctor [--online]
// Checks this install: Node, settings, master key, database + migrations, connectors and connection health.
// --online also verifies provider app credentials with one harmless read (Plaid only for now).
// Never prints a secret: only whether it's set and well-formed.

import { readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Kysely } from 'kysely'
import { connect, MIGRATIONS_DIR } from '@agfn/db'
import { loadKeyRing } from '@agfn/security'
import { installedConnectorList, unconfiguredConnectors } from '@agfn/connector-registry'
import { PlaidClient } from '@agfn/connector-plaid'
import { databaseUrlFor } from './init.ts'
import { parseArgs, rejectUnknown, type Io } from './io.ts'

/** off: optional and not set up (nothing wrong). */
export type CheckStatus = 'ok' | 'off' | 'warn' | 'fail'
export interface Check {
  name: string
  status: CheckStatus
  detail: string
}

export interface DoctorDeps {
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
}

const MARK: Record<CheckStatus, string> = { ok: '✓', off: '·', warn: '!', fail: '✗' }

function nodeCheck(): Check {
  const [maj = 0, min = 0] = process.versions.node.split('.').map(Number)
  const ok = maj > 22 || (maj === 22 && min >= 18)
  return { name: 'node', status: ok ? 'ok' : 'fail', detail: ok ? `v${process.versions.node}` : `v${process.versions.node}: needs 22.18+ (runs TypeScript directly)` }
}

function settingsChecks(env: NodeJS.ProcessEnv, dataDir: string): Check[] {
  const out: Check[] = []
  const auth = env.AUTH_SECRET ?? ''
  out.push(
    !auth
      ? { name: 'AUTH_SECRET', status: 'fail', detail: 'not set (run `agfn init`)' }
      : auth.length < 32
        ? { name: 'AUTH_SECRET', status: 'fail', detail: 'shorter than 32 characters' }
        : { name: 'AUTH_SECRET', status: 'ok', detail: 'set' },
  )
  try {
    loadKeyRing(env, dataDir)
    out.push({ name: 'master key', status: 'ok', detail: env.AGFN_MASTER_KEY_FILE ? 'loaded from AGFN_MASTER_KEY_FILE' : env.AGFN_MASTER_KEY_COMMAND ? 'loaded from AGFN_MASTER_KEY_COMMAND' : 'loaded from AGFN_MASTER_KEY' })
  } catch (e) {
    out.push({ name: 'master key', status: 'fail', detail: e instanceof Error ? e.message : 'invalid' })
  }
  const base = env.BASE_URL ?? 'http://localhost:8787'
  try {
    const u = new URL(base)
    const local = ['localhost', '127.0.0.1'].includes(u.hostname) || u.hostname.endsWith('.local')
    out.push(
      u.protocol === 'https:' || local
        ? { name: 'BASE_URL', status: 'ok', detail: base }
        : { name: 'BASE_URL', status: 'warn', detail: `${base} is not https: sign-in cookies and OAuth callbacks need https on a public host` },
    )
  } catch {
    out.push({ name: 'BASE_URL', status: 'fail', detail: `not a URL: ${base}` })
  }
  return out
}

interface DbTables {
  kysely_migration: { name: string }
  connections: { connector_key: string; status: string; last_error: string | null; display_name: string; id: string }
}

async function databaseChecks(env: NodeJS.ProcessEnv, cwd: string): Promise<{ checks: Check[]; connectorKeys: string[] }> {
  const url = databaseUrlFor(env, cwd)
  const shown = url.replace(/\/\/[^@/]*@/, '//***@')
  const checks: Check[] = []
  const connectorKeys: string[] = []
  let h
  try {
    h = connect(url)
  } catch (e) {
    return { checks: [{ name: 'database', status: 'fail', detail: `${shown}: ${e instanceof Error ? e.message : 'cannot open'}` }], connectorKeys }
  }
  try {
    const db = h.db as unknown as Kysely<DbTables>
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_[a-z0-9_]+\.ts$/.test(f)).map((f) => f.replace(/\.ts$/, ''))
    let applied: string[] = []
    try {
      applied = (await db.selectFrom('kysely_migration').select('name').execute()).map((r) => r.name)
    } catch {
      applied = []
    }
    const pending = files.filter((f) => !applied.includes(f))
    checks.push({ name: 'database', status: 'ok', detail: shown })
    checks.push(
      pending.length
        ? { name: 'migrations', status: 'fail', detail: `${pending.length} pending (${pending.slice(0, 4).join(', ')}${pending.length > 4 ? ', …' : ''}): run \`agfn migrate\`` }
        : { name: 'migrations', status: 'ok', detail: `${applied.length} applied` },
    )
    if (!pending.length) {
      const rows = await db.selectFrom('connections').select(['id', 'connector_key', 'status', 'last_error', 'display_name']).execute()
      const bad = rows.filter((r) => r.status === 'needs_reauth' || r.status === 'error')
      for (const r of rows) connectorKeys.push(r.connector_key)
      checks.push(
        bad.length
          ? {
              name: 'connections',
              status: 'warn',
              detail: `${rows.length} total; ${bad.map((r) => `${r.display_name} (${r.connector_key}, ${r.id}): ${r.status}${r.last_error ? ' — ' + r.last_error.slice(0, 80) : ''}`).join('; ')}`,
            }
          : { name: 'connections', status: 'ok', detail: `${rows.length} total, all healthy` },
      )
    }
  } catch (e) {
    checks.push({ name: 'database', status: 'fail', detail: `${shown}: ${e instanceof Error ? e.message : 'query failed'}` })
  } finally {
    await h.close()
  }
  return { checks, connectorKeys }
}

const redirectFor = (env: NodeJS.ProcessEnv) => `${(env.BASE_URL ?? `http://localhost:${env.PORT ?? 8787}`).replace(/\/+$/, '')}/connect/plaid/oauth`

export function connectorChecks(env: NodeJS.ProcessEnv, used: string[]): Check[] {
  const installed = installedConnectorList(env).map((c) => c.key)
  const out: Check[] = [{ name: 'connectors', status: 'ok', detail: installed.join(', ') }]
  // App-based connectors without keys: what to set, and the redirect URI to register (same guides as the web).
  for (const g of unconfiguredConnectors(env, installed)) {
    const what = `set ${g.setup?.env?.join(', ')}${g.setup?.redirectUri ? `; register ${g.setup.redirectUri}` : ''}`
    if (g.key === 'plaid') out.push({ name: 'plaid', status: 'warn', detail: `banks are off: ${what} to connect banks and cards (or use SimpleFIN or statement uploads)` })
    else out.push({ name: g.key, status: 'off', detail: `${g.name} isn't set up: ${what}` })
  }
  // Plaid in production without a redirect URI: OAuth banks (Chase, Bank of America…) can't finish connecting.
  if (installed.includes('plaid') && env.PLAID_ENV === 'production' && !env.PLAID_LINK_REDIRECT_URI) {
    out.push({ name: 'plaid', status: 'warn', detail: `PLAID_LINK_REDIRECT_URI isn't set: banks like Chase can't finish connecting. Register ${redirectFor(env)} in Plaid (Developers → API) and set it` })
  }
  // Built-in sources, not connectors: uploads, "Added by hand" entries and the native cap table.
  const builtIn = new Set(['files', 'manual', 'equity'])
  const orphaned = [...new Set(used)].filter((k) => !installed.includes(k) && !builtIn.has(k))
  if (orphaned.length) out.push({ name: 'connectors', status: 'fail', detail: `connections exist for ${orphaned.join(', ')} but those connectors aren't configured here` })
  return out
}

async function onlineChecks(env: NodeJS.ProcessEnv, deps: DoctorDeps): Promise<Check[]> {
  const out: Check[] = []
  if (env.PLAID_CLIENT_ID && env.PLAID_SECRET) {
    const plaidEnv = env.PLAID_ENV === 'production' ? 'production' : 'sandbox'
    const client = new PlaidClient({ clientId: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, env: plaidEnv }, deps.fetch ? { fetch: deps.fetch, clock: { now: Date.now, sleep: async () => {} } } : {})
    try {
      await client.call('/institutions/get_by_id', { institution_id: 'ins_109508', country_codes: ['US'] })
      out.push({ name: 'plaid keys', status: 'ok', detail: `accepted by Plaid ${plaidEnv}` })
    } catch (e) {
      out.push({ name: 'plaid keys', status: 'fail', detail: `Plaid ${plaidEnv} rejected them: ${e instanceof Error ? e.message : 'error'}` })
    }
  }
  return out
}

/** DATA_DIR holds the whole ledger (the SQLite file, document files): other users on this machine shouldn't read it. */
export function dataDirCheck(dataDir: string): Check[] {
  if (process.platform === 'win32') return []
  let mode: number
  try {
    mode = statSync(dataDir).mode
  } catch {
    return []
  }
  if ((mode & 0o077) === 0) return [{ name: 'data dir', status: 'ok', detail: `${dataDir} (only you can read it)` }]
  return [{ name: 'data dir', status: 'warn', detail: `${dataDir} can be read by other users on this machine: run \`chmod -R go-rwx ${dataDir}\`` }]
}

export async function runChecks(io: Io, opts: { online?: boolean } = {}, deps: DoctorDeps = {}): Promise<Check[]> {
  const env = io.env
  const dataDir = resolve(io.cwd, env.DATA_DIR ?? './data')
  const db = await databaseChecks(env, io.cwd)
  return [
    nodeCheck(),
    ...settingsChecks(env, dataDir),
    ...(databaseUrlFor(env, io.cwd).startsWith('sqlite:') ? dataDirCheck(dataDir) : []),
    ...db.checks,
    ...connectorChecks(env, db.connectorKeys),
    ...(opts.online ? await onlineChecks(env, deps) : []),
  ]
}

export async function doctorCommand(argv: string[], io: Io, deps: DoctorDeps = {}): Promise<number> {
  const args = parseArgs(argv, ['online'])
  rejectUnknown(args, ['online'])
  const checks = await runChecks(io, { online: args.flags.has('online') }, deps)
  const width = Math.max(...checks.map((c) => c.name.length))
  for (const c of checks) io.out(`${MARK[c.status]} ${c.name.padEnd(width)}  ${c.detail}`)
  const failed = checks.filter((c) => c.status === 'fail').length
  const warned = checks.filter((c) => c.status === 'warn').length
  io.out(failed ? `${failed} problem${failed === 1 ? '' : 's'} to fix.` : warned ? 'OK, with notes above.' : 'All good.')
  return failed ? 1 : 0
}
