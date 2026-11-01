// Mercury webhooks (https://docs.mercury.com/reference/webhooks). Header `Mercury-Signature: t=<unix seconds>,v1=<hex>`
// where v1 = HMAC-SHA256(endpoint secret, `${t}.${rawBody}`). Mercury recommends rejecting timestamps older than
// 5 minutes. Delivery is at-least-once; the event id is the dedupe key. The body is the Events API shape
// (resourceType, resourceId, operationType, mergePatch). A verified event only triggers a sync.

import { createHash } from 'node:crypto'
import { ConnectorError, header, hmac, isRecord, signatureMatches, systemClock, type Clock, type ConnectorWebhook, type WebhookOutcome, type WebhookRequest } from '@agfn/connector-sdk'

export const MERCURY_WEBHOOK_TOLERANCE_S = 300

const reject = (msg: string) => new ConnectorError('auth', `Mercury webhook rejected: ${msg}`, { provider: 'mercury' })

export function verifyMercuryWebhook(req: WebhookRequest, secret: string, clock: Clock = systemClock, toleranceS = MERCURY_WEBHOOK_TOLERANCE_S): void {
  const h = header(req, 'mercury-signature')
  if (!h) throw reject('missing Mercury-Signature header')
  let t: string | undefined
  const sigs: string[] = []
  for (const part of h.split(',')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k === 't') t = v
    else if (k === 'v1') sigs.push(v)
  }
  if (!t || !/^\d+$/.test(t) || !sigs.length) throw reject('malformed Mercury-Signature header')
  if (Math.abs(clock.now() / 1000 - Number(t)) > toleranceS) throw reject('timestamp outside tolerance')
  const expected = hmac('sha256', secret, `${t}.${req.body}`)
  if (!sigs.some((s) => signatureMatches(expected, s, 'hex'))) throw reject('bad signature')
}

/**
 * match.field is 'accountIds' (conn.config.accountIds is a list: the server should match connections whose list
 * contains the value). Balance events carry the account id as resourceId; transaction events carry it in
 * mergePatch.accountId when present. Without an account id, there is no match and the server decides.
 */
export function interpretMercuryWebhook(req: WebhookRequest): WebhookOutcome {
  let body: unknown
  try {
    body = JSON.parse(req.body)
  } catch {
    return { action: 'ignore', dedupeKey: 'mercury:' + createHash('sha256').update(req.body).digest('hex'), reason: 'unparsable body' }
  }
  if (!isRecord(body) || typeof body.resourceType !== 'string') {
    return { action: 'ignore', dedupeKey: 'mercury:' + createHash('sha256').update(req.body).digest('hex'), reason: 'not a Mercury event' }
  }
  const dedupeKey = 'mercury:' + (typeof body.id === 'string' ? body.id : createHash('sha256').update(req.body).digest('hex'))
  const rt = body.resourceType
  const patch = isRecord(body.mergePatch) ? body.mergePatch : {}
  const isBalance = /Account$/.test(rt) || /account/i.test(rt)
  const accountId = typeof patch.accountId === 'string' ? patch.accountId : isBalance && typeof body.resourceId === 'string' ? body.resourceId : undefined
  const action: WebhookOutcome['action'] = rt === 'transaction' || isBalance ? 'sync' : 'ignore'
  return {
    action,
    dedupeKey,
    reason: `${rt}.${typeof body.operationType === 'string' ? body.operationType : '?'}`,
    ...(accountId ? { match: { field: 'accountIds', value: accountId } } : {}),
  }
}

export function mercuryWebhook(secret: string, clock: Clock = systemClock): ConnectorWebhook {
  return { verify: async (req) => verifyMercuryWebhook(req, secret, clock), interpret: interpretMercuryWebhook }
}
