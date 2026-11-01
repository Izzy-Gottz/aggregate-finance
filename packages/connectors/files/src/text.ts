// Byte → text decoding for statement files. Banks export UTF-8 (often with a BOM), UTF-16 (Excel "Unicode text"),
// or Windows-1252 / Latin-1 (most German and older US exports). We never guess silently: a fallback adds a warning.

import { createHash } from 'node:crypto'
import { ConnectorError } from '@agfn/connector-sdk'

export const PROVIDER = 'files'

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

export function invalid(message: string, code?: string): ConnectorError {
  return new ConnectorError('invalid_input', message, { provider: PROVIDER, ...(code ? { code } : {}) })
}

export interface DecodedText {
  text: string
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252'
  warnings: string[]
}

/** Decode a text file. `declared` (e.g. OFX CHARSET:1252) wins over sniffing when no BOM is present. */
export function decodeText(bytes: Uint8Array, declared?: DecodedText['encoding']): DecodedText {
  const warnings: string[] = []
  let text: string
  let encoding: DecodedText['encoding']
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = 'utf-8'
    text = new TextDecoder('utf-8').decode(bytes.subarray(3))
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le'
    text = new TextDecoder('utf-16le').decode(bytes.subarray(2))
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be'
    text = new TextDecoder('utf-16be').decode(bytes.subarray(2))
  } else if (declared === 'windows-1252') {
    encoding = 'windows-1252'
    text = new TextDecoder('windows-1252').decode(bytes)
  } else {
    try {
      encoding = 'utf-8'
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      encoding = 'windows-1252'
      text = new TextDecoder('windows-1252').decode(bytes)
      warnings.push('file is not valid UTF-8; decoded as Windows-1252')
    }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  if (text.includes('\u0000')) throw invalid('file looks binary, not a text statement', 'binary_file')
  return { text, encoding, warnings }
}

/** Lowercase, strip accents and quotes, collapse whitespace: "Währung " → "wahrung". */
export function normalizeLabel(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/["'‘’“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
