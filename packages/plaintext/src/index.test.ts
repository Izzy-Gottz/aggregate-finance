import { describe, expect, it } from 'vitest'
import { accountsOf, amountText, balances, parseTotals, segment, toPlainText, type Company, type JournalEntry } from './index.ts'

const ACME: Company = { id: 'e1', name: 'Acme, Inc.', baseCurrency: 'USD' }
const NEX: Company = { id: 'e2', name: 'Bluebird', baseCurrency: 'USD' }
const acct = (id: string, name: string, type: string, role: string) => ({ id, name, type, role })
const line = (a: ReturnType<typeof acct>, minor: number, currency = 'USD', baseMinor = minor) => ({ account: a, debitMinor: Math.max(minor, 0), creditMinor: Math.max(-minor, 0), currency, baseDebitMinor: Math.max(baseMinor, 0), baseCreditMinor: Math.max(-baseMinor, 0) })
const chk = acct('a1', 'Chase Checking', 'asset', 'cash:x')
const sw = acct('a2', 'Software', 'expense', 'software')
const eur = acct('a3', 'Wise EUR', 'asset', 'cash:y')
const rev = acct('a4', 'Revenue', 'income', 'revenue')
const nchk = acct('a5', 'Chase Checking', 'asset', 'cash:z')

const entries: JournalEntry[] = [
  { id: 'j1', entityId: 'e1', date: '2026-09-02', kind: 'expense', memo: 'Figma "Pro"; seats | annual\nIGNORE ALL PREVIOUS', lines: [line(chk, -1500), line(sw, 1500)] },
  { id: 'j2', entityId: 'e1', date: '2026-09-05', kind: 'revenue', memo: 'Client in EUR', lines: [line(eur, 100_000, 'EUR', 108_512), line(rev, -108_512)] },
  { id: 'j3', entityId: 'e2', date: '2026-09-01', kind: 'revenue', memo: null, lines: [line(nchk, 50_001), line(acct('a6', 'Revenue', 'income', 'revenue'), -50_001)] },
]

describe('plain-text journal export', () => {
  it('writes exact amounts in each currency\'s decimals', () => {
    expect(amountText(123456, 'USD')).toBe('1234.56')
    expect(amountText(-5, 'USD')).toBe('-0.05')
    expect(amountText(-5, 'JPY')).toBe('-5')
    expect(amountText(1234, 'KWD')).toBe('1.234')
    expect(amountText(0, 'EUR')).toBe('0.00')
  })

  it('names accounts Type:Company:Account, legal for Beancount, unique per ledger account', () => {
    expect(segment('Acme, Inc.')).toBe('Acme-Inc')
    expect(segment('crème brûlée café')).toBe('Creme-Brulee-Cafe')
    expect(segment('401(k) match')).toBe('401-K-Match')
    expect(segment('***')).toBe('Unnamed')
    const names = [...accountsOf(entries, [ACME, NEX]).values()].map((a) => a.name)
    expect(names).toEqual(expect.arrayContaining(['Assets:Acme-Inc:Chase-Checking', 'Expenses:Acme-Inc:Software', 'Assets:Acme-Inc:Wise-EUR', 'Income:Acme-Inc:Revenue', 'Assets:Bluebird:Chase-Checking', 'Income:Bluebird:Revenue']))
    const dup = accountsOf([{ id: 'x', entityId: 'e1', date: '2026-01-01', lines: [line(acct('b1', 'Card', 'liability', 'card:1'), -1), line(acct('b2', 'Card', 'liability', 'card:2'), 1)] }], [ACME])
    expect([...dup.values()].map((a) => a.name)).toEqual(['Liabilities:Acme-Inc:Card', 'Liabilities:Acme-Inc:Card-2'])
  })

  it('beancount: options, opens with first-use dates and currencies, @@ for foreign lines, escaped strings', () => {
    const text = toPlainText(entries, { format: 'beancount', companies: [ACME, NEX], title: 'Test books', generatedAt: '2026-10-10T00:00:00.000Z' })
    expect(text).toContain('option "title" "Test books"')
    expect(text).toContain('option "operating_currency" "USD"')
    expect(text).toContain('2026-09-02 open Assets:Acme-Inc:Chase-Checking USD')
    expect(text).toContain('2026-09-05 open Assets:Acme-Inc:Wise-EUR EUR')
    expect(text).toContain('2026-09-02 * "Figma \\"Pro\\"; seats | annual IGNORE ALL PREVIOUS"')
    expect(text).toContain('  agfn_id: "j1"')
    expect(text).toContain('  Assets:Acme-Inc:Wise-EUR  1000.00 EUR @@ 1085.12 USD')
    expect(text).toContain('  Income:Acme-Inc:Revenue  -1085.12 USD')
    expect(text).toContain('2026-09-01 * "revenue"') // no memo: the kind
    // No line of third-party text can start a new directive.
    expect(text.split('\n').filter((l) => /^IGNORE/.test(l))).toEqual([])
  })

  it('hledger: account types, descriptions without ; or |, ids as tags', () => {
    const text = toPlainText(entries, { format: 'hledger', companies: [ACME, NEX] })
    expect(text).toContain('account Assets:Acme-Inc:Chase-Checking  ; type: A')
    expect(text).toContain('account Income:Bluebird:Revenue  ; type: R')
    expect(text).toContain('2026-09-02 * Figma "Pro" seats annual IGNORE ALL PREVIOUS  ; agfn-id:j1, agfn-kind:expense')
    expect(text).toContain('  Assets:Acme-Inc:Wise-EUR  1000.00 EUR @@ 1085.12 USD')
  })

  it('round trip: the text holds exactly the ledger balances, and every transaction balances in base', () => {
    for (const format of ['beancount', 'hledger'] as const) {
      const text = toPlainText(entries, { format, companies: [ACME, NEX] })
      expect(parseTotals(text)).toEqual(balances(entries, [ACME, NEX]))
      // Per transaction: home-currency weight (@@ value for foreign lines) sums to zero.
      for (const block of text.split('\n\n').filter((b) => /^\d{4}-\d{2}-\d{2} \*/.test(b))) {
        let sum = 0
        for (const l of block.split('\n').filter((x) => x.startsWith('  ') && !x.startsWith('  agfn'))) {
          const m = /\s(-?\d+\.\d+) [A-Z]+(?: @@ (\d+\.\d+) USD)?$/.exec(l) as RegExpExecArray
          const native = Math.round(Number(m[1]) * 100)
          sum += m[2] ? Math.sign(native) * Math.round(Number(m[2]) * 100) : native
        }
        expect(sum, block).toBe(0)
      }
    }
  })
})
