// Shopify webhooks and OAuth callback validation.
// Webhooks: X-Shopify-Hmac-Sha256 = base64(HMAC-SHA256(app secret, raw body)). Shopify doesn't sign a timestamp,
// so there is no staleness window to check; replays are absorbed by dedupe on X-Shopify-Event-Id.
// OAuth callback: hmac = hex(HMAC-SHA256(app secret, the other query params sorted and joined as k=v&k=v)).

import { createHash } from 'node:crypto'
import { ConnectorError, header, hmac, signatureMatches, type ConnectorWebhook, type WebhookOutcome, type WebhookRequest } from '@agfn/connector-sdk'
import { normalizeShop } from './client.ts'

function reject(msg: string): ConnectorError {
  return new ConnectorError('auth', `Shopify webhook rejected: ${msg}`, { provider: 'shopify' })
}

export function verifyShopifyWebhook(secret: string, req: WebhookRequest): void {
  const sig = header(req, 'x-shopify-hmac-sha256')
  if (!sig) throw reject('missing X-Shopify-Hmac-Sha256 header')
  if (!signatureMatches(hmac('sha256', secret, req.body), sig, 'base64')) throw reject('bad signature')
}

const SYNC_TOPICS = new Set(['orders/paid', 'orders/cancelled', 'refunds/create', 'disputes/create', 'disputes/update'])

export function interpretShopifyWebhook(req: WebhookRequest): WebhookOutcome {
  const topic = header(req, 'x-shopify-topic') ?? ''
  const shop = normalizeShop(header(req, 'x-shopify-shop-domain'))
  const id = header(req, 'x-shopify-event-id') ?? header(req, 'x-shopify-webhook-id')
  const dedupeKey = 'shopify:' + (id ?? createHash('sha256').update(topic + '\0' + req.body).digest('hex'))
  const out = (action: WebhookOutcome['action']): WebhookOutcome => ({
    action,
    dedupeKey,
    reason: topic || 'no topic',
    ...(shop ? { match: { field: 'shop', value: shop } } : {}),
  })
  if (topic === 'app/uninstalled') return out('disconnected')
  // Mandatory privacy webhooks. Aggregate reads payouts and balance transactions only, never customer records, so a
  // customer data request or erasure has nothing to return or delete (answered 200). shop/redact (48 hours after
  // uninstall) erases what we hold for the store.
  if (topic === 'customers/data_request' || topic === 'customers/redact') return out('ignore')
  if (topic === 'shop/redact') return out('erase')
  if (topic.startsWith('payouts/') || SYNC_TOPICS.has(topic)) return out('sync')
  return out('ignore')
}

export function shopifyWebhook(secret: string): ConnectorWebhook {
  return {
    verify: async (req) => verifyShopifyWebhook(secret, req),
    interpret: interpretShopifyWebhook,
  }
}

/**
 * Validate an install request from Shopify (the App Store or the admin's "Install app" opens our app URL with
 * ?shop&hmac&timestamp). Same signature scheme as the OAuth callback, plus a freshness check. Returns the shop.
 */
export function verifyShopifyInstall(query: Record<string, string>, secret: string, nowMs: number, maxAgeMs = 60 * 60_000): string {
  verifyShopifyOAuthCallback(query, secret)
  const ts = Number(query.timestamp) * 1000
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > maxAgeMs) throw new ConnectorError('auth', 'Shopify install link expired; install again from Shopify', { provider: 'shopify' })
  const shop = normalizeShop(query.shop)
  if (!shop) throw new ConnectorError('invalid_input', 'shop must be a *.myshopify.com domain', { provider: 'shopify' })
  return shop
}

/** Validate the OAuth redirect's query (hmac over the other params). Throws 'auth' when forged. */
export function verifyShopifyOAuthCallback(query: Record<string, string>, secret: string): void {
  const given = query.hmac
  if (!given) throw new ConnectorError('auth', 'Shopify OAuth callback has no hmac', { provider: 'shopify' })
  const message = Object.keys(query)
    .filter((k) => k !== 'hmac' && k !== 'signature')
    .sort()
    .map((k) => `${k}=${query[k]}`)
    .join('&')
  if (!signatureMatches(hmac('sha256', secret, message), given, 'hex')) {
    throw new ConnectorError('auth', 'Shopify OAuth callback hmac mismatch', { provider: 'shopify' })
  }
}
