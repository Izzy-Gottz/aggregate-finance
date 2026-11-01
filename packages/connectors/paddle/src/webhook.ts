// Paddle webhooks (developer.paddle.com/webhooks/signature-verification): the Paddle-Signature header is
// `ts=<unix seconds>;h1=<hex>`, where h1 = HMAC-SHA256(endpoint secret key, `${ts}:${rawBody}`). Paddle's SDKs reject
// events more than 5 seconds old; we default to that and allow a wider window via options (clock skew, queues).
// Several h1 values may appear during secret rotation; any match is accepted.
//
// Matching: Paddle event payloads carry no seller id, and each notification destination has its own secret, so the
// connection is found by `webhookRef` (a short hash of the secret, stored in conn.config at connect time).

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
import type { PaddleEventBody } from './types.ts'

export const PADDLE_DEFAULT_TOLERANCE_S = 5

/** Non-secret id derived from the webhook secret, used to route a verified event to its connection. */
export function paddleWebhookRef(secret: string): string {
  return 'pwh_' + createHash('sha256').update('agfn-paddle-webhook\0' + secret).digest('hex').slice(0, 16)
}

export interface PaddleWebhookOptions {
  secret: string
  toleranceSeconds?: number
  clock?: Clock
}

export function verifyPaddleSignature(req: WebhookRequest, opts: PaddleWebhookOptions): void {
  const sig = header(req, 'paddle-signature')
  if (!sig) throw reject('missing Paddle-Signature header')
  let ts: string | undefined
  const h1: string[] = []
  for (const part of sig.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k === 'ts') ts = v
    else if (k === 'h1') h1.push(v)
  }
  if (!ts || !/^\d+$/.test(ts) || h1.length === 0) throw reject('malformed Paddle-Signature header')
  const now = (opts.clock ?? systemClock).now()
  const tolerance = (opts.toleranceSeconds ?? PADDLE_DEFAULT_TOLERANCE_S) * 1000
  if (Math.abs(now - Number(ts) * 1000) > tolerance) throw reject('timestamp outside tolerance')
  const expected = hmac('sha256', opts.secret, `${ts}:${req.body}`)
  if (!h1.some((h) => /^[0-9a-f]+$/i.test(h) && signatureMatches(expected, h, 'hex'))) throw reject('bad signature')
}

function reject(msg: string): ConnectorError {
  return new ConnectorError('auth', `Paddle webhook rejected: ${msg}`, { provider: 'paddle' })
}

const SYNC_PREFIXES = ['transaction.', 'subscription.', 'adjustment.']

export function interpretPaddleWebhook(req: WebhookRequest, webhookRef: string): WebhookOutcome {
  let body: PaddleEventBody | undefined
  try {
    const parsed: unknown = JSON.parse(req.body)
    body = isRecord(parsed) ? (parsed as PaddleEventBody) : undefined
  } catch {
    body = undefined
  }
  const fallback = 'paddle:' + createHash('sha256').update(req.body, 'utf8').digest('hex')
  if (!body || typeof body.event_type !== 'string') return { action: 'ignore', dedupeKey: fallback, reason: 'not a Paddle event' }
  const dedupeKey = typeof body.event_id === 'string' ? `paddle:${body.event_id}` : fallback
  const match = { field: 'webhookRef', value: webhookRef }
  const t = body.event_type
  if (SYNC_PREFIXES.some((p) => t.startsWith(p))) return { action: 'sync', dedupeKey, reason: t, match }
  return { action: 'ignore', dedupeKey, reason: t, match }
}

export function paddleWebhook(opts: PaddleWebhookOptions): ConnectorWebhook {
  const ref = paddleWebhookRef(opts.secret)
  return {
    async verify(req) {
      verifyPaddleSignature(req, opts)
    },
    interpret: (req) => interpretPaddleWebhook(req, ref),
  }
}
