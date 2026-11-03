// Unit tests: money math, FX, rules, buckets, matching helpers.
import { describe, expect, it } from 'vitest'
import { allocate, convert, exponentOf, impliedRate, MoneyError, parseAmount, parseDecimal, toWireMoney, decimalToString } from './money.ts'
import { CachedRateSource, FrankfurterRateSource, MemoryRateSource, RateUnavailableError, invertRate, multiplyRates } from './fx.ts'
import { applyRules, globMatch, merchantKey, RuleValidationError, suggestRules, validateRule } from './rules.ts'
import { detectRecurring, dueDates, monthlyEquivalent, scheduleStatus, validateFields, validateValues, BucketValidationError } from './buckets.ts'
import { nameSimilarity } from './matching.ts'
import { defineRole, defaultTemplate, FIXED_ROLES } from './coa.ts'
import { MemoryLedgerStore } from './memory-store.ts'
import type { Rule, SourceRecord } from './model.ts'
import { assertEntryBalanced, LedgerInvariantError } from './validate.ts'

describe('money', () => {
  it('knows ISO exponents', () => {
    expect([exponentOf('USD'), exponentOf('JPY'), exponentOf('KWD'), exponentOf('EUR')]).toEqual([2, 0, 3, 2])
    expect(() => exponentOf('usd')).toThrow(MoneyError)
  })

  it('parses and formats decimal strings exactly', () => {
    expect(parseAmount('1234.56', 'USD')).toEqual({ minor: 123456, currency: 'USD' })
    expect(parseAmount('-0.05', 'USD')).toEqual({ minor: -5, currency: 'USD' })
    expect(parseAmount('1000', 'JPY')).toEqual({ minor: 1000, currency: 'JPY' })
    expect(parseAmount('1.234', 'KWD')).toEqual({ minor: 1234, currency: 'KWD' })
    expect(() => parseAmount('1.234', 'USD')).toThrow(MoneyError)
    expect(() => parseAmount('1e3', 'USD')).toThrow(MoneyError)
    expect(toWireMoney({ minor: -5, currency: 'USD' })).toEqual({ amount: '-0.05', currency: 'USD' })
    expect(toWireMoney({ minor: 1234, currency: 'KWD' })).toEqual({ amount: '1.234', currency: 'KWD' })
    expect(toWireMoney({ minor: 1000, currency: 'JPY' })).toEqual({ amount: '1000', currency: 'JPY' })
  })

  it('converts with exact decimals, rounding halves away from zero', () => {
    expect(convert({ minor: 10_000, currency: 'EUR' }, 'USD', '1.10')).toEqual({ minor: 11_000, currency: 'USD' })
    expect(convert({ minor: 5, currency: 'USD' }, 'EUR', '0.5')).toEqual({ minor: 3, currency: 'EUR' }) // 2.5 → 3
    expect(convert({ minor: -5, currency: 'USD' }, 'EUR', '0.5')).toEqual({ minor: -3, currency: 'EUR' })
    expect(convert({ minor: 10_000, currency: 'USD' }, 'JPY', '149.5')).toEqual({ minor: 14_950, currency: 'JPY' })
    expect(convert({ minor: 14_950, currency: 'JPY' }, 'USD', '0.0066889')).toEqual({ minor: 10_000, currency: 'USD' })
    expect(convert({ minor: 100, currency: 'USD' }, 'KWD', '0.3071')).toEqual({ minor: 307, currency: 'KWD' })
    // 0.1 + 0.2 style float errors can't happen.
    expect(convert({ minor: 30, currency: 'USD' }, 'EUR', '0.1')).toEqual({ minor: 3, currency: 'EUR' })
  })

  it('parses rates including exponent notation', () => {
    expect(decimalToString(parseDecimal('1.0842'))).toBe('1.0842')
    expect(decimalToString(parseDecimal(1e-7))).toBe('0.0000001')
    expect(decimalToString(parseDecimal('2.5E+2'))).toBe('250')
    expect(() => parseDecimal('abc')).toThrow(MoneyError)
  })

  it('allocates by largest remainder so parts always sum exactly', () => {
    expect(allocate(40_000, [100_000, 8_000])).toEqual([37_037, 2_963])
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33])
    expect(allocate(-100, [1, 1, 1])).toEqual([-34, -33, -33])
    for (const total of [1, 7, 99_999, -12_345]) {
      expect(allocate(total, [3, 5, 7]).reduce((a, b) => a + b, 0)).toBe(total)
    }
  })

  it('reports the implied rate of a conversion', () => {
    expect(impliedRate({ minor: 100_000, currency: 'EUR' }, { minor: 110_000, currency: 'USD' })).toBe('1.1')
  })

  it('rejects unsafe integers', () => {
    expect(() => convert({ minor: Number.MAX_SAFE_INTEGER, currency: 'USD' }, 'JPY', '200')).toThrow(MoneyError)
  })
})

describe('fx', () => {
  it('looks back over weekends, inverts and crosses through EUR', async () => {
    const r = new MemoryRateSource().set('2026-10-02', 'EUR', 'USD', '1.10').set('2026-10-02', 'EUR', 'GBP', '0.85')
    expect(await r.rate('2026-10-04', 'EUR', 'USD')).toBe('1.1')
    expect(await r.rate('2026-10-02', 'USD', 'EUR')).toBe(invertRate('1.10'))
    expect(await r.rate('2026-10-02', 'USD', 'GBP')).toBe(multiplyRates(invertRate('1.10'), '0.85'))
    await expect(r.rate('2026-10-20', 'EUR', 'USD')).rejects.toBeInstanceOf(RateUnavailableError)
  })

  it('Frankfurter: retries server errors with backoff, then caches in the store', async () => {
    const calls: string[] = []
    const responses = [new Response('busy', { status: 503 }), new Response(JSON.stringify({ date: '2026-10-02', rates: { USD: 1.0842 } }), { status: 200 })]
    const fetchMock = (async (url: string) => {
      calls.push(url)
      return responses.shift() as Response
    }) as unknown as typeof fetch
    const sleeps: number[] = []
    const fr = new FrankfurterRateSource({ fetch: fetchMock, backoffMs: 10, sleep: async (ms) => void sleeps.push(ms) })
    const store = new MemoryLedgerStore()
    const cached = new CachedRateSource(store, fr)
    expect(await cached.rate('2026-10-02', 'EUR', 'USD')).toBe('1.0842')
    expect(await cached.rate('2026-10-02', 'EUR', 'USD')).toBe('1.0842')
    expect(calls).toEqual(['https://api.frankfurter.dev/v1/2026-10-02?base=EUR&symbols=USD', 'https://api.frankfurter.dev/v1/2026-10-02?base=EUR&symbols=USD'])
    expect(sleeps).toEqual([10])
    expect(await store.getRate('2026-10-02', 'EUR', 'USD')).toBe('1.0842')
  })

  it('Frankfurter: a 404 is final, a bad date never reaches the network', async () => {
    let n = 0
    const fr = new FrankfurterRateSource({
      fetch: (async () => {
        n++
        return new Response('{}', { status: 404 })
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
    })
    await expect(fr.rate('2026-10-02', 'EUR', 'XYZ')).rejects.toBeInstanceOf(RateUnavailableError)
    expect(n).toBe(1)
    await expect(fr.rate('../../etc', 'EUR', 'USD')).rejects.toBeInstanceOf(RateUnavailableError)
    expect(n).toBe(1)
  })
})

type TxnUpsertEvent = Extract<SourceRecord['event'], { type: 'txn.upsert' }>

function rec(counterparty: string, minor: number, id = counterparty): SourceRecord {
  return {
    id,
    workspaceId: 'w',
    connectionId: 'c',
    eventType: 'txn.upsert',
    externalId: id,
    contentHash: '',
    event: { type: 'txn.upsert', externalId: id, connectionId: 'c', accountExternalId: 'a', date: '2026-09-01', amount: { minor, currency: 'USD' }, status: 'posted', counterparty },
    origin: 'connector',
    createdBy: null,
    sourceAccountId: 'acc',
    entityId: 'e',
    status: 'posted',
    date: '2026-09-01',
    amount: { minor, currency: 'USD' },
    postingHash: null,
    provenance: null,
    createdAt: '',
    updatedAt: '',
  }
}

describe('rules', () => {
  it('normalizes merchant names and matches globs in linear time', () => {
    expect(merchantKey('SQ *BLUE BOTTLE 4482')).toBe('sq blue bottle')
    expect(globMatch('*blue*bottle*', 'SQ *BLUE BOTTLE 4482')).toBe(true)
    expect(globMatch('wework', 'WEWORK 1234 NYC')).toBe(true)
    expect(globMatch('*aws*', 'Amazon')).toBe(false)
    const evil = 'a'.repeat(50_000)
    const t0 = Date.now()
    expect(globMatch(`*${'a*'.repeat(100)}b`, evil)).toBe(false)
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it('validates rules', () => {
    expect(() => validateRule({}, { category: 'cloud' })).toThrow(RuleValidationError)
    expect(() => validateRule({ textPatterns: ['***'] }, { category: 'cloud' })).toThrow(RuleValidationError)
    expect(() => validateRule({ textPatterns: ['aws'] }, {})).toThrow(RuleValidationError)
    expect(() => validateRule({ textPatterns: ['aws'] }, { category: 'not_a_role' })).toThrow()
    expect(() => validateRule({ minAbsMinor: 10, maxAbsMinor: 5 }, { category: 'cloud' })).toThrow(RuleValidationError)
    expect(() => validateRule({ textPatterns: ['aws'] }, { category: 'cloud' })).not.toThrow()
  })

  it('first matching rule wins per action field, in priority order', () => {
    const rule = (id: string, priority: number, actions: Rule['actions'], status: Rule['status'] = 'active'): Rule => ({
      id,
      workspaceId: 'w',
      name: id,
      priority,
      conditions: { textPatterns: ['aws'] },
      actions,
      status,
      origin: 'user',
      createdBy: null,
      hitCount: 0,
      lastHitAt: null,
      createdAt: '2026-01-01',
    })
    const res = applyRules([rule('a', 1, { category: 'cloud' }), rule('b', 2, { category: 'software', bucketId: 'bk' }), rule('c', 0, { kind: 'expense' }, 'suggested')], rec('AWS', -100))
    expect(res).toEqual({ actions: { category: 'cloud', bucketId: 'bk' }, ruleIds: ['a', 'b'] })
  })

  it('a counterparty rule matches a row that has only a description (a CSV statement)', () => {
    const rule: Rule = { id: 'r', workspaceId: 'w', name: 'Siemens is revenue', priority: 1, conditions: { counterparty: 'Siemens AG' }, actions: { kind: 'revenue' }, status: 'active', origin: 'user', createdBy: null, hitCount: 0, lastHitAt: null, createdAt: '2026-01-01' }
    const csv = rec('x', 750_000)
    csv.event = { ...(csv.event as TxnUpsertEvent), counterparty: undefined, rawText: 'Siemens AG' }
    expect(applyRules([rule], csv).ruleIds).toEqual(['r'])
    // A named counterparty still has to be that one.
    expect(applyRules([rule], rec('Siemens Energy', 750_000)).ruleIds).toEqual([])
  })

  it('suggests only at the threshold, and never twice', () => {
    const records = [rec('Figma 1', -1, 'r1'), rec('FIGMA 22', -1, 'r2'), rec('figma', -1, 'r3')]
    const overrides = new Map(records.map((r) => [r.id, { recordId: r.id, workspaceId: 'w', category: 'software', updatedBy: null, updatedAt: '' }]))
    expect(suggestRules(records.slice(0, 2), overrides, [], 3)).toEqual([])
    expect(suggestRules(records.slice(0, 2), overrides, [], 2)).toHaveLength(1)
    const [s] = suggestRules(records, overrides, [], 3)
    expect(s?.conditions).toMatchObject({ textPatterns: ['*figma*'], direction: 'out', entityIds: [expect.any(String)] })
    expect(() => suggestRules(records, overrides, [], 1)).toThrow(RuleValidationError)
  })

  it('never learns from Aggregate’s own auto-filing, only from answers (audit: U S Dollar → Other income)', () => {
    const records = [rec('U S Dollar', 50, 'a1'), rec('U S Dollar', 30, 'a2'), rec('U S Dollar', 70, 'a3')]
    const by = (who: string) => new Map(records.map((r) => [r.id, { recordId: r.id, workspaceId: 'w', category: 'other_income', updatedBy: who, updatedAt: '' }]))
    expect(suggestRules(records, by('auto:review'), [], 3)).toEqual([])
    expect(suggestRules(records, by('auto:rule'), [], 3)).toEqual([])
    expect(suggestRules(records, by('person_1'), [], 3)).toHaveLength(1)
  })
})

describe('buckets', () => {
  it('generates due dates, clamping to month end', () => {
    expect(dueDates({ amount: { minor: 1, currency: 'USD' }, direction: 'out', cadence: 'monthly', dueDay: 31, startDate: '2026-01-31' }, '2026-04-30')).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'])
    expect(dueDates({ amount: { minor: 1, currency: 'USD' }, direction: 'out', cadence: 'quarterly', startDate: '2026-01-15' }, '2026-12-31')).toEqual(['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15'])
    expect(dueDates({ amount: { minor: 1, currency: 'USD' }, direction: 'out', cadence: 'biweekly', startDate: '2026-01-02', endDate: '2026-02-01' }, '2026-12-31')).toEqual(['2026-01-02', '2026-01-16', '2026-01-30'])
  })

  it('marks partial payments and tolerances', () => {
    const s = { amount: { minor: 100_000, currency: 'USD' }, direction: 'out' as const, cadence: 'monthly' as const, startDate: '2026-08-01', toleranceMinor: 100 }
    const occ = scheduleStatus(s, [{ recordId: 'a', date: '2026-08-01', amount: { minor: -99_950, currency: 'USD' }, counterparty: null }, { recordId: 'b', date: '2026-09-02', amount: { minor: -50_000, currency: 'USD' }, counterparty: null }], '2026-09-20')
    expect(occ.map((o) => o.status)).toEqual(['paid', 'partial', 'upcoming'])
  })

  it('validates custom fields and values', () => {
    expect(() => validateFields([{ key: 'Bad Key', label: 'x', type: 'text' }])).toThrow(BucketValidationError)
    expect(() => validateFields([{ key: 'kind', label: 'Kind', type: 'select' }])).toThrow(BucketValidationError)
    const fields = [
      { key: 'lender', label: 'Lender', type: 'text' as const, required: true },
      { key: 'rate', label: 'Rate', type: 'number' as const },
      { key: 'principal', label: 'Principal', type: 'money' as const },
      { key: 'kind', label: 'Kind', type: 'select' as const, options: ['term', 'line'] },
    ]
    expect(validateValues(fields, { lender: 'SBA', rate: 6.5, principal: { minor: 1_000_000, currency: 'USD' }, kind: 'term' })).toMatchObject({ lender: 'SBA' })
    expect(() => validateValues(fields, { rate: 1 })).toThrow(/required/)
    expect(() => validateValues(fields, { lender: 'x', kind: 'other' })).toThrow(BucketValidationError)
    expect(() => validateValues(fields, { lender: 'x', nope: 1 })).toThrow(/Unknown field/)
  })

  it('normalizes cadences to a monthly figure and detects recurring charges', () => {
    expect([monthlyEquivalent(1200, 'annual'), monthlyEquivalent(300, 'quarterly'), monthlyEquivalent(1000, 'weekly')]).toEqual([100, 100, 4333])
    const mk = (d: string, minor: number, id: string): SourceRecord => ({ ...rec('NOTION LABS', minor, id), date: d, event: { ...rec('NOTION LABS', minor, id).event, date: d } as SourceRecord['event'] })
    const series = detectRecurring([mk('2026-07-03', -1_600, 'a'), mk('2026-08-03', -1_600, 'b'), mk('2026-09-02', -1_650, 'c')], '2026-10-09')
    expect(series).toHaveLength(1)
    expect(series[0]).toMatchObject({ cadence: 'monthly', monthlyMinor: 1_650 })
    expect(detectRecurring([mk('2026-01-03', -1_600, 'a'), mk('2026-02-03', -1_600, 'b'), mk('2026-03-03', -1_600, 'c')], '2026-10-09')).toEqual([])
  })
})

describe('chart of accounts and invariants', () => {
  it('every fixed role resolves; unknown roles throw', () => {
    expect(defaultTemplate()).toHaveLength(FIXED_ROLES.length)
    expect(defineRole('due_from:ent_1', { entityName: 'Sub' })).toMatchObject({ type: 'asset', name: 'Owed by Sub', normalBalance: 'debit' })
    expect(defineRole('card:acc_1')).toMatchObject({ type: 'liability', normalBalance: 'credit' })
    expect(() => defineRole('cash')).toThrow()
    expect(() => defineRole('revenue; drop table')).toThrow()
  })

  it('refuses an unbalanced entry', () => {
    const line = (d: number, c: number) => ({ id: 'l', entryId: 'e', ledgerAccountId: 'a', debitMinor: d, creditMinor: c, currency: 'USD', baseDebitMinor: d, baseCreditMinor: c, fxRate: '1', bucketId: null, memo: null })
    const entry = { id: 'e', workspaceId: 'w', entityId: 'x', date: '2026-01-01', basis: 'both' as const, kind: 'other' as const, sourceId: 's', memo: null, reversesId: null, reversedById: null, createdAt: '', lines: [line(100, 0), line(0, 99)] }
    expect(() => assertEntryBalanced(entry)).toThrow(LedgerInvariantError)
    expect(() => assertEntryBalanced({ ...entry, lines: [line(100, 0), line(0, 100)] })).not.toThrow()
    expect(() => assertEntryBalanced({ ...entry, lines: [line(100, 100), line(0, 0)] })).toThrow(LedgerInvariantError)
  })
})

describe('matching helpers', () => {
  it('scores names', () => {
    expect(nameSimilarity('Globex Corp', 'GLOBEX CORP ACH 991')).toBeGreaterThanOrEqual(0.9)
    expect(nameSimilarity('Initech', 'Initrode')).toBeLessThan(0.8)
    expect(nameSimilarity('', 'x')).toBe(0)
  })
})
