// Coinbase Developer Platform (CDP) secret API keys, for self-hosters (Coinbase isn't issuing new OAuth apps to
// everyone). Each request carries its own short JWT (docs.cdp.coinbase.com/coinbase-app/authentication-authorization/
// api-key-authentication): header { alg, kid: <key name>, nonce, typ: 'JWT' }, payload { sub: <key name>, iss: 'cdp',
// nbf, exp: nbf + 120, uri: 'GET api.coinbase.com/v2/accounts' } (method, host and path, no query string).
// Two key kinds: Ed25519 (the default now: a base64 secret of 64 bytes, seed then public key; alg EdDSA) and ECDSA
// P-256 (an "EC PRIVATE KEY" PEM; alg ES256 with the raw r||s signature JOSE wants).

import { createPrivateKey, randomBytes, sign, type KeyObject } from 'node:crypto'
import { ConnectorError } from '@agfn/connector-sdk'

export interface CoinbaseApiKey {
  /** The key's name or id: "organizations/{org}/apiKeys/{id}" (ECDSA) or a UUID (Ed25519). */
  name: string
  privateKey: string
}

export const JWT_TTL_S = 120

/** PKCS#8 wrapper for a raw Ed25519 seed (RFC 8410). */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

export function loadCoinbaseKey(secret: string): { key: KeyObject; alg: 'EdDSA' | 'ES256' } {
  const text = (secret.includes('\\n') && !secret.includes('\n') ? secret.replace(/\\n/g, '\n') : secret).trim()
  const bad = (cause?: unknown) =>
    new ConnectorError('invalid_input', 'That isn’t a Coinbase API key secret. Paste the private key shown when the key was created.', { provider: 'coinbase', forUser: true, ...(cause ? { cause } : {}) })
  if (text.startsWith('-----BEGIN')) {
    let key: KeyObject
    try {
      key = createPrivateKey({ key: text, format: 'pem' })
    } catch (e) {
      throw bad(e)
    }
    if (key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1') return { key, alg: 'ES256' }
    if (key.asymmetricKeyType === 'ed25519') return { key, alg: 'EdDSA' }
    throw bad()
  }
  const raw = /^[A-Za-z0-9+/=_-]+$/.test(text) ? Buffer.from(text, 'base64') : Buffer.alloc(0)
  if (raw.length !== 64 && raw.length !== 32) throw bad()
  try {
    return { key: createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, raw.subarray(0, 32)]), format: 'der', type: 'pkcs8' }), alg: 'EdDSA' }
  } catch (e) {
    throw bad(e)
  }
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')

export function coinbaseJwt(k: CoinbaseApiKey, method: string, host: string, path: string, nowMs: number, loaded = loadCoinbaseKey(k.privateKey), nonce = randomBytes(16).toString('hex')): string {
  const nbf = Math.floor(nowMs / 1000)
  const head = b64({ alg: loaded.alg, kid: k.name, nonce, typ: 'JWT' })
  const body = b64({ sub: k.name, iss: 'cdp', nbf, exp: nbf + JWT_TTL_S, uri: `${method.toUpperCase()} ${host}${path.split('?')[0]}` })
  const data = Buffer.from(`${head}.${body}`)
  const sig = loaded.alg === 'EdDSA' ? sign(null, data, loaded.key) : sign('sha256', data, { key: loaded.key, dsaEncoding: 'ieee-p1363' })
  return `${head}.${body}.${sig.toString('base64url')}`
}
