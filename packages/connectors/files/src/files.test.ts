import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AccountUpsert, BalanceSnapshot, ConnectionRef, NormalizedEvent, TxnUpsert } from '@agfn/contracts'
import { ConnectorError, MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, assertValidEvents, runConnectorContract } from '@agfn/connector-sdk/testing'
import {
  FILE_ACCEPT,
  createFilesConnector,
  csvRows,
  decodeText,
  detectDateFormat,
  headerSignature,
  importFile,
  importWarnings,
  ingestDocument,
  parseCsv,
  parseDate,
  parseOfx,
  parseOfxDate,
  parseXml,
  planCsvImport,
  suggestMapping,
  type ColumnMapping,
  type FileOutcome,
  type FileSource,
  type ImportOptions,
  type PendingFile,
} from './index.ts'

const FIXTURES = [
  'chase-checking.csv',
  'amex-card.csv',
  'german-bank.csv',
  'preamble-credit-union.csv',
  'ofx102-checking.ofx',
  'qfx-card.qfx',
  'ofx2-savings.ofx',
  'tiny-statement.pdf',
  'camt053-eur-checking.xml',
  'chase-card.csv',
  'bofa-checking.csv',
  'bofa-card.csv',
  'wells-fargo.csv',
  'citi-card.csv',
  'capitalone-card.csv',
  'capitalone-360.csv',
  'usbank.csv',
  'pnc.csv',
  'mercury.csv',
  'apple-card.csv',
  'discover-card.csv',
  'chase-checking.qfx',
  'chase-checking-redownload.qfx',
  'bofa-card.qfx',
  'wells-fargo.qfx',
  'capitalone-card.ofx',
  'camt053-multi-currency.xml',
  'manifest.json',
] as const

const bytes = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/redacted/${name}`, import.meta.url)))
const utf8 = (s: string) => new TextEncoder().encode(s)

const CONN = 'conn_files'
const checking = (o: Partial<ImportOptions> = {}): ImportOptions => ({
  connectionId: CONN,
  accountExternalId: 'file_chk',
  account: { name: 'Business checking', accountType: 'depository', currency: 'USD' },
  raw: new MemoryRawSink(),
  ...o,
})
const card = (o: Partial<ImportOptions> = {}): ImportOptions =>
  checking({ accountExternalId: 'file_card', account: { name: 'Amex', accountType: 'credit_card', currency: 'USD' }, ...o })

const txns = (events: NormalizedEvent[]) => events.filter((e): e is TxnUpsert => e.type === 'txn.upsert')
const golden = (events: NormalizedEvent[]) => txns(events).map((t) => [t.date, t.amount.minor, t.rawText ?? t.counterparty])
const one = <T extends NormalizedEvent>(events: NormalizedEvent[], type: T['type']) => events.filter((e) => e.type === type) as T[]

async function expectInvalid(p: Promise<unknown> | (() => unknown), code?: string) {
  let err: unknown
  try {
    await (typeof p === 'function' ? p() : p)
  } catch (e) {
    err = e
  }
  expect(err).toBeInstanceOf(ConnectorError)
  expect((err as ConnectorError).kind).toBe('invalid_input')
  if (code) expect((err as ConnectorError).code).toBe(code)
  return err as ConnectorError
}

// ---------- Fixtures ----------

describe('fixtures', () => {
  it.each(FIXTURES)('%s is redacted', (name) => {
    // OFX datetimes like 20260102120000 look like 14-digit account numbers to the generic check.
    // camt files use the published example IBANs (ECBS DE/GB, SIX CH) and bank references made up for the fixture.
    assertRedacted(Buffer.from(bytes(name)).toString('latin1'), [/^20\d{12}$/, /^2469216601234567890123\d$/, /^246921660\d{14}$/, /^2026\d{17}$/, /^2026\d{9}[AB]?$/, /^(DE89370400440532013000|GB33BUKB20201555555555|CH9300762011623852957|0532013000|20201555555555|11623852957|9300762011623852957)$/, /^202609300041773\d$/, /^20261001000008\d\d$/])
  })
})

// ---------- CSV golden answers ----------

describe('Chase checking CSV', () => {
  it('maps every row with exact amounts and signs (positive = money in)', async () => {
    const r = await importFile(bytes('chase-checking.csv'), 'chase.csv', checking())
    expect(r.detectedFormat).toBe('csv')
    expect([r.mapping?.source, r.mapping?.preset?.id]).toEqual(['preset', 'chase-checking'])
    expect(r.mapping?.mapping).toMatchObject({
      date: 'Posting Date',
      dateFormat: 'MM/DD/YYYY',
      amount: { kind: 'signed', column: 'Amount', convention: 'positive_is_in' },
      description: 'Description',
      balance: 'Balance',
      decimal: '.',
    })
    expect(r.mapping?.confidence).toBeGreaterThanOrEqual(0.7)
    expect(golden(r.events)).toEqual([
      ['2026-01-08', -1200, 'MONTHLY SERVICE FEE'],
      ['2026-01-07', 7525, 'Zelle payment from SAMPLE PAYER ONE'],
      ['2026-01-06', -100000, 'Payment to card ending in 0042'],
      ['2026-01-05', -25000, 'CHECK 1042'],
      ['2026-01-03', -450, 'COFFEE ROASTERS, SPRINGFIELD'],
      ['2026-01-03', -450, 'COFFEE ROASTERS, SPRINGFIELD'],
      ['2026-01-02', 320000, 'PAYROLL ACME WIDGETS LLC PPD ID: 9000'],
    ])
    assertValidEvents(r.events, { connectionId: CONN })
    const coffee = txns(r.events).filter((t) => t.rawText?.startsWith('COFFEE'))
    expect(new Set(coffee.map((t) => t.externalId)).size).toBe(2)
  })

  it('checks the running balance (newest-first file) and snapshots the latest balance', async () => {
    const r = await importFile(bytes('chase-checking.csv'), 'chase.csv', checking())
    expect(r.balanceCheck).toEqual([
      expect.objectContaining({
        status: 'ok',
        method: 'running_balance',
        opening: { minor: 200000, currency: 'USD' },
        closing: { minor: 400425, currency: 'USD' },
        sum: { minor: 200425, currency: 'USD' },
        difference: { minor: 0, currency: 'USD' },
        rowsChecked: 7,
        mismatches: [],
      }),
    ])
    const [snap] = one<BalanceSnapshot>(r.events, 'balance.snapshot')
    expect(snap).toMatchObject({ externalId: 'file_chk@2026-01-08', current: { minor: 400425, currency: 'USD' }, at: '2026-01-08T23:59:59.000Z' })
  })

  it('stores each row raw with file hash, line number and original cells', async () => {
    const raw = new MemoryRawSink()
    const r = await importFile(bytes('chase-checking.csv'), 'chase.csv', checking({ raw }))
    const fee = txns(r.events)[0] as TxnUpsert
    const stored = raw.records.get(fee.rawRef as string)
    expect(stored).toMatchObject({ kind: 'files.row', externalId: fee.externalId })
    expect(stored?.payload).toMatchObject({ file: r.fileSha256, line: 2, cells: { Description: 'MONTHLY SERVICE FEE', Amount: '-12.00' } })
  })
})

describe('Amex card CSV (positive = charge)', () => {
  it('flips charges to negative and payments/refunds to positive', async () => {
    const r = await importFile(bytes('amex-card.csv'), 'amex.csv', card())
    expect(r.mapping?.mapping.amount).toEqual({ kind: 'signed', column: 'Amount', convention: 'positive_is_out' })
    expect(golden(r.events)).toEqual([
      ['2026-01-12', -123456, 'AIRLINE TICKET'],
      ['2026-01-10', 2345, 'OFFICE SUPPLY CO'],
      ['2026-01-09', 50000, 'AUTOPAY PAYMENT - THANK YOU'],
      ['2026-01-06', -4900, 'CLOUD HOSTING INC'],
      ['2026-01-04', -12345, 'OFFICE SUPPLY CO'],
    ])
    const t = txns(r.events)
    expect(t.map((x) => x.externalId)).toEqual([
      'file_card:AX2601120005',
      'file_card:AX2601100004',
      'file_card:AX2601090003',
      'file_card:AX2601060002',
      'file_card:AX2601040001',
    ])
    expect(t[3]?.categoryHint).toBe('Business Services-Internet Services')
    expect(r.balanceCheck).toEqual([])
    expect(one<AccountUpsert>(r.events, 'account.upsert')[0]?.accountType).toBe('credit_card')
  })

  it('keeps multi-line quoted cells intact and reports the starting line', async () => {
    const raw = new MemoryRawSink()
    const r = await importFile(bytes('amex-card.csv'), 'amex.csv', card({ raw }))
    const hosting = txns(r.events)[3] as TxnUpsert
    const payload = raw.records.get(hosting.rawRef as string)?.payload as { line: number; cells: Record<string, string> }
    expect(payload.cells['Extended Details']).toBe('CLOUD HOSTING INC\nSAN FRANCISCO\nXX')
    expect(payload.line).toBe(7)
  })
})

describe('German bank CSV (semicolons, DD.MM.YYYY, 1.234,56, Soll/Haben)', () => {
  it('reads the indicator column and comma decimals', async () => {
    const r = await importFile(bytes('german-bank.csv'), 'umsaetze.csv', checking({ account: { name: 'Girokonto', accountType: 'depository', currency: 'EUR' } }))
    expect(r.mapping?.mapping).toMatchObject({
      date: 'Buchungstag',
      dateFormat: 'DD.MM.YYYY',
      decimal: ',',
      amount: { kind: 'indicator', column: 'Umsatz', indicator: 'Soll/Haben' },
      counterparty: 'Empfänger/Zahlungspflichtiger',
      description: 'Verwendungszweck',
      currency: 'Währung',
    })
    expect(txns(r.events).map((t) => [t.date, t.amount.minor, t.amount.currency, t.counterparty])).toEqual([
      ['2026-01-02', 123456, 'EUR', 'Beispiel GmbH'],
      ['2026-01-05', -8990, 'EUR', 'Stadtwerke Musterstadt'],
      ['2026-01-07', -102000, 'EUR', 'Muster Versicherung AG'],
      ['2026-01-09', 50000, 'EUR', 'Kunde Beispiel KG'],
      ['2026-01-12', -750, 'EUR', 'Musterbank'],
    ])
    expect(txns(r.events)[3]?.rawText).toBe('Rechnung 2026-002; Teilzahlung')
    expect(txns(r.events).reduce((s, t) => s + t.amount.minor, 0)).toBe(61716)
  })
})

describe('CSV with preamble lines, split columns and a beginning-balance row', () => {
  it('finds the header below the preamble and reads withdrawals/deposits', async () => {
    const r = await importFile(bytes('preamble-credit-union.csv'), 'export.csv', checking())
    expect(r.mapping?.headers).toEqual(['Transaction Date', 'Description', 'Withdrawal', 'Deposit', 'Balance'])
    expect(r.mapping?.mapping.amount).toEqual({ kind: 'split', debit: 'Withdrawal', credit: 'Deposit' })
    expect(golden(r.events)).toEqual([
      ['2026-01-02', 50000, 'Transfer from savings 0042'],
      ['2026-01-04', -120000, 'Rent - January'],
      ['2026-01-04', -3510, 'Card purchase HARDWARE STORE'],
      ['2026-01-10', 105000, 'Mobile deposit'],
      ['2026-01-15', -2500, 'Wire fee'],
    ])
    expect(r.balanceCheck[0]).toMatchObject({
      status: 'ok',
      opening: { minor: 150000, currency: 'USD' },
      closing: { minor: 178990, currency: 'USD' },
      sum: { minor: 28990, currency: 'USD' },
    })
    expect(one<BalanceSnapshot>(r.events, 'balance.snapshot')[0]?.current.minor).toBe(178990)
  })

  it('honours an explicit skipRows mapping', async () => {
    const mapping: ColumnMapping = {
      date: 'Transaction Date',
      dateFormat: 'MM/DD/YYYY',
      amount: { kind: 'split', debit: 'Withdrawal', credit: 'Deposit' },
      description: 'Description',
      decimal: '.',
      skipRows: 4,
    }
    const r = await importFile(bytes('preamble-credit-union.csv'), 'export.csv', checking({ mapping }))
    expect(r.mapping?.source).toBe('provided')
    expect(txns(r.events)).toHaveLength(5)
  })
})

// ---------- Balance check failing ----------

describe('balance check', () => {
  it('reports a running-balance mismatch without throwing', async () => {
    const text = Buffer.from(bytes('preamble-credit-union.csv')).toString('utf8').replace('800.00', '800.01')
    const r = await importFile(utf8(text), 'export.csv', checking())
    expect(r.balanceCheck[0]?.status).toBe('mismatch')
    expect(r.balanceCheck[0]?.mismatches).toEqual([
      { line: 8, expected: { minor: 80000, currency: 'USD' }, actual: { minor: 80001, currency: 'USD' } },
      { line: 9, expected: { minor: 76491, currency: 'USD' }, actual: { minor: 76490, currency: 'USD' } },
    ])
    expect(txns(r.events)).toHaveLength(5)
  })

  it('OFX: skipped with the implied opening, ok with the right opening, mismatch with a wrong one', async () => {
    const f = bytes('ofx102-checking.ofx')
    const none = await importFile(f, 'a.ofx', checking())
    expect(none.balanceCheck[0]).toMatchObject({
      status: 'skipped',
      method: 'opening_closing',
      closing: { minor: 380183, currency: 'USD' },
      sum: { minor: 180183, currency: 'USD' },
      impliedOpening: { minor: 200000, currency: 'USD' },
    })
    const ok = await importFile(f, 'a.ofx', checking({ openingBalance: { minor: 200000, currency: 'USD' } }))
    expect(ok.balanceCheck[0]).toMatchObject({ status: 'ok', difference: { minor: 0, currency: 'USD' } })
    const bad = await importFile(f, 'a.ofx', checking({ openingBalance: { minor: 199900, currency: 'USD' } }))
    expect(bad.balanceCheck[0]).toMatchObject({ status: 'mismatch', difference: { minor: 100, currency: 'USD' } })
  })
})

// ---------- OFX ----------

describe('OFX 1.02 SGML checking', () => {
  it('maps transactions with FITID ids, signs as given, and balances', async () => {
    const r = await importFile(bytes('ofx102-checking.ofx'), 'stmt.ofx', checking())
    expect(r.detectedFormat).toBe('ofx')
    const [acct] = one<AccountUpsert>(r.events, 'account.upsert')
    expect(acct).toMatchObject({ name: 'SAMPLE BANK Checking ••3210', accountType: 'depository', mask: '3210', currency: 'USD', institution: 'SAMPLE BANK' })
    expect(acct?.externalId).toMatch(/^ofx_[0-9a-f]{24}$/)
    expect(JSON.stringify(r.events)).not.toContain('XXXXXX3210')
    const t = txns(r.events)
    expect(t.map((x) => [x.date, x.amount.minor, x.counterparty])).toEqual([
      ['2026-01-02', 250000, 'ACME WIDGETS PAYROLL'],
      ['2026-01-05', -15000, 'CHECK 1043'],
      ['2026-01-06', -4217, 'GROCERY & DELI'],
      ['2026-01-10', -300, 'ATM FEE'],
      ['2026-01-10', -300, 'ATM FEE'],
      ['2026-01-15', -50000, 'TRANSFER TO SAVINGS'],
    ])
    const id = acct?.externalId as string
    expect(t[0]?.externalId).toBe(`${id}:F20260102001`)
    expect(t[0]?.rawText).toBe('ACME WIDGETS PAYROLL DIRECT DEP')
    expect(t[1]?.linkRefs).toEqual({ check_number: '1043' })
    expect(t[5]?.linkRefs).toEqual({ ref: 'T0042' })
    expect(t[3]?.externalId).not.toBe(t[4]?.externalId)
    expect(t[3]?.externalId).toMatch(new RegExp(`^${id}:h[0-9a-f]{32}$`))
    const [snap] = one<BalanceSnapshot>(r.events, 'balance.snapshot')
    expect(snap).toMatchObject({
      externalId: `${id}@2026-01-31`,
      at: '2026-01-31T17:00:00.000Z',
      current: { minor: 380183, currency: 'USD' },
      available: { minor: 375183, currency: 'USD' },
    })
    assertValidEvents(r.events, { connectionId: CONN })
  })
})

describe('QFX credit card', () => {
  it('keeps the OFX sign: purchases negative, payments and refunds positive, balance owed negative', async () => {
    const r = await importFile(bytes('qfx-card.qfx'), 'card.qfx', checking())
    expect(r.detectedFormat).toBe('qfx')
    const [acct] = one<AccountUpsert>(r.events, 'account.upsert')
    expect(acct).toMatchObject({ accountType: 'credit_card', mask: '1234', name: 'SAMPLE CARD CO Credit card ••1234' })
    expect(txns(r.events).map((t) => [t.date, t.amount.minor, t.categoryHint ?? null])).toEqual([
      ['2026-01-03', -6420, null],
      ['2026-01-08', -129999, null],
      ['2026-01-12', 5000, null],
      ['2026-01-20', 80000, 'ofx:payment'],
      ['2026-01-25', -1837, 'ofx:int'],
    ])
    expect(one<BalanceSnapshot>(r.events, 'balance.snapshot')[0]?.current).toEqual({ minor: -153256, currency: 'USD' })
    const ok = await importFile(bytes('qfx-card.qfx'), 'card.qfx', checking({ openingBalance: { minor: -100000, currency: 'USD' } }))
    expect(ok.balanceCheck[0]?.status).toBe('ok')
  })

  it('invertOfxSign flips amounts and balances for non-conforming banks (opt-in only)', async () => {
    const r = await importFile(bytes('qfx-card.qfx'), 'card.qfx', checking({ invertOfxSign: true }))
    expect(txns(r.events)[0]?.amount.minor).toBe(6420)
    expect(one<BalanceSnapshot>(r.events, 'balance.snapshot')[0]?.current.minor).toBe(153256)
  })

  it('is detected as qbo by extension', async () => {
    expect((await importFile(bytes('qfx-card.qfx'), 'card.QBO', checking())).detectedFormat).toBe('qbo')
  })
})

describe('OFX 2.x XML', () => {
  it('parses closed tags, entities, CDATA, PAYEE/NAME and comma-decimal TRNAMT', async () => {
    const r = await importFile(bytes('ofx2-savings.ofx'), 'savings.ofx', checking())
    const doc = parseOfx(Buffer.from(bytes('ofx2-savings.ofx')).toString('utf8'))
    expect(doc.version).toBe(2)
    expect(one<AccountUpsert>(r.events, 'account.upsert')[0]).toMatchObject({ name: 'Beispiel Sparbank Savings ••7788', currency: 'EUR' })
    expect(txns(r.events).map((t) => [t.date, t.amount.minor, t.counterparty, t.rawText])).toEqual([
      ['2026-01-05', 100000, 'Muster & Partner', 'Muster & Partner Einzahlung <bar>'],
      ['2026-01-15', -25000, 'Transfer to checking', 'Transfer to checking Monthly sweep'],
      ['2026-01-31', 1234, 'Interest', 'Interest'],
    ])
    expect(one<BalanceSnapshot>(r.events, 'balance.snapshot')[0]).toMatchObject({
      current: { minor: 576234, currency: 'EUR' },
      at: '2026-01-31T22:59:59.000Z',
    })
    expect(r.balanceCheck[0]?.impliedOpening).toEqual({ minor: 500000, currency: 'EUR' })
  })

  it('handles CORRECTACTION DELETE/REPLACE by voiding the corrected FITID', async () => {
    const ofx = `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD</CURDEF><BANKACCTFROM><BANKID>1</BANKID><ACCTID>A9</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260102</DTPOSTED><TRNAMT>-5.00</TRNAMT><FITID>N1</FITID><CORRECTFITID>OLD1</CORRECTFITID><CORRECTACTION>REPLACE</CORRECTACTION><NAME>FIXED</NAME></STMTTRN>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260103</DTPOSTED><TRNAMT>-7.00</TRNAMT><FITID>N2</FITID><CORRECTFITID>OLD2</CORRECTFITID><CORRECTACTION>DELETE</CORRECTACTION></STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`
    const r = await importFile(utf8(ofx), 'x.ofx', checking())
    const t = txns(r.events).map((x) => [x.externalId.split(':')[1], x.status, x.amount.minor])
    expect(t).toEqual([
      ['OLD1', 'void', -500],
      ['N1', 'posted', -500],
      ['OLD2', 'void', -700],
    ])
  })

  it('parses OFX dates with offsets', () => {
    expect(parseOfxDate('20260131120000.000[-5:EST]')).toEqual({ date: '2026-01-31', at: '2026-01-31T17:00:00.000Z' })
    expect(parseOfxDate('20260131')).toEqual({ date: '2026-01-31', at: '2026-01-31T00:00:00.000Z' })
    expect(parseOfxDate('20260131000000[+5.30:IST]').at).toBe('2026-01-30T18:30:00.000Z')
    expect(() => parseOfxDate('Jan 31')).toThrow(ConnectorError)
  })

  it('rejects an OFX amount with both separators', async () => {
    const ofx = Buffer.from(bytes('ofx102-checking.ofx')).toString('utf8').replace('-42.17', '-1,042.17')
    await expectInvalid(importFile(utf8(ofx), 'a.ofx', checking()), 'ambiguous_amount')
  })
})

// ---------- Dedupe ----------

describe('stable ids and dedupe', () => {
  const ids = (events: NormalizedEvent[]) => txns(events).map((t) => t.externalId)

  it('re-importing the same file yields the same ids and events', async () => {
    for (const [name, opts] of [
      ['chase-checking.csv', checking()],
      ['amex-card.csv', card()],
      ['preamble-credit-union.csv', checking()],
      ['ofx102-checking.ofx', checking()],
    ] as const) {
      const a = await importFile(bytes(name), name, opts)
      const b = await importFile(bytes(name), name, { ...opts, raw: new MemoryRawSink() })
      expect(JSON.stringify(b.events)).toBe(JSON.stringify(a.events))
    }
  })

  it('overlapping imports produce the same ids for the shared rows (no double count)', async () => {
    const lines = Buffer.from(bytes('chase-checking.csv')).toString('utf8').split('\r\n')
    const header = lines[0] as string
    const rows = lines.slice(1).filter(Boolean)
    const fileA = [header, ...rows.slice(0, 5)].join('\r\n') // 01/08 .. 01/03 (both coffee rows)
    const fileB = [header, ...rows.slice(3)].join('\r\n') // 01/05 .. 01/02 (both coffee rows)
    const a = await importFile(utf8(fileA), 'a.csv', checking())
    const b = await importFile(utf8(fileB), 'b.csv', checking())
    const full = await importFile(bytes('chase-checking.csv'), 'full.csv', checking())
    const union = new Set([...ids(a.events), ...ids(b.events)])
    expect(union.size).toBe(7)
    expect([...union].sort()).toEqual(ids(full.events).sort())
  })

  it('two identical rows on the same day stay two rows, stably', async () => {
    const head = 'Date,Description,Amount\n'
    const twin = '01/03/2026,COFFEE,-4.50\n'
    const both = await importFile(utf8(head + twin + twin), 'a.csv', checking())
    const again = await importFile(utf8(head + twin + twin), 'b.csv', checking())
    const single = await importFile(utf8(head + twin), 'c.csv', checking())
    expect(ids(both.events)).toHaveLength(2)
    expect(new Set(ids(both.events)).size).toBe(2)
    expect(ids(again.events)).toEqual(ids(both.events))
    expect(ids(single.events)[0]).toBe(ids(both.events)[0])
    // Description normalization: case and spacing don't change the id.
    const shouty = await importFile(utf8(head + '01/03/2026,  coffee ,-4.50\n'), 'd.csv', checking())
    expect(ids(shouty.events)[0]).toBe(ids(both.events)[0])
  })

  it('a reference column that repeats falls back to the content hash', async () => {
    const csv = 'Date,Description,Amount,Transaction ID\n01/03/2026,A,-1.00,TX0001\n01/04/2026,B,-2.00,TX0001\n'
    const mapping: ColumnMapping = { date: 'Date', dateFormat: 'MM/DD/YYYY', amount: { kind: 'signed', column: 'Amount', convention: 'positive_is_in' }, description: 'Description', externalId: 'Transaction ID', decimal: '.' }
    const r = await importFile(utf8(csv), 'a.csv', checking({ mapping }))
    expect(ids(r.events)[0]).toBe('file_chk:TX0001')
    expect(ids(r.events)[1]).toMatch(/^file_chk:h/)
    expect(r.warnings.some((w) => w.includes('repeats'))).toBe(true)
  })
})

// ---------- CSV parser edge cases ----------

describe('parseCsv edge cases', () => {
  const cases: Array<[string, string, string, string[][]]> = [
    ['comma', 'a,b,c\n1,2,3\n', ',', [['a', 'b', 'c'], ['1', '2', '3']]],
    ['semicolon with comma decimals', 'a;b;c\n1,5;2,5;3\n', ';', [['a', 'b', 'c'], ['1,5', '2,5', '3']]],
    ['tab', 'a\tb\tc\n1\t2\t3\n', '\t', [['a', 'b', 'c'], ['1', '2', '3']]],
    ['pipe', 'a|b|c\n1|2|3\n', '|', [['a', 'b', 'c'], ['1', '2', '3']]],
    ['quoted delimiter', 'a,b\n"x, y",2\n', ',', [['a', 'b'], ['x, y', '2']]],
    ['escaped quotes', 'a,b\n"say ""hi""",2\n', ',', [['a', 'b'], ['say "hi"', '2']]],
    ['embedded newline', 'a,b\n"line1\nline2",2\n', ',', [['a', 'b'], ['line1\nline2', '2']]],
    ['CRLF', 'a,b\r\n1,2\r\n', ',', [['a', 'b'], ['1', '2']]],
    ['BOM', '﻿a,b\n1,2\n', ',', [['a', 'b'], ['1', '2']]],
    ['blank lines dropped', 'a,b\n\n1,2\n\n\n', ',', [['a', 'b'], ['1', '2']]],
    ['no trailing newline', 'a,b\n1,2', ',', [['a', 'b'], ['1', '2']]],
    ['empty fields', 'a,b,c\n,,3\n', ',', [['a', 'b', 'c'], ['', '', '3']]],
    ['quoted empty', 'a,b\n"",2\n', ',', [['a', 'b'], ['', '2']]],
    ['space before quote', 'a,b\n1, "x,y"\n', ',', [['a', 'b'], ['1', 'x,y']]],
    ['preamble does not fool the delimiter', 'Statement for: X\nFrom 1/1 to 1/31\na;b;c\n1;2;3\n4;5;6\n', ';', [['Statement for: X'], ['From 1/1 to 1/31'], ['a', 'b', 'c'], ['1', '2', '3'], ['4', '5', '6']]],
  ]
  it.each(cases)('%s', (_name, text, delimiter, records) => {
    const t = parseCsv(text)
    expect(t.delimiter).toBe(delimiter)
    expect(t.records.map((r) => r.cells)).toEqual(records)
  })

  it('tracks physical line numbers across embedded newlines and blank lines', () => {
    const t = parseCsv('a,b\n"x\ny",1\n\nz,2\n')
    expect(t.records.map((r) => r.line)).toEqual([1, 2, 5])
  })

  it('throws on an unterminated quote', async () => {
    await expectInvalid(() => parseCsv('a,b\n"open,1\n'), 'csv_unterminated_quote')
  })

  it('decodes Windows-1252 and UTF-16 files', () => {
    const latin = new Uint8Array([...utf8('Empf'), 0xe4, ...utf8('nger;Betrag\n')])
    const d = decodeText(latin)
    expect(d.text).toBe('Empfänger;Betrag\n')
    expect(d.encoding).toBe('windows-1252')
    expect(d.warnings).toHaveLength(1)
    const u16 = new Uint8Array([0xff, 0xfe, ...Buffer.from('Date,Amount\n', 'utf16le')])
    expect(decodeText(u16).text).toBe('Date,Amount\n')
    expect(() => decodeText(new Uint8Array([1, 0, 2, 0, 3]))).toThrow(ConnectorError)
  })
})

// ---------- Ambiguous amounts ----------

describe('ambiguous amounts throw (never guessed)', () => {
  const base: ColumnMapping = { date: 'Date', dateFormat: 'YYYY-MM-DD', amount: { kind: 'signed', column: 'Amount', convention: 'positive_is_in' }, decimal: '.' }
  const cases: Array<[string, string, ColumnMapping]> = [
    ['comma group of 2 with dot decimal', '"1,23"', base],
    ['European amount with dot decimal', '"1.234,56"', base],
    ['US amount with comma decimal', '"12,345.67"', { ...base, decimal: ',' }],
    ['two decimal points', '1.2.3', base],
    ['words', 'n/a', base],
  ]
  it.each(cases)('%s', async (_name, value, mapping) => {
    const csv = `Date,Amount\n2026-01-02,${value}\n`
    const err = await expectInvalid(importFile(utf8(csv), 'x.csv', checking({ mapping })), 'ambiguous_amount')
    expect(err.message).toContain('line 2')
  })

  it('an unknown Soll/Haben marker throws', async () => {
    const mapping: ColumnMapping = { date: 'Datum', dateFormat: 'DD.MM.YYYY', amount: { kind: 'indicator', column: 'Betrag', indicator: 'S/H' }, decimal: ',' }
    await expectInvalid(importFile(utf8('Datum;Betrag;S/H\n02.01.2026;5,00;X\n'), 'x.csv', checking({ mapping })), 'ambiguous_amount')
  })

  it('accepts accounting negatives, currency symbols and trailing minus', async () => {
    const csv = 'Date,Amount\n2026-01-02,(12.50)\n2026-01-03,"$1,000.00"\n2026-01-04,7.25-\n'
    const r = await importFile(utf8(csv), 'x.csv', checking({ mapping: base }))
    expect(txns(r.events).map((t) => t.amount.minor)).toEqual([-1250, 100000, -725])
  })
})

// ---------- Mapping suggestions, signatures, dates ----------

describe('suggestMapping', () => {
  it('flags an ambiguous date order and lowers confidence', () => {
    const s = suggestMapping(['Date', 'Description', 'Amount'], [['01/02/2026', 'A', '-1.00'], ['03/04/2026', 'B', '2.00']])
    expect(s.mapping?.dateFormat).toBe('MM/DD/YYYY')
    expect(s.confidence).toBeLessThan(0.8)
    expect(s.reasons.join(' ')).toContain('month/day order is a guess')
  })

  it('prefers day-first when the decimal is a comma', () => {
    const s = suggestMapping(['Date', 'Montant'], [['01/02/2026', '-1,00'], ['03/04/2026', '2,50']])
    expect(s.mapping?.dateFormat).toBe('DD/MM/YYYY')
    expect(s.mapping?.decimal).toBe(',')
  })

  it('returns null with reasons when there is no amount', () => {
    const s = suggestMapping(['Date', 'Description'], [['2026-01-02', 'x']])
    expect(s.mapping).toBeNull()
    expect(s.confidence).toBe(0)
    expect(s.reasons.at(-1)).toContain('no amount column')
  })

  it('a low-confidence CSV without a mapping is refused with needs_mapping', async () => {
    const csv = 'Foo,Bar\n1,2\n'
    await expectInvalid(importFile(utf8(csv), 'x.csv', checking()), 'needs_mapping')
  })

  it('Debit/Credit columns and "Betrag (EUR)"-style partial names', () => {
    expect(suggestMapping(['Date', 'Payee', 'Debit', 'Credit'], [['2026-01-02', 'X', '5.00', '']]).mapping?.amount).toEqual({ kind: 'split', debit: 'Debit', credit: 'Credit' })
    const s = suggestMapping(['Buchungsdatum', 'Betrag (EUR)', 'Buchungstext'], [['02.01.2026', '-5,00', 'x']])
    expect(s.mapping).toMatchObject({ date: 'Buchungsdatum', amount: { kind: 'signed', column: 'Betrag (EUR)' }, description: 'Buchungstext' })
  })
})

describe('headerSignature', () => {
  it('is stable across case and surrounding whitespace, and differs by columns', () => {
    const a = headerSignature(['Date', 'Description', 'Amount'])
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(headerSignature([' date', 'DESCRIPTION ', 'amount'])).toBe(a)
    expect(headerSignature(['Date', 'Amount', 'Description'])).not.toBe(a)
  })
})

describe('dates', () => {
  it.each([
    ['2026-01-05', 'YYYY-MM-DD', '2026-01-05'],
    ['2026-01-05 13:22:00', 'YYYY-MM-DD', '2026-01-05'],
    ['20260105', 'YYYYMMDD', '2026-01-05'],
    ['1/5/2026', 'MM/DD/YYYY', '2026-01-05'],
    ['05/01/2026', 'DD/MM/YYYY', '2026-01-05'],
    ['05.01.2026', 'DD.MM.YYYY', '2026-01-05'],
    ['1/5/26', 'M/D/YY', '2026-01-05'],
    ['5.1.26', 'D.M.YY', '2026-01-05'],
    ['05 Jan 2026', 'DD MMM YYYY', '2026-01-05'],
    ['05-Mär-2026', 'DD MMM YYYY', '2026-03-05'],
    ['31.02.2026', 'DD.MM.YYYY', undefined],
    ['13/01/2026', 'MM/DD/YYYY', undefined],
  ] as const)('%s as %s', (raw, fmt, want) => {
    expect(parseDate(raw, fmt)).toBe(want)
  })

  it('detects the format and whether it is ambiguous', () => {
    expect(detectDateFormat(['01/15/2026', '01/02/2026'])).toEqual({ format: 'MM/DD/YYYY', ambiguous: false })
    expect(detectDateFormat(['15/01/2026'])).toEqual({ format: 'DD/MM/YYYY', ambiguous: false })
    expect(detectDateFormat(['01/02/2026'])).toEqual({ format: 'MM/DD/YYYY', ambiguous: true })
    expect(detectDateFormat(['nope'])).toBeUndefined()
  })
})

// ---------- Documents ----------

describe('documents (PDF/images are stored, not parsed)', () => {
  it('describes a valid PDF and importFile routes it as a document', async () => {
    const pdf = bytes('tiny-statement.pdf')
    const d = ingestDocument(pdf, 'jan.pdf')
    expect(d).toMatchObject({ mime: 'application/pdf', size: pdf.length, filename: 'jan.pdf', kind: 'statement' })
    expect(d.sha256).toMatch(/^[0-9a-f]{64}$/)
    const r = await importFile(pdf, 'jan.pdf', checking())
    expect(r).toMatchObject({ detectedFormat: 'pdf', events: [], document: d })
  })

  it.each([
    ['png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0], 'image/png'],
    ['jpeg', [0xff, 0xd8, 0xff, 0xe0, 0], 'image/jpeg'],
    ['heic', [0, 0, 0, 0x18, ...utf8('ftypheic'), 0, 0, 0, 0], 'image/heic'],
    ['heif', [0, 0, 0, 0x18, ...utf8('ftypmif1'), 0, 0, 0, 0], 'image/heif'],
  ] as const)('accepts %s by magic bytes', (_n, sig, mime) => {
    expect(ingestDocument(new Uint8Array(sig), 'scan').mime).toBe(mime)
  })

  it.each([
    ['text renamed to .pdf', utf8('Date,Amount\n'), 'x.pdf'],
    ['zip', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]), 'x.pdf'],
    ['mp4 ftyp brand', new Uint8Array([0, 0, 0, 0x18, ...utf8('ftypisom'), 0, 0, 0, 0]), 'x.heic'],
    ['empty', new Uint8Array(0), 'x.pdf'],
  ])('rejects %s', async (_n, b, name) => {
    await expectInvalid(() => ingestDocument(b, name))
    await expectInvalid(importFile(b, name, checking()))
  })

  it('rejects documents over 25 MB', async () => {
    const big = new Uint8Array(25 * 1024 * 1024 + 1)
    big.set(utf8('%PDF-1.4'))
    await expectInvalid(() => ingestDocument(big, 'big.pdf'), 'file_too_large')
  })
})

// ---------- Connector ----------

const CONFIG = { accountExternalId: 'file_chk', name: 'Business checking', accountType: 'depository', currency: 'USD' }
const connRef: ConnectionRef = { id: CONN, workspaceId: 'ws1', connectorKey: 'files', secret: null, config: CONFIG }

function fakeSource(files: PendingFile[], withReport = true) {
  const reports: Array<[string, FileOutcome]> = []
  const source: FileSource = {
    // Keys off the cursor (not call order) so page-by-page resume works.
    async list(connectionId, after) {
      expect(connectionId).toBe(CONN)
      const i = after === null ? 0 : files.findIndex((f) => f.fileId === after) + 1
      return files.slice(i)
    },
    ...(withReport ? { report: async (_c: string, fileId: string, o: FileOutcome) => void reports.push([fileId, o]) } : {}),
  }
  return { source, reports }
}

const QUEUE = (): PendingFile[] => [
  { fileId: 'f1', filename: 'chase.csv', bytes: bytes('chase-checking.csv') },
  { fileId: 'f2', filename: 'stmt.ofx', bytes: bytes('ofx102-checking.ofx') },
  { fileId: 'f3', filename: 'jan.pdf', bytes: bytes('tiny-statement.pdf') },
  { fileId: 'f4', filename: 'card.qfx', bytes: bytes('qfx-card.qfx') },
  { fileId: 'f5', filename: 'broken.csv', bytes: utf8('Foo,Bar\n1,2\n') },
  { fileId: 'f6', filename: 'preamble.csv', bytes: bytes('preamble-credit-union.csv') },
]

describe('files connector', () => {
  it('describes itself and begins with an upload picker', async () => {
    const c = createFilesConnector({ source: fakeSource([]).source }, { raw: new MemoryRawSink() })
    expect(c.describe()).toMatchObject({ key: 'files', group: 'files', auth: 'file' })
    const b = await c.begin({ workspaceId: 'ws1', redirectUri: 'https://x.example.com/cb', state: 's', userRef: 'u' })
    expect(b).toEqual({ kind: 'upload', accept: FILE_ACCEPT })
    expect(FILE_ACCEPT).toContain('.qfx')
    expect(FILE_ACCEPT).toContain('application/pdf')
  })

  it('connect creates a file account and validates input', async () => {
    const c = createFilesConnector({ source: fakeSource([]).source }, { raw: new MemoryRawSink() })
    expect(await c.connect({ accountExternalId: 'file_chk', name: 'Checking', accountType: 'depository', currency: 'usd' })).toEqual({
      secret: null,
      config: { accountExternalId: 'file_chk', name: 'Checking', accountType: 'depository', currency: 'USD' },
    })
    const gen = await c.connect({ name: 'Card', accountType: 'credit_card', currency: 'USD' })
    expect(gen.config.accountExternalId).toMatch(/^file_[0-9a-f-]{36}$/)
    await expectInvalid(c.connect({ accountType: 'depository', currency: 'USD' }))
    await expectInvalid(c.connect({ name: 'x', accountType: 'savings', currency: 'USD' }))
    await expectInvalid(c.connect({ name: 'x', accountType: 'depository', currency: 'dollars' }))
    await expectInvalid(c.connect({ name: 'x', accountType: 'depository', currency: 'USD', accountExternalId: 'has spaces' }))
    await expectInvalid(c.connect({ name: 'x', accountType: 'depository', currency: 'USD', mapping: { date: 'Date' } }))
    expect(await c.health(connRef)).toEqual({ status: 'ok' })
    expect((await c.health({ ...connRef, config: {} })).status).toBe('error')
  })

  it('passes the connector contract through the FileSource path (one file per page, resumable)', async () => {
    const report = await runConnectorContract({
      make: () => ({
        connector: createFilesConnector({ source: fakeSource(QUEUE()).source }, { raw: new MemoryRawSink() }),
        conn: connRef,
      }),
      minEvents: 30,
    })
    expect(report.pages).toBe(6)
    const ofxIds = report.events.filter((e) => e.type === 'account.upsert').map((e) => e.externalId)
    expect(ofxIds).toHaveLength(3)
  })

  it('reports per-file outcomes: imported (with balance check), document, failed', async () => {
    const { source, reports } = fakeSource(QUEUE())
    const c = createFilesConnector({ source }, { raw: new MemoryRawSink() })
    const run = await runSync(c, connRef, null)
    expect(run.complete).toBe(true)
    expect(reports.map(([id, o]) => [id, o.status])).toEqual([
      ['f1', 'imported'],
      ['f2', 'imported'],
      ['f3', 'document'],
      ['f4', 'imported'],
      ['f5', 'failed'],
      ['f6', 'imported'],
    ])
    const f1 = reports[0]?.[1]
    expect(f1?.status === 'imported' && f1.result.balanceCheck[0]?.status).toBe('ok')
    const f5 = reports[4]?.[1]
    expect(f5?.status === 'failed' && f5.error.code).toBe('needs_mapping')
    // Nothing new: an incremental sync from the final cursor is empty and keeps the cursor.
    const next = await c.sync(connRef, run.cursor)
    expect(next).toEqual({ events: [], cursor: run.cursor, hasMore: false })
  })

  it('puts a short summary of balance mismatches, row warnings and failures into the page warnings', async () => {
    const mismatched = Buffer.from(bytes('preamble-credit-union.csv')).toString('utf8').replace('800.00', '800.01')
    const mapping: ColumnMapping = { date: 'Foo', dateFormat: 'YYYYMMDD', amount: { kind: 'signed', column: 'Bar', convention: 'positive_is_out' }, decimal: '.' }
    const files: PendingFile[] = [
      { fileId: 'w1', filename: 'chase.csv', bytes: bytes('chase-checking.csv') },
      { fileId: 'w2', filename: 'uploads/credit-union.csv', bytes: utf8(mismatched) },
      { fileId: 'w3', filename: 'rows.csv', bytes: utf8('Foo,Bar\n20260102,9.99\nnot-a-date,1.00\n20260103,\n'), mapping },
      { fileId: 'w4', filename: 'broken.csv', bytes: utf8('Foo,Bar\n1,2\n') },
    ]
    const { source, reports } = fakeSource(files)
    const c = createFilesConnector({ source }, { raw: new MemoryRawSink() })
    const pages: Array<string[] | undefined> = []
    let cursor: string | null = null
    for (;;) {
      const r = await c.sync(connRef, cursor)
      pages.push(r.warnings)
      cursor = r.cursor
      if (!r.hasMore) break
    }
    expect(pages[0]).toBeUndefined()
    expect(pages[1]).toEqual(["credit-union.csv: the running balance doesn't add up on 2 rows (first at line 8); some rows may be missing or wrong."])
    expect(pages[2]).toEqual([expect.stringMatching(/^rows\.csv: 2 import warnings, e\.g\. line 3: skipped/)])
    expect(pages[3]).toEqual([expect.stringMatching(/^broken\.csv couldn't be imported: /)])
    // The full detail still goes to the FileSource report.
    expect(reports.map(([id, o]) => [id, o.status])).toEqual([['w1', 'imported'], ['w2', 'imported'], ['w3', 'imported'], ['w4', 'failed']])
  })

  it('importWarnings caps and dedupes', () => {
    const check = { accountExternalId: 'a', status: 'mismatch' as const, method: 'opening_closing' as const, rowsChecked: 1, mismatches: [] }
    const w = importWarnings('s.ofx', { balanceCheck: [check, check, check, check, check, check], warnings: ['only one'] })
    expect(w).toEqual(["s.ofx: the closing balance doesn't match the opening balance plus the transactions; some rows may be missing.", 's.ofx: only one'])
  })

  it('uses a per-file mapping over auto-detection', async () => {
    const mapping: ColumnMapping = { date: 'Foo', dateFormat: 'YYYYMMDD', amount: { kind: 'signed', column: 'Bar', convention: 'positive_is_out' }, decimal: '.' }
    const { source } = fakeSource([{ fileId: 'g1', filename: 'x.csv', bytes: utf8('Foo,Bar\n20260102,9.99\n'), mapping }])
    const c = createFilesConnector({ source }, { raw: new MemoryRawSink() })
    const page = await c.sync(connRef, null)
    expect(txns(page.events)[0]?.amount).toEqual({ minor: -999, currency: 'USD' })
  })

  it('without a report hook a bad file surfaces as invalid_input', async () => {
    const { source } = fakeSource([{ fileId: 'b1', filename: 'broken.csv', bytes: utf8('Foo,Bar\n1,2\n') }], false)
    const c = createFilesConnector({ source }, { raw: new MemoryRawSink() })
    await expectInvalid(c.sync(connRef, null), 'needs_mapping')
  })

  it('a garbage cursor is cursor_invalid', async () => {
    const c = createFilesConnector({ source: fakeSource([]).source }, { raw: new MemoryRawSink() })
    await expect(c.sync(connRef, 'not-a-cursor')).rejects.toMatchObject({ kind: 'cursor_invalid' })
  })
})

// ---------- ISO 20022 camt.053 ----------

describe('camt.053 (ISO 20022 XML)', () => {
  const eur = () => importFile(bytes('camt053-eur-checking.xml'), 'kontoauszug.xml', checking())

  it('reads booked and pending entries with signs, references, parties and remittance text', async () => {
    const r = await eur()
    expect(r.detectedFormat).toBe('camt.053')
    const [acct] = one<AccountUpsert>(r.events, 'account.upsert')
    expect(acct).toMatchObject({ name: 'Musterbank Geschäftskonto ••3000', accountType: 'depository', currency: 'EUR', mask: '3000', institution: 'Musterbank' })
    expect(acct!.externalId).toMatch(/^camt_[0-9a-f]{24}$/)
    const t = txns(r.events)
    expect(t.map((x) => [x.date, x.amount.minor, x.status, x.counterparty ?? null, x.rawText ?? null])).toEqual([
      ['2026-09-30', 250_000, 'posted', 'Muster GmbH', 'Rechnung 2026-114 Danke & Gruss'],
      ['2026-09-30', -8_990, 'posted', 'Telefonica Beispiel AG', 'Mobilfunk September'],
      ['2026-09-30', -1_240, 'posted', 'Cafe Beispiel', 'Kartenzahlung Cafe Beispiel'],
      ['2026-09-30', -120_000, 'posted', null, 'Sammelueberweisung 2 Posten'],
      ['2026-10-01', -4_500, 'pending', null, 'Vormerkung Tankstelle'],
    ])
    // The bank's reference is the id; without one (card payment, end-to-end NOTPROVIDED) a content hash is.
    expect(t.map((x) => x.externalId.slice(acct!.externalId.length + 1))).toEqual(['2026093000417731', '2026093000417732', expect.stringMatching(/^h[0-9a-f]{32}$/), '2026093000417734', '2026100100000881'])
    expect(t[1]!.linkRefs).toEqual({ end_to_end_id: 'TK-0099-0926', mandate_id: 'MNDT-0042' })
    expect(t[0]!.categoryHint).toBe('camt:pmnt-rcdt-esct')
    const [bal] = one<BalanceSnapshot>(r.events, 'balance.snapshot')
    expect([bal!.current, bal!.available]).toEqual([{ minor: 219_770, currency: 'EUR' }, { minor: 215_270, currency: 'EUR' }])
    // Previous closing 1,000.00 + booked rows = closing 2,197.70 (the pending row isn't in it).
    expect(r.balanceCheck).toMatchObject([{ status: 'ok', method: 'opening_closing', opening: { minor: 100_000 }, closing: { minor: 219_770 } }])
    assertValidEvents(r.events, { connectionId: CONN })
  })

  it('re-importing the same file yields the same ids and events', async () => {
    const [a, b] = [await eur(), await eur()]
    expect(b.events.map((e) => e.externalId)).toEqual(a.events.map((e) => e.externalId))
    expect(new Set(a.events.map((e) => e.externalId)).size).toBe(a.events.length)
  })

  it('multi-currency: one account per account number and currency, each with its own balance check', async () => {
    const r = await importFile(bytes('camt053-multi-currency.xml'), 'statement.xml', checking())
    const accts = one<AccountUpsert>(r.events, 'account.upsert')
    expect(accts.map((a) => [a.name, a.currency])).toEqual([
      ['Beispielbank Account ••2957 (CHF)', 'CHF'],
      ['Beispielbank Account ••2957 (EUR)', 'EUR'],
      ['Operating ••5555', 'GBP'],
    ])
    expect(new Set(accts.map((a) => a.externalId)).size).toBe(3)
    expect(txns(r.events).map((x) => [x.accountExternalId === accts[0]!.externalId ? 'CHF' : 'EUR', x.date, x.amount])).toEqual([
      ['CHF', '2026-09-30', { minor: -36_975, currency: 'CHF' }],
      ['EUR', '2026-09-30', { minor: 100_000, currency: 'EUR' }],
    ])
    expect(r.balanceCheck.map((c) => [c.status, c.opening?.minor, c.closing?.minor])).toEqual([['ok', 500_000, 463_025], ['ok', -15_000, 85_000], ['ok', 0, 0]])
    expect(one<BalanceSnapshot>(r.events, 'balance.snapshot').map((b) => b.at)).toEqual(['2026-09-30T21:59:59.000Z', '2026-09-30T23:59:59.000Z', '2026-09-30T23:59:59.000Z'])
  })

  it('a single-account file posts into the chosen account when asked (ofxIntoFileAccount)', async () => {
    const r = await importFile(bytes('camt053-eur-checking.xml'), 'k.xml', checking({ ofxIntoFileAccount: true }))
    expect(new Set(r.events.map((e) => (e.type === 'account.upsert' ? e.externalId : (e as TxnUpsert).accountExternalId)))).toEqual(new Set(['file_chk']))
  })

  it('refuses DOCTYPE/ENTITY (no XXE, no entity expansion), unknown entities, malformed XML and other ISO messages', async () => {
    const wrap = (body: string, pre = '') => utf8(`<?xml version="1.0"?>${pre}<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt>${body}</BkToCstmrStmt></Document>`)
    await expectInvalid(importFile(wrap('', '<!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]>'), 'x.xml', checking()), 'xml_doctype')
    await expectInvalid(importFile(wrap('', '<!DOCTYPE d [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;">]>'), 'x.xml', checking()), 'xml_doctype')
    await expectInvalid(importFile(wrap('<Stmt><Acct><Id><IBAN>&xxe;</IBAN></Id></Acct></Stmt>'), 'x.xml', checking()), 'xml_entity')
    await expectInvalid(importFile(wrap('<Stmt><Acct>'), 'x.xml', checking()), 'xml_malformed')
    await expectInvalid(importFile(wrap('<Stmt></Acct></Stmt>'), 'x.xml', checking()), 'xml_malformed')
    await expectInvalid(importFile(wrap('<Stmt><Acct><Id><IBAN>DE89370400440532013000</IBAN></Id><Ccy>EUR</Ccy></Acct><Ntry><Amt Ccy="EUR">1,00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-09-30</Dt></BookgDt></Ntry></Stmt>'), 'x.xml', checking()), 'ambiguous_amount')
    await expectInvalid(importFile(wrap('<Stmt><Acct><Id><IBAN>DE89370400440532013000</IBAN></Id><Ccy>EUR</Ccy></Acct><Ntry><Amt Ccy="EUR">1.00</Amt><CdtDbtInd>UP</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-09-30</Dt></BookgDt></Ntry></Stmt>'), 'x.xml', checking()), 'camt_malformed')
    const ntf = utf8('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.054.001.02"><BkToCstmrDbtCdtNtfctn/></Document>')
    await expectInvalid(importFile(ntf, 'notice.xml', checking()), 'camt_unsupported')
    await expectInvalid(importFile(utf8('<rss><channel/></rss>'), 'feed.xml', checking()), 'camt_unsupported')
  })

  it('refuses a huge file before parsing and caps elements and depth', async () => {
    const big = new Uint8Array(25 * 1024 * 1024 + 1).fill(0x20)
    await expectInvalid(importFile(big, 'big.xml', checking()), 'file_too_large')
    const many = `<Document xmlns="camt.053"><BkToCstmrStmt>${'<a/>'.repeat(1001)}</BkToCstmrStmt></Document>`
    expect(() => parseXml(many, { maxElements: 1000 })).toThrow(/more than 1000 XML elements/)
    expect(() => parseXml(`${'<a>'.repeat(65)}${'</a>'.repeat(65)}`)).toThrow(/deeper than 64/)
  })

  it('the file connector imports a camt upload like any statement', async () => {
    const source: FileSource = { list: async (_c, after) => (after ? [] : [{ fileId: 'f1', filename: 'auszug.xml', bytes: bytes('camt053-eur-checking.xml') }]) }
    const conn: ConnectionRef = { id: CONN, workspaceId: 'ws', connectorKey: 'files', secret: null, config: { accountExternalId: 'file_chk', name: 'Business checking', accountType: 'depository', currency: 'EUR' } }
    const r = await runSync(createFilesConnector({ source }, { raw: new MemoryRawSink() } as never), conn, null)
    expect(txns(r.events)).toHaveLength(5)
    expect(FILE_ACCEPT).toContain('.xml')
  })
})

// ---------- US bank exports (presets) ----------

describe('US bank CSV exports are recognised and signed the bank\'s way', () => {
  const run = async (name: string, kind: 'bank' | 'card') => {
    const r = await importFile(bytes(name), name, kind === 'card' ? card() : checking())
    return { r, rows: txns(r.events).map((t) => [t.date, t.amount.minor, t.status]) }
  }
  it.each([
    ['chase-card.csv', 'card', 'chase-card', [['2026-01-14', -675, 'posted'], ['2026-01-12', -14_218, 'posted'], ['2026-01-10', 50_000, 'posted'], ['2026-01-08', 2_340, 'posted']]],
    ['bofa-checking.csv', 'bank', 'bofa-checking', [['2026-01-03', -11_245, 'posted'], ['2026-01-06', 120_000, 'posted'], ['2026-01-09', -20_000, 'posted']]],
    ['bofa-card.csv', 'card', 'bofa-card', [['2026-01-13', -3_820, 'posted'], ['2026-01-11', 25_000, 'posted'], ['2026-01-07', -41_200, 'posted']]],
    ['wells-fargo.csv', 'bank', 'wells-fargo', [['2026-01-15', -4_510, 'posted'], ['2026-01-12', 185_000, 'posted'], ['2026-01-09', -30_000, 'posted']]],
    ['citi-card.csv', 'card', 'citi-card', [['2026-01-15', -1_599, 'pending'], ['2026-01-12', -8_950, 'posted'], ['2026-01-10', 40_000, 'posted'], ['2026-01-05', 1_225, 'posted']]],
    ['capitalone-card.csv', 'card', 'capitalone-card', [['2026-01-14', -4_812, 'posted'], ['2026-01-11', 30_000, 'posted'], ['2026-01-08', -2_107, 'posted']]],
    ['capitalone-360.csv', 'bank', 'capitalone-360', [['2026-01-14', 210_000, 'posted'], ['2026-01-10', -150_000, 'posted'], ['2026-01-01', 125, 'posted']]],
    ['usbank.csv', 'bank', 'usbank', [['2026-01-14', -6_430, 'posted'], ['2026-01-12', 240_000, 'posted'], ['2026-01-09', -13_000, 'posted']]],
    ['pnc.csv', 'bank', 'pnc', [['2026-01-14', -985, 'posted'], ['2026-01-12', 100_000, 'posted'], ['2026-01-08', -25_000, 'posted']]],
    ['mercury.csv', 'bank', 'mercury', [['2026-01-15', -21_240, 'pending'], ['2026-01-13', 1_500_000, 'posted'], ['2026-01-11', -320_000, 'posted'], ['2026-01-10', -7_500, 'void']]],
    ['apple-card.csv', 'card', 'apple-card', [['2026-01-14', -675, 'posted'], ['2026-01-12', 25_000, 'posted'], ['2026-01-10', -4_218, 'posted'], ['2026-01-09', 1_200, 'posted']]],
    ['discover-card.csv', 'card', 'discover-card', [['2026-01-14', -5_430, 'posted'], ['2026-01-11', 20_000, 'posted'], ['2026-01-08', -3_105, 'posted']]],
  ] as const)('%s', async (name, kind, preset, rows) => {
    const { r, rows: got } = await run(name, kind)
    expect([r.mapping?.source, r.mapping?.preset?.id]).toEqual(['preset', preset])
    expect(got).toEqual(rows)
    for (const c of r.balanceCheck) expect(c.status, `${name} balance check`).not.toBe('mismatch')
  })

  it('a running balance is checked and becomes the closing balance (Bank of America skips its summary block)', async () => {
    const r = await importFile(bytes('bofa-checking.csv'), 'stmt.csv', checking())
    expect(r.balanceCheck).toMatchObject([{ status: 'ok', method: 'running_balance' }])
    expect(one<BalanceSnapshot>(r.events, 'balance.snapshot')[0]?.current).toEqual({ minor: 338_755, currency: 'USD' })
    expect(one<AccountUpsert>(r.events, 'account.upsert')[0]?.institution).toBe('Bank of America')
  })

  it('Bank of America card rows use the bank reference as the id, so a re-export dedupes', async () => {
    const [a, b] = [await importFile(bytes('bofa-card.csv'), 'a.csv', card()), await importFile(bytes('bofa-card.csv'), 'b.csv', card())]
    expect(txns(a.events).map((t) => t.externalId)).toEqual(['file_card:24692166012345678901234', 'file_card:24692166012345678901235', 'file_card:24692166012345678901236'])
    expect(txns(b.events).map((t) => t.externalId)).toEqual(txns(a.events).map((t) => t.externalId))
  })

  it('a bare Date/Description/Amount file is not taken for Amex (its sign would flip)', async () => {
    const r = await importFile(utf8('Date,Description,Amount,Balance\n2026-01-03,Sample Shop,-5.00,995.00\n'), 'x.csv', checking())
    expect(r.mapping?.source).toBe('suggested')
    expect(txns(r.events)[0]?.amount.minor).toBe(-500)
  })

  it('an unknown export still goes through the header guess', async () => {
    const r = await importFile(utf8('Date,Payee,Amount\n2026-01-03,Sample Shop,-5.00\n2026-01-04,Sample Client,100.00\n'), 'x.csv', checking())
    expect(r.mapping?.source).toBe('suggested')
  })
})

// ---------- US bank OFX/QFX ----------

describe('US bank OFX/QFX: FITIDs, and banks that re-issue them', () => {
  const prior = (events: NormalizedEvent[]) => async (acct: string, from: string, to: string) =>
    txns(events).filter((t) => t.accountExternalId === acct && t.date >= from && t.date <= to).map((t) => ({ externalId: t.externalId, date: t.date, amountMinor: t.amount.minor, text: t.rawText ?? '' }))

  it.each([
    ['chase-checking.qfx', [-4_210, 150_000, -4_210, -25_000], 316_570],
    ['bofa-card.qfx', [-5_840, 30_000, -1_725], -127_565],
    ['wells-fargo.qfx', [-7_500, 220_000], 412_500],
    ['capitalone-card.ofx', [-2_107, 30_000, -4_812], -76_919],
  ] as const)('%s: FITID ids, the OFX sign, the ledger balance', async (name, amounts, ledger) => {
    const r = await importFile(bytes(name), name, checking())
    const t = txns(r.events)
    expect(t.map((x) => x.amount.minor)).toEqual(amounts)
    expect(t.every((x) => !/:h[0-9a-f]{32}$/.test(x.externalId))).toBe(true)
    expect(one<BalanceSnapshot>(r.events, 'balance.snapshot')[0]?.current.minor).toBe(ledger)
    const again = await importFile(bytes(name), `${name}.copy`, checking())
    expect(txns(again.events).map((x) => x.externalId)).toEqual(t.map((x) => x.externalId))
  })

  it('a re-download with new FITIDs keeps the earlier ids, so January counts once; the new row is new', async () => {
    const jan = await importFile(bytes('chase-checking.qfx'), 'jan.qfx', checking())
    const naive = await importFile(bytes('chase-checking-redownload.qfx'), 'jan2.qfx', checking())
    // Without the guard every row would look new:
    expect(txns(naive.events).filter((t) => txns(jan.events).some((j) => j.externalId === t.externalId))).toHaveLength(0)
    const guarded = await importFile(bytes('chase-checking-redownload.qfx'), 'jan2.qfx', checking({ prior: prior(jan.events) }))
    const ids = txns(guarded.events).map((t) => t.externalId)
    expect(ids.slice(0, 4)).toEqual(txns(jan.events).map((t) => t.externalId))
    expect(ids[4]).toMatch(/:202601180001B$/)
    expect(guarded.warnings).toContain('4 rows came with new transaction ids from the bank; matched to the earlier import so they count once')
  })

  it('an earlier row the new file still has under its own FITID is never borrowed', async () => {
    const jan = await importFile(bytes('chase-checking.qfx'), 'jan.qfx', checking())
    const same = await importFile(bytes('chase-checking.qfx'), 'jan-again.qfx', checking({ prior: prior(jan.events) }))
    expect(txns(same.events).map((t) => t.externalId)).toEqual(txns(jan.events).map((t) => t.externalId))
    expect(same.warnings.some((w) => /new transaction ids/.test(w))).toBe(false)
  })
})

// ---------- One plain question when a CSV is ambiguous ----------

describe('an ambiguous CSV asks one question at a time', () => {
  const file = utf8('When,What,Value,Note\n03/04/2026,Sample Shop,-12.00,x\n05/06/2026,Sample Client,250.00,y\n')
  it('known exports and confident guesses ask nothing', () => {
    expect('mapping' in planCsvImport(bytes('chase-card.csv'))).toBe(true)
    expect('mapping' in planCsvImport(utf8('Date,Description,Amount\n2026-01-03,Sample Shop,-5.00\n2026-01-14,Sample Client,100.00\n'))).toBe(true)
  })
  it('unknown headers: the date column, then the amount column, then the date order', () => {
    const q1 = planCsvImport(file)
    expect('question' in q1 && q1.question).toMatchObject({ field: 'date', text: 'Which column is the date?', headers: ['When', 'What', 'Value', 'Note'], sample: [['03/04/2026', 'Sample Shop', '-12.00', 'x'], ['05/06/2026', 'Sample Client', '250.00', 'y']] })
    const q2 = planCsvImport(file, { date: 'When' })
    expect('question' in q2 && q2.question).toMatchObject({ field: 'amount', text: 'Which column is the amount?' })
    expect('question' in q2 && q2.question.options.map((o) => o.value)).toEqual(['What', 'Value', 'Note'])
    const q3 = planCsvImport(file, { date: 'When', amount: 'Value' })
    expect('question' in q3 && q3.question).toMatchObject({ field: 'dateFormat', text: 'Is 03/04/2026 March 4 or April 3?', options: [{ value: 'MM/DD/YYYY' }, { value: 'DD/MM/YYYY' }] })
    const done = planCsvImport(file, { date: 'When', amount: 'Value', dateFormat: 'DD/MM/YYYY' })
    expect('mapping' in done && done.mapping).toMatchObject({ date: 'When', dateFormat: 'DD/MM/YYYY', amount: { kind: 'signed', column: 'Value', convention: 'positive_is_in' } })
  })
  it('a card export with no payment rows asks which way the sign goes', async () => {
    const card1 = utf8('Date,Description,Amount\n2026-01-03,Sample Shop,12.00\n2026-01-14,Sample Cafe,4.50\n')
    const q = planCsvImport(card1, {}, { accountType: 'credit_card' })
    expect('question' in q && q.question).toMatchObject({ field: 'sign', text: 'In this file, is a positive amount money you spent or money that came in?' })
    const plan = planCsvImport(card1, { sign: 'positive_is_out' }, { accountType: 'credit_card' })
    expect('mapping' in plan).toBe(true)
    const r = await importFile(card1, 'c.csv', card({ mapping: 'mapping' in plan ? plan.mapping : undefined }))
    expect(txns(r.events).map((t) => t.amount.minor)).toEqual([-1200, -450])
  })
})
