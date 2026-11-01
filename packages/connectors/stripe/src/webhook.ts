// Stripe webhooks. Verification follows Stripe's documented scheme: the Stripe-Signature header is
// "t=<unix seconds>,v1=<hex>[,v1=<hex>...][,v0=...]"; each v1 is HMAC-SHA256(secret, `${t}.${rawBody}`). Any v1
// matching any configured secret is accepted (Stripe sends several during secret rotation), and the timestamp must be
// within the tolerance (default 5 minutes) to stop replays. A verified event only triggers a sync; data comes from the API.

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

export const STRIPE_SIGNATURE_TOLERANCE_SEC = 300

export interface StripeWebhookOptions {
  /** Endpoint signing secret(s) (whsec_...). A Connect endpoint and an account endpoint have different secrets. */
  secrets: string[]
  toleranceSec?: number
  /**
   * For a direct (non-Connect) endpoint, events carry no `account` field; this is the account id the endpoint belongs
   * to, used as the match value. Connect events always use their own `account`.
   */
  accountId?: string
  clock?: Clock
}

function reject(msg: string): ConnectorError {
  return new ConnectorError('auth', `Stripe webhook rejected: ${msg}`, { provider: 'stripe' })
}

export function parseStripeSignature(value: string): { t?: number; v1: string[] } {
  let t: number | undefined
  const v1: string[] = []
  for (const part of value.split(',')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k === 't' && t === undefined && /^\d+$/.test(v)) t = Number(v)
    else if (k === 'v1' && v) v1.push(v)
  }
  return t === undefined ? { v1 } : { t, v1 }
}

/** Build a Stripe-Signature header value (for tests and local tooling). */
export function signStripePayload(secret: string, body: string, t: number): string {
  return `t=${t},v1=${hmac('sha256', secret, `${t}.${body}`).toString('hex')}`
}

export function verifyStripeSignature(req: WebhookRequest, opts: StripeWebhookOptions): void {
  const secrets = opts.secrets.filter((s) => s)
  if (!secrets.length) throw reject('no signing secret configured')
  const sig = header(req, 'stripe-signature')
  if (!sig) throw reject('missing Stripe-Signature header')
  const { t, v1 } = parseStripeSignature(sig)
  if (t === undefined || !v1.length) throw reject('malformed Stripe-Signature header')
  const tolerance = opts.toleranceSec ?? STRIPE_SIGNATURE_TOLERANCE_SEC
  const age = Math.floor((opts.clock ?? systemClock).now() / 1000) - t
  if (age > tolerance) throw reject('timestamp too old')
  if (age < -tolerance) throw reject('timestamp in the future')
  const payload = `${t}.${req.body}`
  for (const secret of secrets) {
    const expected = hmac('sha256', secret, payload)
    if (v1.some((s) => /^[0-9a-f]+$/i.test(s) && signatureMatches(expected, s, 'hex'))) return
  }
  throw reject('no matching v1 signature')
}

const SYNC_PREFIXES = ['charge.', 'payout.', 'invoice.', 'customer.subscription.', 'balance.']

/** Decide what a (verified) event means. Unknown types are ignored, never trusted. match.field is 'accountId'. */
export function interpretStripeEvent(req: WebhookRequest, fallbackAccountId?: string): WebhookOutcome {
  let body: unknown
  try {
    body = JSON.parse(req.body)
  } catch {
    return { action: 'ignore', dedupeKey: 'stripe:unparsable', reason: 'unparsable body' }
  }
  if (!isRecord(body) || typeof body.id !== 'string' || typeof body.type !== 'string') {
    return { action: 'ignore', dedupeKey: 'stripe:not-an-event', reason: 'not a Stripe event' }
  }
  const dedupeKey = `stripe:${body.id}`
  const account = typeof body.account === 'string' && body.account ? body.account : fallbackAccountId
  const match = account ? { field: 'accountId', value: account } : undefined
  const out = (action: WebhookOutcome['action'], reason: string): WebhookOutcome => ({
    action,
    dedupeKey,
    reason,
    ...(match ? { match } : {}),
  })
  const t = body.type
  if (t === 'account.application.deauthorized') return out('disconnected', t)
  if (SYNC_PREFIXES.some((p) => t.startsWith(p))) {
    if (!match) return { action: 'ignore', dedupeKey, reason: `${t}: no account on event and no accountId configured` }
    return out('sync', t)
  }
  return out('ignore', t)
}

export function stripeWebhook(opts: StripeWebhookOptions): ConnectorWebhook {
  return {
    verify: async (req) => verifyStripeSignature(req, opts),
    interpret: (req) => interpretStripeEvent(req, opts.accountId),
  }
}
