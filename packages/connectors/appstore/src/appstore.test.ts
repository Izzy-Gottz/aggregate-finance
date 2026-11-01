import { generateKeyPairSync, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { AccountUpsert, ConnectionRef, NormalizedEvent, ProcessorBalanceTxn } from '@agfn/contracts'
import { MemoryRawSink, runSync, type FetchLike } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, runConnectorContract } from '@agfn/connector-sdk/testing'
import { addMonths, aggregateProceeds, appStoreJwt, createAppStoreConnector, parseFinanceReport, type AppStoreConnectorOptions } from './index.ts'

const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/finance-reports.json', import.meta.url), 'utf8')) as {
  reports: Record<string, string>
  errors: Record<'unauthorized' | 'forbidden' | 'not_found' | 'rate_limited', unknown>
}

// A throwaway P-256 key generated per test run (never a real .p8).
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const PEM = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
const ISSUER = '69a6de7f-0000-47e3-e053-5b8c7c11a4d1'
const KEY_ID = 'ABC123DEFG'

const conn: ConnectionRef = {
  id: 'conn_appstore',
  workspaceId: 'ws1',
  connectorKey: 'appstore',
  secret: { issuerId: ISSUER, keyId: KEY_ID, privateKey: PEM },
  config: { vendorNumber: '85000001', keyId: KEY_ID },
}

interface Call {
  url: URL
  headers: Record<string, string>
}

type Override = (u: URL, n: number) => Response | undefined

/** Serves gzip reports as bytes (fixtureFetch only serves text). Reports not in the fixture are Apple's 404. */
function appleFetch(override?: Override): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input)
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) })
    const o = override?.(url, calls.length)
    if (o) return o
    if (url.pathname !== '/v1/financeReports') throw new Error(`no fixture for ${url.pathname}`)
    const tsv = fx.reports[url.searchParams.get('filter[reportDate]') ?? '']
    if (tsv === undefined) return json(404, fx.errors.not_found)
    return new Response(gzipSync(Buffer.from(tsv)), { status: 200, headers: { 'content-type': 'application/a-gzip' } })
  }
  return { fetch, calls }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

function make(override?: Override, opts: AppStoreConnectorOptions = { backfillMonths: 3 }) {
  const f = appleFetch(override)
  const clock = fakeClock()
  const connector = createAppStoreConnector(opts, { raw: new MemoryRawSink(), fetch: f.fetch, clock })
  return { connector, conn, calls: f.calls, clock }
}

const find = <T extends NormalizedEvent>(events: NormalizedEvent[], type: T['type'], id: string) =>
  events.find((e) => e.type === type && e.externalId === id) as T | undefined

describe('appstore contract', () => {
  it('passes the connector contract', async () => {
    const r = await runConnectorContract({
      make: () => make(),
      signs: { '2026-07:USD:US:S': '+', '2026-07:USD:US:R': '-', '2026-07:CAD:CA:R': '-', '2026-09:JPY:JP:S': '+' },
      minEvents: 10,
    })
    // 2026-07, 2026-08 (no report), 2026-09.
    expect(r.pages).toBe(3)
  })

  it('fixture is redacted', () => {
    assertRedacted(fx)
  })
})

describe('appstore mapping', () => {
  it('aggregates proceeds per month, currency, country and sale/return', async () => {
    const { connector, calls } = make()
    const { events } = await runSync(connector, conn, null)
    const t = (id: string) => find<ProcessorBalanceTxn>(events, 'processor.balance_txn', id)
    expect(t('2026-07:USD:US:S')).toMatchObject({
      kind: 'charge', accountExternalId: 'appstore:85000001:USD', gross: { minor: 910, currency: 'USD' }, fee: { minor: 0 }, net: { minor: 910 },
      at: '2026-08-01T00:00:00.000Z',
    })
    expect(t('2026-07:USD:US:R')).toMatchObject({ kind: 'refund', net: { minor: -70 } })
    expect(t('2026-07:USD:MX:S')?.net.minor).toBe(280)
    expect(t('2026-07:CAD:CA:S')).toMatchObject({ net: { minor: 210, currency: 'CAD' }, accountExternalId: 'appstore:85000001:CAD' })
    // An R row with a positive amount is still a refund (negative).
    expect(t('2026-07:CAD:CA:R')?.net.minor).toBe(-105)
    expect(t('2026-09:JPY:JP:S')?.net).toEqual({ minor: 12, currency: 'JPY' })
    expect(find<AccountUpsert>(events, 'account.upsert', 'appstore:85000001:JPY')).toMatchObject({ name: 'App Store proceeds (JPY)', accountType: 'processor_balance' })
    expect(events.filter((e) => e.type === 'account.upsert')).toHaveLength(3)
    const q = calls[0]!.url.searchParams
    expect(Object.fromEntries(q)).toEqual({ 'filter[regionCode]': 'ZZ', 'filter[reportType]': 'FINANCIAL', 'filter[reportDate]': '2026-07', 'filter[vendorNumber]': '85000001' })
    expect(calls[0]!.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
    // One token reused across the sync.
    expect(new Set(calls.map((c) => c.headers.authorization)).size).toBe(1)
  })

  it('a 404 for the latest month means "not published yet": stop and keep the cursor', async () => {
    const { connector, calls } = make((u) => (u.searchParams.get('filter[reportDate]') === '2026-09' ? json(404, fx.errors.not_found) : undefined))
    const first = await runSync(connector, conn, null)
    expect(first.complete).toBe(true)
    expect(first.events.some((e) => e.externalId.startsWith('2026-09'))).toBe(false)
    const n = calls.length
    const page = await connector.sync(conn, first.cursor)
    expect(page.cursor).toBe(first.cursor)
    expect(page.hasMore).toBe(false)
    expect(page.warnings).toEqual(["App Store report for 2026-09 isn't published yet"])
    expect(calls.slice(n).map((c) => c.url.searchParams.get('filter[reportDate]'))).toEqual(['2026-09'])
  })

  it('a published latest month carries no warning', async () => {
    const { connector } = make()
    let cursor: string | null = null
    for (;;) {
      const r = await connector.sync(conn, cursor)
      expect(r.warnings).toBeUndefined()
      cursor = r.cursor
      if (!r.hasMore) break
    }
  })

  it('does nothing once caught up', async () => {
    const { connector, calls } = make()
    const first = await runSync(connector, conn, null)
    const n = calls.length
    const again = await runSync(connector, conn, first.cursor)
    expect(again.events).toEqual([])
    expect(calls.length).toBe(n)
  })

  it('parses headers case-insensitively and skips footer lines', () => {
    const rows = parseFinanceReport(fx.reports['2026-07']!)
    expect(rows).toHaveLength(6)
    expect(rows.map((r) => r.country)).toEqual(['US', 'US', 'US', 'MX', 'CA', 'CA'])
    expect(aggregateProceeds('2026-07', rows).map((g) => g.key)).toEqual([
      '2026-07:CAD:CA:R', '2026-07:CAD:CA:S', '2026-07:USD:MX:S', '2026-07:USD:US:R', '2026-07:USD:US:S',
    ])
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(addMonths('2026-12', 1)).toBe('2027-01')
  })
})

describe('appstore JWT', () => {
  it('signs ES256 with a raw r||s signature and Apple claims', () => {
    const now = Date.parse('2026-10-09T12:00:00Z')
    const token = appStoreJwt({ issuerId: ISSUER, keyId: KEY_ID, privateKey: PEM }, now)
    const [h, p, s] = token.split('.') as [string, string, string]
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' })
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString()) as { iss: string; iat: number; exp: number; aud: string }
    expect(payload).toMatchObject({ iss: ISSUER, aud: 'appstoreconnect-v1', iat: now / 1000 })
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(20 * 60)
    const sig = Buffer.from(s, 'base64url')
    expect(sig).toHaveLength(64)
    expect(verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig)).toBe(true)
    // Never more than 20 minutes, even if asked.
    const long = JSON.parse(Buffer.from(appStoreJwt({ issuerId: ISSUER, keyId: KEY_ID, privateKey: PEM }, now, 3600).split('.')[1]!, 'base64url').toString()) as { iat: number; exp: number }
    expect(long.exp - long.iat).toBe(1200)
  })
})

describe('appstore errors and connect', () => {
  it('401 is auth and health needs_reauth; 403 explains Finance access', async () => {
    const un = make(() => json(401, fx.errors.unauthorized))
    await expect(runSync(un.connector, conn, null)).rejects.toMatchObject({ kind: 'auth' })
    expect((await un.connector.health(conn)).status).toBe('needs_reauth')
    const fb = make(() => json(403, fx.errors.forbidden))
    await expect(runSync(fb.connector, conn, null)).rejects.toThrow(/Finance/)
    expect(await make().connector.health(conn)).toEqual({ status: 'ok' })
  })

  it('429 with Retry-After is retried', async () => {
    const { connector, clock } = make((_u, n) => (n === 1 ? json(429, fx.errors.rate_limited, { 'retry-after': '5' }) : undefined))
    const page = await connector.sync(conn, null)
    expect(page.events.length).toBeGreaterThan(0)
    expect(clock.sleeps).toContain(5000)
  })

  it('malformed stored secret is auth', async () => {
    await expect(make().connector.sync({ ...conn, secret: { issuerId: ISSUER } }, null)).rejects.toMatchObject({ kind: 'auth' })
  })

  it('connect validates input and the key type, then probes one report', async () => {
    const { connector, calls } = make()
    const good = { issuerId: ISSUER, keyId: KEY_ID, privateKey: PEM, vendorNumber: '85000001' }
    await expect(connector.connect({})).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(connector.connect({ ...good, keyId: 'short' })).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(connector.connect({ ...good, privateKey: 'not a key' })).rejects.toMatchObject({ kind: 'invalid_input' })
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    await expect(connector.connect({ ...good, privateKey: rsa })).rejects.toThrow(/P-256/)
    // Keys pasted with literal \n are accepted. The probe month (2026-08) has no report: 404 is fine.
    const out = await connector.connect({ ...good, privateKey: PEM.replace(/\n/g, '\\n') })
    expect(out.secret).toEqual({ issuerId: ISSUER, keyId: KEY_ID, privateKey: PEM.trim() })
    expect(out.config).toMatchObject({ vendorNumber: '85000001', keyId: KEY_ID })
    expect(calls.at(-1)?.url.searchParams.get('filter[reportDate]')).toBe('2026-08')
  })

  it('begin says what is needed', async () => {
    const b = await make().connector.begin()
    expect(b).toMatchObject({ kind: 'api_key', helpUrl: expect.stringContaining('appstoreconnect.apple.com') })
    expect(b.kind === 'api_key' && b.steps?.join(' ')).toMatch(/Issuer ID.*Key ID.*vendor number/)
  })
})
