// Shopify session tokens (App Bridge `shopify.idToken()`): an HS256 JWT signed with the app's client secret, so an
// embedded admin page can call us without cookies. https://shopify.dev/docs/apps/build/authentication-authorization/session-tokens
import { createHmac, timingSafeEqual } from 'node:crypto'
import { ConnectorError } from '@agfn/connector-sdk'
import { normalizeShop } from './client.ts'

/** Seconds of clock skew allowed on exp/nbf (Shopify's own libraries allow a few seconds). */
const LEEWAY_S = 10

const b64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

/** Verify a session token for this app and return the shop it was issued for. Throws 'auth' when it isn't one. */
export function verifyShopifySessionToken(token: string, app: { clientId: string; secret: string }, nowMs: number): string {
  const bad = (why: string) => new ConnectorError('auth', `Shopify session token ${why}`, { provider: 'shopify' })
  const parts = token.split('.')
  if (parts.length !== 3) throw bad('is malformed')
  const [h, p, sig] = parts as [string, string, string]
  let header: Record<string, unknown>
  let claims: Record<string, unknown>
  try {
    header = JSON.parse(b64url(h).toString('utf8')) as Record<string, unknown>
    claims = JSON.parse(b64url(p).toString('utf8')) as Record<string, unknown>
  } catch {
    throw bad('is malformed')
  }
  if (header.alg !== 'HS256') throw bad('uses the wrong algorithm')
  const want = createHmac('sha256', app.secret).update(`${h}.${p}`).digest()
  const given = b64url(sig)
  if (given.length !== want.length || !timingSafeEqual(given, want)) throw bad('has a bad signature')
  const now = Math.floor(nowMs / 1000)
  if (typeof claims.exp !== 'number' || claims.exp + LEEWAY_S < now) throw bad('has expired')
  if (typeof claims.nbf === 'number' && claims.nbf - LEEWAY_S > now) throw bad('is not valid yet')
  const aud = claims.aud
  if (!(aud === app.clientId || (Array.isArray(aud) && aud.includes(app.clientId)))) throw bad('is for another app')
  const host = (u: unknown) => {
    try {
      return typeof u === 'string' ? new URL(u).hostname : undefined
    } catch {
      return undefined
    }
  }
  const shop = normalizeShop(host(claims.dest))
  if (!shop) throw bad('names no shop')
  if (host(claims.iss) !== shop) throw bad('was issued for another shop')
  return shop
}
