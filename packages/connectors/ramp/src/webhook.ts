// Ramp webhooks (https://docs.ramp.com/developer-api/v1/webhooks). `X-Ramp-Signature` is the bare hex
// HMAC-SHA256 of the raw body, keyed with the subscription secret (returned when the subscription is created).
// Ramp signs no timestamp, so there is no staleness window: replays are caught by dedupe on the event id
// (also sent as X-Ramp-Webhook-ID), which stays the same across retries. A verified event only triggers a sync.
//
// Subscription verification (`type: "webhooks.verification"` with a challenge) is answered by whoever registered
// the subscription; interpret() ignores it.

import { createHash } from 'node:crypto'
import { ConnectorError, header, hmac, isRecord, signatureMatches, type ConnectorWebhook, type WebhookOutcome, type WebhookRequest } from '@agfn/connector-sdk'

const reject = (msg: string) => new ConnectorError('auth', `Ramp webhook rejected: ${msg}`, { provider: 'ramp' })

export function verifyRampWebhook(req: WebhookRequest, secret: string): void {
  const sig = header(req, 'x-ramp-signature')
  if (!sig) throw reject('missing X-Ramp-Signature header')
  if (!/^[a-f0-9]{64}$/i.test(sig.trim())) throw reject('malformed signature')
  if (!signatureMatches(hmac('sha256', secret, req.body), sig, 'hex')) throw reject('bad signature')
}

/** match.field is 'businessId' (from the event's business_id). */
export function interpretRampWebhook(req: WebhookRequest): WebhookOutcome {
  const fallback = 'ramp:' + createHash('sha256').update(req.body, 'utf8').digest('hex')
  let body: unknown
  try {
    body = JSON.parse(req.body)
  } catch {
    return { action: 'ignore', dedupeKey: fallback, reason: 'unparsable body' }
  }
  if (!isRecord(body) || typeof body.type !== 'string') return { action: 'ignore', dedupeKey: fallback, reason: 'not a Ramp event' }
  const id = header(req, 'x-ramp-webhook-id') ?? (typeof body.id === 'string' ? body.id : undefined)
  const dedupeKey = id ? `ramp:${id}` : fallback
  const match = typeof body.business_id === 'string' ? { match: { field: 'businessId', value: body.business_id } } : {}
  const relevant = /^(transactions|bills|reimbursements)\./.test(body.type)
  return { action: relevant ? 'sync' : 'ignore', dedupeKey, reason: body.type, ...match }
}

export function rampWebhook(secret: string): ConnectorWebhook {
  return { verify: async (req) => verifyRampWebhook(req, secret), interpret: interpretRampWebhook }
}
