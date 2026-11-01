import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AccountUpsert, BalanceSnapshot, ConnectionRef, NormalizedEvent, TxnUpsert } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, assertValidEvents, fakeClock, fixtureFetch, runConnectorContract, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { accountType, categoryHint, isPaymentRail, mapAccount, mapTxn, plainName, plaidCurrency, railPerson } from './map.ts'
import { PlaidWebhookVerifier, classifyPlaidError, createPlaidConnector, findDuplicatePlaidItem, interpretPlaidWebhook, type PlaidConnectorOptions } from './index.ts'

const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/sandbox-item.json', import.meta.url), 'utf8')) as {
  exchange: unknown
  item_get: unknown
  accounts_get: unknown
  liabilities_get: unknown
  holdings_get: unknown
  inv_txns: unknown
  sync_pages: Record<string, unknown>
}

/** Serves /investments/transactions/get like Plaid: filtered by the date window, paged by offset/count. */
function invResponder(data: unknown) {
  const all = data as { investment_transactions: Array<{ date: string }>; [k: string]: unknown }
  return (_u: URL, body: unknown) => {
    const b = body as { start_date: string; end_date: string; options?: { count?: number; offset?: number } }
    const rows = all.investment_transactions.filter((t) => t.date >= b.start_date && t.date <= b.end_date)
    const off = b.options?.offset ?? 0
    const n = b.options?.count ?? 100
    return { json: { ...all, investment_transactions: rows.slice(off, off + n), total_investment_transactions: rows.length } }
  }
}

const OPTS: PlaidConnectorOptions = { clientId: 'cid', secret: 'test-secret', env: 'sandbox', webhookUrl: 'https://meridn.example.com/webhooks/plaid' }
const conn: ConnectionRef = {
  id: 'conn_plaid',
  workspaceId: 'ws1',
  connectorKey: 'plaid',
  secret: { accessToken: 'access-sandbox-redacted-1', itemId: 'item_SANDBOX_1' },
  config: { itemId: 'item_SANDBOX_1', institution: 'First Platypus Bank', products: ['liabilities', 'investments'] },
}

function routes(extra: FixtureRoute[] = []): FixtureRoute[] {
  return [
    ...extra,
    { match: '/accounts/get', respond: { json: fx.accounts_get } },
    { match: '/liabilities/get', respond: { json: fx.liabilities_get } },
    { match: '/investments/holdings/get', respond: { json: fx.holdings_get } },
    { match: '/investments/transactions/get', respond: invResponder(fx.inv_txns) },
    { match: '/item/public_token/exchange', respond: { json: fx.exchange } },
    { match: '/item/get', respond: { json: fx.item_get } },
    {
      match: '/transactions/sync',
      respond: (_u, body) => {
        const page = fx.sync_pages[String((body as { cursor?: string }).cursor ?? '')]
        return page ? { json: page } : { status: 400, json: { error_type: 'INVALID_INPUT', error_code: 'INVALID_FIELD', error_message: 'bad cursor' } }
      },
    },
  ]
}

function make(extra: FixtureRoute[] = []) {
  const f = fixtureFetch(routes(extra))
  const raw = new MemoryRawSink()
  const connector = createPlaidConnector(OPTS, { raw, fetch: f.fetch, clock: fakeClock() })
  return { connector, conn, calls: f.calls, raw }
}

const byId = <T extends NormalizedEvent>(events: NormalizedEvent[], type: T['type'], id: string) =>
  events.find((e) => e.type === type && e.externalId === id) as T | undefined

// Plaid bills these per call (Balance $0.10, Transactions Refresh $0.12, Investments Refresh $0.12) or as an extra
// per-Item subscription we don't offer (Recurring Transactions). docs/costs.md assumes we call none of them.
const PER_CALL_ENDPOINTS = ['/transactions/refresh', '/investments/refresh', '/transactions/recurring/get']

describe('plaid billing guard', () => {
  it('the connector source never names a per-call or unsubscribed endpoint', () => {
    const dir = new URL('./', import.meta.url)
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      const src = readFileSync(new URL(f, dir), 'utf8')
      for (const p of PER_CALL_ENDPOINTS) expect(src.includes(p), `${f} mentions ${p}`).toBe(false)
    }
  })

  it('a sync never calls the billed live-balance endpoint (only refreshBalances does, on request)', async () => {
    const { connector, calls } = make()
    await runSync(connector, conn, null)
    expect(calls.some((c) => c.url.endsWith('/accounts/balance/get'))).toBe(false)
    const src = readFileSync(new URL('./connector.ts', import.meta.url), 'utf8')
    expect(src.split("'/accounts/balance/get'").length - 1).toBe(1)
  })
})

describe('plaid contract', () => {
  it('passes the connector contract on the sandbox fixture', async () => {
    const report = await runConnectorContract({
      make: () => make(),
      signs: { tx_united: '-', tx_payroll: '+', tx_card_payment: '-', tx_card_payment_in: '+', tx_check: '-', tx_eur: '-' },
      minEvents: 18,
    })
    // accounts, the whole transactions/sync loop, investment transactions
    expect(report.pages).toBe(3)
  })

  it('fixture is redacted', () => {
    assertRedacted(fx, [/^access-sandbox/])
  })
})

describe('plaid mapping', () => {
  it('maps accounts, balances, liabilities and holdings', async () => {
    const { connector, calls } = make()
    const { events } = await runSync(connector, conn, null)

    const checking = byId<AccountUpsert>(events, 'account.upsert', 'acc_checking')
    expect(checking).toMatchObject({ accountType: 'depository', currency: 'USD', mask: '0000', institution: 'First Platypus Bank', businessHint: 'business' })
    expect(byId<AccountUpsert>(events, 'account.upsert', 'acc_card')?.businessHint).toBe('personal')
    expect(byId<AccountUpsert>(events, 'account.upsert', 'acc_saving')?.businessHint).toBe('unknown')

    const bal = (id: string) => events.find((e): e is BalanceSnapshot => e.type === 'balance.snapshot' && e.accountExternalId === id)
    expect(bal('acc_checking')).toMatchObject({ current: { minor: 11000 }, available: { minor: 10000 }, at: '2026-10-09T12:00:00.000Z', externalId: 'acc_checking@2026-10-09' })
    // Liabilities are money owed: negative, and no "available".
    expect(bal('acc_card')?.current.minor).toBe(-41000)
    expect(bal('acc_card')?.available).toBeUndefined()
    expect(bal('acc_mortgage')?.current.minor).toBe(-5630206)
    expect(bal('acc_401k')?.current.minor).toBe(2363198)
    expect(bal('acc_eur')).toBeUndefined()

    expect(byId<AccountUpsert>(events, 'account.upsert', 'acc_card')?.liability).toEqual({
      kind: 'credit',
      nextPaymentDueDate: '2026-10-24',
      minimumPayment: { minor: 2000, currency: 'USD' },
      lastStatementBalance: { minor: 170877, currency: 'USD' },
      lastStatementDate: '2026-09-28',
      lastPaymentAmount: { minor: 16825, currency: 'USD' },
      lastPaymentDate: '2026-09-22',
      apr: '27.95',
    })
    expect(byId<AccountUpsert>(events, 'account.upsert', 'acc_mortgage')?.liability).toMatchObject({
      kind: 'mortgage', apr: '3.99', originationPrincipal: { minor: 42500000 }, maturityDate: '2045-07-31',
    })
    expect(bal('acc_401k')?.holdings).toEqual([
      { securityExternalId: 'sec_cash', ticker: 'CUR:USD', name: 'U S Dollar', quantity: '11568.9655', value: { minor: 1156897, currency: 'USD' } },
      { securityExternalId: 'sec_vtsax', ticker: 'VTSAX', name: 'Vanguard Total Stock Market Index Fund', quantity: '100.5', value: { minor: 1206302, currency: 'USD' }, costBasis: { minor: 1000000, currency: 'USD' } },
    ])

    // Never call billed-per-call or money-moving endpoints.
    const paths = calls.map((c) => new URL(c.url).pathname)
    for (const billedPerCall of PER_CALL_ENDPOINTS) expect(paths).not.toContain(billedPerCall)
    expect(calls.every((c) => (c.body as { secret?: string }).secret === 'test-secret')).toBe(true)
  })

  it('maps transactions: sign flip, refs, categories, untrusted text, rounding', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    const t = (id: string) => byId<TxnUpsert>(events, 'txn.upsert', id)
    expect(t('tx_united')).toMatchObject({ amount: { minor: -50000, currency: 'USD' }, status: 'posted', counterparty: 'United Airlines', rawText: 'UNITED AIRLINES 0162345 CHICAGO IL', categoryHint: 'TRAVEL_FLIGHTS', date: '2026-09-30' })
    expect(t('tx_payroll')).toMatchObject({ amount: { minor: 250000 }, counterparty: 'Acme Payroll', linkRefs: { reference_number: 'REF123', ppd_id: 'PPD9' } })
    expect(t('tx_uber_pending')).toMatchObject({ status: 'pending', amount: { minor: -633 } })
    expect(t('tx_check')).toMatchObject({ amount: { minor: -100001 }, linkRefs: { check_number: '201' } })
    expect(t('tx_eur')?.amount).toEqual({ minor: -1250, currency: 'EUR' })
  })

  it('incremental cycle: pending→posted link, modification, removal as void', async () => {
    const { connector } = make()
    const first = await runSync(connector, conn, null)
    const second = await runSync(connector, conn, first.cursor)
    expect(second.complete).toBe(true)
    // A new cycle refreshes balances first.
    expect(second.events.some((e) => e.type === 'balance.snapshot')).toBe(true)
    const posted = byId<TxnUpsert>(second.events, 'txn.upsert', 'tx_uber_posted')
    expect(posted).toMatchObject({ status: 'posted', pendingExternalId: 'tx_uber_pending', amount: { minor: -633 } })
    expect(byId<TxnUpsert>(second.events, 'txn.upsert', 'tx_united')?.amount.minor).toBe(-48000)
    expect(byId<TxnUpsert>(second.events, 'txn.upsert', 'tx_uber_pending')).toMatchObject({ status: 'void', accountExternalId: 'acc_card', amount: { minor: 0, currency: 'USD' } })
    assertValidEvents(second.events, { connectionId: conn.id })

    const third = await runSync(connector, conn, second.cursor)
    expect(third.events.filter((e) => e.type === 'txn.upsert')).toHaveLength(0)
  })

  it('emits investment cash flows (dividend, contribution, fee) but not buys', async () => {
    const { connector, calls } = make()
    const { events } = await runSync(connector, conn, null)
    const t = (id: string) => byId<TxnUpsert>(events, 'txn.upsert', id)
    expect(t('inv_div')).toMatchObject({ amount: { minor: 4217 }, accountExternalId: 'acc_401k', counterparty: 'VTSAX', categoryHint: 'INVESTMENT_CASH_DIVIDEND' })
    expect(t('inv_contrib')?.amount.minor).toBe(50000)
    expect(t('inv_fee')).toMatchObject({ amount: { minor: -500 }, categoryHint: 'INVESTMENT_FEE_ACCOUNT_FEE' })
    expect(t('inv_buy')).toBeUndefined()
    const inv = calls.find((c) => c.url.endsWith('/investments/transactions/get'))?.body as { start_date: string; end_date: string }
    expect(inv).toMatchObject({ start_date: '2024-10-09', end_date: '2026-10-09' })
    // Next cycle reads only from 7 days before the last window's end.
    const first = await runSync(connector, conn, null)
    calls.length = 0
    await runSync(connector, conn, first.cursor)
    expect(calls.find((c) => c.url.endsWith('/investments/transactions/get'))?.body).toMatchObject({ start_date: '2026-10-02' })
  })

  it('restarts pagination after TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION', async () => {
    let failed = false
    const { connector, calls } = make([
      {
        match: (u, _i, body) => u.pathname === '/transactions/sync' && (body as { cursor?: string }).cursor === 'cur-1' && !failed,
        respond: () => {
          failed = true
          return { status: 400, json: { error_type: 'TRANSACTIONS_ERROR', error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION', error_message: 'mutated' } }
        },
      },
    ])
    const r = await runSync(connector, conn, null)
    expect(r.complete).toBe(true)
    const cursors = calls.filter((c) => c.url.endsWith('/transactions/sync')).map((c) => (c.body as { cursor?: string }).cursor ?? '')
    // '' → 'cur-1' fails → restart loop from '' → 'cur-1' succeeds.
    expect(cursors).toEqual(['', 'cur-1', '', 'cur-1'])
  })

  it('saves the transactions cursor only after has_more is false (one page per full sync loop)', async () => {
    const { connector } = make()
    const pages: Array<{ cursor: string | null; types: string[] }> = []
    let cursor: string | null = null
    for (;;) {
      const p = await connector.sync(conn, cursor)
      pages.push({ cursor: p.cursor, types: [...new Set(p.events.map((e) => e.type))] })
      cursor = p.cursor
      if (!p.hasMore) break
    }
    // accounts → every /transactions/sync page at once → investment transactions
    expect(pages).toHaveLength(3)
    expect(pages[1]?.types).toContain('txn.upsert')
  })

  it('asks for bounded follow-up syncs while Plaid is still preparing history, then stops', async () => {
    let status = 'NOT_READY'
    const page = { added: [], modified: [], removed: [], next_cursor: 'c-empty', has_more: false, accounts: [] }
    const { connector } = make([{ match: '/transactions/sync', respond: () => ({ json: { ...page, transactions_update_status: status } }) }])
    const plain = { ...conn, config: { ...conn.config, products: [] } }
    const cycle = async (cursor: string | null) => {
      const r = await runSync(connector, plain, cursor)
      return { cursor: r.cursor, again: r.syncAgainInMs }
    }
    let c = await cycle(null)
    expect(c.again).toBe(30_000)
    status = 'INITIAL_UPDATE_COMPLETE'
    c = await cycle(c.cursor)
    expect(c.again).toBe(120_000)
    c = await cycle(c.cursor)
    expect(c.again).toBe(600_000)
    c = await cycle(c.cursor)
    expect(c.again).toBe(1_800_000)
    c = await cycle(c.cursor)
    expect(c.again).toBeUndefined()
    status = 'HISTORICAL_UPDATE_COMPLETE'
    c = await cycle(c.cursor)
    expect(c.again).toBeUndefined()
  })

  it('skips an optional product the Item does not support', async () => {
    const { connector } = make([
      { match: '/liabilities/get', respond: { status: 400, json: { error_type: 'ITEM_ERROR', error_code: 'PRODUCTS_NOT_SUPPORTED', error_message: 'no' } } },
    ])
    const r = await runSync(connector, conn, null)
    expect(byId<AccountUpsert>(r.events, 'account.upsert', 'acc_card')?.liability).toBeUndefined()
  })
})

describe('plaid relink and errors', () => {
  const loginRequired = { status: 400, json: { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'the login details of this item have changed', display_message: 'Please reconnect your bank.' } }

  it('ITEM_LOGIN_REQUIRED during sync is an auth error (relink), not retried', async () => {
    const { connector, calls } = make([{ match: '/accounts/get', respond: loginRequired }])
    await expect(runSync(connector, conn, null)).rejects.toMatchObject({ kind: 'auth', code: 'ITEM_LOGIN_REQUIRED', message: 'Please reconnect your bank.' })
    expect(calls).toHaveLength(1)
  })

  it('health reports needs_reauth from /item/get error and ok otherwise', async () => {
    const bad = make([{ match: '/item/get', respond: { json: { item: { item_id: 'item_SANDBOX_1', error: loginRequired.json } } } }])
    expect(await bad.connector.health(conn)).toEqual({ status: 'needs_reauth', message: 'Please reconnect your bank.' })
    expect(await make().connector.health(conn)).toEqual({ status: 'ok' })
    const limited = make([{ match: '/item/get', respond: { status: 429, json: { error_type: 'RATE_LIMIT_EXCEEDED', error_code: 'RATE_LIMIT', error_message: 'slow down' } } }])
    expect((await limited.connector.health(conn)).status).toBe('rate_limited')
  })

  it('rejects a malformed stored secret as auth', async () => {
    const { connector } = make()
    await expect(connector.sync({ ...conn, secret: { nope: 1 } }, null)).rejects.toMatchObject({ kind: 'auth' })
  })

  it('retries institution downtime', async () => {
    let n = 0
    const { connector, calls } = make([
      { match: (u) => u.pathname === '/accounts/get' && n++ === 0, respond: { status: 400, json: { error_type: 'INSTITUTION_ERROR', error_code: 'INSTITUTION_DOWN', error_message: 'down' } } },
    ])
    const r = await runSync(connector, conn, null, { maxPages: 1 })
    expect(r.events.length).toBeGreaterThan(0)
    expect(calls.filter((c) => c.url.endsWith('/accounts/get'))).toHaveLength(2)
  })
})

describe('plaid connect and link', () => {
  it('exchanges a public token and records consented extra products', async () => {
    const { connector, calls } = make()
    const out = await connector.connect({ publicToken: 'public-sandbox-x', institution: { name: 'First Platypus Bank', institution_id: 'ins_109508' } })
    expect(out.secret).toEqual({ accessToken: 'access-sandbox-redacted-1', itemId: 'item_SANDBOX_1' })
    expect(out.config).toEqual({ itemId: 'item_SANDBOX_1', products: ['liabilities', 'investments'], institution: 'First Platypus Bank', institutionId: 'ins_109508' })
    expect(calls[0]?.body).toMatchObject({ public_token: 'public-sandbox-x' })
    await expect(connector.connect({})).rejects.toMatchObject({ kind: 'invalid_input' })
  })

  it('creates link tokens for new links and for relink (update mode)', async () => {
    const f = fixtureFetch([{ match: '/link/token/create', respond: { json: { link_token: 'link-sandbox-1', expiration: '2026-10-09T16:00:00Z' } } }])
    const c = createPlaidConnector({ ...OPTS, consentedProducts: ['investments', 'liabilities'], linkRedirectUri: 'https://app.example.com/connect/plaid/oauth' }, { raw: new MemoryRawSink(), fetch: f.fetch })
    expect(await c.createLinkToken({ clientUserId: 'u1' })).toEqual({ linkToken: 'link-sandbox-1', expiration: '2026-10-09T16:00:00Z' })
    expect(f.calls[0]?.body).toMatchObject({
      products: ['transactions'], additional_consented_products: ['investments', 'liabilities'], transactions: { days_requested: 730 },
      user: { client_user_id: 'u1' }, webhook: OPTS.webhookUrl, country_codes: ['US'], client_name: 'Aggregate',
    })
    await c.createLinkToken({ clientUserId: 'u1', accessToken: 'access-sandbox-x', accountSelection: true })
    const relink = f.calls[1]?.body as Record<string, unknown>
    expect(relink).toMatchObject({ access_token: 'access-sandbox-x', products: [], update: { account_selection_enabled: true } })
    expect(relink.optional_products).toBeUndefined()
    expect(relink.additional_consented_products).toBeUndefined()
  })

  it('begin returns a link widget token, in update mode for an existing connection', async () => {
    const f = fixtureFetch([{ match: '/link/token/create', respond: { json: { link_token: 'link-sandbox-2', expiration: '2026-10-09T16:00:00Z' } } }])
    const c = createPlaidConnector(OPTS, { raw: new MemoryRawSink(), fetch: f.fetch })
    const ctx = { workspaceId: 'ws1', redirectUri: 'https://meridn.example.com/cb', state: 's', userRef: 'u_hash' }
    expect(await c.begin(ctx)).toEqual({ kind: 'link_widget', provider: 'plaid', token: 'link-sandbox-2' })
    expect((f.calls[0]?.body as Record<string, unknown>).access_token).toBeUndefined()
    await c.begin({ ...ctx, connection: conn })
    expect(f.calls[1]?.body).toMatchObject({ access_token: 'access-sandbox-redacted-1', products: [], user: { client_user_id: 'u_hash' } })
    // A broken login is repaired without account selection; new accounts ask for it.
    expect((f.calls[1]?.body as Record<string, unknown>).update).toBeUndefined()
    await c.begin({ ...ctx, connection: conn, accountSelection: true })
    expect(f.calls[2]?.body).toMatchObject({ update: { account_selection_enabled: true } })
  })

  it('puts the OAuth redirect URI on every link token, update mode included', async () => {
    const f = fixtureFetch([{ match: '/link/token/create', respond: { json: { link_token: 'link-sandbox-3', expiration: '2026-10-09T16:00:00Z' } } }])
    const c = createPlaidConnector({ ...OPTS, linkRedirectUri: 'https://app.example.com/connect/plaid/oauth' }, { raw: new MemoryRawSink(), fetch: f.fetch })
    const ctx = { workspaceId: 'ws1', redirectUri: 'https://app.example.com/cb', state: 's', userRef: 'u_hash' }
    await c.begin(ctx)
    await c.begin({ ...ctx, connection: conn })
    for (const call of f.calls) expect(call.body).toMatchObject({ redirect_uri: 'https://app.example.com/connect/plaid/oauth' })
  })

  it('disconnect revokes the Item at Plaid', async () => {
    const f = fixtureFetch([{ match: '/item/remove', respond: { json: { request_id: 'r' } } }])
    const c = createPlaidConnector(OPTS, { raw: new MemoryRawSink(), fetch: f.fetch })
    await c.disconnect(conn)
    expect(f.calls.map((x) => new URL(x.url).pathname)).toEqual(['/item/remove'])
    expect(f.calls[0]?.body).toMatchObject({ access_token: 'access-sandbox-redacted-1' })
  })

  it('removeItem tolerates an already-removed Item', async () => {
    const f = fixtureFetch([{ match: '/item/remove', respond: { status: 400, json: { error_type: 'INVALID_INPUT', error_code: 'INVALID_ACCESS_TOKEN', error_message: 'gone' } } }])
    const c = createPlaidConnector(OPTS, { raw: new MemoryRawSink(), fetch: f.fetch })
    await expect(c.removeItem(conn)).resolves.toBeUndefined()
  })
})

describe('plaid balance refresh, duplicates and errors', () => {
  it('reads live balances only on request', async () => {
    const { connector, calls } = make([{ match: '/accounts/balance/get', respond: { json: fx.accounts_get } }])
    const events = await connector.refreshBalances(conn)
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.type === 'balance.snapshot')).toBe(true)
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/accounts/balance/get'])
    expect((calls[0]?.body as Record<string, unknown>).options).toBeUndefined()
  })

  it('asks Capital One for a freshness floor and falls back to cached balances when it has nothing newer', async () => {
    const { connector, calls } = make([
      { match: '/accounts/balance/get', respond: { status: 400, json: { error_type: 'INVALID_RESULT', error_code: 'LAST_UPDATED_DATETIME_OUT_OF_RANGE', error_message: 'old', request_id: 'req-1' } } },
    ])
    const events = await connector.refreshBalances({ ...conn, config: { ...conn.config, institutionId: 'ins_128026' } })
    expect(events.length).toBeGreaterThan(0)
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/accounts/balance/get', '/accounts/get'])
    expect(calls[0]?.body).toMatchObject({ options: { min_last_updated_datetime: expect.any(String) } })
  })

  it('finds an already-connected login by institution and account mask, but allows a second login at the same bank', () => {
    const existing = [{ connectionId: 'c1', institutionId: 'ins_3', accounts: [{ mask: '0000', subtype: 'checking' }, { mask: '1111', subtype: 'savings' }] }]
    expect(findDuplicatePlaidItem({ institutionId: 'ins_3', accounts: [{ mask: '0000', subtype: 'checking' }] }, existing)).toBe('c1')
    expect(findDuplicatePlaidItem({ institutionId: 'ins_3', accounts: [{ mask: '9999', subtype: 'checking' }] }, existing)).toBeUndefined()
    expect(findDuplicatePlaidItem({ institutionId: 'ins_4', accounts: [{ mask: '0000', subtype: 'checking' }] }, existing)).toBeUndefined()
    expect(findDuplicatePlaidItem({ accounts: [{ mask: '0000', subtype: 'checking' }] }, existing)).toBeUndefined()
  })

  it('keeps request_id on errors and treats a removed Item as needing a new connection', () => {
    const e = classifyPlaidError(400, { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'x', request_id: 'req-9' })
    expect(e).toMatchObject({ kind: 'auth', requestId: 'req-9' })
    const gone = classifyPlaidError(400, { error_type: 'INVALID_INPUT', error_code: 'ITEM_NOT_FOUND', error_message: 'not found' })
    expect(gone).toMatchObject({ kind: 'auth', code: 'ITEM_NOT_FOUND' })
    expect(gone.message).toMatch(/connect the bank again/)
  })
})

describe('plaid webhooks', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'ES256', use: 'sig', created_at: 1, expired_at: null }

  function signed(body: string, iat: number, kid = 'k1'): Record<string, string> {
    const h = Buffer.from(JSON.stringify({ alg: 'ES256', kid, typ: 'JWT' })).toString('base64url')
    const p = Buffer.from(JSON.stringify({ iat, request_body_sha256: createHash('sha256').update(body).digest('hex') })).toString('base64url')
    const s = sign('sha256', Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
    return { 'plaid-verification': `${h}.${p}.${s}` }
  }

  function verifier() {
    const f = fixtureFetch([{ match: '/webhook_verification_key/get', respond: { json: { key: jwk } } }])
    const clock = fakeClock()
    const c = createPlaidConnector(OPTS, { raw: new MemoryRawSink(), fetch: f.fetch, clock })
    return { v: new PlaidWebhookVerifier(c.client, clock), calls: f.calls, clock }
  }

  const body = JSON.stringify({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'item_SANDBOX_1', environment: 'sandbox' })

  it('accepts a correctly signed webhook and caches the key', async () => {
    const { v, calls, clock } = verifier()
    const iat = Math.floor(clock.now() / 1000)
    await v.verify({ headers: signed(body, iat), body })
    await v.verify({ headers: signed(body, iat), body })
    expect(calls).toHaveLength(1)
  })

  it('rejects tampering, stale, unsigned and wrong-alg webhooks', async () => {
    const { v, clock } = verifier()
    const iat = Math.floor(clock.now() / 1000)
    await expect(v.verify({ headers: signed(body, iat), body: body.replace('item_SANDBOX_1', 'item_OTHER') })).rejects.toMatchObject({ kind: 'auth' })
    await expect(v.verify({ headers: signed(body, iat - 600), body })).rejects.toThrow(/too old/)
    await expect(v.verify({ headers: {}, body })).rejects.toThrow(/missing/)
    const h = signed(body, iat)['plaid-verification']!.split('.')
    const none = Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url')
    await expect(v.verify({ headers: { 'plaid-verification': `${none}.${h[1]}.${h[2]}` }, body })).rejects.toThrow(/header/)
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey
    const forged = sign('sha256', Buffer.from(`${h[0]}.${h[1]}`), { key: other, dsaEncoding: 'ieee-p1363' }).toString('base64url')
    await expect(v.verify({ headers: { 'plaid-verification': `${h[0]}.${h[1]}.${forged}` }, body })).rejects.toThrow(/signature/)
  })

  it('interprets webhook codes', () => {
    const w = (o: object) => interpretPlaidWebhook({ headers: {}, body: JSON.stringify({ item_id: 'item_1', ...o }) })
    expect(w({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE' })).toMatchObject({ action: 'sync', match: { field: 'itemId', value: 'item_1' } })
    expect(w({ webhook_type: 'ITEM', webhook_code: 'ERROR', error: { error_code: 'ITEM_LOGIN_REQUIRED' } }).action).toBe('needs_reauth')
    expect(w({ webhook_type: 'ITEM', webhook_code: 'PENDING_EXPIRATION' }).action).toBe('reconnect_soon')
    expect(w({ webhook_type: 'ITEM', webhook_code: 'PENDING_DISCONNECT' }).action).toBe('reconnect_soon')
    expect(w({ webhook_type: 'ITEM', webhook_code: 'NEW_ACCOUNTS_AVAILABLE' }).action).toBe('new_accounts')
    expect(w({ webhook_type: 'ITEM', webhook_code: 'USER_ACCOUNT_REVOKED' }).action).toBe('disconnected')
    expect(w({ webhook_type: 'ITEM', webhook_code: 'ERROR', error: { error_code: 'ITEM_NOT_FOUND' } }).action).toBe('disconnected')
    expect(w({ webhook_type: 'ITEM', webhook_code: 'ERROR', error: { error_code: 'INSTITUTION_DOWN' } }).action).toBe('sync')
    expect(w({ webhook_type: 'ITEM', webhook_code: 'WEBHOOK_UPDATE_ACKNOWLEDGED' }).action).toBe('ignore')
    expect(w({ webhook_type: 'TRANSACTIONS', webhook_code: 'DEFAULT_UPDATE' }).action).toBe('ignore')
    expect(w({ webhook_type: 'HOLDINGS', webhook_code: 'DEFAULT_UPDATE' }).action).toBe('sync')
    expect(w({ webhook_type: 'INVESTMENTS_TRANSACTIONS', webhook_code: 'DEFAULT_UPDATE' }).action).toBe('sync')
    expect(w({ webhook_type: 'LIABILITIES', webhook_code: 'DEFAULT_UPDATE' }).action).toBe('sync')
    expect(w({ webhook_type: 'ITEM', webhook_code: 'USER_PERMISSION_REVOKED' }).action).toBe('disconnected')
    expect(w({ webhook_type: 'ITEM', webhook_code: 'LOGIN_REPAIRED' }).action).toBe('repaired')
    expect(w({ webhook_type: 'AUTH', webhook_code: 'SOMETHING' }).action).toBe('ignore')
    expect(interpretPlaidWebhook({ headers: {}, body: 'not json' }).action).toBe('ignore')
    const a = w({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE' })
    expect(a.dedupeKey).toBe(w({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE' }).dedupeKey)
  })
})

describe('plaid account kinds', () => {
  const acct = (type: string, subtype: string | null, holder_category?: string) =>
    ({ account_id: 'a', name: 'A', type, subtype, mask: '1234', balances: { iso_currency_code: 'USD' }, ...(holder_category ? { holder_category } : {}) }) as unknown as Parameters<typeof mapAccount>[0]
  it('keeps CDs and HSAs out of cash, and marks retirement, health and home/student loans as personal', () => {
    expect(accountType(acct('depository', 'checking'))).toBe('depository')
    expect(accountType(acct('depository', 'money market'))).toBe('depository')
    expect(accountType(acct('depository', 'cd'))).toBe('investment')
    expect(accountType(acct('depository', 'hsa'))).toBe('investment')
    const hint = (a: ReturnType<typeof acct>) => mapAccount(a, 'c', 'r', 'Bank', undefined).businessHint
    for (const [t, s] of [['investment', 'ira'], ['investment', '401k'], ['depository', 'hsa'], ['loan', 'mortgage'], ['loan', 'student']] as const) expect(hint(acct(t, s))).toBe('personal')
    expect(hint(acct('depository', 'checking'))).toBe('unknown')
    // The bank's own business flag wins.
    expect(hint(acct('loan', 'mortgage', 'business'))).toBe('business')
  })
})

describe('payment-app rows keep the person', () => {
  const row = (name: string, amount = -450, extra: Record<string, unknown> = {}) => ({ amount, name, original_description: name, ...extra }) as unknown as Parameters<typeof railPerson>[0]
  it('takes the payer or payee, not "Zelle"', () => {
    expect(railPerson(row('JOHN MELTON ZELLE'))).toBe('John Melton')
    expect(railPerson(row('ZELLE FROM JOHN MELTON ON 09/21 REF # PP0ABC123'))).toBe('John Melton')
    expect(railPerson(row('VENMO *DANA RUIZ', 25))).toBe('Dana Ruiz')
    expect(railPerson(row('CASH APP*SAM LEE*1234', 40))).toBe('Sam Lee')
    expect(railPerson(row('ZELLE PAYMENT 1234567'))).toBeUndefined()
    expect(railPerson(row('Zelle', -450, { payment_meta: { payer: 'JOHN MELTON' } }))).toBe('John Melton')
    expect(railPerson(row('COFFEE SHOP'))).toBeUndefined()
    expect(isPaymentRail('Zelle')).toBe(true)
    expect(isPaymentRail('Lumen Health')).toBe(false)
  })
})

describe('rows with no merchant keep a name', () => {
  it('uses Plaid\'s own name, title-cased when shouted', () => {
    expect(plainName('SUSHI BY KATSUYUKI')).toBe('Sushi by Katsuyuki')
    expect(plainName('Uber 072515 SF**POOL**')).toBe('Uber 072515 SF**POOL**')
    expect(plainName('123456')).toBeUndefined()
    expect(plainName(null)).toBeUndefined()
  })

  it('keeps initials upper case and drops the bank wording at the end', () => {
    expect(plainName('PG&E WEB ONLINE PAYMENT')).toBe('PG&E')
    expect(plainName('AT&T BILL PAYMENT')).toBe('AT&T')
    expect(plainName('ADP PAYROLL FEES')).toBe('ADP Payroll Fees')
    expect(plainName('BARNETT DESIGN LLC PAYMENT')).toBe('Barnett Design LLC')
    expect(plainName('TRAVIS WALDRON ACH CREDIT')).toBe('Travis Waldron')
    expect(plainName('CVS PHARMACY 4471')).toBe('CVS Pharmacy')
    expect(plainName('ACME CORP PPD ID: 9921')).toBe('Acme Corp')
    expect(plainName('DR SMITH DENTAL')).toBe('Dr Smith Dental')
    expect(plainName('Mobile Deposit')).toBe('Mobile Deposit')
    expect(plainName('Stripe Transfer')).toBe('Stripe Transfer')
    expect(plainName('ONLINE PAYMENT')).toBe('Online Payment')
  })
})

describe('interest the bank names, when Plaid is unsure', () => {
  const t = (name: string, amount: number, confidence: string, primary = 'TRANSFER_IN', detailed = 'TRANSFER_IN_OTHER_TRANSFER_IN') =>
    ({ name, original_description: name, amount, personal_finance_category: { primary, detailed, confidence_level: confidence } }) as Parameters<typeof categoryHint>[0]
  it('INTRST PYMNT money in with a low-confidence guess is interest income; otherwise Plaid\'s category stands', () => {
    expect(categoryHint(t('INTRST PYMNT', -4.22, 'LOW'))).toBe('INCOME_INTEREST_EARNED')
    expect(categoryHint(t('Interest Payment', -1.5, 'MEDIUM'))).toBe('INCOME_INTEREST_EARNED')
    expect(categoryHint(t('INTRST PYMNT', -4.22, 'VERY_HIGH'))).toBe('TRANSFER_IN_OTHER_TRANSFER_IN')
    expect(categoryHint(t('INTEREST PAYMENT', 25, 'LOW', 'LOAN_PAYMENTS', 'LOAN_PAYMENTS_OTHER_PAYMENT'))).toBe('LOAN_PAYMENTS_OTHER_PAYMENT')
    expect(categoryHint(t('Interest Rate Partners LLC', -900, 'LOW'))).toBe('TRANSFER_IN_OTHER_TRANSFER_IN')
    // Category v2 names for v1 codes read as v1: a paycheck stays INCOME_WAGES; codes new in v2 pass through.
    expect(categoryHint(t('ACME CORP PAYROLL DIRECT DEP', -4250, 'HIGH', 'INCOME', 'INCOME_SALARY'))).toBe('INCOME_WAGES')
    expect(categoryHint(t('MISC DEPOSIT', -20, 'HIGH', 'INCOME', 'INCOME_OTHER'))).toBe('INCOME_OTHER_INCOME')
    expect(categoryHint(t('LOAN PROCEEDS', -5000, 'HIGH', 'LOAN_DISBURSEMENTS', 'LOAN_DISBURSEMENTS_OTHER_DISBURSEMENT'))).toBe('TRANSFER_IN_CASH_ADVANCES_AND_LOANS')
    expect(categoryHint(t('DFAS MIL PAY', -3000, 'HIGH', 'INCOME', 'INCOME_MILITARY'))).toBe('INCOME_MILITARY')
  })
})

describe('crypto and points (Plaid unofficial_currency_code)', () => {
  it("is 'XXX', never the account's or USD; ISO codes win when present", () => {
    expect(plaidCurrency('EUR', null)).toBe('EUR')
    expect(plaidCurrency(null, 'BTC')).toBe('XXX')
    expect(plaidCurrency(undefined, undefined, 'CAD')).toBe('CAD')
  })
  it('a mixed batch keeps the dollar rows in dollars and books the BTC row as XXX', () => {
    const base = { account_id: 'acc_cb', date: '2026-09-02', name: 'Coinbase', pending: false, pending_transaction_id: null }
    const usd = mapTxn({ ...base, transaction_id: 't_usd', amount: 25, iso_currency_code: 'USD', unofficial_currency_code: null } as never, 'c1', 'r1', 'USD')
    const btc = mapTxn({ ...base, transaction_id: 't_btc', amount: -1.5, iso_currency_code: null, unofficial_currency_code: 'BTC' } as never, 'c1', 'r2', 'USD')
    expect(usd.amount).toEqual({ minor: -2500, currency: 'USD' })
    expect(btc.amount.currency).toBe('XXX')
  })
})

describe('plaid brokerage-only logins', () => {
  const brokerage: ConnectionRef = { ...conn, config: { ...conn.config, products: ['investments'] } }
  const notSupported = { status: 400, json: { error_type: 'ITEM_ERROR', error_code: 'PRODUCTS_NOT_SUPPORTED', error_message: 'no' } }

  it('investmentsFirst requires Investments and consents Transactions, so a brokerage-only login has a compatible account', async () => {
    const f = fixtureFetch([{ match: '/link/token/create', respond: { json: { link_token: 'link-sandbox-4', expiration: '2026-10-09T16:00:00Z' } } }])
    const c = createPlaidConnector({ ...OPTS, consentedProducts: ['investments', 'liabilities'] }, { raw: new MemoryRawSink(), fetch: f.fetch })
    const ctx = { workspaceId: 'ws1', redirectUri: 'https://meridn.example.com/cb', state: 's', userRef: 'u_hash' }
    await c.begin({ ...ctx, investmentsFirst: true })
    expect(f.calls[0]?.body).toMatchObject({ products: ['investments'], additional_consented_products: ['transactions', 'liabilities'] })
    // Update mode keeps the Item's own products.
    await c.begin({ ...ctx, connection: conn, investmentsFirst: true })
    expect(f.calls[1]?.body).toMatchObject({ access_token: 'access-sandbox-redacted-1', products: [] })
    expect((f.calls[1]?.body as Record<string, unknown>).additional_consented_products).toBeUndefined()
  })

  it('records an Item without Transactions, and its sync reads holdings and investment transactions only', async () => {
    const item = (fx.item_get as { item: Record<string, unknown> }).item
    const { connector, calls } = make([{ match: '/item/get', respond: { json: { ...(fx.item_get as object), item: { ...item, products: ['investments'], consented_products: ['investments'] } } } }])
    const out = await connector.connect({ publicToken: 'public-sandbox-x' })
    expect(out.config).toMatchObject({ products: ['investments'], noTransactions: true })
    calls.length = 0
    const { events } = await runSync(connector, { ...brokerage, config: out.config }, null)
    expect(calls.some((c) => c.url.endsWith('/transactions/sync'))).toBe(false)
    expect(calls.some((c) => c.url.endsWith('/investments/holdings/get'))).toBe(true)
    expect(byId<TxnUpsert>(events, 'txn.upsert', 'inv_div')).toBeDefined()
  })

  it('an investments Item whose accounts Transactions does not cover still syncs; a bank Item still fails', async () => {
    const { connector } = make([{ match: '/transactions/sync', respond: notSupported }])
    const { events } = await runSync(connector, brokerage, null)
    expect(events.some((e) => e.type === 'balance.snapshot')).toBe(true)
    expect(byId<TxnUpsert>(events, 'txn.upsert', 'inv_div')).toBeDefined()
    const bank: ConnectionRef = { ...conn, config: { ...conn.config, products: [] } }
    await expect(runSync(connector, bank, null)).rejects.toMatchObject({ code: 'PRODUCTS_NOT_SUPPORTED' })
  })
})

describe('plaid billed product calls only where an account needs them', () => {
  // The first /liabilities/get or /investments/* call starts that product's monthly per-Item subscription.
  const accountsOf = (...types: string[]) => {
    const all = fx.accounts_get as { accounts: Array<{ type: string }>; [k: string]: unknown }
    return { json: { ...all, accounts: all.accounts.filter((a) => types.includes(a.type)) } }
  }
  const billed = (calls: Array<{ url: string }>) =>
    ['/liabilities/get', '/investments/holdings/get', '/investments/transactions/get'].filter((p) => calls.some((c) => c.url.endsWith(p)))

  it('a bank-only Item makes no Liabilities or Investments call', async () => {
    const { connector, calls } = make([{ match: '/accounts/get', respond: accountsOf('depository') }])
    await runSync(connector, conn, null)
    expect(billed(calls)).toEqual([])
  })

  it('a card or loan Item reads Liabilities only', async () => {
    const { connector, calls } = make([{ match: '/accounts/get', respond: accountsOf('depository', 'credit') }])
    const r = await runSync(connector, conn, null)
    expect(billed(calls)).toEqual(['/liabilities/get'])
    expect(byId<AccountUpsert>(r.events, 'account.upsert', 'acc_card')?.liability).toBeDefined()
  })

  it('a brokerage Item reads Investments only, Transactions or not', async () => {
    const { connector, calls } = make([{ match: '/accounts/get', respond: accountsOf('investment') }])
    const r = await runSync(connector, conn, null)
    expect(billed(calls)).toEqual(['/investments/holdings/get', '/investments/transactions/get'])
    expect(byId<TxnUpsert>(r.events, 'txn.upsert', 'inv_div')).toBeDefined()
    calls.length = 0
    await runSync(connector, { ...conn, config: { ...conn.config, products: ['investments'], noTransactions: true } }, null)
    expect(billed(calls)).toEqual(['/investments/holdings/get', '/investments/transactions/get'])
  })
})
