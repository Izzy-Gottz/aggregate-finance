// S3-compatible FileStore (AWS S3, Cloudflare R2, MinIO) for hosted. AWS Signature V4 by hand: no SDK dependency.
// Path-style URLs (https://endpoint/bucket/key) so R2 and MinIO work without per-bucket DNS.

import { createHash, createHmac } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { assertKey, type FileStore } from './index.ts'

export interface S3Config {
  bucket: string
  /** e.g. https://s3.us-east-1.amazonaws.com or https://<account>.r2.cloudflarestorage.com */
  endpoint: string
  /** "auto" for R2. */
  region: string
  accessKeyId: string
  secretAccessKey: string
  /** Optional prefix inside the bucket, e.g. "prod/". */
  prefix?: string
  fetch?: typeof fetch
  /** Retries for 5xx / 429 / network errors (default 3). */
  retries?: number
  now?: () => Date
  /** The variable the endpoint came from, for error messages (default FILES_S3_ENDPOINT). */
  endpointVar?: string
}

/** Build from FILES_S3_* env vars (or another prefix, e.g. BACKUP_S3_); null when <prefix>BUCKET is unset. */
export function s3ConfigFromEnv(env: Record<string, string | undefined>, p = 'FILES_S3_'): S3Config | null {
  const bucket = env[`${p}BUCKET`]
  if (!bucket) return null
  const need = (k: string) => {
    const v = env[`${p}${k}`]
    if (!v) throw new Error(`${p}BUCKET is set, so ${p}${k} is required.`)
    return v
  }
  return {
    bucket,
    endpoint: need('ENDPOINT'),
    region: env[`${p}REGION`] ?? 'auto',
    accessKeyId: need('ACCESS_KEY_ID'),
    secretAccessKey: need('SECRET_ACCESS_KEY'),
    ...(env[`${p}PREFIX`] ? { prefix: env[`${p}PREFIX`] } : {}),
    endpointVar: `${p}ENDPOINT`,
  }
}

const sha256hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest()

/** RFC 3986 encoding as SigV4 wants it ("/" kept in paths). */
function encodePath(p: string): string {
  return p
    .split('/')
    .map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/')
}

export interface SignInput {
  method: string
  url: URL
  headers: Record<string, string>
  payloadHash: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  date: Date
  service?: string
}

/** Returns the Authorization header value (and mutates nothing). Exported for the AWS test vector. */
export function signV4(i: SignInput): { authorization: string; amzDate: string } {
  const service = i.service ?? 's3'
  const amzDate = i.date.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const day = amzDate.slice(0, 8)
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(i.headers)) headers[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ')
  headers.host = i.url.host
  headers['x-amz-date'] = amzDate
  headers['x-amz-content-sha256'] = i.payloadHash
  const names = Object.keys(headers).sort()
  const query = [...i.url.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  const canonical = [i.method, encodePath(decodeURIComponent(i.url.pathname)), query, names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), i.payloadHash].join('\n')
  const scope = `${day}/${i.region}/${service}/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n')
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, day), i.region), service), 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex')
  return { authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`, amzDate }
}

const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

export class S3FileStore implements FileStore {
  private readonly c: S3Config
  private readonly f: typeof fetch
  constructor(config: S3Config) {
    const name = config.endpointVar ?? 'FILES_S3_ENDPOINT'
    if (!/^https?:\/\//.test(config.endpoint)) throw new Error(`${name} must be an http(s) URL`)
    // Plain http only to this machine (a local MinIO): anything else would send the keys and data unencrypted.
    if (config.endpoint.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(config.endpoint)) {
      throw new Error(`${name} must use https (plain http is allowed only for localhost)`)
    }
    this.c = config
    this.f = config.fetch ?? fetch
  }

  private url(key: string): URL {
    assertKey(key)
    const base = this.c.endpoint.replace(/\/+$/, '')
    return new URL(`${base}/${encodePath(this.c.bucket)}/${encodePath((this.c.prefix ?? '') + key)}`)
  }

  private async send(method: 'PUT' | 'GET' | 'DELETE' | 'POST', key: string, body?: Uint8Array): Promise<Response> {
    return this.sendUrl(method, this.url(key), body)
  }

  private async sendUrl(method: 'PUT' | 'GET' | 'DELETE' | 'POST', url: URL, body?: Uint8Array): Promise<Response> {
    const payloadHash = sha256hex(body ?? new Uint8Array())
    const extra: Record<string, string> = body ? { 'content-type': 'application/octet-stream', 'content-length': String(body.byteLength) } : {}
    const retries = this.c.retries ?? 3
    let lastErr: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, Math.min(2000, 100 * 2 ** attempt) + Math.random() * 100))
      const { authorization, amzDate } = signV4({ method, url, headers: extra, payloadHash, region: this.c.region, accessKeyId: this.c.accessKeyId, secretAccessKey: this.c.secretAccessKey, date: (this.c.now ?? (() => new Date()))() })
      try {
        const res = await this.f(url, { method, headers: { ...extra, authorization, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash }, ...(body ? { body: new Uint8Array(body) } : {}) })
        if (res.status >= 500 || res.status === 429) {
          lastErr = new Error(`object store ${method} failed: ${res.status}`)
          await res.body?.cancel()
          continue
        }
        return res
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('object store unreachable')
  }

  /** Keys under `prefix` (relative to the configured prefix) with their last-modified time. Follows pagination. */
  async list(prefix: string): Promise<Array<{ key: string; lastModified: string }>> {
    const out: Array<{ key: string; lastModified: string }> = []
    const base = (this.c.prefix ?? '') + prefix
    let token: string | undefined
    for (let page = 0; page < 1000; page++) {
      const url = new URL(`${this.c.endpoint.replace(/\/+$/, '')}/${encodePath(this.c.bucket)}`)
      url.searchParams.set('list-type', '2')
      url.searchParams.set('prefix', base)
      if (token) url.searchParams.set('continuation-token', token)
      const res = await this.sendUrl('GET', url)
      if (!res.ok) throw new Error(`object store LIST failed: ${res.status}`)
      const xml = await res.text()
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = /<Key>([\s\S]*?)<\/Key>/.exec(m[1]!)?.[1]
        const lm = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(m[1]!)?.[1]
        if (key) out.push({ key: unxml(key).slice((this.c.prefix ?? '').length), lastModified: lm ?? '' })
      }
      if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break
      token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1]
      if (!token) break
      token = unxml(token)
    }
    return out
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const res = await this.send('PUT', key, bytes)
    if (!res.ok) throw new Error(`object store PUT failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
  }

  /**
   * Upload a file without holding it: S3 multipart, one part (8 MiB) in memory at a time; a small file is one PUT.
   * A failed upload is aborted so no parts linger. Used for backups, which can be larger than the machine's memory.
   */
  async putFile(key: string, path: string, partSize = 8 << 20): Promise<void> {
    const size = (await stat(path)).size
    const fh = await open(path, 'r')
    try {
      const read = async (at: number, n: number): Promise<Uint8Array> => {
        const buf = new Uint8Array(n)
        const { bytesRead } = await fh.read(buf, 0, n, at)
        return buf.subarray(0, bytesRead)
      }
      if (size <= partSize) return await this.put(key, await read(0, size))
      const base = this.url(key)
      const start = new URL(base)
      start.searchParams.set('uploads', '')
      const res = await this.sendUrl('POST', start)
      if (!res.ok) throw new Error(`object store multipart start failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
      const uploadId = unxml(/<UploadId>([\s\S]*?)<\/UploadId>/.exec(await res.text())?.[1] ?? '')
      if (!uploadId) throw new Error('object store multipart start returned no UploadId')
      const withId = (extra: Record<string, string> = {}) => {
        const u = new URL(base)
        for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v)
        u.searchParams.set('uploadId', uploadId)
        return u
      }
      try {
        const etags: string[] = []
        for (let at = 0, n = 1; at < size; at += partSize, n++) {
          const part = await this.sendUrl('PUT', withId({ partNumber: String(n) }), await read(at, Math.min(partSize, size - at)))
          if (!part.ok) throw new Error(`object store part ${n} failed: ${part.status} ${(await part.text()).slice(0, 200)}`)
          await part.body?.cancel()
          const etag = part.headers.get('etag')
          if (!etag) throw new Error(`object store part ${n} returned no ETag`)
          etags.push(etag)
        }
        const xml = `<CompleteMultipartUpload>${etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</ETag></Part>`).join('')}</CompleteMultipartUpload>`
        const done = await this.sendUrl('POST', withId(), new TextEncoder().encode(xml))
        const text = await done.text()
        // S3 can answer 200 with an <Error> body when completing.
        if (!done.ok || /<Error>/.test(text)) throw new Error(`object store multipart complete failed: ${done.status} ${text.slice(0, 200)}`)
      } catch (err) {
        await this.sendUrl('DELETE', withId()).then((r) => r.body?.cancel()).catch(() => undefined)
        throw err
      }
    } finally {
      await fh.close()
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    const res = await this.send('GET', key)
    if (res.status === 404) {
      await res.body?.cancel()
      return null
    }
    if (!res.ok) throw new Error(`object store GET failed: ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  async delete(key: string): Promise<void> {
    const res = await this.send('DELETE', key)
    if (!res.ok && res.status !== 404) throw new Error(`object store DELETE failed: ${res.status}`)
    await res.body?.cancel()
  }
}
