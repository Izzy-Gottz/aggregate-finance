// Statement layouts of the big US banks, written from their public sample statements. Each one says how to recognise
// the statement, where its period, account number and opening/closing balances are, and which sections hold the
// transactions with what sign. Nothing here is trusted on its own: statement.ts only imports a statement whose rows
// add up to its printed balances and section totals, so a layout that drifts (the bank redesigns its PDF) falls
// back to "Ask your AI to read it" instead of importing wrong money.
import type { AccountType } from '@agfn/contracts'
import type { PdfLine } from './lines.ts'
import { parseDate, parseMoney } from './values.ts'

export interface PdfSection {
  name: string
  /** The section's header line (the whole line, so a summary line with the same words and an amount doesn't match). */
  start: RegExp
  end?: RegExp
  /** The printed total line; its amount must equal the section's rows. */
  total?: RegExp
  /**
   * in / out: amounts are printed unsigned (or all one sign) and the section says which way. printed: use the sign.
   * columns: separate money-in and money-out columns; each amount's side is the column header it sits under.
   */
  sign: 'in' | 'out' | 'printed' | 'columns'
  /** For sign 'columns': the header labels of the in, out and (ignored) balance columns. */
  columns?: { in: RegExp; out: RegExp; balance?: RegExp }
  /** The last amount on a row is the running balance; the amount is the one before it. */
  balanceColumn?: boolean
}

/** A summary figure: the amount after a label, or read some other way (a value under a table header). */
export type Figure = RegExp | ((lines: PdfLine[]) => number | null)

export interface PdfLayout {
  id: string
  label: string
  institution: string
  accountType: AccountType
  /** Shown as the account's name with the last four digits: "Chase checking ••1234". */
  accountName: string
  /** All must appear in the first two pages. */
  match: RegExp[]
  period(text: string): { from?: string; to: string } | null
  /** Group 1 holds the account number (masked or not); its last four digits are used. */
  account: RegExp
  /** The amount right after this label, or a reader for a summary table. Cards: the balance owed. */
  opening: Figure
  closing: Figure
  sections: PdfSection[]
  /** Lines that end every section (year-to-date totals, rate tables). */
  stop?: RegExp
  /** Lines that are never rows or wrapped descriptions (page footers, column headers). */
  skip?: RegExp[]
  /** For sign 'printed': is a positive amount money in (bank) or a charge (card)? */
  printedPositiveIs?: 'in' | 'out'
}

const LONG_DATE = String.raw`[A-Z][a-z]+\.? \d{1,2}, \d{4}`
const SHORT_DATE = String.raw`\d{2}\/\d{2}\/\d{2,4}`

function range(re: RegExp): (text: string) => { from: string; to: string } | null {
  return (text) => {
    const m = re.exec(text)
    const from = m && parseDate(m[1]!)
    const to = m && parseDate(m[2]!)
    return from && to ? { from, to } : null
  }
}

/** A summary table: the amount on the line below `label`, in the cell nearest the label's column. */
function underHeader(label: RegExp): (lines: PdfLine[]) => number | null {
  return (lines) => {
    const i = lines.findIndex((l) => l.cells.some((c) => label.test(c.text)))
    const head = lines[i]?.cells.find((c) => label.test(c.text))
    const next = lines[i + 1]
    if (!head || !next) return null
    const best = next.cells.map((c) => ({ c, v: parseMoney(c.text) })).filter((x) => x.v !== null).sort((a, b) => Math.abs(a.c.x - head.x) - Math.abs(b.c.x - head.x))[0]
    return best ? best.v : null
  }
}

/** "Ending balance on 9/30" with the year from the statement's long date ("September 30, 2026"). */
function slashPeriod(fromRe: RegExp, toRe: RegExp): (text: string) => { from?: string; to: string } | null {
  return (text) => {
    const year = /[A-Z][a-z]+ \d{1,2}, (\d{4})/.exec(text)?.[1]
    const t = toRe.exec(text)?.[1]
    if (!year || !t) return null
    const to = parseDate(`${t}/${year}`)
    if (!to) return null
    const f = fromRe.exec(text)?.[1]
    const fy = f && Number(f.split('/')[0]) > Number(to.slice(5, 7)) ? Number(year) - 1 : Number(year)
    const from = f ? parseDate(`${f}/${fy}`) : null
    return from ? { from, to } : { to }
  }
}

const FOOTERS = [/^Page \d+ of \d+/i, /^\d+ of \d+$/, /^(DATE|Date) .*(AMOUNT|Amount)/]
const header = (words: string) => new RegExp(`^(\\*start\\*)?${words}( - continued| \\(continued\\))?$`, 'i')

export const PDF_LAYOUTS: PdfLayout[] = [
  {
    // Chase Total/Business checking: a summary, then one TRANSACTION DETAIL table, amounts signed, running balance.
    id: 'chase-checking-pdf',
    label: 'Chase checking statement',
    institution: 'Chase',
    accountType: 'depository',
    accountName: 'Chase checking',
    match: [/JPMorgan Chase Bank/i, /CHECKING SUMMARY/i, /TRANSACTION DETAIL/i],
    period: range(new RegExp(`(${LONG_DATE}) ?through ?(${LONG_DATE})`)),
    account: /Account Number:?\s*([\dX* ]{4,})/i,
    opening: /Beginning Balance/i,
    closing: /Ending Balance/i,
    sections: [{ name: 'Transaction detail', start: header('TRANSACTION DETAIL'), end: /^(\*end\*)?Ending Balance|^\*end\*transaction detail/i, sign: 'printed', balanceColumn: true }],
    skip: [...FOOTERS, /^Beginning Balance/i],
    printedPositiveIs: 'in',
  },
  {
    // Chase credit cards: ACCOUNT ACTIVITY with payments (printed negative), purchases, fees and interest.
    id: 'chase-card-pdf',
    label: 'Chase credit card statement',
    institution: 'Chase',
    accountType: 'credit_card',
    accountName: 'Chase card',
    match: [/chase\.com|JPMorgan Chase Bank/i, /ACCOUNT SUMMARY/i, /ACCOUNT ACTIVITY/i, /Previous Balance/i],
    period: range(new RegExp(`Opening/Closing Date\\s*(${SHORT_DATE})\\s*-\\s*(${SHORT_DATE})`)),
    account: /Account Number:?\s*([\dX ]{12,})/i,
    opening: /Previous Balance/i,
    closing: /New Balance/i,
    sections: [
      { name: 'Payments and other credits', start: header('PAYMENTS AND OTHER CREDITS'), sign: 'printed' },
      { name: 'Purchases', start: header('PURCHASES?'), sign: 'printed' },
      { name: 'Cash advances', start: header('CASH ADVANCES?'), sign: 'printed' },
      { name: 'Balance transfers', start: header('BALANCE TRANSFERS?'), sign: 'printed' },
      { name: 'Fees charged', start: header('FEES CHARGED'), total: /^TOTAL FEES FOR THIS PERIOD/i, sign: 'printed' },
      { name: 'Interest charged', start: header('INTEREST CHARGED'), total: /^TOTAL INTEREST FOR THIS PERIOD/i, sign: 'printed' },
    ],
    stop: /^\d{4} Totals Year-to-Date|^Totals Year-to-Date|^INTEREST CHARGES$/i,
    skip: FOOTERS,
    printedPositiveIs: 'out',
  },
  {
    // Bank of America checking/savings: deposits, withdrawals, checks and fees in their own sections, each totalled.
    id: 'bofa-checking-pdf',
    label: 'Bank of America checking statement',
    institution: 'Bank of America',
    accountType: 'depository',
    accountName: 'Bank of America checking',
    match: [/Bank of America/i, /Deposits and other additions/i, /Withdrawals and other subtractions/i, /Beginning balance on/i],
    period: range(new RegExp(`for (${LONG_DATE}) to (${LONG_DATE})`)),
    account: /Account number:?\s*([\d ]{8,})/i,
    opening: new RegExp(`Beginning balance on ${LONG_DATE}`, 'i'),
    closing: new RegExp(`Ending balance on ${LONG_DATE}`, 'i'),
    sections: [
      { name: 'Deposits and other additions', start: header('Deposits and other additions'), total: /^Total deposits and other additions/i, sign: 'in' },
      { name: 'ATM and debit card subtractions', start: header('ATM and debit card subtractions'), total: /^Total ATM and debit card subtractions/i, sign: 'out' },
      { name: 'Other subtractions', start: header('Other subtractions'), total: /^Total other subtractions/i, sign: 'out' },
      { name: 'Withdrawals and other subtractions', start: header('Withdrawals and other subtractions'), total: /^Total withdrawals and other subtractions/i, sign: 'out' },
      { name: 'Checks', start: header('Checks'), total: /^Total checks/i, sign: 'out' },
      { name: 'Service fees', start: header('Service fees'), total: /^Total service fees/i, sign: 'out' },
    ],
    stop: /^Daily ledger balances/i,
    skip: FOOTERS,
  },
  {
    // Bank of America credit cards: payments and credits (printed negative), purchases, fees and interest, each totalled.
    id: 'bofa-card-pdf',
    label: 'Bank of America credit card statement',
    institution: 'Bank of America',
    accountType: 'credit_card',
    accountName: 'Bank of America card',
    match: [/Bank of America/i, /Payments and Other Credits/i, /Purchases and Adjustments/i, /Previous Balance/i],
    period: (text) => {
      const m = new RegExp(`([A-Z][a-z]+\\.? \\d{1,2}) - (${LONG_DATE})`).exec(text)
      const to = m && parseDate(m[2]!)
      if (!m || !to) return null
      const y = Number(to.slice(0, 4))
      const from = parseDate(m[1]!, y)
      return from ? { from: from > to ? (parseDate(m[1]!, y - 1) ?? from) : from, to } : null
    },
    account: /Account#?\s*(?:Number)?:?\s*([\dX ]{12,})/i,
    opening: /Previous Balance/i,
    closing: /New Balance Total/i,
    sections: [
      { name: 'Payments and other credits', start: header('Payments and Other Credits'), total: /^TOTAL PAYMENTS AND OTHER CREDITS FOR THIS PERIOD/i, sign: 'printed' },
      { name: 'Purchases and adjustments', start: header('Purchases and Adjustments'), total: /^TOTAL PURCHASES AND ADJUSTMENTS FOR THIS PERIOD/i, sign: 'printed' },
      { name: 'Fees charged', start: header('Fees Charged'), total: /^TOTAL FEES CHARGED FOR THIS PERIOD/i, sign: 'printed' },
      { name: 'Interest charged', start: header('Interest Charged'), total: /^TOTAL INTEREST CHARGED FOR THIS PERIOD/i, sign: 'printed' },
    ],
    stop: /^\d{4} Totals Year-to-Date|^Interest Charge Calculation/i,
    skip: FOOTERS,
    printedPositiveIs: 'out',
  },
  {
    // American Express cards: a closing date and billing days, payments and credits (printed -$), new charges, fees,
    // interest. Rows carry full dates (MM/DD/YY).
    id: 'amex-card-pdf',
    label: 'American Express statement',
    institution: 'American Express',
    accountType: 'credit_card',
    accountName: 'Amex',
    match: [/American Express/i, /Closing Date/i, /New Charges/i, /Previous Balance/i],
    period: (text) => {
      const close = /Closing Date:?\s*(\d{2}\/\d{2}\/\d{2,4})/i.exec(text)
      const to = close && parseDate(close[1]!)
      if (!to) return null
      const days = /Days in Billing Period:?\s*(\d{1,2})/i.exec(text)
      if (!days) return { to }
      const d = new Date(`${to}T00:00:00Z`)
      d.setUTCDate(d.getUTCDate() - Number(days[1]) + 1)
      return { from: d.toISOString().slice(0, 10), to }
    },
    account: /Account Ending:?\s*([\d-]{4,})/i,
    opening: /Previous Balance/i,
    closing: /New Balance/i,
    sections: [
      { name: 'Payments and credits', start: header('(Payments and Credits|Payments|Credits)'), sign: 'printed' },
      { name: 'New charges', start: header('New Charges'), sign: 'printed' },
      { name: 'Fees', start: header('Fees'), total: /^Total Fees for this Period/i, sign: 'printed' },
      { name: 'Interest charged', start: header('Interest Charged'), total: /^Total Interest Charged for this Period/i, sign: 'printed' },
    ],
    stop: /^\d{4} Fees and Interest Totals Year to Date|^Interest Charge Calculation|^About Trailing Interest/i,
    skip: [...FOOTERS, /^Summary$/i, /^Detail$/i, /^Card Ending/i],
    printedPositiveIs: 'out',
  },
  {
    // Wells Fargo checking: one Transaction history table with separate deposit and withdrawal columns, an ending
    // daily balance on some rows, M/D dates; the year comes from the statement date.
    id: 'wells-checking-pdf',
    label: 'Wells Fargo checking statement',
    institution: 'Wells Fargo',
    accountType: 'depository',
    accountName: 'Wells Fargo checking',
    match: [/Wells Fargo/i, /Transaction history/i, /Ending daily balance/i, /Beginning balance on/i],
    period: slashPeriod(/Beginning balance on (\d{1,2}\/\d{1,2})/i, /Ending balance on (\d{1,2}\/\d{1,2})/i),
    account: /Account number:?\s*(\d{6,})/i,
    opening: /Beginning balance on \d{1,2}\/\d{1,2}/i,
    closing: /Ending balance on \d{1,2}\/\d{1,2}/i,
    sections: [
      {
        name: 'Transaction history',
        start: header('Transaction history'),
        end: /^Ending balance on|^Totals\b/i,
        sign: 'columns',
        columns: { in: /^Deposits\/ ?Additions$/i, out: /^Withdrawals\/ ?Subtractions$/i, balance: /^Ending daily ?balance$/i },
      },
    ],
    skip: [...FOOTERS, /^(Date|Check)\b.*Description/i],
  },
  {
    // Citi credit cards: a billing period, payments and credits (printed negative), standard purchases, fees, interest.
    id: 'citi-card-pdf',
    label: 'Citi credit card statement',
    institution: 'Citi',
    accountType: 'credit_card',
    accountName: 'Citi card',
    match: [/Citi(bank|cards|\b)/, /Billing Period/i, /Previous balance/i, /Standard Purchases/i],
    period: range(new RegExp(`Billing Period:?\\s*(${SHORT_DATE})\\s*-\\s*(${SHORT_DATE})`, 'i')),
    account: /Account number ending in:?\s*(\d{4})/i,
    opening: /Previous balance/i,
    closing: /New balance/i,
    sections: [
      { name: 'Payments, credits and adjustments', start: header('Payments, Credits and Adjustments'), sign: 'printed' },
      { name: 'Standard purchases', start: header('Standard Purchases'), sign: 'printed' },
      { name: 'Fees charged', start: header('Fees Charged'), total: /^Total fees charged this period/i, sign: 'printed' },
      { name: 'Interest charged', start: header('Interest Charged'), total: /^Total interest charged this period/i, sign: 'printed' },
    ],
    stop: /^\d{4} totals year-to-date|^Interest charge calculation/i,
    skip: [...FOOTERS, /^Sale\s+Post/i],
    printedPositiveIs: 'out',
  },
  {
    // Capital One credit cards: "Sep 1" dates (transaction and post), payments printed "- $", one Transactions list
    // per card holder ("NAME #1234: Transactions").
    id: 'capone-card-pdf',
    label: 'Capital One credit card statement',
    institution: 'Capital One',
    accountType: 'credit_card',
    accountName: 'Capital One card',
    match: [/Capital One/i, /days in Billing Cycle/i, /Previous Balance/i, /Account ending in/i],
    period: range(/([A-Z][a-z]{2} \d{1,2}, \d{4}) - ([A-Z][a-z]{2} \d{1,2}, \d{4})/),
    account: /Account ending in:?\s*(\d{4})/i,
    opening: /Previous Balance/i,
    closing: /New Balance/i,
    sections: [
      { name: 'Payments, credits and adjustments', start: /(^|: )Payments, Credits and Adjustments$/i, sign: 'printed' },
      { name: 'Transactions', start: /(^|: )Transactions$/i, total: /^Total Transactions for This Period/i, sign: 'printed' },
      { name: 'Fees', start: header('Fees'), total: /^Total Fees for This Period/i, sign: 'printed' },
      { name: 'Interest charged', start: header('Interest Charged'), total: /^Total Interest for This Period/i, sign: 'printed' },
    ],
    stop: /^Totals Year-to-Date|^Interest Charge Calculation/i,
    skip: [...FOOTERS, /^Trans Date/i],
    printedPositiveIs: 'out',
  },
  {
    // U.S. Bank checking: deposits and withdrawals in titled, totalled sections; "Sep 3" dates; withdrawals often
    // printed with a trailing minus.
    id: 'usbank-checking-pdf',
    label: 'U.S. Bank checking statement',
    institution: 'U.S. Bank',
    accountType: 'depository',
    accountName: 'U.S. Bank checking',
    match: [/U\.S\. Bank/i, /Statement Period/i, /Beginning Balance on/i, /Ending Balance on/i],
    period: range(/Statement Period:?\s*([A-Z][a-z]{2} \d{1,2}, \d{4}),? (?:through|to|-) ([A-Z][a-z]{2} \d{1,2}, \d{4})/i),
    account: /Account Number:?\s*([\d-]{8,})/i,
    opening: /Beginning Balance on [A-Z][a-z]{2} \d{1,2}(, \d{4})?/i,
    closing: /Ending Balance on [A-Z][a-z]{2} \d{1,2}(, \d{4})?/i,
    sections: [
      { name: 'Customer deposits', start: header('Customer Deposits'), total: /^Total Customer Deposits/i, sign: 'in' },
      { name: 'Other deposits', start: header('Other Deposits'), total: /^Total Other Deposits/i, sign: 'in' },
      { name: 'Card withdrawals', start: header('Card Withdrawals'), total: /^Total Card Withdrawals/i, sign: 'out' },
      { name: 'Other withdrawals', start: header('Other Withdrawals'), total: /^Total Other Withdrawals/i, sign: 'out' },
      { name: 'Checks', start: header('Checks Presented Conventionally'), total: /^Total Checks/i, sign: 'out' },
    ],
    stop: /^Balance Summary/i,
    skip: [...FOOTERS, /^Date\s+Description/i],
  },
  {
    // PNC checking: a Balance Summary table (labels on one line, amounts on the next), deposits and deductions with
    // subsections, the amount printed before the description.
    id: 'pnc-checking-pdf',
    label: 'PNC checking statement',
    institution: 'PNC',
    accountType: 'depository',
    accountName: 'PNC checking',
    match: [/PNC Bank/i, /Balance Summary/i, /Deposits and Other Additions/i, /Checks and Other Deductions/i],
    period: range(/For the period\s*(\d{2}\/\d{2}\/\d{4})\s*to\s*(\d{2}\/\d{2}\/\d{4})/i),
    account: /account number:?\s*([\dX-]{6,})/i,
    opening: underHeader(/^Beginning balance$/i),
    closing: underHeader(/^Ending balance$/i),
    sections: [
      { name: 'Deposits and other additions', start: header('Deposits and Other Additions'), sign: 'in' },
      { name: 'Checks and other deductions', start: header('Checks and Other Deductions'), sign: 'out' },
    ],
    stop: /^Daily Balance Detail/i,
    skip: [
      ...FOOTERS,
      /^(Deposits|ACH Additions|Other Additions|Checks and Substitute Checks|Debit Card Purchases|POS Purchases|ACH Deductions|Service Charges and Fees|Other Deductions)$/i,
      /^There (were|was) \d+/i,
      /^Date posted/i,
    ],
  },
  {
    // Mercury business checking: "Sep 3" dates, signed amounts (money out printed with a minus), starting and ending
    // balances in the summary.
    id: 'mercury-checking-pdf',
    label: 'Mercury statement',
    institution: 'Mercury',
    accountType: 'depository',
    accountName: 'Mercury',
    match: [/Mercury/i, /Starting balance/i, /Ending balance/i, /Money in/i],
    period: range(/([A-Z][a-z]{2} \d{1,2}, \d{4}) ?[–-] ?([A-Z][a-z]{2} \d{1,2}, \d{4})/),
    account: /(?:Checking|Savings|Account)\s*(?:••|\.\.|\*+|x{2,}|ending in)\s*(\d{4})/i,
    opening: /Starting balance/i,
    closing: /Ending balance/i,
    sections: [{ name: 'Transactions', start: header('Transactions'), sign: 'printed' }],
    skip: [...FOOTERS, /^Date\s+Description/i],
    printedPositiveIs: 'in',
  },
]
