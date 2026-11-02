import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateMasterKey, isStreamSealed, keyIdFor, loadKeyRing, reseal, seal, sealBytes, sealedKeyId, sealStream, unseal, unsealBytes, unsealStream, safeEqual, splitArgv } from './index.ts'

const ctx = { workspaceId: 'ws1', recordId: 'conn1', purpose: 'connection.secret' }

describe('envelope encryption', () => {
  const ring = loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() })

  it('round-trips values', () => {
    const s = seal(ring, { access_token: 'access-sandbox-123' }, ctx)
    expect(s).not.toContain('access-sandbox')
    expect(unseal(ring, s, ctx)).toEqual({ access_token: 'access-sandbox-123' })
  })

  it('fails when moved to another record or workspace', () => {
    const s = seal(ring, 'secret', ctx)
    expect(() => unseal(ring, s, { ...ctx, recordId: 'conn2' })).toThrow()
    expect(() => unseal(ring, s, { ...ctx, workspaceId: 'ws2' })).toThrow()
  })

  it('detects tampering', () => {
    const s = seal(ring, 'secret', ctx)
    const parts = s.split('.')
    const payload = Buffer.from(parts[3]!, 'base64url')
    payload[payload.length - 1] = (payload[payload.length - 1] ?? 0) ^ 1
    parts[3] = payload.toString('base64url')
    expect(() => unseal(ring, parts.join('.'), ctx)).toThrow()
  })

  it('rotates keys', () => {
    const oldKey = generateMasterKey()
    const oldRing = loadKeyRing({ AGFN_MASTER_KEY: oldKey })
    const s = seal(oldRing, 'secret', ctx)
    const newRing = loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey(), AGFN_OLD_MASTER_KEYS: oldKey })
    expect(unseal(newRing, s, ctx)).toBe('secret')
    const rotated = reseal(newRing, s, ctx)
    expect(rotated.split('.')[1]).toBe(newRing.current.id)
    expect(() => unseal(oldRing, rotated, ctx)).toThrow()
  })

  it('refuses a key file inside the data directory and a missing key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agfn-'))
    const f = join(dir, 'master.key')
    writeFileSync(f, generateMasterKey())
    expect(() => loadKeyRing({ AGFN_MASTER_KEY_FILE: f }, dir)).toThrow(/data directory/)
    expect(loadKeyRing({ AGFN_MASTER_KEY_FILE: f }, join(tmpdir(), 'elsewhere-x')).current.key).toHaveLength(32)
    expect(() => loadKeyRing({})).toThrow(/No master key/)
  })

  it('compares in constant time', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'ab')).toBe(false)
  })
})

describe('master key from a command (KMS, 1Password)', () => {
  const node = JSON.stringify(process.execPath)
  const dir = mkdtempSync(join(tmpdir(), 'agfn-keycmd-'))

  it('runs the command once without a shell and uses its stdout', () => {
    const key = generateMasterKey()
    const script = join(dir, 'print-key.mjs')
    writeFileSync(script, `process.stdout.write(${JSON.stringify(key + '\n')})`)
    const ring = loadKeyRing({ AGFN_MASTER_KEY_COMMAND: `${node} ${JSON.stringify(script)}` })
    expect(ring.current.id).toBe(keyIdFor(Buffer.from(key, 'base64')))
    // No shell: metacharacters are plain arguments, so nothing after them runs.
    const marker = join(dir, 'pwned')
    expect(() => loadKeyRing({ AGFN_MASTER_KEY_COMMAND: `${node} ${JSON.stringify(script)} ; touch ${marker}` })).not.toThrow()
    expect(existsSync(marker)).toBe(false)
  })

  it('refuses more than one source, with a plain error', () => {
    const k = generateMasterKey()
    expect(() => loadKeyRing({ AGFN_MASTER_KEY: k, AGFN_MASTER_KEY_COMMAND: 'x' })).toThrow(/only one master key source.*AGFN_MASTER_KEY_COMMAND and AGFN_MASTER_KEY/)
    expect(() => loadKeyRing({ AGFN_MASTER_KEY_FILE: '/x', AGFN_MASTER_KEY: k })).toThrow(/AGFN_MASTER_KEY_FILE and AGFN_MASTER_KEY/)
    // Empty values (as .env templates write them) do not count.
    expect(loadKeyRing({ AGFN_MASTER_KEY: k, AGFN_MASTER_KEY_COMMAND: '  ', AGFN_MASTER_KEY_FILE: '' }).current.key).toHaveLength(32)
  })

  it('reports failures without the output, and times out', () => {
    const secretish = join(dir, 'bad.mjs')
    writeFileSync(secretish, 'process.stdout.write("TOPSECRET-not-a-key"); process.stderr.write("access denied"); process.exit(3)')
    let msg = ''
    try {
      loadKeyRing({ AGFN_MASTER_KEY_COMMAND: `${node} ${JSON.stringify(secretish)}` })
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toMatch(/status 3: access denied/)
    expect(msg).not.toContain('TOPSECRET')
    const wrong = join(dir, 'wrong.mjs')
    writeFileSync(wrong, 'process.stdout.write("TOPSECRET-not-a-key")')
    try {
      loadKeyRing({ AGFN_MASTER_KEY_COMMAND: `${node} ${JSON.stringify(wrong)}` })
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toMatch(/32 bytes/)
    expect(msg).not.toContain('TOPSECRET')
    expect(() => loadKeyRing({ AGFN_MASTER_KEY_COMMAND: '/definitely/not/here --x' })).toThrow(/was not found/)
    const slow = join(dir, 'slow.mjs')
    writeFileSync(slow, 'setTimeout(() => {}, 60000)')
    expect(() => loadKeyRing({ AGFN_MASTER_KEY_COMMAND: `${node} ${JSON.stringify(slow)}` })).toThrow(/within 10s/)
  }, 20_000)

  it('splits argv with quotes and escapes', () => {
    expect(splitArgv(`aws kms decrypt --ciphertext-blob "fileb:///run/my key.enc" --output text`)).toEqual(['aws', 'kms', 'decrypt', '--ciphertext-blob', 'fileb:///run/my key.enc', '--output', 'text'])
    expect(splitArgv(`op read 'op://Prod/Aggregate/master key'`)).toEqual(['op', 'read', 'op://Prod/Aggregate/master key'])
    expect(splitArgv(`a\\ b "" c`)).toEqual(['a b', '', 'c'])
    expect(() => splitArgv(`op read "unclosed`)).toThrow(/unclosed quote/)
  })
})

describe('old keys from a command', () => {
  const node = JSON.stringify(process.execPath)
  const printing = (text: string) => {
    const script = join(tmpdir(), `agfn-old-keys-${randomUUID()}.mjs`)
    writeFileSync(script, `process.stdout.write(${JSON.stringify(text)})`)
    return `${node} ${JSON.stringify(script)}`
  }

  it('decrypts what an old key sealed, and reseal moves it to the current key', () => {
    const [oldA, oldB] = [generateMasterKey(), generateMasterKey()]
    const ctx = { workspaceId: 'w', recordId: 'r', purpose: 'p' }
    const sealed = seal(loadKeyRing({ AGFN_MASTER_KEY: oldB }), { a: 1 }, ctx)
    const ring = loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey(), AGFN_OLD_MASTER_KEYS_COMMAND: printing(`${oldA},${oldB}\n`) })
    expect(unseal(ring, sealed, ctx)).toEqual({ a: 1 })
    expect(sealedKeyId(sealed)).not.toBe(ring.current.id)
    expect(sealedKeyId(reseal(ring, sealed, ctx))).toBe(ring.current.id)
  })

  it('refuses two sources, an empty answer, and never shows the output', () => {
    const k = generateMasterKey()
    expect(() => loadKeyRing({ AGFN_MASTER_KEY: k, AGFN_OLD_MASTER_KEYS: k, AGFN_OLD_MASTER_KEYS_COMMAND: 'x' })).toThrow(/only one old key source/)
    expect(() => loadKeyRing({ AGFN_MASTER_KEY: k, AGFN_OLD_MASTER_KEYS_COMMAND: printing('  ') })).toThrow(/printed nothing/)
    expect(() => loadKeyRing({ AGFN_MASTER_KEY: k, AGFN_OLD_MASTER_KEYS_COMMAND: '/definitely/not/here' })).toThrow(/AGFN_OLD_MASTER_KEYS_COMMAND failed/)
    expect(() => loadKeyRing({ AGFN_MASTER_KEY: k, AGFN_OLD_MASTER_KEYS_COMMAND: printing('not-a-key') })).toThrow(/^master key must be 32 bytes/)
  })

  it('names no key in sealedKeyId for something that is not sealed', () => {
    expect(sealedKeyId('plain')).toBeNull()
  })
})

describe('binary envelope (backups)', () => {
  it('round-trips bytes, is bound to its context, and decrypts with a retired key', () => {
    const oldKey = generateMasterKey()
    const old = loadKeyRing({ AGFN_MASTER_KEY: oldKey })
    const data = Buffer.from('x'.repeat(100_000))
    const ctx = { workspaceId: '_backup', recordId: '2026-10-10.agfnbak', purpose: 'backup' }
    const blob = sealBytes(old, data, ctx)
    expect(blob.includes(Buffer.from('xxxxxxxx'))).toBe(false)
    expect(unsealBytes(old, blob, ctx).equals(data)).toBe(true)
    expect(() => unsealBytes(old, blob, { ...ctx, recordId: 'other' })).toThrow()
    const rotated = loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey(), AGFN_OLD_MASTER_KEYS: oldKey })
    expect(unsealBytes(rotated, blob, ctx).equals(data)).toBe(true)
    expect(() => unsealBytes(loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), blob, ctx)).toThrow(/not loaded/)
    expect(() => unsealBytes(old, Buffer.from('nope'), ctx)).toThrow(/not an Aggregate/)
  })
})

describe('sealStream (backups too large to hold)', () => {
  const ring = loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() })
  const ctx = { workspaceId: '_backup', recordId: 'b1', purpose: 'backup' }
  async function sealAll(data: Buffer, chunk: number, pieces = 7): Promise<Buffer> {
    const t = sealStream(ring, ctx, chunk)
    const out: Buffer[] = []
    t.on('data', (b: Buffer) => out.push(b))
    const done = new Promise((r) => t.on('end', r))
    for (let i = 0; i < data.length; i += pieces) t.write(data.subarray(i, i + pieces))
    t.end()
    await done
    return Buffer.concat(out)
  }
  const open = (blob: Buffer, c = ctx) => {
    const parts: Buffer[] = []
    unsealStream(ring, blob, c, (p) => parts.push(p))
    return Buffer.concat(parts)
  }
  const data = Buffer.from(Array.from({ length: 1000 }, (_, i) => (i * 7) % 256))

  it('round-trips across many frames, and an empty payload', async () => {
    const blob = await sealAll(data, 64)
    expect(isStreamSealed(blob)).toBe(true)
    expect(open(blob)).toEqual(data)
    expect(open(await sealAll(Buffer.alloc(0), 64))).toEqual(Buffer.alloc(0))
  })

  it('refuses a cut-off file, a dropped frame, a changed byte, or another context', async () => {
    const blob = await sealAll(data, 64)
    // 1000 bytes in 64-byte chunks: 15 full frames, then a last frame of 40 (each frame adds 33 bytes).
    const lastFrame = 33 + 40
    const firstFrame = blob.length - (15 * (33 + 64) + lastFrame)
    expect(() => open(blob.subarray(0, blob.length - lastFrame))).toThrow(/truncated/)
    const dropSecond = Buffer.concat([blob.subarray(0, firstFrame + 97), blob.subarray(firstFrame + 2 * 97)])
    expect(() => open(dropSecond)).toThrow()
    const flipped = Buffer.from(blob)
    flipped[blob.length - 3]! ^= 1
    expect(() => open(flipped)).toThrow()
    expect(() => open(blob, { ...ctx, recordId: 'b2' })).toThrow()
  })
})
