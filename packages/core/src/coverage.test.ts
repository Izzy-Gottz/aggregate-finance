// Statement coverage and pinned balances, golden answers on memory and SQLite.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFinance } from './finance.ts'
import { eur, invoice, makeKit, snapshot, txn, usd, type Backend, type Kit } from './test-kit.ts'

const backends: Backend[] = ['memory', 'sqlite']

describe.each(backends)('coverage and balance assertions (%s)', (backend) => {
  let k: Kit
  let acme: string

  beforeEach(async () => {
    k = await makeKit(backend, { now: '2026-10-09T12:00:00.000Z' })
    acme = await k.company('Acme')
  })
  afterEach(async () => {
    await k.close()
  })

  it("a pinned balance is a check: it passes while the ledger agrees and fails when it doesn't", async () => {
    const bank = await k.account({ entityId: acme, name: 'Chase', mask: '4411' })
    const card = await k.account({ entityId: acme, name: 'Amex', type: 'credit_card' })
    await k.engine.postBatch(k.ws, [txn(bank, '2026-09-02', 500_000), txn(bank, '2026-09-20', -120_000), txn(card, '2026-09-12', -45_000)])
    const ok = await k.engine.addBalanceAssertion(k.ws, { accountId: bank.id, date: '2026-09-30', balance: usd(380_000), source: 'September statement' })
    await k.engine.addBalanceAssertion(k.ws, { accountId: card.id, date: '2026-09-30', balance: usd(45_000), source: 'Amex statement' })
    let checks = (await k.engine.checks(k.ws)).filter((c) => c.name === 'balance_assertion')
    expect(checks.map((c) => [c.status, c.message]).sort()).toEqual([
      ['ok', 'Amex on 2026-09-30: matches Amex statement'],
      ['ok', 'Chase ··4411 on 2026-09-30: matches September statement'],
    ])
    const bad = await k.engine.addBalanceAssertion(k.ws, { accountId: bank.id, date: '2026-09-10', balance: usd(400_000), source: 'a photo of the statement' })
    checks = (await k.engine.checks(k.ws, { problemsOnly: true })).filter((c) => c.name === 'balance_assertion')
    expect(checks.map((c) => [c.subjectId, c.differenceMinor, c.message])).toEqual([[bad.id, -100_000, 'Chase ··4411 on 2026-09-10: a photo of the statement says $4,000.00, the ledger says $5,000.00']])
    expect((await k.engine.dataHealth(k.ws)).counts.failedChecks).toBe(1)
    // A day off around midnight (the bank's date vs the person's): noted, not failed.
    const nearby = await k.engine.addBalanceAssertion(k.ws, { accountId: bank.id, date: '2026-09-19', balance: usd(380_000) })
    const note = (await k.engine.checks(k.ws, { problemsOnly: true })).find((c) => c.subjectId === nearby.id)
    expect(note?.matchesOn).toBe('2026-09-20')
    expect([note?.status, note?.message]).toEqual(['warn', 'Chase ··4411: the pinned balance ($3,800.00) matches the ledger on 2026-09-20, not 2026-09-19; bank and sync dates can differ by a day around midnight'])
    await k.engine.removeBalanceAssertion(k.ws, nearby.id)
    await k.engine.removeBalanceAssertion(k.ws, bad.id)
    expect((await k.engine.checks(k.ws, { problemsOnly: true })).filter((c) => c.name === 'balance_assertion')).toEqual([])
    expect((await k.engine.balanceAssertions(k.ws)).map((a) => a.id)).toContain(ok.id)
    await expect(k.engine.addBalanceAssertion(k.ws, { accountId: bank.id, date: '2026-09-30', balance: { minor: 1, currency: 'EUR' } })).rejects.toThrow('in USD')
  })

  it('a month-end row that reaches the balance a day later is posting lag, not a month that fails', async () => {
    const bank = await k.account({ entityId: acme, name: 'Mercury' })
    await k.engine.postBatch(k.ws, [snapshot(bank, '2026-07-31', 100_000), txn(bank, '2026-08-31', -30_000), snapshot(bank, '2026-08-31', 100_000), snapshot(bank, '2026-09-01', 70_000)])
    const [cov] = await k.engine.coverage(k.ws)
    expect(cov?.months.find((m) => m.month === '2026-08')?.status).toBe('covered')
  })

  it('coverage: a quiet month in a busy account, a statement not uploaded yet, a month that does not add up', async () => {
    const bank = await k.account({ entityId: acme, name: 'Chase', mask: '4411' })
    const busy = (month: string) => [3, 10, 17, 24].map((d) => txn(bank, `${month}-${String(d).padStart(2, '0')}`, -1_000, { counterparty: `Shop ${month}-${d}` }))
    await k.engine.postBatch(k.ws, [...busy('2026-06'), ...busy('2026-07'), ...busy('2026-09'), ...busy('2026-10')])
    const upload = await k.account({ entityId: acme, name: 'Savings', mask: '9001', connectionId: await k.connection({ key: 'files' }) })
    await k.engine.postBatch(k.ws, [txn(upload, '2026-06-30', 1_200), txn(upload, '2026-07-31', 1_250)])
    const cov = await k.engine.coverage(k.ws)
    const chase = cov.find((c) => c.accountId === bank.id)
    expect(chase?.months.map((m) => [m.month, m.status, m.rows])).toEqual([
      ['2026-06', 'covered', 4],
      ['2026-07', 'covered', 4],
      ['2026-08', 'missing', 0],
      ['2026-09', 'covered', 4],
      ['2026-10', 'in_progress', 4],
    ])
    expect(chase?.problems).toEqual(['Chase ··4411: August has no transactions'])
    expect(cov.find((c) => c.accountId === upload.id)?.problems).toEqual(['Savings ··9001: August statement missing', 'Savings ··9001: September statement missing'])
    const health = await k.engine.dataHealth(k.ws)
    expect(health.counts.missingStatements).toBe(3)
    expect(health.items.filter((i) => i.kind === 'missing_statement').map((i) => i.text).sort()).toEqual([
      'No Chase ··4411 transactions in August',
      'Statement for Savings ··9001 missing for August',
      'Statement for Savings ··9001 missing for September',
    ])
    expect(health.line).toContain('3 months missing')

    // Provider balances that moved differently from the rows posted in the month.
    const mm = await k.account({ entityId: acme, name: 'Mercury' })
    await k.engine.postBatch(k.ws, [snapshot(mm, '2026-07-31', 100_000), txn(mm, '2026-08-15', 30_000), snapshot(mm, '2026-08-31', 150_000)])
    const merc = (await k.engine.coverage(k.ws)).find((c) => c.accountId === mm.id)
    expect(merc?.months.find((m) => m.month === '2026-08')).toEqual({ month: '2026-08', status: 'mismatched', rows: 1, detail: 'the balance moved $500.00, rows add up to $300.00' })
  })

  it("a Square cash drawer is the ledger's own account: its balance is known, whatever the connection says", async () => {
    const scope = { workspaceId: k.ws, entityIds: [acme] }
    const mercury = await k.account({ entityId: acme, name: 'Mercury', connectionId: await k.connection({ lastSuccessAt: '2026-10-09T08:00:00Z' }) })
    await k.engine.postBatch(k.ws, [snapshot(mercury, '2026-10-09', 50_000)])
    for (const lastSuccessAt of ['2026-10-09T08:00:00Z', null]) {
      // Synced by the Square connection (its first sync may still be running), never a balance from Square.
      const square = await k.connection({ key: 'square', lastSuccessAt })
      const drawer = await k.account({ entityId: acme, type: 'cash_on_hand', name: `Square cash drawer (${lastSuccessAt ? 'Main' : 'New'})`, connectionId: square, includeInCash: true })
      await k.engine.postBatch(k.ws, [txn(drawer, '2026-10-08', 4_500, { categoryHint: 'INCOME_SALES' })])
    }
    // A drawer with no cash sale for weeks is still current while Square keeps syncing.
    const quiet = await k.account({ entityId: acme, type: 'cash_on_hand', name: 'Square cash drawer (Quiet)', connectionId: await k.connection({ key: 'square', lastSuccessAt: '2026-10-09T08:00:00Z' }), includeInCash: true })
    await k.engine.postBatch(k.ws, [txn(quiet, '2026-09-10', 1_000, { categoryHint: 'INCOME_SALES' })])
    const cash = await k.engine.metric('cash', scope)
    expect([cash.state, cash.unknownReason, cash.value]).toEqual(['ok', undefined, usd(60_000)])
    expect(cash.coverage?.accounts.find((a) => a.name === 'Square cash drawer (Quiet)')).toMatchObject({ balanceAsOf: '2026-10-09', stale: false })
  })

  it('a processor balance with no sales yet is a known zero once its connection has synced (Gumroad never sends a balance)', async () => {
    const scope = { workspaceId: k.ws, entityIds: [acme] }
    const mercury = await k.account({ entityId: acme, name: 'Mercury', connectionId: await k.connection({ lastSuccessAt: '2026-10-09T08:00:00Z' }) })
    await k.engine.postBatch(k.ws, [snapshot(mercury, '2026-10-09', 118_500)])
    const gumroad = await k.connection({ key: 'gumroad', lastSuccessAt: '2026-10-09T08:00:00Z' })
    await k.account({ entityId: acme, type: 'processor_balance', name: 'Seller balance (Gumroad)', connectionId: gumroad, includeInCash: true })
    const cash = await k.engine.metric('cash', scope)
    expect([cash.state, cash.unknownReason, cash.value]).toEqual(['ok', undefined, usd(118_500)])
    expect(cash.coverage?.accounts.find((a) => a.name === 'Seller balance (Gumroad)')).toMatchObject({ balanceAsOf: '2026-10-09', stale: false })
    // Before its first sync finishes it hasn't told us anything yet.
    await k.account({ entityId: acme, type: 'processor_balance', name: 'New balance (Gumroad)', connectionId: await k.connection({ key: 'gumroad', lastSuccessAt: null }), includeInCash: true })
    expect((await k.engine.metric('cash', scope)).unknownReason).toBe('New balance (Gumroad) has never reported a balance')
  })

  it('metrics say unknown, not zero, and stale when balances are old', async () => {
    const scope = { workspaceId: k.ws, entityIds: [acme] }
    const chase = await k.account({ entityId: acme, name: 'Chase', mask: '4411', connectionId: await k.connection({ lastSuccessAt: '2026-09-29T08:00:00Z' }) })
    const fresh = await k.account({ entityId: acme, name: 'Mercury', connectionId: await k.connection({ lastSuccessAt: '2026-10-09T08:00:00Z' }) })
    await k.engine.postBatch(k.ws, [snapshot(chase, '2026-09-29', 100_000), snapshot(fresh, '2026-10-09', 50_000)])
    const cash = await k.engine.metric('cash', scope)
    expect([cash.state, cash.value, cash.unknownReason]).toEqual(['stale', usd(150_000), 'Chase ··4411 last reported Sep 29; total uses that balance'])
    expect(cash.coverage?.accounts.map((a) => [a.name, a.balanceAsOf, a.stale]).sort()).toEqual([
      ['Chase ··4411', '2026-09-29', true],
      ['Mercury', '2026-10-09', false],
    ])
    // Last month's burn: Chase only synced through Sep 29, so September isn't complete.
    const burn = await k.engine.metric('net_burn', { ...scope, from: '2026-09-01', to: '2026-09-30' })
    expect([burn.state, burn.value, burn.unknownReason]).toEqual(['unknown', null, 'Chase ··4411 has only synced through Sep 29'])
    // An account that never reported anything: cash is unknown, not a smaller number.
    await k.account({ entityId: acme, name: 'New Brex', connectionId: await k.connection({ lastSuccessAt: null }) })
    const cash2 = await k.engine.metric('cash', scope)
    expect([cash2.state, cash2.value, cash2.unknownReason]).toEqual(['unknown', null, 'New Brex has never reported a balance'])
    // The overview keeps its numbers but says which ones are unknown or stale.
    const [row] = (await createFinance(k.engine).reader.overview(scope)).entities
    expect(row?.caveats?.find((c) => c.figure === 'cash')).toEqual({ figure: 'cash', state: 'unknown', reason: 'New Brex has never reported a balance' })
  })

  it("a company in another currency is compared in that currency, whatever the month's rates did", async () => {
    const gmbh = await k.company('GmbH', { currency: 'EUR' })
    const books = await k.connection({ entityId: gmbh, key: 'quickbooks' })
    k.rates.set('2026-09-05', 'EUR', 'USD', '1.10').set('2026-09-30', 'EUR', 'USD', '1.20').set('2026-10-09', 'EUR', 'USD', '1.20')
    await k.engine.postBatch(k.ws, [
      invoice(books, { total: eur(100_000), issueDate: '2026-09-05', dueDate: '2026-10-05' }),
      { type: 'report.snapshot', externalId: 'pnl:eur', connectionId: books, kind: 'profit_and_loss', from: '2026-09-01', to: '2026-09-30', basis: 'accrual', currency: 'EUR', rows: [{ account: 'Net Income', amount: eur(100_000), section: '', depth: 0 }] },
    ])
    const checks = (await k.engine.checks(k.ws)).filter((c) => c.name === 'provider_report')
    expect(checks.map((c) => c.status)).toEqual(['ok'])
  })

  it("our P&L is checked against the books' own report for each period", async () => {
    const books = await k.connection({ entityId: acme, key: 'quickbooks' })
    const report = (from: string, to: string, net: number) => ({
      type: 'report.snapshot' as const,
      externalId: `pnl:${from}:${to}:accrual`,
      connectionId: books,
      kind: 'profit_and_loss' as const,
      from,
      to,
      basis: 'accrual' as const,
      currency: 'USD',
      rows: [
        { account: 'Total Income', amount: usd(net), section: 'Income', depth: 0 },
        { account: 'Net Income', amount: usd(net), section: '', depth: 0 },
      ],
    })
    await k.engine.postBatch(k.ws, [invoice(books, { total: usd(100_000), issueDate: '2026-09-05', dueDate: '2026-10-05' }), report('2026-09-01', '2026-09-30', 100_000), report('2026-08-01', '2026-08-31', 50_000)])
    const checks = (await k.engine.checks(k.ws)).filter((c) => c.name === 'provider_report')
    expect(checks.map((c) => [c.status, c.message]).sort()).toEqual([
      ['fail', 'Acme: net income 2026-08-01 to 2026-08-31 (accrual) is $0.00 here and $500.00 in QuickBooks'],
      ['ok', 'Acme: 2026-09-01 to 2026-09-30 (accrual) matches the P&L in QuickBooks'],
    ])
    expect((await k.engine.dataHealth(k.ws)).counts.failedChecks).toBe(1)
    expect((await k.engine.dataHealth(k.ws)).line).toContain("1 report doesn't match the books")
    const h = (await k.engine.metric('data_health', { workspaceId: k.ws, entityIds: [acme] })).health
    expect(h?.failedChecks).toBe(1)
    expect(h?.passedChecks).toBeGreaterThan(0)

    // The provider's own totals win over its rows, and say which part of the P&L differs.
    await k.engine.post(k.ws, {
      ...report('2026-07-01', '2026-07-31', 0),
      totals: { income: usd(40_000), cogs: usd(13_500), expenses: usd(0), netIncome: usd(26_500) },
    })
    await k.engine.post(k.ws, invoice(books, { total: usd(40_000), issueDate: '2026-07-10', dueDate: '2026-08-10', externalId: 'inv-jul' }))
    const july = (await k.engine.checks(k.ws)).find((c) => c.name === 'provider_report' && c.message.includes('2026-07-01'))
    expect(july?.message).toBe('Acme: net income 2026-07-01 to 2026-07-31 (accrual) is $400.00 here and $265.00 in QuickBooks (cost of goods sold $0.00 vs $135.00)')
  })

  it("each provider's report is compared with what came from that provider, not the whole company", async () => {
    const books = await k.connection({ entityId: acme, key: 'quickbooks' })
    const payroll = await k.connection({ entityId: acme, key: 'finch' })
    await k.engine.postBatch(k.ws, [
      invoice(books, { total: usd(148_128), issueDate: '2026-09-05', dueDate: '2026-10-05' }),
      {
        type: 'payroll.run',
        externalId: 'run-9',
        connectionId: payroll,
        payDate: '2026-09-15',
        gross: usd(3_000_000),
        employerTaxes: usd(229_500),
        net: usd(2_300_000),
        status: 'paid',
        source: 'provider',
      } as never,
      {
        type: 'report.snapshot',
        externalId: 'pnl:2026-09:accrual',
        connectionId: books,
        kind: 'profit_and_loss',
        from: '2026-09-01',
        to: '2026-09-30',
        basis: 'accrual',
        currency: 'USD',
        rows: [],
        totals: { netIncome: usd(148_128) },
      },
      // A cash-basis report can't be compared while payroll also books into the P&L: skipped, not failed.
      { type: 'report.snapshot', externalId: 'pnl:2026-09:cash', connectionId: books, kind: 'profit_and_loss', from: '2026-09-01', to: '2026-09-30', basis: 'cash', currency: 'USD', rows: [], totals: { netIncome: usd(0) } },
    ])
    // The whole company is deep in the red from payroll; QuickBooks' own books still match what came from QuickBooks.
    expect((await k.engine.profitAndLoss(k.ws, { entityIds: [acme], from: '2026-09-01', to: '2026-09-30', basis: 'accrual' })).netIncome.minor).toBe(148_128 - 3_229_500)
    const checks = (await k.engine.checks(k.ws)).filter((c) => c.name === 'provider_report')
    expect(checks.map((c) => [c.status, c.message])).toEqual([['ok', 'Acme: 2026-09-01 to 2026-09-30 (accrual) matches the P&L in QuickBooks']])
  })

  describe('a store sales report (WooCommerce) is not books', () => {
    const woo = (connectionId: never, month: string, basis: 'accrual' | 'cash' = 'accrual', sales = 987_654) => ({
      type: 'report.snapshot' as const,
      externalId: `woocommerce:${month}:USD:${basis}`,
      connectionId,
      kind: 'profit_and_loss' as const,
      from: `${month}-01`,
      to: `${month}-30`,
      basis,
      currency: 'USD',
      rows: [
        { account: 'Sales reported by the store', amount: usd(sales), section: 'Sales', depth: 0 },
        { account: 'Net sales reported by the store', amount: usd(sales), section: 'Sales', depth: 0 },
      ],
    })
    const books = (connectionId: never, month: string, net: number) => ({
      type: 'report.snapshot' as const,
      externalId: `pnl:${month}:accrual`,
      connectionId,
      kind: 'profit_and_loss' as const,
      from: `${month}-01`,
      to: `${month}-30`,
      basis: 'accrual' as const,
      currency: 'USD',
      rows: [],
      totals: { netIncome: usd(net) },
    })

    it('beside different ledger numbers: no provider_report at all, on either basis, even with a net income to compare', async () => {
      const store = await k.connection({ entityId: acme, key: 'woocommerce' })
      const stripe = await k.connection({ entityId: acme, key: 'stripe' })
      await k.engine.postBatch(k.ws, [
        invoice(stripe, { total: usd(100_000), issueDate: '2026-08-05', dueDate: '2026-09-05' }),
        woo(store as never, '2026-08'),
        woo(store as never, '2026-08', 'cash'),
        // Even if a row ever read like one, it would not be compared.
        { ...woo(store as never, '2026-07'), rows: [{ account: 'Net Income', amount: usd(5), section: '', depth: 0 }] },
        { ...woo(store as never, '2026-06'), totals: { netIncome: usd(7) } },
      ])
      expect((await k.engine.checks(k.ws)).filter((c) => c.name === 'provider_report')).toEqual([])
      expect((await k.engine.dataHealth(k.ws)).counts.failedChecks).toBe(0)
    })

    it("never takes QuickBooks' or Xero's place for the same period, whichever arrived last", async () => {
      for (const [key, wooFirst] of [['quickbooks', true], ['quickbooks', false], ['xero', true], ['xero', false]] as const) {
        const kit = await makeKit(backend, { now: '2026-10-09T12:00:00.000Z' })
        try {
          const acmeId = await kit.company('Acme')
          const ledger = await kit.connection({ entityId: acmeId, key })
          const store = await kit.connection({ entityId: acmeId, key: 'woocommerce' })
          const both = [woo(store as never, '2026-08'), books(ledger as never, '2026-08', 50_000)]
          await kit.engine.postBatch(kit.ws, [invoice(ledger, { total: usd(100_000), issueDate: '2026-08-05', dueDate: '2026-09-05' }), ...(wooFirst ? both : both.reverse())])
          const checks = (await kit.engine.checks(kit.ws)).filter((c) => c.name === 'provider_report')
          // The real comparison still runs, against the books' own number, and still fails where it should.
          expect(checks.map((c) => [c.status, c.expectedMinor, c.actualMinor])).toEqual([['fail', 50_000, 100_000]])
        } finally {
          await kit.close()
        }
      }
    })
  })

  describe('Harvest: a report-only source is not books', () => {
    const report = (connectionId: never, month: string, basis: 'accrual' | 'cash' = 'accrual') => ({
      type: 'report.snapshot' as const,
      externalId: `harvest:${month}:USD:${basis}`,
      connectionId,
      kind: 'profit_and_loss' as const,
      from: `${month}-01`,
      to: `${month}-30`,
      basis,
      currency: 'USD',
      rows: [{ account: 'Invoiced in Harvest', amount: usd(987_654), section: 'Sales', depth: 0 }],
    })
    const books = (connectionId: never, month: string, net: number) => ({
      type: 'report.snapshot' as const,
      externalId: `pnl:${month}:accrual`,
      connectionId,
      kind: 'profit_and_loss' as const,
      from: `${month}-01`,
      to: `${month}-30`,
      basis: 'accrual' as const,
      currency: 'USD',
      rows: [],
      totals: { netIncome: usd(net) },
    })

    it('beside different ledger numbers: no provider_report at all, on either basis, even with a net income to compare', async () => {
      const source = await k.connection({ entityId: acme, key: 'harvest' })
      const stripe = await k.connection({ entityId: acme, key: 'stripe' })
      await k.engine.postBatch(k.ws, [
        invoice(stripe, { total: usd(100_000), issueDate: '2026-08-05', dueDate: '2026-09-05' }),
        report(source as never, '2026-08'),
        report(source as never, '2026-08', 'cash'),
        { ...report(source as never, '2026-07'), rows: [{ account: 'Net Income', amount: usd(5), section: '', depth: 0 }] },
        { ...report(source as never, '2026-06'), totals: { netIncome: usd(7) } },
      ])
      expect((await k.engine.checks(k.ws)).filter((c) => c.name === 'provider_report')).toEqual([])
      expect((await k.engine.dataHealth(k.ws)).counts.failedChecks).toBe(0)
    })

    it("never takes QuickBooks' or Xero's place for the same period, whichever arrived last", async () => {
      for (const [key, sourceFirst] of [['quickbooks', true], ['quickbooks', false], ['xero', true], ['xero', false]] as const) {
        const kit = await makeKit(backend, { now: '2026-10-09T12:00:00.000Z' })
        try {
          const acmeId = await kit.company('Acme')
          const ledger = await kit.connection({ entityId: acmeId, key })
          const source = await kit.connection({ entityId: acmeId, key: 'harvest' })
          const both = [report(source as never, '2026-08'), books(ledger as never, '2026-08', 50_000)]
          await kit.engine.postBatch(kit.ws, [invoice(ledger, { total: usd(100_000), issueDate: '2026-08-05', dueDate: '2026-09-05' }), ...(sourceFirst ? both : both.reverse())])
          const checks = (await kit.engine.checks(kit.ws)).filter((c) => c.name === 'provider_report')
          expect(checks.map((c) => [c.status, c.expectedMinor, c.actualMinor])).toEqual([['fail', 50_000, 100_000]])
        } finally {
          await kit.close()
        }
      }
    })
  })

  describe('Lightspeed: a report-only source is not books', () => {
    const report = (connectionId: never, month: string, basis: 'accrual' | 'cash' = 'accrual') => ({
      type: 'report.snapshot' as const,
      externalId: `lightspeed:${month}:USD:${basis}`,
      connectionId,
      kind: 'profit_and_loss' as const,
      from: `${month}-01`,
      to: `${month}-30`,
      basis,
      currency: 'USD',
      rows: [{ account: 'Sales reported by the store', amount: usd(987_654), section: 'Sales', depth: 0 }],
    })
    const books = (connectionId: never, month: string, net: number) => ({
      type: 'report.snapshot' as const,
      externalId: `pnl:${month}:accrual`,
      connectionId,
      kind: 'profit_and_loss' as const,
      from: `${month}-01`,
      to: `${month}-30`,
      basis: 'accrual' as const,
      currency: 'USD',
      rows: [],
      totals: { netIncome: usd(net) },
    })

    it('beside different ledger numbers: no provider_report at all, on either basis, even with a net income to compare', async () => {
      const source = await k.connection({ entityId: acme, key: 'lightspeed' })
      const stripe = await k.connection({ entityId: acme, key: 'stripe' })
      await k.engine.postBatch(k.ws, [
        invoice(stripe, { total: usd(100_000), issueDate: '2026-08-05', dueDate: '2026-09-05' }),
        report(source as never, '2026-08'),
        report(source as never, '2026-08', 'cash'),
        { ...report(source as never, '2026-07'), rows: [{ account: 'Net Income', amount: usd(5), section: '', depth: 0 }] },
        { ...report(source as never, '2026-06'), totals: { netIncome: usd(7) } },
      ])
      expect((await k.engine.checks(k.ws)).filter((c) => c.name === 'provider_report')).toEqual([])
      expect((await k.engine.dataHealth(k.ws)).counts.failedChecks).toBe(0)
    })

    it("never takes QuickBooks' or Xero's place for the same period, whichever arrived last", async () => {
      for (const [key, sourceFirst] of [['quickbooks', true], ['quickbooks', false], ['xero', true], ['xero', false]] as const) {
        const kit = await makeKit(backend, { now: '2026-10-09T12:00:00.000Z' })
        try {
          const acmeId = await kit.company('Acme')
          const ledger = await kit.connection({ entityId: acmeId, key })
          const source = await kit.connection({ entityId: acmeId, key: 'lightspeed' })
          const both = [report(source as never, '2026-08'), books(ledger as never, '2026-08', 50_000)]
          await kit.engine.postBatch(kit.ws, [invoice(ledger, { total: usd(100_000), issueDate: '2026-08-05', dueDate: '2026-09-05' }), ...(sourceFirst ? both : both.reverse())])
          const checks = (await kit.engine.checks(kit.ws)).filter((c) => c.name === 'provider_report')
          expect(checks.map((c) => [c.status, c.expectedMinor, c.actualMinor])).toEqual([['fail', 50_000, 100_000]])
        } finally {
          await kit.close()
        }
      }
    })
  })

  describe('Pinterest: a report-only source is not books', () => {
    const report = (connectionId: never, month: string, basis: 'accrual' | 'cash' = 'accrual') => ({
      type: 'report.snapshot' as const,
      externalId: `pinterest:${month}:USD:${basis}`,
      connectionId,
      kind: 'profit_and_loss' as const,
      from: `${month}-01`,
      to: `${month}-30`,
      basis,
      currency: 'USD',
      rows: [{ account: 'Spent on Pinterest ads', amount: usd(987_654), section: 'Earnings', depth: 0 }],
    })
    const books = (connectionId: never, month: string, net: number) => ({
      type: 'report.snapshot' as const,
      externalId: `pnl:${month}:accrual`,
      connectionId,
      kind: 'profit_and_loss' as const,
      from: `${month}-01`,
      to: `${month}-30`,
      basis: 'accrual' as const,
      currency: 'USD',
      rows: [],
      totals: { netIncome: usd(net) },
    })

    it('beside different ledger numbers: no provider_report at all, on either basis, even with a net income to compare', async () => {
      const source = await k.connection({ entityId: acme, key: 'pinterest' })
      const stripe = await k.connection({ entityId: acme, key: 'stripe' })
      await k.engine.postBatch(k.ws, [
        invoice(stripe, { total: usd(100_000), issueDate: '2026-08-05', dueDate: '2026-09-05' }),
        report(source as never, '2026-08'),
        report(source as never, '2026-08', 'cash'),
        { ...report(source as never, '2026-07'), rows: [{ account: 'Net Income', amount: usd(5), section: '', depth: 0 }] },
        { ...report(source as never, '2026-06'), totals: { netIncome: usd(7) } },
      ])
      expect((await k.engine.checks(k.ws)).filter((c) => c.name === 'provider_report')).toEqual([])
      expect((await k.engine.dataHealth(k.ws)).counts.failedChecks).toBe(0)
    })

    it("never takes QuickBooks' or Xero's place for the same period, whichever arrived last", async () => {
      for (const [key, sourceFirst] of [['quickbooks', true], ['quickbooks', false], ['xero', true], ['xero', false]] as const) {
        const kit = await makeKit(backend, { now: '2026-10-09T12:00:00.000Z' })
        try {
          const acmeId = await kit.company('Acme')
          const ledger = await kit.connection({ entityId: acmeId, key })
          const source = await kit.connection({ entityId: acmeId, key: 'pinterest' })
          const both = [report(source as never, '2026-08'), books(ledger as never, '2026-08', 50_000)]
          await kit.engine.postBatch(kit.ws, [invoice(ledger, { total: usd(100_000), issueDate: '2026-08-05', dueDate: '2026-09-05' }), ...(sourceFirst ? both : both.reverse())])
          const checks = (await kit.engine.checks(kit.ws)).filter((c) => c.name === 'provider_report')
          expect(checks.map((c) => [c.status, c.expectedMinor, c.actualMinor])).toEqual([['fail', 50_000, 100_000]])
        } finally {
          await kit.close()
        }
      }
    })
  })
  describe('AdSense: a report-only source is not books', () => {
    const report = (connectionId: never, month: string, basis: 'accrual' | 'cash' = 'accrual') => ({
      type: 'report.snapshot' as const,
      externalId: `adsense:${month}:USD:${basis}`,
      connectionId,
      kind: 'profit_and_loss' as const,
      from: `${month}-01`,
      to: `${month}-30`,
      basis,
      currency: 'USD',
      rows: [{ account: 'Estimated AdSense earnings', amount: usd(987_654), section: 'Earnings', depth: 0 }],
    })
    const books = (connectionId: never, month: string, net: number) => ({
      type: 'report.snapshot' as const,
      externalId: `pnl:${month}:accrual`,
      connectionId,
      kind: 'profit_and_loss' as const,
      from: `${month}-01`,
      to: `${month}-30`,
      basis: 'accrual' as const,
      currency: 'USD',
      rows: [],
      totals: { netIncome: usd(net) },
    })

    it('beside different ledger numbers: no provider_report at all, on either basis, even with a net income to compare', async () => {
      const source = await k.connection({ entityId: acme, key: 'adsense' })
      const stripe = await k.connection({ entityId: acme, key: 'stripe' })
      await k.engine.postBatch(k.ws, [
        invoice(stripe, { total: usd(100_000), issueDate: '2026-08-05', dueDate: '2026-09-05' }),
        report(source as never, '2026-08'),
        report(source as never, '2026-08', 'cash'),
        { ...report(source as never, '2026-07'), rows: [{ account: 'Net Income', amount: usd(5), section: '', depth: 0 }] },
        { ...report(source as never, '2026-06'), totals: { netIncome: usd(7) } },
      ])
      expect((await k.engine.checks(k.ws)).filter((c) => c.name === 'provider_report')).toEqual([])
      expect((await k.engine.dataHealth(k.ws)).counts.failedChecks).toBe(0)
    })

    it("never takes QuickBooks' or Xero's place for the same period, whichever arrived last", async () => {
      for (const [key, sourceFirst] of [['quickbooks', true], ['quickbooks', false], ['xero', true], ['xero', false]] as const) {
        const kit = await makeKit(backend, { now: '2026-10-09T12:00:00.000Z' })
        try {
          const acmeId = await kit.company('Acme')
          const ledger = await kit.connection({ entityId: acmeId, key })
          const source = await kit.connection({ entityId: acmeId, key: 'adsense' })
          const both = [report(source as never, '2026-08'), books(ledger as never, '2026-08', 50_000)]
          await kit.engine.postBatch(kit.ws, [invoice(ledger, { total: usd(100_000), issueDate: '2026-08-05', dueDate: '2026-09-05' }), ...(sourceFirst ? both : both.reverse())])
          const checks = (await kit.engine.checks(kit.ws)).filter((c) => c.name === 'provider_report')
          expect(checks.map((c) => [c.status, c.expectedMinor, c.actualMinor])).toEqual([['fail', 50_000, 100_000]])
        } finally {
          await kit.close()
        }
      }
    })
  })

  describe('YouTube: a report-only source is not books', () => {
    const report = (connectionId: never, month: string, basis: 'accrual' | 'cash' = 'accrual') => ({
      type: 'report.snapshot' as const,
      externalId: `youtube:${month}:USD:${basis}`,
      connectionId,
      kind: 'profit_and_loss' as const,
      from: `${month}-01`,
      to: `${month}-30`,
      basis,
      currency: 'USD',
      rows: [{ account: 'Estimated YouTube earnings', amount: usd(987_654), section: 'Earnings', depth: 0 }],
    })
    const books = (connectionId: never, month: string, net: number) => ({
      type: 'report.snapshot' as const,
      externalId: `pnl:${month}:accrual`,
      connectionId,
      kind: 'profit_and_loss' as const,
      from: `${month}-01`,
      to: `${month}-30`,
      basis: 'accrual' as const,
      currency: 'USD',
      rows: [],
      totals: { netIncome: usd(net) },
    })

    it('beside different ledger numbers: no provider_report at all, on either basis, even with a net income to compare', async () => {
      const source = await k.connection({ entityId: acme, key: 'youtube' })
      const stripe = await k.connection({ entityId: acme, key: 'stripe' })
      await k.engine.postBatch(k.ws, [
        invoice(stripe, { total: usd(100_000), issueDate: '2026-08-05', dueDate: '2026-09-05' }),
        report(source as never, '2026-08'),
        report(source as never, '2026-08', 'cash'),
        { ...report(source as never, '2026-07'), rows: [{ account: 'Net Income', amount: usd(5), section: '', depth: 0 }] },
        { ...report(source as never, '2026-06'), totals: { netIncome: usd(7) } },
      ])
      expect((await k.engine.checks(k.ws)).filter((c) => c.name === 'provider_report')).toEqual([])
      expect((await k.engine.dataHealth(k.ws)).counts.failedChecks).toBe(0)
    })

    it("never takes QuickBooks' or Xero's place for the same period, whichever arrived last", async () => {
      for (const [key, sourceFirst] of [['quickbooks', true], ['quickbooks', false], ['xero', true], ['xero', false]] as const) {
        const kit = await makeKit(backend, { now: '2026-10-09T12:00:00.000Z' })
        try {
          const acmeId = await kit.company('Acme')
          const ledger = await kit.connection({ entityId: acmeId, key })
          const source = await kit.connection({ entityId: acmeId, key: 'youtube' })
          const both = [report(source as never, '2026-08'), books(ledger as never, '2026-08', 50_000)]
          await kit.engine.postBatch(kit.ws, [invoice(ledger, { total: usd(100_000), issueDate: '2026-08-05', dueDate: '2026-09-05' }), ...(sourceFirst ? both : both.reverse())])
          const checks = (await kit.engine.checks(kit.ws)).filter((c) => c.name === 'provider_report')
          expect(checks.map((c) => [c.status, c.expectedMinor, c.actualMinor])).toEqual([['fail', 50_000, 100_000]])
        } finally {
          await kit.close()
        }
      }
    })
  })

  describe('Squarespace: a report-only source is not books', () => {
    const report = (connectionId: never, month: string, basis: 'accrual' | 'cash' = 'accrual') => ({
      type: 'report.snapshot' as const,
      externalId: `squarespace:${month}:USD:${basis}`,
      connectionId,
      kind: 'profit_and_loss' as const,
      from: `${month}-01`,
      to: `${month}-30`,
      basis,
      currency: 'USD',
      rows: [{ account: 'Net sales reported by the store', amount: usd(987_654), section: 'Sales', depth: 0 }],
    })
    const books = (connectionId: never, month: string, net: number) => ({
      type: 'report.snapshot' as const,
      externalId: `pnl:${month}:accrual`,
      connectionId,
      kind: 'profit_and_loss' as const,
      from: `${month}-01`,
      to: `${month}-30`,
      basis: 'accrual' as const,
      currency: 'USD',
      rows: [],
      totals: { netIncome: usd(net) },
    })

    it('beside different ledger numbers: no provider_report at all, on either basis, even with a net income to compare', async () => {
      const source = await k.connection({ entityId: acme, key: 'squarespace' })
      const stripe = await k.connection({ entityId: acme, key: 'stripe' })
      await k.engine.postBatch(k.ws, [
        invoice(stripe, { total: usd(100_000), issueDate: '2026-08-05', dueDate: '2026-09-05' }),
        report(source as never, '2026-08'),
        report(source as never, '2026-08', 'cash'),
        { ...report(source as never, '2026-07'), rows: [{ account: 'Net Income', amount: usd(5), section: '', depth: 0 }] },
        { ...report(source as never, '2026-06'), totals: { netIncome: usd(7) } },
      ])
      expect((await k.engine.checks(k.ws)).filter((c) => c.name === 'provider_report')).toEqual([])
      expect((await k.engine.dataHealth(k.ws)).counts.failedChecks).toBe(0)
    })

    it("never takes QuickBooks' or Xero's place for the same period, whichever arrived last", async () => {
      for (const [key, sourceFirst] of [['quickbooks', true], ['quickbooks', false], ['xero', true], ['xero', false]] as const) {
        const kit = await makeKit(backend, { now: '2026-10-09T12:00:00.000Z' })
        try {
          const acmeId = await kit.company('Acme')
          const ledger = await kit.connection({ entityId: acmeId, key })
          const source = await kit.connection({ entityId: acmeId, key: 'squarespace' })
          const both = [report(source as never, '2026-08'), books(ledger as never, '2026-08', 50_000)]
          await kit.engine.postBatch(kit.ws, [invoice(ledger, { total: usd(100_000), issueDate: '2026-08-05', dueDate: '2026-09-05' }), ...(sourceFirst ? both : both.reverse())])
          const checks = (await kit.engine.checks(kit.ws)).filter((c) => c.name === 'provider_report')
          expect(checks.map((c) => [c.status, c.expectedMinor, c.actualMinor])).toEqual([['fail', 50_000, 100_000]])
        } finally {
          await kit.close()
        }
      }
    })
  })

  describe('Wix: a report-only source is not books', () => {
    const report = (connectionId: never, month: string, basis: 'accrual' | 'cash' = 'accrual') => ({
      type: 'report.snapshot' as const,
      externalId: `wix:${month}:USD:${basis}`,
      connectionId,
      kind: 'profit_and_loss' as const,
      from: `${month}-01`,
      to: `${month}-30`,
      basis,
      currency: 'USD',
      rows: [{ account: 'Net sales reported by the store', amount: usd(987_654), section: 'Sales', depth: 0 }],
    })
    const books = (connectionId: never, month: string, net: number) => ({
      type: 'report.snapshot' as const,
      externalId: `pnl:${month}:accrual`,
      connectionId,
      kind: 'profit_and_loss' as const,
      from: `${month}-01`,
      to: `${month}-30`,
      basis: 'accrual' as const,
      currency: 'USD',
      rows: [],
      totals: { netIncome: usd(net) },
    })

    it('beside different ledger numbers: no provider_report at all, on either basis, even with a net income to compare', async () => {
      const source = await k.connection({ entityId: acme, key: 'wix' })
      const stripe = await k.connection({ entityId: acme, key: 'stripe' })
      await k.engine.postBatch(k.ws, [
        invoice(stripe, { total: usd(100_000), issueDate: '2026-08-05', dueDate: '2026-09-05' }),
        report(source as never, '2026-08'),
        report(source as never, '2026-08', 'cash'),
        { ...report(source as never, '2026-07'), rows: [{ account: 'Net Income', amount: usd(5), section: '', depth: 0 }] },
        { ...report(source as never, '2026-06'), totals: { netIncome: usd(7) } },
      ])
      expect((await k.engine.checks(k.ws)).filter((c) => c.name === 'provider_report')).toEqual([])
      expect((await k.engine.dataHealth(k.ws)).counts.failedChecks).toBe(0)
    })

    it("never takes QuickBooks' or Xero's place for the same period, whichever arrived last", async () => {
      for (const [key, sourceFirst] of [['quickbooks', true], ['quickbooks', false], ['xero', true], ['xero', false]] as const) {
        const kit = await makeKit(backend, { now: '2026-10-09T12:00:00.000Z' })
        try {
          const acmeId = await kit.company('Acme')
          const ledger = await kit.connection({ entityId: acmeId, key })
          const source = await kit.connection({ entityId: acmeId, key: 'wix' })
          const both = [report(source as never, '2026-08'), books(ledger as never, '2026-08', 50_000)]
          await kit.engine.postBatch(kit.ws, [invoice(ledger, { total: usd(100_000), issueDate: '2026-08-05', dueDate: '2026-09-05' }), ...(sourceFirst ? both : both.reverse())])
          const checks = (await kit.engine.checks(kit.ws)).filter((c) => c.name === 'provider_report')
          expect(checks.map((c) => [c.status, c.expectedMinor, c.actualMinor])).toEqual([['fail', 50_000, 100_000]])
        } finally {
          await kit.close()
        }
      }
    })
  })

  describe('SumUp: a report-only source is not books', () => {
    const report = (connectionId: never, month: string, basis: 'accrual' | 'cash' = 'accrual') => ({
      type: 'report.snapshot' as const,
      externalId: `sumup:${month}:USD:${basis}`,
      connectionId,
      kind: 'profit_and_loss' as const,
      from: `${month}-01`,
      to: `${month}-30`,
      basis,
      currency: 'USD',
      rows: [{ account: 'Paid out by SumUp', amount: usd(987_654), section: 'Payouts', depth: 0 }],
    })
    const books = (connectionId: never, month: string, net: number) => ({
      type: 'report.snapshot' as const,
      externalId: `pnl:${month}:accrual`,
      connectionId,
      kind: 'profit_and_loss' as const,
      from: `${month}-01`,
      to: `${month}-30`,
      basis: 'accrual' as const,
      currency: 'USD',
      rows: [],
      totals: { netIncome: usd(net) },
    })

    it('beside different ledger numbers: no provider_report at all, on either basis, even with a net income to compare', async () => {
      const source = await k.connection({ entityId: acme, key: 'sumup' })
      const stripe = await k.connection({ entityId: acme, key: 'stripe' })
      await k.engine.postBatch(k.ws, [
        invoice(stripe, { total: usd(100_000), issueDate: '2026-08-05', dueDate: '2026-09-05' }),
        report(source as never, '2026-08'),
        report(source as never, '2026-08', 'cash'),
        { ...report(source as never, '2026-07'), rows: [{ account: 'Net Income', amount: usd(5), section: '', depth: 0 }] },
        { ...report(source as never, '2026-06'), totals: { netIncome: usd(7) } },
      ])
      expect((await k.engine.checks(k.ws)).filter((c) => c.name === 'provider_report')).toEqual([])
      expect((await k.engine.dataHealth(k.ws)).counts.failedChecks).toBe(0)
    })

    it("never takes QuickBooks' or Xero's place for the same period, whichever arrived last", async () => {
      for (const [key, sourceFirst] of [['quickbooks', true], ['quickbooks', false], ['xero', true], ['xero', false]] as const) {
        const kit = await makeKit(backend, { now: '2026-10-09T12:00:00.000Z' })
        try {
          const acmeId = await kit.company('Acme')
          const ledger = await kit.connection({ entityId: acmeId, key })
          const source = await kit.connection({ entityId: acmeId, key: 'sumup' })
          const both = [report(source as never, '2026-08'), books(ledger as never, '2026-08', 50_000)]
          await kit.engine.postBatch(kit.ws, [invoice(ledger, { total: usd(100_000), issueDate: '2026-08-05', dueDate: '2026-09-05' }), ...(sourceFirst ? both : both.reverse())])
          const checks = (await kit.engine.checks(kit.ws)).filter((c) => c.name === 'provider_report')
          expect(checks.map((c) => [c.status, c.expectedMinor, c.actualMinor])).toEqual([['fail', 50_000, 100_000]])
        } finally {
          await kit.close()
        }
      }
    })
  })

  it("a gap the connector can't read is explained, and the advice changes once payroll comes from elsewhere", async () => {
    const books = await k.connection({ entityId: acme, key: 'xero' })
    const notCovered = { text: 'connect payroll to include wages', withPayroll: 'your payroll connection is counted instead' }
    const report = (month: string) => ({ type: 'report.snapshot' as const, externalId: `pnl:${month}`, connectionId: books, kind: 'profit_and_loss' as const, from: `${month}-01`, to: `${month}-30`, basis: 'accrual' as const, currency: 'USD', rows: [], totals: { netIncome: usd(-500_000) }, notCovered })
    const payroll = await k.connection({ entityId: acme, key: 'finch' })
    await k.engine.postBatch(k.ws, [
      report('2026-08'),
      report('2026-09'),
      { type: 'payroll.run', externalId: 'run-9', connectionId: payroll, payDate: '2026-09-15', gross: usd(100_000), employerTaxes: usd(0), net: usd(90_000), status: 'paid', source: 'provider' } as never,
    ])
    const msgs = (await k.engine.checks(k.ws)).filter((c) => c.name === 'provider_report').map((c) => c.message).sort()
    expect(msgs).toEqual([
      'Acme: net income 2026-08-01 to 2026-08-30 (accrual) is $0.00 here and -$5,000.00 in Xero. connect payroll to include wages',
      'Acme: net income 2026-09-01 to 2026-09-30 (accrual) is $0.00 here and -$5,000.00 in Xero. your payroll connection is counted instead',
    ])
  })

  it('statement-only accounts are stale after a month, not a week', async () => {
    const upload = await k.account({ entityId: acme, name: 'Savings', connectionId: await k.connection({ key: 'files' }) })
    await k.engine.postBatch(k.ws, [txn(upload, '2026-09-15', 10_000)])
    const cash = await k.engine.metric('cash', { workspaceId: k.ws, entityIds: [acme] })
    expect([cash.state ?? 'ok', cash.value]).toEqual(['ok', usd(10_000)])
  })
  it('a disconnected source is never "not syncing", and money in health lines reads as money', async () => {
    const gone = await k.connection({ entityId: acme, lastSuccessAt: '2026-09-01T00:00:00Z', status: 'disconnected' })
    await k.account({ entityId: acme, name: 'Old Xero', connectionId: gone })
    const health = await k.engine.dataHealth(k.ws)
    expect(health.items.filter((x) => x.kind === 'stale_source').map((x) => x.refId)).not.toContain(gone)
    expect((await k.engine.metric('cash', { workspaceId: k.ws, entityIds: [acme] })).staleSources).not.toContain(gone)
    for (const x of health.items) expect(x.text).not.toMatch(/ has -?\d{3,} not matched| -?\d{3,} of money in/)
  })
})

describe.each(backends)('the workspace time zone (%s)', (backend) => {
  it('a balance read on a New York evening belongs to that evening, not to tomorrow (UTC)', async () => {
    const k = await makeKit(backend, { now: '2026-10-11T02:54:00.000Z', timeZone: 'America/New_York' })
    try {
      const acme = await k.company('Acme')
      const saving = await k.account({ entityId: acme, name: 'Saving', mask: '1111' })
      // First sync, 22:54 on Oct 10 in New York: the balance and the rows up to that day.
      await k.engine.postBatch(k.ws, [txn(saving, '2026-10-06', 42_200), snapshot(saving, '2026-10-11T02:54:00Z', 21_000)])
      const [snap] = await k.engine.store.listRecords(k.ws, { eventTypes: ['balance.snapshot'] })
      expect(snap?.date).toBe('2026-10-10')
      // The next morning the bank posts a row dated Oct 11 (local): it comes after that balance, not before it.
      k.setNow('2026-10-11T14:00:00.000Z')
      await k.engine.postBatch(k.ws, [txn(saving, '2026-10-11', -2_500)])
      expect(await k.bal(acme, `cash:${saving.id}`, 'cash', '2026-10-10')).toBe(21_000)
      expect(await k.bal(acme, `cash:${saving.id}`)).toBe(18_500)
      const pin = await k.engine.addBalanceAssertion(k.ws, { accountId: saving.id, date: '2026-10-10', balance: usd(21_000) })
      expect((await k.engine.checks(k.ws)).find((c) => c.subjectId === pin.id)?.status).toBe('ok')
    } finally {
      await k.close()
    }
  })
})

