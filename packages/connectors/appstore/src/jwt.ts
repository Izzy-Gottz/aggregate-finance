// App Store Connect API tokens (developer.apple.com, "Generating tokens for API requests"): an ES256 JWT with header
// { alg: 'ES256', kid: <key id>, typ: 'JWT' } and payload { iss: <issuer id>, iat, exp (≤ 20 minutes after iat),
// aud: 'appstoreconnect-v1' }, signed with the team key's .p8 (EC P-256) private key. JOSE requires the raw r||s
// (ieee-p1363) signature encoding, not DER.

import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
import { ConnectorError } from '@agfn/connector-sdk'

export const APPSTORE_AUDIENCE = 'appstoreconnect-v1'
/** Apple rejects tokens that live longer than 20 minutes. */
export const MAX_TOKEN_TTL_S = 20 * 60

export interface AppStoreKey {
  issuerId: string
  keyId: string
  /** PKCS#8 PEM (the downloaded AuthKey_XXXXXXXXXX.p8). */
  privateKey: string
}

/** Parse the .p8 PEM, accepting keys pasted with literal "\n" sequences. Throws invalid_input if it isn't EC P-256. */
export function loadP8(pem: string): KeyObject {
  const text = pem.includes('\\n') && !pem.includes('\n') ? pem.replace(/\\n/g, '\n') : pem
  let key: KeyObject
  try {
    key = createPrivateKey({ key: text.trim(), format: 'pem' })
  } catch (e) {
    throw new ConnectorError('invalid_input', 'privateKey is not a readable .p8 PEM key', { provider: 'appstore', cause: e })
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new ConnectorError('invalid_input', 'privateKey must be an App Store Connect EC P-256 (.p8) key', { provider: 'appstore' })
  }
  return key
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')

export function appStoreJwt(k: AppStoreKey, nowMs: number, ttlSeconds = 15 * 60, key: KeyObject = loadP8(k.privateKey)): string {
  const iat = Math.floor(nowMs / 1000)
  const exp = iat + Math.min(MAX_TOKEN_TTL_S, Math.max(60, ttlSeconds))
  const head = b64({ alg: 'ES256', kid: k.keyId, typ: 'JWT' })
  const body = b64({ iss: k.issuerId, iat, exp, aud: APPSTORE_AUDIENCE })
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  return `${head}.${body}.${sig}`
}
