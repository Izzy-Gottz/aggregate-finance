import { describe, expect, it } from 'vitest'
import type { Connector, ConnectionRef, NormalizedEvent, SyncResult } from '@agfn/contracts'
import {
  providerFx,
  rateString,
  ConnectorError,
  parseTokenResponse,
  HttpClient,
  MemoryRawSink,
  OAuthClient,
  RateLimiter,
  cursorCodec,
  dedupeEvents,
  healthFromError,
  hmac,
  instantAt,
  isoDate,
  minorMoney,
  money,
  parseRetryAfter,
  plainError,
  rawId,
  runSync,
  signatureMatches,
  toMinor,
} from './index.ts'
import { assertRedacted, assertValidEvents, fakeClock, fixtureFetch, redact, runConnectorContract } from './testing.ts'

describe('toMinor (golden answers)', () => {
  const cases: Array<[string | number, string, number]> = [
    ['1234.56', 'USD', 123456],
    ['-0.05', 'USD', -5],
    ['1,234.5', 'USD', 123450],
    ['(12.00)', 'USD', -1200],
    ['$12', 'USD', 1200],
    ['12.00-', 'USD', -1200],
    [0.1 + 0.2, 'USD', 30],
    [12.345, 'USD', 1235],
    [-12.345, 'USD', -1235],
    [1e3, 'USD', 100000],
    ['1000', 'JPY', 1000],
    ['1.2345', 'KWD', 1235],
    ['.5', 'EUR', 50],
    ['-0', 'USD', 0],
    [1e-7, 'USD', 0],
    ['USD 12.50', 'USD', 1250],
    ['12.50 EUR', 'EUR', 1250],
  ]
  it.each(cases)('%s %s → %d', (v, c, want) => {
    expect(toMinor(v, c)).toBe(want)
  })
  it('handles European formats only when asked, and never guesses', () => {
    expect(toMinor('10.000,00', 'EUR', { decimal: ',' })).toBe(1000000)
    expect(toMinor('1 234,5', 'EUR', { decimal: ',' })).toBe(123450)
    expect(toMinor('-1,5', 'EUR', { decimal: ',' })).toBe(-150)
    expect(() => toMinor('12.34', 'EUR', { decimal: ',' })).toThrow(/ambiguous/)
    expect(toMinor('12.345', 'EUR', { decimal: ',' })).toBe(1234500)
    expect(() => toMinor('10.000,00', 'EUR')).toThrow(/ambiguous/)
    expect(() => toMinor('1,5', 'USD')).toThrow(/ambiguous/)
    expect(() => toMinor('1,23,456.00', 'USD')).toThrow(/ambiguous/)
    expect(() => toMinor('1.2.3', 'USD')).toThrow(ConnectorError)
    expect(toMinor('1,234,567.89', 'USD')).toBe(123456789)
  })
  it('rejects garbage', () => {
    expect(() => toMinor('12abc', 'USD')).toThrow(ConnectorError)
    expect(() => toMinor(Number.NaN, 'USD')).toThrow(ConnectorError)
    expect(() => toMinor('', 'USD')).toThrow(ConnectorError)
  })
  it('money and minorMoney normalize currency', () => {
    expect(money('1.00', 'usd')).toEqual({ minor: 100, currency: 'USD' })
    expect(minorMoney(-250, 'eur')).toEqual({ minor: -250, currency: 'EUR' })
    expect(() => minorMoney(1.5, 'USD')).toThrow(ConnectorError)
  })
})

describe('instantAt (an event at-instant only for a real intraday moment)', () => {
  it('carries a real intraday timestamp (string or epoch), normalized to ISO', () => {
    expect(instantAt('2026-10-31T23:30:00-04:00')).toBe('2026-11-01T03:30:00.000Z')
    expect(instantAt('2026-10-31T23:30:00.000Z')).toBe('2026-10-31T23:30:00.000Z')
    expect(instantAt(1791021700)).toBe('2026-10-03T10:01:40.000Z') // epoch seconds
  })
  it('returns undefined for a date-only value or an exact UTC-midnight stamp (carrying it would shift the day back)', () => {
    expect(instantAt('2026-10-31')).toBeUndefined()
    expect(instantAt('2026-10-31T00:00:00Z')).toBeUndefined()
    expect(instantAt('2026-10-31T00:00:00.000Z')).toBeUndefined()
  })
  it('returns undefined for missing or unparseable input', () => {
    expect(instantAt(undefined)).toBeUndefined()
    expect(instantAt(null)).toBeUndefined()
    expect(instantAt('')).toBeUndefined()
    expect(instantAt('not a date')).toBeUndefined()
  })
})

describe('plainError (what the person sees on a failed sync — provider text never shown)', () => {
  const err = (kind: 'auth' | 'rate_limited' | 'transient' | 'permanent', extra: Record<string, unknown> = {}) =>
    new ConnectorError(kind, 'raw provider stack trace', { provider: 'x', ...extra })
  it('an expired/revoked token (401) becomes needs_reauth with a plain reconnect message', () => {
    const r = plainError(err('auth', { status: 401 }), 'Mercury')
    expect(r.status).toBe('needs_reauth')
    expect(r.message).toMatch(/[Rr]econnect/)
    expect(r.message).not.toContain('raw provider stack trace')
  })
  it('a missing-permission auth failure (403) asks to reconnect and allow read access', () => {
    const r = plainError(err('auth', { status: 403 }), 'Mercury')
    expect(r.status).toBe('needs_reauth')
    expect(r.message).toMatch(/read/)
  })
  it('rate-limited and transient stay a plain error, not needs_reauth', () => {
    expect(plainError(err('rate_limited'), 'Mercury').status).toBe('error')
    expect(plainError(err('transient'), 'Mercury').status).toBe('error')
    expect(plainError(err('transient'), 'Mercury').message).not.toContain('raw provider stack trace')
  })
})

describe('HttpClient', () => {
  it('a ConnectorError thrown by the fetch keeps its kind: a refusal is not retried as a network error', async () => {
    let calls = 0
    const refused = new ConnectorError('permanent', 'refused', { provider: 'x', forUser: true })
    const fetch = async () => {
      calls++
      throw refused
    }
    const http = new HttpClient({ provider: 'x', baseUrl: 'https://api.example.com', fetch, clock: fakeClock() })
    await expect(http.request({ path: '/a' })).rejects.toBe(refused)
    expect(calls).toBe(1)
  })

  it('retries 5xx and 429 with Retry-After, then succeeds', async () => {
    const clock = fakeClock()
    const fx = fixtureFetch([
      {
        match: '/thing',
        respond: [
          { status: 503, json: { message: 'down' } },
          { status: 429, json: {}, headers: { 'retry-after': '2' } },
          { json: { ok: true } },
        ],
      },
    ])
    const http = new HttpClient({ provider: 'x', baseUrl: 'https://api.example.com', fetch: fx.fetch, clock, random: () => 0.5 })
    const res = await http.request<{ ok: boolean }>({ path: '/thing' })
    expect(res.data.ok).toBe(true)
    expect(fx.calls).toHaveLength(3)
    expect(clock.sleeps).toEqual([250, 2000])
  })

  it('retries a persistent 5xx up to the budget, then fails visibly (never a partial success)', async () => {
    const clock = fakeClock()
    const fx = fixtureFetch([{ match: '/thing', respond: { status: 503, json: { message: 'down' } } }])
    const http = new HttpClient({ provider: 'x', baseUrl: 'https://api.example.com', fetch: fx.fetch, clock, random: () => 0.5, retry: { maxAttempts: 3 } })
    await expect(http.request({ path: '/thing' })).rejects.toMatchObject({ kind: 'transient' })
    expect(fx.calls).toHaveLength(3) // tried the whole budget
    expect(clock.sleeps).toHaveLength(2) // slept between attempts, then gave up
  })

  it('retries a persistent 429 up to the budget, then fails rate_limited', async () => {
    const clock = fakeClock()
    const fx = fixtureFetch([{ match: '/thing', respond: { status: 429, json: {} } }])
    const http = new HttpClient({ provider: 'x', baseUrl: 'https://api.example.com', fetch: fx.fetch, clock, random: () => 0.5, retry: { maxAttempts: 4 } })
    await expect(http.request({ path: '/thing' })).rejects.toMatchObject({ kind: 'rate_limited' })
    expect(fx.calls).toHaveLength(4)
  })

  it('throws a long Retry-After at once (no in-process wait) so the scheduler retries later', async () => {
    const clock = fakeClock()
    const fx = fixtureFetch([{ match: '/thing', respond: { status: 429, json: {}, headers: { 'retry-after': '86400' } } }])
    const http = new HttpClient({ provider: 'x', baseUrl: 'https://api.example.com', fetch: fx.fetch, clock, random: () => 0.5 })
    await expect(http.request({ path: '/thing' })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 86_400_000 })
    expect(fx.calls).toHaveLength(1) // not retried in-process
    expect(clock.sleeps).toEqual([])
  })

  it('does not retry a non-idempotent POST', async () => {
    const fx = fixtureFetch([{ match: '/w', respond: { status: 500, json: {} } }])
    const http = new HttpClient({ provider: 'x', baseUrl: 'https://api.example.com', fetch: fx.fetch, clock: fakeClock() })
    await expect(http.request({ method: 'POST', path: '/w', json: {} })).rejects.toMatchObject({ kind: 'transient' })
    expect(fx.calls).toHaveLength(1)
  })

  it('classifies 401 as auth without retrying and keeps provider message', async () => {
    const fx = fixtureFetch([{ match: '/a', respond: { status: 401, json: { error: { message: 'bad key', code: 'k' } } } }])
    const http = new HttpClient({ provider: 'x', baseUrl: 'https://api.example.com', fetch: fx.fetch, clock: fakeClock() })
    await expect(http.request({ path: '/a' })).rejects.toMatchObject({ kind: 'auth', message: 'bad key', code: 'k', status: 401 })
    expect(fx.calls).toHaveLength(1)
  })

  it('puts the provider request id header on errors (QuickBooks intuit_tid), and only when configured', async () => {
    const respond = { status: 400, json: { Fault: {} }, headers: { intuit_tid: '1-6a2b3c-abc123' } }
    const fx = fixtureFetch([{ match: '/q', respond }])
    const http = new HttpClient({ provider: 'x', baseUrl: 'https://api.example.com', fetch: fx.fetch, clock: fakeClock(), requestIdHeader: 'intuit_tid' })
    await expect(http.request({ path: '/q' })).rejects.toMatchObject({ kind: 'permanent', status: 400, requestId: '1-6a2b3c-abc123' })
    // Kept through a retryable error with Retry-After, and never taken from a junk value.
    const fx2 = fixtureFetch([{ match: '/r', respond: { status: 429, json: {}, headers: { intuit_tid: 'tid-9', 'retry-after': '3600' } } }])
    await expect(new HttpClient({ provider: 'x', baseUrl: 'https://api.example.com', fetch: fx2.fetch, clock: fakeClock(), requestIdHeader: 'intuit_tid' }).request({ path: '/r' })).rejects.toMatchObject({ kind: 'rate_limited', requestId: 'tid-9' })
    const fx3 = fixtureFetch([{ match: '/q', respond: { ...respond, headers: { intuit_tid: 'has spaces <script>' } } }])
    const e3 = await new HttpClient({ provider: 'x', baseUrl: 'https://api.example.com', fetch: fx3.fetch, clock: fakeClock(), requestIdHeader: 'intuit_tid' }).request({ path: '/q' }).catch((e: unknown) => e)
    expect((e3 as { requestId?: string }).requestId).toBeUndefined()
    const fx4 = fixtureFetch([{ match: '/q', respond }])
    const e4 = await new HttpClient({ provider: 'x', baseUrl: 'https://api.example.com', fetch: fx4.fetch, clock: fakeClock() }).request({ path: '/q' }).catch((e: unknown) => e)
    expect((e4 as { requestId?: string }).requestId).toBeUndefined()
  })

  it('gives up after maxAttempts', async () => {
    const fx = fixtureFetch([{ match: '/a', respond: { status: 502, json: {} } }])
    const http = new HttpClient({ provider: 'x', baseUrl: 'https://api.example.com', fetch: fx.fetch, clock: fakeClock(), retry: { maxAttempts: 3 } })
    await expect(http.request({ path: '/a' })).rejects.toMatchObject({ kind: 'transient', status: 502 })
    expect(fx.calls).toHaveLength(3)
  })

  it('maps network failures to transient', async () => {
    const http = new HttpClient({
      provider: 'x',
      baseUrl: 'https://api.example.com',
      fetch: async () => {
        throw new TypeError('fetch failed')
      },
      clock: fakeClock(),
      retry: { maxAttempts: 1 },
    })
    await expect(http.request({ path: '/a' })).rejects.toMatchObject({ kind: 'transient' })
  })

  it('builds query strings and sends json', async () => {
    const fx = fixtureFetch([{ method: 'POST', match: '/q', respond: { json: {} } }])
    const http = new HttpClient({ provider: 'x', baseUrl: 'https://api.example.com/', fetch: fx.fetch, headers: { authorization: 'Bearer t' } })
    await http.request({ method: 'POST', path: 'q', query: { a: 1, b: undefined, c: ['x', 'y'] }, json: { z: 1 } })
    expect(fx.calls[0]?.url).toBe('https://api.example.com/q?a=1&c=x&c=y')
    expect(fx.calls[0]?.body).toEqual({ z: 1 })
    expect(fx.calls[0]?.headers.authorization).toBe('Bearer t')
  })

  it("a provider's Retry-After wins over the connector's default wait", async () => {
    const clock = fakeClock()
    const fx = fixtureFetch([{ match: '/q', respond: [{ status: 429, json: {}, headers: { 'retry-after': '3' } }, { json: { ok: true } }] }])
    const classifyError = ({ status }: { status: number }) => (status === 429 ? new ConnectorError('rate_limited', 'slow down', { provider: 'x', status, retryAfterMs: 1_500 }) : undefined)
    const http = new HttpClient({ provider: 'x', baseUrl: 'https://api.example.com', fetch: fx.fetch, clock, classifyError })
    expect((await http.request({ path: '/q' })).data).toEqual({ ok: true })
    expect(clock.sleeps).toEqual([3_000])
    // Without the header, the connector's default stands.
    const fx2 = fixtureFetch([{ match: '/q', respond: [{ status: 429, json: {} }, { json: { ok: true } }] }])
    const clock2 = fakeClock()
    await new HttpClient({ provider: 'x', baseUrl: 'https://api.example.com', fetch: fx2.fetch, clock: clock2, classifyError }).request({ path: '/q' })
    expect(clock2.sleeps).toEqual([1_500])
  })

  it('throws at once when Retry-After exceeds maxRetryAfterMs (e.g. daily quota)', async () => {
    const clock = fakeClock()
    const fx = fixtureFetch([{ match: '/q', respond: { status: 429, json: {}, headers: { 'retry-after': '7200' } } }])
    const http = new HttpClient({ provider: 'x', baseUrl: 'https://api.example.com', fetch: fx.fetch, clock, maxRetryAfterMs: 60_000 })
    await expect(http.request({ path: '/q' })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 7_200_000 })
    expect(fx.calls).toHaveLength(1)
    expect(clock.sleeps).toEqual([])
  })

  it('parses Retry-After dates and caps', () => {
    const now = Date.parse('2026-10-09T12:00:00Z')
    expect(parseRetryAfter('Fri, 09 Oct 2026 12:00:05 GMT', now)).toBe(5000)
    expect(parseRetryAfter('99999', now)).toBe(99_999_000)
    expect(parseRetryAfter('soon', now)).toBeUndefined()
  })
})

describe('RateLimiter', () => {
  it('allows a burst then spaces requests', async () => {
    const clock = fakeClock()
    const rl = new RateLimiter(2, 2, clock)
    for (let i = 0; i < 4; i++) await rl.acquire()
    expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBe(1000)
  })
})

describe('cursorCodec', () => {
  const codec = cursorCodec<{ p: string }>('x', 2)
  it('round-trips and rejects bad cursors', () => {
    const c = codec.encode({ p: 'abc' })
    expect(codec.decode(c)).toEqual({ p: 'abc' })
    expect(codec.decode(null)).toBeNull()
    expect(() => codec.decode('%%%')).toThrow(expect.objectContaining({ kind: 'cursor_invalid' }))
    expect(() => cursorCodec('x', 3).decode(c)).toThrow(expect.objectContaining({ kind: 'cursor_invalid' }))
  })
})

describe('raw sink', () => {
  it('is content-addressed and key-order independent', async () => {
    const sink = new MemoryRawSink()
    const a = await sink.put('c1', 'txn', 't1', { a: 1, b: 2 })
    const b = await sink.put('c1', 'txn', 't1', { b: 2, a: 1 })
    expect(a).toBe(b)
    expect(sink.records.size).toBe(1)
    expect(rawId('c1', 'txn', 't1', { a: 2 })).not.toBe(a)
  })
})

// A tiny paginated fake connector over 5 items, 2 per page.
function fakeConnector(raw = new MemoryRawSink()): Connector {
  const items = [1, 2, 3, 4, 5]
  const codec = cursorCodec<{ i: number }>('fake')
  return {
    describe: () => ({ key: 'fake', name: 'Fake', group: 'banks', provides: ['transactions'], freshness: 'now', auth: 'none' }),
    connect: async () => ({ secret: null, config: {} }),
    health: async () => ({ status: 'ok' }),
    async sync(conn, cursor): Promise<SyncResult> {
      const start = codec.decode(cursor)?.i ?? 0
      const events: NormalizedEvent[] = []
      if (start === 0) {
        events.push({ type: 'account.upsert', externalId: 'acc', connectionId: conn.id, name: 'A', accountType: 'depository', currency: 'USD', rawRef: await raw.put(conn.id, 'acc', 'acc', {}) })
      }
      for (const n of items.slice(start, start + 2)) {
        events.push({
          type: 'txn.upsert', externalId: 't' + n, connectionId: conn.id, accountExternalId: 'acc', date: '2026-10-0' + n,
          amount: { minor: n % 2 ? -n * 100 : n * 100, currency: 'USD' }, status: 'posted', rawRef: await raw.put(conn.id, 'txn', 't' + n, { n }),
        })
      }
      const next = start + 2
      return { events, cursor: codec.encode({ i: next }), hasMore: next < items.length }
    },
  }
}
const conn: ConnectionRef = { id: 'c1', workspaceId: 'w1', connectorKey: 'fake', secret: null, config: {} }

describe('runSync', () => {
  it('pages to completion and checkpoints each page', async () => {
    const pages: number[] = []
    const r = await runSync(fakeConnector(), conn, null, { onPage: async (_p, i) => void pages.push(i) })
    expect(r.complete).toBe(true)
    expect(r.pages).toBe(3)
    expect(pages).toEqual([0, 1, 2])
    expect(r.events.filter((e) => e.type === 'txn.upsert')).toHaveLength(5)
  })

  it('stops at maxPages and resumes', async () => {
    const a = await runSync(fakeConnector(), conn, null, { maxPages: 1 })
    expect(a.complete).toBe(false)
    const b = await runSync(fakeConnector(), conn, a.cursor)
    expect(b.complete).toBe(true)
  })

  it('restarts once on cursor_invalid', async () => {
    const r = await runSync(fakeConnector(), conn, 'garbage')
    expect(r.restarted).toBe(true)
    expect(r.complete).toBe(true)
  })

  it('refuses a connector that never advances', async () => {
    const stuck: Connector = { ...fakeConnector(), sync: async () => ({ events: [], cursor: 'same', hasMore: true }) }
    await expect(runSync(stuck, conn, 'same')).rejects.toMatchObject({ kind: 'permanent' })
  })

  it('carries a rotated secret forward', async () => {
    const seen: unknown[] = []
    const c: Connector = {
      ...fakeConnector(),
      sync: async (cn, cursor) => {
        seen.push(cn.secret)
        return { events: [], cursor: cursor === null ? 'a' : 'b', hasMore: cursor === null, updatedSecret: { v: 2 } } as SyncResult
      },
    }
    const r = await runSync(c, { ...conn, secret: { v: 1 } }, null)
    expect(seen).toEqual([{ v: 1 }, { v: 2 }])
    expect(r.updatedSecret).toEqual({ v: 2 })
  })

  it('dedupeEvents keeps the last sighting', () => {
    const e = (minor: number): NormalizedEvent => ({ type: 'txn.upsert', externalId: 't', connectionId: 'c', accountExternalId: 'a', date: '2026-01-01', amount: { minor, currency: 'USD' }, status: 'posted' })
    expect(dedupeEvents([e(1), e(2)])).toEqual([e(2)])
  })
})

describe('contract harness', () => {
  it('passes a well-behaved connector', async () => {
    const report = await runConnectorContract({
      make: () => ({ connector: fakeConnector(), conn }),
      signs: { t1: '-', t2: '+' },
      minEvents: 6,
    })
    expect(report.pages).toBe(3)
  })

  it('catches bad events', () => {
    const base = { connectionId: 'c1', rawRef: 'r' }
    expect(() => assertValidEvents([{ ...base, type: 'txn.upsert', externalId: 't', accountExternalId: 'nope', date: '2026-01-01', amount: { minor: 1, currency: 'USD' }, status: 'posted' }], { connectionId: 'c1' })).toThrow(/unknown account/)
    expect(() => assertValidEvents([
      { ...base, type: 'account.upsert', externalId: 'a', name: 'A', accountType: 'depository', currency: 'USD' },
      { ...base, type: 'txn.upsert', externalId: 't', accountExternalId: 'a', date: '2026-01-01', amount: { minor: 1.5, currency: 'USD' }, status: 'posted' },
    ], { connectionId: 'c1' })).toThrow(/safe integer/)
    expect(() => assertValidEvents([
      { ...base, type: 'account.upsert', externalId: 'a', name: 'A', accountType: 'processor_balance', currency: 'USD' },
      { ...base, type: 'processor.balance_txn', externalId: 'b', accountExternalId: 'a', at: '2026-01-01T00:00:00Z', kind: 'charge', gross: { minor: 100, currency: 'USD' }, fee: { minor: 3, currency: 'USD' }, net: { minor: 98, currency: 'USD' } },
    ], { connectionId: 'c1' })).toThrow(/gross - fee/)
  })

  it('assertRedacted flags secrets and redact scrubs them', () => {
    expect(() => assertRedacted({ k: 'sk_live_abcdefghijkl' })).toThrow(/stripe live key/)
    expect(() => assertRedacted({ e: 'person@gmail.com' })).toThrow(/email/)
    expect(() => assertRedacted({ e: 'ok@example.com', n: '1234' })).not.toThrow()
    expect(redact({ a: { access_token: 'x', keep: 1 } })).toEqual({ a: { access_token: 'REDACTED', keep: 1 } })
  })
})

describe('OAuthClient', () => {
  const base = {
    provider: 'qb', authorizeUrl: 'https://auth.example.com/authorize', tokenUrl: 'https://auth.example.com/token',
    clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://app.example.com/cb', scopes: ['a', 'b'],
  }
  it('builds an authorization url with PKCE', () => {
    const u = new URL(new OAuthClient(base).authorizationUrl({ state: 's', pkce: { verifier: 'v', challenge: 'c', method: 'S256' } }))
    expect(u.searchParams.get('scope')).toBe('a b')
    expect(u.searchParams.get('code_challenge')).toBe('c')
  })
  it('exchanges, then refreshes with rotation, carrying extras', async () => {
    const clock = fakeClock()
    const fx = fixtureFetch([
      {
        match: (_u, _i, body) => (body as Record<string, string>).grant_type === 'authorization_code',
        respond: { json: { access_token: 'at1', refresh_token: 'rt1', expires_in: 3600, realmId: '42' } },
      },
      { match: (_u, _i, body) => (body as Record<string, string>).grant_type === 'refresh_token', respond: { json: { access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 } } },
    ])
    const oc = new OAuthClient({ ...base, fetch: fx.fetch, clock })
    const t1 = await oc.exchangeCode('code')
    expect(t1).toMatchObject({ accessToken: 'at1', refreshToken: 'rt1', extra: { realmId: '42' } })
    expect(fx.calls[0]?.headers.authorization).toMatch(/^Basic /)
    expect((await oc.ensureFresh(t1)).refreshed).toBe(false)
    clock.t += 3600_000
    const { tokens, refreshed } = await oc.ensureFresh(t1)
    expect(refreshed).toBe(true)
    expect(tokens).toMatchObject({ accessToken: 'at2', refreshToken: 'rt2', extra: { realmId: '42' } })
  })
  it('reads absolute expires_at (seconds, ms, ISO) when expires_in is absent', () => {
    const now = Date.parse('2026-10-09T12:00:00Z')
    const at = Date.parse('2026-10-10T12:00:00Z')
    expect(parseTokenResponse({ access_token: 'a', expires_at: at / 1000 }, 'p', now).expiresAt).toBe(at)
    expect(parseTokenResponse({ access_token: 'a', expires_at: at }, 'p', now).expiresAt).toBe(at)
    expect(parseTokenResponse({ access_token: 'a', expires_at: '2026-10-10T12:00:00Z' }, 'p', now).expiresAt).toBe(at)
    expect(parseTokenResponse({ access_token: 'a', expires_at: String(at / 1000) }, 'p', now)).toEqual({ accessToken: 'a', expiresAt: at })
    expect(parseTokenResponse({ access_token: 'a', expires_in: 60, expires_at: 1 }, 'p', now).expiresAt).toBe(now + 60_000)
    expect(parseTokenResponse({ access_token: 'a', expires_at: 'garbage' }, 'p', now).expiresAt).toBeUndefined()
  })
  it('token-call errors carry the provider request id', async () => {
    const fx = fixtureFetch([{ match: '/token', respond: { status: 400, json: { error: 'invalid_grant' }, headers: { intuit_tid: 'tok-tid-1' } } }])
    const oc = new OAuthClient({ ...base, requestIdHeader: 'intuit_tid', fetch: fx.fetch, clock: fakeClock() })
    await expect(oc.refresh({ accessToken: 'a', refreshToken: 'r' })).rejects.toMatchObject({ kind: 'auth', requestId: 'tok-tid-1' })
  })
  it('maps invalid_grant to auth', async () => {
    const fx = fixtureFetch([{ match: '/token', respond: { status: 400, json: { error: 'invalid_grant' } } }])
    const oc = new OAuthClient({ ...base, fetch: fx.fetch, clock: fakeClock() })
    await expect(oc.refresh({ accessToken: 'a', refreshToken: 'r' })).rejects.toMatchObject({ kind: 'auth' })
  })
})

describe('misc', () => {
  it('webhook signatures compare in constant time', () => {
    const sig = hmac('sha256', 'k', 'body')
    expect(signatureMatches(sig, sig.toString('hex'), 'hex')).toBe(true)
    expect(signatureMatches(sig, 'deadbeef', 'hex')).toBe(false)
    expect(signatureMatches(sig, '', 'hex')).toBe(false)
  })
  it('healthFromError', () => {
    expect(healthFromError(new ConnectorError('auth', 'x', { provider: 'p' })).status).toBe('needs_reauth')
    expect(healthFromError(new ConnectorError('rate_limited', 'x', { provider: 'p' })).status).toBe('rate_limited')
    expect(healthFromError(new Error('boom')).status).toBe('error')
  })
  it('isoDate handles seconds, ms and dates', () => {
    expect(isoDate(1_760_000_000)).toBe('2025-10-09')
    expect(isoDate('2026-01-02')).toBe('2026-01-02')
    expect(isoDate('2026-01-02T23:00:00Z')).toBe('2026-01-02')
  })
})

describe('assertValidEvents: listings and provider rates', () => {
  const inv = { type: 'invoice.upsert', externalId: 'i1', connectionId: 'c1', rawRef: 'r', direction: 'receivable', issueDate: '2026-09-01', counterparty: 'A', total: { minor: 100, currency: 'EUR' }, amountPaid: { minor: 0, currency: 'EUR' }, status: 'open', lines: [] } as unknown as NormalizedEvent
  it('a completed listing needs no rawRef; its kinds and startedAt are checked', () => {
    expect(() => assertValidEvents([{ type: 'listing.complete', externalId: 'listing:1', connectionId: 'c1', kinds: ['invoice', 'bill', 'credit_note'], startedAt: '2026-10-11T00:00:00Z' }], { connectionId: 'c1' })).not.toThrow()
    expect(() => assertValidEvents([{ type: 'listing.complete', externalId: 'listing:1', connectionId: 'c1', kinds: [], startedAt: '2026-10-11T00:00:00Z' }], { connectionId: 'c1' })).toThrow(/bad kinds/)
  })
  it('fx needs a positive decimal rate and a home currency', () => {
    expect(() => assertValidEvents([{ ...inv, fx: { rate: '1.0825', home: 'USD' } } as NormalizedEvent], { connectionId: 'c1' })).not.toThrow()
    expect(() => assertValidEvents([{ ...inv, fx: { rate: '-1', home: 'USD' } } as NormalizedEvent], { connectionId: 'c1' })).toThrow(/fx.rate/)
    expect(() => assertValidEvents([{ ...inv, fx: { rate: '1.1', home: 'usd' } } as NormalizedEvent], { connectionId: 'c1' })).toThrow(/fx.home/)
  })
})

describe('provider exchange rates', () => {
  it('rateString: plain positive decimals, never exponent notation', () => {
    expect(rateString(1.085)).toBe('1.085')
    expect(rateString('0.006712')).toBe('0.006712')
    expect(rateString(1e-7)).toBe('0.0000001')
    expect(rateString(1 / 3)).toBe('0.333333333333')
    for (const bad of [0, -1, NaN, Infinity, 'x', null, undefined]) expect(rateString(bad)).toBeUndefined()
  })
  it('providerFx only for a document not in the home currency', () => {
    expect(providerFx('EUR', 'USD', 1.1)).toEqual({ rate: '1.1', home: 'USD' })
    expect(providerFx('USD', 'USD', 1)).toBeUndefined()
    expect(providerFx('EUR', 'USD', undefined)).toBeUndefined()
  })
})

