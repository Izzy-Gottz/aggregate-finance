// Pulley and OCX (Carta / Mantle) Excel imports. The workbooks are synthetic, written here as real OOXML: they follow
// Pulley's documented export tabs and the Open Cap Table Coalition's OCX layout (github.com/Open-Cap-Table-Coalition/ocx),
// with made-up companies and people.

import { connect, migrateToLatest, newId, nowIso, type CoreTables, type DbHandle } from '@agfn/db'
import { crc32, deflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { replay } from './captable.ts'
import { parseVestingText } from './csv.ts'
import { EquityService, type EquityTables } from './service.ts'
import { importCapTableXlsx } from './workbook.ts'
import { readXlsx, XlsxError } from './xlsx.ts'

// ---------- A small .xlsx writer for fixtures ----------

/** A cell: text, a number, a date ({ d }), or a formula with its saved result ({ f, v }). */
type Cell = string | number | null | { d: string } | { f: string; v: number }
type Book = Array<{ name: string; rows: Cell[][] }>

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const col = (i: number) => {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}
const serial = (iso: string, date1904 = false) => (Date.parse(iso + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 86_400_000 - (date1904 ? 1462 : 0)

function zip(files: Record<string, string>): Uint8Array {
  const parts: Buffer[] = []
  const dir: Buffer[] = []
  let off = 0
  for (const [name, body] of Object.entries(files)) {
    const raw = Buffer.from(body, 'utf8')
    const data = deflateRawSync(raw)
    const n = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0), local.writeUInt16LE(20, 4), local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc32(raw), 14), local.writeUInt32LE(data.length, 18), local.writeUInt32LE(raw.length, 22), local.writeUInt16LE(n.length, 26)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0), c.writeUInt16LE(20, 4), c.writeUInt16LE(20, 6), c.writeUInt16LE(8, 10)
    c.writeUInt32LE(crc32(raw), 16), c.writeUInt32LE(data.length, 20), c.writeUInt32LE(raw.length, 24), c.writeUInt16LE(n.length, 28), c.writeUInt32LE(off, 42)
    parts.push(local, n, data)
    dir.push(c, n)
    off += 30 + n.length + data.length
  }
  const cd = Buffer.concat(dir)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0), end.writeUInt16LE(dir.length / 2, 8), end.writeUInt16LE(dir.length / 2, 10), end.writeUInt32LE(cd.length, 12), end.writeUInt32LE(off, 16)
  return new Uint8Array(Buffer.concat([...parts, cd, end]))
}

function xlsx(book: Book, opts: { sharedStrings?: boolean; date1904?: boolean } = {}): Uint8Array {
  const shared: string[] = []
  const str = (s: string) => {
    if (!opts.sharedStrings) return ` t="inlineStr"><is><t xml:space="preserve">${esc(s)}</t></is></c>`
    let i = shared.indexOf(s)
    if (i < 0) i = shared.push(s) - 1
    return ` t="s"><v>${i}</v></c>`
  }
  const sheets = book.map((s) =>
    `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${s.rows
      .map((r, ri) => `<row r="${ri + 1}">${r
        .map((v, ci) => {
          const ref = `${col(ci)}${ri + 1}`
          if (v === null || v === '') return ''
          if (typeof v === 'string') return `<c r="${ref}"${str(v)}`
          if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`
          if ('d' in v) return `<c r="${ref}" s="1"><v>${serial(v.d, opts.date1904)}</v></c>`
          return `<c r="${ref}"><f>${esc(v.f)}</f><v>${v.v}</v></c>`
        })
        .join('')}</row>`)
      .join('')}</sheetData></worksheet>`,
  )
  const files: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${opts.date1904 ? '<workbookPr date1904="1"/>' : ''}<sheets>${book.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${book.map((_, i) => `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
    'xl/styles.xml': '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="mm/dd/yyyy"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>',
  }
  sheets.forEach((x, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = x))
  if (opts.sharedStrings) files['xl/sharedStrings.xml'] = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`
  return zip(files)
}

// ---------- Fixtures ----------

/** Pulley's "Download Cap Table" (All Time): a summary tab plus one ledger tab per kind of security. */
function pulley(summaryAda = 6_000_000): Book {
  return [
    {
      name: 'Summary',
      rows: [
        ['Northwind Robotics, Inc. Cap Table'],
        ['As of 10/01/2026'],
        [],
        ['Stakeholder', 'Common', 'Series Seed Preferred', '2024 Equity Incentive Plan', 'Fully Diluted Shares', 'Fully Diluted %'],
        ['Ada Okafor', summaryAda, null, null, { f: 'SUM(B5:D5)', v: summaryAda }, 0.5],
        ['Ben Ruiz', 3_000_000, null, null, 3_000_000, 0.25],
        ['Kite Ventures Fund II, L.P.', null, 1_500_000, null, 1_500_000, 0.125],
        ['Cora Lin', null, null, 400_000, 400_000, 0.033],
        ['Dev Shah', null, null, 100_000, 100_000, 0.008],
        ['Available for Issuance', null, null, 1_000_000, 1_000_000, 0.083],
        ['Total', { f: 'SUM(B5:B10)', v: summaryAda + 3_000_000 }, 1_500_000, 1_500_000, { f: 'SUM(E5:E10)', v: summaryAda + 6_000_000 }, 1],
      ],
    },
    {
      name: 'Common Stock',
      rows: [
        ['Northwind Robotics, Inc. — Common Stock'],
        [],
        ['Security ID', 'Stakeholder', 'Share Class', 'Shares', 'Issue Date', 'Price Per Share', 'Vesting Schedule', 'Vesting Start Date'],
        ['CS-1', 'Ada Okafor', 'Common', 6_000_000, { d: '2024-02-01' }, 0.0001, '4 years, 1 year cliff', { d: '2024-02-01' }],
        ['CS-2', 'Ben Ruiz', 'Common', 3_000_000, { d: '2024-02-01' }, 0.0001, '48 months / 12 month cliff', { d: '2024-02-01' }],
        ['Total', null, null, { f: 'SUM(D4:D5)', v: 9_000_000 }],
      ],
    },
    {
      name: 'Preferred Stock',
      rows: [
        ['Security ID', 'Stakeholder', 'Share Class', 'Shares', 'Issue Date', 'Price Per Share', 'Cash Paid'],
        ['PS-1', 'Kite Ventures Fund II, L.P.', 'Series Seed Preferred', 1_500_000, { d: '2025-06-15' }, 1.0, 1_500_000],
      ],
    },
    {
      name: 'Incentive Plan',
      rows: [
        ['2024 Equity Incentive Plan'],
        ['Security ID', 'Stakeholder', 'Grant Date', 'Options Granted', 'Exercise Price', 'Exercised', 'Canceled', 'Vesting Schedule', 'Vesting Start Date'],
        ['ES-1', 'Cora Lin', { d: '2025-01-10' }, 500_000, 0.2, 0, 100_000, '1/48 monthly, 1 year cliff', { d: '2025-01-10' }],
        ['ES-2', 'Dev Shah', { d: '2025-09-01' }, 100_000, 0.35, 0, 0, '4 years, 1 year cliff', { d: '2025-09-01' }],
        ['Available for issuance', null, null, 1_000_000],
      ],
    },
    {
      name: 'SAFEs',
      rows: [
        ['Investor', 'Investment Amount', 'Valuation Cap', 'Discount', 'Date'],
        ['Ada Okafor', '$50,000.00', '$6,000,000', '', { d: '2024-03-01' }],
      ],
    },
  ]
}

/** OCX v1 as ocf2ocx writes it: Summary Snapshot, Stakeholder Snapshot (A1 is =Context!A1), Voting, Context. */
function ocx(opts: { totalCommon?: number } = {}): Book {
  const asOf = { d: '2026-09-30' }
  return [
    { name: 'Summary Snapshot', rows: [[asOf, null, 'Lumen Labs Summary of Capitalization'], ['Class', 'Authorized', 'Outstanding'], ['Common Stock', 10_000_000, 7_000_000]] },
    {
      name: 'Stakeholder Snapshot',
      rows: [
        [{ f: 'Context!A1', v: serial('2026-09-30') }, null, 'Lumen Labs Capitalization by Stakeholder'],
        ['Stakeholder', 'Stakeholder Group', 'Common Stock', 'Series A Preferred\n(outstanding) (1.0000)', 'Series A Preferred\n(as converted)', '2022 Stock Plan', 'Series A Preferred Warrants', 'Total Stock\n(outstanding)*', 'Total Stock\n(as converted)', 'Total Stock %\n(as converted)', 'Fully Diluted Shares**', 'Fully Diluted %'],
        ['Maya Patel', null, 5_000_000, 0, 0, 0, 0, 5_000_000, 5_000_000, 0.55, 5_000_000, 0.45],
        ['Omar Reyes', null, 2_000_000, 0, 0, 250_000, 0, 2_000_000, 2_000_000, 0.22, 2_250_000, 0.2],
        ['Harbor Seed Fund, LP', null, 0, 2_000_000, 2_000_000, 0, 0, 2_000_000, 2_000_000, 0.22, 2_000_000, 0.18],
        ['Riverbank Lending, LLC', null, 0, 0, 0, 0, 50_000, 0, 0, 0, 50_000, 0.005],
        [],
        ['Options Remaining for Issuance', null, 0, 0, 0, 1_750_000, 0, null, null, null, 1_750_000, 0.16],
        [],
        ['Total', null, { f: 'SUM(C3:C8)', v: opts.totalCommon ?? 7_000_000 }, 2_000_000, 2_000_000, { f: 'SUM(F3:F8)', v: 2_000_000 }, 50_000, 9_000_000, 9_000_000, 1, { f: 'SUM(K3:K8)', v: 11_050_000 }, 1],
      ],
    },
    { name: 'Voting by SH Group', rows: [['Voting Power by Shareholder Group']] },
    { name: 'Context', rows: [[asOf, null, 'Context']] },
  ]
}

const today = '2026-10-12'

// ---------- The reader ----------

describe('readXlsx', () => {
  it('reads inline and shared strings, numbers, saved formula results, and dates (1900 and 1904 systems)', () => {
    const book: Book = [{ name: 'S', rows: [['A & B <c>', 12.5, { f: 'B1*2', v: 25 }, { d: '2025-06-15' }]] }]
    for (const o of [{}, { sharedStrings: true }, { date1904: true }]) {
      const [s] = readXlsx(xlsx(book, o))
      expect(s!.rows[0]).toEqual(['A & B <c>', '12.5', '25', '2025-06-15'])
    }
  })

  it('refuses what isn’t an .xlsx, and password-protected files, in plain words', () => {
    expect(() => readXlsx(new TextEncoder().encode('Stakeholder,Shares\nA,1'))).toThrow(XlsxError)
    const b = xlsx([{ name: 'S', rows: [['x']] }])
    const v = new DataView(b.buffer)
    // Set the "encrypted" flag on every central-directory entry.
    for (let i = 0; i < b.length - 4; i++) if (v.getUint32(i, true) === 0x02014b50) v.setUint16(i + 8, 1, true)
    expect(() => readXlsx(b)).toThrow(/password-protected/)
  })
})

describe('parseVestingText', () => {
  it('reads the usual ways a schedule is written', () => {
    expect(parseVestingText('4 years, 1 year cliff')).toEqual({ months: 48, cliffMonths: 12 })
    expect(parseVestingText('48 months / 12 month cliff')).toEqual({ months: 48, cliffMonths: 12 })
    expect(parseVestingText('1/48 monthly, 1 year cliff')).toEqual({ months: 48, cliffMonths: 12 })
    expect(parseVestingText('Immediate')).toBeUndefined()
  })
})

// ---------- Pulley ----------

describe('Pulley cap table export', () => {
  it('imports every ledger tab, typed by tab name, and checks it against the Summary tab', () => {
    const r = importCapTableXlsx(xlsx(pulley(), { sharedStrings: true }), { today })
    expect(r.kind).toBe('ledger')
    expect(r.notes).toContain('Checked against the “Summary” summary: every holding matches on 2026-10-01.')
    const s = replay(r.objects, today)
    expect(s.stakeholders.map((x) => x.name).sort()).toEqual(['Ada Okafor', 'Ben Ruiz', 'Cora Lin', 'Dev Shah', 'Kite Ventures Fund II, L.P.'])
    expect(s.classes.map((c) => [c.name, c.classType])).toEqual([['Common', 'COMMON'], ['Series Seed Preferred', 'PREFERRED']])
    expect(s.stock.map((p) => p.quantity).sort((a, b) => a - b)).toEqual([1_500_000, 3_000_000, 6_000_000])
    expect(s.stock.find((p) => p.quantity === 6_000_000)?.vesting).toEqual({ start: '2024-02-01', months: 48, cliffMonths: 12 })
    // The Incentive Plan tab has no type column: its name makes the rows options. "Canceled" (US spelling) counts.
    const cora = s.grants.find((g) => g.granted === 500_000)!
    expect([cora.compensationType, cora.cancelled, cora.vesting?.months, cora.exercisePrice?.minor]).toEqual(['OPTION_NSO', 100_000, 48, 20])
    // The pool is what was granted plus what the tab lists as available; "Total" and "Available" rows aren't holders.
    expect(s.plans[0]!.size).toBe(1_600_000)
    expect(s.convertibles).toHaveLength(1)
    expect(s.convertibles[0]!.amount.minor).toBe(5_000_000)
    expect(s.warnings).toEqual([])
  })

  it('says so when the ledger tabs and the Summary tab disagree', () => {
    const r = importCapTableXlsx(xlsx(pulley(5_000_000)), { today })
    expect(r.notes.find((n) => n.includes('don’t match'))).toContain('ada okafor common: ledger tabs 6,000,000, “Summary” 5,000,000')
  })

  it('imports a Summary-only workbook as a snapshot', () => {
    const r = importCapTableXlsx(xlsx([pulley()[0]!]), { today })
    expect(r.kind).toBe('snapshot')
    expect(r.asOf).toBe('2026-10-01')
    const s = replay(r.objects, today)
    expect(s.plans[0]).toMatchObject({ name: '2024 Equity Incentive Plan', size: 1_500_000 })
    expect(r.notes.some((n) => /add up|says/.test(n) && !/summary cap table/.test(n))).toBe(false)
  })
})

// ---------- OCX ----------

describe('OCX (Carta / Mantle Excel export)', () => {
  it('imports the Stakeholder Snapshot: classes, the plan and its unissued options, warrants; totals check out', () => {
    const r = importCapTableXlsx(xlsx(ocx()), { today })
    expect(r.kind).toBe('snapshot')
    expect(r.asOf).toBe('2026-09-30')
    expect(r.rows).toBe(4)
    const s = replay(r.objects, today)
    expect(s.classes.map((c) => [c.name, c.classType, c.conversionRatio])).toEqual([['Common Stock', 'COMMON', 1], ['Series A Preferred', 'PREFERRED', 1]])
    expect(s.plans).toHaveLength(1)
    expect(s.plans[0]).toMatchObject({ name: '2022 Stock Plan', size: 2_000_000 })
    expect(s.grants.map((g) => [g.granted, g.date])).toEqual([[250_000, '2026-09-30']])
    expect(s.warrants.map((w) => w.granted)).toEqual([50_000])
    expect(s.stock.reduce((t, p) => t + p.quantity, 0)).toBe(9_000_000)
    // Nothing disagreed with the file's own Total row or its fully diluted total.
    expect(r.notes.filter((n) => /add up/.test(n))).toEqual([])
    expect(r.notes[0]).toMatch(/^This is a summary cap table as of 2026-09-30/)
  })

  it('flags a column that doesn’t add up to the file’s Total row', () => {
    const r = importCapTableXlsx(xlsx(ocx({ totalCommon: 7_100_000 })), { today })
    expect(r.notes).toContain('Common Stock: the holders add up to 7,000,000, but the file’s Total row says 7,100,000. Check the file before relying on this column.')
  })

  it('says plainly when a workbook isn’t a cap table', () => {
    const r = importCapTableXlsx(xlsx([{ name: 'Budget', rows: [['Month', 'Spend'], ['Jan', 100]] }]), { today })
    expect(r.kind).toBe('none')
    expect(r.notes[0]).toMatch(/^Couldn’t find a cap table/)
  })
})

// ---------- Duplicates: flagged, never doubled ----------

type T = CoreTables & EquityTables
describe('EquityService.importXlsx', () => {
  let h: DbHandle<T>
  let ws: string
  let acme: string
  let svc: EquityService
  const meta = { origin: 'import' as const, label: 'import' }
  beforeEach(async () => {
    h = connect<T>('sqlite::memory:')
    await migrateToLatest(h.db)
    ws = newId()
    acme = newId()
    await h.db.insertInto('workspaces').values({ id: ws, name: 'W', base_currency: 'USD', created_at: nowIso() }).execute()
    await h.db.insertInto('entities').values({ id: acme, workspace_id: ws, kind: 'company', name: 'Acme', base_currency: 'USD', owner_person_id: null, parent_entity_id: null, fiscal_year_start_month: 1, created_at: nowIso(), archived_at: null }).execute()
    svc = new EquityService({ db: h.db, ledger: { post: async () => ({ journalEntryId: 'je' }) }, now: () => '2026-10-12T12:00:00.000Z' })
  })
  afterEach(() => h.close())

  it('the same OCX twice adds nothing the second time', async () => {
    const a = await svc.importXlsx(ws, acme, xlsx(ocx()), meta)
    expect(a.added).toBeGreaterThan(0)
    const b = await svc.importXlsx(ws, acme, xlsx(ocx(), { sharedStrings: true }), meta)
    expect(b.added).toBe(0)
    expect(b.notes[0]).toMatch(/matches the cap table on 2026-09-30 holding for holding/)
    expect((await svc.detail(ws, acme)).fullyDiluted.total).toBe(11_050_000)
  })

  it('a snapshot that differs from the cap table is refused, with the differences', async () => {
    await svc.importXlsx(ws, acme, xlsx(ocx()), meta)
    const book = ocx()
    book[1]!.rows[2]![2] = 4_000_000
    const r = await svc.importXlsx(ws, acme, xlsx(book), meta)
    expect(r.added).toBe(0)
    expect(r.notes[0]).toContain('maya patel common stock: on the cap table 5,000,000, in the file 4,000,000')
  })

  it('a ledger on top of a snapshot is refused; the Pulley ledger twice adds nothing', async () => {
    await svc.importXlsx(ws, acme, xlsx(ocx()), meta)
    const r = await svc.importXlsx(ws, acme, xlsx(pulley()), meta)
    expect(r.added).toBe(0)
    expect(r.notes[0]).toMatch(/built from a summary snapshot/)

    const other = newId()
    await h.db.insertInto('entities').values({ id: other, workspace_id: ws, kind: 'company', name: 'Northwind', base_currency: 'USD', owner_person_id: null, parent_entity_id: null, fiscal_year_start_month: 1, created_at: nowIso(), archived_at: null }).execute()
    const first = await svc.importXlsx(ws, other, xlsx(pulley()), meta)
    expect(first.added).toBeGreaterThan(0)
    const again = await svc.importXlsx(ws, other, xlsx(pulley(), { sharedStrings: true }), meta)
    expect(again.added).toBe(0)
    // Pulley's own Summary tab on its own is the same holdings: flagged as a match, not doubled.
    const summary = await svc.importXlsx(ws, other, xlsx([pulley()[0]!]), meta)
    expect(summary.added).toBe(0)
    expect(summary.notes[0]).toMatch(/matches the cap table/)
  })
})
