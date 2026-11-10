// The real path, against stand-ins for STS and KMS: the signature is recomputed here from what arrived.
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { keyIdFor } from '@agfn/security'

const SCRIPT = join(import.meta.dirname, 'kms-master-key.mjs')
const CREDS = { AccessKeyId: 'AKIDEXAMPLE', SecretAccessKey: 'test-secret-value', SessionToken: 'test-session-token' }
const KEY = randomBytes(32).toString('base64')

type Reply = (path: string, headers: Record<string, string>, body: string) => { status: number; json: unknown; delayMs?: number }
let servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))))
  servers = []
})

async function stand(reply: Reply): Promise<string> {
  const srv = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      const r = reply(req.url ?? '', req.headers as Record<string, string>, body)
      if (r instanceof Promise) return // hangs: never answers
      const send = () => {
        res.writeHead(r.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(r.json))
      }
      if (r.delayMs) setTimeout(send, r.delayMs)
      else send()
    })
  })
  servers.push(srv)
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(srv.address() as { port: number }).port}/`
}

const run = (env: Record<string, string>, args: string[] = []) =>
  new Promise<{ code: number; out: string; err: string }>((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH ?? '', ...env } }, (e, out, err) => resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err }))
  })

function tokenFile(): string {
  const f = join(mkdtempSync(join(tmpdir(), 'agfn-kms-')), 'oidc_token')
  writeFileSync(f, 'the-oidc-token\n')
  return f
}

const sts = (seen: string[] = []) => stand((_p, _h, body) => (seen.push(body), { status: 200, json: { AssumeRoleWithWebIdentityResponse: { AssumeRoleWithWebIdentityResult: { Credentials: CREDS } } } }))
const baseEnv = (stsUrl: string, kmsUrl: string, wrapped = 'd3JhcHBlZA==') => ({ AGFN_MASTER_KEY_WRAPPED: wrapped, AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/test', AWS_WEB_IDENTITY_TOKEN_FILE: tokenFile(), FLY_APP_NAME: 'aggregate-staging', AWS_ENDPOINT_URL_STS: stsUrl, AWS_ENDPOINT_URL_KMS: kmsUrl })

function validSignature(h: Record<string, string>, body: string): boolean {
  const m = /Credential=([^/]+)\/(\d{8})\/([^/]+)\/kms\/aws4_request, SignedHeaders=([^,]+), Signature=(\w+)/.exec(h.authorization ?? '')
  if (!m) return false
  const [, , day, region, signed, signature] = m as unknown as [string, string, string, string, string, string]
  const names = signed.split(';')
  const sha = (s: string) => createHash('sha256').update(s).digest('hex')
  const canonical = ['POST', '/', '', ...names.map((n) => `${n}:${h[n]}`), '', signed, sha(body)].join('\n')
  const toSign = ['AWS4-HMAC-SHA256', h['x-amz-date'], `${day}/${region}/kms/aws4_request`, sha(canonical)].join('\n')
  const mac = (k: string | Buffer, s: string) => createHmac('sha256', k).update(s).digest()
  const key = mac(mac(mac(mac(`AWS4${CREDS.SecretAccessKey}`, day), region), 'kms'), 'aws4_request')
  return mac(key, toSign).toString('hex') === signature && names.includes('host') && names.includes('x-amz-security-token') && names.includes('x-amz-target')
}

describe('kms-master-key', () => {
  it('signs in with the token file, signs the Decrypt, and prints only the key', async () => {
    const seen: string[] = []
    const calls: Array<{ h: Record<string, string>; body: string }> = []
    const kms = await stand((_p, h, body) => (calls.push({ h, body }), { status: 200, json: { Plaintext: KEY } }))
    const r = await run(baseEnv(await sts(seen), kms))
    expect(r).toMatchObject({ code: 0, out: KEY, err: '' })
    const form = new URLSearchParams(seen[0])
    expect(form.get('Action')).toBe('AssumeRoleWithWebIdentity')
    expect(form.get('WebIdentityToken')).toBe('the-oidc-token')
    const call = calls[0]!
    expect(call.h['x-amz-target']).toBe('TrentService.Decrypt')
    expect(JSON.parse(call.body)).toEqual({ CiphertextBlob: 'd3JhcHBlZA==', EncryptionContext: { app: 'aggregate-staging' } })
    expect(validSignature(call.h, call.body)).toBe(true)
  })

  it('reads another variable, comma-separated, for old keys', async () => {
    const kms = await stand((_p, _h, body) => ({ status: 200, json: { Plaintext: `plain-${JSON.parse(body).CiphertextBlob}` } }))
    const { AGFN_MASTER_KEY_WRAPPED: _unused, ...env } = baseEnv(await sts(), kms)
    const r = await run({ ...env, AGFN_OLD_WRAPPED: 'a, b' }, ['AGFN_OLD_WRAPPED'])
    expect(r).toMatchObject({ code: 0, out: 'plain-a,plain-b' })
  })

  it('a refusal exits non-zero with the status and type, and prints no key', async () => {
    const kms = await stand(() => ({ status: 400, json: { __type: 'AccessDeniedException', message: 'details about the role' } }))
    const r = await run(baseEnv(await sts(), kms))
    expect(r.code).toBe(1)
    expect(r.out).toBe('')
    expect(r.err).toContain('KMS Decrypt failed: status 400, AccessDeniedException')
    expect(r.err).not.toContain('details about the role')
  })

  it('retries once when AWS is briefly unwell', async () => {
    let n = 0
    const kms = await stand(() => (++n === 1 ? { status: 503, json: {} } : { status: 200, json: { Plaintext: KEY } }))
    expect(await run(baseEnv(await sts(), kms))).toMatchObject({ code: 0, out: KEY })
    expect(n).toBe(2)
  })

  it('a hung KMS: gives up within its deadline, says which host, prints nothing', async () => {
    const kms = await stand(() => new Promise(() => {}) as never)
    const started = Date.now()
    const r = await run({ ...baseEnv(await sts(), kms), AGFN_KMS_DEADLINE_MS: '1500' })
    expect(r.code).toBe(1)
    expect(r.out).toBe('')
    expect(r.err).toMatch(/127\.0\.0\.1:\d+ did not answer \(TimeoutError\)|ran out of time/)
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it('many old keys and a slow KMS: stops at the deadline, before the 10 s kill, and prints none of them', async () => {
    const kms = await stand((_p, _h, body) => ({ status: 200, json: { Plaintext: `plain-${JSON.parse(body).CiphertextBlob}` }, delayMs: 400 }))
    const { AGFN_MASTER_KEY_WRAPPED: _unused, ...env } = baseEnv(await sts(), kms)
    const r = await run({ ...env, AGFN_OLD_WRAPPED: 'a,b,c,d,e,f', AGFN_KMS_DEADLINE_MS: '1000' }, ['AGFN_OLD_WRAPPED'])
    expect(r.code).toBe(1)
    expect(r.out).toBe('')
    expect(r.err).toMatch(/ran out of time|did not answer/)
    expect(r.err).not.toContain('plain-')
  })

  it('a key wrapped for another app (wrong encryption context) is refused, and nothing is printed', async () => {
    // KMS refuses a Decrypt whose context differs from the one the key was wrapped with.
    const kms = await stand((_p, _h, body) =>
      JSON.parse(body).EncryptionContext?.app === 'aggregate-finance' ? { status: 200, json: { Plaintext: KEY } } : { status: 400, json: { __type: 'InvalidCiphertextException' } },
    )
    const r = await run(baseEnv(await sts(), kms)) // FLY_APP_NAME is aggregate-staging
    expect(r.code).toBe(1)
    expect(r.out).toBe('')
    expect(r.err).toContain('KMS Decrypt failed: status 400, InvalidCiphertextException')
    expect((await run({ ...baseEnv(await sts(), kms), FLY_APP_NAME: 'aggregate-finance' })).out).toBe(KEY)
  })

  it('one key of several refused: none is printed (no partial output)', async () => {
    const kms = await stand((_p, _h, body) => (JSON.parse(body).CiphertextBlob === 'b' ? { status: 400, json: { __type: 'AccessDeniedException' } } : { status: 200, json: { Plaintext: KEY } }))
    const { AGFN_MASTER_KEY_WRAPPED: _unused, ...env } = baseEnv(await sts(), kms)
    const r = await run({ ...env, AGFN_OLD_WRAPPED: 'a,b' }, ['AGFN_OLD_WRAPPED'])
    expect(r.code).toBe(1)
    expect(r.out).toBe('')
    expect(r.err).not.toContain(KEY)
  })

  it('boots a key ring through AGFN_MASTER_KEY_COMMAND, the way the server does', async () => {
    const kms = await stand(() => ({ status: 200, json: { Plaintext: KEY } }))
    // loadKeyRing runs the command synchronously, so it runs in a child here: in this process it would block the
    // stand-ins it's waiting on. The child prints only the key ring's id, never the key.
    const env = { ...baseEnv(await sts(), kms), PATH: process.env.PATH ?? '', AGFN_MASTER_KEY_COMMAND: `${process.execPath} ${SCRIPT}` }
    const code = "import { loadKeyRing } from '@agfn/security'; process.stdout.write(loadKeyRing(process.env).current.id)"
    const id = await new Promise<string>((resolve, reject) =>
      execFile(process.execPath, ['--input-type=module', '-e', code], { env, cwd: join(import.meta.dirname, '..') }, (e, out, err) => (e ? reject(new Error(err)) : resolve(out))),
    )
    expect(id).toBe(keyIdFor(Buffer.from(KEY, 'base64')))
  })

  it('names what is missing', async () => {
    const r = await run({ AGFN_MASTER_KEY_WRAPPED: 'x', FLY_APP_NAME: 'aggregate-staging', AWS_WEB_IDENTITY_TOKEN_FILE: tokenFile() })
    expect(r.code).toBe(1)
    expect(r.err).toContain('AWS_ROLE_ARN is not set')
    expect((await run({})).err).toContain('AGFN_MASTER_KEY_WRAPPED is not set')
    // The context is checked before any network call.
    expect((await run({ AGFN_MASTER_KEY_WRAPPED: 'x' })).err).toContain('AGFN_KMS_CONTEXT_APP (or FLY_APP_NAME) is not set')
    expect((await run({ AGFN_MASTER_KEY_WRAPPED: 'x', AGFN_KMS_CONTEXT_APP: 'a"b' })).err).toContain('plain app name')
    expect((await run({ AGFN_MASTER_KEY_WRAPPED: 'x', AGFN_KMS_CONTEXT_APP: 'aggregate-live', AWS_EC2_METADATA_DISABLED: 'true' })).err).toContain('instance metadata service is disabled')
  })
})

// EC2: no token file, so the instance role's credentials come from IMDSv2, the way the AWS SDKs get them.
type Imds = { calls: Array<{ method: string; path: string; token?: string; ttl?: string }>; url: string }
async function imds(o: { role?: string | null; hang?: boolean; tokenStatus?: number } = {}): Promise<Imds> {
  const calls: Imds['calls'] = []
  const srv = createServer((req, res) => {
    const call = { method: req.method ?? '', path: req.url ?? '', token: req.headers['x-aws-ec2-metadata-token'] as string | undefined, ttl: req.headers['x-aws-ec2-metadata-token-ttl-seconds'] as string | undefined }
    calls.push(call)
    if (o.hang) return
    const text = (status: number, body: string) => (res.writeHead(status, { 'content-type': 'text/plain' }), res.end(body))
    if (call.path === '/latest/api/token') return call.method === 'PUT' && call.ttl ? text(o.tokenStatus ?? 200, 'imds-session-token') : text(400, '')
    // Without the session token IMDSv2 answers 401 (what an instance with IMDSv1 turned off does).
    if (call.token !== 'imds-session-token') return text(401, '')
    if (call.path === '/latest/meta-data/iam/security-credentials/') return o.role === null ? text(404, '') : text(200, `${o.role ?? 'agfn-live-app'}\n`)
    if (call.path === `/latest/meta-data/iam/security-credentials/${o.role ?? 'agfn-live-app'}`)
      return text(200, JSON.stringify({ Code: 'Success', Type: 'AWS-HMAC', AccessKeyId: CREDS.AccessKeyId, SecretAccessKey: CREDS.SecretAccessKey, Token: CREDS.SessionToken, Expiration: '2026-11-10T12:00:00Z' }))
    text(404, '')
  })
  servers.push(srv)
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return { calls, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}` }
}
const ec2Env = (imdsUrl: string, kmsUrl: string) => ({ AGFN_MASTER_KEY_WRAPPED: 'd3JhcHBlZA==', AGFN_KMS_CONTEXT_APP: 'aggregate-live', AWS_EC2_METADATA_SERVICE_ENDPOINT: imdsUrl, AWS_ENDPOINT_URL_KMS: kmsUrl })

describe('kms-master-key on EC2 (instance role through IMDSv2)', () => {
  it('gets the role credentials with a session token, signs the Decrypt with them, and uses AGFN_KMS_CONTEXT_APP', async () => {
    const md = await imds()
    const calls: Array<{ h: Record<string, string>; body: string }> = []
    const kms = await stand((_p, h, body) => (calls.push({ h, body }), { status: 200, json: { Plaintext: KEY } }))
    const r = await run(ec2Env(md.url, kms))
    expect(r).toMatchObject({ code: 0, out: KEY, err: '' })
    expect(md.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['PUT /latest/api/token', 'GET /latest/meta-data/iam/security-credentials/', 'GET /latest/meta-data/iam/security-credentials/agfn-live-app'])
    expect(md.calls[0]!.ttl).toBe('60')
    // Never IMDSv1: every metadata read carries the session token.
    expect(md.calls.slice(1).every((c) => c.token === 'imds-session-token')).toBe(true)
    expect(JSON.parse(calls[0]!.body).EncryptionContext).toEqual({ app: 'aggregate-live' })
    expect(calls[0]!.h['x-amz-security-token']).toBe(CREDS.SessionToken)
    expect(validSignature(calls[0]!.h, calls[0]!.body)).toBe(true)
  })

  it('AGFN_KMS_CONTEXT_APP wins over FLY_APP_NAME; FLY_APP_NAME alone still works (the Fly-wrapped blobs)', async () => {
    const seen: string[] = []
    const kms = await stand((_p, _h, body) => (seen.push(JSON.parse(body).EncryptionContext.app), { status: 200, json: { Plaintext: KEY } }))
    expect((await run({ ...ec2Env((await imds()).url, kms), FLY_APP_NAME: 'aggregate-finance' })).code).toBe(0)
    const { AGFN_KMS_CONTEXT_APP: _unused, ...flyOnly } = ec2Env((await imds()).url, kms)
    expect((await run({ ...flyOnly, FLY_APP_NAME: 'aggregate-finance' })).code).toBe(0)
    expect(seen).toEqual(['aggregate-live', 'aggregate-finance'])
  })

  it('no instance role attached: says so, prints nothing', async () => {
    const kms = await stand(() => ({ status: 200, json: { Plaintext: KEY } }))
    const r = await run(ec2Env((await imds({ role: null })).url, kms))
    expect(r.code).toBe(1)
    expect(r.out).toBe('')
    expect(r.err).toContain('IMDS role lookup (is an instance role attached?) failed: status 404')
  })

  it('a refused session token (IMDSv2 unavailable) fails without falling back to IMDSv1', async () => {
    const md = await imds({ tokenStatus: 403 })
    const kms = await stand(() => ({ status: 200, json: { Plaintext: KEY } }))
    const r = await run(ec2Env(md.url, kms))
    expect(r.code).toBe(1)
    expect(r.err).toContain('IMDSv2 token failed: status 403')
    expect(md.calls.every((c) => c.path === '/latest/api/token')).toBe(true)
  })

  it('a hung metadata service: gives up within the deadline, prints nothing', async () => {
    const kms = await stand(() => ({ status: 200, json: { Plaintext: KEY } }))
    const started = Date.now()
    const r = await run({ ...ec2Env((await imds({ hang: true })).url, kms), AGFN_KMS_DEADLINE_MS: '1500' })
    expect(r.code).toBe(1)
    expect(r.out).toBe('')
    expect(r.err).toMatch(/did not answer \(TimeoutError\)|ran out of time/)
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it('a key wrapped under the Fly app name is refused under the new context until it is re-wrapped', async () => {
    const kms = await stand((_p, _h, body) => (JSON.parse(body).EncryptionContext?.app === 'aggregate-finance' ? { status: 200, json: { Plaintext: KEY } } : { status: 400, json: { __type: 'InvalidCiphertextException' } }))
    const r = await run(ec2Env((await imds()).url, kms))
    expect(r.code).toBe(1)
    expect(r.out).toBe('')
    expect(r.err).toContain('InvalidCiphertextException')
  })
})
