#!/usr/bin/env node
// Prints the master key for AGFN_MASTER_KEY_COMMAND: unwraps AGFN_MASTER_KEY_WRAPPED with AWS KMS and writes base64 to
// stdout. Pass another variable's name to read that instead (comma-separated values come back comma-separated, for
// AGFN_OLD_MASTER_KEYS_COMMAND). Signs in with the Fly machine's OIDC token file, read fresh every run because it's
// short-lived, so no AWS secret sits next to the wrapped key. No dependencies: the runtime image has no AWS tools.
// The output is the key: nothing here logs it, and errors carry only a status and AWS's error type.

import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'

const TIMEOUT_MS = 2_400 // Two tries each of STS and KMS have to fit inside the 10 seconds a key command gets.

const need = (env, name) => {
  const v = env[name]?.trim()
  if (!v) throw new Error(`${name} is not set`)
  return v
}
const sha256 = (s) => createHash('sha256').update(s).digest('hex')
const hmac = (key, s) => createHmac('sha256', key).update(s).digest()

async function post(url, init) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { ...init, method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS) })
      // One fast retry, for AWS being briefly unwell. A refusal won't change.
      if (res.status < 500 || attempt === 2) return res
    } catch (err) {
      if (attempt === 2) throw new Error(`${new URL(url).host} did not answer (${err.name})`)
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
  const body = JSON.stringify({ CiphertextBlob: wrapped, EncryptionContext: { app: need(env, 'FLY_APP_NAME') } })
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
  const creds = await assumeRole(env, region)
  const keys = []
  for (const wrapped of values) keys.push(await decrypt(env, region, creds, wrapped))
  process.stdout.write(keys.join(','))
}

main(process.env, process.argv.slice(2)).catch((err) => {
  console.error(`kms-master-key: ${err.message}`)
  process.exit(1)
})
