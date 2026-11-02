// The real path, against stand-ins for STS and KMS: the signature is recomputed here from what arrived.
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPT = join(import.meta.dirname, 'kms-master-key.mjs')
const CREDS = { AccessKeyId: 'AKIDEXAMPLE', SecretAccessKey: 'test-secret-value', SessionToken: 'test-session-token' }
const KEY = randomBytes(32).toString('base64')

type Reply = (path: string, headers: Record<string, string>, body: string) => { status: number; json: unknown }
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
      res.writeHead(r.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(r.json))
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

  it('names what is missing', async () => {
    const r = await run({ AGFN_MASTER_KEY_WRAPPED: 'x' })
    expect(r.code).toBe(1)
    expect(r.err).toContain('AWS_ROLE_ARN is not set')
    expect((await run({})).err).toContain('AGFN_MASTER_KEY_WRAPPED is not set')
  })
})
