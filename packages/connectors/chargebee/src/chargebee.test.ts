import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ConnectionRef, NormalizedEvent, SubscriptionUpsert } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { CB_FALLBACK_WARNING, createChargebeeConnector, percentFraction, siteFrom } from './index.ts'

const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/chargebee.json', import.meta.url), 'utf8')) as {
  pages: Record<string, unknown>
  coupons: Record<string, unknown>
  errors: { unauthorized: unknown }
}

const conn: ConnectionRef = { id: 'conn_cb', workspaceId: 'ws1', connectorKey: 'chargebee', secret: { site: 'acme', apiKey: 'test_cb_key_redacted_01' }, config: { site: 'acme' } }

function routes(extra: FixtureRoute[] = []): FixtureRoute[] {
  return [
    ...extra,
    { match: (u) => u.hostname === 'acme.chargebee.com' && u.pathname === '/api/v2/subscriptions', respond: (u) => ({ json: fx.pages[u.searchParams.get('offset') ?? ''] ?? { list: [] } }) },
    {
      match: (u) => u.pathname.startsWith('/api/v2/coupons/'),
      respond: (u) => {
        const c = fx.coupons[decodeURIComponent(u.pathname.slice('/api/v2/coupons/'.length))]
        return c ? { json: c } : { status: 404, json: { message: 'not found', api_error_code: 'resource_not_found' } }
      },
    },
  ]
}

function make(extra: FixtureRoute[] = []) {
  const f = fixtureFetch(routes(extra))
  const clock = fakeClock()
  return { connector: createChargebeeConnector({}, { raw: new MemoryRawSink(), fetch: f.fetch, clock }), conn, calls: f.calls }
}

const subs = (events: NormalizedEvent[]) => new Map(events.filter((e): e is SubscriptionUpsert => e.type === 'subscription.upsert').map((e) => [e.externalId, e]))

describe('chargebee contract', () => {
  it('passes the connector contract', async () => {
    const r = await runConnectorContract({ make: () => make(), minEvents: 18 })
    expect(r.pages).toBe(2)
  })
  it('fixture is redacted', () => assertRedacted(fx))
})

describe('chargebee MRR accuracy (independent answers, to the cent)', () => {
  // Worked by hand (Python fractions, rounded half away from zero once per subscription):
  const expected: Record<string, number> = {
    sub_monthly: 5_900, // plan 49.00 + 2 seats × 5.00
    sub_annual: 9_000, // 1,200.00 a year ÷ 12, less 10% (forever, whole invoice)
    sub_quarter: 9_000, // (300.00 − 30.00 off each quarter) ÷ 3
    sub_coupon: 7_425, // 99.00 less coupon LAUNCH25 (25%, forever)
    sub_oldcoupon: 5_000, // coupon OLD10 past its apply_till: no longer counts
    sub_onetime: 3_000, // one-time 50% not included in MRR
    sub_pastdue: 1_999, // an unpaid invoice: past_due still counts
    sub_weekly: 4_333, // 10.00 a week × 52 ÷ 12 = 43.333…
    sub_charge: 1_500, // the one-off setup charge item doesn't count
    sub_criteria: 7_777, // coupon with criteria constraints: Chargebee's own figure, with a warning
    sub_offerqty: 4_000, // 5 seats × 10.00, one seat free
    sub_nonrenewing: 3_300, // ends at term end, still counts until then
    sub_multifreq: 1_200, // 10.00 monthly plan + 24.00 yearly addon (2.00 a month)
    sub_decimal: 8_333, // amount_in_decimal "999.99" a year ÷ 12 = 83.3325
  }

  it('each subscription and the totals (core/src/mrr.chargebee.test.ts runs them through get_mrr_movements)', async () => {
    const { connector } = make()
    const events: NormalizedEvent[] = []
    let cursor: string | null = null
    let warnings: string[] | undefined
    for (;;) {
      const page = await connector.sync(conn, cursor)
      events.push(...page.events)
      cursor = page.cursor
      if (!page.hasMore) {
        warnings = page.warnings
        break
      }
      expect(page.warnings).toBeUndefined()
    }
    const m = subs(events)
    for (const [id, minor] of Object.entries(expected)) {
      expect(m.get(id)?.mrr, id).toEqual({ minor, currency: 'USD' })
      expect(m.get(id)?.status, id).toMatch(/^(active|past_due)$/)
    }
    // Item-level 20% off the 3 seats only: 20.00 + 15.00 × 0.8 = 32.00 EUR.
    expect(m.get('sub_itempct')?.mrr).toEqual({ minor: 3_200, currency: 'EUR' })

    const total = (cur: string) => [...m.values()].filter((e) => e.mrr.currency === cur).reduce((s, e) => s + e.mrr.minor, 0)
    expect(total('USD')).toBe(71_767)
    expect(total('EUR')).toBe(3_200)
    expect(warnings).toEqual([CB_FALLBACK_WARNING(1)])
  })

  it('statuses: trials count nothing, cancellations churn their discounted value, transfers and deletions vanish', async () => {
    const { events } = await runSync(make().connector, conn, null)
    const m = subs(events)
    expect(m.get('sub_trial')).toMatchObject({ status: 'trialing', mrr: { minor: 0 } })
    expect(m.get('sub_nonrenewing')).toMatchObject({ status: 'active', cancelAtPeriodEnd: true })
    expect(m.get('sub_pastdue')?.status).toBe('past_due')
    const c = m.get('sub_cancelled')!
    expect(c).toMatchObject({ status: 'canceled', mrr: { minor: 0 }, endedAt: '2026-03-02T00:00:00.000Z' })
    expect(c.changes).toEqual([{ at: '2026-01-01T00:00:00.000Z', mrr: { minor: 2_500, currency: 'USD' } }])
    expect(m.has('sub_transferred')).toBe(false)
    const d = m.get('sub_deleted')!
    expect(d).toMatchObject({ status: 'incomplete_expired', mrr: { minor: 0 } })
    expect(d.endedAt ?? d.canceledAt).toBeUndefined()
    // Only recurring lines are items (the setup charge isn't).
    expect(m.get('sub_charge')?.items?.map((i) => i.priceExternalId)).toEqual(['sub_charge-plan'])
  })

  it('later syncs ask only for what changed since the newest update seen', async () => {
    const { connector, calls } = make()
    const first = await runSync(connector, conn, null)
    calls.length = 0
    await runSync(connector, conn, first.cursor)
    const u = new URL(calls[0]!.url)
    expect(u.searchParams.get('updated_at[after]')).toBe(String(1_767_225_600 + 19 - 1))
    expect(u.searchParams.get('include_deleted')).toBe('true')
    expect(u.searchParams.get('sort_by[asc]')).toBe('updated_at')
  })
})

describe('chargebee connect and errors', () => {
  it('takes a site name in any common form and checks the key once', async () => {
    expect(siteFrom('Acme')).toBe('acme')
    expect(siteFrom('https://acme-test.chargebee.com/d/subscriptions')).toBe('acme-test')
    expect(siteFrom('acme.example.com/x')).toBeUndefined()
    const { connector, calls } = make()
    const r = await connector.connect({ site: 'acme.chargebee.com', apiKey: 'test_cb_key_redacted_01' })
    expect(r.secret).toEqual({ site: 'acme', apiKey: 'test_cb_key_redacted_01' })
    expect(calls).toHaveLength(1)
    // Basic auth with the key as the user name and no password; only reads.
    expect(calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from('test_cb_key_redacted_01:').toString('base64')}`)
    expect(calls[0]!.method).toBe('GET')
    await expect(connector.connect({ site: 'not a site!', apiKey: 'test_cb_key_redacted_01' })).rejects.toMatchObject({ kind: 'invalid_input' })
  })

  it('a revoked key reads as needs-reauth', async () => {
    const { connector } = make([{ match: () => true, respond: { status: 401, json: fx.errors.unauthorized } }])
    expect((await connector.health(conn)).status).toBe('needs_reauth')
  })

  it('percentages are exact', () => {
    expect(percentFraction(12.5)).toEqual({ n: 1n, d: 8n })
    expect(percentFraction(33.33)).toEqual({ n: 3333n, d: 10000n })
    expect(percentFraction(101)).toBeUndefined()
  })
})
