// PayPal webhooks. PayPal signs with a certificate chain; instead of re-implementing that, we use PayPal's own
// POST /v1/notifications/verify-webhook-signature, passing the five PAYPAL-* transmission headers, our webhook id
// and the event exactly as received. Only verification_status SUCCESS is accepted. A verified webhook just tells
// us which connection to sync; data always comes from the API.

import { createHash } from 'node:crypto'
import { ConnectorError, header, isRecord, type ConnectorWebhook, type WebhookOutcome, type WebhookRequest } from '@agfn/connector-sdk'
import type { PayPalClient, PayPalCredentials } from './client.ts'
import type { PayPalWebhookEvent } from './types.ts'

export interface PayPalWebhookOptions {
  /** Webhook id from the PayPal app's webhook settings. */
  webhookId: string
  /** Credentials of the REST app that owns the webhook (verify must be called by that app). */
  app: PayPalCredentials
}

function reject(msg: string): ConnectorError {
  return new ConnectorError('auth', `PayPal webhook rejected: ${msg}`, { provider: 'paypal' })
}

export async function verifyPayPalWebhook(client: PayPalClient, o: PayPalWebhookOptions, req: WebhookRequest): Promise<void> {
  const h = (n: string) => header(req, n)
  const authAlgo = h('paypal-auth-algo')
  const certUrl = h('paypal-cert-url')
  const transmissionId = h('paypal-transmission-id')
  const transmissionSig = h('paypal-transmission-sig')
  const transmissionTime = h('paypal-transmission-time')
  if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime) throw reject('missing PAYPAL-* headers')
  try {
    JSON.parse(req.body)
  } catch {
    throw reject('body is not JSON')
  }
  // The event goes back to PayPal byte-for-byte (re-serializing parsed JSON can change number/unicode formatting
  // and make verification fail), so the request body is assembled around the raw text.
  const head = JSON.stringify({
    auth_algo: authAlgo,
    cert_url: certUrl,
    transmission_id: transmissionId,
    transmission_sig: transmissionSig,
    transmission_time: transmissionTime,
    webhook_id: o.webhookId,
  })
  const payload = `${head.slice(0, -1)},"webhook_event":${req.body}}`
  let res: { verification_status?: string }
  try {
    res = await client.request<{ verification_status?: string }>(o.app, {
      method: 'POST',
      path: '/v1/notifications/verify-webhook-signature',
      body: payload,
      headers: { 'content-type': 'application/json' },
      // A read-only check; safe to retry.
      idempotent: true,
    })
  } catch (e) {
    // PayPal answers 400 for a malformed or forged signature request: that's "not authentic", not an outage.
    if (e instanceof ConnectorError && e.kind === 'invalid_input') throw reject('PayPal could not verify the signature')
    throw e
  }
  if (res.verification_status !== 'SUCCESS') throw reject(`verification_status ${res.verification_status ?? 'missing'}`)
}

/** PayPal's account id (payer id / merchant id) when the event carries it. */
function merchantId(resource: Record<string, unknown> | undefined): string | undefined {
  if (!resource) return undefined
  const payee = isRecord(resource.payee) ? resource.payee : undefined
  const candidates = [payee?.merchant_id, resource.merchant_id, resource.payee_merchant_id]
  for (const c of candidates) if (typeof c === 'string' && c) return c
  return undefined
}

/**
 * match.field is 'accountId' when the event names the PayPal account, else 'webhookId' (the webhook belongs to one
 * REST app, and connect() stores that id in conn.config.webhookId).
 */
export function interpretPayPalWebhook(req: WebhookRequest, webhookId?: string): WebhookOutcome {
  let body: PayPalWebhookEvent
  try {
    body = JSON.parse(req.body) as PayPalWebhookEvent
  } catch {
    return { action: 'ignore', dedupeKey: 'paypal:' + createHash('sha256').update(req.body).digest('hex'), reason: 'unparsable body' }
  }
  const dedupeKey =
    'paypal:' + (isRecord(body) && typeof body.id === 'string' ? body.id : createHash('sha256').update(req.body).digest('hex'))
  if (!isRecord(body) || typeof body.event_type !== 'string') return { action: 'ignore', dedupeKey, reason: 'not a PayPal event' }
  const acct = merchantId(isRecord(body.resource) ? body.resource : undefined)
  const match = acct ? { field: 'accountId', value: acct } : webhookId ? { field: 'webhookId', value: webhookId } : undefined
  const t: string = body.event_type
  const out = (action: WebhookOutcome['action']): WebhookOutcome => ({ action, dedupeKey, reason: t, ...(match ? { match } : {}) })
  if (t === 'MERCHANT.PARTNER-CONSENT.REVOKED' || t === 'IDENTITY.AUTHORIZATION-CONSENT.REVOKED') return out('disconnected')
  if (
    t.startsWith('PAYMENT.CAPTURE.') ||
    t.startsWith('PAYMENT.SALE.') ||
    t.startsWith('PAYMENT.PAYOUTSBATCH.') ||
    t.startsWith('PAYMENT.PAYOUTS-ITEM.') ||
    t.startsWith('CUSTOMER.DISPUTE.') ||
    t.startsWith('INVOICING.INVOICE.') ||
    t.startsWith('CHECKOUT.ORDER.COMPLETED') ||
    t.startsWith('BILLING.SUBSCRIPTION.PAYMENT.')
  ) {
    return out('sync')
  }
  return out('ignore')
}

export function payPalWebhook(client: PayPalClient, o: PayPalWebhookOptions): ConnectorWebhook {
  return {
    verify: (req) => verifyPayPalWebhook(client, o, req),
    interpret: (req) => interpretPayPalWebhook(req, o.webhookId),
  }
}
