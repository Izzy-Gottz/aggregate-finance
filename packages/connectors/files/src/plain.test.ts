// Every reason a statement file can fail reaches the person in plain words: what happened and what to do next, no
// parser codes or file-format internals. A new code thrown anywhere in the parsers must get its own message here.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { plainImportError } from './plain.ts'

const SRC = import.meta.dirname
const FALLBACK = plainImportError(undefined, '')

function thrownCodes(): string[] {
  const codes = new Set<string>()
  const walk = (dir: string) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (f.isDirectory()) walk(join(dir, f.name))
      else if (f.name.endsWith('.ts') && !f.name.endsWith('.test.ts')) {
        for (const m of readFileSync(join(dir, f.name), 'utf8').matchAll(/invalid\(\s*(?:`[^`]*`|'[^']*'|"[^"]*")\s*,\s*'([a-z_]+)'\s*,?\s*\)/g)) codes.add(m[1] as string)
      }
    }
  }
  walk(SRC)
  return [...codes].sort()
}

describe('plain import errors', () => {
  it('finds the parsers\' codes (the scan itself works)', () => {
    expect(thrownCodes()).toEqual(expect.arrayContaining(['ambiguous_amount', 'camt_malformed', 'csv_unterminated_quote', 'empty_file', 'needs_mapping', 'ofx_malformed', 'xml_doctype']))
  })

  it.each(thrownCodes())('%s has its own plain message', (code) => {
    const msg = plainImportError(code, `line 12: technical detail <OFX> CdtDbtInd ACCTID ${code}`)
    expect(msg).not.toBe(FALLBACK)
    // No internals: codes, tags, field names, or the parser's own words.
    expect(msg).not.toMatch(/_|<|>|CdtDbtInd|ACCTID|technical detail|mapping|ISO 20022/)
    // What to do next: every message ends with a sentence saying it.
    expect(msg.endsWith('.')).toBe(true)
    expect(msg.split(/\.\s+/).at(-1)).toMatch(/^(Download|Upload|Export|Ask your AI)/)
  })

  it('keeps the line number when the parser gave one', () => {
    expect(plainImportError('ambiguous_amount', 'line 48: amount "1.234,5" is ambiguous')).toContain('around line 48')
    expect(plainImportError('empty_file', 'file is empty')).not.toContain('line')
  })

  it('anything unknown still reads plainly', () => {
    expect(FALLBACK).toBe('We couldn’t read this file. Upload a CSV or PDF statement from your bank, or ask your AI to read it.')
  })
})
