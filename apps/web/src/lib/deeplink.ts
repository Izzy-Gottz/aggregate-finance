// A "connect this" link (#/?d=connect:stripe, e.g. the Stripe App's install button) survives sign-in and first-run
// setup: kept here, carried in the sign-in link, then opened once there's a workspace to connect it to.
// Only ever connect:<known connector> — never any other route.
import { parseHash } from '../app/router.ts'

/** The connectors a link may open. Anything else is ignored. */
const KEYS = new Set([
  'adsense', 'youtube', 'pinterest', 'squarespace', 'ownerrez', 'whop', 'mollie', 'wix', 'appstore', 'billcom', 'brex', 'carta', 'chargebee', 'coinbase', 'deel', 'expensify', 'files', 'finch', 'googleplay', 'gumroad', 'justworks', 'lemonsqueezy', 'lightspeed', 'mercury', 'freshbooks', 'patreon', 'harvest',
  'paddle', 'paypal', 'plaid', 'polar', 'quickbooks', 'ramp', 'revenuecat', 'rippling', 'shopify', 'simplefin', 'square', 'stripe', 'sumup', 'wefunder', 'wise', 'woocommerce', 'xero',
])
const KEY = 'agfn.connect-intent'
const TTL = 24 * 60 * 60 * 1000

/** The connector a hash asks to open: exactly one connect:<known key> drawer, else null. */
export function connectIntent(hash: string): string | null {
  const { stack } = parseHash(hash)
  const v = stack.length === 1 ? stack[0] : undefined
  return v?.kind === 'connect' && v.key && KEYS.has(v.key) ? v.key : null
}

export function keepIntent(key: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ key, at: Date.now() }))
  } catch {
    /* private mode: the sign-in link still carries it */
  }
}

export function peekIntent(): string | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { key?: string; at?: number } | null
    return v?.key && KEYS.has(v.key) && v.at && Date.now() - v.at < TTL ? v.key : null
  } catch {
    return null
  }
}

export function takeIntent(): string | null {
  const k = peekIntent()
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
  return k
}

/** Where a sign-in link (email, Google, Apple) brings someone back: the kept connector's drawer, or the app. */
export const signInCallback = (): string => {
  const k = peekIntent()
  return k ? `/#/?d=connect:${k}` : '/#/'
}
