// The search/rule query language: parsing and matching.
import { describe, expect, it } from 'vitest'
import { matchesFilter, parseQuery, QueryError, type FilterRow } from './query.ts'

const row = (o: Partial<FilterRow> = {}): FilterRow => ({
  text: 'AMAZON WEB SERVICES AWS.AMAZON.CO',
  counterparty: 'AWS',
  amount: { minor: -61_250, currency: 'USD' },
  date: '2026-09-14',
  account: { id: 'acc1', name: 'Chase Checking', mask: '4411' },
  ...o,
})

describe('query language', () => {
  it('parses every term', () => {
    expect(parseQuery('counterparty:"AWS" amount>500 date:2026-09 -refund out account:4411 currency:usd "web services" aws*')).toEqual({
      words: ['web services', 'aws*'],
      notWords: ['refund'],
      counterparty: 'AWS',
      minAbs: 500,
      minExclusive: true,
      direction: 'out',
      from: '2026-09-01',
      to: '2026-09-30',
      accounts: ['4411'],
      currency: 'USD',
    })
    expect(parseQuery('amount:100..250.50 after:2026-01 before:2026-03-15 payee:Figma category:software')).toMatchObject({ minAbs: 100, maxAbs: 250.5, from: '2026-02-01', to: '2026-03-14', counterparty: 'Figma', category: 'software' })
  })

  it('matches rows', () => {
    const m = (q: string, r: FilterRow = row()) => matchesFilter(parseQuery(q), r)
    expect(m('counterparty:"AWS" amount>500 date:2026-09 -refund')).toBe(true)
    expect(m('amount>612.50')).toBe(false)
    expect(m('amount>=612.50')).toBe(true)
    expect(m('amount:612.5')).toBe(true)
    expect(m('in')).toBe(false)
    expect(m('date<2026-09-14')).toBe(false)
    expect(m('amazon*aws')).toBe(true)
    expect(m('-amazon')).toBe(false)
    expect(m('account:chase')).toBe(true)
    expect(m('account:9999')).toBe(false)
    expect(m('amount<10', row({ amount: { minor: -900, currency: 'JPY' } }))).toBe(false)
    expect(m('category:cloud', row({ category: 'cloud' }))).toBe(true)
  })

  it('refuses OR (it would search for the word "or"), and ignores AND (every term must hold anyway)', () => {
    for (const q of ['account:Stripe OR account:Shopify', 'POS OR terminal', 'a || b']) expect(() => parseQuery(q)).toThrow(/OR isn't supported: every term must hold\. Run one query per alternative/)
    expect(parseQuery('out AND software')).toEqual(parseQuery('out software'))
    // Lowercase or a quoted "OR" is still a word to find.
    expect(parseQuery('salt or pepper').words).toEqual(['salt', 'or', 'pepper'])
    expect(parseQuery('"OR"').words).toEqual(['or'])
  })

  it('explains mistakes', () => {
    expect(() => parseQuery('amount>lots')).toThrow(QueryError)
    expect(() => parseQuery('amount>lots')).toThrow('"amount>lots": the amount must be a number like 500 or 12.50')
    expect(() => parseQuery('colour:red')).toThrow('unknown term "colour"')
    expect(() => parseQuery('date:September')).toThrow('dates look like 2026-09 or 2026-09-15')
    expect(() => parseQuery('amount:500..100')).toThrow('The amount range is empty')
  })
})
