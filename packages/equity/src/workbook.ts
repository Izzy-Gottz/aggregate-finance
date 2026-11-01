// Excel cap-table import: Pulley's "Download Cap Table" workbook, Carta's or Mantle's OCX (the Open Cap Table
// Coalition's Excel layout), or any spreadsheet laid out like them.
//
// A workbook holds one of two things, sometimes both:
// - ledger tabs, one row per security (Pulley's share, incentive-plan, convertible and warrant tabs): each tab goes
//   through the same column matching as a CSV (csv.ts), with the tab's name standing in for a missing type column;
// - a snapshot: holders down the side, classes, plans and warrants across, a Total row at the bottom (OCX's
//   "Stakeholder Snapshot", Pulley's summary tab). It says what each holder owns on one date, not each grant.
// Ledger tabs win: they carry dates, prices and vesting. A snapshot next to them is only used to check the import
// adds up to the same holdings. A snapshot alone is imported as one holding per holder and column, dated as of the
// snapshot. Every column is checked against the file's own Total row and fully diluted total, and differences are
// reported, never smoothed over.

import { replay } from './captable.ts'
import { dateOf, importCapTableRows, norm, number, slug, type CsvImportResult } from './csv.ts'
import { looksInstitutional, type EquityObject, type IsoDate } from './model.ts'
import { readXlsx, type Sheet } from './xlsx.ts'

export interface WorkbookImportResult extends CsvImportResult {
  /** 'ledger': one row per security. 'snapshot': holdings on one date (asOf). */
  kind: 'ledger' | 'snapshot' | 'none'
  asOf?: IsoDate
}

export interface WorkbookImportOptions {
  currency?: string
  idPrefix?: string
  existing?: readonly EquityObject[]
  /** Used as the snapshot date when the workbook doesn't show one. */
  today: IsoDate
}

/** Snapshot imports' ids start with this, so a later ledger import can tell the two apart (see service.ts). */
export const SNAPSHOT_ID = 'snap'

/** A tab's name as the type of its rows, for tabs with no type column. */
function hintFor(sheet: string): string | undefined {
  const s = sheet.toLowerCase()
  if (/\brsus?\b|restricted stock unit/.test(s)) return 'rsu'
  if (/option|incentive|equity plan|grant|award/.test(s)) return 'option'
  if (/warrant/.test(s)) return 'warrant'
  if (/\bsafes?\b/.test(s)) return 'safe'
  if (/convertible|\bnotes?\b/.test(s)) return 'convertible note'
  if (/prefer|series/.test(s)) return 'preferred'
  return undefined
}

const SKIP_TAB = /^(context|notes?|instructions|read ?me|legend|stakeholders?( report)?|contacts?)$|^voting\b/i
const head = (s: string) => s.replace(/\s+/g, ' ').replace(/\*+$/, '').trim()

// ---------- Snapshot ----------

type ColKind =
  | { kind: 'class'; name: string; preferred: boolean; ratio: number }
  | { kind: 'plan'; name: string; rsu: boolean }
  | { kind: 'warrant'; className: string }
  | { kind: 'nonplan'; className: string }
  | { kind: 'fd' }
  | { kind: 'skip' }

function classify(h: string): ColKind {
  const t = head(h)
  const l = t.toLowerCase()
  if (!l || l === 'stakeholder group' || /as converted|%|percent|ownership|voting/.test(l)) return { kind: 'skip' }
  if (/^fully diluted( shares)?$/.test(l)) return { kind: 'fd' }
  if (/^total\b|fully diluted/.test(l)) return { kind: 'skip' }
  let m = t.match(/^(.*?)\s+warrants?$/i)
  if (m) return { kind: 'warrant', className: m[1]!.trim() }
  m = t.match(/^(.*?)\s+non-plan awards?$/i)
  if (m) return { kind: 'nonplan', className: m[1]!.trim() }
  m = t.match(/^(.*?)\s*\(outstanding\)\s*(?:\(~?([\d.]+)\))?$/i)
  if (m) return { kind: 'class', name: m[1]!.trim(), preferred: true, ratio: m[2] ? Number(m[2]) : 1 }
  if (/\bplan\b|\bpool\b|options?\b|incentive|\bawards?\b|\brsus?\b/i.test(t) && !/prefer|series|common/i.test(t)) return { kind: 'plan', name: t, rsu: /\brsus?\b/i.test(t) }
  return { kind: 'class', name: t, preferred: /prefer|series/i.test(t), ratio: 1 }
}

/** The header row of a snapshot: "Stakeholder" (or a holder synonym) followed by at least one holdings column. */
function snapshotHeader(rows: readonly string[][]): number {
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const r = rows[i] ?? []
    const c = r.findIndex((x) => /^(stakeholders?|stakeholder name|holders?|shareholders?|security holders?|name)$/.test(norm(head(x))))
    if (c < 0) continue
    const after = r.slice(c + 1).map(classify)
    if (after.some((k) => k.kind === 'class' || k.kind === 'plan') && !r.some((x) => /^(issue|grant) date$|^date$|^security type$/i.test(norm(x)))) return i
  }
  return -1
}

function snapshotDate(sheets: readonly Sheet[], sheet: Sheet, headerRow: number): IsoDate | undefined {
  const scan = (rows: readonly string[][], upTo: number) => {
    for (const r of rows.slice(0, upTo)) for (const x of r) if (/^\d{4}-\d{2}-\d{2}$/.test(x.trim())) return x.trim()
    for (const r of rows.slice(0, upTo)) for (const x of r) {
      const m = x.match(/as of\s+(.+)$/i)
      const d = m ? dateOf(m[1]!) : undefined
      if (d) return d
    }
    return undefined
  }
  const ctx = sheets.find((s) => /^context$/i.test(s.name.trim()))
  return scan(sheet.rows, headerRow) ?? (ctx ? scan(ctx.rows, 10) : undefined)
}

interface Snapshot {
  objects: EquityObject[]
  notes: string[]
  holders: number
}

function importSnapshot(sheet: Sheet, at: number, asOf: IsoDate, pre: string): Snapshot {
  const notes: string[] = []
  const header = sheet.rows[at]!
  const holderCol = header.findIndex((x) => /^(stakeholders?|stakeholder name|holders?|shareholders?|security holders?|name)$/.test(norm(head(x))))
  const cols = header.map((h, i) => (i > holderCol ? classify(h) : ({ kind: 'skip' } as ColKind)))
  const objects: EquityObject[] = []
  const classIds = new Map<string, string>()
  const classOf = (name: string, preferred: boolean, ratio = 1) => {
    const k = name.toLowerCase()
    let id = classIds.get(k)
    if (!id) {
      id = `${pre}-cls-${slug(name)}`
      classIds.set(k, id)
      objects.push({ type: 'STOCK_CLASS', id, name, classType: preferred ? 'PREFERRED' : 'COMMON', authorized: null, seniority: preferred ? 1 : 0, liquidationPrefMultiple: preferred ? 1 : 0, participating: false, participationCapMultiple: null, conversionRatio: ratio })
      if (preferred) notes.push(`Created ${name} as 1x non-participating preferred. Change it if the terms differ.`)
    }
    return id
  }
  // Classes first, in the file's order, so the cap table lists them the same way.
  for (const c of cols) if (c.kind === 'class') classOf(c.name, c.preferred, c.ratio)
  const common = () => {
    for (const c of cols) if (c.kind === 'class' && !c.preferred) return classOf(c.name, false)
    return classOf('Common', false)
  }
  const planIds = new Map<number, string>()
  cols.forEach((c, i) => {
    if (c.kind !== 'plan') return
    const id = `${pre}-plan-${slug(c.name)}`
    planIds.set(i, id)
    objects.push({ type: 'STOCK_PLAN', id, name: c.name, stockClassId: common(), size: 0 })
  })

  const sums = new Map<number, number>()
  const remaining = new Map<number, number>()
  const totals = new Map<number, number>()
  const people: EquityObject[] = []
  let anyPlanGrant = false
  for (let r = at + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r] ?? []
    const name = (row[holderCol] ?? '').trim()
    const label = name || row.slice(0, holderCol + 1).join(' ').trim()
    if (/remaining for (issuance|grant)|available for (issuance|grant)|^unallocated|^unissued/i.test(label)) {
      cols.forEach((_, i) => remaining.set(i, (remaining.get(i) ?? 0) + (number(row[i]) ?? 0)))
      continue
    }
    if (/^(grand\s+)?totals?\b/i.test(label)) {
      cols.forEach((_, i) => {
        const n = number(row[i])
        if (n !== undefined) totals.set(i, n)
      })
      break
    }
    if (!name) continue
    const who = `${pre}-sh-${slug(name)}`
    let holds = false
    cols.forEach((c, i) => {
      const q = number(row[i])
      if (!q || c.kind === 'skip' || c.kind === 'fd') return
      if (q < 0) return notes.push(`${sheet.name}, row ${r + 1}: ${name} has a negative holding (${q}); skipped.`)
      sums.set(i, (sums.get(i) ?? 0) + q)
      const id = `${pre}-${slug(name)}-${i}`
      holds = true
      if (c.kind === 'class') objects.push({ type: 'TX_STOCK_ISSUANCE', id, date: asOf, securityId: id, stakeholderId: who, stockClassId: classOf(c.name, c.preferred, c.ratio), quantity: q })
      else if (c.kind === 'plan') {
        anyPlanGrant = true
        objects.push({ type: 'TX_EQUITY_COMPENSATION_ISSUANCE', id, date: asOf, securityId: id, stakeholderId: who, stockPlanId: planIds.get(i)!, stockClassId: common(), compensationType: c.rsu ? 'RSU' : 'OPTION_NSO', quantity: q })
      } else if (c.kind === 'nonplan') objects.push({ type: 'TX_EQUITY_COMPENSATION_ISSUANCE', id, date: asOf, securityId: id, stakeholderId: who, stockClassId: common(), compensationType: 'OPTION_NSO', quantity: q })
      else if (c.kind === 'warrant') objects.push({ type: 'TX_WARRANT_ISSUANCE', id, date: asOf, securityId: id, stakeholderId: who, stockClassId: classOf(c.className, /prefer|series/i.test(c.className)), quantity: q })
    })
    if (holds && !people.some((p) => p.id === who)) people.push({ type: 'STAKEHOLDER', id: who, name, stakeholderType: looksInstitutional(name) ? 'INSTITUTION' : 'INDIVIDUAL' })
  }

  // Pools are what was granted plus what the file says is left.
  for (const [i, id] of planIds) {
    const plan = objects.find((o) => o.id === id)
    if (plan?.type === 'STOCK_PLAN') plan.size = (sums.get(i) ?? 0) + (remaining.get(i) ?? 0)
  }
  // Each column against the file's own Total row.
  cols.forEach((c, i) => {
    if (c.kind === 'skip' || c.kind === 'fd' || !totals.has(i)) return
    const want = totals.get(i)! - (c.kind === 'plan' ? (remaining.get(i) ?? 0) : 0)
    const got = sums.get(i) ?? 0
    // OCX's plan Total includes what's left in the pool; other layouts' don't. Accept either.
    if (Math.abs(got - want) > 0.5 && Math.abs(got - totals.get(i)!) > 0.5) notes.push(`${head(header[i]!)}: the holders add up to ${got.toLocaleString('en-US')}, but the file’s Total row says ${totals.get(i)!.toLocaleString('en-US')}. Check the file before relying on this column.`)
  })
  // And the whole thing against its fully diluted total.
  const fdCol = cols.findIndex((c) => c.kind === 'fd')
  if (fdCol >= 0 && totals.has(fdCol)) {
    let fd = 0
    cols.forEach((c, i) => {
      const n = sums.get(i) ?? 0
      if (c.kind === 'class') fd += n * c.ratio
      else if (c.kind === 'plan') fd += n + (remaining.get(i) ?? 0)
      else if (c.kind === 'warrant' || c.kind === 'nonplan') fd += n
    })
    const want = totals.get(fdCol)!
    if (Math.abs(fd - want) > 0.5) notes.push(`The holdings add up to ${Math.round(fd).toLocaleString('en-US')} fully diluted shares, but the file says ${want.toLocaleString('en-US')}. Something in the file isn’t a column we read (convertibles aren’t in a snapshot); check it.`)
  }
  if (anyPlanGrant) notes.push('A summary cap table doesn’t say whether options are ISOs or NSOs, so they were recorded as NSOs. Change any that are ISOs or RSUs.')
  notes.unshift(`This is a summary cap table as of ${asOf}: it lists what each holder owns, not each grant, so holdings are dated ${asOf} with no price or vesting. If you have the ledger export (one row per certificate or grant), import that instead for full history.`)
  return { objects: [...people, ...objects], notes, holders: people.length }
}

// ---------- Comparing holdings (snapshot vs ledger) ----------

/** What each holder owns, by holder name and class (stock), "options" (grants) or class + " warrants". */
export function holdings(objects: readonly EquityObject[], asOf: IsoDate): Map<string, number> {
  const s = replay(objects, asOf)
  const who = new Map(s.stakeholders.map((x) => [x.id, x.name.toLowerCase()]))
  const cls = new Map(s.classes.map((x) => [x.id, x.name.toLowerCase()]))
  const out = new Map<string, number>()
  const add = (k: string, n: number) => n && out.set(k, (out.get(k) ?? 0) + n)
  for (const p of s.stock) add(`${who.get(p.stakeholderId)}|${cls.get(p.stockClassId)}`, p.quantity)
  for (const g of s.grants) add(`${who.get(g.stakeholderId)}|options`, g.granted - g.exercised - g.released - g.cancelled)
  for (const w of s.warrants) add(`${who.get(w.stakeholderId)}|${cls.get(w.stockClassId)} warrants`, w.granted - w.exercised - w.cancelled)
  return out
}

/** Plain-language differences between two holdings maps, at most `max` of them. */
export function holdingDiffs(a: Map<string, number>, b: Map<string, number>, labels: [string, string], max = 8): string[] {
  const out: string[] = []
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k) ?? 0
    const y = b.get(k) ?? 0
    if (Math.abs(x - y) > 0.5) {
      const [holder, what] = k.split('|')
      out.push(`${holder} ${what}: ${labels[0]} ${x.toLocaleString('en-US')}, ${labels[1]} ${y.toLocaleString('en-US')}`)
    }
  }
  return out.length > max ? [...out.slice(0, max), `…and ${out.length - max} more`] : out
}

// ---------- Entry point ----------

export function importCapTableXlsx(bytes: Uint8Array, opts: WorkbookImportOptions): WorkbookImportResult {
  const sheets = readXlsx(bytes)
  const cur = opts.currency ?? 'USD'
  const pre = opts.idPrefix ?? 'xlsx'
  const notes: string[] = []

  // Snapshot tabs (OCX's Stakeholder Snapshot first, then any holder × class table).
  const snaps = sheets
    .map((s) => ({ s, at: SKIP_TAB.test(s.name.trim()) ? -1 : snapshotHeader(s.rows) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => Number(/stakeholder snapshot/i.test(b.s.name)) - Number(/stakeholder snapshot/i.test(a.s.name)))

  // Ledger tabs, imported one after another so a holder or class on two tabs is one holder or class.
  const objects: EquityObject[] = []
  let rows = 0
  let ledgerTabs = 0
  sheets.forEach((s, i) => {
    if (SKIP_TAB.test(s.name.trim()) || snaps.some((x) => x.s === s)) return
    const r = importCapTableRows(s.rows, { currency: cur, idPrefix: `${pre}-t${i}`, existing: [...(opts.existing ?? []), ...objects], typeHint: hintFor(s.name), where: s.name, headerSearch: 15 })
    if (!r.objects.length && /Couldn’t find the holder/.test(r.notes[0] ?? '')) return
    ledgerTabs++
    rows += r.rows
    objects.push(...r.objects)
    notes.push(...r.notes)
  })

  if (ledgerTabs) {
    // A snapshot next to the ledger tabs: say so if the two don't describe the same cap table.
    const snap = snaps[0]
    if (snap) {
      const asOf = snapshotDate(sheets, snap.s, snap.at) ?? opts.today
      const view = importSnapshot(snap.s, snap.at, asOf, 'check')
      const diffs = holdingDiffs(holdings([...(opts.existing ?? []), ...objects], asOf), holdings(view.objects, asOf), ['ledger tabs', `“${snap.s.name}”`])
      if (diffs.length) notes.push(`The ledger tabs and the “${snap.s.name}” summary don’t match on ${asOf}: ${diffs.join('; ')}. The ledger tabs were imported; check the differences.`)
      else notes.push(`Checked against the “${snap.s.name}” summary: every holding matches on ${asOf}.`)
    }
    return { kind: 'ledger', objects, notes, rows }
  }
  const snap = snaps[0]
  if (snap) {
    const shown = snapshotDate(sheets, snap.s, snap.at)
    const asOf = shown ?? opts.today
    const r = importSnapshot(snap.s, snap.at, asOf, `${SNAPSHOT_ID}${pre}`)
    if (!shown) r.notes.push(`The workbook doesn’t show an as-of date, so holdings were dated today (${asOf}).`)
    return { kind: 'snapshot', asOf, objects: r.objects, notes: r.notes, rows: r.holders }
  }
  return { kind: 'none', objects: [], notes: ['Couldn’t find a cap table in this workbook: no tab has a holder column with shares, and no tab is a holder-by-class summary. Expected Pulley’s “Download Cap Table” export or an OCX file.'], rows: 0 }
}
