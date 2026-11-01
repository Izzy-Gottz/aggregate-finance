// Google service-account auth (OAuth 2.0 JWT bearer grant, RFC 7523): sign a JWT with the service account's RSA key
// (RS256) whose claims are { iss: client_email, scope, aud: token endpoint, iat, exp ≤ 1 hour }, then POST it to the
// token endpoint for a short-lived access token. Scope is read-only Cloud Storage.

import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
import { ConnectorError, isRecord } from '@agfn/connector-sdk'

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GCS_READ_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_only'
export const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer'

export interface ServiceAccount {
  clientEmail: string
  privateKey: string
}

/** Accepts the downloaded key JSON (string or object). Throws invalid_input when it isn't a usable service-account key. */
export function parseServiceAccount(input: unknown): ServiceAccount {
  let v: unknown = input
  if (typeof input === 'string') {
    try {
      v = JSON.parse(input)
    } catch (e) {
      throw new ConnectorError('invalid_input', 'serviceAccountJson is not valid JSON', { provider: 'googleplay', cause: e })
    }
  }
  if (!isRecord(v) || typeof v.client_email !== 'string' || typeof v.private_key !== 'string') {
    throw new ConnectorError('invalid_input', 'serviceAccountJson must be a service-account key with client_email and private_key', { provider: 'googleplay' })
  }
  if (v.type !== undefined && v.type !== 'service_account') {
    throw new ConnectorError('invalid_input', 'serviceAccountJson is not a service-account key', { provider: 'googleplay' })
  }
  loadRsaKey(v.private_key)
  return { clientEmail: v.client_email, privateKey: v.private_key }
}

export function loadRsaKey(pem: string): KeyObject {
  let key: KeyObject
  try {
    key = createPrivateKey({ key: pem, format: 'pem' })
  } catch (e) {
    throw new ConnectorError('invalid_input', 'service-account private_key is not a readable PEM key', { provider: 'googleplay', cause: e })
  }
  if (key.asymmetricKeyType !== 'rsa') throw new ConnectorError('invalid_input', 'service-account private_key must be an RSA key', { provider: 'googleplay' })
  return key
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')

export function serviceAccountAssertion(sa: ServiceAccount, nowMs: number, key: KeyObject = loadRsaKey(sa.privateKey)): string {
  const iat = Math.floor(nowMs / 1000)
  const head = b64({ alg: 'RS256', typ: 'JWT' })
  const body = b64({ iss: sa.clientEmail, scope: GCS_READ_SCOPE, aud: GOOGLE_TOKEN_URL, iat, exp: iat + 3600 })
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), key).toString('base64url')
  return `${head}.${body}.${sig}`
}
