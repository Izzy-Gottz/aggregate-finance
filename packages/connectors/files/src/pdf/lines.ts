// A PDF's text layer is loose runs of text at x/y positions. Statements are tables, so we rebuild lines (runs on the
// same baseline) and cells (runs separated by a column gap), which is what both an AI reading the text and the
// layout parsers need. Pure: no PDF library here.

/** One run of text as the PDF placed it (PDF space: y grows upward). */
export interface PdfRun {
  page: number
  x: number
  y: number
  width: number
  /** Font size in PDF units. */
  height: number
  text: string
}

export interface PdfCell {
  x: number
  text: string
}

export interface PdfLine {
  page: number
  y: number
  cells: PdfCell[]
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

/** Group runs into lines (top to bottom, page by page) and each line into cells (left to right). */
export function toLines(runs: PdfRun[]): PdfLine[] {
  const out: PdfLine[] = []
  const pages = [...new Set(runs.map((r) => r.page))].sort((a, b) => a - b)
  for (const page of pages) {
    const onPage = runs.filter((r) => r.page === page && r.text.trim() !== '')
    const h = median(onPage.map((r) => r.height).filter((v) => v > 0)) || 10
    // Top of the page first; runs within half a line height of a line's baseline belong to it.
    const sorted = [...onPage].sort((a, b) => b.y - a.y || a.x - b.x)
    const groups: PdfRun[][] = []
    for (const r of sorted) {
      const g = groups[groups.length - 1]
      if (g && Math.abs(g[0]!.y - r.y) <= h * 0.5) g.push(r)
      else groups.push([r])
    }
    for (const g of groups) {
      g.sort((a, b) => a.x - b.x)
      const cells: PdfCell[] = []
      let end = -Infinity
      for (const r of g) {
        const gap = r.x - end
        const last = cells[cells.length - 1]
        // A gap wider than about one character starts a new column; a small one is a space inside the same cell.
        if (last && gap < h * 0.9) last.text += (gap > h * 0.15 && !last.text.endsWith(' ') && !r.text.startsWith(' ') ? ' ' : '') + r.text
        else cells.push({ x: r.x, text: r.text })
        end = Math.max(end, r.x + Math.max(r.width, 0))
      }
      const clean = cells.map((c) => ({ x: Math.round(c.x * 10) / 10, text: c.text.replace(/\s+/g, ' ').trim() })).filter((c) => c.text)
      if (clean.length) out.push({ page, y: Math.round(g[0]!.y * 10) / 10, cells: clean })
    }
  }
  return out
}

/** Lines as plain text: cells two spaces apart, a blank line between pages. Capped at `max` characters. */
export function linesToText(lines: PdfLine[], max: number): { text: string; truncated: boolean } {
  const parts: string[] = []
  let len = 0
  let page = lines[0]?.page
  for (const l of lines) {
    const row = (l.page !== page ? '\n' : '') + l.cells.map((c) => c.text).join('  ')
    page = l.page
    if (len + row.length + 1 > max) return { text: parts.join('\n'), truncated: true }
    parts.push(row)
    len += row.length + 1
  }
  return { text: parts.join('\n'), truncated: false }
}
