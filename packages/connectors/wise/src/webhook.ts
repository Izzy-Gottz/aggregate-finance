// Wise webhooks (https://docs.wise.com/guides/developer/webhooks/event-handling). Every delivery carries
// `X-Signature-SHA256`: a base64 RSA-SHA256 signature of the raw body made with Wise's private key; verify it with
// Wise's published public key (different PEMs for production and sandbox; pass the right one as
// opts.webhookPublicKey). Wise signs no timestamp, so replays are caught by dedupe on X-Delivery-Id.
// A verified balances#update / balances#credit event only triggers a sync.

import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
import { ConnectorError, header, isRecord, type ConnectorWebhook, type WebhookOutcome, type WebhookRequest } from '@agfn/connector-sdk'

const reject = (msg: string) => new ConnectorError('auth', `Wise webhook rejected: ${msg}`, { provider: 'wise' })

export function loadWisePublicKey(pem: string): KeyObject {
  try {
    return createPublicKey({ key: pem, format: 'pem' })
  } catch (e) {
    throw new ConnectorError('invalid_input', 'Wise webhook public key must be a PEM public key', { provider: 'wise', cause: e })
  }
}

export function verifyWiseWebhook(req: WebhookRequest, publicKey: KeyObject): void {
  const sig = header(req, 'x-signature-sha256')
  if (!sig) throw reject('missing X-Signature-SHA256 header')
  let ok = false
  try {
    ok = verify('sha256', Buffer.from(req.body, 'utf8'), publicKey, Buffer.from(sig, 'base64'))
  } catch {
    ok = false
  }
  if (!ok) throw reject('bad signature')
}

const SYNC_EVENTS = new Set(['balances#update', 'balances#credit', 'incoming-transfer#credited', 'transfers#state-change'])

/** match.field is 'profileId' (string). Test notifications (X-Test-Notification: true) are ignored. */
export function interpretWiseWebhook(req: WebhookRequest): WebhookOutcome {
  const delivery = header(req, 'x-delivery-id')
  const dedupeKey = 'wise:' + (delivery ?? createHash('sha256').update(req.body, 'utf8').digest('hex'))
  if (header(req, 'x-test-notification') === 'true') return { action: 'ignore', dedupeKey, reason: 'test notification' }
  let body: unknown
  try {
    body = JSON.parse(req.body)
  } catch {
    return { action: 'ignore', dedupeKey, reason: 'unparsable body' }
  }
  if (!isRecord(body) || typeof body.event_type !== 'string') return { action: 'ignore', dedupeKey, reason: 'not a Wise event' }
  const data = isRecord(body.data) ? body.data : {}
  const resource = isRecord(data.resource) ? data.resource : {}
  const pid = resource.profile_id ?? (resource.type === 'profile' ? resource.id : undefined)
  const match = typeof pid === 'number' || typeof pid === 'string' ? { match: { field: 'profileId', value: String(pid) } } : {}
  return { action: SYNC_EVENTS.has(body.event_type) ? 'sync' : 'ignore', dedupeKey, reason: body.event_type, ...match }
}

export function wiseWebhook(publicKeyPem: string): ConnectorWebhook {
  const key = loadWisePublicKey(publicKeyPem)
  return { verify: async (req) => verifyWiseWebhook(req, key), interpret: interpretWiseWebhook }
}
