import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConnectBeginContext, Connector, ConnectionRef, NormalizedEvent } from '@agfn/contracts'
import type { ConnectorDeps, WebhookOutcome } from '@agfn/connector-sdk'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { MemoryFileStore } from '@agfn/files'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'

const BASE = 'http://localhost:8787'
let booted: Booted
let app: ReturnType<typeof createApp>
let outbox: string[]
let items: number
let begins: ConnectBeginContext[]
let liveChecks: number

// A Plaid-shaped connector: Link widget, update mode on an existing connection, live balances, webhooks by itemId.
const fakePlaid = (deps: ConnectorDeps): Connector & { begin(ctx: ConnectBeginContext): Promise<{ kind: 'link_widget'; provider: string; token: string }>; webhook: { verify(): Promise<void>; interpret(r: { body: string }): WebhookOutcome } } => ({
  describe: () => ({ key: 'plaid', name: 'Bank or card (Plaid)', group: 'banks', provides: ['balances', 'transactions'], freshness: 'minutes', auth: 'link_widget' }),
  begin: async (ctx) => {
    begins.push(ctx)
    return { kind: 'link_widget', provider: 'plaid', token: ctx.connection ? 'link-update' : 'link-new' }
  },
  connect: async () => {
    items++
    return { secret: { accessToken: 'access-x', itemId: `item_${items}` }, config: { itemId: `item_${items}`, institutionId: 'ins_3', products: [], displayName: `Chase · login ${items}` } }
  },
  health: async () => ({ status: 'ok' }),
  sync: async (conn: ConnectionRef) => {
    const rawRef = await deps.raw.put(conn.id, 'a', 'acc_1', {})
    return { events: [{ type: 'account.upsert', connectionId: conn.id, rawRef, externalId: 'acc_1', name: 'Checking', accountType: 'depository', currency: 'USD', mask: '0000', institution: 'Chase' }] as NormalizedEvent[], cursor: null, hasMore: false }
  },
  refreshBalances: async (conn: ConnectionRef) => {
    liveChecks++
    const rawRef = await deps.raw.put(conn.id, 'b', 'acc_1@now', {})
    return [{ type: 'balance.snapshot', connectionId: conn.id, rawRef, externalId: `acc_1@${liveChecks}`, accountExternalId: 'acc_1', at: new Date().toISOString(), current: { minor: 12_345, currency: 'USD' } }] as NormalizedEvent[]
  },
  webhook: {
    verify: async () => {},
    interpret: (r) => {
      const b = JSON.parse(r.body) as { item_id: string; action: WebhookOutcome['action']; n: number }
      return { action: b.action, dedupeKey: `k${b.n}`, match: { field: 'itemId', value: b.item_id } }
    },
  },
})

beforeEach(async () => {
  outbox = []
  items = 0
  begins = []
  liveChecks = 0
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push(m.text) }, connectors: [fakePlaid as never], fileStore: new MemoryFileStore() })
  app = createApp(booted.services)
})
afterEach(() => booted.shutdown())

async function signIn(email: string): Promise<string> {
  await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
  const link = outbox.at(-1)!.match(/https?:\/\/\S+/)![0]
  const res = await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })
  await withPasskey(booted.services.db, email)
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}
/** Connecting accounts needs a passkey and a fresh passkey check (see app.test.ts withPasskey). */
async function withPasskey(db: Booted['services']['db'], email: string): Promise<void> {
  const p = await db.selectFrom('people').select(['id', 'auth_user_id']).where('email', '=', email).executeTakeFirstOrThrow()
  const anyDb = db as unknown as import('kysely').Kysely<Record<string, Record<string, unknown>>>
  await anyDb.insertInto('passkey').values({ id: `pk_${p.id}`, name: 'Mac', publicKey: 'x', userId: p.auth_user_id, credentialID: `cred_${p.id}`, counter: 0, deviceType: 'singleDevice', backedUp: 0, transports: 'internal', createdAt: new Date().toISOString() }).execute()
  await db.insertInto('reauth_events').values({ id: `re_${p.id}`, person_id: p.id, method: 'passkey', at: new Date().toISOString() }).execute()
}

const post = (cookie: string, body: unknown = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify(body) })
const linked = { institution: { name: 'Chase', institution_id: 'ins_3' }, accounts: [{ mask: '0000', subtype: 'checking' }], linkSessionId: 'ls-1' }

async function connectChase(cookie: string) {
  const start = (await (await app.request('/api/connectors/plaid/start', post(cookie, {}))).json()) as { state: string }
  return app.request('/api/connectors/plaid/finish', post(cookie, { state: start.state, publicToken: 'public-x', ...linked }))
}
const summary = async (cookie: string, id: string) => (await (await app.request(`/api/connections/${id}`, { headers: { origin: BASE, cookie } })).json()) as { status: string; message?: string; attention?: string[]; canRefreshBalance?: boolean }
const hook = (body: object) => app.request('/api/webhooks/plaid', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('plaid reconnect, duplicates, webhooks, live balance', () => {
  it('refuses a second Item for a login the workspace already has, before exchanging it', async () => {
    const cookie = await signIn('dup@example.com')
    await app.request('/api/workspaces', post(cookie, { companyName: 'Acme' }))
    const first = (await (await connectChase(cookie)).json()) as { connectionId: string }
    // The connector named the connection after what was connected.
    expect(((await (await app.request(`/api/connections/${first.connectionId}`, { headers: { origin: BASE, cookie } })).json()) as { name: string }).name).toBe('Chase · login 1')
    const again = await connectChase(cookie)
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: 'duplicate', message: 'Chase is already connected. Use Reconnect on it instead of adding it again.' })
    expect(items).toBe(1)
    // A second login at the same bank with different accounts is fine.
    const start = (await (await app.request('/api/connectors/plaid/start', post(cookie, {}))).json()) as { state: string }
    const other = await app.request('/api/connectors/plaid/finish', post(cookie, { state: start.state, publicToken: 'public-y', ...linked, accounts: [{ mask: '7777' }] }))
    expect(other.status).toBe(200)
  })

  it('reconnects the SAME connection in update mode and clears the prompt', async () => {
    const cookie = await signIn('re@example.com')
    await app.request('/api/workspaces', post(cookie, { companyName: 'Acme' }))
    const { connectionId } = (await (await connectChase(cookie)).json()) as { connectionId: string }
    await hook({ item_id: 'item_1', action: 'needs_reauth', n: 1 })
    expect((await summary(cookie, connectionId)).status).toBe('needs_reauth')

    const r = (await (await app.request(`/api/connections/${connectionId}/reconnect`, post(cookie, {}))).json()) as { kind: string; linkToken: string; state: string }
    expect(r).toMatchObject({ kind: 'plaid_link', linkToken: 'link-update' })
    expect(begins.at(-1)?.connection?.id).toBe(connectionId)
    expect(begins.at(-1)?.accountSelection).toBeUndefined()
    const fin = await app.request(`/api/connections/${connectionId}/reconnect/finish`, post(cookie, { state: r.state, linkSessionId: 'ls-2' }))
    expect(fin.status).toBe(200)
    // Back to working: the sync it queued shows as "syncing" until it runs.
    expect((await summary(cookie, connectionId)).status).toBe('syncing')
    expect(items).toBe(1)
    // The state is single-use.
    expect((await app.request(`/api/connections/${connectionId}/reconnect/finish`, post(cookie, { state: r.state }))).status).toBe(400)
  })

  it('turns webhooks into prompts: reconnect soon, new accounts (with account selection), repaired, revoked', async () => {
    const cookie = await signIn('hooks@example.com')
    await app.request('/api/workspaces', post(cookie, { companyName: 'Acme' }))
    const { connectionId } = (await (await connectChase(cookie)).json()) as { connectionId: string }

    await hook({ item_id: 'item_1', action: 'reconnect_soon', n: 1 })
    expect(await summary(cookie, connectionId)).toMatchObject({ status: 'ok', attention: ['reconnect_soon'], message: expect.stringMatching(/within 7 days/) })
    await hook({ item_id: 'item_1', action: 'repaired', n: 2 })
    expect((await summary(cookie, connectionId)).attention).toBeUndefined()

    await hook({ item_id: 'item_1', action: 'new_accounts', n: 3 })
    expect((await summary(cookie, connectionId)).attention).toEqual(['new_accounts'])
    const r = (await (await app.request(`/api/connections/${connectionId}/reconnect`, post(cookie, { accountSelection: true }))).json()) as { state: string }
    expect(begins.at(-1)?.accountSelection).toBe(true)
    await app.request(`/api/connections/${connectionId}/reconnect/finish`, post(cookie, { state: r.state }))
    expect((await summary(cookie, connectionId)).attention).toBeUndefined()

    await hook({ item_id: 'item_1', action: 'disconnected', n: 4 })
    const row = await booted.handle.db.selectFrom('connections').select(['status', 'secret_enc']).where('id', '=', connectionId).executeTakeFirstOrThrow()
    expect(row).toEqual({ status: 'disconnected', secret_enc: null })
  })

  it('checks balances live on request, capped per connection and per workspace day, and metered', async () => {
    await booted.shutdown()
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
    booted = await boot({ config, env: { AGFN_LIVE_BALANCE_DAILY_CAP: '2' }, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push(m.text) }, connectors: [fakePlaid as never], fileStore: new MemoryFileStore() })
    app = createApp(booted.services)
    const cookie = await signIn('bal@example.com')
    await app.request('/api/workspaces', post(cookie, { companyName: 'Acme' }))
    const { connectionId } = (await (await connectChase(cookie)).json()) as { connectionId: string }
    expect((await summary(cookie, connectionId)).canRefreshBalance).toBe(true)
    const refresh = async (id: string) => (await (await app.request(`/api/connections/${id}/refresh-balance`, post(cookie))).json()) as { live: boolean; reason?: string; message?: string; refreshedAt?: string }
    expect(await refresh(connectionId)).toMatchObject({ live: true })
    // Within 15 minutes: nothing is called, the cached balance stands with how old it is.
    expect(await refresh(connectionId)).toMatchObject({ live: false, reason: 'cooldown', message: expect.stringMatching(/^Refreshed \d+ min ago/) })
    expect(liveChecks).toBe(1)

    // A second login: one more live check, then the workspace's daily cap (2 here) stops a third.
    const start = (await (await app.request('/api/connectors/plaid/start', post(cookie, {}))).json()) as { state: string }
    const other = (await (await app.request('/api/connectors/plaid/finish', post(cookie, { state: start.state, publicToken: 'p2', ...linked, accounts: [{ mask: '5555' }] }))).json()) as { connectionId: string }
    expect(await refresh(other.connectionId)).toMatchObject({ live: true })
    const start3 = (await (await app.request('/api/connectors/plaid/start', post(cookie, {}))).json()) as { state: string }
    const third = (await (await app.request('/api/connectors/plaid/finish', post(cookie, { state: start3.state, publicToken: 'p3', ...linked, accounts: [{ mask: '6666' }] }))).json()) as { connectionId: string }
    expect(await refresh(third.connectionId)).toMatchObject({ live: false, reason: 'daily_cap' })
    expect(liveChecks).toBe(2)

    const ws = (await booted.services.db.selectFrom('connections').select('workspace_id').where('id', '=', connectionId).executeTakeFirstOrThrow()).workspace_id
    expect((await booted.services.usage.snapshot(ws)).liveBalanceChecks).toBe(2)
  })

  it('only the explicit refresh path can reach a live balance check (never sync, webhooks or jobs)', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const root = new URL('../../../', import.meta.url).pathname
    const callers: string[] = []
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        if (n === 'node_modules' || n === 'dist' || n.startsWith('.')) continue
        const f = join(dir, n)
        if (statSync(f).isDirectory()) walk(f)
        else if (f.endsWith('.ts') && !f.endsWith('.test.ts') && /\.refreshBalances\(/.test(readFileSync(f, 'utf8'))) callers.push(f.slice(root.length))
      }
    }
    walk(join(root, 'apps'))
    walk(join(root, 'packages'))
    // The engine method (the only place a connector's refreshBalances runs), the person's button route, and the AI
    // tool's port (modules.ts liveBalancePort, used only by refresh_balance after confirm: true).
    for (const f of callers) expect(['packages/sync/src/engine.ts', 'apps/server/src/routes/connections.ts', 'apps/server/src/modules.ts', 'packages/mcp/src/']).toSatisfy((allowed: string[]) => allowed.some((a) => f.startsWith(a)), f)
  })

})

describe('plaid OAuth return page', () => {
  it('serves the web app at the registered redirect path, query intact for Link', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dist = mkdtempSync(join(tmpdir(), 'agfn-web-'))
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Aggregate</title>')
    await booted.shutdown()
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: dist }), runWorker: false }
    booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => {} }, connectors: [], fileStore: new MemoryFileStore() })
    app = createApp(booted.services)
    const res = await app.request('/connect/plaid/oauth?oauth_state_id=abc-123')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<title>Aggregate</title>')
    expect(res.headers.get('content-security-policy')).toContain('https://cdn.plaid.com')
  })
})

describe('plaid early-access cap (AGFN_PLAID_MAX_ITEMS_PER_WORKSPACE)', () => {
  it('reads the setting; unset or junk means no cap', () => {
    const base = { AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE }
    expect(loadConfig({ ...base, AGFN_PLAID_MAX_ITEMS_PER_WORKSPACE: '25' }).plaidMaxItems).toBe(25)
    expect(loadConfig(base).plaidMaxItems).toBeUndefined()
    expect(loadConfig({ ...base, AGFN_PLAID_MAX_ITEMS_PER_WORKSPACE: '0' }).plaidMaxItems).toBeUndefined()
    // Hosted is always capped, even with the setting missing or junk (a machine without its [env] block).
    const neon = 'postgres://u:p@ep-x.us-east-2.aws.neon.tech/aggregate'
    expect(loadConfig({ ...base, DATABASE_URL: neon }).plaidMaxItems).toBe(25)
    expect(loadConfig({ ...base, AGFN_HOSTED: '1' }).plaidMaxItems).toBe(25)
    expect(loadConfig({ ...base, AGFN_HOSTED: '1', AGFN_PLAID_MAX_ITEMS_PER_WORKSPACE: '0' }).plaidMaxItems).toBe(25)
    expect(loadConfig({ ...base, DATABASE_URL: neon, AGFN_PLAID_MAX_ITEMS_PER_WORKSPACE: '40' }).plaidMaxItems).toBe(40)
  })

  it('refuses the next bank before Link opens; update mode still works; a disconnect frees a slot', async () => {
    booted.services.config.plaidMaxItems = 2
    const cookie = await signIn('cap@example.com')
    await app.request('/api/workspaces', post(cookie, { companyName: 'Acme' }))
    const connect = async (mask: string) => {
      const start = await app.request('/api/connectors/plaid/start', post(cookie, {}))
      if (start.status !== 200) return start
      const { state } = (await start.json()) as { state: string }
      return app.request('/api/connectors/plaid/finish', post(cookie, { state, publicToken: `public-${mask}`, ...linked, accounts: [{ mask }] }))
    }
    const a = (await (await connect('1111')).json()) as { connectionId: string }
    expect((await connect('2222')).status).toBe(200)
    const before = begins.length

    const third = await connect('3333')
    expect(third.status).toBe(409)
    expect(await third.json()).toEqual({ error: 'plaid_limit', limit: 2, message: "You've connected 2 banks — the most during early access. Disconnect one to add another." })
    expect(begins.length).toBe(before) // no link token was created
    expect(items).toBe(2)

    // Reconnecting an existing bank (update mode) isn't a new connection.
    const r = await app.request(`/api/connections/${a.connectionId}/reconnect`, post(cookie, {}))
    expect(r.status).toBe(200)
    expect(((await r.json()) as { linkToken: string }).linkToken).toBe('link-update')

    expect((await app.request(`/api/connections/${a.connectionId}/disconnect`, post(cookie, {}))).status).toBe(200)
    expect((await connect('4444')).status).toBe(200)
    expect(items).toBe(3)
  })

  it('a start that slipped in under the cap is refused at finish, before the exchange', async () => {
    booted.services.config.plaidMaxItems = 1
    const cookie = await signIn('race@example.com')
    await app.request('/api/workspaces', post(cookie, { companyName: 'Acme' }))
    const s1 = (await (await app.request('/api/connectors/plaid/start', post(cookie, {}))).json()) as { state: string }
    const s2 = (await (await app.request('/api/connectors/plaid/start', post(cookie, {}))).json()) as { state: string }
    expect((await app.request('/api/connectors/plaid/finish', post(cookie, { state: s1.state, publicToken: 'p1', ...linked, accounts: [{ mask: '1111' }] }))).status).toBe(200)
    const late = await app.request('/api/connectors/plaid/finish', post(cookie, { state: s2.state, publicToken: 'p2', ...linked, accounts: [{ mask: '2222' }] }))
    expect(late.status).toBe(409)
    expect(items).toBe(1)
  })
})
