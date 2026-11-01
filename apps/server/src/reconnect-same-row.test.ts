// A reconnect (or a second sign-in to the same provider company) must land in the existing connection, never a second
// row: records are keyed on the connection, so a copy would count the company's invoices, bills and revenue twice.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Connector, NormalizedEvent } from '@agfn/contracts'
import { generateMasterKey, loadKeyRing, unseal } from '@agfn/security'
import { MemoryFileStore } from '@agfn/files'
import { SECRET_PURPOSE } from '@agfn/sync'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { loadInstalledModules } from './modules.ts'

const BASE = 'http://localhost:8787'
let booted: Booted
let app: ReturnType<typeof createApp>
let outbox: string[]
/** What the next sign-in to each provider returns as its company (null: the provider names none). */
let company: Record<string, string | null>
let signIns = 0

const usd = (minor: number) => ({ minor, currency: 'USD' })
const books = (connectionId: string): NormalizedEvent[] =>
  [
    { type: 'invoice.upsert', externalId: 'inv-1', direction: 'receivable', number: 'INV-1', counterparty: 'Globex', issueDate: '2026-09-05', dueDate: '2026-10-05', total: usd(100_000), amountPaid: usd(0), status: 'open' },
    { type: 'invoice.upsert', externalId: 'bill-1', direction: 'payable', number: 'B-1', counterparty: 'Initech', issueDate: '2026-09-10', dueDate: '2026-10-10', total: usd(30_000), amountPaid: usd(0), status: 'open' },
  ].map((e) => ({ ...e, connectionId })) as NormalizedEvent[]

// OAuth-shaped fakes: QuickBooks names its company (realmId); Coinbase-like names none.
const fake = (key: string, idKey: string | null) => (): Connector => ({
  describe: () => ({ key, name: key === 'quickbooks' ? 'QuickBooks' : 'Coinbase', group: 'accounting', provides: ['invoices'], freshness: 'hours', auth: 'oauth' }),
  begin: async () => ({ kind: 'oauth' as const, url: `https://login.${key}.example/authorize?x=1` }),
  connect: async () => {
    const n = ++signIns
    const id = company[key]
    return { secret: { token: `t${n}` }, config: { ...(idKey && id ? { [idKey]: id } : {}), displayName: `${key === 'quickbooks' ? 'QuickBooks' : 'Coinbase'} · ${id ?? 'mine'}` } }
  },
  health: async () => ({ status: 'ok' }),
  sync: async (conn) => ({ events: key === 'quickbooks' ? books(conn.id) : [], cursor: null, hasMore: false }),
})

beforeEach(async () => {
  outbox = []
  company = { quickbooks: 'realm-1', coinbase: null }
  signIns = 0
  const env = { AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }
  const config = { ...loadConfig(env), runWorker: false }
  booted = await boot({ config, env, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push(m.text) }, ...(await loadInstalledModules(env)), connectors: [fake('quickbooks', 'realmId') as never, fake('coinbase', null) as never], fileStore: new MemoryFileStore() })
  app = createApp(booted.services)
})
afterEach(() => booted.shutdown())

async function signIn(email: string): Promise<string> {
  await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
  const link = outbox.at(-1)!.match(/https?:\/\/\S+/)![0]
  const res = await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })
  const db = booted.services.db
  const p = await db.selectFrom('people').select(['id', 'auth_user_id']).where('email', '=', email).executeTakeFirstOrThrow()
  const anyDb = db as unknown as import('kysely').Kysely<Record<string, Record<string, unknown>>>
  await anyDb.insertInto('passkey').values({ id: `pk_${p.id}`, name: 'Mac', publicKey: 'x', userId: p.auth_user_id, credentialID: `cred_${p.id}`, counter: 0, deviceType: 'singleDevice', backedUp: 0, transports: 'internal', createdAt: new Date().toISOString() }).execute()
  await db.insertInto('reauth_events').values({ id: `re_${p.id}`, person_id: p.id, method: 'passkey', at: new Date().toISOString() }).execute()
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}
const post = (cookie: string, body: unknown = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify(body) })

async function workspace(email: string) {
  const cookie = await signIn(email)
  const r = (await (await app.request('/api/workspaces', post(cookie, { companyName: 'Acme' }))).json()) as { workspaceId?: string; id?: string }
  const ws = (r.workspaceId ?? r.id)!
  const acme = (await booted.services.db.selectFrom('entities').select('id').where('workspace_id', '=', ws).where('kind', '=', 'company').executeTakeFirstOrThrow()).id
  return { cookie, ws, acme }
}
/** Start → provider → callback, as the browser does. Returns where the app sends the person. */
async function connect(cookie: string, key: string, entityId?: string): Promise<string> {
  const start = (await (await app.request(`/api/connectors/${key}/start`, post(cookie, entityId ? { entityId } : {}))).json()) as { state?: string; url: string }
  const state = start.state ?? new URL(start.url).searchParams.get('state')!
  const res = await app.request(`/api/connectors/${key}/callback?code=c1&state=${encodeURIComponent(state)}`, { headers: { cookie, origin: BASE } })
  return decodeURIComponent(res.headers.get('location') ?? '')
}
const rows = async (ws: string, key: string) => booted.services.db.selectFrom('connections').select(['id', 'status', 'secret_enc']).where('workspace_id', '=', ws).where('connector_key', '=', key).execute()
async function owed(cookie: string, acme: string) {
  const b = (await (await app.request(`/api/entities/${acme}`, { headers: { cookie, origin: BASE } })).json()) as { owedToYou: { total?: { minor: number } } | null; bills: { rows?: Array<{ amount: { minor: number } }> } | null }
  return { ar: b.owedToYou?.total?.minor ?? 0, ap: (b.bills?.rows ?? []).reduce((t, r) => t + r.amount.minor, 0) }
}
const tokenOf = (ws: string, row: { id: string; secret_enc: string | null }) => (unseal(booted.services.keys, row.secret_enc!, { workspaceId: ws, recordId: row.id, purpose: SECRET_PURPOSE }) as { token: string }).token

describe('reconnect lands in the same connection', () => {
  it('an expired sign-in reconnected: one connection, the new token in it, the numbers unchanged', async () => {
    const a = await workspace('a@example.test')
    expect(await connect(a.cookie, 'quickbooks', a.acme)).toMatch(/d=connection:/)
    const [first] = await rows(a.ws, 'quickbooks')
    expect(await owed(a.cookie, a.acme)).toEqual({ ar: 100_000, ap: 30_000 })
    // The sign-in ends; the person presses Reconnect, which runs QuickBooks' normal connect.
    await booted.services.db.updateTable('connections').set({ status: 'needs_reauth', last_error: 'expired' }).where('id', '=', first!.id).execute()
    expect(((await (await app.request(`/api/connections/${first!.id}/reconnect`, post(a.cookie))).json()) as { kind: string }).kind).toBe('connect')
    const to = await connect(a.cookie, 'quickbooks', a.acme)
    expect(to).toContain(`d=connection:${first!.id}`)
    const after = await rows(a.ws, 'quickbooks')
    expect(after.map((r) => [r.id, r.status])).toEqual([[first!.id, 'active']])
    expect(tokenOf(a.ws, after[0]!)).toBe('t2')
    expect(await owed(a.cookie, a.acme)).toEqual({ ar: 100_000, ap: 30_000 })
  })

  it('the same company connected again from Add (no Reconnect press) also lands in the stuck one', async () => {
    const a = await workspace('a@example.test')
    await connect(a.cookie, 'quickbooks', a.acme)
    const [first] = await rows(a.ws, 'quickbooks')
    await booted.services.db.updateTable('connections').set({ status: 'needs_reauth' }).where('id', '=', first!.id).execute()
    expect(await connect(a.cookie, 'quickbooks', a.acme)).toContain(`d=connection:${first!.id}`)
    expect((await rows(a.ws, 'quickbooks')).length).toBe(1)
    expect(await owed(a.cookie, a.acme)).toEqual({ ar: 100_000, ap: 30_000 })
  })

  it('a second sign-in to a company that is already connected and working is refused, and nothing doubles', async () => {
    const a = await workspace('a@example.test')
    await connect(a.cookie, 'quickbooks', a.acme)
    const to = await connect(a.cookie, 'quickbooks', a.acme)
    expect(to).toMatch(/connect_error=.*is already connected/)
    expect((await rows(a.ws, 'quickbooks')).length).toBe(1)
    expect(await owed(a.cookie, a.acme)).toEqual({ ar: 100_000, ap: 30_000 })
    // A different company is a new connection, as before.
    company.quickbooks = 'realm-2'
    expect(await connect(a.cookie, 'quickbooks', a.acme)).toMatch(/d=connection:/)
    expect((await rows(a.ws, 'quickbooks')).length).toBe(2)
  })

  it('a provider that names no company: Reconnect lands in the one it was pressed on; a fresh Add is still its own', async () => {
    const a = await workspace('a@example.test')
    await connect(a.cookie, 'coinbase')
    const [first] = await rows(a.ws, 'coinbase')
    await booted.services.db.updateTable('connections').set({ status: 'needs_reauth' }).where('id', '=', first!.id).execute()
    await app.request(`/api/connections/${first!.id}/reconnect`, post(a.cookie))
    expect(await connect(a.cookie, 'coinbase')).toContain(`d=connection:${first!.id}`)
    const after = await rows(a.ws, 'coinbase')
    expect(after.map((r) => r.status)).toEqual(['active'])
    expect(tokenOf(a.ws, after[0]!)).toBe('t2')
    // Without a Reconnect press there's nothing to match on: a second account is allowed.
    await connect(a.cookie, 'coinbase')
    expect((await rows(a.ws, 'coinbase')).length).toBe(2)
  })

  it('another workspace connecting the same company is its own connection', async () => {
    const a = await workspace('a@example.test')
    const b = await workspace('b@example.test')
    await connect(a.cookie, 'quickbooks', a.acme)
    expect(await connect(b.cookie, 'quickbooks', b.acme)).toMatch(/d=connection:/)
    expect((await rows(a.ws, 'quickbooks')).length).toBe(1)
    expect((await rows(b.ws, 'quickbooks')).length).toBe(1)
  })
})
