import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ConnectionRef, NormalizedEvent, SubscriptionUpsert, SyncResult } from '@agfn/contracts'
import { ConnectorError, MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureResponse, type FixtureRoute } from '@agfn/connector-sdk/testing'
import {
  PATREON_CAMPAIGN_FIELDS,
  PATREON_HOSTED_TOKEN_REFUSED,
  PATREON_MEMBER_FIELDS,
  PATREON_SCOPES,
  classifyPatreonError,
  createPatreonConnector,
  mapMember,
  monthlyCents,
  patreonCadenceUnknownWarning,
  patreonNonMonthlyWarning,
  patreonPerCreationWarning,
  type PatreonConnectorOptions,
  type PatreonMember,
} from './index.ts'

interface Fx {
  identity: unknown
  campaigns: Record<string, unknown>
  members: Record<string, Record<string, unknown>>
}
const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/patreon.json', import.meta.url), 'utf8')) as Fx

const API = /^\/api\/oauth2\/v2/
const routes = (over: { members?: (u: URL) => FixtureResponse | undefined } = {}): FixtureRoute[] => [
  { match: (u: URL) => u.pathname === '/api/oauth2/v2/identity', respond: { json: fx.identity } },
  { match: (u: URL) => u.pathname === '/api/oauth2/v2/campaigns', respond: (u: URL) => ({ json: fx.campaigns[u.searchParams.get('page[cursor]') ?? ''] }) },
  {
    match: (u: URL) => /^\/api\/oauth2\/v2\/campaigns\/[^/]+\/members$/.test(u.pathname),
    respond: (u: URL) => over.members?.(u) ?? { json: fx.members[u.pathname.split('/')[5]!]![u.searchParams.get('page[cursor]') ?? ''] },
  },
]

const conn = (secret: unknown = { token: 'creator_token_redacted_01' }): ConnectionRef => ({ id: 'c1', workspaceId: 'w1', connectorKey: 'patreon', secret, config: {} }) as ConnectionRef

function make(opts: Partial<PatreonConnectorOptions> = {}, r = routes(), raw = new MemoryRawSink()) {
  const f = fixtureFetch(r)
  const clock = fakeClock(Date.parse('2026-11-01T12:00:00Z'))
  return { f, clock, raw, connector: createPatreonConnector(opts, { raw, fetch: f.fetch, clock }) }
}

/** A whole cycle page by page; runSync doesn't hand back warnings. */
async function walk(connector: ReturnType<typeof createPatreonConnector>) {
  let cursor: string | null = null
  const events: NormalizedEvent[] = []
  for (;;) {
    const page: SyncResult = await connector.sync(conn(), cursor)
    events.push(...page.events)
    cursor = page.cursor
    if (!page.hasMore) return { events, warnings: page.warnings }
  }
}
const subs = (events: NormalizedEvent[]) => events.filter((e): e is SubscriptionUpsert => e.type === 'subscription.upsert')
const byId = (events: NormalizedEvent[]) => new Map(subs(events).map((e) => [e.externalId, e]))
const member = (attributes: PatreonMember['attributes']): PatreonMember => ({ id: 'm1', attributes })
const CAMPAIGN = { id: 'c-usd', currency: 'USD' }
const map = (a: PatreonMember['attributes']) => mapMember(member(a), CAMPAIGN, '2026-11-01T12:00:00.000Z', 'c1', 'raw1')

describe('monthlyCents', () => {
  it('divides exactly and rounds once, half up', () => {
    expect(monthlyCents(500, 1)).toBe(500)
    expect(monthlyCents(12_000, 12)).toBe(1_000)
    expect(monthlyCents(9_999, 12)).toBe(833) // 833.25
    expect(monthlyCents(10_002, 12)).toBe(834) // 833.5
    expect(monthlyCents(3_000, 3)).toBe(1_000)
  })
})

describe('mapMember: status map', () => {
  it('active with a positive amount is active, at its monthly value', () => {
    const r = map({ patron_status: 'active_patron', currently_entitled_amount_cents: 500, pledge_cadence: 1 })
    expect(r?.event).toMatchObject({ status: 'active', mrr: { minor: 500, currency: 'USD' }, interval: 'month', intervalCount: 1, customer: 'm1' })
  })
  it('annual is per cycle: divided by 12, interval year', () => {
    const r = map({ patron_status: 'active_patron', currently_entitled_amount_cents: 12_000, pledge_cadence: 12 })
    expect(r?.event).toMatchObject({ status: 'active', mrr: { minor: 1_000 }, interval: 'year', intervalCount: 1 })
    expect(r?.nonMonthly).toBe(true)
  })
  it('accepts pledge_cadence as the string the docs say it is', () => {
    expect(map({ patron_status: 'active_patron', currently_entitled_amount_cents: 12_000, pledge_cadence: '12' })?.event.mrr.minor).toBe(1_000)
  })
  it('a missing cadence counts as monthly and is flagged', () => {
    const r = map({ patron_status: 'active_patron', currently_entitled_amount_cents: 250, pledge_cadence: null })
    expect(r?.event.mrr.minor).toBe(250)
    expect(r?.cadenceUnknown).toBe(true)
  })
  it('a free trial is trialing with no MRR, whatever the amount', () => {
    expect(map({ patron_status: 'active_patron', currently_entitled_amount_cents: 1_000, pledge_cadence: 1, is_free_trial: true })?.event).toMatchObject({ status: 'trialing', mrr: { minor: 0 } })
  })
  it('declined is past_due; a zero entitlement falls back to what the next cycle would charge', () => {
    expect(map({ patron_status: 'declined_patron', currently_entitled_amount_cents: 700, pledge_cadence: 1 })?.event).toMatchObject({ status: 'past_due', mrr: { minor: 700 } })
    expect(map({ patron_status: 'declined_patron', currently_entitled_amount_cents: 0, will_pay_amount_cents: 300, pledge_cadence: 1 })?.event).toMatchObject({ status: 'past_due', mrr: { minor: 300 } })
  })
  it('former is canceled with no MRR, ended at the last charge', () => {
    const r = map({ patron_status: 'former_patron', currently_entitled_amount_cents: 500, pledge_cadence: 1, last_charge_date: '2026-08-01T00:00:00.000+00:00', pledge_relationship_start: '2026-01-01T00:00:00.000+00:00' })
    expect(r?.event).toMatchObject({ status: 'canceled', mrr: { minor: 0 }, endedAt: '2026-08-01T00:00:00.000Z', canceledAt: '2026-08-01T00:00:00.000Z' })
  })
  it('a free member who never paid is skipped', () => {
    expect(map({ patron_status: null, currently_entitled_amount_cents: 0, campaign_lifetime_support_cents: 0 })).toBeUndefined()
    expect(map({ patron_status: 'active_patron', currently_entitled_amount_cents: 0, campaign_lifetime_support_cents: 0 })).toBeUndefined()
  })
  it('a free member who used to pay ends the paid subscription (else its old MRR would stay forever)', () => {
    expect(map({ patron_status: null, currently_entitled_amount_cents: 0, campaign_lifetime_support_cents: 1_500, last_charge_date: '2026-05-01T00:00:00.000+00:00' })?.event).toMatchObject({ status: 'canceled', mrr: { minor: 0 } })
  })
  it('a gift is not recurring revenue', () => {
    expect(map({ patron_status: 'active_patron', currently_entitled_amount_cents: 500, is_gifted: true, campaign_lifetime_support_cents: 0 })).toBeUndefined()
  })
})

describe('sync', () => {
  it('passes the connector contract (repeatable, resumes page by page)', async () => {
    const report = await runConnectorContract({ make: () => { const { connector } = make(); return { connector, conn: conn() } }, minEvents: 10 })
    expect(report.events.every((e) => e.type === 'subscription.upsert')).toBe(true)
  })

  it('emits only subscription.upsert: nothing reaches the ledger as money', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn(), null)
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(['subscription.upsert']))
  })

  it('MRR adds up to the hand-computed total, per currency', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn(), null)
    const total = (c: string) => subs(events).filter((e) => e.mrr.currency === c && (e.status === 'active' || e.status === 'past_due')).reduce((s, e) => s + e.mrr.minor, 0)
    // USD: 500 + 12000/12 (1000) + 9999/12 (833) + 700 + 300 + 3000/3 (1000) = 4333. Trial, former, free and gifted add 0.
    expect(total('USD')).toBe(4_333)
    // EUR: 1000 + 250.
    expect(total('EUR')).toBe(1_250)
  })

  it('reads every campaign in its own currency, and skips free members who never paid', async () => {
    const { connector } = make()
    const m = byId((await runSync(connector, conn(), null)).events)
    expect(m.get('m-eur')).toMatchObject({ mrr: { minor: 1_000, currency: 'EUR' } })
    expect(m.get('m-monthly')).toMatchObject({ customer: 'm-monthly', startedAt: '2026-01-15T10:00:00.000Z', currentPeriodEnd: '2026-11-01T00:00:00.000Z' })
    expect(m.has('m-free')).toBe(false)
    expect(m.has('m-gifted')).toBe(false)
    expect(m.get('m-free-after-paying')?.status).toBe('canceled')
    expect(m.size).toBe(12)
  })

  it('per-creation campaigns have no MRR: never read, and the sync says so', async () => {
    const { connector, f } = make()
    const { warnings } = await walk(connector)
    expect(f.calls.some((c) => c.url.includes('/campaigns/c-post/'))).toBe(false)
    expect(warnings).toContain(patreonPerCreationWarning(1))
  })

  it('warns about non-monthly pledges (the docs do not state their unit) and a missing cadence', async () => {
    const { connector } = make()
    const { warnings } = await walk(connector)
    expect(warnings).toContain(patreonNonMonthlyWarning(3))
    expect(warnings).toContain(patreonCadenceUnknownWarning(1))
  })

  it('a campaign without a currency is skipped rather than guessed as USD', async () => {
    const r = routes()
    r[1] = { match: (u: URL) => u.pathname === '/api/oauth2/v2/campaigns', respond: () => ({ json: { data: [{ id: 'c-x', type: 'campaign', attributes: { is_monthly: true } }] } }) }
    const { connector, f } = make({}, r)
    const out = await walk(connector)
    expect(out.events).toEqual([])
    expect(f.calls.some((c) => c.url.includes('/members'))).toBe(false)
    expect(out.warnings?.join(' ')).toMatch(/currency/)
  })

  it('pages with cursors and hasMore, and resumes mid-campaign from the saved cursor', async () => {
    const { connector, f } = make()
    const c = conn()
    const one = await connector.sync(c, null) // campaigns
    expect(one).toMatchObject({ events: [], hasMore: true })
    const two = await connector.sync(c, one.cursor) // USD page 1
    expect(two.hasMore).toBe(true)
    expect(subs(two.events).map((e) => e.externalId)).toContain('m-monthly')

    const again = make()
    const three = await again.connector.sync(c, two.cursor) // a new process carries on at USD page 2
    expect(subs(three.events).map((e) => e.externalId)).toContain('m-trial')
    expect(again.f.calls).toHaveLength(1)
    expect(new URL(again.f.calls[0]!.url).searchParams.get('page[cursor]')).toBe('usd2')
    const four = await again.connector.sync(c, three.cursor) // EUR
    expect(subs(four.events).map((e) => e.externalId)).toEqual(['m-eur', 'm-no-cadence'])
    expect(four.hasMore).toBe(false)
    expect(f.calls.filter((x) => x.url.includes('/members'))).toHaveLength(1)
  })

  it('every cycle is a full walk: the next sync starts over at the campaigns', async () => {
    const { connector, f } = make()
    const first = await runSync(connector, conn(), null)
    const before = f.calls.length
    const second = await runSync(connector, conn(), first.cursor)
    expect(f.calls.length - before).toBe(before)
    expect(second.events).toEqual(first.events)
  })

  it('401 surfaces as needing a new sign-in', async () => {
    const { connector } = make({}, routes({ members: () => ({ status: 401, json: { errors: [{ code_name: 'Unauthorized', status: '401' }] } }) }))
    const c = conn()
    const first = await connector.sync(c, null)
    await expect(connector.sync(c, first.cursor)).rejects.toMatchObject({ kind: 'auth', status: 401 })
    expect(await connector.health({ ...c, secret: c.secret })).toMatchObject({ status: 'ok' })
    const dead = make({}, [{ match: () => true, respond: { status: 401, json: {} } }])
    expect((await dead.connector.health(c)).status).toBe('needs_reauth')
  })

  it('429: waits retry_after_seconds, then carries on', async () => {
    let n = 0
    const { connector, clock } = make({}, routes({
      members: () => (n++ === 0 ? { status: 429, json: { errors: [{ code_name: 'RequestThrottled', retry_after_seconds: 9, status: '429' }] } } : undefined),
    }))
    const { events } = await runSync(connector, conn(), null)
    expect(clock.sleeps).toContain(9_000)
    expect(subs(events).length).toBe(12)
  })

  it('429 with Patreon’s 30-minute edge block goes back to the scheduler instead of sleeping', async () => {
    const { connector, clock } = make({}, routes({ members: () => ({ status: 429, json: { errors: [{ detail: 'Too many bad requests. Time to cool down.', retry_after_seconds: 1800 }] } }) }))
    const c = conn()
    const first = await connector.sync(c, null)
    await expect(connector.sync(c, first.cursor)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 1_800_000 })
    expect(clock.sleeps).not.toContain(1_800_000)
  })

  it('sends a User-Agent on every call (Patreon may drop calls without one)', async () => {
    const { connector, f } = make()
    await runSync(connector, conn(), null)
    expect(f.calls.length).toBeGreaterThan(0)
    for (const c of f.calls) expect(c.headers['user-agent']).toMatch(/Aggregate/)
  })

  it('only ever issues GETs under the v2 API', async () => {
    const { connector, f } = make()
    await runSync(connector, conn(), null)
    for (const c of f.calls) {
      expect(c.method).toBe('GET')
      expect(new URL(c.url).pathname).toMatch(API)
    }
  })
})

describe('no personal data', () => {
  const PII = /full_name|first_name|last_name|email|address|vanity|note|url|user/i

  it('asks only for the fields it needs: never a name or email, and no includes', async () => {
    const { connector, f } = make()
    await connector.connect({ token: 'creator_token_redacted_01' })
    await runSync(connector, conn(), null)
    expect(PATREON_MEMBER_FIELDS.join(',')).not.toMatch(PII)
    expect(PATREON_CAMPAIGN_FIELDS.join(',')).not.toMatch(PII)
    for (const c of f.calls) {
      const q = new URL(c.url).searchParams
      expect(q.get('include')).toBeNull()
      for (const [k, v] of q) {
        if (k.startsWith('page[')) continue
        expect(`${k}=${v}`).not.toMatch(PII)
      }
    }
    const members = f.calls.find((c) => c.url.includes('/members'))!
    expect(new URL(members.url).searchParams.get('fields[member]')).toBe(PATREON_MEMBER_FIELDS.join(','))
  })

  it('never asks for a name or email scope', () => {
    expect(PATREON_SCOPES).toEqual(['identity', 'campaigns', 'campaigns.members'])
  })

  it('stores only the listed fields, even if Patreon sends more', async () => {
    const leaky = { data: [{ id: 'm-leak', type: 'member', attributes: { patron_status: 'active_patron', currently_entitled_amount_cents: 500, pledge_cadence: 1, full_name: 'Real Person', email: 'real@person.test', note: 'creator note' }, relationships: { user: { data: { id: '42', type: 'user' } } } }], meta: { pagination: { cursors: { next: null } } } }
    const raw = new MemoryRawSink()
    const { connector } = make({}, routes({ members: () => ({ json: leaky }) }), raw)
    await runSync(connector, conn(), null)
    const stored = JSON.stringify([...raw.records.values()])
    expect(stored).toContain('m-leak')
    expect(stored).not.toMatch(/Real Person|real@person|creator note|"user"/)
  })

  it('the fixture is clean', () => {
    assertRedacted(fx)
    expect(JSON.stringify(fx)).not.toMatch(/full_name|email/)
  })
})

describe('connecting', () => {
  const oauth = { clientId: 'cid', clientSecret: 'csec', redirectUri: 'https://app.example.com/api/connectors/patreon/callback' }
  const tokenRoute = (json: unknown) => ({ method: 'POST', match: (u: URL) => u.pathname === '/api/oauth2/token', respond: { json } })

  it('without an app, self-hosters paste a Creator’s Access Token', async () => {
    const { connector } = make()
    expect((await connector.begin({ state: 's' })).kind).toBe('api_key')
    const r = await connector.connect({ token: 'creator_token_redacted_01' })
    expect(r.secret).toEqual({ token: 'creator_token_redacted_01' })
    expect(r.config).toMatchObject({ accountId: '9000001' })
  })

  it('hosted refuses a pasted token', async () => {
    const { connector } = make({ hosted: true, oauth })
    await expect(connector.connect({ token: 'creator_token_redacted_01' })).rejects.toThrow(PATREON_HOSTED_TOKEN_REFUSED)
  })

  it('sign-in asks for exactly the three scopes', async () => {
    const { connector } = make({ oauth })
    const b = (await connector.begin({ state: 'st' })) as { kind: string; url: string }
    const u = new URL(b.url)
    expect(u.origin + u.pathname).toBe('https://www.patreon.com/oauth2/authorize')
    expect(u.searchParams.get('scope')).toBe('identity campaigns campaigns.members')
    expect(u.searchParams.get('state')).toBe('st')
  })

  it('refuses a sign-in that came back without the members scope', async () => {
    const { connector } = make({ oauth }, [tokenRoute({ access_token: 'access_redacted_0001', refresh_token: 'refresh_redacted_001', expires_in: 2_678_400, scope: 'identity campaigns' }), ...routes()])
    await expect(connector.connect({ code: 'abc' })).rejects.toThrow(/campaigns\.members/)
  })

  it('a creator with no campaign gets a plain answer', async () => {
    const r = routes()
    r[1] = { match: (u: URL) => u.pathname === '/api/oauth2/v2/campaigns', respond: () => ({ json: { data: [] } }) }
    const { connector } = make({}, r)
    await expect(connector.connect({ token: 'creator_token_redacted_01' })).rejects.toThrow(/campaign/)
  })

  it('renews a token close to expiry, saves the single-use pair before reading, and hands it back', async () => {
    const f = fixtureFetch([tokenRoute({ access_token: 'access_new_redacted_01', refresh_token: 'refresh_new_redacted_1', expires_in: 2_678_400 }), ...routes()])
    const saved: unknown[] = []
    const clock = fakeClock(Date.parse('2026-11-01T12:00:00Z'))
    const connector = createPatreonConnector({ oauth }, { raw: new MemoryRawSink(), fetch: f.fetch, clock, saveSecret: async (_id, s) => { saved.push(s) } })
    const page = await connector.sync(conn({ tokens: { accessToken: 'access_old_redacted_01', refreshToken: 'refresh_old_redacted_1', expiresAt: clock.now() + 1_000 } }), null)
    expect(f.calls[0]!.method).toBe('POST')
    expect(f.calls[0]!.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'refresh_old_redacted_1', client_id: 'cid', client_secret: 'csec' })
    expect(saved).toHaveLength(1)
    expect(page.updatedSecret).toMatchObject({ tokens: { accessToken: 'access_new_redacted_01' } })
    expect(f.calls[1]!.headers.authorization).toBe('Bearer access_new_redacted_01')
  })

  it('a dead refresh token asks for a new sign-in', async () => {
    const { connector, clock } = make({ oauth }, [{ method: 'POST', match: (u: URL) => u.pathname === '/api/oauth2/token', respond: { status: 400, json: { error: 'invalid_grant' } } }, ...routes()])
    await expect(connector.sync(conn({ tokens: { accessToken: 'access_old_redacted_01', refreshToken: 'refresh_old_redacted_1', expiresAt: clock.now() - 1 } }), null)).rejects.toMatchObject({ kind: 'auth' })
  })

  it('disconnect: Patreon has no revoke call, so it says where to remove the app', async () => {
    const { connector, f } = make({ oauth })
    expect(await connector.disconnect!(conn({ tokens: { accessToken: 'access_old_redacted_01' } }))).toEqual({ notRevoked: expect.stringMatching(/^In Patreon, go to .*Remove Aggregate\.$/) })
    expect(await connector.disconnect!(conn())).toEqual({ notRevoked: expect.stringMatching(/^In Patreon, go to /) })
    expect(f.calls).toHaveLength(0)
  })
})

describe('classifyPatreonError', () => {
  const kind = (s: number, b: unknown = {}) => classifyPatreonError(s, b).kind
  it('sorts statuses', () => {
    expect(kind(401)).toBe('auth')
    expect(kind(403)).toBe('permanent')
    expect(kind(429)).toBe('rate_limited')
    expect(kind(503)).toBe('transient')
    expect(kind(400)).toBe('invalid_input')
    expect(kind(404)).toBe('permanent')
  })
  it('reads retry_after_seconds, and treats it as optional', () => {
    expect(classifyPatreonError(429, { errors: [{ retry_after_seconds: 9 }] }).retryAfterMs).toBe(9_000)
    expect(classifyPatreonError(429, {}).retryAfterMs).toBeUndefined()
  })
  it('is a ConnectorError', () => {
    expect(classifyPatreonError(500, 'nope')).toBeInstanceOf(ConnectorError)
  })
})
