// The company drawer says what get_overview says (docs/qa/web-number-sources.md; 34: one definition, the web never
// sums). A controlled core reader for the edge cases (unknown cash, runway states, JPY), then a fully booted server
// where the drawer's figures must equal overview(), which get_overview returns as is.
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { Actor, DataType, MetricAnswer, Money, Overview } from '@agfn/contracts'
import { connect, migrateToLatest, type CoreTables } from '@agfn/db'
import type { SyncEngineDeps } from '@agfn/sync'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import type { RequestPerson } from '../app.ts'
import { boot } from '../boot.ts'
import { createApp } from '../app.ts'
import { loadConfig } from '../config.ts'
import { ledgerFor, mcpFor } from '../modules.ts'
import { financeFor } from '../finance.ts'
import { financeRoutes, fmtMoney, holdingsOf } from './finance.ts'

const WS = 'ws_drawer'
const ACME = 'ent_acme'
const at = '2026-10-09T12:00:00.000Z'
const usd = (minor: number): Money => ({ minor, currency: 'USD' })

const answer = (o: Partial<MetricAnswer>): MetricAnswer =>
  ({ value: null, state: 'ok', asOf: at, basis: 'cash', includedAccounts: [], staleSources: [], pendingReviewCount: 0, failedChecks: [], ...o }) as MetricAnswer

/** A drawer over a core reader whose answers the test chooses. */
async function drawerWith(o: { cash: MetricAnswer; runway: MetricAnswer; overview: Partial<Overview['entities'][number]>; currency?: string; history?: Money[] }) {
  const h = connect<CoreTables>('sqlite::memory:')
  await migrateToLatest(h.db)
  const db = h.db as unknown as import('kysely').Kysely<Record<string, Record<string, unknown>>>
  const currency = o.currency ?? 'USD'
  await db.insertInto('workspaces').values({ id: WS, name: 'W', base_currency: currency, created_at: at }).execute()
  await db.insertInto('entities').values({ id: ACME, workspace_id: WS, kind: 'company', name: 'Acme', base_currency: currency, created_at: at }).execute()
  const zero = { minor: 0, currency }
  const ov: Overview = {
    asOf: at,
    homeCurrency: currency,
    attention: [],
    failingChecks: [],
    entities: [{ entityId: ACME, cash: zero, cardDebt: zero, netBurn3mo: null, runwayMonths: null, runwayState: 'no_data', mrr: null, owedToYou: { total: zero, overdue: zero }, billsDue30d: zero, nextPayroll: null, ...o.overview }],
  }
  const reader = {
    metric: async (name: string) => (name === 'cash' ? o.cash : name === 'runway' ? o.runway : answer({ state: 'no_data' })),
    overview: async () => ov,
    accounts: async () => [],
    dataAvailability: async () => ['balances', 'invoices', 'bills'] as DataType[],
    searchInvoices: async () => ({ rows: [], totalCount: 0, nextCursor: null, totals: [], aging: [] }),
  }
  const ledger = { cashHistory: async () => o.history ?? [], metric: reader.metric }
  const permissions = { entitiesFor: async () => [{ id: ACME, name: 'Acme', kind: 'company' as const }], can: async (_a: Actor, action: string) => action === 'view', canManageWorkspace: async () => false }
  const s = { db: h.db as never, ledger: ledger as never, syncDeps: { afterSync: [] } as unknown as SyncEngineDeps, permissions: permissions as never }
  financeFor(s, { core: { reader: reader as never, writer: {} as never, owns: async () => false } })
  const app = new Hono<{ Variables: { person: RequestPerson } }>()
  app.onError((err) => (err instanceof HTTPException ? err.getResponse() : new Response(String(err), { status: 500 })))
  app.use('/api/*', async (c, next) => (c.set('person', { personId: 'p1', name: 'Y', email: 'y@example.test', sessionId: 's', workspaceId: WS }), next()))
  app.route('/api', financeRoutes(s))
  const d = (await (await app.request(`/api/entities/${ACME}`)).json()) as Record<string, any>
  h.close()
  return d
}

describe('company drawer = get_overview', () => {
  it('cash the ledger can’t know is null, not a number (as the Workspace page and get_overview show it)', async () => {
    const d = await drawerWith({ cash: answer({ state: 'unknown', value: usd(5_000_00), unknownReason: 'An account has no balance yet.' }), runway: answer({ state: 'unknown' }), overview: { runwayState: 'unknown' } })
    expect(d.entity.cash).toBeNull()
    expect(d.runway).toMatchObject({ months: null, state: 'unknown' })
    expect(d.trend).toEqual([])
  })

  it('runway state is the overview’s: not burning, with no months', async () => {
    const d = await drawerWith({ cash: answer({ value: usd(80_000_00) }), runway: answer({ state: 'not_burning' }), overview: { runwayState: 'not_burning' } })
    expect(d.entity.cash).toEqual(usd(80_000_00))
    expect(d.runway).toMatchObject({ months: null, state: 'not_burning' })
  })

  it('JPY has no minor units: the trend and amounts in words aren’t divided by 100; BHD has three', async () => {
    const jpy = (minor: number) => ({ minor, currency: 'JPY' })
    const d = await drawerWith({ currency: 'JPY', cash: answer({ value: jpy(1_200_000) }), runway: answer({ value: 14, state: 'ok' }), overview: { runwayState: 'ok', runwayMonths: 14 }, history: Array.from({ length: 12 }, (_, i) => jpy(1_000_000 + i * 10_000)) })
    expect(d.trend[0]).toBe(1_000_000)
    expect(d.trend.at(-1)).toBe(1_110_000)
    expect(fmtMoney(jpy(1_200_000))).toBe('¥1,200,000')
    expect(fmtMoney({ minor: 1_500_500, currency: 'BHD' })).toMatch(/^BHD\s1,501$/)
    expect(fmtMoney(usd(250_000_00))).toBe('$250,000')
  })

  it('holdings: a total per currency from the server, never added across currencies', () => {
    const row = (value: Money) => ({ securityId: 's', accountId: 'a', accountName: 'Brokerage', entityId: ACME, quantity: '1', value, asOf: '2026-10-09' }) as never
    expect(holdingsOf([row(usd(100_00)), row(usd(50_00)), row({ minor: 300_00, currency: 'EUR' })]).holdingsTotal).toEqual([usd(150_00), { minor: 300_00, currency: 'EUR' }])
    expect(holdingsOf(null)).toEqual({ holdings: null, holdingsTotal: [] })
  })
})

describe('company drawer on a booted server', () => {
  it('bills due, owed to you, cash and runway state equal overview() for the same books (a bill due in 20 days counts)', async () => {
    const BASE = 'http://localhost:8787'
    const outbox: Array<{ to: string; text: string }> = []
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
    const booted = await boot({
      config,
      keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }),
      mailer: { send: async (m) => void outbox.push({ to: m.to, text: m.text }) },
      ledger: (h) => ledgerFor(h.db),
      mcp: (s) => mcpFor(s, financeFor(s)),
    })
    try {
      const app = createApp(booted.services)
      await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: 'f@example.com', callbackURL: '/' }) })
      const link = outbox.at(-1)!.text.match(/https?:\/\/\S+/)![0]
      const cookie = (await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
      const req = (method: string, body?: unknown) => ({ method, headers: { 'content-type': 'application/json', origin: BASE, cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      const { companyId, workspaceId } = (await (await app.request('/api/workspaces', req('POST', { companyName: 'Acme' }))).json()) as { companyId: string; workspaceId: string }
      // Yesterday (UTC), not today: overview() counts days in the company's local time, and between 00:00 UTC and local
      // midnight a UTC "today" is tomorrow there, so the bills would look not yet issued.
      const today = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
      const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
      await app.request('/api/entries/cash', req('POST', { entityId: companyId, direction: 'in', amount: usd(40_000_00), date: today, counterparty: 'Founder', paidBy: 'company', idempotencyKey: 'drawer-cash-1' }))
      const fin = financeFor(booted.services)
      const doc = (side: 'receivable' | 'payable', key: string, total: number, issueDate: string, dueDate: string) =>
        fin.writer.apply(
          { op: 'add_invoice', workspaceId, entityId: companyId, payload: { direction: side, counterparty: side === 'payable' ? 'Example Cloud' : 'Globex', number: key, issueDate, dueDate, currency: 'USD', lines: [{ description: 'x', quantity: 1, unitPriceMinor: total, amountMinor: total }], taxMinor: 0, totalMinor: total, linesMismatchMinor: 0, status: 'open', note: null } },
          { writeRequestId: `wr-${key}`, actorKind: 'person', label: 'test' },
        )
      await doc('payable', 'B-20', 1_250_00, today, inDays(20))
      await doc('payable', 'B-90', 9_999_00, today, inDays(90))
      await doc('receivable', 'INV-1', 3_000_00, inDays(-60), inDays(-30))
      await doc('receivable', 'INV-2', 2_000_00, today, inDays(10))

      const d = (await (await app.request(`/api/entities/${companyId}`, { headers: { cookie } })).json()) as Record<string, any>
      const ov = (await fin.reader.overview({ workspaceId, entityIds: [companyId] })).entities[0]!
      expect(d.bills.dueSoon).toEqual(ov.billsDue30d)
      expect(d.bills.dueSoon.minor).toBeGreaterThanOrEqual(1_250_00) // the old 14-day sum left the 20-day bill out
      expect(d.bills.dueSoon.minor).toBeLessThan(1_250_00 + 9_999_00) // the 90-day one is outside 30 days
      expect({ total: d.owedToYou.total, overdue: d.owedToYou.overdue }).toEqual(ov.owedToYou)
      expect(d.runway.state).toBe(ov.runwayState)
      const cashUnknown = (ov.caveats ?? []).some((c) => c.figure === 'cash' && c.state === 'unknown')
      expect(d.entity.cash).toEqual(cashUnknown ? null : ov.cash)
    } finally {
      await booted.shutdown()
    }
  }, 60_000)
})
