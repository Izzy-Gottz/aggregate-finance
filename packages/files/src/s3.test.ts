import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { S3FileStore, s3ConfigFromEnv, signV4 } from './s3.ts'

describe('SigV4', () => {
  it('matches the AWS documented S3 GET example', () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html (GET Object example)
    const { authorization } = signV4({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { range: 'bytes=0-9' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      date: new Date('2013-05-24T00:00:00Z'),
    })
    expect(authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    )
  })
})

/** A tiny in-memory S3: checks that requests are signed and stores bodies. */
function fakeS3(opts: { failFirst?: number } = {}) {
  const objects = new Map<string, Uint8Array>()
  const seen: Array<{ method: string; path: string }> = []
  let fails = opts.failFirst ?? 0
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    seen.push({ method, path: url.pathname })
    const auth = new Headers(init?.headers).get('authorization') ?? ''
    if (!auth.startsWith('AWS4-HMAC-SHA256 Credential=AK/')) return new Response('denied', { status: 403 })
    if (fails > 0) {
      fails--
      return new Response('busy', { status: 503 })
    }
    if (method === 'PUT') {
      objects.set(url.pathname, new Uint8Array(init!.body as Uint8Array))
      return new Response(null, { status: 200 })
    }
    if (method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = `/agfn/${url.searchParams.get('prefix') ?? ''}`
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice('/agfn/'.length))
      const start = Number(url.searchParams.get('continuation-token') ?? 0)
      const page = keys.slice(start, start + 2)
      const more = start + 2 < keys.length
      return new Response(`<ListBucketResult>${page.map((k) => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key><LastModified>2026-10-10T00:00:00.000Z</LastModified></Contents>`).join('')}<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ''}</ListBucketResult>`, { status: 200 })
    }
    if (method === 'GET') {
      const o = objects.get(url.pathname)
      return o ? new Response(new Uint8Array(o), { status: 200 }) : new Response('<NoSuchKey/>', { status: 404 })
    }
    objects.delete(url.pathname)
    return new Response(null, { status: 204 })
  }) as typeof fetch
  return { f, objects, seen }
}

describe('S3FileStore', () => {
  const base = { bucket: 'agfn', endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', accessKeyId: 'AK', secretAccessKey: 'SK', prefix: 'prod/' }

  it('puts, gets and deletes with path-style URLs', async () => {
    const s3 = fakeS3()
    const store = new S3FileStore({ ...base, fetch: s3.f })
    await store.put('ws1/abc.pdf', new TextEncoder().encode('%PDF'))
    expect(s3.seen[0]).toEqual({ method: 'PUT', path: '/agfn/prod/ws1/abc.pdf' })
    expect(new TextDecoder().decode((await store.get('ws1/abc.pdf'))!)).toBe('%PDF')
    expect(await store.get('ws1/missing.pdf')).toBeNull()
    await store.delete('ws1/abc.pdf')
    expect(await store.get('ws1/abc.pdf')).toBeNull()
    await expect(store.put('../escape', new Uint8Array())).rejects.toThrow()
  })

  it('lists keys under a prefix across pages, relative to the configured prefix', async () => {
    const s3 = fakeS3()
    const store = new S3FileStore({ ...base, fetch: s3.f })
    for (const k of ['backups/a.bak', 'backups/b_c.bak', 'backups/c.bak', 'other/x']) await store.put(k, new Uint8Array([1]))
    const keys = (await store.list('backups/')).map((o) => o.key)
    expect(keys).toEqual(['backups/a.bak', 'backups/b_c.bak', 'backups/c.bak'])
  })

  it('reads BACKUP_S3_* with a prefix argument', () => {
    expect(s3ConfigFromEnv({ BACKUP_S3_BUCKET: 'b', BACKUP_S3_ENDPOINT: 'https://x', BACKUP_S3_ACCESS_KEY_ID: 'a', BACKUP_S3_SECRET_ACCESS_KEY: 's' }, 'BACKUP_S3_')).toMatchObject({ bucket: 'b' })
    expect(() => s3ConfigFromEnv({ BACKUP_S3_BUCKET: 'b' }, 'BACKUP_S3_')).toThrow(/BACKUP_S3_ENDPOINT/)
    // An endpoint error names the variable it came from, and plain http is only for this machine.
    const backup = (endpoint: string) => () => new S3FileStore(s3ConfigFromEnv({ BACKUP_S3_BUCKET: 'b', BACKUP_S3_ENDPOINT: endpoint, BACKUP_S3_ACCESS_KEY_ID: 'a', BACKUP_S3_SECRET_ACCESS_KEY: 's' }, 'BACKUP_S3_')!)
    expect(backup('http://minio.lan:9000')).toThrow(/^BACKUP_S3_ENDPOINT must use https/)
    expect(backup('http://localhost.example.com')).toThrow(/must use https/)
    for (const ok of ['http://localhost:9000', 'http://127.0.0.1:9000/', 'http://[::1]:9000', 'https://x']) expect(backup(ok)).not.toThrow()
  })

  it('retries transient failures and surfaces permanent ones', async () => {
    const s3 = fakeS3({ failFirst: 2 })
    const store = new S3FileStore({ ...base, fetch: s3.f, retries: 3 })
    await store.put('a/b.csv', new Uint8Array([1]))
    expect(s3.seen.filter((r) => r.method === 'PUT')).toHaveLength(3)
    const bad = new S3FileStore({ ...base, accessKeyId: 'WRONG', fetch: s3.f })
    await expect(bad.put('a/b.csv', new Uint8Array([1]))).rejects.toThrow(/403/)
  })

  it('reads config from env and refuses plain http to remote hosts', () => {
    expect(s3ConfigFromEnv({})).toBeNull()
    expect(() => s3ConfigFromEnv({ FILES_S3_BUCKET: 'b' })).toThrow(/FILES_S3_ENDPOINT/)
    expect(s3ConfigFromEnv({ FILES_S3_BUCKET: 'b', FILES_S3_ENDPOINT: 'https://x', FILES_S3_ACCESS_KEY_ID: 'a', FILES_S3_SECRET_ACCESS_KEY: 's' })).toMatchObject({ bucket: 'b', region: 'auto' })
    expect(() => new S3FileStore({ ...base, endpoint: 'http://s3.example.com' })).toThrow(/https/)
    expect(() => new S3FileStore({ ...base, endpoint: 'http://localhost:9000' })).not.toThrow()
  })
})

describe('putFile (multipart, for backups larger than memory)', () => {
  const base = { endpoint: 'https://s3.example.com', bucket: 'b', region: 'auto', accessKeyId: 'AK', secretAccessKey: 'SK', retries: 0 }
  /** S3's multipart calls: start (POST ?uploads), parts (PUT ?partNumber&uploadId), complete (POST ?uploadId), abort. */
  function multipartS3(opts: { failPart?: number } = {}) {
    const objects = new Map<string, Uint8Array>()
    const parts = new Map<number, Uint8Array>()
    const calls: string[] = []
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const q = url.searchParams
      const body = init?.body ? new Uint8Array(init.body as Uint8Array) : new Uint8Array()
      if (method === 'POST' && q.has('uploads')) return calls.push('start'), new Response('<InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>')
      if (method === 'PUT' && q.get('uploadId') === 'up-1') {
        const n = Number(q.get('partNumber'))
        calls.push(`part ${n} ${body.length}`)
        if (n === opts.failPart) return new Response('nope', { status: 400 })
        parts.set(n, body)
        return new Response(null, { status: 200, headers: { etag: `"e${n}"` } })
      }
      if (method === 'POST' && q.get('uploadId') === 'up-1') {
        const xml = new TextDecoder().decode(body)
        calls.push(`complete ${[...xml.matchAll(/<ETag>([^<]*)<\/ETag>/g)].map((m) => m[1]).join(',')}`)
        objects.set(url.pathname, Buffer.concat([...parts.keys()].sort((a, b) => a - b).map((k) => parts.get(k)!)))
        return new Response('<CompleteMultipartUploadResult/>')
      }
      if (method === 'DELETE' && q.get('uploadId') === 'up-1') return calls.push('abort'), new Response(null, { status: 204 })
      if (method === 'PUT') return calls.push(`put ${body.length}`), objects.set(url.pathname, body), new Response(null, { status: 200 })
      return new Response('unexpected', { status: 500 })
    }) as typeof fetch
    return { f, objects, calls }
  }
  const file = (bytes: number) => {
    const dir = mkdtempSync(join(tmpdir(), 'agfn-s3-'))
    const p = join(dir, 'f.bin')
    writeFileSync(p, Buffer.from(Array.from({ length: bytes }, (_, i) => i % 251)))
    return p
  }

  it('uploads in parts, in order, and the object is the whole file', async () => {
    const s3 = multipartS3()
    const p = file(25)
    await new S3FileStore({ ...base, fetch: s3.f }).putFile(`backups/x.agfnbak`, p, 10)
    expect(s3.calls).toEqual(['start', 'part 1 10', 'part 2 10', 'part 3 5', 'complete "e1","e2","e3"'])
    expect(Buffer.from(s3.objects.get('/b/backups/x.agfnbak')!)).toEqual(readFileSync(p))
  })

  it('a small file is one PUT', async () => {
    const s3 = multipartS3()
    await new S3FileStore({ ...base, fetch: s3.f }).putFile(`backups/y.agfnbak`, file(8), 10)
    expect(s3.calls).toEqual(['put 8'])
  })

  it('a failed part aborts the upload (no parts left behind) and throws', async () => {
    const s3 = multipartS3({ failPart: 2 })
    await expect(new S3FileStore({ ...base, fetch: s3.f }).putFile(`backups/z.agfnbak`, file(25), 10)).rejects.toThrow(/part 2 failed/)
    expect(s3.calls).toEqual(['start', 'part 1 10', 'part 2 10', 'abort'])
    expect(s3.objects.size).toBe(0)
  })
})
