import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AccountUpsert, BalanceSnapshot, ConnectionRef, NormalizedEvent, TxnUpsert } from '@agfn/contracts'
import { MemoryRawSink, hmac, runSync } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { MERCURY_CREDIT_TXNS_WARNING, createMercuryConnector, mercuryHiddenWarning, interpretMercuryWebhook, verifyMercuryWebhook, type MercuryConnectorOptions } from './index.ts'

const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/org.json', import.meta.url), 'utf8')) as {
  accounts: unknown
  credit: unknown
  treasury: unknown
  transactions: Record<string, Record<string, unknown>>
}

const TOKEN = 'secret-token:mercury_sandbox_testtoken'
const conn: ConnectionRef = { id: 'conn_mercury', workspaceId: 'ws1', connectorKey: 'mercury', secret: { token: TOKEN }, config: { accountIds: ['acc_checking', 'acc_savings', 'cred_io'] } }

function routes(extra: FixtureRoute[] = []): FixtureRoute[] {
  return [
    ...extra,
    { match: (u) => u.pathname === '/api/v1/accounts', respond: { json: fx.accounts } },
    { match: (u) => u.pathname === '/api/v1/credit', respond: { json: fx.credit } },
    { match: (u) => u.pathname === '/api/v1/treasury', respond: { json: fx.treasury } },
    {
      match: (u) => /^\/api\/v1\/account\/[^/]+\/transactions$/.test(u.pathname),
      respond: (u) => {
        const id = decodeURIComponent(u.pathname.split('/')[4] ?? '')
        const page = fx.transactions[id]?.[u.searchParams.get('offset') ?? '0']
        return page ? { json: page } : { status: 404, json: { message: 'accountId not found' } }
      },
    },
  ]
}

function make(extra: FixtureRoute[] = [], opts: MercuryConnectorOptions = { pageSize: 2 }) {
  const f = fixtureFetch(routes(extra))
  const clock = fakeClock()
  const saved: unknown[] = []
  const connector = createMercuryConnector(opts, { raw: new MemoryRawSink(), fetch: f.fetch, clock, saveSecret: async (_id, sec) => void saved.push(sec) })
  return { connector, conn, calls: f.calls, clock, saved }
}

const txn = (events: NormalizedEvent[], id: string) => events.find((e): e is TxnUpsert => e.type === 'txn.upsert' && e.externalId === id)

describe('mercury contract', () => {
  it('passes the connector contract', async () => {
    const r = await runConnectorContract({
      make: () => make(),
      signs: { txn_card: '-', txn_wire_in: '+', txn_xfer_out: '-', txn_xfer_in: '+', txn_cc: '-' },
      minEvents: 15,
    })
    // accounts, checking ×2, savings ×2, credit ×2 (a full page is followed up; the empty one ends it)
    expect(r.pages).toBe(7)
  })

  it('fixture is redacted', () => assertRedacted(fx))
})

describe('mercury mapping', () => {
  it('maps accounts and balances', async () => {
    const { connector, calls } = make()
    const { events } = await runSync(connector, conn, null)
    const acct = (id: string) => events.find((e): e is AccountUpsert => e.type === 'account.upsert' && e.externalId === id)
    expect(acct('acc_checking')).toMatchObject({ name: 'Operating', accountType: 'depository', currency: 'USD', mask: '1234', institution: 'Mercury', businessHint: 'business' })
    expect(acct('acc_savings')?.name).toBe('Mercury Savings')
    expect(acct('acc_external')).toBeUndefined()
    expect(acct('cred_io')).toMatchObject({ accountType: 'credit_card' })
    expect(acct('tre_1')).toMatchObject({ accountType: 'investment' })
    const bal = (id: string) => events.find((e): e is BalanceSnapshot => e.type === 'balance.snapshot' && e.accountExternalId === id)
    expect(bal('acc_checking')).toMatchObject({ externalId: 'acc_checking@2026-10-09', current: { minor: 12510050, currency: 'USD' }, available: { minor: 12500050 } })
    expect(bal('cred_io')?.current.minor).toBe(-123456)
    expect(bal('cred_io')?.available).toBeUndefined()
    expect(bal('tre_1')?.current.minor).toBe(30012345)
    expect(calls.every((c) => c.method === 'GET' && c.headers.authorization === `Bearer ${TOKEN}`)).toBe(true)
    const first = new URL(calls.find((c) => c.url.includes('/transactions'))!.url).searchParams
    expect(Object.fromEntries(first)).toEqual({ limit: '2', offset: '0', start: '2024-10-09', end: '2026-10-09', order: 'asc' })
  })

  it('maps transactions with golden values', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    expect(txn(events, 'txn_card')).toMatchObject({
      accountExternalId: 'acc_checking', date: '2026-10-02', amount: { minor: -4567, currency: 'USD' }, status: 'posted',
      counterparty: 'Blue Bottle', rawText: 'BLUE BOTTLE COFFEE OAKLAND CA', categoryHint: 'debitCardTransaction', linkRefs: { card_id: 'card_debit_1' },
    })
    expect(txn(events, 'txn_wire_in')).toMatchObject({ amount: { minor: 1000000 }, counterparty: 'Customer Co', rawText: 'WIRE IN CUSTOMER CO REF INV-1001 | Invoice 1001' })
    expect(txn(events, 'txn_xfer_out')).toMatchObject({ amount: { minor: -250000 }, linkRefs: { counterparty_account: 'acc_savings' } })
    expect(txn(events, 'txn_xfer_out')?.linkRefs?.transfer).toBeUndefined()
    expect(txn(events, 'txn_xfer_in')).toMatchObject({ accountExternalId: 'acc_savings', amount: { minor: 250000 } })
    expect(txn(events, 'txn_pending')).toMatchObject({ status: 'pending', date: '2026-09-20', amount: { minor: -10050 }, rawText: 'September services | INV 77' })
    expect(txn(events, 'txn_cc')).toMatchObject({ accountExternalId: 'cred_io', amount: { minor: -1999 }, date: '2026-10-06' })
    expect(txn(events, 'txn_failed')?.status).toBe('void')
  })

  it('next cycle re-reads from the oldest pending row (or the overlap)', async () => {
    const { connector, calls } = make()
    const first = await runSync(connector, conn, null)
    const n = calls.length
    const second = await runSync(connector, conn, first.cursor)
    expect(second.complete).toBe(true)
    const starts = calls.slice(n).filter((c) => c.url.includes('/transactions')).map((c) => new URL(c.url).searchParams.get('start'))
    expect(new Set(starts)).toEqual(new Set(['2026-09-20']))
  })

  it('works without credit or treasury access', async () => {
    const { connector } = make([
      { match: (u) => u.pathname === '/api/v1/credit', respond: { status: 403, json: { message: 'forbidden' } } },
      { match: (u) => u.pathname === '/api/v1/treasury', respond: { status: 404, json: {} } },
    ])
    const r = await runSync(connector, conn, null)
    expect(r.events.some((e) => e.externalId === 'cred_io')).toBe(false)
    expect(txn(r.events, 'txn_card')).toBeDefined()
  })

  it('warns only when credit or treasury accounts seen before disappear', async () => {
    const hidden: FixtureRoute[] = [
      { match: (u) => u.pathname === '/api/v1/credit', respond: { status: 403, json: { message: 'forbidden' } } },
      { match: (u) => u.pathname === '/api/v1/treasury', respond: { status: 404, json: {} } },
    ]
    const cycle = async (connector: ReturnType<typeof make>['connector'], start: string | null) => {
      const warnings: string[] = []
      let cursor = start
      for (;;) {
        const r = await connector.sync(conn, cursor)
        warnings.push(...(r.warnings ?? []))
        cursor = r.cursor
        if (!r.hasMore) break
      }
      return { warnings, cursor }
    }
    // Never had them: silent.
    const never = make(hidden).connector
    const a = await cycle(never, null)
    expect(a.warnings).toEqual([])
    expect((await cycle(never, a.cursor)).warnings).toEqual([])
    // Had them last cycle, now hidden: one warning per product, on the accounts page.
    const full = await cycle(make().connector, null)
    expect(full.warnings).toEqual([])
    const first = await make(hidden).connector.sync(conn, full.cursor)
    expect(first.warnings).toEqual([mercuryHiddenWarning('credit'), mercuryHiddenWarning('treasury')])
  })
})

describe('mercury account names', () => {
  it('drops the "••1234" Mercury puts at the end of a name (the app shows the last four itself)', async () => {
    const { mapAccount } = await import('./map.ts')
    const base = { id: 'a1', kind: 'checking', accountNumber: '000000006693', status: 'active', type: 'mercury' } as never
    expect(mapAccount({ ...(base as object), name: 'Mercury Checking ••5234' } as never, 'c', 'r').name).toBe('Mercury Checking')
    expect(mapAccount({ ...(base as object), name: 'Ops ••1579', nickname: 'Payroll ••1579' } as never, 'c', 'r').name).toBe('Payroll')
    expect(mapAccount({ ...(base as object), name: 'Main checking' } as never, 'c', 'r').name).toBe('Main checking')
    expect(mapAccount({ ...(base as object), name: '••1579' } as never, 'c', 'r').name).toBe('Mercury checking')
  })
})

describe('mercury paging and missing card activity', () => {
  const drain = async (connector: ReturnType<typeof make>['connector'], c: ConnectionRef = conn) => {
    const warnings: string[] = []
    const events: NormalizedEvent[] = []
    let cursor: string | null = null
    for (let i = 0; i < 50; i++) {
      const r = await connector.sync(c, cursor)
      warnings.push(...(r.warnings ?? []))
      events.push(...r.events)
      cursor = r.cursor
      if (!r.hasMore) return { warnings, events }
    }
    throw new Error('sync never finished')
  }
  const txnPath = (id: string) => `/api/v1/account/${id}/transactions`

  it('keeps paging while pages are full, even when total looks per-page', async () => {
    const first = (fx.transactions.acc_checking as Record<string, { transactions: unknown[] }>)['0']!
    const { connector, calls } = make([
      // total 2 = this page only; the old offset+n < total check would have stopped and missed txn_xfer_out.
      { match: (u) => u.pathname === txnPath('acc_checking') && u.searchParams.get('offset') === '0', respond: { json: { total: 2, transactions: first.transactions } } },
    ])
    const { events } = await drain(connector)
    const offsets = calls.filter((c) => new URL(c.url).pathname === txnPath('acc_checking')).map((c) => new URL(c.url).searchParams.get('offset'))
    expect(offsets).toEqual(['0', '2'])
    expect(txn(events, 'txn_xfer_out')).toBeDefined()
  })

  it('stops on a short or empty page', async () => {
    const { connector, calls } = make()
    await drain(connector)
    const offsets = (id: string) => calls.filter((c) => new URL(c.url).pathname === txnPath(id)).map((c) => new URL(c.url).searchParams.get('offset'))
    expect(offsets('acc_checking')).toEqual(['0', '2']) // second page has 1 of 2
    expect(offsets('acc_savings')).toEqual(['0', '2']) // second page empty
  })

  it('a 404 on the credit card transactions warns and the cycle goes on', async () => {
    const { connector } = make([{ match: (u) => u.pathname === txnPath('cred_io'), respond: { status: 404, json: { message: 'not found' } } }])
    const { warnings, events } = await drain(connector)
    expect(warnings).toEqual([MERCURY_CREDIT_TXNS_WARNING])
    expect(events.some((e) => e.type === 'account.upsert' && e.externalId === 'cred_io')).toBe(true)
    expect(txn(events, 'txn_card')).toBeDefined()
    // A 404 on a bank account is skipped without the card warning.
    const dep = make([{ match: (u) => u.pathname === txnPath('acc_savings'), respond: { status: 404, json: { message: 'not found' } } }])
    expect((await drain(dep.connector)).warnings).toEqual([])
  })
})

describe('mercury errors and connect', () => {
  it('401 → auth, not retried; health needs_reauth', async () => {
    const { connector, calls } = make([{ match: () => true, respond: { status: 401, json: { errors: { message: 'Unauthorized' } } } }])
    await expect(runSync(connector, conn, null)).rejects.toMatchObject({ kind: 'auth' })
    expect(calls).toHaveLength(1)
    expect(await connector.health(conn)).toMatchObject({ status: 'needs_reauth', message: expect.stringMatching(/Read Only token/) })
  })

  it('401 on a sign-in connection asks for a reconnect, not a new API token', async () => {
    const { connector } = make([{ match: () => true, respond: { status: 401, json: { errors: { message: 'Unauthorized' } } } }])
    const oauthConn: ConnectionRef = { ...conn, secret: { token: 'at_1', kind: 'oauth', refreshToken: 'rt_1', expiresAt: Date.parse('2026-10-09T13:00:00Z') } }
    const h = await connector.health(oauthConn)
    expect(h).toMatchObject({ status: 'needs_reauth', message: expect.stringMatching(/reconnect Mercury/) })
    expect(h.message).not.toMatch(/API token|Read Only/)
  })

  it('429 with Retry-After is retried', async () => {
    let n = 0
    const { connector, clock } = make([{ match: (u) => u.pathname === '/api/v1/accounts' && n++ === 0, respond: { status: 429, headers: { 'retry-after': '3' }, text: 'Too Many Requests' } }])
    const r = await runSync(connector, conn, null, { maxPages: 1 })
    expect(r.events.length).toBeGreaterThan(0)
    expect(clock.sleeps).toContain(3000)
    expect(await make().connector.health(conn)).toEqual({ status: 'ok' })
  })

  it('malformed secret → auth; connect validates and verifies', async () => {
    const { connector } = make()
    await expect(connector.sync({ ...conn, secret: { token: '' } }, null)).rejects.toMatchObject({ kind: 'auth' })
    await expect(connector.connect({})).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(connector.connect({ apiKey: 'two words' })).rejects.toMatchObject({ kind: 'invalid_input' })
    expect(await connector.connect({ apiKey: TOKEN })).toEqual({
      secret: { token: TOKEN },
      config: { accountIds: ['acc_checking', 'acc_savings', 'cred_io'], legalBusinessName: 'Example Labs Inc.' },
    })
    const odd = await connector.connect({ apiKey: 'not-a-mercury-token' })
    expect(odd.config.warnings).toHaveLength(1)
  })

  it('begin and describe', async () => {
    const { connector } = make()
    expect(await connector.begin()).toMatchObject({ kind: 'api_key', helpUrl: expect.stringContaining('mercury.com'), placeholder: expect.stringContaining('secret-token:') })
    expect(connector.describe()).toMatchObject({ key: 'mercury', group: 'banks', auth: 'api_key' })
  })
})

describe('mercury webhooks', () => {
  const secret = 'mercury-webhook-secret'
  const now = Math.floor(Date.parse('2026-10-09T12:00:00Z') / 1000)
  const body = JSON.stringify({ id: 'evt_1', resourceType: 'transaction', resourceId: 'txn_card', operationType: 'update', mergePatch: { status: 'sent', accountId: 'acc_checking' } })
  const sig = (t: number, b: string, k = secret) => `t=${t},v1=${hmac('sha256', k, `${t}.${b}`).toString('hex')}`

  it('accepts a valid signature', async () => {
    const { connector } = make([], { webhookSecret: secret })
    await expect(connector.webhook!.verify({ headers: { 'mercury-signature': sig(now, body) }, body })).resolves.toBeUndefined()
  })

  it('rejects tampered, stale, wrong key, missing', () => {
    const clock = fakeClock()
    expect(() => verifyMercuryWebhook({ headers: { 'mercury-signature': sig(now, body) }, body: body.replace('sent', 'failed') }, secret, clock)).toThrow(/signature/)
    expect(() => verifyMercuryWebhook({ headers: { 'mercury-signature': sig(now - 301, body) }, body }, secret, clock)).toThrow(/tolerance/)
    expect(() => verifyMercuryWebhook({ headers: { 'mercury-signature': sig(now, body, 'other') }, body }, secret, clock)).toThrow(/signature/)
    expect(() => verifyMercuryWebhook({ headers: {}, body }, secret, clock)).toThrow(/missing/)
    expect(() => verifyMercuryWebhook({ headers: { 'mercury-signature': 'garbage' }, body }, secret, clock)).toThrow(/malformed/)
  })

  it('interprets events', () => {
    expect(make().connector.webhook).toBeUndefined()
    expect(interpretMercuryWebhook({ headers: {}, body })).toEqual({ action: 'sync', dedupeKey: 'mercury:evt_1', reason: 'transaction.update', match: { field: 'accountIds', value: 'acc_checking' } })
    const bal = JSON.stringify({ id: 'evt_2', resourceType: 'checkingAccount', resourceId: 'acc_checking', operationType: 'update', mergePatch: { currentBalance: 1 } })
    expect(interpretMercuryWebhook({ headers: {}, body: bal })).toMatchObject({ action: 'sync', match: { field: 'accountIds', value: 'acc_checking' } })
    expect(interpretMercuryWebhook({ headers: {}, body: JSON.stringify({ id: 'e', resourceType: 'recipient', resourceId: 'r', operationType: 'create' }) }).action).toBe('ignore')
    expect(interpretMercuryWebhook({ headers: {}, body: '{' }).action).toBe('ignore')
  })
})

describe('mercury one-click sign-in (OAuth)', () => {
  const app: MercuryConnectorOptions = { pageSize: 2, oauthClientId: 'merc_client', oauthClientSecret: 'merc_csecret' }
  const ctx = { workspaceId: 'ws1', redirectUri: 'https://app.example/api/connectors/mercury/callback', state: 'state-123456789', userRef: 'p1' }
  const basic = `Basic ${Buffer.from('merc_client:merc_csecret').toString('base64')}`
  const tokenRoute = (json: unknown): FixtureRoute => ({ method: 'POST', match: (u) => u.host === 'oauth2.mercury.com' && u.pathname === '/oauth2/token', respond: { json } })

  it('without the client it stays a pasted token', async () => {
    const { connector } = make()
    expect(connector.describe().auth).toBe('api_key')
    expect(await connector.begin(ctx)).toMatchObject({ kind: 'api_key' })
  })

  it('begin sends people to Mercury asking for read + offline_access', async () => {
    const { connector } = make([], app)
    expect(connector.describe().auth).toBe('oauth')
    const b = await connector.begin(ctx)
    const u = new URL(b.kind === 'oauth' ? b.url : '')
    expect(u.origin + u.pathname).toBe('https://oauth2.mercury.com/oauth2/auth')
    expect(u.searchParams.get('scope')).toBe('read offline_access')
    expect(u.searchParams.get('response_type')).toBe('code')
    expect(u.searchParams.get('redirect_uri')).toBe(ctx.redirectUri)
    expect(u.searchParams.get('state')).toBe('state-123456789')
  })

  it('connect exchanges the code (Basic auth); an expiring token is refreshed with scope and the rotated one returned', async () => {
    const { connector, calls, clock } = make([tokenRoute({ access_token: 'at_1', refresh_token: 'rt_1', expires_in: 3600, token_type: 'bearer' })], app)
    const r = await connector.connect({ code: 'code_1', redirectUri: ctx.redirectUri })
    expect(r.secret).toEqual({ token: 'at_1', kind: 'oauth', refreshToken: 'rt_1', expiresAt: clock.now() + 3_600_000 })
    expect(r.config).not.toHaveProperty('warnings')
    expect(calls[0]?.headers.authorization).toBe(basic)
    expect(calls.find((c) => c.url.includes('api.mercury.com'))?.headers.authorization).toBe('Bearer at_1')

    const f2 = make([tokenRoute({ access_token: 'at_2', refresh_token: 'rt_2', expires_in: 3600 })], app)
    f2.clock.t = clock.t + 3_600_000 - 60_000
    const page = await f2.connector.sync({ ...conn, secret: r.secret }, null)
    expect(page.updatedSecret).toEqual({ token: 'at_2', kind: 'oauth', refreshToken: 'rt_2', expiresAt: f2.clock.t + 3_600_000 })
    expect(f2.calls[0]?.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt_1', scope: 'read offline_access' })
    expect(f2.calls.find((c) => c.url.includes('api.mercury.com'))?.headers.authorization).toBe('Bearer at_2')
  })

  it('saves a rotated refresh token before the first page, and health never refreshes', async () => {
    const f = make([tokenRoute({ access_token: 'at_2', refresh_token: 'rt_2', expires_in: 3600 }), { match: (u) => u.pathname.includes('/accounts'), respond: { status: 500, json: {} } }], app)
    const expiring = { ...conn, secret: { token: 'at_1', kind: 'oauth', refreshToken: 'rt_1', expiresAt: f.clock.now() } }
    await expect(f.connector.sync(expiring, null)).rejects.toBeTruthy()
    expect(f.saved).toEqual([expect.objectContaining({ token: 'at_2', refreshToken: 'rt_2' })])
    const g = make([tokenRoute({ access_token: 'at_3', refresh_token: 'rt_3', expires_in: 3600 })], app)
    expect(await g.connector.health({ ...conn, secret: { token: 'at_1', kind: 'oauth', refreshToken: 'rt_1', expiresAt: g.clock.now() - 1 } })).toMatchObject({ status: 'ok', message: expect.stringMatching(/next sync/) })
    expect(g.calls).toHaveLength(0)
    expect(g.saved).toHaveLength(0)
  })
})

describe('mercury disconnect', () => {
  const app: MercuryConnectorOptions = { pageSize: 2, oauthClientId: 'merc_client', oauthClientSecret: 'merc_csecret' }
  const oauthConn: ConnectionRef = { ...conn, secret: { token: 'at_1', kind: 'oauth', refreshToken: 'rt_1', expiresAt: 0 } }
  const revoke = (status: number, json: unknown): FixtureRoute => ({ method: 'POST', match: (u) => u.host === 'oauth2.mercury.com' && u.pathname === '/oauth2/revoke', respond: { status, json } })

  it('revokes the refresh token with the app credentials', async () => {
    const { connector, calls } = make([revoke(200, {})], app)
    await expect(connector.disconnect!(oauthConn)).resolves.toBeUndefined()
    const call = calls.find((c) => c.url.endsWith('/oauth2/revoke'))
    expect(call?.headers.authorization).toBe(`Basic ${btoa('merc_client:merc_csecret')}`)
    expect(call?.body).toEqual({ token: 'rt_1', token_type_hint: 'refresh_token' })
  })

  it('a token Mercury no longer knows is already gone', async () => {
    const { connector } = make([revoke(400, { error: 'invalid_token' })], app)
    await expect(connector.disconnect!(oauthConn)).resolves.toBeUndefined()
  })

  it('any other refusal says what to finish at Mercury', async () => {
    for (const r of [revoke(400, { error: 'invalid_request' }), revoke(401, { error: 'invalid_client' }), revoke(500, {})]) {
      const { connector } = make([r], app)
      await expect(connector.disconnect!(oauthConn)).resolves.toEqual({ notRevoked: expect.stringContaining('Remove Aggregate') })
    }
  })

  it('a pasted token can only be deleted in Mercury, and nothing is sent', async () => {
    const { connector, calls } = make([revoke(200, {})], app)
    await expect(connector.disconnect!(conn)).resolves.toEqual({ notRevoked: expect.stringContaining('Settings → Tokens') })
    expect(calls.filter((c) => c.url.endsWith('/oauth2/revoke'))).toHaveLength(0)
  })
})
