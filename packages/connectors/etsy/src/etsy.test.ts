import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { BalanceSnapshot, ConnectionRef, NormalizedEvent, ProcessorBalanceTxn } from '@agfn/contracts'
import { ConnectorError, MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureResponse, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { createEtsyConnector, ETSY_NO_SHOP, ETSY_REFUSED, ETSY_SIGN_IN_ONLY, ETSY_TOKEN_REJECTED, ETSY_WRONG_SCOPE, etsyChainBroken, getOnly, LEDGER_TYPES, NOT_REVOKED, verifierFor } from './index.ts'

type Row = Record<string, unknown>
const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/etsy.json', import.meta.url), 'utf8')) as { me: Row; shop: Row; entries: Row[] }

const SHOP = 5550001
const ACCT = `etsy:${SHOP}:USD`
const LATER = Date.parse('2026-10-09T13:00:00Z')
const app = { clientId: 'samplekeystring', clientSecret: 'samplesharedsecret', redirectUri: 'https://app.example.com/api/connectors/etsy/callback' }
const conn: ConnectionRef = { id: 'conn_etsy', workspaceId: 'ws1', connectorKey: 'etsy', secret: { tokens: { accessToken: '7770001.access-sample', refreshToken: '7770001.refresh-sample', expiresAt: LATER } }, config: { shopId: SHOP } }
const sec = (iso: string) => Date.parse(iso) / 1000

interface Data {
  entries?: Row[]
  /** Answers first, for any API request; undefined falls through to the shop below. */
  hook?: (u: URL) => FixtureResponse | undefined
  token?: Row
}

/** A small Open API: me, the shop, and its ledger filtered by created (inclusive), in sequence order, paged by offset. */
function etsy(data: Data = {}): FixtureRoute[] {
  const entries = data.entries ?? fx.entries
  return [
    { method: 'GET', match: () => true, respond: (u) => data.hook?.(u) ?? route(u) },
    { method: 'POST', match: '/v3/public/oauth/token', respond: { json: data.token ?? { access_token: '7770001.renewed-sample', token_type: 'Bearer', expires_in: 3600, refresh_token: '7770001.refresh-next' } } },
  ]
  function route(u: URL): FixtureResponse {
    if (u.host !== 'openapi.etsy.com') return { status: 404, json: {} }
    if (u.pathname === '/v3/application/users/me') return { json: fx.me }
    if (u.pathname === `/v3/application/shops/${SHOP}`) return { json: fx.shop }
    if (u.pathname === `/v3/application/shops/${SHOP}/payment-account/ledger-entries`) {
      const min = Number(u.searchParams.get('min_created'))
      const max = Number(u.searchParams.get('max_created'))
      if (!(max > min) || max - min > 31 * 86_400) return { status: 400, json: { error: 'bad window' } }
      const limit = Number(u.searchParams.get('limit') ?? 25)
      const offset = Number(u.searchParams.get('offset') ?? 0)
      const all = entries.filter((e) => (e.created_timestamp as number) >= min && (e.created_timestamp as number) <= max).sort((a, b) => (a.sequence_number as number) - (b.sequence_number as number))
      return { json: { count: all.length, results: all.slice(offset, offset + limit) } }
    }
    return { status: 404, json: {} }
  }
}

function make(routes: FixtureRoute[] = etsy(), over: Partial<ConnectionRef> = {}) {
  const f = fixtureFetch(routes)
  const clock = fakeClock()
  const raw = new MemoryRawSink()
  const saved: unknown[] = []
  const connector = createEtsyConnector({ app }, { raw, fetch: f.fetch, clock, random: () => 0, saveSecret: async (_id, s) => void saved.push(s) })
  return { connector, conn: { ...conn, ...over }, calls: f.calls, clock, raw, saved }
}

const txns = (events: NormalizedEvent[]) => new Map(events.filter((e): e is ProcessorBalanceTxn => e.type === 'processor.balance_txn').map((e) => [e.externalId, e]))
const amounts = (t: ProcessorBalanceTxn | undefined) => (t ? [t.kind, t.gross.minor, t.fee.minor, t.net.minor] : undefined)
const ledgerCalls = (calls: { url: string }[]) => calls.filter((c) => c.url.includes('/payment-account/ledger-entries')).map((c) => new URL(c.url).searchParams)

/** Page by page, keeping what was sent before a failure (runSync drops it). */
async function steps(m: ReturnType<typeof make>): Promise<{ events: NormalizedEvent[]; error?: ConnectorError }> {
  const events: NormalizedEvent[] = []
  let cursor: string | null = null
  for (let i = 0; i < 200; i++) {
    try {
      const r = await m.connector.sync(m.conn, cursor)
      events.push(...r.events)
      cursor = r.cursor
      if (!r.hasMore) return { events }
    } catch (e) {
      return { events, error: e as ConnectorError }
    }
  }
  throw new Error('no end')
}

/** A chain of `n` entries starting at `start` (epoch seconds), `gap` seconds apart, from a 0 balance. */
function many(n: number, start: number, gap: number): Row[] {
  let bal = 0
  return Array.from({ length: n }, (_, i) => {
    const amount = i % 2 === 0 ? 1000 : -30
    bal += amount
    return { entry_id: 200001 + i, ledger_id: 9001, sequence_number: 1001 + i, amount, currency: 'USD', balance: bal, created_timestamp: start + i * gap, ledger_type: i % 2 === 0 ? 'PAYMENT_GROSS' : 'transaction', reference_type: 'receipt', reference_id: String(3300100000 + i) }
  })
}

describe('etsy connector', () => {
  it('passes the connector contract', async () => {
    const r = await runConnectorContract({ make: () => make(), minEvents: 19, signs: { 'etsy:100001': '+', 'etsy:100003': '-', 'etsy:100015': '-', 'etsy:100011': '+' } })
    // 365 days in 30-day windows: 13 ledger pages.
    expect(r.pages).toBe(13)
  })
  it('fixture is redacted', () => assertRedacted(fx))

  it('one row per entry, by category, to hand-computed numbers; the balance is the last entry’s', async () => {
    const m = make()
    const r = await runSync(m.connector, m.conn, null)
    const t = txns(r.events)
    expect(t.size).toBe(fx.entries.length)
    expect(amounts(t.get('etsy:100001'))).toEqual(['charge', 3000, 0, 3000])
    expect(amounts(t.get('etsy:100003'))).toEqual(['fee', 0, 195, -195])
    expect(amounts(t.get('etsy:100004'))).toEqual(['fee', 0, 120, -120])
    expect(amounts(t.get('etsy:100005'))).toEqual(['fee', 0, 20, -20])
    expect(amounts(t.get('etsy:100006'))).toEqual(['fee', 0, 450, -450])
    expect(amounts(t.get('etsy:100013'))).toEqual(['fee', 0, 650, -650])
    expect(amounts(t.get('etsy:100014'))).toEqual(['fee', 0, 12, -12])
    expect(amounts(t.get('etsy:100010'))).toEqual(['refund', -500, 0, -500])
    // Etsy handing fees back: still fees, negative.
    expect(amounts(t.get('etsy:100011'))).toEqual(['fee', 0, -33, 33])
    expect(amounts(t.get('etsy:100012'))).toEqual(['fee', 0, -15, 15])
    for (const x of t.values()) {
      expect(x.gross.minor - x.fee.minor).toBe(x.net.minor)
      expect(x.accountExternalId).toBe(ACCT)
      expect(x.net.currency).toBe('USD')
    }
    // Every row nets to the balance's movement: 27.80 at the end, from the 50.00 there before.
    expect([...t.values()].reduce((s, x) => s + x.net.minor, 0)).toBe(2780 - 5000)
    const snaps = r.events.filter((e): e is BalanceSnapshot => e.type === 'balance.snapshot')
    expect(snaps.at(-1)).toMatchObject({ accountExternalId: ACCT, at: '2026-10-05T10:00:01.000Z', current: { minor: 2780, currency: 'USD' } })
    expect(snaps.map((s) => [s.externalId, s.current.minor])).toEqual([
      [`${ACCT}@2026-09-03`, 6975],
      [`${ACCT}@2026-09-10`, 1000],
      [`${ACCT}@2026-10-05`, 2780],
    ])
    const accounts = r.events.filter((e) => e.type === 'account.upsert')
    expect(accounts).toEqual([expect.objectContaining({ externalId: ACCT, name: 'Etsy (USD)', accountType: 'processor_balance', currency: 'USD', institution: 'Etsy' })])
  })

  it('sales tax Etsy collects and remits is salesTax, never revenue', async () => {
    const t = txns((await runSync(make().connector, conn, null)).events)
    expect(t.get('etsy:100002')).toMatchObject({ kind: 'adjustment', gross: { minor: -240 }, net: { minor: -240 }, salesTax: true })
    expect([...t.values()].filter((x) => x.salesTax).map((x) => x.externalId)).toEqual(['etsy:100002'])
  })

  it('a deposit to the bank is the payout row: negative net, its own payout id, the day it left', async () => {
    const t = txns((await runSync(make().connector, conn, null)).events)
    expect(t.get('etsy:100015')).toEqual(expect.objectContaining({ kind: 'payout', gross: { minor: -6188, currency: 'USD' }, fee: { minor: 0, currency: 'USD' }, net: { minor: -6188, currency: 'USD' }, payoutExternalId: 'etsy:100015', at: '2026-09-10T06:00:00.000Z', arrivalDate: '2026-09-10' }))
    expect([...t.values()].filter((x) => x.payoutExternalId).map((x) => x.externalId)).toEqual(['etsy:100015'])
  })

  it('every known ledger_type maps to one category', () => {
    const cats = new Set(LEDGER_TYPES.values())
    expect([...cats].sort()).toEqual(['charge', 'fee', 'payout', 'refund', 'sales_tax'])
    expect(LEDGER_TYPES.get('disburse2')).toBe('payout')
    expect(LEDGER_TYPES.get('payment_gross')).toBe('charge')
    expect(LEDGER_TYPES.get('offsite_ads_fee_refund')).toBe('fee')
  })

  it('a ledger_type it doesn’t know stops the sync; nothing from its window is sent, earlier windows stand', async () => {
    const entries = structuredClone(fx.entries)
    entries.find((e) => e.entry_id === 100017)!.ledger_type = 'mystery_new_type'
    const { events, error } = await steps(make(etsy({ entries })))
    expect(error).toMatchObject({ kind: 'permanent', forUser: true })
    expect(error!.message).toContain('a kind of payment account entry Aggregate doesn’t read yet (mystery_new_type)')
    const t = txns(events)
    expect(t.has('etsy:100015')).toBe(true)
    // 100016 is in the same window as the unknown entry: not sent either.
    expect(t.has('etsy:100016')).toBe(false)
    expect(t.has('etsy:100017')).toBe(false)
  })

  it('a balance that doesn’t chain stops the sync; nothing from that window is recorded', async () => {
    const entries = structuredClone(fx.entries)
    entries.find((e) => e.entry_id === 100009)!.balance = 8303
    const { events, error } = await steps(make(etsy({ entries })))
    expect(error).toMatchObject({ kind: 'permanent', forUser: true })
    expect(error!.message).toBe(etsyChainBroken(sec('2026-09-04T12:00:00Z'), sec('2026-10-04T12:00:00Z')))
    const t = txns(events)
    // The window before (to 2026-09-04) passed its own check and stands; none of 09-05 to 10-04 is sent.
    expect([...t.keys()]).toEqual(['etsy:100001', 'etsy:100002', 'etsy:100003', 'etsy:100004', 'etsy:100005', 'etsy:100006'])
  })

  it('a missing entry breaks the chain, across windows and inside one', async () => {
    // 100007 opens the second window; without it 100008 doesn't follow 100006.
    const gone = (await steps(make(etsy({ entries: fx.entries.filter((e) => e.entry_id !== 100007) }))))
    expect(gone.error?.message).toContain('don’t add up')
    expect(txns(gone.events).size).toBe(6)
    // Inside one window: without 100005, 100006 doesn't follow 100004. Nothing at all is sent.
    const inner = await steps(make(etsy({ entries: fx.entries.filter((e) => e.entry_id !== 100005) })))
    expect(inner.error?.message).toContain('don’t add up')
    expect(inner.events).toEqual([])
  })

  it('an entry in another currency inside the ledger stops the sync', async () => {
    const entries = structuredClone(fx.entries)
    entries.find((e) => e.entry_id === 100003)!.currency = 'CAD'
    const { events, error } = await steps(make(etsy({ entries })))
    expect(error?.message).toBe('Etsy listed an entry in CAD in a payment account kept in USD. Adding them would be wrong, so this sync stopped. Nothing from those days was recorded.')
    expect(events).toEqual([])
  })

  it('pages a busy window by offset, 100 at a time, and holds it until it’s all read', async () => {
    const entries = many(250, sec('2026-10-05T00:00:00Z'), 60)
    const m = make(etsy({ entries }))
    const r = await runSync(m.connector, m.conn, null)
    const pages = ledgerCalls(m.calls).filter((q) => q.get('max_created') === String(sec('2026-10-09T12:00:00Z')))
    expect(pages.map((q) => [q.get('offset'), q.get('limit')])).toEqual([['0', '100'], ['100', '100'], ['200', '100']])
    expect(txns(r.events).size).toBe(250)
  })

  it('a window with more than 1,000 entries is halved first; the next window is back to 30 days', async () => {
    const m = make(etsy({ hook: (u) => (u.pathname.endsWith('/ledger-entries') && Number(u.searchParams.get('max_created')) - Number(u.searchParams.get('min_created')) > 20 * 86_400 && u.searchParams.get('min_created') === String(sec('2025-10-09T12:00:00Z')) ? { json: { count: 1500, results: [] } } : undefined) }))
    await runSync(m.connector, m.conn, null)
    const q = ledgerCalls(m.calls).slice(0, 3).map((p) => (Number(p.get('max_created')) - Number(p.get('min_created'))) / 86_400)
    expect(q).toEqual([30, 15, 30])
  })

  it('every window stays within Etsy’s 31 days, from a year back, up to when the run started', async () => {
    const m = make()
    await runSync(m.connector, m.conn, null)
    const q = ledgerCalls(m.calls)
    expect(q[0]!.get('min_created')).toBe(String(sec('2025-10-09T12:00:00Z')))
    expect(q.at(-1)!.get('max_created')).toBe(String(sec('2026-10-09T12:00:00Z')))
    for (const p of q) expect(Number(p.get('max_created')) - Number(p.get('min_created'))).toBeLessThanOrEqual(30 * 86_400)
  })

  it('the next run reads again from a day before the last one started, skips what it recorded, and sends what’s new', async () => {
    const m = make()
    const first = await runSync(m.connector, m.conn, null)
    const later = [
      ...structuredClone(fx.entries),
      // Late arrivals inside the overlap and after it, chaining on from 27.80.
      { entry_id: 100019, ledger_id: 9001, sequence_number: 519, amount: 500, currency: 'USD', balance: 3280, created_timestamp: sec('2026-10-09T11:59:00Z'), ledger_type: 'PAYMENT_GROSS' },
      { entry_id: 100020, ledger_id: 9001, sequence_number: 520, amount: -3280, currency: 'USD', balance: 0, created_timestamp: sec('2026-10-12T06:00:00Z'), ledger_type: 'DISBURSE2' },
    ]
    const m2 = make(etsy({ entries: later }))
    m2.clock.t = Date.parse('2026-10-15T12:00:00Z')
    const second = await runSync(m2.connector, m2.conn, first.cursor)
    const q = ledgerCalls(m2.calls)
    expect(q.map((p) => [p.get('min_created'), p.get('max_created')])).toEqual([[String(sec('2026-10-08T12:00:00Z')), String(sec('2026-10-15T12:00:00Z'))]])
    expect([...txns(second.events).keys()]).toEqual(['etsy:100019', 'etsy:100020'])
    expect(second.events.find((e) => e.type === 'balance.snapshot')).toMatchObject({ current: { minor: 0 } })
    expect(second.events.some((e) => e.type === 'account.upsert')).toBe(false)
  })

  it('an unrecorded entry that turns up before the last one recorded can’t be placed: the sync stops', async () => {
    const m = make()
    const first = await runSync(m.connector, m.conn, null)
    const late = [...structuredClone(fx.entries), { entry_id: 100099, ledger_id: 9001, sequence_number: 517, amount: 1, currency: 'USD', balance: 2871, created_timestamp: sec('2026-10-09T10:00:00Z'), ledger_type: 'PAYMENT_GROSS' }]
    const m2 = make(etsy({ entries: late }))
    m2.clock.t = Date.parse('2026-10-10T12:00:00Z')
    await expect(runSync(m2.connector, m2.conn, first.cursor)).rejects.toThrow('don’t add up')
  })

  it('reads only: GET with the Bearer token and x-api-key keystring:shared_secret; anything else never leaves', async () => {
    const m = make()
    await runSync(m.connector, m.conn, null)
    const api = m.calls.filter((c) => c.url.startsWith('https://openapi.etsy.com/'))
    expect(api.length).toBe(13)
    for (const c of api) {
      expect(c.method).toBe('GET')
      expect(c.headers.authorization).toBe('Bearer 7770001.access-sample')
      expect(c.headers['x-api-key']).toBe('samplekeystring:samplesharedsecret')
    }
    expect(m.calls.some((c) => c.method !== 'GET')).toBe(false)
    let sent = false
    const guarded = getOnly(async () => ((sent = true), new Response('{}')))
    await expect(guarded('https://openapi.etsy.com/v3/application/shops/1', { method: 'PUT' })).rejects.toThrow('only reads')
    await expect(guarded('https://openapi.etsy.com/v3/application/shops/1/listings', { method: 'POST' })).rejects.toThrow('only reads')
    await expect(guarded('https://openapi.etsy.com/v3/application/listings/1', { method: 'DELETE' })).rejects.toThrow('only reads')
    expect(sent).toBe(false)
  })

  it('stores no buyer data: no descriptions, no payment adjustments, not in an event, not in raw', async () => {
    const m = make()
    const r = await runSync(m.connector, m.conn, null)
    const stored = [...m.raw.records.values()]
    expect(stored.map((s) => s.kind)).toEqual(['etsy.ledger', 'etsy.ledger', 'etsy.ledger'])
    for (const s of [JSON.stringify(r.events.map(({ rawRef: _r, ...e }) => e)), JSON.stringify(stored.map((x) => x.payload))]) {
      for (const bad of ['Sample Buyer', 'Another Buyer', 'Third Buyer', 'Buyer Sample Name', 'Sample product', 'description', 'payment_adjustments', 'reason_code', 'user_id', 'Sample Studio', 'samplelogin']) expect(s).not.toContain(bad)
      assertRedacted(s)
    }
    const first = (stored[0]!.payload as { entries: Row[] }).entries[0]
    expect(Object.keys(first!).sort()).toEqual(['amount', 'balance', 'created', 'currency', 'id', 'ledger', 'refId', 'refType', 'seq', 'type'])
  })

  it('401 and 403 need a new sign-in, in words written here, never Etsy’s; 429 waits Etsy’s retry-after and tries again', async () => {
    const hook = (status: number) => () => ({ status, json: { error: 'internal detail about request sample' } })
    const e401 = (await steps(make(etsy({ hook: hook(401) })))).error!
    expect(e401).toMatchObject({ kind: 'auth', status: 401, message: ETSY_TOKEN_REJECTED, forUser: true })
    const e403 = (await steps(make(etsy({ hook: hook(403) })))).error!
    expect(e403).toMatchObject({ kind: 'auth', status: 403, message: ETSY_REFUSED, forUser: true })
    expect(e403.message).not.toContain('internal detail')

    let n = 0
    const m = make(etsy({ hook: () => (n++ === 0 ? { status: 429, headers: { 'retry-after': '3' }, json: {} } : undefined) }))
    const r = await runSync(m.connector, m.conn, null)
    expect(r.complete).toBe(true)
    expect(m.clock.sleeps).toContain(3000)
  })

  it('renews the one-hour access token before reading, and keeps the new one', async () => {
    const m = make(etsy(), { secret: { tokens: { accessToken: '7770001.old', refreshToken: '7770001.refresh-sample', expiresAt: Date.parse('2026-10-09T12:01:00Z') } } })
    const r = await m.connector.sync(m.conn, null)
    const post = m.calls.find((c) => c.method === 'POST')!
    expect(post.url).toBe('https://api.etsy.com/v3/public/oauth/token')
    expect(post.body).toEqual({ grant_type: 'refresh_token', refresh_token: '7770001.refresh-sample', client_id: app.clientId })
    expect(r.updatedSecret).toMatchObject({ tokens: { accessToken: '7770001.renewed-sample', refreshToken: '7770001.refresh-next' } })
    expect(m.saved).toHaveLength(1)
    expect(m.calls.at(-1)!.headers.authorization).toBe('Bearer 7770001.renewed-sample')
  })

  it('begin: Etsy’s consent page asking for exactly transactions_r shops_r, with an S256 PKCE challenge from the state', async () => {
    const b = (await make().connector.begin({ state: 'st-1' })) as { kind: string; url: string }
    expect(b.kind).toBe('oauth')
    const u = new URL(b.url)
    expect(u.origin + u.pathname).toBe('https://www.etsy.com/oauth/connect')
    expect(u.searchParams.get('scope')).toBe('transactions_r shops_r')
    expect(b.url).toContain('scope=transactions_r+shops_r')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    const verifier = verifierFor(app.clientSecret, 'st-1')
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(u.searchParams.get('code_challenge')).toBe(createHash('sha256').update(verifier).digest('base64url'))
    expect(Object.fromEntries(u.searchParams)).toEqual({ response_type: 'code', client_id: app.clientId, redirect_uri: app.redirectUri, state: 'st-1', scope: 'transactions_r shops_r', code_challenge: u.searchParams.get('code_challenge'), code_challenge_method: 'S256' })
    expect(verifierFor(app.clientSecret, 'st-2')).not.toBe(verifier)
  })

  it('connect exchanges the code with the matching verifier, no secret in the body, then reads the account, shop and ledger', async () => {
    const m = make(etsy({ token: { access_token: '7770001.access-sample', token_type: 'Bearer', expires_in: 3600, refresh_token: '7770001.refresh-sample', scope: 'shops_r transactions_r' } }))
    const r = await m.connector.connect({ code: 'code-sample', connectState: 'st-1', redirectUri: app.redirectUri })
    const post = m.calls[0]!
    expect(post).toMatchObject({ method: 'POST', url: 'https://api.etsy.com/v3/public/oauth/token' })
    expect(post.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(post.body).toEqual({ grant_type: 'authorization_code', code: 'code-sample', redirect_uri: app.redirectUri, code_verifier: verifierFor(app.clientSecret, 'st-1'), client_id: app.clientId })
    expect(m.calls.slice(1).map((c) => new URL(c.url).pathname)).toEqual(['/v3/application/users/me', `/v3/application/shops/${SHOP}`, `/v3/application/shops/${SHOP}/payment-account/ledger-entries`])
    expect(r.config).toEqual({ shopId: SHOP, userId: 7770001, currency: 'USD', displayName: 'Etsy · Sample Studio' })
    expect(r.secret).toMatchObject({ tokens: { accessToken: '7770001.access-sample', refreshToken: '7770001.refresh-sample' } })
    await expect(m.connector.connect({ state: 'x' })).rejects.toThrow(ETSY_SIGN_IN_ONLY)
  })

  it('connect refuses more access than asked for, a token for someone else, and an account with no shop', async () => {
    const wide = make(etsy({ token: { access_token: '7770001.a', expires_in: 3600, refresh_token: '7770001.r', scope: 'transactions_r shops_r transactions_w' } }))
    await expect(wide.connector.connect({ code: 'c', connectState: 's' })).rejects.toThrow(ETSY_WRONG_SCOPE)
    const other = make(etsy({ token: { access_token: '1234.a', expires_in: 3600, refresh_token: '1234.r' } }))
    await expect(other.connector.connect({ code: 'c', connectState: 's' })).rejects.toThrow(/can’t read/)
    const noShop = make(etsy({ hook: (u) => (u.pathname === '/v3/application/users/me' ? { json: { user_id: 7770001 } } : undefined) }))
    await expect(noShop.connector.connect({ code: 'c', connectState: 's' })).rejects.toThrow(ETSY_NO_SHOP)
  })

  it('describes itself as text-only Etsy and tells the seller where to remove it', async () => {
    const c = make().connector
    expect(c.describe()).toEqual({ key: 'etsy', name: 'Etsy', group: 'payments', provides: ['transactions'], freshness: 'updates every few hours', auth: 'oauth', staleAfterHours: 24 })
    expect(await c.disconnect!(conn)).toEqual({ notRevoked: NOT_REVOKED })
  })
})
