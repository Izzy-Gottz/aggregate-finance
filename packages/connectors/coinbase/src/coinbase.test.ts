import { generateKeyPairSync, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { AccountUpsert, BalanceSnapshot, ConnectionRef, NormalizedEvent, TxnUpsert } from '@agfn/contracts'
import { isConnectorError, MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { describe, expect, it } from 'vitest'
import { classifyCoinbaseError } from './client.ts'
import { COINBASE_KEY_REFUSED_HOSTED, COINBASE_KEY_TOO_STRONG, COINBASE_NO_RATES_WARNING, createCoinbaseConnector, type CoinbaseSecret } from './connector.ts'
import { coinbaseJwt, loadCoinbaseKey } from './jwt.ts'
import { usdValue } from './map.ts'

const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/coinbase.json', import.meta.url), 'utf8')) as {
  accounts: Record<string, unknown>
  rates: unknown
  transactions: Record<string, unknown>
  token: unknown
  refreshed: unknown
  permissions: { view: unknown; trade: unknown }
  errors: { revoked: unknown; scope: unknown; rate: unknown }
}
const NOW = Date.parse('2026-10-14T12:00:00Z')
const REDIRECT = 'https://app.example.com/api/connectors/coinbase/callback'

const routes = (o: { rates?: boolean; perms?: 'view' | 'trade' } = {}): FixtureRoute[] => [
  { match: (u) => u.pathname === '/v2/accounts', respond: (u) => ({ json: u.searchParams.get('limit') === '1' && !u.searchParams.get('starting_after') ? fx.accounts[''] : fx.accounts[u.searchParams.get('starting_after') ?? ''] }) },
  { match: (u) => u.pathname === '/v2/exchange-rates', respond: o.rates === false ? { status: 503, json: {} } : { json: fx.rates } },
  { match: (u) => u.pathname === '/v2/accounts/acct-usd/transactions', respond: (u) => ({ json: fx.transactions[u.searchParams.get('starting_after') ?? ''] }) },
  { match: (u) => u.pathname === '/api/v3/brokerage/key_permissions', respond: { json: fx.permissions[o.perms ?? 'view'] } },
  { match: (u) => u.pathname === '/oauth2/token', respond: (_u, body) => ({ json: (body as Record<string, string>).grant_type === 'refresh_token' ? fx.refreshed : fx.token }) },
  { match: (u) => u.pathname === '/oauth2/revoke', respond: { json: {} } },
]

function make(o: { secret?: CoinbaseSecret; saved?: unknown[]; extra?: FixtureRoute[]; rates?: boolean; perms?: 'view' | 'trade'; hosted?: boolean; oauth?: boolean } = {}) {
  const ff = fixtureFetch([...(o.extra ?? []), ...routes(o)])
  const connector = createCoinbaseConnector({
    deps: { raw: new MemoryRawSink(), fetch: ff.fetch, clock: fakeClock(NOW), random: () => 0.5, saveSecret: async (_id, s) => void o.saved?.push(s) },
    ...(o.oauth === false ? {} : { oauth: { clientId: 'cb_client_redacted', clientSecret: 'cb_secret_redacted', redirectUri: REDIRECT } }),
    ...(o.hosted ? { hosted: true } : {}),
  })
  const conn: ConnectionRef = {
    id: 'conn_cb',
    workspaceId: 'ws',
    connectorKey: 'coinbase',
    secret: o.secret ?? ({ kind: 'oauth', tokens: { accessToken: 'at_test_1', refreshToken: 'rt_test_1', expiresAt: NOW + 3_600_000 } } satisfies CoinbaseSecret),
    config: {},
  }
  return { connector, conn, ff }
}
const of = <T extends NormalizedEvent['type']>(events: NormalizedEvent[], type: T) => events.filter((e): e is Extract<NormalizedEvent, { type: T }> => e.type === type)

function edKey(): { name: string; privateKey: string; publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'] } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  // Coinbase shows an Ed25519 secret as base64 of seed + public key (64 bytes).
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  return { name: '11111111-2222-3333-4444-555555555555', privateKey: Buffer.concat([seed, pub]).toString('base64'), publicKey }
}

describe('coinbase contract', () => {
  it('passes the connector contract', async () => {
    const r = await runConnectorContract({ make: () => make(), minEvents: 12 })
    expect(r.pages).toBeGreaterThanOrEqual(3)
  })
  it('fixture is redacted', () => assertRedacted(fx))
})

describe('coinbase: wallets, holdings and cash rows (hand-checked)', () => {
  it('a cash wallet is money in its own currency; crypto wallets are not-money accounts holding the exact quantity at Coinbase’s dollar rate', async () => {
    const ev = (await runSync(make().connector, make().conn, null)).events
    const accounts = of(ev, 'account.upsert') as AccountUpsert[]
    expect(accounts.map((a) => [a.externalId, a.name, a.accountType, a.currency])).toEqual([
      ['acct-usd', 'Coinbase USD', 'crypto', 'USD'],
      ['acct-btc', 'Coinbase BTC', 'crypto', 'XXX'],
      ['acct-eth', 'Coinbase ETH', 'crypto', 'XXX'],
      // An empty DOGE wallet (Coinbase lists one for every asset) is skipped.
      ['acct-usdc', 'Coinbase USDC', 'crypto', 'XXX'],
    ])
    const snaps = new Map((of(ev, 'balance.snapshot') as BalanceSnapshot[]).map((s) => [s.accountExternalId, s]))
    expect(snaps.get('acct-usd')?.current).toEqual({ minor: 630_00, currency: 'USD' })
    expect(snaps.get('acct-usd')?.holdings).toBeUndefined()
    // 0.0153 BTC at 0.000016 BTC per dollar = $956.25; 0.5 ETH at 0.0004 = $1,250.00; 25 USDC = $25.00.
    expect(snaps.get('acct-btc')?.holdings).toEqual([{ securityExternalId: 'coinbase:BTC', ticker: 'BTC', name: 'Bitcoin', quantity: '0.01530000', value: { minor: 956_25, currency: 'USD' } }])
    expect(snaps.get('acct-eth')?.holdings?.[0]).toMatchObject({ quantity: '0.50000000', value: { minor: 1_250_00, currency: 'USD' } })
    expect(snaps.get('acct-usdc')?.holdings?.[0]).toMatchObject({ quantity: '25.000000', value: { minor: 25_00, currency: 'USD' } })
    expect(snaps.get('acct-btc')?.current.currency).toBe('XXX')
  })

  it('cash rows: every completed row signed as Coinbase sends it, trades marked CRYPTO_TRADE, pending kept pending, canceled void', async () => {
    const ev = (await runSync(make().connector, make().conn, null)).events
    const rows = (of(ev, 'txn.upsert') as TxnUpsert[]).map((t) => [t.externalId, t.date, t.amount.minor, t.status, t.categoryHint, t.rawText])
    expect(rows).toEqual([
      ['tx-5', '2026-10-10', -100_00, 'pending', undefined, 'Withdrawal from Coinbase'],
      // A buy paid with Apple Pay: the payment in pairs with the card or bank, only the leg to crypto is the trade.
      ['tx-6b', '2026-10-09', -100_00, 'posted', 'CRYPTO_TRADE', 'Bought crypto · Apple Pay'],
      ['tx-6a', '2026-10-09', 100_00, 'posted', undefined, 'Paid in for a crypto buy · Apple Pay'],
      ['tx-4', '2026-10-08', 120_00, 'posted', 'CRYPTO_TRADE', 'Sold crypto'],
      ['tx-3', '2026-10-05', -500_00, 'posted', 'CRYPTO_TRADE', 'Bought crypto'],
      ['tx-2', '2026-10-03', 1_000_00, 'posted', undefined, 'Deposit to Coinbase'],
      ['tx-1', '2026-10-02', 250_00, 'void', undefined, 'Deposit to Coinbase'],
      ['tx-0', '2026-09-28', 10_00, 'posted', 'INCOME_INTEREST_EARNED', 'USD rewards'],
    ])
    // Posted rows add up to the wallet's balance: 1,000 − 500 + 120 + 10 = 630.00.
    const posted = (of(ev, 'txn.upsert') as TxnUpsert[]).filter((t) => t.status === 'posted').reduce((s, t) => s + t.amount.minor, 0)
    expect(posted).toBe(630_00)
    // No crypto-side rows: they'd be not-money rounded to two decimals.
    expect((of(ev, 'txn.upsert') as TxnUpsert[]).every((t) => t.accountExternalId === 'acct-usd')).toBe(true)
  })

  it('the next cycle reads back a week before the last one began (and stops there), and re-reads the same ids', async () => {
    const m = make()
    const first = await runSync(m.connector, m.conn, null)
    const later = make()
    // Ten days on, the cursor's start is 2026-10-14: read back to 2026-10-07, so only the rows from 10-08 on again.
    const clock = fakeClock(NOW + 10 * 86_400_000)
    const c2 = createCoinbaseConnector({ deps: { raw: new MemoryRawSink(), fetch: later.ff.fetch, clock, random: () => 0.5 }, oauth: { clientId: 'cb_client_redacted', clientSecret: 'cb_secret_redacted', redirectUri: REDIRECT } })
    const conn = { ...later.conn, secret: { kind: 'oauth', tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: NOW + 20 * 86_400_000 } } }
    const second = await runSync(c2, conn, first.cursor)
    expect((of(second.events, 'txn.upsert') as TxnUpsert[]).map((t) => t.externalId)).toEqual(['tx-5', 'tx-6b', 'tx-6a', 'tx-4'])
    expect(later.ff.calls.filter((c) => c.url.includes('starting_after=tx-3'))).toEqual([])
  })

  it('an emptied wallet still gets its zero balance once it was seen', async () => {
    const m = make()
    const first = await runSync(m.connector, m.conn, null)
    const empty = { ...(fx.accounts['acct-btc'] as Record<string, unknown>) }
    const later = make({ extra: [{ match: (u) => u.pathname === '/v2/accounts' && u.searchParams.get('starting_after') === 'acct-btc', respond: { json: { ...empty, data: (empty.data as Array<Record<string, unknown>>).map((a) => (a.id === 'acct-eth' ? { ...a, balance: { amount: '0.00000000', currency: 'ETH' } } : a)) } } }] })
    const ev = (await runSync(later.connector, later.conn, first.cursor)).events
    const eth = (of(ev, 'balance.snapshot') as BalanceSnapshot[]).find((s) => s.accountExternalId === 'acct-eth')
    expect(eth?.holdings?.[0]).toMatchObject({ quantity: '0.00000000', value: { minor: 0, currency: 'USD' } })
  })

  it('no dollar rates: quantities still come in, without a dollar value, and the sync says so', async () => {
    const m = make({ rates: false })
    const r = await m.connector.sync(m.conn, null)
    const btc = (of(r.events, 'balance.snapshot') as BalanceSnapshot[]).find((s) => s.accountExternalId === 'acct-btc')
    expect(btc?.holdings?.[0]).toMatchObject({ quantity: '0.01530000', value: { minor: 0, currency: 'XXX' } })
    expect(r.warnings).toContain(COINBASE_NO_RATES_WARNING)
  })

  it('usdValue rounds to the cent and refuses a missing or zero rate', () => {
    expect(usdValue('1', '0.000016')).toBe(6_250_000)
    expect(usdValue('0.00000001', '0.000016')).toBe(0)
    expect(usdValue('1', undefined)).toBeUndefined()
    expect(usdValue('1', '0')).toBeUndefined()
  })
})

describe('coinbase: sign-in', () => {
  it('asks for read scopes only, comma-separated, with a refresh token', () => {
    const u = new URL(make().connector.authorizationUrl('state_12345678'))
    expect(u.origin + u.pathname).toBe('https://login.coinbase.com/oauth2/auth')
    expect(u.searchParams.get('scope')).toBe('wallet:accounts:read,wallet:transactions:read,offline_access')
    expect(u.searchParams.get('redirect_uri')).toBe(REDIRECT)
    expect(u.searchParams.get('state')).toBe('state_12345678')
  })

  it('exchanges the code (secret in the form) and checks it can read wallets', async () => {
    const m = make()
    const r = await m.connector.connect({ code: 'code_redacted', redirectUri: REDIRECT })
    expect(r.secret).toMatchObject({ kind: 'oauth', tokens: { accessToken: 'at_test_new', refreshToken: 'rt_test_new', expiresAt: NOW + 3_600_000 } })
    const tok = m.ff.calls.find((c) => c.url.includes('/oauth2/token'))
    expect(tok?.body).toMatchObject({ grant_type: 'authorization_code', code: 'code_redacted', client_id: 'cb_client_redacted', client_secret: 'cb_secret_redacted', redirect_uri: REDIRECT })
    expect(m.ff.calls.some((c) => c.url.includes('/v2/accounts?limit=1') && c.headers.authorization === 'Bearer at_test_new')).toBe(true)
  })

  it('refuses access granted without the transactions scope', async () => {
    const m = make({ extra: [{ match: (u) => u.pathname === '/oauth2/token', respond: { json: { ...(fx.token as object), scope: 'wallet:accounts:read offline_access' } } }] })
    await expect(m.connector.connect({ code: 'c', redirectUri: REDIRECT })).rejects.toMatchObject({ kind: 'invalid_input', forUser: true })
  })

  it('an expiring token is refreshed and the new pair saved before any read', async () => {
    const saved: unknown[] = []
    const m = make({ saved, secret: { kind: 'oauth', tokens: { accessToken: 'at_old', refreshToken: 'rt_old', expiresAt: NOW + 60_000 } } })
    const r = await m.connector.sync(m.conn, null)
    expect(saved).toEqual([{ kind: 'oauth', tokens: expect.objectContaining({ accessToken: 'at_test_2', refreshToken: 'rt_test_2' }) }])
    expect(r.updatedSecret).toEqual(saved[0])
    const first = m.ff.calls.findIndex((c) => c.url.includes('/v2/'))
    expect(m.ff.calls.findIndex((c) => c.url.includes('/oauth2/token'))).toBeLessThan(first)
    expect(m.ff.calls[first]?.headers.authorization).toBe('Bearer at_test_2')
  })

  it('a revoked token is a reconnect, not a retry loop; disconnect revokes at Coinbase', async () => {
    const m = make({ extra: [{ match: (u) => u.pathname.startsWith('/v2/accounts'), respond: { status: 401, json: fx.errors.revoked } }] })
    const err = await m.connector.sync(m.conn, null).catch((e: unknown) => e)
    expect(isConnectorError(err) && err.kind).toBe('auth')
    expect((await m.connector.health(m.conn)).status).toBe('needs_reauth')
    const d = make()
    await d.connector.disconnect?.(d.conn)
    expect(d.ff.calls.find((c) => c.url.includes('/oauth2/revoke'))?.body).toMatchObject({ token: 'rt_test_1', client_id: 'cb_client_redacted' })
  })

  it('errors: scope, rate limit, server', () => {
    expect(classifyCoinbaseError({ status: 403, headers: new Headers(), body: fx.errors.scope })).toMatchObject({ kind: 'auth', forUser: true })
    expect(classifyCoinbaseError({ status: 429, headers: new Headers({ 'retry-after': '30' }), body: fx.errors.rate })).toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 })
    expect(classifyCoinbaseError({ status: 502, headers: new Headers(), body: {} }).kind).toBe('transient')
  })
})

describe('coinbase: API keys (self-hosted)', () => {
  it('signs each request with a fresh Ed25519 JWT for that method, host and path', async () => {
    const k = edKey()
    const m = make({ oauth: false, secret: { kind: 'key', name: k.name, privateKey: k.privateKey } })
    await runSync(m.connector, m.conn, null)
    const call = m.ff.calls.find((c) => c.url.includes('/v2/accounts/acct-usd/transactions'))
    const jwt = (call?.headers.authorization ?? '').replace(/^Bearer /, '')
    const [h, p, s] = jwt.split('.') as [string, string, string]
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toMatchObject({ alg: 'EdDSA', kid: k.name, typ: 'JWT' })
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toEqual({ sub: k.name, iss: 'cdp', nbf: NOW / 1000, exp: NOW / 1000 + 120, uri: 'GET api.coinbase.com/v2/accounts/acct-usd/transactions' })
    expect(verify(null, Buffer.from(`${h}.${p}`), k.publicKey, Buffer.from(s, 'base64url'))).toBe(true)
  })

  it('an ECDSA key (EC PRIVATE KEY PEM) signs ES256 with a raw 64-byte signature', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const pem = privateKey.export({ format: 'pem', type: 'sec1' }).toString()
    const name = 'organizations/org-redacted/apiKeys/key-redacted'
    const jwt = coinbaseJwt({ name, privateKey: pem.replace(/\n/g, '\\n') }, 'GET', 'api.coinbase.com', '/v2/accounts?limit=1', NOW)
    const [h, p, s] = jwt.split('.') as [string, string, string]
    expect(JSON.parse(Buffer.from(h, 'base64url').toString()).alg).toBe('ES256')
    expect(JSON.parse(Buffer.from(p, 'base64url').toString()).uri).toBe('GET api.coinbase.com/v2/accounts')
    expect(Buffer.from(s, 'base64url').length).toBe(64)
    expect(verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))).toBe(true)
  })

  it('a View-only key connects; one that can trade is refused; garbage is a plain message', async () => {
    const k = edKey()
    const ok = await make({ oauth: false }).connector.connect({ keyName: k.name, privateKey: k.privateKey })
    expect(ok.secret).toEqual({ kind: 'key', name: k.name, privateKey: k.privateKey })
    await expect(make({ oauth: false, perms: 'trade' }).connector.connect({ keyName: k.name, privateKey: k.privateKey })).rejects.toMatchObject({ kind: 'invalid_input', message: COINBASE_KEY_TOO_STRONG })
    await expect(make({ oauth: false }).connector.connect({ keyName: k.name, privateKey: 'not a key' })).rejects.toMatchObject({ kind: 'invalid_input', forUser: true })
    expect(() => loadCoinbaseKey('-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----')).toThrow(/Coinbase API key/)
  })

  it('hosted: no key form and no pasted key, sign-in only', async () => {
    const k = edKey()
    const h = make({ oauth: false, hosted: true })
    await expect(h.connector.begin({ workspaceId: 'ws', redirectUri: REDIRECT, state: 's', userRef: 'u' })).rejects.toMatchObject({ message: COINBASE_KEY_REFUSED_HOSTED })
    await expect(h.connector.connect({ keyName: k.name, privateKey: k.privateKey })).rejects.toMatchObject({ message: COINBASE_KEY_REFUSED_HOSTED })
    expect((await make({ hosted: true }).connector.begin({ workspaceId: 'ws', redirectUri: REDIRECT, state: 's', userRef: 'u' })).kind).toBe('oauth')
  })
})
