// Brex webhooks (https://developer.brex.com/guides/webhooks). Svix-style signing: headers Webhook-Id,
// Webhook-Timestamp (epoch seconds) and Webhook-Signature (space-separated "v1,<base64>" entries). The signed content
// is `${id}.${timestamp}.${rawBody}`, HMAC-SHA256 keyed with the base64-decoded secret from GET /v1/webhooks/secrets.
// During rotation Brex has two secrets; a match on any one is valid.
//
// Brex has no webhook for card or cash transactions. TRANSFER_PROCESSED / TRANSFER_FAILED and EXPENSE_PAYMENT_UPDATED
// mean cash or card activity changed, so they trigger a sync; data still comes from the API.

import { createHash } from 'node:crypto'
import { ConnectorError, hmac, header, isRecord, signatureMatches, systemClock, type Clock, type ConnectorWebhook, type WebhookOutcome, type WebhookRequest } from '@agfn/connector-sdk'

/** Brex's sample code allows 60 seconds either way. */
export const BREX_WEBHOOK_TOLERANCE_S = 60

function secretBytes(secret: string): Buffer {
  const s = secret.startsWith('whsec_') ? secret.slice(6) : secret
  return Buffer.from(s, 'base64')
}

const reject = (msg: string) => new ConnectorError('auth', `Brex webhook rejected: ${msg}`, { provider: 'brex' })

export function verifyBrexWebhook(req: WebhookRequest, secrets: string[], clock: Clock = systemClock, toleranceS = BREX_WEBHOOK_TOLERANCE_S): void {
  const id = header(req, 'webhook-id')
  const ts = header(req, 'webhook-timestamp')
  const sigs = header(req, 'webhook-signature')
  if (!id || !ts || !sigs) throw reject('missing Webhook-Id, Webhook-Timestamp or Webhook-Signature header')
  if (!/^\d+$/.test(ts)) throw reject('bad timestamp')
  if (Math.abs(clock.now() / 1000 - Number(ts)) > toleranceS) throw reject('timestamp outside tolerance')
  const content = `${id}.${ts}.${req.body}`
  const provided = sigs
    .split(' ')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('v1,'))
    .map((s) => s.slice(3))
  for (const secret of secrets) {
    const expected = hmac('sha256', secretBytes(secret), content)
    if (provided.some((p) => signatureMatches(expected, p, 'base64'))) return
  }
  throw reject('bad signature')
}

const SYNC_EVENTS = new Set(['TRANSFER_PROCESSED', 'TRANSFER_FAILED', 'EXPENSE_PAYMENT_UPDATED'])

/** Decide what a verified webhook means. match.field is 'companyId' when Brex includes company_id. */
export function interpretBrexWebhook(req: WebhookRequest): WebhookOutcome {
  const id = header(req, 'webhook-id')
  const dedupeKey = 'brex:' + (id ?? createHash('sha256').update(req.body, 'utf8').digest('hex'))
  let body: unknown
  try {
    body = JSON.parse(req.body)
  } catch {
    return { action: 'ignore', dedupeKey, reason: 'unparsable body' }
  }
  if (!isRecord(body) || typeof body.event_type !== 'string') return { action: 'ignore', dedupeKey, reason: 'not a Brex event' }
  const match = typeof body.company_id === 'string' ? { field: 'companyId', value: body.company_id } : undefined
  return {
    action: SYNC_EVENTS.has(body.event_type) ? 'sync' : 'ignore',
    dedupeKey,
    reason: body.event_type,
    ...(match ? { match } : {}),
  }
}

export function brexWebhook(secrets: string[], clock: Clock = systemClock): ConnectorWebhook {
  return {
    verify: async (req) => verifyBrexWebhook(req, secrets, clock),
    interpret: interpretBrexWebhook,
  }
}
