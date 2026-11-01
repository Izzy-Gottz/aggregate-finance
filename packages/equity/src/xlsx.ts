// Just enough of .xlsx (Office Open XML spreadsheets) to read cap-table exports: the zip container, the sheet list,
// shared strings, and each cell's value — the value Excel saved, so formula cells read as their result. Date-formatted
// numbers come back as ISO dates. No dependency: uploads are untrusted, so the reader is small, bounded and refuses
// anything odd (encrypted, zip64, oversized) instead of trying.

import { inflateRawSync } from 'node:zlib'

export interface Sheet {
  name: string
  /** Dense rows: rows[r][c] is the cell's text ('' when empty). Row 0 is the sheet's first row (A1). */
  rows: string[][]
}

export class XlsxError extends Error {}

const MAX_ENTRIES = 2_000
const MAX_TOTAL = 64 * 1024 * 1024
const MAX_ROWS = 50_000
const MAX_COLS = 500

export const looksLikeXlsx = (b: Uint8Array) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04

/** The zip's files by name. */
function unzip(b: Uint8Array): Map<string, Uint8Array> {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let eocd = -1
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65_535); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new XlsxError('That file isn’t a readable .xlsx (no zip directory).')
  const count = v.getUint16(eocd + 10, true)
  let p = v.getUint32(eocd + 16, true)
  if (count === 0xffff || p === 0xffffffff) throw new XlsxError('That .xlsx uses zip64, which isn’t supported. Re-save it in Excel.')
  if (count > MAX_ENTRIES) throw new XlsxError('That .xlsx has too many parts.')
  const files = new Map<string, Uint8Array>()
  let total = 0
  for (let n = 0; n < count; n++) {
    if (p + 46 > b.length || v.getUint32(p, true) !== 0x02014b50) throw new XlsxError('That .xlsx is damaged (zip directory).')
    const flags = v.getUint16(p + 8, true)
    const method = v.getUint16(p + 10, true)
    const size = v.getUint32(p + 20, true)
    const usize = v.getUint32(p + 24, true)
    const nameLen = v.getUint16(p + 28, true)
    const extra = v.getUint16(p + 30, true)
    const comment = v.getUint16(p + 32, true)
    const local = v.getUint32(p + 42, true)
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen))
    p += 46 + nameLen + extra + comment
    if (flags & 1) throw new XlsxError('That .xlsx is password-protected. Remove the password in Excel and upload it again.')
    if (!/\.(xml|rels)$/i.test(name)) continue
    total += usize
    if (total > MAX_TOTAL) throw new XlsxError('That .xlsx is too large once unpacked.')
    if (local + 30 > b.length || v.getUint32(local, true) !== 0x04034b50) throw new XlsxError('That .xlsx is damaged (zip entry).')
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true)
    const data = b.subarray(start, start + size)
    if (method === 0) files.set(name, data)
    else if (method === 8) {
      try {
        files.set(name, new Uint8Array(inflateRawSync(data, { maxOutputLength: Math.max(usize, 1) })))
      } catch {
        throw new XlsxError('That .xlsx is damaged (couldn’t unpack it).')
      }
    } else throw new XlsxError('That .xlsx uses an unsupported compression method.')
  }
  return files
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
function text(s: string): string {
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
      e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()]!,
    )
    .replace(/_x([0-9a-f]{4})_/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
}
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) out[m[1]!] = text(m[2]!)
  return out
}
/** The text of an <si> or <is>: its runs joined, phonetic hints left out. */
const richText = (x: string) => [...x.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => text(m[1]!)).join('')

const DATE_IDS = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57])
function isDateFormat(code: string): boolean {
  const c = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '')
  return /[dy]/i.test(c) || /m{3,}/i.test(c)
}

function colIndex(ref: string): number {
  let n = 0
  for (const ch of ref.replace(/\d+$/, '').toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function serialDate(serial: number, date1904: boolean): string | undefined {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2_958_465) return undefined
  const days = Math.floor(serial) + (date1904 ? 1462 : 0)
  return new Date(Date.UTC(1899, 11, 30) + days * 86_400_000).toISOString().slice(0, 10)
}

export function readXlsx(bytes: Uint8Array): Sheet[] {
  const files = unzip(bytes)
  const dec = new TextDecoder()
  const xml = (name: string) => {
    const f = files.get(name)
    return f ? dec.decode(f) : undefined
  }
  const wb = xml('xl/workbook.xml')
  if (!wb) throw new XlsxError('That file isn’t an Excel workbook (.xlsx).')
  const date1904 = /<workbookPr\b[^>]*date1904\s*=\s*"(1|true)"/i.test(wb)
  const rels = new Map<string, string>()
  for (const m of (xml('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)) {
    const a = attrs(m[0])
    if (a.Id && a.Target) rels.set(a.Id, a.Target.startsWith('/') ? a.Target.slice(1) : `xl/${a.Target.replace(/^\.\//, '')}`)
  }
  const shared = [...(xml('xl/sharedStrings.xml') ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => richText(m[1]!))

  // Which style indexes are dates: cellXfs in order, each pointing at a built-in or custom number format.
  const styles = xml('xl/styles.xml') ?? ''
  const custom = new Map<number, string>()
  for (const m of styles.matchAll(/<numFmt\b[^>]*>/g)) {
    const a = attrs(m[0])
    if (a.numFmtId) custom.set(Number(a.numFmtId), a.formatCode ?? '')
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? ''
  const dateStyle = [...xfs.matchAll(/<xf\b[^>]*>/g)].map((m) => {
    const id = Number(attrs(m[0]).numFmtId ?? 0)
    return DATE_IDS.has(id) || (custom.has(id) && isDateFormat(custom.get(id)!))
  })

  const sheets: Sheet[] = []
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const a = attrs(m[0])
    // The relationship id is r:id in every file we've seen; match any prefix in case a writer picked another.
    const rid = a['r:id'] ?? Object.entries(a).find(([k]) => k.endsWith(':id'))?.[1]
    const path = rid ? rels.get(rid) : undefined
    const body = path ? xml(path) : undefined
    if (!body) continue
    const rows: string[][] = []
    for (const r of body.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rowNo = Number(attrs(r[1]!).r ?? rows.length + 1) - 1
      if (rowNo >= MAX_ROWS) throw new XlsxError(`The “${a.name}” sheet has too many rows.`)
      const row: string[] = []
      let next = 0
      for (const c of (r[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ca = attrs(c[1]!)
        const col = ca.r ? colIndex(ca.r) : next
        next = col + 1
        if (col >= MAX_COLS) continue
        const inner = c[2] ?? ''
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1]
        let val = ''
        if (ca.t === 's') val = v !== undefined ? (shared[Number(v)] ?? '') : ''
        else if (ca.t === 'inlineStr') val = richText(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? '')
        else if (ca.t === 'str') val = v !== undefined ? text(v) : ''
        else if (ca.t === 'b') val = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : ''
        else if (ca.t === 'e') val = ''
        else if (v !== undefined) {
          val = text(v)
          if (ca.s && dateStyle[Number(ca.s)]) val = serialDate(Number(val), date1904) ?? val
        }
        while (row.length < col) row.push('')
        row[col] = val
      }
      while (rows.length < rowNo) rows.push([])
      rows[rowNo] = row
    }
    sheets.push({ name: a.name ?? `Sheet${sheets.length + 1}`, rows })
  }
  if (!sheets.length) throw new XlsxError('That workbook has no sheets.')
  return sheets
}
