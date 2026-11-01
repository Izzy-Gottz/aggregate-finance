// Webhooks: signature checks and a common outcome shape. A webhook never carries data we trust on its own;
// it only tells the sync engine which connection to sync (or mark for re-auth). The data comes from the API.

import { createHmac, timingSafeEqual } from 'node:crypto'

export interface WebhookRequest {
  /** Header names lower-cased. */
  headers: Record<string, string | undefined>
  /** Exact raw body; signatures are computed over these bytes. */
  body: string
}

export interface WebhookOutcome {
  /** Which connection(s) this concerns, as a provider-side id (Plaid item_id, Stripe account id, ...). */
  match?: { field: string; value: string }
  /**
   * sync: pull now. needs_reauth: the login broke, data stops until the person reconnects. disconnected: access was
   * revoked. repaired: the login healed on its own (clear reconnect prompts, then sync). reconnect_soon: still working,
   * but consent ends soon (ask the person to reconnect). new_accounts: the person opened accounts we don't read yet
   * (offer reconnect with account selection). erase: the provider asks us to delete what we hold for the matched
   * connection(s) (Shopify shop/redact): stop access and delete the provider's raw records. ignore: nothing to do.
   */
  action: 'sync' | 'needs_reauth' | 'disconnected' | 'repaired' | 'reconnect_soon' | 'new_accounts' | 'erase' | 'ignore'
  /** Stable id for dedupe (provider event id or hash of body); store in connector_webhook_receipts. */
  dedupeKey: string
  reason?: string
}

export function hmac(algorithm: 'sha256' | 'sha1' | 'sha512', secret: string | Buffer, data: string): Buffer {
  return createHmac(algorithm, secret).update(data, 'utf8').digest()
}

/** Constant-time compare of an expected digest with a provided hex/base64 signature. */
export function signatureMatches(expected: Buffer, provided: string, encoding: 'hex' | 'base64'): boolean {
  let got: Buffer
  try {
    got = Buffer.from(provided.trim(), encoding)
  } catch {
    return false
  }
  return got.length === expected.length && got.length > 0 && timingSafeEqual(got, expected)
}

export function header(req: WebhookRequest, name: string): string | undefined {
  return req.headers[name.toLowerCase()]
}

/**
 * Generic webhook hook a connector exposes as `connector.webhook`. The server mounts POST /api/webhooks/:key,
 * calls verify (throws ConnectorError 'auth' when not authentic), then interpret, then recordWebhookReceipt.
 */
export interface ConnectorWebhook {
  verify(req: WebhookRequest): Promise<void>
  interpret(req: WebhookRequest): WebhookOutcome
}
