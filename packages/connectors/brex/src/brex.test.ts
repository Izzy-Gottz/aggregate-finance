import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AccountUpsert, BalanceSnapshot, ConnectionRef, NormalizedEvent, TxnUpsert } from '@agfn/contracts'
import { MemoryRawSink, hmac, runSync } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { BREX_NO_CASH_WARNING, createBrexConnector, mapCardBalance, interpretBrexWebhook, verifyBrexWebhook, type BrexConnectorOptions } from './index.ts'

type Page = { next_cursor: string | null; items: unknown[] }
const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/business.json', import.meta.url), 'utf8')) as {
  card_accounts: unknown[]
  cash_accounts: Page
  cash_txns: Record<string, Record<string, Page>>
  card_txns: Record<string, Page>
}

const conn: ConnectionRef = { id: 'conn_brex', workspaceId: 'ws1', connectorKey: 'brex', secret: { token: 'bxt_test_token' }, config: { cash: true } }
const notFound = { status: 400, json: { type: 'BAD_REQUEST', message: 'bad cursor' } }

function routes(extra: FixtureRoute[] = []): FixtureRoute[] {
  return [
    ...extra,
    { match: (u) => u.pathname === '/v2/accounts/card', respond: { json: fx.card_accounts } },
    { match: (u) => u.pathname === '/v2/accounts/cash', respond: { json: fx.cash_accounts } },
    {
      match: (u) => u.pathname.startsWith('/v2/transactions/cash/'),
      respond: (u) => {
        const id = decodeURIComponent(u.pathname.split('/').pop() ?? '')
        const page = fx.cash_txns[id]?.[u.searchParams.get('cursor') ?? '']
        return page ? { json: page } : notFound
      },
    },
    {
      match: (u) => u.pathname === '/v2/transactions/card/primary',
      respond: (u) => {
        const page = fx.card_txns[u.searchParams.get('cursor') ?? '']
        return page ? { json: page } : notFound
      },
    },
  ]
}

function make(extra: FixtureRoute[] = [], opts: BrexConnectorOptions = {}) {
  const f = fixtureFetch(routes(extra))
  const clock = fakeClock()
  const saved: unknown[] = []
  const connector = createBrexConnector(opts, { raw: new MemoryRawSink(), fetch: f.fetch, clock, saveSecret: async (_id, sec) => void saved.push(sec) })
  return { connector, conn, calls: f.calls, clock, saved }
}

const txn = (events: NormalizedEvent[], id: string) => events.find((e): e is TxnUpsert => e.type === 'txn.upsert' && e.externalId === id)

describe('brex contract', () => {
  it('passes the connector contract', async () => {
    const r = await runConnectorContract({
      make: () => make(),
      signs: { cttx_purchase: '-', cttx_refund: '+', cttx_collection: '+', ctx_card_payment: '-', ctx_customer_ach: '+', ctx_book_out: '-', ctx_book_in: '+' },
      minEvents: 15,
    })
    // accounts, operating ×2, reserve, card ×2
    expect(r.pages).toBe(6)
  })

  it('fixture is redacted', () => assertRedacted(fx))
})

describe('brex mapping', () => {
  it('maps accounts and balances (card owed is negative)', async () => {
    const { connector, calls } = make()
    const { events } = await runSync(connector, conn, null)
    const acct = (id: string) => events.find((e): e is AccountUpsert => e.type === 'account.upsert' && e.externalId === id)
    expect(acct('cuacc_card_1')).toMatchObject({ accountType: 'credit_card', name: 'Brex Card', currency: 'USD', institution: 'Brex' })
    expect(acct('dpacc_operating')).toMatchObject({ accountType: 'depository', name: 'Operating', mask: '6789' })
    const bal = (id: string) => events.find((e): e is BalanceSnapshot => e.type === 'balance.snapshot' && e.accountExternalId === id)
    expect(bal('cuacc_card_1')).toMatchObject({ current: { minor: -452050, currency: 'USD' }, externalId: 'cuacc_card_1@2026-10-09' })
    expect(bal('cuacc_card_1')?.available).toBeUndefined()
    expect(bal('dpacc_operating')).toMatchObject({ current: { minor: 12500000 }, available: { minor: 12400000 } })
    expect(calls.every((c) => c.headers.authorization === 'Bearer bxt_test_token')).toBe(true)
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
    // first sync: full history, no posted_at_start
    expect(calls.some((c) => c.url.includes('posted_at_start'))).toBe(false)
    expect(calls.find((c) => c.url.includes('/card/primary'))?.url).toContain('expand%5B%5D=expense_id')
  })

  it('a card balance is owed whichever way Brex signs it (its docs only say "signed")', () => {
    const acct = (amount: number) => ({ id: 'cuacc_x', status: 'ACTIVE', current_balance: { amount, currency: 'USD' } }) as never
    for (const amount of [452050, -452050]) expect(mapCardBalance(acct(amount), 'c', 'r', '2026-10-09T00:00:00Z')?.current).toEqual({ minor: -452050, currency: 'USD' })
    expect(mapCardBalance(acct(0), 'c', 'r', '2026-10-09T00:00:00Z')?.current.minor).toBe(0)
  })

  it('maps card and cash transactions with golden values', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    expect(txn(events, 'cttx_purchase')).toMatchObject({
      accountExternalId: 'cuacc_card_1', amount: { minor: -12900, currency: 'USD' }, status: 'posted', date: '2026-10-03',
      counterparty: 'CHILIS', rawText: 'CHILIS #123 SAN FRANCISCO CA', categoryHint: 'PURCHASE:mcc_5812', linkRefs: { expense_id: 'expense_1', card_id: 'card_ab12' },
    })
    expect(txn(events, 'cttx_refund')?.amount.minor).toBe(2500)
    expect(txn(events, 'cttx_collection')).toMatchObject({ amount: { minor: 100000 }, categoryHint: 'card_payment' })
    expect(txn(events, 'cttx_collection')?.counterparty).toBeUndefined()
    expect(txn(events, 'cttx_rewards')?.amount.minor).toBe(500)
    expect(txn(events, 'ctx_card_payment')).toMatchObject({ accountExternalId: 'dpacc_operating', amount: { minor: -100000 }, categoryHint: 'card_payment' })
    expect(txn(events, 'ctx_customer_ach')).toMatchObject({ amount: { minor: 500000 }, linkRefs: { brex_transfer_id: 'dptx_incoming_1' } })
    // Both legs of an internal book transfer share linkRefs.transfer.
    expect(txn(events, 'ctx_book_out')?.linkRefs).toEqual({ transfer: 'dptx_book_1' })
    expect(txn(events, 'ctx_book_in')).toMatchObject({ accountExternalId: 'dpacc_reserve', amount: { minor: 200000 }, linkRefs: { transfer: 'dptx_book_1' } })
  })

  it('next cycle is incremental with a 3-day overlap', async () => {
    const { connector, calls } = make()
    const first = await runSync(connector, conn, null)
    const n = calls.length
    const second = await runSync(connector, conn, first.cursor)
    expect(second.complete).toBe(true)
    const later = calls.slice(n).filter((c) => c.url.includes('/v2/transactions/'))
    expect(later.length).toBeGreaterThan(0)
    expect(later.every((c) => new URL(c.url).searchParams.get('posted_at_start') === '2026-10-06T00:00:00Z')).toBe(true)
  })

  it('card-only customers: no cash access is skipped, with a connect warning', async () => {
    const noCash: FixtureRoute = { match: (u) => u.pathname === '/v2/accounts/cash', respond: { status: 403, json: { type: 'FORBIDDEN', message: 'Must be cash admin, bookkeeper or user.' } } }
    const { connector } = make([noCash])
    const out = await connector.connect({ apiKey: 'bxt_x' })
    expect(out.config).toMatchObject({ cash: false, cardAccountId: 'cuacc_card_1', warnings: [expect.stringContaining('Brex Cash')] })
    const r = await runSync(connector, { ...conn, config: { cash: true } }, null)
    expect(r.events.some((e) => e.type === 'account.upsert' && e.externalId === 'dpacc_operating')).toBe(false)
    expect(txn(r.events, 'cttx_purchase')).toBeDefined()
  })

  it('card-only token: the accounts page warns, every cycle', async () => {
    const noCash: FixtureRoute = { match: (u) => u.pathname === '/v2/accounts/cash', respond: { status: 403, json: { type: 'FORBIDDEN', message: 'Must be cash admin, bookkeeper or user.' } } }
    const drain = async (connector: ReturnType<typeof make>['connector'], c: ConnectionRef) => {
      const out: Array<string[] | undefined> = []
      let cursor: string | null = null
      for (;;) {
        const r = await connector.sync(c, cursor)
        out.push(r.warnings)
        cursor = r.cursor
        if (!r.hasMore) break
      }
      return out
    }
    // Cash denied at sync time.
    const denied = await drain(make([noCash]).connector, conn)
    expect(denied[0]).toEqual([BREX_NO_CASH_WARNING])
    expect(denied.filter(Boolean)).toHaveLength(1)
    // Known at connect (config.cash = false).
    expect((await drain(make().connector, { ...conn, config: { cash: false } }))[0]).toEqual([BREX_NO_CASH_WARNING])
    // Cash readable: no warnings.
    expect((await drain(make().connector, conn)).every((w) => w === undefined)).toBe(true)
  })
})

describe('brex cash access', () => {
  const forbidden = (message: string) => ({ status: 403, json: { type: 'FORBIDDEN', message } })

  it('any 403 on the cash accounts list means card-only, whatever the wording', async () => {
    const { connector } = make([{ match: (u) => u.pathname === '/v2/accounts/cash', respond: forbidden('Access denied') }])
    expect((await connector.connect({ apiKey: 'bxt_x' })).config).toMatchObject({ cash: false })
    const first = await connector.sync(conn, null)
    expect(first.warnings).toEqual([BREX_NO_CASH_WARNING])
    const r = await runSync(connector, conn, null)
    expect(r.complete).toBe(true)
    expect(txn(r.events, 'cttx_purchase')).toBeDefined()
  })

  it('a 403 on cash transactions skips cash with a warning and still syncs the card', async () => {
    const { connector, calls } = make([{ match: (u) => u.pathname.startsWith('/v2/transactions/cash/'), respond: forbidden('Access denied') }])
    const warnings: string[] = []
    const events: NormalizedEvent[] = []
    let cursor: string | null = null
    for (;;) {
      const r = await connector.sync(conn, cursor)
      warnings.push(...(r.warnings ?? []))
      events.push(...r.events)
      cursor = r.cursor
      if (!r.hasMore) break
    }
    expect(warnings).toEqual([BREX_NO_CASH_WARNING])
    // One refused call, not one per cash account.
    expect(calls.filter((c) => c.url.includes('/v2/transactions/cash/'))).toHaveLength(1)
    expect(txn(events, 'cttx_purchase')).toBeDefined()
    expect(events.some((e) => e.type === 'account.upsert' && e.externalId === 'dpacc_operating')).toBe(true)
  })

  it('a 401 on cash is a real auth failure, not card-only', async () => {
    const { connector } = make([{ match: (u) => u.pathname === '/v2/accounts/cash', respond: { status: 401, json: { type: 'UNAUTHORIZED', message: 'Must be cash admin, bookkeeper or user.' } } }])
    await expect(connector.sync(conn, null)).rejects.toMatchObject({ kind: 'auth' })
  })
})

describe('brex errors', () => {
  it('401 is auth, not retried, and health explains the 90-day expiry', async () => {
    const bad: FixtureRoute = { match: () => true, respond: { status: 401, json: { type: 'UNAUTHORIZED', message: 'PERMISSION_DENIED: Invalid or Revoked Token' } } }
    const { connector, calls } = make([bad])
    await expect(runSync(connector, conn, null)).rejects.toMatchObject({ kind: 'auth' })
    expect(calls).toHaveLength(1)
    const h = await connector.health(conn)
    expect(h.status).toBe('needs_reauth')
    expect(h.message).toMatch(/90 days/)
  })

  it('403 Expired token is auth', async () => {
    const { connector } = make([{ match: () => true, respond: { status: 403, json: { type: 'FORBIDDEN', message: 'Expired token' } } }])
    expect(await connector.health(conn)).toMatchObject({ status: 'needs_reauth', message: expect.stringMatching(/90 days/) })
  })

  it('429 with Retry-After is retried', async () => {
    let n = 0
    const { connector, clock } = make([{ match: (u) => u.pathname === '/v2/accounts/card' && n++ === 0, respond: { status: 429, headers: { 'retry-after': '2' }, json: { message: 'slow' } } }])
    const r = await runSync(connector, conn, null, { maxPages: 1 })
    expect(r.events.length).toBeGreaterThan(0)
    expect(clock.sleeps).toContain(2000)
    expect(await make().connector.health(conn)).toEqual({ status: 'ok' })
  })

  it('malformed secret is auth; connect validates input', async () => {
    const { connector } = make()
    await expect(connector.sync({ ...conn, secret: { nope: 1 } }, null)).rejects.toMatchObject({ kind: 'auth' })
    await expect(connector.connect({})).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(connector.connect({ apiKey: 'bxt has spaces' })).rejects.toMatchObject({ kind: 'invalid_input' })
    const ok = await connector.connect({ apiKey: ' bxt_good ' })
    expect(ok).toEqual({ secret: { token: 'bxt_good' }, config: { cash: true, cardAccountId: 'cuacc_card_1' } })
  })

  it('begin asks for an api key', async () => {
    expect(await make().connector.begin()).toMatchObject({ kind: 'api_key', helpUrl: expect.stringContaining('brex.com'), placeholder: 'bxt_...' })
  })

  it('describe', () => {
    expect(make().connector.describe()).toMatchObject({ key: 'brex', group: 'spend', auth: 'api_key' })
  })
})

describe('brex webhooks', () => {
  const secret = Buffer.from('brex-webhook-test-secret').toString('base64')
  const body = JSON.stringify({ event_type: 'TRANSFER_PROCESSED', company_id: 'cuco_1', transfer_id: 'dptx_book_1' })
  const now = Math.floor(Date.parse('2026-10-09T12:00:00Z') / 1000)
  const sign = (id: string, ts: number, b: string, key = secret) =>
    hmac('sha256', Buffer.from(key, 'base64'), `${id}.${ts}.${b}`).toString('base64')
  const headers = (ts = now, b = body, key = secret) => ({ 'webhook-id': 'msg_1', 'webhook-timestamp': String(ts), 'webhook-signature': `v1,${sign('msg_1', ts, b, key)}` })

  it('accepts a valid signature, including during rotation', async () => {
    const { connector } = make([], { webhookSecrets: [Buffer.from('old').toString('base64'), `whsec_${secret}`] })
    await expect(connector.webhook!.verify({ headers: headers(), body })).resolves.toBeUndefined()
    const multi = { ...headers(), 'webhook-signature': `v1,AAAA ${headers()['webhook-signature']}` }
    await expect(connector.webhook!.verify({ headers: multi, body })).resolves.toBeUndefined()
  })

  it('rejects tampered, stale and unsigned', () => {
    const clock = fakeClock()
    expect(() => verifyBrexWebhook({ headers: headers(), body: body.replace('cuco_1', 'cuco_2') }, [secret], clock)).toThrow(/signature/)
    expect(() => verifyBrexWebhook({ headers: headers(now - 600), body }, [secret], clock)).toThrow(/tolerance/)
    expect(() => verifyBrexWebhook({ headers: {}, body }, [secret], clock)).toThrow(/missing/)
    expect(() => verifyBrexWebhook({ headers: headers(now, body, Buffer.from('wrong').toString('base64')), body }, [secret], clock)).toThrow(/signature/)
  })

  it('no webhook without secrets; interprets events', () => {
    expect(make().connector.webhook).toBeUndefined()
    expect(interpretBrexWebhook({ headers: { 'webhook-id': 'msg_1' }, body })).toEqual({ action: 'sync', dedupeKey: 'brex:msg_1', reason: 'TRANSFER_PROCESSED', match: { field: 'companyId', value: 'cuco_1' } })
    expect(interpretBrexWebhook({ headers: {}, body: JSON.stringify({ event_type: 'USER_UPDATED' }) }).action).toBe('ignore')
    expect(interpretBrexWebhook({ headers: {}, body: 'nope' }).action).toBe('ignore')
  })
})

describe('brex partner sign-in (OAuth)', () => {
  const oauthOpts: BrexConnectorOptions = { oauthClientId: 'brex_client_1', oauthClientSecret: 'brex_csecret_1', oauthBase: 'https://accounts-api.staging.brexapps.com/oauth2/default' }
  const ctx = { workspaceId: 'ws1', redirectUri: 'https://app.example/api/connectors/brex/callback', state: 'state-123456789', userRef: 'p1' }
  const tokenRoute = (json: unknown): FixtureRoute => ({ method: 'POST', match: (u) => u.pathname.endsWith('/v1/token'), respond: { json } })

  it('without client credentials it stays a pasted token', async () => {
    const { connector } = make()
    expect(connector.describe().auth).toBe('api_key')
    expect(await connector.begin(ctx)).toMatchObject({ kind: 'api_key' })
  })

  it('begin sends people to Brex with read-only scopes', async () => {
    const { connector } = make([], oauthOpts)
    expect(connector.describe().auth).toBe('oauth')
    const b = await connector.begin(ctx)
    expect(b.kind).toBe('oauth')
    const u = new URL(b.kind === 'oauth' ? b.url : '')
    expect(u.origin + u.pathname).toBe('https://accounts-api.staging.brexapps.com/oauth2/default/v1/authorize')
    expect(u.searchParams.get('state')).toBe('state-123456789')
    expect(u.searchParams.get('redirect_uri')).toBe(ctx.redirectUri)
    expect(u.searchParams.get('scope')?.split(' ')).toEqual(['openid', 'offline_access', 'accounts.card.readonly', 'accounts.cash.readonly', 'transactions.card.readonly', 'transactions.cash.readonly'])
    expect(u.searchParams.get('scope')).not.toMatch(/(?<!\.readonly)\b(cards|transfers)\b/)
  })

  it('connect exchanges the code; sync refreshes an expiring token and returns the rotated secret', async () => {
    const { connector, calls, clock } = make([tokenRoute({ access_token: 'at_1', refresh_token: 'rt_1', expires_in: 3600, token_type: 'bearer' })], oauthOpts)
    const r = await connector.connect({ code: 'code_1', redirectUri: ctx.redirectUri })
    expect(r.secret).toEqual({ token: 'at_1', kind: 'oauth', refreshToken: 'rt_1', expiresAt: clock.now() + 3_600_000 })
    const tokenCall = calls.find((c) => c.url.endsWith('/v1/token'))
    expect(tokenCall?.body).toMatchObject({ grant_type: 'authorization_code' })
    expect(tokenCall?.body).toMatchObject({ client_secret: 'brex_csecret_1' })
    expect(calls.find((c) => c.url.includes('/v2/accounts/card'))?.headers.authorization).toBe('Bearer at_1')

    // Still fresh: no refresh, no updatedSecret.
    const oauthConn: ConnectionRef = { ...conn, secret: r.secret }
    const p1 = await connector.sync(oauthConn, null)
    expect(p1.updatedSecret).toBeUndefined()

    clock.t += 3_600_000 - 60_000
    const f2 = make([tokenRoute({ access_token: 'at_2', refresh_token: 'rt_2', expires_in: 3600 })], oauthOpts)
    f2.clock.t = clock.t
    const p2 = await f2.connector.sync(oauthConn, null)
    expect(p2.updatedSecret).toEqual({ token: 'at_2', kind: 'oauth', refreshToken: 'rt_2', expiresAt: clock.t + 3_600_000 })
    expect(f2.calls[0]?.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt_1' })
    expect(f2.calls.find((c) => c.url.includes('/v2/accounts/card'))?.headers.authorization).toBe('Bearer at_2')
  })

  it('disconnect revokes sign-in tokens only, form-encoded with a type hint', async () => {
    const { connector, calls } = make([{ method: 'POST', match: (u) => u.pathname.endsWith('/v1/revoke'), respond: { status: 200, json: {} } }], oauthOpts)
    expect(await connector.revoke({ ...conn, secret: { token: 'at_1', kind: 'oauth', refreshToken: 'rt_1', expiresAt: 0 } })).toEqual({ revoked: true, failures: [] })
    const revokes = calls.filter((c) => c.url.endsWith('/v1/revoke'))
    expect(revokes.map((c) => c.headers['content-type'])).toEqual(['application/x-www-form-urlencoded', 'application/x-www-form-urlencoded'])
    expect(revokes[0]?.body).toEqual({ token: 'rt_1', token_type_hint: 'refresh_token', client_id: 'brex_client_1', client_secret: 'brex_csecret_1' })
    expect(revokes[1]?.body).toMatchObject({ token: 'at_1', token_type_hint: 'access_token' })
    expect(await connector.revoke(conn)).toEqual({ revoked: false, failures: [] })
    expect(calls.filter((c) => c.url.endsWith('/v1/revoke'))).toHaveLength(2)
  })

  it('disconnect tells the person to delete a pasted token at Brex', async () => {
    const { connector, calls } = make([], oauthOpts)
    await expect(connector.disconnect!(conn)).resolves.toEqual({ notRevoked: expect.stringContaining('Delete the token') })
    expect(calls.filter((c) => c.url.endsWith('/v1/revoke'))).toHaveLength(0)
  })

  it('a refused or unreachable revoke is recorded and logged, never thrown', async () => {
    const f = fixtureFetch([{ method: 'POST', match: (u) => u.pathname.endsWith('/v1/revoke'), respond: { status: 401, json: { error: 'invalid_client' } } }])
    const logs: Array<[string, Record<string, unknown> | undefined]> = []
    const deps = { raw: new MemoryRawSink(), fetch: f.fetch, clock: fakeClock(), log: (m: string, fields?: Record<string, unknown>) => logs.push([m, fields]) }
    const connector = createBrexConnector(oauthOpts, deps)
    const sec = { token: 'at_1', kind: 'oauth', refreshToken: 'rt_1', expiresAt: 0 }
    expect(await connector.revoke({ ...conn, secret: sec })).toEqual({ revoked: false, failures: ['refresh_token HTTP 401', 'access_token HTTP 401'] })
    expect(logs).toEqual([['brex revoke failed', { connectionId: 'conn_brex', failures: ['refresh_token HTTP 401', 'access_token HTTP 401'] }]])
    // Network failure, no logger: still resolves.
    const down = createBrexConnector(oauthOpts, { raw: new MemoryRawSink(), fetch: async () => { throw new TypeError('fetch failed') }, clock: fakeClock() })
    expect(await down.revoke({ ...conn, secret: sec })).toEqual({ revoked: false, failures: ['refresh_token network error', 'access_token network error'] })
    // disconnect never throws, so the engine always goes on to wipe the secret, and it says what to finish at Brex.
    await expect(connector.disconnect!({ ...conn, secret: sec })).resolves.toEqual({ notRevoked: expect.stringContaining('Developer page') })
    await expect(down.disconnect!({ ...conn, secret: sec })).resolves.toEqual({ notRevoked: expect.stringContaining('Developer page') })
  })

  it('keeps the rotated refresh token: the next refresh sends the new one', async () => {
    const f = make([tokenRoute({ access_token: 'at_2', refresh_token: 'rt_2', expires_in: 3600 })], oauthOpts)
    const p1 = await f.connector.sync({ ...conn, secret: { token: 'at_1', kind: 'oauth', refreshToken: 'rt_1', expiresAt: f.clock.now() } }, null)
    expect(p1.updatedSecret).toMatchObject({ refreshToken: 'rt_2' })
    f.clock.t += 3_600_000
    const g = make([tokenRoute({ access_token: 'at_3', refresh_token: 'rt_3', expires_in: 3600 })], oauthOpts)
    g.clock.t = f.clock.t
    const p2 = await g.connector.sync({ ...conn, secret: p1.updatedSecret }, null)
    expect(g.calls[0]?.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt_2' })
    expect(p2.updatedSecret).toMatchObject({ token: 'at_3', refreshToken: 'rt_3' })
    // A refresh response without a new refresh token keeps the current one.
    const h = make([tokenRoute({ access_token: 'at_4', expires_in: 3600 })], oauthOpts)
    h.clock.t = g.clock.t + 3_600_000
    const p3 = await h.connector.sync({ ...conn, secret: { ...(p2.updatedSecret as object), expiresAt: h.clock.t } }, null)
    expect(p3.updatedSecret).toMatchObject({ token: 'at_4', refreshToken: 'rt_3' })
  })

  it('saves a rotated refresh token before the first page, and health never refreshes', async () => {
    const f = make([tokenRoute({ access_token: 'at_2', refresh_token: 'rt_2', expires_in: 3600 }), { match: (u) => u.pathname.includes('/v2/accounts'), respond: { status: 500, json: {} } }], oauthOpts)
    const expiring = { ...conn, secret: { token: 'at_1', kind: 'oauth', refreshToken: 'rt_1', expiresAt: f.clock.now() } }
    await expect(f.connector.sync(expiring, null)).rejects.toBeTruthy()
    expect(f.saved).toEqual([expect.objectContaining({ token: 'at_2', refreshToken: 'rt_2' })])
    const g = make([tokenRoute({ access_token: 'at_3', refresh_token: 'rt_3', expires_in: 3600 })], oauthOpts)
    expect(await g.connector.health({ ...conn, secret: { token: 'at_1', kind: 'oauth', refreshToken: 'rt_1', expiresAt: g.clock.now() - 1 } })).toMatchObject({ status: 'ok', message: expect.stringMatching(/next sync/) })
    expect(g.calls).toHaveLength(0)
    expect(g.saved).toHaveLength(0)
  })
})
