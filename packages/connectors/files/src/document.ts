// PDF and image statements are NOT parsed here. We validate them by magic bytes and hand back a descriptor; the
// platform stores the file as an unread document that the person's own AI reads through MCP.

import { invalid, sha256Hex } from './text.ts'

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024

export type DocumentMime = 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/heic' | 'image/heif'

export interface DocumentDescriptor {
  sha256: string
  mime: DocumentMime
  size: number
  filename: string
  kind: 'statement'
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'])
const HEIF_BRANDS = new Set(['mif1', 'msf1'])

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x)
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to))

/** The document type from magic bytes, or undefined when it isn't a PDF/PNG/JPEG/HEIC/HEIF. */
export function sniffDocument(bytes: Uint8Array): DocumentMime | undefined {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf' // %PDF-
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12)
    if (HEIC_BRANDS.has(brand)) return 'image/heic'
    if (HEIF_BRANDS.has(brand)) return 'image/heif'
  }
  return undefined
}

/** Validate a PDF/image statement and describe it for storage. Anything else throws invalid_input. */
export function ingestDocument(bytes: Uint8Array, filename: string): DocumentDescriptor {
  if (!bytes.length) throw invalid('file is empty', 'empty_file')
  if (bytes.length > MAX_DOCUMENT_BYTES) throw invalid('document is larger than 25 MB', 'file_too_large')
  const mime = sniffDocument(bytes)
  if (!mime) throw invalid(`${filename || 'file'} is not a PDF, PNG, JPEG or HEIC document`, 'unsupported_document')
  return { sha256: sha256Hex(bytes), mime, size: bytes.length, filename, kind: 'statement' }
}
