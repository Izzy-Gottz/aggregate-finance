import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractPdfText } from './extract.ts'
import { linesToText, toLines } from './lines.ts'
import { makePdf } from './test-kit.ts'

const enc = (s: string) => new TextEncoder().encode(s)

describe('PDF text layer', () => {
  it('rebuilds lines and columns from positioned text', async () => {
    const pdf = makePdf({
      pages: [
        {
          texts: [
            { x: 50, y: 740, text: 'Sample Bank', size: 14 },
            { x: 50, y: 700, text: 'DATE' },
            { x: 120, y: 700, text: 'DESCRIPTION' },
            { x: 480, y: 700, text: 'AMOUNT' },
            { x: 50, y: 685, text: '09/03' },
            { x: 120, y: 685, text: 'Coffee' },
            { x: 151, y: 685, text: 'Shop' },
            { x: 480, y: 685, text: '-4.50' },
          ],
        },
        { texts: [{ x: 50, y: 740, text: 'Page two' }] },
      ],
    })
    const r = await extractPdfText(pdf)
    expect(r.status).toBe('text')
    if (r.status !== 'text') return
    expect(r.pages).toBe(2)
    const row = r.lines.find((l) => l.cells[0]?.text === '09/03')!
    expect(row.cells.map((c) => c.text)).toEqual(['09/03', 'Coffee Shop', '-4.50'])
    expect(r.text).toContain('09/03  Coffee Shop  -4.50')
    expect(r.text).toContain('\n\nPage two')
  }, 30_000)

  it('a scan has no text layer; a locked PDF is told apart; junk is unreadable', async () => {
    expect((await extractPdfText(makePdf({ pages: [{ imageOnly: true }] }))).status).toBe('scanned')
    expect((await extractPdfText(makePdf({ pages: [{ texts: [{ x: 50, y: 700, text: 'secret' }] }], userPassword: 'hunter2' }))).status).toBe('locked')
    expect((await extractPdfText(enc('%PDF-1.4\nnot really a pdf'))).status).toBe('unreadable')
  }, 30_000)

  it('caps pages and text, and a worker that runs too long is stopped', async () => {
    const many = makePdf({ pages: Array.from({ length: 5 }, (_, i) => ({ texts: [{ x: 50, y: 700, text: `Page ${i + 1}` }] })) })
    const r = await extractPdfText(many, { maxPages: 2 })
    expect(r.status === 'text' && [r.pages, r.truncated, r.text.includes('Page 3')]).toEqual([5, true, false])
    const t = await extractPdfText(many, { timeoutMs: 1 })
    expect(t).toEqual({ status: 'unreadable', reason: 'too complex to read' })
  }, 30_000)

  it('a FontMatrix that smuggles code (CVE-2024-4367 shape) runs nothing', async () => {
    const marker = join(tmpdir(), `agfn-pdf-pwned-${process.pid}`)
    rmSync(marker, { force: true })
    const payload = `(1\\); process.getBuiltinModule\\('fs'\\).writeFileSync\\('${marker}', 'x'\\); //)`
    const hostile = [
      // Type1 font dictionary with an injected FontMatrix entry.
      `<< /Type /Font /Subtype /Type1 /BaseFont /Evil /FontMatrix [0.001 0 0 0.001 0 ${payload}] /FirstChar 32 /LastChar 126 /Widths [] >>`,
      // Type3 font (its FontMatrix is required and read from the PDF itself).
      `<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 ${payload}] /CharProcs << /a {n} 0 R >> /Encoding << /Type /Encoding /Differences [97 /a] >> /FirstChar 97 /LastChar 97 /Widths [1000] /Resources << >> >>`,
    ]
    for (const fontDict of hostile) {
      const pdf = makePdf({ pages: [{ texts: [{ x: 50, y: 700, text: 'aaa' }] }], fontDict, extraObjects: ['<< /Length 20 >>\nstream\n1000 0 0 0 750 750 d1\nendstream'] })
      const r = await extractPdfText(pdf)
      expect(['text', 'scanned', 'unreadable']).toContain(r.status)
    }
    expect(existsSync(marker)).toBe(false)
  }, 30_000)

  it('lines: wrapped columns, page breaks and the text cap', () => {
    const lines = toLines([
      { page: 1, x: 300, y: 500, width: 30, height: 10, text: '12.00' },
      { page: 1, x: 50, y: 500.3, width: 30, height: 10, text: '01/02' },
      { page: 1, x: 50, y: 480, width: 30, height: 10, text: 'next' },
      { page: 2, x: 50, y: 700, width: 30, height: 10, text: 'p2' },
    ])
    expect(lines.map((l) => [l.page, l.cells.map((c) => c.text).join('|')])).toEqual([[1, '01/02|12.00'], [1, 'next'], [2, 'p2']])
    expect(linesToText(lines, 15)).toEqual({ text: '01/02  12.00', truncated: true })
  })
})
