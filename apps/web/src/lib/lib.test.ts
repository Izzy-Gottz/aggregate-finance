import { describe, expect, it } from 'vitest'
import { exponent, fmt, parseAmount, sum } from './money.ts'
import { ago, dueWords } from './time.ts'
import { markRechecked, recentlyRechecked } from './recheck.ts'
import { CANT_EVER, companiesText, dataText, expiryText, grantLine, grantSentence, listWords, sentenceText } from './grant.ts'
import type { GrantShape } from '@agfn/contracts'
import type { EntitySummary } from '../api/types.ts'

const usd = (minor: number) => ({ minor, currency: 'USD' })

describe('money', () => {
  it('formats whole dollars without cents for big amounts', () => {
    expect(fmt(usd(28_441_000))).toBe('$284,410')
    expect(fmt(usd(-821_400))).toBe('−$8,214')
  })
  it('shows cents for small amounts that have them, or when asked', () => {
    expect(fmt(usd(41237))).toBe('$412.37')
    expect(fmt(usd(134022), { cents: true })).toBe('$1,340.22')
    expect(fmt(usd(612_00))).toBe('$612')
  })
  it('signs incoming money when asked', () => {
    expect(fmt(usd(120000), { signed: true })).toBe('+$1,200')
    expect(fmt(null)).toBe('–')
  })
  it('knows zero-decimal currencies', () => {
    expect(exponent('JPY')).toBe(0)
    expect(fmt({ minor: 5000, currency: 'JPY' })).toBe('¥5,000')
  })
  it('parses what people type into minor units, never floats', () => {
    expect(parseAmount('1,200', 'USD')).toEqual(usd(120000))
    expect(parseAmount('$0.10', 'USD')).toEqual(usd(10))
    expect(parseAmount('19.99', 'USD')).toEqual(usd(1999))
    expect(parseAmount('1.234', 'USD')).toBeNull()
    expect(parseAmount('abc', 'USD')).toBeNull()
    expect(parseAmount('500', 'JPY')).toEqual({ minor: 500, currency: 'JPY' })
  })
  it('sums one currency', () => {
    expect(sum([usd(100), usd(250), { minor: 9, currency: 'EUR' }], 'USD')).toEqual(usd(350))
  })
})

describe('time', () => {
  const now = Date.parse('2026-10-09T16:00:00Z')
  it('reads relative times in plain words', () => {
    expect(ago('2026-10-09T15:58:00Z', now)).toBe('2 min ago')
    expect(ago('2026-10-09T14:00:00Z', now)).toBe('2h ago')
    expect(ago('2026-10-08T10:00:00Z', now)).toBe('yesterday')
    expect(ago('2026-10-02T10:00:00Z', now)).toBe('Oct 2')
    expect(ago(null, now)).toBe('never')
  })
  it('colours due dates by meaning', () => {
    expect(dueWords('2026-09-05', now)).toEqual({ text: '34 days overdue', tone: 'red' })
    expect(dueWords('2026-10-12', now).tone).toBe('amber')
    expect(dueWords('2026-11-01', now)).toEqual({ text: 'due Nov 1', tone: 'grey' })
  })
})

describe('control sentence', () => {
  const now = Date.parse('2026-10-09T16:00:00Z')
  const ents: EntitySummary[] = [
    { id: 'a', kind: 'company', name: 'Acme', currency: 'USD', cash: null, hidden: false },
    { id: 'n', kind: 'company', name: 'Bluebird Studio', currency: 'USD', cash: null, hidden: false },
    { id: 'c', kind: 'company', name: 'Harbor Coffee', currency: 'USD', cash: null, hidden: false },
  ]
  const shape: GrantShape = {
    entityIds: ['a', 'n'],
    dataTypes: ['balances', 'transactions', 'invoices'],
    write: true,
    reviewMode: 'instant',
    expiresAt: new Date(now + 90 * 86_400_000).toISOString(),
  }
  it('reads exactly like the spec', () => {
    expect(sentenceText(grantSentence('Claude', shape, ents, now))).toBe(
      'Claude can see Acme and Bluebird Studio: balances, transactions, invoices. Can add records. Changes apply immediately. Expires in 90 days.',
    )
  })
  it('marks every variable part as a clickable slot', () => {
    const slots = grantSentence('Claude', shape, ents, now).flatMap((p) => ('slot' in p ? [p.slot] : []))
    expect(slots).toEqual(['companies', 'data', 'write', 'review', 'expiry'])
  })
  it('handles all companies, read only, review, never expiring', () => {
    const s = { ...shape, entityIds: 'all' as const, write: false, reviewMode: 'review_all' as const, expiresAt: null }
    expect(sentenceText(grantSentence('ChatGPT', s, ents, now))).toBe(
      'ChatGPT can see all your companies: balances, transactions, invoices. Read only. Changes wait for your review. Never expires.',
    )
    expect(grantLine(s, ents)).toBe('all companies · read only')
    expect(grantLine(shape, ents)).toBe('Acme and Bluebird Studio · read + add')
  })
  it('lists words naturally', () => {
    expect(listWords(['A'])).toBe('A')
    expect(listWords(['A', 'B', 'C'])).toBe('A, B and C')
    expect(companiesText({ ...shape, entityIds: [] }, ents)).toBe('nothing yet')
    expect(dataText({ ...shape, dataTypes: [] })).toBe('no data')
    // Investment positions ride on the equity grant: the label says so, so an owner knows the portfolio is included.
    expect(dataText({ ...shape, dataTypes: ['equity'] })).toBe('cap table & investments')
    expect(expiryText({ ...shape, expiresAt: new Date(now + 30 * 86_400_000).toISOString() }, now)).toBe('Expires in 30 days')
    // A 1-hour key is not "tomorrow" (QA round 6).
    expect(expiryText({ ...shape, expiresAt: new Date(now + 60 * 60_000).toISOString() }, now)).toBe('Expires in an hour')
    expect(expiryText({ ...shape, expiresAt: new Date(now + 5 * 60 * 60_000).toISOString() }, now)).toBe('Expires in 5 hours')
    expect(expiryText({ ...shape, expiresAt: new Date(now + 20 * 60_000).toISOString() }, now)).toBe('Expires in 20 minutes')
    expect(expiryText({ ...shape, expiresAt: new Date(now + 30 * 60 * 60_000).toISOString() }, now)).toBe('Expires tomorrow')
  })
  it('keeps the permanent line', () => {
    expect(CANT_EVER).toBe('Can’t ever: move money, pay bills, send invoices or emails.')
  })
})

import { termsLine } from './terms.ts'
describe('termsLine', () => {
  it('shows only what the provider sent', () => {
    expect(termsLine({ kind: 'credit', apr: '24.9', minimumPayment: { minor: 3500, currency: 'USD' }, nextPaymentDueDate: '2026-10-28' })).toBe('Min $35 due Oct 28 · 24.9% APR')
    expect(termsLine({ kind: 'mortgage', nextPaymentDueDate: '2026-11-01' })).toBe('Payment due Nov 1')
    expect(termsLine({ kind: 'student', apr: '5.500' })).toBe('5.5% APR')
    expect(termsLine({ kind: 'other' })).toBeNull()
    expect(termsLine(undefined)).toBeNull()
  })
})

describe('email re-check memory', () => {
  it('remembers the time for 9 minutes in this tab, and nothing when storage is off', () => {
    const g = globalThis as { sessionStorage?: unknown }
    const before = g.sessionStorage
    const m = new Map<string, string>()
    g.sessionStorage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
    try {
      expect(recentlyRechecked(1_000)).toBe(false)
      markRechecked(1_000)
      expect([...m.values()]).toEqual(['1000'])
      expect(recentlyRechecked(1_000 + 8 * 60_000)).toBe(true)
      expect(recentlyRechecked(1_000 + 9 * 60_000)).toBe(false)
      g.sessionStorage = { getItem: () => { throw new Error('off') }, setItem: () => { throw new Error('off') } }
      expect(() => markRechecked()).not.toThrow()
      expect(recentlyRechecked()).toBe(false)
    } finally {
      g.sessionStorage = before
    }
  })
})

describe('typed currency', () => {
  it('reads €, £, ¥ and a code; “$” and bare numbers leave the form’s currency', async () => {
    const { typedCurrency, parseTyped } = await import('./money.ts')
    expect(typedCurrency('€450,000')).toBe('EUR')
    expect(typedCurrency('450000 eur')).toBe('EUR')
    expect(typedCurrency('GBP 1,200.50')).toBe('GBP')
    expect(typedCurrency('$450,000')).toBeNull()
    expect(typedCurrency('450,000')).toBeNull()
    expect(parseTyped('€450,000', 'USD')).toEqual({ minor: 45_000_000, currency: 'EUR' })
    expect(parseTyped('450000 EUR', 'USD')).toEqual({ minor: 45_000_000, currency: 'EUR' })
    expect(parseTyped('$1,200', 'USD')).toEqual({ minor: 120_000, currency: 'USD' })
    expect(parseTyped('¥5000', 'USD')).toEqual({ minor: 5000, currency: 'JPY' })
  })
})
