// Roast/hype: facts only from the ledger (expense and revenue roles; never transfers, payouts or owner money), fixed
// template lines, names only when turned on, and the hard stops. Then the real thing on the demo's Harbor Coffee.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ReportView, TxnView } from '@agfn/contracts'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { createDemoConnector } from '@agfn/connector-demo'
import { MemoryFileStore } from '@agfn/files'
import { createDemoWorkspace } from '@agfn/demo'
import { boot, type Booted } from './boot.ts'
import { loadConfig } from './config.ts'
import { financeFor } from './finance.ts'
import { loadInstalledModules } from './modules.ts'
import { factsFrom, lines, pnlOf, refusal, windows, type Pnl } from './roast.ts'
import { draftShare, listShares, makeSharePort, previewShare, ShareError } from './share.ts'

let n = 0
const row = (date: string, minor: number, category: string, counterparty?: string): TxnView => ({ id: `t${++n}`, entityId: 'e', accountId: 'a', date, amount: { minor, currency: 'USD' }, status: 'posted', category, ...(counterparty ? { counterparty } : {}), addedBy: { kind: 'connector' } as never, links: [], needsReview: false })

describe('roast facts and lines', () => {
  const m = windows('2026-10-12')
  it('windows are the 3 complete months and the 3 before', () => {
    expect(m).toEqual({ now: ['2026-07', '2026-08', '2026-09'], before: ['2026-04', '2026-05', '2026-06'], from: '2026-04-01', to: '2026-09-30', nowFrom: '2026-07-01', beforeTo: '2026-06-30' })
  })
  const rows: TxnView[] = []
  for (const mo of ['07', '08', '09']) {
    rows.push(row(`2026-${mo}-15`, -60_000_00, 'payroll_expense', 'Gusto'), row(`2026-${mo}-01`, -8_500_00, 'rent', 'Commonspace'))
    rows.push(row(`2026-${mo}-05`, mo === '09' ? -200_00 : -100_00, 'software', 'Slack'))
    for (let d = 1; d <= 20; d++) rows.push(row(`2026-${mo}-${String(d).padStart(2, '0')}`, -5_50, 'meals', 'Blue Bottle'))
    rows.push(row(`2026-${mo}-20`, 50_000_00, 'revenue', 'Stripe'))
    // Never spending: a transfer, a card payment, owner money.
    rows.push(row(`2026-${mo}-02`, -45_000_00, 'clearing_transfers'), row(`2026-${mo}-25`, -9_000_00, 'clearing_card_payments'), row(`2026-${mo}-10`, 25_000_00, 'owner_money_unspecified'))
  }
  rows.push(row('2026-08-09', -48_00, 'software', 'Figma'), row('2026-08-09', -48_00, 'software', 'Figma'))
  for (const mo of ['04', '05', '06']) rows.push(row(`2026-${mo}-15`, -55_000_00, 'payroll_expense', 'Gusto'), row(`2026-${mo}-20`, 40_000_00, 'revenue', 'Stripe'))
  // The P&L for each window, as the ledger would post these rows (expense roles only; no transfers or owner money).
  const spendRoles = new Set(['payroll_expense', 'rent', 'software', 'meals'])
  const pnlFor = (months: string[]): Pnl => {
    const p: Pnl = { spend: {}, revenue: 0 }
    for (const r of rows.filter((x) => months.includes(x.date.slice(0, 7)))) {
      if (spendRoles.has(r.category!)) p.spend[r.category!] = (p.spend[r.category!] ?? 0) - r.amount.minor
      if (r.category === 'revenue') p.revenue += r.amount.minor
    }
    return p
  }
  const f = factsFrom(rows, m, { now: pnlFor(m.now), before: pnlFor(m.before) }, 14)

  it('computes the facts', () => {
    expect(f.top).toEqual({ group: 'payroll', pct: 87 })
    expect(f.priceJump).toEqual({ name: 'Slack', group: 'software', pct: 100 })
    expect(f.frequent).toEqual({ name: 'Blue Bottle', group: 'food', perMonth: 20 })
    expect(f.doubles).toEqual({ name: 'Figma', count: 1 })
    expect(f.revenueChangePct).toBe(25)
    expect(f.spendChangePct).toBeGreaterThan(10)
  })

  it('the same fee twice on one day is two sales, not a double charge', () => {
    const withFees = [...rows]
    for (let i = 0; i < 5; i++) withFees.push(row('2026-09-04', -1_87, 'processor_fees', 'Stripe'))
    const p = pnlFor(m.now)
    const g = factsFrom(withFees, m, { now: { ...p, spend: { ...p.spend, processor_fees: 5 * 1_87 } }, before: pnlFor(m.before) }, 14)
    expect(g.doubles).toEqual({ name: 'Figma', count: 1 })
  })

  it('reads the P&L sections by role (cost of revenue and operating expenses are spending)', () => {
    const usd = (minor: number) => ({ minor, currency: 'USD' })
    const report = { kind: 'profit_and_loss', entityId: 'e', from: '2026-07-01', to: '2026-09-30', basis: 'accrual', currency: 'USD', total: usd(0), sections: [
      { name: 'Revenue', rows: [{ account: 'Sales', amount: usd(900_00), role: 'revenue' }], total: usd(900_00) },
      { name: 'Cost of revenue', rows: [{ account: 'Beans', amount: usd(200_00), role: 'cogs' }], total: usd(200_00) },
      { name: 'Operating expenses', rows: [{ account: 'Wages', amount: usd(500_00), role: 'payroll_expense' }, { account: 'Payroll taxes', amount: usd(40_00), role: 'payroll_taxes' }], total: usd(540_00) },
      { name: 'Other income and costs', rows: [{ account: 'Interest', amount: usd(5_00), role: 'interest_income' }], total: usd(5_00) },
    ] } as ReportView
    expect(pnlOf(report)).toEqual({ spend: { cogs: 200_00, payroll_expense: 500_00, payroll_taxes: 40_00 }, revenue: 900_00 })
    expect(pnlOf(undefined)).toEqual({ spend: {}, revenue: 0 })
    const g = factsFrom([], m, { now: pnlOf(report), before: pnlOf(report) })
    expect(g.top).toEqual({ group: 'payroll', pct: 73 })
    expect(g.second).toEqual({ group: 'what you sell', pct: 27 })
    expect(g.spendChangePct).toBe(0)
  })

  it('roasts without names unless asked, and every number in a line is one the facts hold', () => {
    const off = lines('roast', f, { names: false, max: 10 })
    expect(off[0]).toBe('Payroll is 87% of what you spend. Your team is the product, and also the entire budget.')
    expect(off.join(' ')).not.toMatch(/Slack|Blue Bottle|Figma|Gusto|\$/)
    expect(off).toContain('One software tool raised its price 100% and you didn’t blink. Admirable loyalty.')
    const on = lines('roast', f, { names: true, max: 10 })
    expect(on).toContain('Blue Bottle, 20 times a month. That’s not a habit, it’s a subscription without the discount.')
    const allowed = new Set(['87', '100', '20', String(f.second?.pct), String(f.spendChangePct), String(f.revenueChangePct), '6'])
    for (const l of [...off, ...on]) for (const num of l.match(/\d+(\.\d+)?/g) ?? []) expect(allowed.has(num), `${num} in “${l}”`).toBe(true)
    expect(lines('roast', f, { names: false })).toHaveLength(3)
  })

  it('never advises', () => {
    for (const l of [...lines('roast', f, { names: true, max: 10 }), ...lines('hype', f, { names: true, max: 10 })]) expect(l).not.toMatch(/\b(you should|cut|invest|borrow|raise money|fire|consider)\b/i)
  })

  it('hypes kindly and stops where it should', () => {
    expect(lines('hype', f, { names: false })[0]).toBe('14 months of runway. Plenty of road ahead.')
    expect(refusal('roast', false, f)).toMatch(/too honest to roast/)
    expect(refusal('hype', false, f)).toMatch(/still need a look/)
    expect(refusal('roast', true, { ...f, runwayMonths: 4 })).toMatch(/under six months/)
    expect(refusal('hype', true, { ...f, runwayMonths: 4 })).toBeNull()
    expect(refusal('roast', true, f)).toBeNull()
  })
})

describe('roast on the demo', () => {
  let booted: Booted
  let ws = ''
  let harbor = ''
  let personId = ''
  beforeAll(async () => {
    const modules = await loadInstalledModules({})
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: 'http://localhost:8787', WEB_DIST: '/nonexistent' }), runWorker: false }
    booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => {} }, ledger: modules.ledger, mcp: modules.mcp, connectors: [(d) => createDemoConnector(d)], fileStore: new MemoryFileStore() })
    const s = booted.services
    personId = 'p_roast'
    await s.db.insertInto('people').values({ id: personId, auth_user_id: null, name: 'Owner', email: 'owner@example.com', created_at: new Date().toISOString() }).execute()
    const demo = await createDemoWorkspace({ db: s.db, keys: s.keys }, { personId, historyDays: 220 })
    ws = demo.workspaceId
    for (const id of demo.connections) {
      await s.sync.sync(id)
      await s.db.deleteFrom('jobs').where('workspace_id', '=', ws).execute()
    }
    harbor = demo.entities.find((e) => e.name === 'Harbor Coffee')!.id
  }, 300_000)
  afterAll(() => booted?.shutdown())

  it('Harbor Coffee: lines from the ledger, or a plain reason why not', async () => {
    const s = booted.services
    for (const kind of ['roast', 'hype'] as const) {
      const { id } = await draftShare(s, { workspaceId: ws, personId, entityId: harbor, kind, source: 'app' })
      for (const vendors of [false, true]) {
        try {
          const c = await previewShare(s, ws, personId, id, { amounts: false, name: false, vendors })
          console.log(`[${kind}${vendors ? ', vendor names' : ''}]`, JSON.stringify(c.lines))
          expect(c.lines!.length).toBeGreaterThan(0)
          expect(c).not.toHaveProperty('cash')
          expect(c).not.toHaveProperty('company')
        } catch (e) {
          if (!(e instanceof ShareError)) throw e
          console.log(`[${kind}] refused:`, e.message)
          expect(e.status).toBe(422)
        }
      }
    }
  }, 120_000)

  it('Harbor Coffee: the card’s spending shares are the P&L’s (accrual, last 3 complete months)', async () => {
    const s = booted.services
    const r = financeFor(s).reader
    const scope = { workspaceId: ws, entityIds: [harbor] }
    const asOf = String((await r.metric('cash', scope)).asOf).slice(0, 10)
    const m = windows(asOf)
    const p = pnlOf((await r.reports(scope, 'profit_and_loss', m.nowFrom, m.to, 'accrual'))[0])
    const spend = Object.values(p.spend).reduce((t, x) => t + x, 0)
    const payroll = ['payroll_expense', 'payroll_taxes', 'payroll_benefits'].reduce((t, k) => t + (p.spend[k] ?? 0), 0)
    const { id } = await draftShare(s, { workspaceId: ws, personId, entityId: harbor, kind: 'roast', source: 'app' })
    const c = await previewShare(s, ws, personId, id, { amounts: false, name: false }).catch((e: Error) => e)
    if (c instanceof ShareError) return // not reconciled in this run: nothing to compare
    if (c instanceof Error) throw c
    const said = c.lines!.join(' ')
    if (/Payroll is \d+%/.test(said)) expect(said).toContain(`Payroll is ${Math.round((payroll / spend) * 100)}% of what you spend`)
  }, 120_000)

  it('the port (share_answer) hands back the card’s own lines, vendor names only when asked; a refusal leaves no draft', async () => {
    const s = booted.services
    const port = makeSharePort(s, 'http://localhost:8787')
    const before = (await listShares(s, ws)).length
    const r = await port.draft({ workspaceId: ws, personId, entityId: harbor, kind: 'hype', source: 'Claude' }).catch((e: Error) => e)
    if (r instanceof ShareError) {
      expect(r.status).toBe(422)
      expect((await listShares(s, ws)).length).toBe(before)
    } else if (r instanceof Error) throw r
    else {
      expect(r.lines!.length).toBeGreaterThan(0)
      expect(r.reviewUrl).toBe(`http://localhost:8787/#/?d=share:${r.id}`)
      const card = await previewShare(s, ws, personId, r.id!, { amounts: false, name: false })
      expect(card.lines).toEqual(r.lines)
    }
    const plain = await port.draft({ workspaceId: ws, personId, entityId: harbor, kind: 'runway', source: 'Claude' })
    expect(plain.lines).toBeUndefined()
    expect(plain.id).toBeTruthy()
  }, 120_000)
})
