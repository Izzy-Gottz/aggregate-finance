import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AccountUpsert, BalanceSnapshot, ConnectionRef, NormalizedEvent, TxnUpsert } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureRoute } from '@agfn/connector-sdk/testing'
import {
  SCA_NO_KEY_WARNING,
  SCA_REFUSED_WARNING,
  createWiseConnector,
  interpretWiseWebhook,
  signOneTimeToken,
  verifyWiseWebhook,
  loadPrivateKey,
  type WiseConnectorOptions,
} from './index.ts'

const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/business-profile.json', import.meta.url), 'utf8')) as {
  profiles: unknown[]
  balances: unknown[]
  statements: Record<string, unknown>
}

const conn: ConnectionRef = {
  id: 'conn_wise', workspaceId: 'ws1', connectorKey: 'wise',
  secret: { token: 'wise-test-token' },
  config: { profileId: '2002', profileType: 'business', name: 'Example Labs Ltd' },
}

const STATEMENT = /^\/v1\/profiles\/2002\/balance-statements\/(\d+)\/statement\.json$/

function statementRoute(): FixtureRoute {
  return {
    match: (u) => STATEMENT.test(u.pathname),
    respond: (u) => {
      const id = STATEMENT.exec(u.pathname)?.[1] ?? ''
      const st = fx.statements[id]
      return st ? { json: st } : { status: 404, json: { errors: [{ code: 'not.found', message: 'no balance' }] } }
    },
  }
}

function routes(extra: FixtureRoute[] = []): FixtureRoute[] {
  return [
    ...extra,
    { match: (u) => u.pathname === '/v2/profiles', respond: { json: fx.profiles } },
    { match: (u) => u.pathname === '/v4/profiles/2002/balances', respond: { json: fx.balances } },
    statementRoute(),
  ]
}

function make(extra: FixtureRoute[] = [], opts: WiseConnectorOptions = {}) {
  const f = fixtureFetch(routes(extra))
  const clock = fakeClock()
  const connector = createWiseConnector(opts, { raw: new MemoryRawSink(), fetch: f.fetch, clock })
  return { connector, conn, calls: f.calls, clock }
}

const txn = (events: NormalizedEvent[], id: string) => events.find((e): e is TxnUpsert => e.type === 'txn.upsert' && e.externalId === id)

describe('wise contract', () => {
  it('passes the connector contract', async () => {
    const r = await runConnectorContract({
      make: () => make(),
      signs: { 'CARD-249281': '-', 'TRANSFER-554433': '+', 'BALANCE-778899:USD': '-', 'BALANCE-778899:EUR': '+', 'DIRECT_DEBIT-9001': '-' },
      minEvents: 9,
    })
    expect(r.pages).toBe(3)
  })

  it('fixture is redacted', () => assertRedacted(fx))
})

describe('wise mapping', () => {
  it('maps balances to one depository account per currency', async () => {
    const { connector, calls } = make()
    const { events } = await runSync(connector, conn, null)
    const acct = (id: string) => events.find((e): e is AccountUpsert => e.type === 'account.upsert' && e.externalId === id)
    expect(acct('2002:USD')).toMatchObject({ name: 'Wise USD', accountType: 'depository', currency: 'USD', institution: 'Wise', businessHint: 'business' })
    expect(acct('2002:EUR')?.name).toBe('Euro ops (EUR)')
    const bal = (id: string) => events.find((e): e is BalanceSnapshot => e.type === 'balance.snapshot' && e.accountExternalId === id)
    expect(bal('2002:USD')).toMatchObject({ externalId: '2002:USD@2026-10-09', current: { minor: 436086, currency: 'USD' }, available: { minor: 431086 } })
    expect(bal('2002:EUR')?.current).toEqual({ minor: 9001, currency: 'EUR' })
    const st = calls.filter((c) => STATEMENT.test(new URL(c.url).pathname)).map((c) => Object.fromEntries(new URL(c.url).searchParams))
    expect(st[0]).toEqual({ currency: 'USD', intervalStart: '2025-10-09T12:00:00.000Z', intervalEnd: '2026-10-09T12:00:00.000Z', type: 'COMPACT' })
    expect(calls.every((c) => c.method === 'GET' && c.headers.authorization === 'Bearer wise-test-token')).toBe(true)
  })

  it('maps statement rows, linking both legs of a conversion', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    expect(txn(events, 'CARD-249281')).toEqual(expect.objectContaining({
      accountExternalId: '2002:USD', date: '2026-10-01', amount: { minor: -2540, currency: 'USD' }, status: 'posted',
      counterparty: 'Notion Labs', categoryHint: 'CARD:Computer Network Services', linkRefs: { wise_reference: 'CARD-249281' },
    }))
    expect(txn(events, 'TRANSFER-554433')).toMatchObject({ amount: { minor: 150000 }, counterparty: 'Customer Co', rawText: 'Received money from Customer Co with reference INV-1001 | INV-1001' })
    expect(txn(events, 'BALANCE-778899:USD')).toMatchObject({ accountExternalId: '2002:USD', amount: { minor: -11000, currency: 'USD' }, linkRefs: { transfer: 'BALANCE-778899' } })
    expect(txn(events, 'BALANCE-778899:EUR')).toMatchObject({ accountExternalId: '2002:EUR', amount: { minor: 10000, currency: 'EUR' }, linkRefs: { transfer: 'BALANCE-778899' } })
    expect(txn(events, 'DIRECT_DEBIT-9001')?.amount).toEqual({ minor: -999, currency: 'EUR' })
  })

  it('next cycle starts 3 days before the previous one; long backfills are windowed', async () => {
    const { connector, calls } = make([], { backfillDays: 500 })
    const first = await runSync(connector, conn, null)
    // 2 windows for USD, 2 for EUR
    expect(first.pages).toBe(5)
    const n = calls.length
    await runSync(connector, conn, first.cursor)
    const starts = calls.slice(n).filter((c) => STATEMENT.test(new URL(c.url).pathname)).map((c) => new URL(c.url).searchParams.get('intervalStart'))
    expect(starts).toEqual(['2026-10-06T12:00:00.000Z', '2026-10-06T12:00:00.000Z'])
  })
})

describe('wise SCA', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  const OTT = 'b3c7a7e2-0000-4000-8000-000000000001'
  const challenge = { status: 403, headers: { 'x-2fa-approval': OTT, 'x-2fa-approval-result': 'REJECTED' }, json: { error: 'sca_required' } }

  /** Statements need a signed OTT; the route checks the signature with the uploaded public key. */
  function scaRoute(accept = true): FixtureRoute {
    // Answers the challenge unless the request carries a valid signature over the OTT (then the normal route serves it).
    return {
      match: (u, init) => {
        if (!STATEMENT.test(u.pathname)) return false
        const h = new Headers(init?.headers)
        const ott = h.get('x-2fa-approval')
        const sig = h.get('x-signature')
        const valid = !!ott && !!sig && ott === OTT && verify('sha256', Buffer.from(ott), publicKey, Buffer.from(sig, 'base64'))
        return !(valid && accept)
      },
      respond: challenge,
    }
  }

  it('signs the one-time token and retries with x-2fa-approval + X-Signature', async () => {
    const { connector, calls } = make([scaRoute()])
    const { events } = await runSync(connector, { ...conn, secret: { token: 'wise-test-token', scaPrivateKey: pem } }, null)
    expect(txn(events, 'CARD-249281')).toBeDefined()
    const st = calls.filter((c) => STATEMENT.test(new URL(c.url).pathname))
    expect(st).toHaveLength(4) // challenge + signed retry, per balance
    expect(st[1]?.headers['x-2fa-approval']).toBe(OTT)
    expect(st[1]?.headers['x-signature']).toBe(signOneTimeToken(OTT, loadPrivateKey(pem)))
    expect(verify('sha256', Buffer.from(OTT), publicKey, Buffer.from(st[1]!.headers['x-signature']!, 'base64'))).toBe(true)
  })

  it('a deployment-wide key from opts works too', async () => {
    const { connector } = make([scaRoute()], { scaPrivateKey: pem })
    const r = await runSync(connector, conn, null)
    expect(r.complete).toBe(true)
  })

  it('without a key: keeps accounts and balances, skips statements with a warning; health ok with the message', async () => {
    const { connector, calls } = make([scaRoute()])
    const page1 = await connector.sync(conn, null)
    expect(page1.events.some((e) => e.type === 'balance.snapshot')).toBe(true)
    expect(page1.warnings).toBeUndefined()
    const page2 = await connector.sync(conn, page1.cursor)
    expect(page2).toMatchObject({ events: [], hasMore: false, warnings: [SCA_NO_KEY_WARNING] })
    // One challenged statement call, then the cycle ends (no other balance is tried).
    expect(calls.filter((c) => STATEMENT.test(new URL(c.url).pathname))).toHaveLength(1)
    // The skipped range is not marked as read: the next cycle backfills the full history again.
    const next = await connector.sync(conn, page2.cursor)
    const n = calls.length
    await connector.sync(conn, next.cursor)
    expect(new URL(calls[n]!.url).searchParams.get('intervalStart')).toBe('2025-10-09T12:00:00.000Z')
    expect(await connector.health(conn)).toEqual({ status: 'ok', message: SCA_NO_KEY_WARNING })
  })

  it('refused signed retry (EU/UK PSD2): continues with a warning explaining the limitation', async () => {
    const { connector } = make([scaRoute(false)])
    const keyed = { ...conn, secret: { token: 'wise-test-token', scaPrivateKey: pem } }
    const r = await runSync(connector, keyed, null)
    expect(r.complete).toBe(true)
    expect(r.events.filter((e) => e.type === 'account.upsert')).toHaveLength(2)
    expect(r.events.some((e) => e.type === 'txn.upsert')).toBe(false)
    const page1 = await connector.sync(keyed, null)
    const page2 = await connector.sync(keyed, page1.cursor)
    expect(page2.warnings).toEqual([SCA_REFUSED_WARNING])
    expect(SCA_REFUSED_WARNING).toMatch(/EU\/UK/)
    expect(await connector.health(keyed)).toEqual({ status: 'ok', message: SCA_REFUSED_WARNING })
  })

  it('statements that work carry no warning', async () => {
    const { connector } = make([scaRoute()], { scaPrivateKey: pem })
    let cursor: string | null = null
    for (;;) {
      const r = await connector.sync(conn, cursor)
      expect(r.warnings).toBeUndefined()
      cursor = r.cursor
      if (!r.hasMore) break
    }
    expect(await connector.health(conn)).toEqual({ status: 'ok' })
  })

  it('rejects a non-RSA or garbage key at connect', async () => {
    const { connector } = make()
    await expect(connector.connect({ apiKey: 'wise-test-token', scaPrivateKey: 'not a key' })).rejects.toMatchObject({ kind: 'invalid_input' })
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    await expect(connector.connect({ apiKey: 'wise-test-token', scaPrivateKey: ec })).rejects.toMatchObject({ kind: 'invalid_input' })
  })
})

describe('wise errors and connect', () => {
  it('401 → auth, not retried; health needs_reauth', async () => {
    const { connector, calls } = make([{ match: () => true, respond: { status: 401, json: { error: 'invalid_token', error_description: 'Invalid token' } } }])
    await expect(runSync(connector, conn, null)).rejects.toMatchObject({ kind: 'auth' })
    expect(calls).toHaveLength(1)
    expect(await connector.health(conn)).toMatchObject({ status: 'needs_reauth', message: expect.stringMatching(/^Wise rejected the personal API token; create a new token/) })
  })

  it('429 with Retry-After is retried; health ok', async () => {
    let n = 0
    const { connector, clock } = make([{ match: (u) => u.pathname.endsWith('/balances') && n++ === 0, respond: { status: 429, headers: { 'retry-after': '2', 'x-rate-limited-by': 'wise-public-api' }, text: '' } }])
    const r = await runSync(connector, conn, null, { maxPages: 1 })
    expect(r.events).toHaveLength(4)
    expect(clock.sleeps).toContain(2000)
    expect(await make().connector.health(conn)).toEqual({ status: 'ok' })
  })

  it('malformed secret → auth', async () => {
    await expect(make().connector.sync({ ...conn, secret: { token: 1 } }, null)).rejects.toMatchObject({ kind: 'auth' })
  })

  it('connect picks the business profile, or the one asked for', async () => {
    const { connector } = make()
    await expect(connector.connect({})).rejects.toMatchObject({ kind: 'invalid_input' })
    const out = await connector.connect({ apiKey: 'wise-test-token' })
    expect(out.secret).toEqual({ token: 'wise-test-token' })
    expect(out.config).toMatchObject({ profileId: '2002', profileType: 'business', name: 'Example Labs Ltd' })
    expect(out.config.warnings).toHaveLength(2)
    const personal = await connector.connect({ apiKey: 'wise-test-token', profileId: 1001 })
    expect(personal.config).toMatchObject({ profileId: '1001', profileType: 'personal', name: 'Test Person' })
    await expect(connector.connect({ apiKey: 'wise-test-token', profileId: 9 })).rejects.toMatchObject({ kind: 'invalid_input' })
  })

  it('begin and describe', async () => {
    const { connector } = make()
    expect(await connector.begin()).toMatchObject({ kind: 'api_key', helpUrl: expect.stringContaining('wise.com') })
    expect(connector.describe()).toMatchObject({ key: 'wise', group: 'banks', auth: 'api_key' })
  })
})

describe('wise webhooks', () => {
  // Stand-in for Wise's signing key pair (Wise publishes the public half).
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const body = JSON.stringify({ data: { resource: { type: 'balance-account', id: 102, profile_id: 2002 }, amount: 10, balance_id: 102, currency: 'EUR', transaction_type: 'credit', occurred_at: '2026-10-09T11:00:00Z' }, subscription_id: 'sub_1', event_type: 'balances#update', schema_version: '4.0.0', sent_at: '2026-10-09T11:00:01Z' })
  const sig = (b: string) => sign('sha256', Buffer.from(b), privateKey).toString('base64')

  it('verifies RSA signatures', async () => {
    const { connector } = make([], { webhookPublicKey: publicPem })
    await expect(connector.webhook!.verify({ headers: { 'x-signature-sha256': sig(body) }, body })).resolves.toBeUndefined()
    const key = publicKey
    expect(() => verifyWiseWebhook({ headers: { 'x-signature-sha256': sig(body) }, body: body.replace('2002', '2003') }, key)).toThrow(/signature/)
    expect(() => verifyWiseWebhook({ headers: { 'x-signature-sha256': 'garbage' }, body }, key)).toThrow(/signature/)
    expect(() => verifyWiseWebhook({ headers: {}, body }, key)).toThrow(/missing/)
  })

  it('interprets events', () => {
    expect(make().connector.webhook).toBeUndefined()
    expect(interpretWiseWebhook({ headers: { 'x-delivery-id': 'd1' }, body })).toEqual({ action: 'sync', dedupeKey: 'wise:d1', reason: 'balances#update', match: { field: 'profileId', value: '2002' } })
    expect(interpretWiseWebhook({ headers: { 'x-test-notification': 'true' }, body }).action).toBe('ignore')
    expect(interpretWiseWebhook({ headers: {}, body: JSON.stringify({ event_type: 'cards#updated' }) }).action).toBe('ignore')
  })
})
