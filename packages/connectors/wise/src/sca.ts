// Wise Strong Customer Authentication (SCA) for personal API tokens.
// Some endpoints (balance statements among them) answer 403 with a one-time token in `x-2fa-approval` and
// `x-2fa-approval-result: REJECTED`. The client signs that token with SHA256withRSA using the private key whose
// public half the customer uploaded in Wise (Settings → API tokens → Manage public keys), base64-encodes the
// signature, and repeats the request with `x-2fa-approval: <ott>` and `X-Signature: <signature>`.

import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
import { ConnectorError, type ConnectorErrorOptions } from '@agfn/connector-sdk'

/** A 403 that asked for an SCA signature. Carries the one-time token so the caller can sign and retry. */
export class WiseScaRequiredError extends ConnectorError {
  readonly oneTimeToken: string

  constructor(message: string, oneTimeToken: string, opts: ConnectorErrorOptions) {
    super('auth', message, { ...opts, code: 'SCA_REQUIRED' })
    this.oneTimeToken = oneTimeToken
  }
}

export function isScaRequired(e: unknown): e is WiseScaRequiredError {
  return e instanceof WiseScaRequiredError
}

/** Parse a PEM private key (PKCS#1 or PKCS#8). Throws invalid_input on anything else. */
export function loadPrivateKey(pem: string): KeyObject {
  try {
    const key = createPrivateKey({ key: pem, format: 'pem' })
    if (key.asymmetricKeyType !== 'rsa') throw new Error('not an RSA key')
    return key
  } catch (e) {
    throw new ConnectorError('invalid_input', 'SCA private key must be an RSA private key in PEM format', { provider: 'wise', cause: e })
  }
}

/** SHA256withRSA (PKCS#1 v1.5) over the one-time token's UTF-8 bytes, base64-encoded, as Wise documents. */
export function signOneTimeToken(oneTimeToken: string, key: KeyObject): string {
  return sign('sha256', Buffer.from(oneTimeToken, 'utf8'), key).toString('base64')
}

export function scaHeaders(oneTimeToken: string, key: KeyObject): Record<string, string> {
  return { 'x-2fa-approval': oneTimeToken, 'X-Signature': signOneTimeToken(oneTimeToken, key) }
}
