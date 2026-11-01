// Lemon Squeezy webhooks (docs.lemonsqueezy.com/help/webhooks/signing-requests): X-Signature is the hex
// HMAC-SHA256 of the raw body keyed with the webhook's signing secret. There is no timestamp in the scheme, so replay
// protection relies on dedupe (the server's webhook receipts) and on webhooks only ever triggering a sync.

import { createHash } from 'node:crypto'
import {
  ConnectorError,
  header,
  hmac,
  isRecord,
  signatureMatches,
  type ConnectorWebhook,
  type WebhookOutcome,
  type WebhookRequest,
} from '@agfn/connector-sdk'
import type { LsWebhookBody } from './types.ts'

export function verifyLemonSqueezySignature(req: WebhookRequest, secret: string): void {
  const sig = header(req, 'x-signature')
  if (!sig) throw reject('missing X-Signature header')
  if (!/^[0-9a-f]{64}$/i.test(sig.trim())) throw reject('malformed X-Signature header')
  if (!signatureMatches(hmac('sha256', secret, req.body), sig, 'hex')) throw reject('bad signature')
}

function reject(msg: string): ConnectorError {
  return new ConnectorError('auth', `Lemon Squeezy webhook rejected: ${msg}`, { provider: 'lemonsqueezy' })
}

export function interpretLemonSqueezyWebhook(req: WebhookRequest): WebhookOutcome {
  const dedupeKey = 'lemonsqueezy:' + createHash('sha256').update(req.body, 'utf8').digest('hex')
  let body: LsWebhookBody | undefined
  try {
    const parsed: unknown = JSON.parse(req.body)
    body = isRecord(parsed) ? (parsed as LsWebhookBody) : undefined
  } catch {
    body = undefined
  }
  const event = body?.meta?.event_name
  if (typeof event !== 'string') return { action: 'ignore', dedupeKey, reason: 'not a Lemon Squeezy event' }
  const store = body?.data?.attributes?.store_id
  const match = store !== undefined && store !== null && String(store) !== '' ? { field: 'storeId', value: String(store) } : undefined
  const action: WebhookOutcome['action'] = event.startsWith('order_') || event.startsWith('subscription_') ? 'sync' : 'ignore'
  return { action, dedupeKey, reason: event, ...(match ? { match } : {}) }
}

export function lemonSqueezyWebhook(secret: string): ConnectorWebhook {
  return {
    async verify(req) {
      verifyLemonSqueezySignature(req, secret)
    },
    interpret: interpretLemonSqueezyWebhook,
  }
}
