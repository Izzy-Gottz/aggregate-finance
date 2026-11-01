import { describe, expect, it } from 'vitest'
import { extractPdfText } from './extract.ts'
import { amex, bofaCard, bofaChecking, capOneCard, chaseCard, chaseChecking, citiCard, mercury, pncChecking, usBankChecking, wellsChecking } from './samples.ts'
import { parsePdfStatement, type PdfStatementResult } from './statement.ts'
import { makePdf } from './test-kit.ts'
import { parseDate, parseMoney } from './values.ts'

async function parse(pdf: Uint8Array): Promise<PdfStatementResult> {
  const t = await extractPdfText(pdf)
  if (t.status !== 'text') throw new Error(`no text: ${t.status}`)
  return parsePdfStatement(t.lines)
}
const amounts = (r: PdfStatementResult) => (r.ok ? r.statement.rows.map((x) => [x.date, x.amount.minor]) : r)

describe('PDF statements', () => {
  it('Chase checking: signed amounts beside a running balance, imported when it reconciles', async () => {
    const r = await parse(chaseChecking({ wrap: 'SAMPLE CITY ST card 1234' }))
    expect(amounts(r)).toEqual([['2026-09-03', -450], ['2026-09-15', 200_000], ['2026-09-20', -50_000]])
    if (!r.ok) return
    expect(r.statement.rows[0]!.description).toBe('Card Purchase 09/02 Sample Coffee Co SAMPLE CITY ST card 1234')
    expect(r.statement.account).toMatchObject({ externalId: 'pdf:chase:depository:6789', mask: '6789', accountType: 'depository', name: 'Chase checking ••6789' })
    expect([r.statement.opening.minor, r.statement.closing.current.minor, r.statement.closing.date]).toEqual([100_000, 249_550, '2026-09-30'])
  }, 30_000)

  it('one cent off anywhere is not imported, and says by how much', async () => {
    const r = await parse(chaseChecking({ closing: '2,495.51' }))
    expect(r).toMatchObject({ ok: false, layout: 'chase-checking-pdf', diffMinor: 1 })
    const dropped = await parse(chaseChecking({ rows: [['09/03', 'Card Purchase Sample Coffee Co', '-4.50', '995.50'], ['09/15', 'Payroll Deposit Example Corp', '2,000.00', '2,995.50']] }))
    expect(dropped).toMatchObject({ ok: false, diffMinor: -50_000 })
  }, 30_000)

  it('Chase card: payments and purchases with the card sign; December rows in a January statement are last year', async () => {
    const r = await parse(chaseCard())
    expect(amounts(r)).toEqual([['2025-12-30', 30_000], ['2025-12-28', -2_500], ['2026-01-05', -41_025]])
    if (!r.ok) return
    // Owed $500 → $635.25: as money, −500.00 → −635.25.
    expect([r.statement.opening.minor, r.statement.closing.current.minor, r.statement.account.mask]).toEqual([-50_000, -63_525, '4321'])
    expect((await parse(chaseCard({ newBalance: '635.00' }))).ok).toBe(false)
    // The coupon names "New Balance" in a heading row before the summary's own line; an authorized user has their own
    // PURCHASE list and a per-card subtotal, and their name doesn't run into the line above.
    const shared = await parse(chaseCard({ couponBox: true, authorizedUser: true, newBalance: '680.25' }))
    expect(amounts(shared)).toEqual([...(amounts(r) as Array<[string, number]>), ['2026-01-09', -4_500]])
    if (shared.ok && r.ok) {
      expect(shared.statement.closing.current.minor).toBe(-68_025)
      expect(shared.statement.rows.map((x) => x.description)).toEqual([...r.statement.rows.map((x) => x.description), 'EXAMPLE PHARMACY SALEM OR'])
    }
    expect((await parse(chaseCard({ couponBox: true, authorizedUser: true, newBalance: '680.26' }))).ok).toBe(false)
  }, 30_000)

  it('Bank of America checking: section signs, printed totals, two checks on one line, ledger balances ignored', async () => {
    const r = await parse(bofaChecking())
    expect(amounts(r)).toEqual([
      ['2026-09-15', 150_000],
      ['2026-09-05', -6_210],
      ['2026-09-18', -20_000],
      ['2026-09-10', -5_000],
      ['2026-09-22', -7_500],
      ['2026-09-30', -1_200],
    ])
    if (r.ok) expect(r.statement.rows[3]!.description).toBe('1001')
    // A section whose printed total disagrees with its rows is refused even if the balances happen to work.
    expect(await parse(bofaChecking({ depositsTotal: '1,500.01' }))).toMatchObject({ ok: false, reason: expect.stringMatching(/Deposits/) })
  }, 30_000)

  it('Bank of America card: transaction and posting dates, reference columns, a period across months', async () => {
    const r = await parse(bofaCard())
    expect(amounts(r)).toEqual([['2026-09-01', 74_000], ['2026-08-30', -5_999]])
    if (!r.ok) return
    expect(r.statement.rows[1]!.description).toBe('SAMPLE SOFTWARE CO 800-555-0123 CA 7731 2468')
    expect([r.statement.period, r.statement.closing.current.minor, r.statement.account.mask]).toEqual([{ from: '2026-08-22', to: '2026-09-21' }, -5_999, '2468'])
    expect((await parse(bofaCard({ purchasesTotal: '59.98' }))).ok).toBe(false)
  }, 30_000)

  it('American Express: -$ payments, $ charges, a wrapped category line, period from the billing days', async () => {
    const r = await parse(amex())
    expect(amounts(r)).toEqual([['2026-09-02', 120_000], ['2026-09-10', -1_240], ['2026-09-21', -7_600]])
    if (!r.ok) return
    expect(r.statement.period).toEqual({ from: '2026-08-29', to: '2026-09-27' })
    expect([r.statement.account.mask, r.statement.closing.current.minor]).toEqual(['5432', -8_840])
    expect((await parse(amex({ newBalance: '88.41' }))).ok).toBe(false)
  }, 30_000)

  it('Wells Fargo checking: which column an amount sits under decides its sign; daily balances are ignored', async () => {
    const r = await parse(wellsChecking())
    expect(amounts(r)).toEqual([['2026-09-02', -3_525], ['2026-09-12', 80_000], ['2026-09-12', -10_000]])
    if (r.ok) expect([r.statement.period, r.statement.account.mask]).toEqual([{ from: '2026-09-01', to: '2026-09-30' }, '3210'])
    expect((await parse(wellsChecking({ closing: '1,664.76' }))).ok).toBe(false)
  }, 30_000)

  it('Citi, Capital One: sale and post dates, "Sep 1" dates, "- $" payments, a per-holder Transactions header', async () => {
    const citi = await parse(citiCard())
    expect(amounts(citi)).toEqual([['2026-09-05', 30_000], ['2026-08-30', -1_560], ['2026-09-14', -3_000]])
    expect((await parse(citiCard({ newBalance: '45.61' }))).ok).toBe(false)
    const cap = await parse(capOneCard())
    expect(amounts(cap)).toEqual([['2026-09-01', 12_000], ['2026-08-25', -1_410], ['2026-09-10', -5_000]])
    if (cap.ok) expect([cap.statement.account.mask, cap.statement.closing.current.minor]).toEqual(['8642', -6_410])
    // The summary box's heading row names "New Balance" (no amount after it) before the "New Balance = $…" line.
    const boxed = await parse(capOneCard({ summaryHeading: true }))
    expect(amounts(boxed)).toEqual(amounts(cap))
    if (boxed.ok) expect(boxed.statement.closing.current.minor).toBe(-6_410)
    // Two card holders, each with a Transactions list and subtotal, under one total for the period.
    const two = await parse(capOneCard({ twoHolders: true, newBalance: '74.10' }))
    expect(amounts(two)).toEqual([['2026-09-01', 12_000], ['2026-08-25', -1_410], ['2026-09-10', -5_000], ['2026-09-12', -1_000]])
    expect((await parse(capOneCard({ twoHolders: true, newBalance: '74.11' }))).ok).toBe(false)
  }, 30_000)

  it('U.S. Bank, PNC, Mercury: trailing minus, a summary table read by column, amounts before descriptions, − signs', async () => {
    expect(amounts(await parse(usBankChecking()))).toEqual([['2026-09-15', 100_000], ['2026-09-04', -7_299], ['2026-09-20', -5_000]])
    expect((await parse(usBankChecking({ closing: '1,377.02' }))).ok).toBe(false)
    const pnc = await parse(pncChecking())
    expect(amounts(pnc)).toEqual([['2026-09-15', 65_000], ['2026-09-06', -1_040], ['2026-09-25', -20_000]])
    if (pnc.ok) expect([pnc.statement.opening.minor, pnc.statement.closing.current.minor, pnc.statement.rows[0]!.description]).toEqual([200_000, 243_960, 'Direct Deposit - Example Payroll'])
    expect((await parse(pncChecking({ ending: '2,439.50' }))).ok).toBe(false)
    const m = await parse(mercury())
    expect(amounts(m)).toEqual([['2026-09-03', -125_000], ['2026-09-15', 250_000]])
    if (m.ok) expect(m.statement.account.mask).toBe('4455')
  }, 30_000)

  it('unknown layouts and statements that look like two banks are not guessed at', async () => {
    const other = makePdf({ pages: [{ texts: [{ x: 50, y: 700, text: 'Sample Credit Union statement' }, { x: 50, y: 680, text: '09/03  Coffee  -4.50' }] }] })
    expect(await parse(other)).toEqual({ ok: false, reason: 'not a statement layout we know' })
    const both = makePdf({
      pages: [{ texts: ['JPMorgan Chase Bank', 'CHECKING SUMMARY', 'TRANSACTION DETAIL', 'Bank of America', 'Deposits and other additions', 'Withdrawals and other subtractions', 'Beginning balance on September 1, 2026'].map((text, i) => ({ x: 50, y: 700 - i * 14, text })) }],
    })
    expect((await parse(both)).ok).toBe(false)
  }, 30_000)

  it('money and dates as statements print them', () => {
    expect(['$1,234.56', '-$12.00', '(12.00)', '12.00-', '12.00 CR', '+$5.00', '0.07', '1234.5', '$1,23.00', '\u2212$3.00', '- $4.00'].map(parseMoney)).toEqual([123_456, -1_200, -1_200, -1_200, -1_200, 500, 7, null, null, -300, -400])
    expect(['September 30, 2026', 'Sep 30, 2026', '09/30/26', '02/30/2026', 'Smarch 3, 2026'].map((s) => parseDate(s))).toEqual(['2026-09-30', '2026-09-30', '2026-09-30', null, null])
  })
})
