#!/usr/bin/env node
// Prints the master key for AGFN_MASTER_KEY_COMMAND: unwraps AGFN_MASTER_KEY_WRAPPED with AWS KMS and writes base64 to
// stdout. Pass another variable's name to read that instead (comma-separated values come back comma-separated, for
// AGFN_OLD_MASTER_KEYS_COMMAND). No AWS secret sits next to the wrapped key. Credentials come from, in order:
//   - a web-identity token file (AWS_WEB_IDENTITY_TOKEN_FILE + AWS_ROLE_ARN: the Fly machine's OIDC token, read fresh
//     every run because it's short-lived), exchanged at STS;
//   - otherwise the EC2 instance role, through IMDSv2 (a session token first, then the role's temporary credentials).
//     In Docker the instance needs a metadata hop limit of 2.
// The encryption context is app=AGFN_KMS_CONTEXT_APP, else app=FLY_APP_NAME (how the Fly-wrapped blobs were made).
// No dependencies: the runtime image has no AWS tools.
// The output is the key: nothing here logs it, and errors carry only a status and AWS's error type.

import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'

const TIMEOUT_MS = 2_400 // One request's wait: two tries each of STS and KMS fit inside the 10 seconds a key command gets.
// The whole run, however many keys (old keys come comma-separated): stop with a message before keyFromCommand's 10 s
// kill, so the boot log says what was slow instead of only "did not finish". AGFN_KMS_DEADLINE_MS can only shorten it.
const DEADLINE_MS = Math.min(9_000, Number(process.env.AGFN_KMS_DEADLINE_MS) > 0 ? Number(process.env.AGFN_KMS_DEADLINE_MS) : 9_000)
const START = Date.now()
const left = () => DEADLINE_MS - (Date.now() - START)

const need = (env, name) => {
  const v = env[name]?.trim()
  if (!v) throw new Error(`${name} is not set`)
  return v
}
const sha256 = (s) => createHash('sha256').update(s).digest('hex')
const hmac = (key, s) => createHmac('sha256', key).update(s).digest()

async function post(url, init) {
  for (let attempt = 1; ; attempt++) {
    const wait = Math.min(TIMEOUT_MS, left())
    if (wait <= 0) throw new Error(`ran out of time (${DEADLINE_MS / 1000}s) before ${new URL(url).host} answered`)
    try {
      const res = await fetch(url, { method: 'POST', ...init, signal: AbortSignal.timeout(wait) })
      // One fast retry, for AWS being briefly unwell. A refusal won't change.
      if (res.status < 500 || attempt === 2) return res
    } catch (err) {
      if (attempt === 2 || left() <= 0) throw new Error(`${new URL(url).host} did not answer (${err.name})`)
    }
  }
}

async function failure(what, res) {
  const body = await res.json().catch(() => null)
  const type = body?.__type ?? body?.Error?.Code ?? body?.code ?? 'unknown'
  return new Error(`${what} failed: status ${res.status}, ${String(type).slice(0, 80)}`)
}

async function assumeRole(env, region) {
  const form = new URLSearchParams({
    Action: 'AssumeRoleWithWebIdentity',
    Version: '2011-06-15',
    RoleArn: need(env, 'AWS_ROLE_ARN'),
    RoleSessionName: env.AWS_ROLE_SESSION_NAME?.trim() || 'agfn-master-key',
    WebIdentityToken: readFileSync(need(env, 'AWS_WEB_IDENTITY_TOKEN_FILE'), 'utf8').trim(),
    DurationSeconds: '900',
  })
  const url = env.AWS_ENDPOINT_URL_STS?.trim() || `https://sts.${region}.amazonaws.com/`
  const res = await post(url, { headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString() })
  if (!res.ok) throw await failure('STS AssumeRoleWithWebIdentity', res)
  const c = (await res.json())?.AssumeRoleWithWebIdentityResponse?.AssumeRoleWithWebIdentityResult?.Credentials
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) throw new Error('STS answered without credentials')
  return c
}

/**
 * The EC2 instance role's credentials through IMDSv2: PUT for a session token, then the role name, then its
 * credentials. IMDSv1 (no token) is never used. AWS_EC2_METADATA_SERVICE_ENDPOINT overrides the address, as in the AWS
 * SDKs; AWS_EC2_METADATA_DISABLED=true turns the path off.
 */
async function instanceRole(env) {
  if (env.AWS_EC2_METADATA_DISABLED?.trim().toLowerCase() === 'true') throw new Error('no AWS_WEB_IDENTITY_TOKEN_FILE, and the instance metadata service is disabled')
  const base = (env.AWS_EC2_METADATA_SERVICE_ENDPOINT?.trim() || 'http://169.254.169.254').replace(/\/+$/, '')
  const tokenRes = await post(`${base}/latest/api/token`, { method: 'PUT', headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '60' } })
  if (!tokenRes.ok) throw await failure('IMDSv2 token', tokenRes)
  const token = (await tokenRes.text()).trim()
  if (!token) throw new Error('IMDSv2 answered without a token')
  const headers = { 'x-aws-ec2-metadata-token': token }
  const roleRes = await post(`${base}/latest/meta-data/iam/security-credentials/`, { method: 'GET', headers })
  if (!roleRes.ok) throw await failure('IMDS role lookup (is an instance role attached?)', roleRes)
  const role = (await roleRes.text()).split('\n')[0]?.trim()
  if (!role || !/^[\w+=,.@-]{1,128}$/.test(role)) throw new Error('IMDS answered without a role name')
  const credRes = await post(`${base}/latest/meta-data/iam/security-credentials/${role}`, { method: 'GET', headers })
  if (!credRes.ok) throw await failure('IMDS role credentials', credRes)
  const c = await credRes.json().catch(() => null)
  if (c?.Code !== 'Success' || !c.AccessKeyId || !c.SecretAccessKey || !c.Token) throw new Error('IMDS answered without credentials')
  return { AccessKeyId: c.AccessKeyId, SecretAccessKey: c.SecretAccessKey, SessionToken: c.Token }
}

const credentials = (env, region) => (env.AWS_WEB_IDENTITY_TOKEN_FILE?.trim() ? assumeRole(env, region) : instanceRole(env))

/** The KMS encryption context the blob was wrapped under. */
const contextApp = (env) => {
  const app = env.AGFN_KMS_CONTEXT_APP?.trim() || env.FLY_APP_NAME?.trim()
  if (!app) throw new Error('AGFN_KMS_CONTEXT_APP (or FLY_APP_NAME) is not set')
  return app
}

/** AWS Signature Version 4 for one KMS JSON call. */
function signedHeaders(creds, region, host, body, now) {
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '')
  const day = amzDate.slice(0, 8)
  const headers = {
    'content-type': 'application/x-amz-json-1.1',
    host,
    'x-amz-date': amzDate,
    'x-amz-security-token': creds.SessionToken,
    'x-amz-target': 'TrentService.Decrypt',
  }
  const names = Object.keys(headers).sort()
  const signed = names.join(';')
  const canonical = ['POST', '/', '', ...names.map((n) => `${n}:${headers[n]}`), '', signed, sha256(body)].join('\n')
  const scope = `${day}/${region}/kms/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')
  const key = ['aws4_request'].reduce(hmac, hmac(hmac(hmac(`AWS4${creds.SecretAccessKey}`, day), region), 'kms'))
  const signature = hmac(key, toSign).toString('hex')
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${creds.AccessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}` }
}

async function decrypt(env, region, creds, wrapped) {
  const url = new URL(env.AWS_ENDPOINT_URL_KMS?.trim() || `https://kms.${region}.amazonaws.com/`)
  const body = JSON.stringify({ CiphertextBlob: wrapped, EncryptionContext: { app: contextApp(env) } })
  const { host: _host, ...headers } = signedHeaders(creds, region, url.host, body, new Date())
  const res = await post(url, { headers, body })
  if (!res.ok) throw await failure('KMS Decrypt', res)
  const plain = (await res.json())?.Plaintext
  if (!plain) throw new Error('KMS answered without a key')
  return plain
}

async function main(env, argv) {
  const region = env.AWS_REGION?.trim() || 'us-east-1'
  const values = need(env, argv[0] ?? 'AGFN_MASTER_KEY_WRAPPED').split(',').map((v) => v.trim()).filter(Boolean)
  // Checked before any network call, so a missing setting fails fast and says which.
  const app = contextApp(env)
  if (!/^[\w.-]{1,128}$/.test(app)) throw new Error('AGFN_KMS_CONTEXT_APP must be a plain app name')
  const creds = await credentials(env, region)
  const keys = []
  for (const wrapped of values) keys.push(await decrypt(env, region, creds, wrapped))
  process.stdout.write(keys.join(','))
}

main(process.env, process.argv.slice(2)).catch((err) => {
  console.error(`kms-master-key: ${err.message}`)
  process.exit(1)
})
