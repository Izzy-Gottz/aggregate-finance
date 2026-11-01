import { createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { Transform } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { realpathSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

/**
 * Envelope encryption for provider secrets (Plaid tokens, Stripe keys, OAuth refresh tokens).
 * Each value gets its own random data key (AES-256-GCM). The data key is wrapped with the master key, and both layers
 * are bound to context (workspace + connection + purpose) as additional authenticated data, so a ciphertext copied
 * to another row fails to decrypt. The master key lives outside the data volume (MASTER.md §9).
 */

const VERSION = 'v1'

export interface MasterKey {
  id: string
  key: Buffer
}

export interface KeyRing {
  /** Key used for new encryptions. */
  current: MasterKey
  /** All keys that may decrypt (current + retired), by id. */
  byId: Map<string, MasterKey>
}

export interface EncryptionContext {
  workspaceId: string
  /** e.g. connection id. */
  recordId: string
  purpose: string
}

function aad(ctx: EncryptionContext): Buffer {
  return Buffer.from(`${VERSION}|${ctx.workspaceId}|${ctx.recordId}|${ctx.purpose}`, 'utf8')
}

function gcmEncrypt(key: Buffer, plaintext: Buffer, ad: Buffer): Buffer {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(ad)
  const body = Buffer.concat([c.update(plaintext), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), body])
}

function gcmDecrypt(key: Buffer, blob: Buffer, ad: Buffer): Buffer {
  if (blob.length < 28) throw new Error('ciphertext too short')
  const iv = blob.subarray(0, 12)
  const tag = blob.subarray(12, 28)
  const body = blob.subarray(28)
  const d = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
  d.setAAD(ad)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(body), d.final()])
}

/** Encrypts any JSON-serializable value. Output: "v1.<keyId>.<wrappedDataKey b64url>.<payload b64url>". */
export function seal(ring: KeyRing, value: unknown, ctx: EncryptionContext): string {
  const dataKey = randomBytes(32)
  const ad = aad(ctx)
  const wrapped = gcmEncrypt(ring.current.key, dataKey, ad)
  const payload = gcmEncrypt(dataKey, Buffer.from(JSON.stringify(value), 'utf8'), ad)
  dataKey.fill(0)
  return [VERSION, ring.current.id, wrapped.toString('base64url'), payload.toString('base64url')].join('.')
}

export function unseal<T = unknown>(ring: KeyRing, sealed: string, ctx: EncryptionContext): T {
  const parts = sealed.split('.')
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('unrecognized sealed format')
  const [, keyId, wrappedB64, payloadB64] = parts as [string, string, string, string]
  const master = ring.byId.get(keyId)
  if (!master) throw new Error(`unknown master key id ${keyId}`)
  const ad = aad(ctx)
  const dataKey = gcmDecrypt(master.key, Buffer.from(wrappedB64, 'base64url'), ad)
  try {
    return JSON.parse(gcmDecrypt(dataKey, Buffer.from(payloadB64, 'base64url'), ad).toString('utf8')) as T
  } finally {
    dataKey.fill(0)
  }
}

/** Re-wraps under the current master key (key rotation). The payload's data key is reused only in memory. */
export function reseal(ring: KeyRing, sealed: string, ctx: EncryptionContext): string {
  return seal(ring, unseal(ring, sealed, ctx), ctx)
}

function parseKey(raw: string): Buffer {
  const trimmed = raw.trim()
  const buf = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, 'hex') : Buffer.from(trimmed, 'base64')
  if (buf.length !== 32) throw new Error('master key must be 32 bytes (64 hex chars or base64)')
  return buf
}

const BYTES_MAGIC = Buffer.from('AGFNENC1', 'ascii')

/**
 * Binary envelope encryption for large blobs (backups): a fresh AES-256-GCM data key per blob, wrapped with the
 * master key, both bound to `ctx`. Layout: magic(8) | keyId length(1) | keyId | wrapped length(2) | wrapped | payload.
 */
export function sealBytes(ring: KeyRing, bytes: Uint8Array, ctx: EncryptionContext): Buffer {
  const dataKey = randomBytes(32)
  const ad = aad(ctx)
  const wrapped = gcmEncrypt(ring.current.key, dataKey, ad)
  const id = Buffer.from(ring.current.id, 'utf8')
  const head = Buffer.alloc(BYTES_MAGIC.length + 1 + id.length + 2)
  BYTES_MAGIC.copy(head, 0)
  head.writeUInt8(id.length, BYTES_MAGIC.length)
  id.copy(head, BYTES_MAGIC.length + 1)
  head.writeUInt16BE(wrapped.length, BYTES_MAGIC.length + 1 + id.length)
  return Buffer.concat([head, wrapped, gcmEncrypt(dataKey, Buffer.from(bytes), ad)])
}

export function unsealBytes(ring: KeyRing, blob: Uint8Array, ctx: EncryptionContext): Buffer {
  const b = Buffer.from(blob)
  if (b.length < BYTES_MAGIC.length + 3 || !b.subarray(0, BYTES_MAGIC.length).equals(BYTES_MAGIC)) throw new Error('not an Aggregate encrypted file')
  let o = BYTES_MAGIC.length
  const idLen = b.readUInt8(o)
  o += 1
  const id = b.subarray(o, o + idLen).toString('utf8')
  o += idLen
  const wLen = b.readUInt16BE(o)
  o += 2
  const key = ring.byId.get(id)
  if (!key) throw new Error(`encrypted with master key ${id}, which is not loaded (set it in AGFN_OLD_MASTER_KEYS)`)
  const ad = aad(ctx)
  const dataKey = gcmDecrypt(key.key, b.subarray(o, o + wLen), ad)
  return gcmDecrypt(dataKey, b.subarray(o + wLen), ad)
}

const STREAM_MAGIC = Buffer.from('AGFNENC2', 'ascii')
/** Plaintext per sealed chunk: memory stays this size whatever the payload's. */
export const SEAL_CHUNK = 1 << 20

/**
 * Streaming envelope encryption for payloads too large to hold (backups). Same key handling as sealBytes (a fresh data
 * key wrapped with the master key, bound to `ctx`); the payload is cut into chunks, each its own AES-256-GCM frame
 * whose associated data also binds its index and whether it is the last, so frames can't be reordered, dropped or cut
 * off. Layout: magic(8) | keyId length(1) | keyId | wrapped length(2) | wrapped, then frames of
 * length(4) | last(1) | iv(12) | tag(16) | ciphertext.
 */
export function sealStream(ring: KeyRing, ctx: EncryptionContext, chunk = SEAL_CHUNK): Transform {
  const dataKey = randomBytes(32)
  const ad = aad(ctx)
  const wrapped = gcmEncrypt(ring.current.key, dataKey, ad)
  const id = Buffer.from(ring.current.id, 'utf8')
  const head = Buffer.alloc(STREAM_MAGIC.length + 1 + id.length + 2)
  STREAM_MAGIC.copy(head, 0)
  head.writeUInt8(id.length, STREAM_MAGIC.length)
  id.copy(head, STREAM_MAGIC.length + 1)
  head.writeUInt16BE(wrapped.length, STREAM_MAGIC.length + 1 + id.length)
  let index = 0
  let pending: Buffer[] = []
  let size = 0
  const frame = (plain: Buffer, last: boolean): Buffer => {
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', dataKey, iv)
    c.setAAD(Buffer.concat([ad, Buffer.from(`|${index++}|${last ? 1 : 0}`, 'utf8')]))
    const body = Buffer.concat([c.update(plain), c.final()])
    const pre = Buffer.alloc(5)
    pre.writeUInt32BE(body.length, 0)
    pre.writeUInt8(last ? 1 : 0, 4)
    return Buffer.concat([pre, iv, c.getAuthTag(), body])
  }
  let started = false
  return new Transform({
    transform(data: Buffer, _enc, done) {
      if (!started) {
        this.push(Buffer.concat([head, wrapped]))
        started = true
      }
      pending.push(data)
      size += data.length
      while (size >= chunk) {
        const all = Buffer.concat(pending)
        this.push(frame(all.subarray(0, chunk), false))
        pending = [all.subarray(chunk)]
        size -= chunk
      }
      done()
    },
    flush(done) {
      if (!started) this.push(Buffer.concat([head, wrapped]))
      this.push(frame(Buffer.concat(pending), true))
      pending = []
      done()
    },
  })
}

/** Whether a blob was sealed by sealStream (else sealBytes). */
export function isStreamSealed(blob: Uint8Array): boolean {
  return blob.length >= STREAM_MAGIC.length && Buffer.from(blob.subarray(0, STREAM_MAGIC.length)).equals(STREAM_MAGIC)
}

/** Opens what sealStream wrote, one frame at a time; `onChunk` gets each plaintext chunk in order. */
export function unsealStream(ring: KeyRing, blob: Uint8Array, ctx: EncryptionContext, onChunk: (plain: Buffer) => void): void {
  const b = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength)
  if (!isStreamSealed(b)) throw new Error('not an Aggregate streamed encrypted file')
  let o = STREAM_MAGIC.length
  const idLen = b.readUInt8(o)
  o += 1
  const id = b.subarray(o, o + idLen).toString('utf8')
  o += idLen
  const wLen = b.readUInt16BE(o)
  o += 2
  const key = ring.byId.get(id)
  if (!key) throw new Error(`encrypted with master key ${id}, which is not loaded (set it in AGFN_OLD_MASTER_KEYS)`)
  const ad = aad(ctx)
  const dataKey = gcmDecrypt(key.key, b.subarray(o, o + wLen), ad)
  o += wLen
  let index = 0
  for (;;) {
    if (o + 33 > b.length) throw new Error('encrypted file is truncated')
    const len = b.readUInt32BE(o)
    const last = b.readUInt8(o + 4) === 1
    const iv = b.subarray(o + 5, o + 17)
    const tag = b.subarray(o + 17, o + 33)
    const body = b.subarray(o + 33, o + 33 + len)
    if (body.length !== len) throw new Error('encrypted file is truncated')
    const d = createDecipheriv('aes-256-gcm', dataKey, iv, { authTagLength: 16 })
    d.setAAD(Buffer.concat([ad, Buffer.from(`|${index++}|${last ? 1 : 0}`, 'utf8')]))
    d.setAuthTag(tag)
    onChunk(Buffer.concat([d.update(body), d.final()]))
    o += 33 + len
    if (last) {
      if (o !== b.length) throw new Error('encrypted file has data after its end')
      return
    }
  }
}

export function keyIdFor(key: Buffer): string {
  return createHash('sha256').update(key).digest('base64url').slice(0, 8)
}

function isInside(child: string, parent: string): boolean {
  const c = resolve(child) + sep
  const p = resolve(parent) + sep
  return c.startsWith(p)
}

/**
 * Split a command line into argv without a shell: whitespace separates, single or double quotes group, backslash
 * escapes the next character outside single quotes. No variables, globs, pipes or redirects.
 */
export function splitArgv(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let has = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i]
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (ch === '\\' && i + 1 < line.length) {
      cur += line[++i]
      has = true
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur)
      cur = ''
      has = false
    } else cur += ch
  }
  if (quote) throw new Error('AGFN_MASTER_KEY_COMMAND has an unclosed quote')
  if (has || cur) out.push(cur)
  return out
}

export const KEY_COMMAND_TIMEOUT_MS = 10_000

/**
 * Run AGFN_MASTER_KEY_COMMAND once (no shell) and return its stdout. The output is the key, so it is never logged or
 * included in errors; only the exit status and the start of stderr are.
 */
function keyFromCommand(line: string, env: NodeJS.ProcessEnv): string {
  const [cmd, ...args] = splitArgv(line)
  if (!cmd) throw new Error('AGFN_MASTER_KEY_COMMAND is empty')
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: KEY_COMMAND_TIMEOUT_MS, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env, windowsHide: true })
  } catch (err) {
    const e = err as { code?: string; status?: number | null; signal?: string | null; stderr?: string }
    const why = e.code === 'ENOENT' ? `"${cmd}" was not found` : e.signal === 'SIGTERM' ? `it did not finish within ${KEY_COMMAND_TIMEOUT_MS / 1000}s` : `it exited with status ${e.status ?? e.code ?? 'unknown'}`
    const stderr = typeof e.stderr === 'string' && e.stderr.trim() ? `: ${e.stderr.trim().slice(0, 300)}` : ''
    throw new Error(`AGFN_MASTER_KEY_COMMAND failed: ${why}${stderr}`)
  }
}

/**
 * Loads the key ring from the environment. The current key comes from exactly one of:
 *  AGFN_MASTER_KEY_FILE (a file), AGFN_MASTER_KEY_COMMAND (stdout of a command run once at boot, e.g. a KMS decrypt),
 *  or AGFN_MASTER_KEY (the value). AGFN_OLD_MASTER_KEYS (comma-separated) holds old keys during rotation.
 * Refuses a key file stored inside the data directory: a stolen backup of /data must never contain the key.
 */
export function loadKeyRing(env: NodeJS.ProcessEnv = process.env, dataDir?: string): KeyRing {
  const file = env.AGFN_MASTER_KEY_FILE?.trim() || undefined
  const command = env.AGFN_MASTER_KEY_COMMAND?.trim() || undefined
  const value = env.AGFN_MASTER_KEY?.trim() || undefined
  const set = [file && 'AGFN_MASTER_KEY_FILE', command && 'AGFN_MASTER_KEY_COMMAND', value && 'AGFN_MASTER_KEY'].filter(Boolean)
  if (set.length > 1) throw new Error(`Set only one master key source; found ${set.join(' and ')}. Remove the others and start again.`)
  let raw: string | undefined
  if (file) {
    if (dataDir) {
      let real = file
      try {
        real = realpathSync(file)
      } catch {
        /* reported by readFileSync below */
      }
      let realData = dataDir
      try {
        realData = realpathSync(dataDir)
      } catch {
        /* data dir may not exist yet */
      }
      if (isInside(real, realData) || isInside(file, dataDir)) throw new Error('AGFN_MASTER_KEY_FILE must not be inside the data directory')
    }
    raw = readFileSync(file, 'utf8')
  } else if (command) {
    raw = keyFromCommand(command, env)
    if (!raw.trim()) throw new Error('AGFN_MASTER_KEY_COMMAND printed nothing; it must print the base64 master key')
  } else raw = value
  if (!raw) throw new Error('No master key: set AGFN_MASTER_KEY, AGFN_MASTER_KEY_FILE or AGFN_MASTER_KEY_COMMAND (generate a key with `npm run keygen`)')
  const current = parseKey(raw)
  const ring: KeyRing = { current: { id: keyIdFor(current), key: current }, byId: new Map() }
  ring.byId.set(ring.current.id, ring.current)
  for (const old of (env.AGFN_OLD_MASTER_KEYS ?? '').split(',').filter(Boolean)) {
    const k = parseKey(old)
    ring.byId.set(keyIdFor(k), { id: keyIdFor(k), key: k })
  }
  return ring
}

export function generateMasterKey(): string {
  return randomBytes(32).toString('base64')
}

/** Constant-time string comparison for tokens and hashes. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}
