// agfn demo [--port N] [--fresh]
// From any folder, with no keys: starts a local Aggregate with a made-up, reconciled sample business (the same demo the
// app offers), then prints the line that connects Claude Code and a link that signs you in to the web app. Data lives
// in ~/.agfn/demo (AGFN_DEMO_DIR to move it); --fresh starts over. Nothing here touches real money or real accounts.

import { randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UsageError, flagString, parseArgs, rejectUnknown, type Io } from './io.ts'

const NAME = 'aggregate-demo'
const EMAIL = 'demo@agfn.localhost'
const KEY_DAYS = 90
/** Four months of made-up history: enough for trends, recurring bills and runway, and quick to fill. */
const HISTORY_DAYS = 120

interface Saved {
  authSecret: string
  masterKey: string
  /** The agent key the printed `claude mcp add` line carries; reused across runs while the database is kept. */
  agentKey?: string
  agentKeyExpiresAt?: string
}

export interface DemoDeps {
  /** Where the built web app is (the npm package ships it next to agfn.mjs); none = API and MCP only. */
  webDist?: string
  /** Stop after printing (tests); otherwise the server runs until Ctrl+C. */
  exitAfterReady?: boolean
  /** Override for tests: the time budget for the demo fill. */
  fillTimeoutMs?: number
}

export async function demoLocalCommand(argv: string[], io: Io, deps: DemoDeps = {}): Promise<number> {
  const args = parseArgs(argv, ['fresh'])
  rejectUnknown(args, ['port', 'fresh'])
  const portFlag = flagString(args, 'port')
  if (portFlag !== undefined && !/^\d{2,5}$/.test(portFlag)) throw new UsageError('--port must be a number, e.g. --port 8787')
  const started = Date.now()
  const dir = io.env.AGFN_DEMO_DIR || join(homedir(), '.agfn', 'demo')
  if (args.flags.has('fresh')) rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  // Next to the npm package's bundle: the web app and the compiled migrations (a checkout uses its own).
  const here = dirname(fileURLToPath(import.meta.url))
  if (existsSync(join(here, 'migrations'))) process.env.AGFN_MIGRATIONS_DIR = join(here, 'migrations')
  const savedPath = join(dir, 'demo.json')
  const dbPath = join(dir, 'demo.db')
  const saved: Saved = existsSync(savedPath) && existsSync(dbPath) ? (JSON.parse(readFileSync(savedPath, 'utf8')) as Saved) : { authSecret: randomBytes(32).toString('hex'), masterKey: '' }
  const save = () => writeFileSync(savedPath, JSON.stringify(saved, null, 2), { mode: 0o600 })

  const port = portFlag ? Number(portFlag) : await freePort(8787, 8799)
  if (port === null) throw new UsageError('ports 8787-8799 are all in use; pick one with --port')
  const base = `http://localhost:${port}`

  // The server's own logs go to a file, so the terminal shows only what to do next.
  const logPath = join(dir, 'server.log')
  const restore = quiet(logPath)
  const mark = (phase: string) => console.info(`[agfn] demo phase ${phase}: ${Date.now() - started} ms`)
  let shutdown: (() => Promise<void>) | undefined
  try {
    const { generateMasterKey, loadKeyRing } = await import('@agfn/security')
    if (!saved.masterKey) saved.masterKey = generateMasterKey()
    save()
    const env: NodeJS.ProcessEnv = {
      AUTH_SECRET: saved.authSecret,
      AGFN_MASTER_KEY: saved.masterKey,
      DATABASE_URL: `sqlite:${dbPath}`,
      BASE_URL: base,
      PORT: String(port),
      HOST: '127.0.0.1',
      WEB_DIST: deps.webDist ?? join(here, 'web'),
      // Files the server keeps (uploaded documents) stay in the demo folder, not wherever this was run from.
      DATA_DIR: dir,
      SYNC_EVERY_MINUTES: '1440',
    }
    const outbox: string[] = []
    const [{ loadConfig }, { boot }, { createApp }, { loadInstalledModules }, { serve }, registry] = await Promise.all([
      import('@agfn/server/config'),
      import('@agfn/server/boot'),
      import('@agfn/server/app'),
      import('@agfn/server/modules'),
      import('@hono/node-server'),
      import('@agfn/connector-registry'),
    ])
    const config = loadConfig(env)
    const modules = await loadInstalledModules(env, { registry: registry as never })
    const booted = await boot({ config, env, keys: loadKeyRing(env), mailer: { send: async (m) => void outbox.push(m.text) }, ...modules })
    const app = createApp(booted.services)
    mark('booted')
    const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }) as unknown as Server
    shutdown = async () => {
      server.close()
      await booted.shutdown()
    }

    // Signed in as the demo person, in this process (no email leaves it).
    const signInLink = async () => {
      const before = outbox.length
      const res = await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ email: EMAIL, callbackURL: '/' }) })
      if (!res.ok) throw new Error(`sign-in failed (${res.status})`)
      const link = outbox.slice(before).join('\n').match(/https?:\/\/\S+/)?.[0]
      if (!link) throw new Error('no sign-in link')
      return link
    }
    const verified = await app.request((await signInLink()).replace(base, ''), { headers: { origin: base } })
    const cookie = verified.headers
      .getSetCookie()
      .map((c) => c.split(';')[0]!)
      .filter((c) => !c.endsWith('='))
      .join('; ')
    const api = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
      const res = await app.request(path, { method, headers: { origin: base, cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
      const text = await res.text()
      return { status: res.status, body: (text ? JSON.parse(text) : null) as T }
    }

    mark('signed in')
    // The app's own demo (createDemoWorkspace, as POST /api/demo), with a shorter history. Its connections import one
    // after another in the background (boot.ts): the first company is ready to ask about in seconds.
    const me = await api<{ personId: string; workspaceId: string | null }>('GET', '/api/me')
    const [{ createDemoWorkspace }, { equityFor }, { demoDocuments }, { withWorkspace }] = await Promise.all([
      import('@agfn/demo'),
      import('@agfn/server/equity'),
      import('@agfn/server/reviewer'),
      import('@agfn/db'),
    ])
    const s = booted.services
    const ledger = s.ledger as { createBucket?: unknown; createRule?: unknown }
    const created = await createDemoWorkspace(
      { db: s.db, keys: s.keys, extras: { ...(ledger.createBucket && ledger.createRule ? { buckets: s.ledger as never } : {}), equity: equityFor(s), documents: demoDocuments(s) } },
      { personId: me.body.personId, historyDays: HISTORY_DAYS },
    )
    const demo = { body: { created: created.created, entities: created.entities } }
    if (created.created && created.connections[0]) await withWorkspace(created.workspaceId, () => s.sync.request(created.workspaceId, created.connections[0]!))
    mark('demo created')
    if (created.created) {
      io.out('Filling four months of made-up activity for the sample companies…')
      await waitForFill(api, deps.fillTimeoutMs ?? 60_000, 1)
      mark('first company filled')
    }

    if (!saved.agentKey || !saved.agentKeyExpiresAt || Date.parse(saved.agentKeyExpiresAt) - Date.now() < 86_400_000) {
      const expiresAt = new Date(Date.now() + KEY_DAYS * 86_400_000).toISOString()
      const shape = { entityIds: 'all', dataTypes: ['balances', 'transactions', 'invoices', 'bills', 'buckets', 'payroll', 'equity', 'documents', 'reports', 'personal'], write: true, reviewMode: 'instant', expiresAt }
      const key = await api<{ key?: string; message?: string }>('POST', '/api/ai/keys', { name: 'Claude Code (demo)', shape })
      if (!key.body?.key) throw new Error(`couldn't make an AI key (${key.status}${key.body?.message ? `: ${key.body.message}` : ''})`)
      saved.agentKey = key.body.key
      saved.agentKeyExpiresAt = expiresAt
      save()
    }
    const webLink = await signInLink()

    io.out(
      [
        '',
        `Aggregate demo is running at ${base} (sample data only, ready in ${Math.round((Date.now() - started) / 1000)}s)`,
        `Companies: ${demo.body.entities.map((e) => e.name).join(', ')}${demo.body.created ? ' (the rest of the sample data fills in within a minute)' : ''}`,
        '',
        'Connect Claude Code (run in another terminal):',
        `  claude mcp add --transport http ${NAME} ${base}/mcp --header "Authorization: Bearer ${saved.agentKey}"`,
        '',
        'Then ask it: "Give me an overview of my companies." (This key can also add records to the sample data.)',
        '',
        `Open the web app (this link signs you in, valid for a few minutes): ${webLink}`,
        '',
        `Ctrl+C stops it. Data: ${dir}  (agfn demo --fresh starts over; delete the folder to remove it)`,
      ].join('\n'),
    )
    if (deps.exitAfterReady) return 0
    await new Promise<void>((resolve) => {
      const stop = () => resolve()
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    })
    return 0
  } finally {
    await shutdown?.().catch(() => undefined)
    restore.done()
  }
}

/** Until every demo connection has synced once, or the time is up (then the app shows the rest filling in). */
async function waitForFill(api: <T>(m: string, p: string) => Promise<{ status: number; body: T }>, timeoutMs: number, atLeast?: number): Promise<number> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const ws = await api<{ connections?: Array<{ connectorKey: string; status: string; lastSyncAt: string | null }> }>('GET', '/api/workspace')
    // Built-in sources (the cap table, cash added by hand) never sync; the demo's own connections do.
    const conns = (ws.body?.connections ?? []).filter((c) => c.connectorKey === 'demo')
    const done = conns.filter((c) => c.status !== 'syncing' && c.lastSyncAt).length
    if (conns.length && done >= (atLeast ?? conns.length)) return conns.length - done
    await new Promise((r) => setTimeout(r, 500))
  }
  return -1
}

async function freePort(from: number, to: number): Promise<number | null> {
  for (let p = from; p <= to; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = createServer()
      s.once('error', () => resolve(false))
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (ok) return p
  }
  return null
}

/** Sends the server's console output to a log file (io.out still prints to the terminal); errors show in both. */
function quiet(logPath: string): { done: () => void } {
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error }
  const toFile = (...a: unknown[]) => {
    try {
      appendFileSync(logPath, `${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`, { mode: 0o600 })
    } catch {
      /* best effort */
    }
  }
  console.log = console.info = console.warn = toFile
  console.error = (...a: unknown[]) => {
    toFile(...a)
    orig.error(...a)
  }
  return { done: () => Object.assign(console, orig) }
}
