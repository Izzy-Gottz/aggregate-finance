import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFileStore, sniffKind } from './index.ts'

describe('files', () => {
  it('stores and reads files and refuses path escapes', async () => {
    const s = new LocalFileStore(mkdtempSync(join(tmpdir(), 'agfn-files-')))
    await s.put('ws1/abc.csv', new TextEncoder().encode('a,b'))
    expect(new TextDecoder().decode((await s.get('ws1/abc.csv'))!)).toBe('a,b')
    expect(await s.get('ws1/missing')).toBeNull()
    await expect(s.put('../evil', new Uint8Array())).rejects.toThrow()
    await expect(s.put('/etc/passwd', new Uint8Array())).rejects.toThrow()
    await s.delete('ws1/abc.csv')
    expect(await s.get('ws1/abc.csv')).toBeNull()
  })

  it('sniffs real file types, not just names', () => {
    expect(sniffKind('x.pdf', new TextEncoder().encode('%PDF-1.7'))).toBe('pdf')
    expect(sniffKind('statement.csv', new TextEncoder().encode('date,amount\n'))).toBe('csv')
    expect(sniffKind('photo.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg')
    expect(sniffKind('evil.csv', new Uint8Array([0x4d, 0x5a, 0, 0]))).toBeNull()
    expect(sniffKind('page.html', new TextEncoder().encode('<html>'))).toBeNull()
  })
})
