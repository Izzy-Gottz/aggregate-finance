import { describe, expect, it } from 'vitest'
import type { CreditNoteUpsert, InvoiceUpsert, PaymentApplied } from '@agfn/contracts'
import { accountIndex, itemIndex, lineRole, mapBill, mapCashEntity, mapInvoiceEvents, mapJournalEntry, mapProfitAndLoss, type MapContext } from './map.ts'

const usd = (minor: number) => ({ minor, currency: 'USD' })
const accounts = accountIndex([
  { Id: '35', Name: 'Checking', Classification: 'Asset', AccountType: 'Bank' },
  { Id: '41', Name: 'Mastercard', Classification: 'Liability', AccountType: 'Credit Card' },
  { Id: '15', Name: 'Office Expenses', Classification: 'Expense', AccountType: 'Expense' },
  { Id: '66', Name: 'Job Expenses:Job Materials:Plants and Soil', Classification: 'Expense', AccountType: 'Expense' },
  { Id: '80', Name: 'Cost of Goods Sold', Classification: 'Expense', AccountType: 'Cost of Goods Sold' },
  { Id: '14', Name: 'Miscellaneous', Classification: 'Expense', AccountType: 'Other Expense' },
  { Id: '83', Name: 'Other Income', Classification: 'Revenue', AccountType: 'Other Income' },
  { Id: '79', Name: 'Sales of Product Income', Classification: 'Revenue', AccountType: 'Income' },
  { Id: '40', Name: 'Truck', Classification: 'Asset', AccountType: 'Fixed Asset' },
])
const ctx: MapContext = { connectionId: 'conn_qbo', homeCurrency: 'USD', accounts }
const expenseLine = (amount: number, id: string) => ({ Amount: amount, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: id } } })

describe('QuickBooks lines land where QuickBooks reports them', () => {
  it('the account type decides the section; balance-sheet accounts are not P&L', () => {
    expect(lineRole({ value: '80' }, ctx, 'expense')).toBe('cogs')
    expect(lineRole({ value: '14' }, ctx, 'expense')).toBe('other_expense')
    expect(lineRole({ value: '83' }, ctx, 'income')).toBe('other_income')
    // "Materials" in the name doesn't make an Expense account cost of goods sold.
    expect(lineRole({ value: '66', name: 'Plants and Soil' }, ctx, 'expense')).toBe('other_expense')
    // A bill line on a balance-sheet account goes to that kind of account, never the P&L; on income lines, nowhere.
    expect(lineRole({ value: '40' }, ctx, 'expense')).toBe('fixed_assets')
    expect(lineRole({ value: '40' }, ctx, 'income')).toBeNull()
    expect(lineRole({ value: '35' }, ctx, 'expense')).toBeNull()
    expect(lineRole({ name: 'Insurance' }, { ...ctx, accounts: new Map() }, 'expense')).toBe('insurance')
  })

  it('a bill line on an asset account books to that asset; the bill keeps its full amount owed', () => {
    const bill = mapBill({ Id: '9', TxnDate: '2026-09-02', TotalAmt: 1100, Balance: 1100, VendorRef: { name: 'Dealer' }, Line: [expenseLine(100, '15'), expenseLine(1000, '40')] }, ctx)!
    expect(bill.total).toEqual(usd(110_000))
    expect(bill.lines?.map((l) => [l.category, l.amount.minor])).toEqual([['other_expense', 10_000], ['fixed_assets', 100_000]])
  })

  it('inventory: bought into Inventory, its cost moves to COGS when it sells', () => {
    const c = { ...ctx, items: itemIndex([{ Id: '5', Type: 'Inventory', PurchaseCost: 125 }, { Id: '17', Type: 'Inventory', PurchaseCost: 2.5 }, { Id: '9', Type: 'Service' }], 'USD') }
    const itemLine = (amount: number, item: string, qty: number) => ({ Amount: amount, DetailType: 'ItemBasedExpenseLineDetail', ItemBasedExpenseLineDetail: { ItemRef: { value: item }, Qty: qty } })
    const bill = mapBill({ Id: '126', TxnDate: '2026-09-14', TotalAmt: 205, Balance: 205, VendorRef: { name: 'Norton Lumber' }, Line: [itemLine(125, '5', 1), itemLine(80, '17', 32)] }, c)!
    expect(bill.lines?.map((l) => l.category)).toEqual(['inventory', 'inventory'])
    const sale = (Id: string) => ({ Id, TxnDate: '2026-09-14', TotalAmt: 314.28, Balance: 314.28, DocNumber: '1035', CustomerRef: { name: 'Mark Cho' }, TxnTaxDetail: { TotalTax: 23.28 }, Line: [
      { Amount: 275, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { Qty: 1, ItemRef: { value: '5' }, ItemAccountRef: { value: '79' } } },
      { Amount: 16, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { Qty: 4, ItemRef: { value: '17' }, ItemAccountRef: { value: '79' } } },
      { Amount: 40, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { Qty: 1, ItemRef: { value: '9' }, ItemAccountRef: { value: '79' } } },
    ] })
    const [inv, cogs] = mapInvoiceEvents(sale('119'), c)
    expect(inv).toMatchObject({ type: 'invoice.upsert', externalId: '119' })
    expect(cogs).toEqual({ type: 'journal.upsert', externalId: 'cogs:119', connectionId: 'conn_qbo', date: '2026-09-14', memo: 'Cost of items sold · 1035', status: 'posted', lines: [{ role: 'cogs', amount: usd(13_500) }, { role: 'inventory', amount: usd(-13_500) }] })
    expect(mapCashEntity('SalesReceipt', sale('11'), c).map((e) => [e.type, e.externalId])).toEqual([['invoice.upsert', 'salesreceipt:11'], ['payment.applied', 'salesreceipt:11'], ['journal.upsert', 'cogs:salesreceipt:11']])
  })
})

describe('money that moved without an invoice or bill', () => {
  it('Purchase → a paid bill and its payment, in its own id space', () => {
    const ev = mapCashEntity('Purchase', { Id: '9', TxnDate: '2026-09-12', TotalAmt: 505, PaymentType: 'CreditCard', AccountRef: { value: '41' }, EntityRef: { name: 'Hicks Hardware' }, Line: [expenseLine(405, '80'), expenseLine(100, '14')] }, ctx)
    const [doc, pay] = ev as [InvoiceUpsert, PaymentApplied]
    expect(doc).toMatchObject({ type: 'invoice.upsert', externalId: 'purchase:9', direction: 'payable', counterparty: 'Hicks Hardware', issueDate: '2026-09-12', total: usd(50_500), amountPaid: usd(50_500), status: 'paid' })
    expect(doc.lines?.map((l) => l.category)).toEqual(['cogs', 'other_expense'])
    expect(pay).toMatchObject({ type: 'payment.applied', externalId: 'purchase:9', direction: 'payable', date: '2026-09-12', amount: usd(50_500), applications: [{ invoiceExternalId: 'purchase:9', amount: usd(50_500) }], method: 'CreditCard', status: 'posted' })
  })

  it('a card credit (Purchase.Credit) is less spending', () => {
    const [n] = mapCashEntity('Purchase', { Id: '10', TxnDate: '2026-09-13', TotalAmt: 25, Credit: true, EntityRef: { name: 'Hicks Hardware' }, Line: [expenseLine(25, '15')] }, ctx) as [CreditNoteUpsert]
    expect(n).toMatchObject({ type: 'credit_note.upsert', externalId: 'purchase:10', direction: 'payable', amount: usd(2_500), appliedTo: 'refund', status: 'applied' })
  })

  it('SalesReceipt → a paid invoice and its payment; tax stays out of income', () => {
    const [doc, pay] = mapCashEntity('SalesReceipt', { Id: '11', TxnDate: '2026-09-14', TotalAmt: 108, CustomerRef: { name: 'Kate Whelan' }, TxnTaxDetail: { TotalTax: 8 }, Line: [{ Amount: 100, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemAccountRef: { value: '79' } } }] }, ctx) as [InvoiceUpsert, PaymentApplied]
    expect(doc).toMatchObject({ externalId: 'salesreceipt:11', direction: 'receivable', total: usd(10_800), tax: usd(800), status: 'paid' })
    expect(pay).toMatchObject({ externalId: 'salesreceipt:11', direction: 'receivable', amount: usd(10_800) })
  })

  it('RefundReceipt → a customer refund as paid, with its tax', () => {
    const [n] = mapCashEntity('RefundReceipt', { Id: '12', TxnDate: '2026-09-15', TotalAmt: 54, CustomerRef: { name: 'Pye' }, TxnTaxDetail: { TotalTax: 4 }, Line: [{ Amount: 50, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: {} }] }, ctx) as [CreditNoteUpsert]
    expect(n).toMatchObject({ externalId: 'refundreceipt:12', direction: 'receivable', amount: usd(5_400), tax: usd(400), appliedTo: 'refund' })
  })

  it('Deposit: linked payments are already counted; other income and fees are not', () => {
    const ev = mapCashEntity('Deposit', {
      Id: '13',
      TxnDate: '2026-09-16',
      TotalAmt: 1180,
      Line: [
        { Amount: 1000, LinkedTxn: [{ TxnId: '55', TxnType: 'Payment' }] },
        { Amount: 200, DetailType: 'DepositLineDetail', DepositLineDetail: { AccountRef: { value: '83' } } },
        { Amount: -20, DetailType: 'DepositLineDetail', DepositLineDetail: { AccountRef: { value: '15' } } },
        { Amount: 0, DetailType: 'DepositLineDetail', DepositLineDetail: { AccountRef: { value: '35' } } },
      ],
    }, ctx)
    expect(ev.map((e) => [e.type, e.externalId])).toEqual([['invoice.upsert', 'deposit:13'], ['payment.applied', 'deposit:13'], ['invoice.upsert', 'deposit:13~fee'], ['payment.applied', 'deposit:13~fee']])
    expect((ev[0] as InvoiceUpsert).total).toEqual(usd(20_000))
    // The fee taken out of the deposit is spending: a paid bill of $20.
    expect(ev[2]).toMatchObject({ direction: 'payable', total: usd(2_000), status: 'paid', lines: [{ category: 'other_expense', amount: usd(2_000) }] })
  })
})

describe('QuickBooks journal entries and deposits', () => {
  const je = (lines: Array<[string, 'Debit' | 'Credit', number]>) => ({
    Id: '501',
    TxnDate: '2026-09-30',
    PrivateNote: 'September depreciation',
    Line: lines.map(([acct, side, amount]) => ({ Amount: amount, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: side, AccountRef: { value: acct } } })),
  })

  it('a journal touching the P&L posts its P&L lines (debit +, credit −) and one balancing balance-sheet line', () => {
    const e = mapJournalEntry(je([['15', 'Debit', 120], ['40', 'Credit', 120]]), ctx)!
    expect(e).toMatchObject({ type: 'journal.upsert', externalId: 'je:501', date: '2026-09-30', status: 'posted', memo: 'September depreciation' })
    expect(e.lines).toEqual([
      { role: lineRole({ value: '15' }, ctx, 'expense'), amount: usd(12_000), accountExternalId: '15' },
      { role: 'other_liabilities', amount: usd(-12_000), memo: 'Balance sheet side in QuickBooks' },
    ])
    expect(e.lines.reduce((t, l) => t + l.amount.minor, 0)).toBe(0)
    // Income credited: a negative income line.
    expect(mapJournalEntry(je([['35', 'Debit', 50], ['83', 'Credit', 50]]), ctx)!.lines[0]).toMatchObject({ role: 'other_income', amount: usd(-5_000) })
  })

  it('a journal only between balance-sheet accounts is left out (it never touches the books we report)', () => {
    expect(mapJournalEntry(je([['35', 'Debit', 100], ['40', 'Credit', 100]]), ctx)).toBeNull()
  })

  it("a deposit's payer comes from its lines when the deposit itself names none", () => {
    const out = mapCashEntity(
      'Deposit',
      { Id: '77', TxnDate: '2026-09-12', Line: [{ Amount: 250, DetailType: 'DepositLineDetail', DepositLineDetail: { AccountRef: { value: '79' }, Entity: { value: '3', name: 'Cool Cars', type: 'CUSTOMER' } } }] },
      ctx,
    )
    expect(out.find((e) => e.type === 'invoice.upsert')).toMatchObject({ counterparty: 'Cool Cars' })
  })
})

describe('QuickBooks P&L reports', () => {
  const period = { from: '2026-11-01', to: '2026-11-01', basis: 'accrual' as const }
  const summary = (group: string, label: string, cols: unknown[] = []) => ({ group, type: 'Section', Summary: { ColData: [{ value: label }, ...cols] } })

  it('a period with no activity (the Account column alone, labels only) is an empty snapshot, not a failed sync', () => {
    // What the sandbox returned on 2026-11-01 for month to date.
    const report = {
      Header: { Currency: 'USD', StartPeriod: '2026-11-01', EndPeriod: '2026-11-01', Option: [{ Name: 'NoReportData', Value: 'true' }] },
      Columns: { Column: [{ ColTitle: '', ColType: 'Account' }] },
      Rows: { Row: [summary('Income', 'Total Income'), summary('GrossProfit', 'Gross Profit'), summary('Expenses', 'Total Expenses'), summary('NetOperatingIncome', 'Net Operating Income'), summary('NetIncome', 'Net Income')] },
    }
    const snap = mapProfitAndLoss(report, ctx, period)
    expect(snap.rows).toEqual([])
    expect(snap).not.toHaveProperty('totals')
  })

  it('amounts come from the Money column', () => {
    const report = {
      Header: { Currency: 'USD' },
      Columns: { Column: [{ ColTitle: '', ColType: 'Account' }, { ColTitle: 'Total', ColType: 'Money' }] },
      Rows: { Row: [summary('Income', 'Total Income', [{ value: '1250.50' }]), summary('NetIncome', 'Net Income', [{ value: '-3.2e-14' }])] },
    }
    const snap = mapProfitAndLoss(report, ctx, period)
    expect(snap.rows.map((r) => [r.account, r.amount.minor])).toEqual([['Total Income', 125050], ['Net Income', 0]])
    expect(snap.totals).toMatchObject({ netIncome: { minor: 0 }, income: { minor: 125050 } })
  })
})
