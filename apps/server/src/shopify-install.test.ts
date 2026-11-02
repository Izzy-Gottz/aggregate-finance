import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Connector, ConnectionRef, NormalizedEvent } from '@agfn/contracts'
import type { ConnectorDeps, WebhookOutcome } from '@agfn/connector-sdk'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { MemoryFileStore } from '@agfn/files'
import { boot, type Booted } from './boot.ts'
import { createApp, SHOPIFY_ERASE_WARNING } from './app.ts'
import { loadConfig } from './config.ts'
import { createHmac } from 'node:crypto'
import { verifyShopifySessionToken } from '@agfn/connector-shopify'

const BASE = 'http://localhost:8787'
const SHOP = 'harbor-coffee.myshopify.com'
let booted: Booted
let app: ReturnType<typeof createApp>
let outbox: string[]
let connects: Array<Record<string, unknown>>
let revoked: string[]
let notRevoked: string | undefined
let exchanges: Array<{ shop: string; token: string }>
let staffEmail: string | undefined

// A Shopify-shaped connector: signed install links, a consent URL per shop, privacy webhooks matched on `shop`.
const fakeShopify = (deps: ConnectorDeps): Connector & Record<string, unknown> => ({
  describe: () => ({ key: 'shopify', name: 'Shopify', group: 'payments', provides: ['balances'], freshness: 'hours', auth: 'oauth' }),
  verifyInstall: (q: Record<string, string>) => {
    if (q.hmac !== 'good') throw new Error('bad hmac')
    return q.shop
  },
  authorizeUrl: (shop: string, redirectUri: string, state: string) => `https://${shop}/admin/oauth/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
  apiKey: 'client-test',
  verifySessionToken: (t: string) => verifyShopifySessionToken(t, { clientId: 'client-test', secret: 'shpss_test' }, Date.now()),
  // The staff member behind a session token (online token exchange): the store owner's email.
  staffEmail: async () => staffEmail,
  // Managed install: the store's token comes from exchanging the embedded page's session token.
  exchangeSessionToken: async (shop: string, token: string) => {
    exchanges.push({ shop, token })
    return { accessToken: `shpua_exchanged_${shop.split('.')[0]}`, refreshToken: 'shprt_x', expiresAt: Date.now() + 3_600_000 }
  },
  connect: async (input: Record<string, unknown>) => {
    connects.push(input)
    const shop = typeof input.shop === 'string' ? input.shop : SHOP
    return { secret: input.adopt ?? { accessToken: 'shpua_x' }, config: { shop, displayName: `Shopify · ${shop.split('.')[0]}` } }
  },
  disconnect: async (conn: ConnectionRef) => {
    if (notRevoked) return { notRevoked }
    revoked.push(conn.id)
  },
  health: async () => ({ status: 'ok' }),
  sync: async (conn: ConnectionRef) => {
    const m = (amount: string) => ({ amount, currencyCode: 'USD' })
    const rawRef = await deps.raw.put(conn.id, 'shopify.payout', 'p1', { id: 'p1', issuedAt: '2026-10-08T12:00:00Z', status: 'PAID', transactionType: 'DEPOSIT', net: m('912.40'), summary: { chargesGross: m('1000.00'), chargesFee: m('-32.60'), refundsFeeGross: m('-55.00'), refundsFee: m('0.00') } })
    await deps.raw.put(conn.id, 'shopify.payout', 'p2', { id: 'p2', issuedAt: '2026-10-13T12:00:00Z', status: 'SCHEDULED', transactionType: 'DEPOSIT', net: m('250.00'), summary: { chargesGross: m('260.00'), chargesFee: m('-10.00') } })
    return { events: [{ type: 'account.upsert', connectionId: conn.id, rawRef, externalId: 'bal', name: 'Shopify balance', accountType: 'processor_balance', currency: 'USD' }] as NormalizedEvent[], cursor: null, hasMore: false }
  },
  webhook: {
    verify: async () => {},
    interpret: (r: { headers: Record<string, string> }): WebhookOutcome => {
      const topic = r.headers['x-shopify-topic'] ?? ''
      const action = topic === 'shop/redact' ? 'erase' : topic === 'app/uninstalled' ? 'disconnected' : 'ignore'
      return { action, dedupeKey: `${topic}:${r.headers['x-shopify-event-id']}`, match: { field: 'shop', value: r.headers['x-shopify-shop-domain'] ?? '' } }
    },
  },
})

beforeEach(async () => {
  outbox = []
  connects = []
  revoked = []
  notRevoked = undefined
  exchanges = []
  staffEmail = 'owner@example.com'
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push(m.text) }, connectors: [fakeShopify as never], fileStore: new MemoryFileStore() })
  app = createApp(booted.services)
})
afterEach(() => booted.shutdown())

async function signIn(email: string): Promise<string> {
  await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
  const link = outbox.at(-1)!.match(/https?:\/\/\S+/)![0]
  const res = await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}
const post = (cookie: string, body: unknown = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify(body) })
const cookieOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')

/** An App Bridge session token as Shopify signs it (HS256 with the app's client secret). */
function sessionToken(o: { shop?: string; aud?: string; secret?: string; exp?: number } = {}): string {
  const enc = (x: object) => Buffer.from(JSON.stringify(x)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const shop = o.shop ?? SHOP
  const body = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ iss: `https://${shop}/admin`, dest: `https://${shop}`, aud: o.aud ?? 'client-test', sub: '42', exp: o.exp ?? now + 60, nbf: now - 5, iat: now - 5, jti: 'j1', sid: 's1' })}`
  return `${body}.${createHmac('sha256', o.secret ?? 'shpss_test').update(body).digest('base64url')}`
}

const hook = (topic: string, n: number, shop = SHOP) => app.request('/api/webhooks/shopify', { method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-topic': topic, 'x-shopify-shop-domain': shop, 'x-shopify-event-id': String(n) }, body: '{}' })
const status = (token?: string) => app.request('/api/connectors/shopify/embedded/status', { headers: token ? { authorization: `Bearer ${token}` } : {} })
const pendingRows = () => (booted.services.db as never as import('kysely').Kysely<{ shopify_pending_installs: { shop: string; link_hash: string | null } }>).selectFrom('shopify_pending_installs').select(['shop', 'link_hash']).execute()

/** As a store owner: the embedded page's "Connect to Aggregate" link, opened and finished in this signed-in session. */
async function installFromAdmin(session: string, shop = SHOP, email?: string): Promise<string> {
  if (email) staffEmail = email
  const { connectUrl } = (await (await status(sessionToken({ shop }))).json()) as { connectUrl: string }
  const link = await app.request(connectUrl.replace(BASE, ''), { headers: { cookie: session } })
  expect(link.headers.get('location')).toBe('/api/connectors/shopify/install/resume')
  const done = await app.request('/api/connectors/shopify/install/resume', { headers: { origin: BASE, cookie: `${session}; ${cookieOf(link)}` } })
  return done.headers.get('location')!.split('connection:')[1]!
}

describe('Shopify managed install (Shopify installs; the embedded page exchanges the token; a one-time link picks the workspace)', () => {
  it('signed out: the embedded page offers a one-time link; it survives sign-in and attaches the exchanged token as a connection', async () => {
    const st = (await (await status(sessionToken())).json()) as { connections: unknown[]; connectUrl: string }
    expect(st.connections).toEqual([])
    expect(st.connectUrl).toMatch(new RegExp(`^${BASE}/api/connectors/shopify/link\\?t=[A-Za-z0-9_-]{43}$`))
    expect(exchanges).toEqual([{ shop: SHOP, token: expect.any(String) }])
    expect(await pendingRows()).toEqual([{ shop: SHOP, link_hash: expect.any(String) }])

    const link = await app.request(st.connectUrl.replace(BASE, ''))
    // Sign in first, with the Shopify staff email filled in.
    expect(link.headers.get('location')).toBe('/#/?signin_email=owner%40example.com&signin_for=shopify')
    const pending = cookieOf(link)
    expect(pending).toMatch(/^agfn_shopify_link=/)
    const session = await signIn('owner@example.com')
    await app.request('/api/workspaces', post(session, { companyName: 'Harbor Coffee' }))
    const cookie = `${session}; ${pending}`
    const me = (await (await app.request('/api/me', { headers: { origin: BASE, cookie } })).json()) as { pendingInstall?: string }
    expect(me.pendingInstall).toBe('shopify')

    const done = await app.request('/api/connectors/shopify/install/resume', { headers: { origin: BASE, cookie } })
    expect(done.headers.get('location')).toMatch(/^\/#\/\?d=connection:/)
    expect(done.headers.getSetCookie().join(';')).toMatch(/agfn_shopify_link=;/)
    expect(connects[0]).toMatchObject({ shop: SHOP, adopt: { accessToken: 'shpua_exchanged_harbor-coffee' } })
    expect(await pendingRows()).toEqual([]) // the waiting token is gone once it's a connection
    // The admin page now shows the connection, with no link.
    const after = (await (await status(sessionToken())).json()) as { connections: Array<{ name: string }>; connectUrl?: string }
    expect(after.connections.map((x) => x.name)).toEqual(['Shopify · harbor-coffee'])
    expect(after.connectUrl).toBeUndefined()
  })

  it('opened outside the admin, the App URL goes to the app in Shopify admin; forged links never do anything', async () => {
    const top = await app.request(`/api/connectors/shopify/install?shop=${SHOP}&timestamp=1&hmac=good`)
    expect(top.headers.get('location')).toBe(`https://${SHOP}/admin/apps/client-test`)
    expect(top.headers.getSetCookie()).toEqual([])
    const bad = await app.request(`/api/connectors/shopify/install?shop=${SHOP}&timestamp=1&hmac=forged`)
    expect(bad.headers.get('location')).toMatch(/connect_error=/)
    expect(bad.headers.getSetCookie()).toEqual([])
    // Resume without a link (or with a junk one) explains instead of connecting anything.
    const session = await signIn('owner2@example.com')
    await app.request('/api/workspaces', post(session, { companyName: 'Harbor Coffee' }))
    for (const cookie of [session, `${session}; agfn_shopify_link=${'x'.repeat(43)}`]) {
      expect((await app.request('/api/connectors/shopify/install/resume', { headers: { origin: BASE, cookie } })).headers.get('location')).toMatch(/connect_error=/)
    }
    expect(connects).toEqual([])
  })

  it('disconnecting in Aggregate deletes the data once the store is uninstalled, whatever was picked, and says so', async () => {
    const session = await signIn('owner4@example.com')
    await app.request('/api/workspaces', post(session, { companyName: 'Harbor Coffee' }))
    const connectionId = await installFromAdmin(session, SHOP, 'owner4@example.com')
    const res = await app.request(`/api/connections/${connectionId}/disconnect`, post(session, { deleteData: false }))
    expect(await res.json()).toMatchObject({ ok: true, dataDeleted: true })
    expect(revoked).toEqual([connectionId])
    expect(await booted.services.db.selectFrom('raw_records').select('id').where('connection_id', '=', connectionId).execute()).toEqual([])
  })

  it('a store that stays installed (another workspace uses it) keeps what was picked and says what to finish', async () => {
    notRevoked = 'Aggregate stays installed on this store because another workspace still uses it.'
    const session = await signIn('owner5@example.com')
    await app.request('/api/workspaces', post(session, { companyName: 'Harbor Coffee' }))
    const connectionId = await installFromAdmin(session, SHOP, 'owner5@example.com')
    const res = await app.request(`/api/connections/${connectionId}/disconnect`, post(session, { deleteData: false }))
    expect(await res.json()).toMatchObject({ ok: true, dataDeleted: false, warning: notRevoked })
    expect((await booted.services.db.selectFrom('raw_records').select('id').where('connection_id', '=', connectionId).execute()).length).toBeGreaterThan(0)
  })

  it('shop/redact erases the store: access stops and its raw records go; customer requests are answered', async () => {
    const session = await signIn('owner3@example.com')
    await app.request('/api/workspaces', post(session, { companyName: 'Harbor Coffee' }))
    const connectionId = await installFromAdmin(session, SHOP, 'owner3@example.com')
    const db = booted.services.db
    expect((await db.selectFrom('raw_records').select('id').where('connection_id', '=', connectionId).execute()).length).toBeGreaterThan(0)
    expect((await hook('customers/data_request', 1)).status).toBe(200)
    expect((await hook('customers/redact', 2)).status).toBe(200)
    // Uninstall first (Shopify's order): the activity log warns what the erasure 48 hours later will remove.
    expect((await hook('app/uninstalled', 3)).status).toBe(200)
    const notes = await db.selectFrom('activity_log' as never).select(['detail' as never]).where('target_id' as never, '=', connectionId as never).execute()
    expect(notes.map((n) => (n as { detail: string }).detail)).toContain(SHOPIFY_ERASE_WARNING)
    expect((await hook('shop/redact', 4)).status).toBe(200)
    const row = await db.selectFrom('connections').select(['status', 'secret_enc']).where('id', '=', connectionId).executeTakeFirstOrThrow()
    expect(row).toEqual({ status: 'disconnected', secret_enc: null })
    expect(await db.selectFrom('raw_records').select('id').where('connection_id', '=', connectionId).execute()).toEqual([])
    const accts = await db.selectFrom('accounts').select(['include_in_cash', 'closed_at']).where('connection_id', '=', connectionId).execute()
    expect(accts.length).toBeGreaterThan(0)
    for (const a of accts) expect(a.include_in_cash === 0 && !!a.closed_at).toBe(true)
    expect(revoked).toEqual([])
  })

  it('a store that reinstalled before shop/redact arrives keeps its new connection', async () => {
    const session = await signIn('owner4@example.com')
    await app.request('/api/workspaces', post(session, { companyName: 'Harbor Coffee' }))
    const connectionId = await installFromAdmin(session, SHOP, 'owner4@example.com')
    expect((await hook('shop/redact', 9)).status).toBe(200)
    const row = await booted.services.db.selectFrom('connections').select('status').where('id', '=', connectionId).executeTakeFirstOrThrow()
    expect(row.status).not.toBe('disconnected')
    expect(revoked).toEqual([])
  })

  it('uninstall after a reinstall disconnects the live connection, not the old one (found on hosted, 2026-10-11)', async () => {
    const session = await signIn('owner5@example.com')
    await app.request('/api/workspaces', post(session, { companyName: 'Harbor Coffee' }))
    const first = await installFromAdmin(session, SHOP, 'owner5@example.com')
    expect((await hook('app/uninstalled', 21)).status).toBe(200)
    const second = await installFromAdmin(session, SHOP, 'owner5@example.com')
    expect(second).not.toBe(first)
    expect((await hook('app/uninstalled', 22)).status).toBe(200)
    const rows = await booted.services.db.selectFrom('connections').select(['id', 'status', 'secret_enc']).where('id', 'in', [first, second]).execute()
    for (const r of rows) expect({ status: r.status, secret_enc: r.secret_enc }).toEqual({ status: 'disconnected', secret_enc: null })
  })

  it('a store whose connection needs reconnecting gets a link again, and the new token goes into that connection', async () => {
    const shop = 'stuck-store.myshopify.com'
    const session = await signIn('owner9@example.com')
    await app.request('/api/workspaces', post(session, { companyName: 'Stuck Store' }))
    const id = await installFromAdmin(session, shop, 'owner9@example.com')
    const db = booted.services.db
    const before = await db.selectFrom('connections').select('secret_enc').where('id', '=', id).executeTakeFirstOrThrow()
    await db.updateTable('connections').set({ status: 'needs_reauth', last_error: 'Shopify access was removed or has expired.' }).where('id', '=', id).execute()
    // The admin page lists it as needing a reconnect and, unlike a working connection, offers a link.
    const st = (await (await status(sessionToken({ shop }))).json()) as { connections: Array<{ status: string }>; connectUrl?: string }
    expect(st.connections.map((x) => x.status)).toEqual(['needs_reauth'])
    expect(st.connectUrl).toMatch(/\/api\/connectors\/shopify\/link\?t=/)
    // Following it lands on the same connection: active again, with the new token, and no second connection.
    expect(await installFromAdmin(session, shop, 'owner9@example.com')).toBe(id)
    const rows = await db.selectFrom('connections').select(['id', 'status', 'last_error', 'secret_enc', 'config_json']).where('connector_key', '=', 'shopify').execute()
    const mine = rows.filter((r) => (JSON.parse(r.config_json) as { shop?: string }).shop === shop)
    expect(mine.map((r) => ({ id: r.id, status: r.status, last_error: r.last_error }))).toEqual([{ id, status: 'active', last_error: null }])
    expect(mine[0]!.secret_enc).not.toBe(before.secret_enc)
    expect(await pendingRows()).not.toContainEqual(expect.objectContaining({ shop }))
    // Working again: the admin page goes back to "Open Aggregate", no link.
    expect(((await (await status(sessionToken({ shop }))).json()) as { connectUrl?: string }).connectUrl).toBeUndefined()
  })

  it('an uninstall before anyone linked the store drops its waiting token', async () => {
    await status(sessionToken())
    expect(await pendingRows()).toHaveLength(1)
    expect((await hook('app/uninstalled', 11)).status).toBe(200)
    expect(await pendingRows()).toEqual([])
  })
})

describe('the embedded page in Shopify admin (App Bridge, session tokens, no cookies)', () => {
  const embedded = `/api/connectors/shopify/install?embedded=1&host=YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvaGFyYm9y&shop=${SHOP}&timestamp=1&hmac=good`
  it('the App URL opened embedded is a page Shopify admin may frame, with App Bridge and the app key', async () => {
    const res = await app.request(embedded)
    expect(res.status).toBe(200)
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain(`frame-ancestors https://${SHOP} https://admin.shopify.com`)
    expect(res.headers.get('x-frame-options')).toBeNull()
    expect(res.headers.getSetCookie()).toEqual([]) // no cookies
    const html = await res.text()
    expect(html).toContain('<meta name="shopify-api-key" content="client-test">')
    expect(html).toContain('https://cdn.shopify.com/shopifycloud/app-bridge.js')
    // Leaving the admin is a real link in a new tab (scripted top navigation is swallowed in the admin frame), and
    // nothing uses confirm()/alert(), which embedded apps can't.
    expect(html).toMatch(/<a id="open"[^>]*target="_blank"/)
    expect(html).not.toMatch(/window\.open|confirm\(|alert\(/)
    // Forged links get no page; the plain (non-embedded) open is still the install flow.
    expect((await app.request(embedded.replace('hmac=good', 'hmac=forged'))).headers.get('location')).toMatch(/connect_error=/)
    expect((await app.request(embedded.replace('/install?', '/install/top?'))).status).toBe(302)
    // Every other page still can't be framed.
    expect((await app.request('/api/sign-in-methods')).headers.get('x-frame-options')).toBe('DENY')
  })

  it('status and disconnect need a valid session token for this app; they act on that store only', async () => {
    const session = await signIn('owner-embedded@example.com')
    await app.request('/api/workspaces', post(session, { companyName: 'Harbor Coffee' }))
    await installFromAdmin(session, SHOP, 'owner-embedded@example.com')

    for (const bad of [undefined, 'junk', sessionToken({ secret: 'wrong' }), sessionToken({ aud: 'another-app' }), sessionToken({ exp: Math.floor(Date.now() / 1000) - 3600 })]) {
      expect((await status(bad)).status).toBe(401)
    }
    expect(await (await status(sessionToken())).json()).toMatchObject({ shop: SHOP, connections: [{ name: 'Shopify · harbor-coffee', status: 'active' }] })
    // Another store's admin sees nothing of this one (only its own link to connect).
    expect(await (await status(sessionToken({ shop: 'other-store.myshopify.com' }))).json()).toEqual({ shop: 'other-store.myshopify.com', connections: [], connectUrl: expect.any(String) })

    const out = await app.request('/api/connectors/shopify/embedded/disconnect', { method: 'POST', headers: { authorization: `Bearer ${sessionToken()}`, origin: BASE } })
    expect(out.status).toBe(200)
    expect(await out.json()).toMatchObject({ shop: SHOP, connections: [] })
    expect(revoked).toHaveLength(1)
    const row = await booted.handle.db.selectFrom('connections').select(['id', 'status']).executeTakeFirstOrThrow()
    expect(row.status).toBe('disconnected')
    // The uninstall's erasure comes 48 hours later: the log says so now.
    const notes = await booted.handle.db.selectFrom('activity_log' as never).select(['detail' as never]).where('target_id' as never, '=', row.id as never).execute()
    expect(notes.map((n) => (n as { detail: string }).detail)).toContain(SHOPIFY_ERASE_WARNING)
  })
})

describe('Shopify review gaps: no staff email, and payouts inside the admin', () => {
  it('Shopify naming no staff member: sign-in, then "Connect <store> to <workspace>?" (Connect attaches it, Cancel does not)', async () => {
    staffEmail = undefined
    const { connectUrl } = (await (await status(sessionToken())).json()) as { connectUrl: string }
    expect(connectUrl).toBeTruthy()
    const opened = await app.request(connectUrl.replace(BASE, ''))
    expect(opened.headers.get('location')).toBe('/#/?signin_for=shopify')
    const session = await signIn('anyone@example.com')
    await app.request('/api/workspaces', post(session, { companyName: 'Harbor Coffee' }))
    const cookie = `${session}; ${cookieOf(opened)}`
    const ask = await app.request('/api/connectors/shopify/install/resume', { headers: { origin: BASE, cookie } })
    expect(ask.status).toBe(200)
    expect(await ask.text()).toContain('Connect harbor-coffee to Harbor Coffee?')
    expect(ask.headers.getSetCookie()).toEqual([]) // the link stays for the Connect button
    expect(connects).toEqual([])
    // Cancel forgets the link; Connect (same-origin POST) attaches the store.
    const cancel = await app.request('/api/connectors/shopify/install/cancel', { method: 'POST', headers: { origin: BASE, cookie } })
    expect(cancel.headers.getSetCookie().join(';')).toMatch(/agfn_shopify_link=;/)
    const yes = await app.request('/api/connectors/shopify/install/confirm', { method: 'POST', headers: { origin: BASE, cookie } })
    expect(yes.headers.get('location')).toMatch(/d=connection:/)
    expect(connects).toHaveLength(1)
    // A cross-site POST can't do it.
    expect((await app.request('/api/connectors/shopify/install/confirm', { method: 'POST', headers: { origin: 'https://evil.example', cookie } })).status).toBe(403)
  })

  it('connected: the admin page gets the latest payouts and the next expected one; another store gets none', async () => {
    const session = await signIn('owner-sum@example.com')
    await app.request('/api/workspaces', post(session, { companyName: 'Harbor Coffee' }))
    await installFromAdmin(session, SHOP, 'owner-sum@example.com')
    const sum = async (t?: string) => app.request('/api/connectors/shopify/embedded/summary', { headers: t ? { authorization: `Bearer ${t}` } : {} })
    expect((await sum()).status).toBe(401)
    expect(await (await sum(sessionToken())).json()).toEqual({
      connected: true,
      payouts: [
        { date: '2026-10-13', status: 'scheduled', currency: 'USD', gross: '260.00', fees: '10.00', refunds: '0.00', net: '250.00' },
        { date: '2026-10-08', status: 'paid', currency: 'USD', gross: '1000.00', fees: '32.60', refunds: '55.00', net: '912.40' },
      ],
      next: { date: '2026-10-13', status: 'scheduled', currency: 'USD', gross: '260.00', fees: '10.00', refunds: '0.00', net: '250.00' },
    })
    expect(await (await sum(sessionToken({ shop: 'other-store.myshopify.com' }))).json()).toEqual({ connected: false, payouts: [], next: null })
    const page = await (await app.request(`/api/connectors/shopify/install?embedded=1&host=x&shop=${SHOP}&timestamp=1&hmac=good`)).text()
    expect(page).toContain("No payouts yet; they'll appear after Shopify's next payout.")
  })
})

