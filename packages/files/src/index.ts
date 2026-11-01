import { mkdir, readFile, rm, writeFile, rename } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'

/** Where uploaded files live. Local disk for self-host; S3/R2 for hosted (same interface). */
export interface FileStore {
  put(key: string, bytes: Uint8Array): Promise<void>
  get(key: string): Promise<Uint8Array | null>
  delete(key: string): Promise<void>
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,250}$/

export function assertKey(key: string): void {
  if (!KEY.test(key) || key.includes('..') || key.includes('//')) throw new Error(`invalid file key: ${key}`)
}

export class LocalFileStore implements FileStore {
  private root: string
  constructor(root: string) {
    this.root = resolve(root)
  }

  private path(key: string): string {
    assertKey(key)
    const p = resolve(join(this.root, key))
    if (!p.startsWith(this.root + sep)) throw new Error('file key escapes the store')
    return p
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const p = this.path(key)
    await mkdir(dirname(p), { recursive: true })
    // Write then rename so a crash never leaves a half-written file under the final name.
    const tmp = `${p}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(tmp, bytes, { mode: 0o600 })
    await rename(tmp, p)
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.path(key)))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true })
  }
}

export class MemoryFileStore implements FileStore {
  readonly files = new Map<string, Uint8Array>()
  async put(key: string, bytes: Uint8Array): Promise<void> {
    assertKey(key)
    this.files.set(key, bytes)
  }
  async get(key: string): Promise<Uint8Array | null> {
    return this.files.get(key) ?? null
  }
  async delete(key: string): Promise<void> {
    this.files.delete(key)
  }
}

/** Accepted upload types, by extension and sniffed magic bytes (never trust the browser's content-type alone). */
export type FileKind = 'csv' | 'ofx' | 'qfx' | 'qbo' | 'xml' | 'pdf' | 'png' | 'jpeg' | 'heic' | 'webp'

export function sniffKind(name: string, bytes: Uint8Array): FileKind | null {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  const head = Buffer.from(bytes.subarray(0, 16))
  if (head.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf'
  if (head[0] === 0x89 && head.subarray(1, 4).toString('latin1') === 'PNG') return 'png'
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg'
  if (head.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|hevc|mif1)/.test(head.subarray(8, 12).toString('latin1'))) return 'heic'
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  // Text formats: must be valid UTF-8 without NUL bytes.
  if (bytes.subarray(0, 4096).includes(0)) return null
  // QBO is QuickBooks Web Connect: OFX with Intuit's header, which most US banks offer as a download.
  if (ext === 'ofx' || ext === 'qfx' || ext === 'qbo') return ext
  // ISO 20022 bank statements (camt.053/052) only: any other XML (SVG, XHTML, feeds) stays out, whatever its name.
  if (ext === 'xml') {
    const head = Buffer.from(bytes.subarray(0, 4096)).toString('utf8')
    return /<(\w+:)?Document[\s>]/.test(head) && /camt\.05[23]|BkToCstmr(Stmt|AcctRpt)/.test(head) && !/<(\w+:)?(svg|html|script)[\s>]/i.test(head) ? 'xml' : null
  }
  if (ext === 'csv' || ext === 'txt') return 'csv'
  return null
}

export const MIME: Record<FileKind, string> = {
  csv: 'text/csv',
  ofx: 'application/x-ofx',
  qfx: 'application/x-qfx',
  qbo: 'application/vnd.intu.qbo',
  xml: 'application/xml',
  pdf: 'application/pdf',
  png: 'image/png',
  jpeg: 'image/jpeg',
  heic: 'image/heic',
  webp: 'image/webp',
}
export { S3FileStore, s3ConfigFromEnv, signV4, type S3Config } from './s3.ts'
