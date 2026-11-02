// Scenario harness: the REAL server (boot + createApp + ledger + finance composition + MCP), with scripted
// providers in place of live APIs. Each scenario signs a person in through the real auth routes, connects providers,
// syncs through the real SyncEngine, and reads the numbers back through BOTH the REST routes (as the UI does) and
// MCP tool calls with an agent key (as an AI does).
//
// Scripted connectors emit normalized events page by page; the per-provider HTTP mapping is covered by each
// connector's own contract tests on redacted fixtures, so scenarios test what happens after the connector boundary.
import type { Connector, ConnectorDescription, GrantShape, NormalizedEvent } from '@agfn/contracts'
import type { ConnectorFactory } from '@agfn/sync'
import { createConnection } from '@agfn/sync'
import { connectPglite, ensureAppRole, exclusivePool, rlsPool, withBypass, withWorkspace, type CoreTables, type DbHandle } from '@agfn/db'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { MemoryFileStore } from '@agfn/files'
import { createFilesConnector } from '@agfn/connector-files'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { boot, type Booted } from '../boot.ts'
import { createApp } from '../app.ts'
import { loadConfig } from '../config.ts'
import { financeFor } from '../finance.ts'
import { ledgerFor, mcpFor } from '../modules.ts'

export const BASE = 'http://localhost:8787'

// ---------- today ----------

/**
 * Scenarios are written against a fixed "today" (runway uses the last 3 full months, aging counts days overdue).
 * Not every component takes a clock, so the whole process runs on a shifted clock: it starts at SCENARIO_NOW and
 * keeps ticking, so ordering, ids and expiries behave normally. Vitest isolates each test file.
 */
export const SCENARIO_TODAY = '2026-10-10'
const RealDate = Date
const offset = RealDate.parse(`${SCENARIO_TODAY}T12:00:00Z`) - RealDate.now()
class ScenarioDate extends RealDate {
  constructor(...a: unknown[]) {
    if (a.length === 0) super(RealDate.now() + offset)
    else super(...(a as [string]))
  }
  static override now(): number {
    return RealDate.now() + offset
  }
}
globalThis.Date = ScenarioDate as DateConstructor

// ---------- scripted providers ----------

/** Pages of events per connection, appended by the scenario between syncs ("the bank has new rows"). */
const scripts = new Map<string, NormalizedEvent[][]>()

const DESCRIPTIONS: Record<string, ConnectorDescription> = {
  plaid: { key: 'plaid', name: 'Bank or card', group: 'banks', provides: ['balances', 'transactions'], freshness: 'scripted', auth: 'link_widget' },
  stripe: { key: 'stripe', name: 'Stripe', group: 'payments', provides: ['balances', 'transactions', 'invoices'], freshness: 'scripted', auth: 'api_key' },
  quickbooks: { key: 'quickbooks', name: 'QuickBooks', group: 'accounting', provides: ['invoices', 'bills', 'reports'], freshness: 'scripted', auth: 'oauth' },
  xero: { key: 'xero', name: 'Xero', group: 'accounting', provides: ['invoices', 'bills', 'reports'], freshness: 'scripted', auth: 'oauth' },
  simplefin: { key: 'simplefin', name: 'SimpleFIN Bridge', group: 'banks', provides: ['balances', 'transactions'], freshness: 'scripted', auth: 'api_key' },
  square: { key: 'square', name: 'Square', group: 'payments', provides: ['balances', 'transactions', 'invoices'], freshness: 'scripted', auth: 'oauth' },
  shopify: { key: 'shopify', name: 'Shopify Payments', group: 'payments', provides: ['balances', 'transactions'], freshness: 'scripted', auth: 'oauth' },
}

function scripted(key: string): ConnectorFactory {
  return (deps) => {
    const c: Connector = {
      describe: () => DESCRIPTIONS[key] as ConnectorDescription,
      connect: async () => ({ secret: { scripted: true }, config: {} }),
      async sync(conn, cursor) {
        const pages = scripts.get(conn.id) ?? []
        const i = cursor ? Number(cursor) : 0
        const page = pages[i] ?? []
        const events: NormalizedEvent[] = []
        for (const e of page) events.push({ ...e, rawRef: await deps.raw.put(conn.id, `${key}.scripted`, e.externalId, e) } as NormalizedEvent)
        const next = Math.min(i + 1, pages.length)
        return { events, cursor: String(next), hasMore: next < pages.length }
      },
      health: async () => ({ status: 'ok' }),
    }
    return c
  }
}

// ---------- server ----------

export interface Server {
  booted: Booted
  app: ReturnType<typeof createApp>
  outbox: string[]
  files: MemoryFileStore
  close(): Promise<void>
}

export interface ServerOptions {
  pglite?: boolean
  /** Extra config env (e.g. INBOUND_EMAIL_DOMAIN). */
  env?: Record<string, string>
  /** Real connector factories; one with the same key as a scripted provider replaces it. */
  connectors?: ConnectorFactory[]
  /** Scripted providers beyond plaid/stripe/quickbooks to install (e.g. simplefin); the default catalog stays small. */
  scripted?: string[]
}

/** Installed unless a scenario asks for more: other tests (red team 12) assert the exact catalog. */
const DEFAULT_SCRIPTED = ['plaid', 'stripe', 'quickbooks']

export async function startServer(opts: ServerOptions = {}): Promise<Server> {
  const outbox: string[] = []
  const files = new MemoryFileStore()
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent', ...opts.env }), runWorker: false }
  // AGFN_TEST_PG_RLS=1 runs the story on Postgres with row-level security on, as an RLS-bound role (docs/security/rls.md).
  const rls = process.env.AGFN_TEST_PG_RLS === '1'
  if (rls) process.env.AGFN_PG_RLS = '1'
  const db = rls
    ? await connectPglite<CoreTables>({ wrapPool: (p) => rlsPool(exclusivePool(p), { role: 'agfn_app' }) })
    : opts.pglite
      ? await connectPglite<CoreTables>()
      : undefined
  if (rls) await withBypass('test:role', () => ensureAppRole(db!.db as never))
  const booted = await boot({
    config,
    ...(db ? { db: db as DbHandle<CoreTables> } : {}),
    keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }),
    mailer: { send: async (m) => void outbox.push(m.text) },
    fileStore: files,
    // Uploaded statements import through the real files connector, as in production.
    connectors: ({ fileSource }) => [
      ...[...DEFAULT_SCRIPTED, ...(opts.scripted ?? [])].filter((k) => !(opts.connectors ?? []).some((f) => keyOf(f) === k)).map(scripted),
      ...(opts.connectors ?? []),
      ...((opts.connectors ?? []).some((f) => keyOf(f) === 'files') ? [] : [(d: Parameters<ConnectorFactory>[0]) => createFilesConnector({ source: fileSource as never }, d)]),
    ],
    // Same wiring as modules.ts loadInstalledModules: the S1 engine, then finance (S1 + S4/S5) behind MCP.
    ledger: (h, c) => ledgerFor(h.db, c),
    mcp: (s) => mcpFor(s, financeFor(s)),
  })
  return { booted, app: createApp(booted.services), outbox, files, close: () => booted.shutdown() }
}

function keyOf(f: ConnectorFactory): string {
  return f({ raw: { put: async () => '' } } as never).describe().key
}

// ---------- people ----------

export interface Session {
  personId: string
  workspaceId: string
  get<T = unknown>(path: string): Promise<{ status: number; body: T }>
  post<T = unknown>(path: string, body: unknown, init?: { headers?: Record<string, string>; raw?: BodyInit }): Promise<{ status: number; body: T }>
  /** Any method, with optional extra headers. */
  send<T = unknown>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T }>
  /** The session cookie header, for tests that build their own requests. */
  cookie(): string
}

export async function signIn(server: Server, email: string, companyName?: string): Promise<Session> {
  const { app, outbox } = server
  const jar = new Map<string, string>()
  const take = (res: Response) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const i = (pair as string).indexOf('=')
      const k = (pair as string).slice(0, i)
      const v = (pair as string).slice(i + 1)
      if (v) jar.set(k, v)
      else jar.delete(k)
    }
  }
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
  const before = outbox.length
  await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
  const link = outbox.slice(before).join('\n').match(/https?:\/\/\S+/)?.[0]
  if (!link) throw new Error('no magic link sent')
  take(await app.request(link.replace(BASE, ''), { headers: { origin: BASE } }))

  const call = async <T>(method: string, path: string, body?: unknown, init: { headers?: Record<string, string>; raw?: BodyInit } = {}) => {
    const headers: Record<string, string> = { origin: BASE, cookie: cookie(), ...init.headers }
    let payload: BodyInit | undefined = init.raw
    if (body !== undefined && payload === undefined) {
      headers['content-type'] ??= 'application/json'
      payload = JSON.stringify(body)
    }
    const res = await app.request(path, { method, headers, ...(payload !== undefined ? { body: payload } : {}) })
    const text = await res.text()
    let parsed: unknown = text
    try {
      parsed = JSON.parse(text)
    } catch {
      /* not json */
    }
    return { status: res.status, body: parsed as T }
  }
  let workspaceId = ''
  if (companyName) {
    const ws = await call<{ workspaceId: string }>('POST', '/api/workspaces', { companyName })
    if (ws.status !== 200 && ws.status !== 201) throw new Error(`create workspace: ${ws.status} ${JSON.stringify(ws.body)}`)
    workspaceId = ws.body.workspaceId
  }
  const me = await call<{ personId: string; workspaceId: string }>('GET', '/api/me')
  return {
    personId: me.body.personId,
    workspaceId: workspaceId || me.body.workspaceId,
    get: (path) => call('GET', path),
    post: (path, body, init) => call('POST', path, body, init),
    send: (method, path, body, headers) => call(method, path, body, headers ? { headers } : {}),
    cookie,
  }
}

/** Company ids by name, plus the Personal space. */
export async function entities(s: Session): Promise<Record<string, string>> {
  const ws = await s.get<{ entities: Array<{ id: string; name: string; kind: string }> }>('/api/workspace')
  return Object.fromEntries(ws.body.entities.map((e) => [e.kind === 'personal' ? 'Personal' : e.name, e.id]))
}

// ---------- providers ----------

export interface Provider {
  id: string
  /** Queue a page of events; `build` gets the connection id the events must carry. */
  push(build: (connectionId: string) => NormalizedEvent[]): void
  sync(): Promise<{ status: string; events: number; posted: number; message?: string }>
}

export async function connectProvider(server: Server, s: Session, key: keyof typeof DESCRIPTIONS & string, opts: { entityId?: string | null; name?: string; config?: Record<string, unknown> } = {}): Promise<Provider> {
  const sv = server.booted.services
  const id = await withWorkspace(s.workspaceId, () => createConnection(sv.db, sv.keys, {
    workspaceId: s.workspaceId,
    connectorKey: key,
    displayName: opts.name ?? (DESCRIPTIONS[key] as ConnectorDescription).name,
    secret: { scripted: true },
    config: opts.config ?? {},
    createdBy: s.personId,
    entityId: opts.entityId ?? null,
  }))
  scripts.set(id, [])
  return {
    id,
    push: (build) => void (scripts.get(id) as NormalizedEvent[][]).push(build(id)),
    // As the worker runs it (boot.ts bypassAll).
    sync: () => withBypass('worker:connection.sync', () => sv.sync.sync(id)) as never,
  }
}

/** Accounts of a connection by external id → Aggregate account id. */
export async function accountIds(server: Server, connectionId: string): Promise<Record<string, string>> {
  const rows = await withBypass('test:read', () => server.booted.services.db.selectFrom('accounts').select(['id', 'external_id']).where('connection_id', '=', connectionId).execute())
  return Object.fromEntries(rows.map((r) => [r.external_id ?? r.id, r.id]))
}

// ---------- AI ----------

export interface Ai {
  grantId: string
  key: string
  /** Calls a tool; returns structuredContent, or throws with the error text when isError. */
  call<T = Record<string, unknown>>(tool: string, args?: Record<string, unknown>): Promise<T>
  /** Same, but returns {isError, text, data} without throwing. */
  try(tool: string, args?: Record<string, unknown>): Promise<{ isError: boolean; text: string; data: Record<string, unknown> | undefined }>
  tools(): Promise<string[]>
  close(): Promise<void>
}

export const READ_WRITE_ALL: GrantShape = {
  entityIds: 'all',
  dataTypes: ['balances', 'transactions', 'invoices', 'bills', 'buckets', 'payroll', 'equity', 'documents', 'reports'],
  write: true,
  reviewMode: 'instant',
  // Agent keys must expire.
  expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
}

export async function connectAi(server: Server, s: Session, shape: GrantShape = READ_WRITE_ALL, name = 'Scenario bot'): Promise<Ai> {
  const created = await s.post<{ grantId: string; key: string; message?: string }>('/api/ai/keys', { name, shape })
  if (created.status !== 201 && created.status !== 200) throw new Error(`create agent key: ${created.status} ${JSON.stringify(created.body)}`)
  const { key, grantId } = created.body
  const fetchIn = (async (input: RequestInfo | URL, init?: RequestInit) => server.app.fetch(new Request(input, init))) as typeof fetch
  const client = new Client({ name: 'scenario', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchIn }))
  const tryCall = async (tool: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name: tool, arguments: args })
    const text = ((r.content as Array<{ type: string; text?: string }> | undefined) ?? []).map((c) => c.text ?? '').join('\n')
    return { isError: r.isError === true, text, data: r.structuredContent as Record<string, unknown> | undefined }
  }
  return {
    grantId,
    key,
    try: tryCall,
    async call<T>(tool: string, args: Record<string, unknown> = {}) {
      const r = await tryCall(tool, args)
      if (r.isError) throw new Error(`${tool} failed: ${r.text}`)
      return r.data as T
    },
    async tools() {
      return (await client.listTools()).tools.map((t) => t.name).sort()
    },
    close: () => client.close(),
  }
}

/** Money in wire form ("1234.56") to minor units, for exact assertions. */
export function minor(w: { amount: string } | null | undefined): number | null {
  if (!w) return null
  const neg = w.amount.startsWith('-')
  const [i = '0', f = ''] = w.amount.replace('-', '').split('.')
  const v = Number(i) * 100 + Number((f + '00').slice(0, 2))
  return neg ? -v : v
}
