import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ConnectionRef, NormalizedEvent, ProcessorBalanceTxn } from '@agfn/contracts'
import { ConnectorError, MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureResponse, type FixtureRoute } from '@agfn/connector-sdk/testing'
import {
  AMAZON_REFUSED,
  AMAZON_SIGN_IN_ONLY,
  AMAZON_TOKEN_REJECTED,
  amazonHeld,
  amazonLoginRedirect,
  amountIn,
  createAmazonConnector,
  getOnly,
  NOT_REVOKED,
} from './index.ts'

type Row = Record<string, unknown>
const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/amazon.json', import.meta.url), 'utf8')) as { groupPages: Row[][]; events: Record<string, Row[]> }

const SELLER = 'A1SAMPLESELLER'
const LATER = Date.parse('2026-10-09T13:00:00Z')
const conn: ConnectionRef = { id: 'conn_amz', workspaceId: 'ws1', connectorKey: 'amazon', secret: { tokens: { accessToken: 'Atza|access-sample', refreshToken: 'Atzr|refresh-sample', expiresAt: LATER } }, config: { sellerId: SELLER } }
const app = { appId: 'amzn1.sellerapps.app.sample', clientId: 'amzn1.application-oa2-client.sample', clientSecret: 'client-secret-sample', redirectUri: 'https://app.example.com/api/connectors/amazon/callback' }

interface Data {
  groupPages?: Row[][]
  events?: Record<string, Row[]>
  /** Answers first, for any request; undefined falls through to the seller below. */
  hook?: (u: URL) => FixtureResponse | undefined
}

/** A small SP-API: settlements filtered by start, paged by NextToken; each settlement's events paged the same way. */
function amazon(data: Data = {}): FixtureRoute[] {
  const pages = data.groupPages ?? fx.groupPages
  const events = data.events ?? fx.events
  return [
    { method: 'GET', match: () => true, respond: (u) => data.hook?.(u) ?? route(u) },
    { method: 'POST', match: '/auth/o2/token', respond: { json: { access_token: 'Atza|renewed-sample', token_type: 'bearer', expires_in: 3600, refresh_token: 'Atzr|refresh-sample' } } },
  ]
  function route(u: URL): FixtureResponse {
    if (u.host !== 'sellingpartnerapi-na.amazon.com') return { status: 404, json: {} }
    if (u.pathname === '/finances/v0/financialEventGroups') {
      const i = Number(u.searchParams.get('NextToken')?.replace('g', '') ?? 0)
      const since = Date.parse(u.searchParams.get('FinancialEventGroupStartedAfter') ?? '')
      const list = (pages[i] ?? []).filter((g) => !(Date.parse(String(g.FinancialEventGroupStart)) < since))
      return { json: { payload: { FinancialEventGroupList: list, ...(i + 1 < pages.length ? { NextToken: `g${i + 1}` } : {}) } } }
    }
    const m = /^\/finances\/v0\/financialEventGroups\/([^/]+)\/financialEvents$/.exec(u.pathname)
    if (m) {
      const list = events[decodeURIComponent(m[1]!)] ?? [{}]
      const i = Number(u.searchParams.get('NextToken')?.replace('p', '') ?? 0)
      return { json: { payload: { FinancialEvents: list[i] ?? {}, ...(i + 1 < list.length ? { NextToken: `p${i + 1}` } : {}) } } }
    }
    return { status: 404, json: {} }
  }
}

function make(routes: FixtureRoute[] = amazon(), over: Partial<ConnectionRef> = {}, draft = true) {
  const f = fixtureFetch(routes)
  const clock = fakeClock()
  const raw = new MemoryRawSink()
  const saved: unknown[] = []
  const connector = createAmazonConnector({ app, draft }, { raw, fetch: f.fetch, clock, random: () => 0, saveSecret: async (_id, s) => void saved.push(s) })
  return { connector, conn: { ...conn, ...over }, calls: f.calls, clock, raw, saved }
}

const txns = (events: NormalizedEvent[]) => new Map(events.filter((e): e is ProcessorBalanceTxn => e.type === 'processor.balance_txn').map((e) => [e.externalId, e]))
const amounts = (t: ProcessorBalanceTxn | undefined) => (t ? [t.gross.minor, t.fee.minor, t.net.minor] : undefined)
const g = (over: Row = {}): Row => ({ FinancialEventGroupId: 'GX', ProcessingStatus: 'Closed', FundTransferStatus: 'Succeeded', OriginalTotal: { CurrencyCode: 'USD', CurrencyAmount: 25.5 }, FundTransferDate: '2026-10-01T10:00:00Z', FinancialEventGroupStart: '2026-09-25T00:00:00Z', FinancialEventGroupEnd: '2026-09-30T00:00:00Z', ...over })
const sale = (principal: number, fee: number, currency = 'USD'): Row => ({
  ShipmentEventList: [{ ShipmentItemList: [{ ItemChargeList: [{ ChargeType: 'Principal', ChargeAmount: { CurrencyCode: currency, CurrencyAmount: principal } }], ItemFeeList: [{ FeeType: 'Commission', FeeAmount: { CurrencyCode: currency, CurrencyAmount: fee } }] }] }],
})

/** Page by page, keeping what was sent before a failure (runSync drops it). */
async function steps(m: ReturnType<typeof make>): Promise<{ events: NormalizedEvent[]; warnings: string[]; error?: ConnectorError }> {
  const events: NormalizedEvent[] = []
  const warnings: string[] = []
  let cursor: string | null = null
  for (let i = 0; i < 100; i++) {
    try {
      const r = await m.connector.sync(m.conn, cursor)
      events.push(...r.events)
      warnings.push(...(r.warnings ?? []))
      cursor = r.cursor
      if (!r.hasMore) return { events, warnings }
    } catch (e) {
      return { events, warnings, error: e as ConnectorError }
    }
  }
  throw new Error('no end')
}

describe('amazon connector', () => {
  it('passes the connector contract', async () => {
    const r = await runConnectorContract({ make: () => make(), minEvents: 15, signs: { 'G1-USD#payout': '-', 'G1-USD#sales': '+', 'G1-USD#fees': '-' } })
    expect(r.pages).toBe(7)
  })
  it('fixture is redacted', () => assertRedacted(fx))

  it('adds up to hand-computed numbers, one row per category, and each settlement nets to zero', async () => {
    const m = make()
    const r = await runSync(m.connector, m.conn, null)
    const t = txns(r.events)
    // G1: sales 100.00 + 5.00 shipping − 10.00 promotion. Fees: −15.75 − 3.22 − 39.99 subscription − 12.50 ads.
    expect(amounts(t.get('G1-USD#sales'))).toEqual([95_00, 0, 95_00])
    expect(amounts(t.get('G1-USD#fees'))).toEqual([0, 71_46, -71_46])
    // Refund −20.00 + 2.00 promotion back; Amazon hands back 3.00 of its fee, less a 0.60 refund administration fee.
    expect(amounts(t.get('G1-USD#refunds'))).toEqual([-18_00, -2_40, -15_60])
    // The reimbursement once (its item's TotalAmount repeats it); the reserve held back as the seller's own money.
    expect(amounts(t.get('G1-USD#adjustments'))).toEqual([7_40, 0, 7_40])
    expect(t.get('G1-USD#reserve')).toMatchObject({ gross: { minor: -4_00 }, balanceRole: 'other_assets' })
    // Tax 8.25 + 0.41 − 1.65 is all marketplace facilitator tax Amazon withheld: it nets to zero, so no row.
    expect(t.has('G1-USD#tax')).toBe(false)
    expect(t.get('G1-USD#payout')).toMatchObject({ kind: 'payout', net: { minor: -11_34, currency: 'USD' }, payoutExternalId: 'G1-USD', at: '2026-09-16T10:00:00.000Z', arrivalDate: '2026-09-16', linkRefs: { trace_id: 'TRACE0001' } })
    expect(t.get('G1-USD#sales')).toMatchObject({ kind: 'charge', at: '2026-09-15T00:00:00.000Z', payoutExternalId: 'G1-USD', accountExternalId: `amazon:${SELLER}:USD` })
    // G2: 30.00 − 4.50 doesn't make 29.50 alone; with the 4.00 carried in it does, and the carry is its own row.
    expect(amounts(t.get('G2-USD#sales'))).toEqual([30_00, 0, 30_00])
    expect(t.get('G2-USD#carried_in')).toMatchObject({ gross: { minor: 4_00 }, balanceRole: 'other_assets' })
    expect(t.get('G2-USD#payout')?.net.minor).toBe(-29_50)
    for (const id of ['G1-USD', 'G2-USD', 'G5-CAD']) {
      const rows = [...t.values()].filter((x) => x.payoutExternalId === id)
      expect(rows.reduce((s, x) => s + x.net.minor, 0)).toBe(0)
      for (const x of rows) expect(x.gross.minor - x.fee.minor).toBe(x.net.minor)
    }
  })

  it('a settlement that doesn’t add up sends nothing from it and stops the sync; earlier ones stand', async () => {
    const pages = structuredClone(fx.groupPages)
    pages[0]![1]!.OriginalTotal = { CurrencyCode: 'USD', CurrencyAmount: 29.51 }
    const { events, error } = await steps(make(amazon({ groupPages: pages })))
    expect(error).toBeInstanceOf(ConnectorError)
    expect(error).toMatchObject({ kind: 'permanent', forUser: true })
    expect(error!.message).toBe('Amazon’s settlement paid on 2026-09-30 doesn’t add up: its events come to 25.50 USD, but Amazon says it paid 29.51 USD. This sync stopped before recording it, so nothing from that settlement was recorded, and the settlements before it are unchanged.')
    const t = txns(events)
    expect(t.get('G1-USD#payout')?.net.minor).toBe(-11_34)
    expect([...t.keys()].some((k) => k.startsWith('G2-USD'))).toBe(false)
  })

  it('the first settlement off by a cent: nothing at all is sent', async () => {
    const pages = structuredClone(fx.groupPages)
    pages[0]![0]!.OriginalTotal = { CurrencyCode: 'USD', CurrencyAmount: 11.35 }
    const { events, error } = await steps(make(amazon({ groupPages: pages })))
    expect(error?.message).toContain('its events come to 11.34 USD, but Amazon says it paid 11.35 USD')
    expect(events).toEqual([])
  })

  it('BeginningBalance only counts when the events alone don’t already make the total', async () => {
    const m = make(amazon({ groupPages: [[g({ BeginningBalance: { CurrencyCode: 'USD', CurrencyAmount: 9 } })]], events: { GX: [sale(30, -4.5)] } }))
    const r = await runSync(m.connector, m.conn, null)
    const t = txns(r.events)
    expect(t.has('GX#carried_in')).toBe(false)
    expect(t.get('GX#payout')?.net.minor).toBe(-25_50)
  })

  it('open settlements send nothing (not even a balance); closed but unpaid ones wait, with a warning', async () => {
    const m = make()
    const r = await steps(m)
    expect(r.events.some((e) => e.externalId.startsWith('G3-USD') || e.externalId.startsWith('G4-USD'))).toBe(false)
    expect(r.events.some((e) => e.type === 'balance.snapshot')).toBe(false)
    expect(m.calls.some((c) => c.url.includes('G3-USD') || c.url.includes('G4-USD'))).toBe(false)
    expect(r.warnings).toEqual([amazonHeld(1)])
  })

  it('keeps currencies apart: one balance per currency, never added together', async () => {
    const m = make()
    const r = await runSync(m.connector, m.conn, null)
    const accounts = r.events.filter((e) => e.type === 'account.upsert')
    expect(accounts.map((a) => [a.externalId, a.type === 'account.upsert' ? a.currency : ''])).toEqual([
      [`amazon:${SELLER}:USD`, 'USD'],
      [`amazon:${SELLER}:CAD`, 'CAD'],
    ])
    const t = txns(r.events)
    expect(t.get('G5-CAD#payout')).toMatchObject({ net: { minor: -8_50, currency: 'CAD' }, accountExternalId: `amazon:${SELLER}:CAD` })
    expect(amounts(t.get('G5-CAD#fees'))).toEqual([0, 1_50, -1_50])
  })

  it('an amount in another currency inside a settlement stops the sync', async () => {
    const { events, error } = await steps(make(amazon({ groupPages: [[g()]], events: { GX: [sale(30, -4.5, 'CAD')] } })))
    expect(error?.message).toBe('Amazon listed an amount in CAD inside a USD settlement. Adding them would be wrong, so this sync stopped. No totals were changed.')
    expect(events).toEqual([])
  })

  it('an event kind it doesn’t know stops the sync, never left out', async () => {
    const { error } = await steps(make(amazon({ groupPages: [[g()]], events: { GX: [{ ...sale(30, -4.5), NewMysteryEventList: [{ Amount: { CurrencyCode: 'USD', CurrencyAmount: 1 } }] }] } })))
    expect(error?.message).toContain('a kind of settlement event Aggregate doesn’t read yet (NewMysteryEventList)')
  })

  it('amounts are exact: places the currency doesn’t have stop, never rounded', () => {
    expect(amountIn({ CurrencyCode: 'USD', CurrencyAmount: 10.34 }, 'USD')).toBe(10_34)
    expect(amountIn({ CurrencyCode: 'USD', CurrencyAmount: '-0.50' }, 'USD')).toBe(-50)
    expect(amountIn({ CurrencyCode: 'USD', CurrencyAmount: '7.400' }, 'USD')).toBe(7_40)
    expect(amountIn(undefined, 'USD')).toBe(0)
    expect(() => amountIn({ CurrencyCode: 'USD', CurrencyAmount: 0.005 }, 'USD')).toThrow(/can’t read/)
    expect(() => amountIn({ CurrencyCode: 'USD', CurrencyAmount: 'ten' }, 'USD')).toThrow(/can’t read/)
    expect(() => amountIn({ CurrencyCode: 'USD' }, 'USD')).toThrow(/can’t read/)
  })

  it('reads only: GET to the SP-API with the access token, no signing; anything else never leaves', async () => {
    const m = make()
    await runSync(m.connector, m.conn, null)
    const api = m.calls.filter((c) => c.url.startsWith('https://sellingpartnerapi-na.amazon.com/'))
    // Two settlement pages, G1's two event pages, G2's and G5's one each.
    expect(api.length).toBe(6)
    for (const c of api) {
      expect(c.method).toBe('GET')
      expect(c.headers['x-amz-access-token']).toBe('Atza|access-sample')
      expect(c.headers['user-agent']).toMatch(/^Aggregate\//)
      expect(c.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/)
      expect(c.headers.authorization).toBeUndefined()
    }
    expect(m.calls.some((c) => c.method !== 'GET')).toBe(false)
    let sent = false
    const guarded = getOnly(async () => ((sent = true), new Response('{}')))
    await expect(guarded('https://sellingpartnerapi-na.amazon.com/finances/v0/financialEventGroups', { method: 'POST' })).rejects.toThrow('only reads')
    await expect(guarded('https://sellingpartnerapi-na.amazon.com/x', { method: 'DELETE' })).rejects.toThrow('only reads')
    expect(sent).toBe(false)
  })

  it('stores no order ids, SKUs, ASINs, store names or bank details: not in an event, not in raw', async () => {
    const m = make()
    const r = await runSync(m.connector, m.conn, null)
    const stored = [...m.raw.records.values()]
    expect(stored.map((s) => s.kind)).toEqual(['amazon.settlement', 'amazon.settlement', 'amazon.settlement'])
    // rawRef (a hash) left out: its hex digits read as an account number to the check.
    for (const s of [JSON.stringify(r.events.map(({ rawRef: _r, ...e }) => e)), JSON.stringify(stored.map((x) => x.payload))]) {
      for (const bad of ['111-0000000', '702-0000000', 'SKU-SAMPLE', 'B000SAMPLE', 'Sample Store', 'Sample product', 'PROMO-SAMPLE', 'OI-SAMPLE', 'INV-SAMPLE', 'AccountTail', 'SELLER-ORDER']) expect(s).not.toContain(bad)
      assertRedacted(s)
    }
    expect(stored[0]!.payload).toMatchObject({ settlement: { id: 'G1-USD', currency: 'USD', total: 11_34 }, totals: { sales: 95_00, fees: -71_46 } })
  })

  it('pages settlements and events a step at a time; the next run lists 35 days again and reads only what’s new', async () => {
    const m = make()
    const first = await runSync(m.connector, m.conn, null)
    const list = m.calls.filter((c) => c.url.includes('/financialEventGroups?'))
    expect(new URL(list[0]!.url).searchParams.get('FinancialEventGroupStartedAfter')).toBe('2025-04-17T12:00:00.000Z')
    expect(new URL(list[1]!.url).searchParams.get('NextToken')).toBe('g1')
    expect(m.calls.filter((c) => c.url.includes('/G1-USD/financialEvents')).map((c) => new URL(c.url).searchParams.get('NextToken'))).toEqual([null, 'p1'])

    // Later: G6 has closed and been paid; G4's transfer has gone through. G2 and G5 are inside the window, already recorded.
    const pages = structuredClone(fx.groupPages)
    pages[1]![0]!.FundTransferStatus = 'Succeeded'
    pages[1]![0]!.FundTransferDate = '2026-09-28T10:00:00Z'
    pages[1]!.push(g({ FinancialEventGroupId: 'G6-USD', FinancialEventGroupStart: '2026-10-01T00:00:00Z' }))
    const m2 = make(amazon({ groupPages: pages, events: { ...fx.events, 'G4-USD': [sale(3.5, -0.5)], 'G6-USD': [sale(30, -4.5)] } }))
    m2.clock.t = Date.parse('2026-10-20T12:00:00Z')
    const second = await runSync(m2.connector, m2.conn, first.cursor)
    expect(new URL(m2.calls.find((c) => c.url.includes('/financialEventGroups?'))!.url).searchParams.get('FinancialEventGroupStartedAfter')).toBe('2026-09-04T12:00:00.000Z')
    const read = m2.calls.filter((c) => c.url.includes('/financialEvents')).map((c) => new URL(c.url).pathname.split('/')[4])
    expect(read).toEqual(['G4-USD', 'G6-USD'])
    expect(txns(second.events).get('G6-USD#payout')?.net.minor).toBe(-25_50)
    expect(txns(second.events).get('G4-USD#payout')?.net.minor).toBe(-3_00)
  })

  it('401 and 403 need a new sign-in, in words written here, never Amazon’s; 429 waits its rate and tries again', async () => {
    const hook = (status: number) => () => ({ status, json: { errors: [{ code: 'Unauthorized', message: 'internal detail about request sample' }] } })
    const e401 = (await steps(make(amazon({ hook: hook(401) })))).error!
    expect(e401).toMatchObject({ kind: 'auth', status: 401, message: AMAZON_TOKEN_REJECTED, forUser: true })
    const e403 = (await steps(make(amazon({ hook: hook(403) })))).error!
    expect(e403).toMatchObject({ kind: 'auth', status: 403, message: AMAZON_REFUSED, forUser: true })
    expect(e403.message).not.toContain('internal detail')

    let n = 0
    const m = make(amazon({ hook: () => (n++ === 0 ? { status: 429, headers: { 'x-amzn-RateLimit-Limit': '0.5' }, json: {} } : undefined) }))
    const r = await runSync(m.connector, m.conn, null)
    expect(r.complete).toBe(true)
    expect(m.clock.sleeps).toContain(2000)
  })

  it('renews the one-hour access token before reading, and keeps the new one', async () => {
    const m = make(amazon(), { secret: { tokens: { accessToken: 'Atza|old', refreshToken: 'Atzr|refresh-sample', expiresAt: Date.parse('2026-10-09T12:01:00Z') } } })
    const r = await m.connector.sync(m.conn, null)
    const post = m.calls.find((c) => c.method === 'POST')!
    expect(post.url).toBe('https://api.amazon.com/auth/o2/token')
    expect(post.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'Atzr|refresh-sample', client_id: app.clientId, client_secret: app.clientSecret })
    expect(r.updatedSecret).toMatchObject({ tokens: { accessToken: 'Atza|renewed-sample', refreshToken: 'Atzr|refresh-sample' } })
    expect(m.saved).toHaveLength(1)
    expect(m.calls.at(-1)!.headers['x-amz-access-token']).toBe('Atza|renewed-sample')
  })

  it('begin: Seller Central consent with the app id and state, version=beta only while the app is Draft', async () => {
    const draft = new URL(((await make().connector.begin({ state: 'st-1' })) as { url: string }).url)
    expect(draft.origin + draft.pathname).toBe('https://sellercentral.amazon.com/apps/authorize/consent')
    expect(Object.fromEntries(draft.searchParams)).toEqual({ application_id: app.appId, state: 'st-1', version: 'beta' })
    const published = new URL(((await make(amazon(), {}, false).connector.begin({ state: 'st-2' })) as { url: string }).url)
    expect(Object.fromEntries(published.searchParams)).toEqual({ application_id: app.appId, state: 'st-2' })
  })

  it('the log-in step goes back to Amazon’s confirm page only, with both states and the redirect URI', () => {
    const q = { amazon_callback_uri: 'https://amazon.com/apps/authorize/confirm/amzn1.sellerapps.app.sample', amazon_state: 'amz-st', selling_partner_id: SELLER, version: 'beta' }
    const u = new URL(amazonLoginRedirect(q, { state: 'st-1', redirectUri: app.redirectUri, draft: false })!)
    expect(u.origin + u.pathname).toBe('https://amazon.com/apps/authorize/confirm/amzn1.sellerapps.app.sample')
    expect(Object.fromEntries(u.searchParams)).toEqual({ amazon_state: 'amz-st', state: 'st-1', redirect_uri: app.redirectUri, version: 'beta' })
    expect(new URL(make().connector.loginRedirect({ ...q, version: undefined }, 'st-2')!).searchParams.get('version')).toBe('beta')
    for (const bad of ['https://evil.example.com/apps/authorize/confirm/x', 'http://amazon.com/apps/authorize/confirm/x', 'https://amazon.com.evil.example/apps/authorize/confirm/x', 'https://amazon.com/somewhere/else', 'not a url']) {
      expect(amazonLoginRedirect({ ...q, amazon_callback_uri: bad }, { state: 'st', redirectUri: app.redirectUri, draft: true })).toBeNull()
    }
    expect(amazonLoginRedirect({ ...q, amazon_state: undefined }, { state: 'st', redirectUri: app.redirectUri, draft: true })).toBeNull()
  })

  it('connect exchanges spapi_oauth_code at Login with Amazon, form-encoded, and reads once', async () => {
    const m = make()
    const r = await m.connector.connect({ spapi_oauth_code: 'code-sample', selling_partner_id: SELLER, redirectUri: app.redirectUri })
    const post = m.calls[0]!
    expect(post).toMatchObject({ method: 'POST', url: 'https://api.amazon.com/auth/o2/token' })
    expect(post.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(post.body).toEqual({ grant_type: 'authorization_code', code: 'code-sample', redirect_uri: app.redirectUri, client_id: app.clientId, client_secret: app.clientSecret })
    expect(m.calls[1]!.url).toContain('/finances/v0/financialEventGroups?')
    expect(r.config).toEqual({ sellerId: SELLER, marketplaceId: 'ATVPDKIKX0DER', displayName: 'Amazon' })
    expect(r.secret).toMatchObject({ tokens: { accessToken: 'Atza|renewed-sample', refreshToken: 'Atzr|refresh-sample' } })
    await expect(m.connector.connect({ code: 'x' })).rejects.toThrow(AMAZON_SIGN_IN_ONLY)
    await expect(m.connector.connect({ spapi_oauth_code: 'x', selling_partner_id: 'bad id!' })).rejects.toThrow(/can’t read/)
  })

  it('describes itself as text-only Amazon and tells the seller where to remove it', async () => {
    const c = make().connector
    expect(c.describe()).toEqual({ key: 'amazon', name: 'Amazon', group: 'payments', provides: ['transactions'], freshness: 'updates every few hours', auth: 'oauth' })
    expect(await c.disconnect!(conn)).toEqual({ notRevoked: NOT_REVOKED })
  })
})
