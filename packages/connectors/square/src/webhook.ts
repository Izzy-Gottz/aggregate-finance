// Square webhooks: x-square-hmacsha256-signature = base64(HMAC-SHA256(signatureKey, notificationUrl + rawBody)).
// The notification URL must be byte-identical to the one registered on the subscription. Square doesn't sign a
// separate timestamp header; the signed body's created_at is checked against a tolerance to refuse old replays.

import { createHash } from 'node:crypto'
import {
  ConnectorError,
  header,
  hmac,
  isRecord,
  signatureMatches,
  systemClock,
  type Clock,
  type ConnectorWebhook,
  type WebhookOutcome,
  type WebhookRequest,
} from '@agfn/connector-sdk'
import type { SquareWebhookBody } from './types.ts'

export interface SquareWebhookOptions {
  signatureKey: string
  /** Exactly the notification URL registered with Square. */
  notificationUrl: string
  /** Reject events whose signed created_at is older than this (default 72h; Square retries for up to 24h). */
  toleranceMs?: number
}

function reject(msg: string): ConnectorError {
  return new ConnectorError('auth', `Square webhook rejected: ${msg}`, { provider: 'square' })
}

export function verifySquareWebhook(o: SquareWebhookOptions, req: WebhookRequest, clock: Clock = systemClock): void {
  const sig = header(req, 'x-square-hmacsha256-signature')
  if (!sig) throw reject('missing x-square-hmacsha256-signature header')
  const expected = hmac('sha256', o.signatureKey, o.notificationUrl + req.body)
  if (!signatureMatches(expected, sig, 'base64')) throw reject('bad signature')
  let created: number | undefined
  try {
    const b = JSON.parse(req.body) as SquareWebhookBody
    created = typeof b?.created_at === 'string' ? Date.parse(b.created_at) : undefined
  } catch {
    throw reject('body is not JSON')
  }
  if (created !== undefined && !Number.isNaN(created) && clock.now() - created > (o.toleranceMs ?? 72 * 3_600_000)) {
    throw reject('webhook too old')
  }
}

export function interpretSquareWebhook(req: WebhookRequest): WebhookOutcome {
  const hash = () => 'square:' + createHash('sha256').update(req.body).digest('hex')
  let b: SquareWebhookBody
  try {
    b = JSON.parse(req.body) as SquareWebhookBody
  } catch {
    return { action: 'ignore', dedupeKey: hash(), reason: 'unparsable body' }
  }
  if (!isRecord(b) || typeof b.type !== 'string') return { action: 'ignore', dedupeKey: hash(), reason: 'not a Square event' }
  const t: string = b.type
  const dedupeKey = typeof b.event_id === 'string' ? `square:${b.event_id}` : hash()
  const match = typeof b.merchant_id === 'string' && b.merchant_id ? { field: 'merchantId', value: b.merchant_id } : undefined
  const out = (action: WebhookOutcome['action']): WebhookOutcome => ({ action, dedupeKey, reason: t, ...(match ? { match } : {}) })
  if (t === 'oauth.authorization.revoked') return out('disconnected')
  if (/^(payout|payment|refund|dispute|invoice)\./.test(t)) return out('sync')
  return out('ignore')
}

export function squareWebhook(o: SquareWebhookOptions, clock?: Clock): ConnectorWebhook {
  return {
    verify: async (req) => verifySquareWebhook(o, req, clock),
    interpret: interpretSquareWebhook,
  }
}
