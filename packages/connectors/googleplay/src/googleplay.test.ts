import { crc32, deflateRawSync } from 'node:zlib'
import { generateKeyPairSync, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AccountUpsert, ConnectionRef, NormalizedEvent, ProcessorBalanceTxn } from '@agfn/contracts'
import { MemoryRawSink, runSync, type FetchLike } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, runConnectorContract } from '@agfn/connector-sdk/testing'
import {
  aggregateEarnings,
  createGooglePlayConnector,
  normalizeBucket,
  parseCsv,
  playTimestamp,
  readZip,
  serviceAccountAssertion,
  GCS_READ_SCOPE,
  GOOGLE_TOKEN_URL,
} from './index.ts'

const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/earnings.json', import.meta.url), 'utf8')) as {
  list: Record<string, unknown>
  csv: Record<string, string>
  token: unknown
  errors: Record<'invalid_grant' | 'forbidden' | 'unauthorized' | 'rate_limited', unknown>
}

/** Tiny ZIP writer for tests: one local header + central directory per entry, deflate or stored. */
function makeZip(files: Array<{ name: string; data: Buffer; store?: boolean }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name)
    const body = f.store ? f.data : deflateRawSync(f.data)
    const method = f.store ? 0 : 8
    const crc = crc32(f.data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0x800, 6)
    lh.writeUInt16LE(method, 8)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(body.length, 18)
    lh.writeUInt32LE(f.data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    locals.push(lh, name, body)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x800, 8)
    ch.writeUInt16LE(method, 10)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(body.length, 20)
    ch.writeUInt32LE(f.data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(offset, 42)
    centrals.push(ch, name)
    offset += 30 + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
const SA_JSON = JSON.stringify({ type: 'service_account', project_id: 'example', client_email: 'reports@example.com', private_key: PEM, token_uri: GOOGLE_TOKEN_URL })
const BUCKET = 'pubsite_prod_rev_0101'

const conn: ConnectionRef = {
  id: 'conn_play',
  workspaceId: 'ws1',
  connectorKey: 'googleplay',
  secret: { clientEmail: 'reports@example.com', privateKey: PEM },
  config: { bucket: BUCKET },
}

interface Call {
  method: string
  url: URL
  headers: Record<string, string>
  body: string | undefined
}
type Override = (u: URL, n: number) => Response | undefined

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

function googleFetch(override?: Override): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input)
    calls.push({ method: init?.method ?? 'GET', url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: typeof init?.body === 'string' ? init.body : undefined })
    const o = override?.(url, calls.length)
    if (o) return o
    if (url.href === GOOGLE_TOKEN_URL) return json(200, fx.token)
    const listPath = `/storage/v1/b/${BUCKET}/o`
    if (url.pathname === listPath) return json(200, fx.list[url.searchParams.get('pageToken') ?? ''])
    if (url.pathname.startsWith(listPath + '/') && url.searchParams.get('alt') === 'media') {
      const name = decodeURIComponent(url.pathname.slice(listPath.length + 1))
      const csv = fx.csv[name]
      if (csv === undefined) return json(404, { error: { code: 404, message: 'No such object' } })
      return new Response(new Uint8Array(makeZip([{ name: name.replace('earnings/', '').replace('.zip', '.csv'), data: Buffer.from(csv) }])), { status: 200, headers: { 'content-type': 'application/zip' } })
    }
    throw new Error(`no fixture for ${url.href}`)
  }
  return { fetch, calls }
}

function make(override?: Override) {
  const f = googleFetch(override)
  const clock = fakeClock()
  const connector = createGooglePlayConnector({}, { raw: new MemoryRawSink(), fetch: f.fetch, clock })
  return { connector, conn, calls: f.calls, clock }
}

const find = <T extends NormalizedEvent>(events: NormalizedEvent[], type: T['type'], id: string) =>
  events.find((e) => e.type === type && e.externalId === id) as T | undefined

const O1 = 'GPA.3301-1111-2222-01001'
const O2 = 'GPA.3301-1111-2222-01002'
const O3 = 'GPA.3301-1111-2222-01003'

describe('googleplay contract', () => {
  it('passes the connector contract', async () => {
    const r = await runConnectorContract({
      make: () => make(),
      signs: { [`${O1}:charge:202608`]: '+', [`${O2}:refund:202608`]: '-', [`${O3}:charge:202609`]: '+' },
      minEvents: 7,
    })
    // list, 202608, 202609.
    expect(r.pages).toBe(3)
  })

  it('fixture is redacted', () => {
    assertRedacted(fx)
  })
})

describe('googleplay mapping', () => {
  it('aggregates per order: gross = charge, fee = Google fee, refunds negative, tax separate', async () => {
    const { connector, calls } = make()
    const { events } = await runSync(connector, conn, null)
    const t = (id: string) => find<ProcessorBalanceTxn>(events, 'processor.balance_txn', id)
    expect(t(`${O1}:charge:202608`)).toMatchObject({
      kind: 'charge', accountExternalId: `googleplay:${BUCKET}:USD`, gross: { minor: 999, currency: 'USD' }, fee: { minor: 150 }, net: { minor: 849 },
      at: '2026-08-03T11:33:17.000Z', sourceExternalId: O1,
    })
    expect(t(`${O1}:tax:202608`)).toMatchObject({ kind: 'adjustment', salesTax: true, gross: { minor: 80 }, fee: { minor: 0 }, net: { minor: 80 } })
    expect(t(`${O2}:charge:202608`)).toMatchObject({ gross: { minor: 499 }, fee: { minor: 75 }, net: { minor: 424 }, at: '2026-08-11T06:05:00.000Z' })
    expect(t(`${O2}:refund:202608`)).toMatchObject({ kind: 'refund', gross: { minor: -499 }, fee: { minor: -75 }, net: { minor: -424 } })
    expect(t('row8:other:202608')).toMatchObject({ kind: 'adjustment', net: { minor: 100 } })
    expect(t('row8:other:202608')?.salesTax).toBeUndefined()
    expect(t(`${O3}:charge:202609`)).toMatchObject({ gross: { minor: 1999 }, fee: { minor: 300 }, net: { minor: 1699 } })
    expect(find<AccountUpsert>(events, 'account.upsert', `googleplay:${BUCKET}:USD`)).toMatchObject({ name: 'Google Play earnings (USD)', accountType: 'processor_balance' })
    // Old reports outside the backfill window and non-report objects are not downloaded.
    const downloads = calls.filter((c) => c.url.searchParams.get('alt') === 'media').map((c) => c.url.searchParams.get('generation'))
    expect(downloads).toEqual(['1001', '1002'])
    // One token for the whole sync; read-only calls only (besides the token mint).
    expect(calls.filter((c) => c.url.href === GOOGLE_TOKEN_URL)).toHaveLength(1)
    expect(calls.filter((c) => c.method !== 'GET').map((c) => c.url.href)).toEqual([GOOGLE_TOKEN_URL])
  })

  it('next sync downloads only new or re-generated objects', async () => {
    const { connector, calls } = make()
    const first = await runSync(connector, conn, null)
    const n = calls.length
    const idle = await runSync(connector, conn, first.cursor)
    expect(idle.events).toEqual([])
    expect(calls.slice(n).some((c) => c.url.searchParams.get('alt') === 'media')).toBe(false)
    // Google re-generates the September report.
    const regenerated = make((u) => {
      if (u.pathname.endsWith('/o') && u.searchParams.get('pageToken') === 'tok2') {
        const page = structuredClone(fx.list.tok2) as { items: Array<{ generation: string }> }
        page.items[0]!.generation = '1003'
        return json(200, page)
      }
      return undefined
    })
    const again = await runSync(regenerated.connector, conn, first.cursor)
    expect(regenerated.calls.filter((c) => c.url.searchParams.get('alt') === 'media').map((c) => c.url.searchParams.get('generation'))).toEqual(['1003'])
    expect(again.events.map((e) => e.externalId)).toEqual([`${O3}:charge:202609`])
  })

  it('reads deflate and stored ZIP entries and rejects garbage', () => {
    const zip = makeZip([{ name: 'a.csv', data: Buffer.from('x,y\n1,2\n') }, { name: 'b.txt', data: Buffer.from('stored'), store: true }])
    expect(readZip(zip).map((e) => [e.name, e.data.toString()])).toEqual([['a.csv', 'x,y\n1,2\n'], ['b.txt', 'stored']])
    expect(() => readZip(Buffer.from('not a zip at all, definitely not'))).toThrow(/unreadable ZIP/)
  })

  it('parses quoted CSV and Pacific timestamps', () => {
    expect(parseCsv('a,"b, ""c""",d\r\n1,2,3')).toEqual([['a', 'b, "c"', 'd'], ['1', '2', '3']])
    expect(playTimestamp('Nov 30, 2016', '11:59:59 PM PST')).toBe('2016-12-01T07:59:59.000Z')
    expect(playTimestamp('Sep 2, 2026', '12:15:00 AM PDT')).toBe('2026-09-02T07:15:00.000Z')
    expect(playTimestamp('garbage', '')).toBeUndefined()
    expect(aggregateEarnings(fx.csv['earnings/earnings_202609_0101.zip']!, '202609')).toHaveLength(1)
    expect(normalizeBucket('gs://pubsite_prod_rev_0101/earnings/')).toBe(BUCKET)
  })
})

describe('googleplay service-account JWT', () => {
  it('signs an RS256 JWT bearer assertion with the read-only scope', async () => {
    const now = Date.parse('2026-10-09T12:00:00Z')
    const jwt = serviceAccountAssertion({ clientEmail: 'reports@example.com', privateKey: PEM }, now)
    const [h, p, s] = jwt.split('.') as [string, string, string]
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toEqual({ iss: 'reports@example.com', scope: GCS_READ_SCOPE, aud: GOOGLE_TOKEN_URL, iat: now / 1000, exp: now / 1000 + 3600 })
    expect(verify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'))).toBe(true)

    const { connector, calls } = make()
    await connector.sync(conn, null)
    const form = new URLSearchParams(calls[0]!.body)
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    expect(form.get('assertion')?.split('.')).toHaveLength(3)
    expect(calls[1]!.headers.authorization).toBe('Bearer ya29.fixture-token')
  })
})

describe('googleplay errors and connect', () => {
  it('invalid_grant and 401 are auth; 403 explains the Play permission; health needs_reauth', async () => {
    const grant = make((u) => (u.href === GOOGLE_TOKEN_URL ? json(400, fx.errors.invalid_grant) : undefined))
    await expect(runSync(grant.connector, conn, null)).rejects.toMatchObject({ kind: 'auth', code: 'invalid_grant' })
    expect((await grant.connector.health(conn)).status).toBe('needs_reauth')
    const un = make((u) => (u.pathname.endsWith('/o') ? json(401, fx.errors.unauthorized) : undefined))
    await expect(runSync(un.connector, conn, null)).rejects.toMatchObject({ kind: 'auth' })
    const fb = make((u) => (u.pathname.endsWith('/o') ? json(403, fx.errors.forbidden) : undefined))
    await expect(runSync(fb.connector, conn, null)).rejects.toThrow(/View financial data/)
    expect(await make().connector.health(conn)).toEqual({ status: 'ok' })
  })

  it('429 with Retry-After is retried', async () => {
    const { connector, clock } = make((u, n) => (u.pathname.endsWith('/o') && n === 2 ? json(429, fx.errors.rate_limited, { 'retry-after': '4' }) : undefined))
    const page = await connector.sync(conn, null)
    expect(page.hasMore).toBe(true)
    expect(clock.sleeps).toContain(4000)
  })

  it('malformed stored secret is auth', async () => {
    await expect(make().connector.sync({ ...conn, secret: { clientEmail: 'x' } }, null)).rejects.toMatchObject({ kind: 'auth' })
  })

  it('connect validates the key JSON and bucket, then lists once', async () => {
    const { connector, calls } = make()
    await expect(connector.connect({ bucket: BUCKET })).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(connector.connect({ serviceAccountJson: '{nope', bucket: BUCKET })).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(connector.connect({ serviceAccountJson: SA_JSON, bucket: 'my-bucket' })).rejects.toMatchObject({ kind: 'invalid_input' })
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    await expect(connector.connect({ serviceAccountJson: { client_email: 'a@example.com', private_key: ec }, bucket: BUCKET })).rejects.toThrow(/RSA/)
    const out = await connector.connect({ serviceAccountJson: SA_JSON, bucket: `gs://${BUCKET}` })
    expect(out.secret).toEqual({ clientEmail: 'reports@example.com', privateKey: PEM })
    expect(out.config).toMatchObject({ bucket: BUCKET, clientEmail: 'reports@example.com' })
    expect(calls.at(-1)?.url.searchParams.get('maxResults')).toBe('1')
  })

  it('begin says what is needed', async () => {
    const b = await make().connector.begin()
    expect(b.kind === 'api_key' && b.steps?.join(' ')).toMatch(/JSON key.*Cloud Storage URI/)
  })
})
