// Minimal ZIP reader for Google Play report archives (one CSV inside). Reads the central directory from the
// End Of Central Directory record, then each entry's local header; supports stored (0) and deflate (8) entries.
// Not supported (throws invalid_input): ZIP64, encryption, multi-disk archives, other compression methods.

import { inflateRawSync } from 'node:zlib'
import { ConnectorError } from '@agfn/connector-sdk'

export interface ZipEntry {
  name: string
  data: Buffer
}

const EOCD = 0x06054b50
const CEN = 0x02014b50
const LOC = 0x04034b50

function bad(msg: string): ConnectorError {
  return new ConnectorError('invalid_input', `unreadable ZIP: ${msg}`, { provider: 'googleplay' })
}

export function readZip(input: Uint8Array): ZipEntry[] {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (buf.length < 22) throw bad('too short')
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw bad('no end of central directory')
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) throw bad('multi-disk archives are not supported')
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw bad('ZIP64 is not supported')
  if (cdOffset + cdSize > eocd) throw bad('central directory out of range')

  const out: ZipEntry[] = []
  let p = cdOffset
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN) throw bad('bad central directory entry')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    if (flags & 0x1) throw bad('encrypted entries are not supported')
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOC) throw bad('bad local header')
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    if (start + compSize > buf.length) throw bad('entry out of range')
    const raw = buf.subarray(start, start + compSize)
    let data: Buffer
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) {
      try {
        data = inflateRawSync(raw)
      } catch (e) {
        throw new ConnectorError('invalid_input', 'unreadable ZIP: bad deflate data', { provider: 'googleplay', cause: e })
      }
    } else throw bad(`compression method ${method} is not supported`)
    if (data.length !== size) throw bad('size mismatch')
    out.push({ name, data })
  }
  return out
}
