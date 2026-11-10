// BigCommerce single-click app: the install, load and uninstall callbacks a Marketplace app answers.
//
// Install: BigCommerce opens our auth callback (inside its control panel) with ?code&scope&context; we trade the code for
// the store's access token at login.bigcommerce.com. Load, uninstall and remove_user arrive with ?signed_payload_jwt,
// an HS256 JWT signed with the app's client secret (BigCommerce's own app SDKs verify it that way), naming the store
// (sub = stores/{hash}) and the user who clicked.
//
// READ-ONLY. The app asks for Orders and Information & Settings read-only and nothing else. Unlike a pasted token, an
// app's token comes back with its scopes, so a grant with any scope that can write is refused here, before it's stored.
// The sync client is GET-only on top of that (client.ts).
//
// Built from BigCommerce's public docs (Single-click app OAuth flow; Single-click app callback handlers). Not yet run
// against a real install.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { ConnectorError, isRecord, type FetchLike } from '@agfn/connector-sdk'
import type { BigCommerceSecret } from './connector.ts'

const PROVIDER = 'bigcommerce'
export const BIGCOMMERCE_TOKEN_URL = 'https://login.bigcommerce.com/oauth2/token'
/** What the app profile asks for. Every other scope stays at None. */
export const BIGCOMMERCE_APP_SCOPES = ['store_v2_orders_read_only', 'store_v2_information_read_only'] as const
/** Scopes an app may hold and still only read: any `*_read_only`, and the installer's basic profile BigCommerce adds. */
const READ_SCOPE = /^(?:[a-z0-9_]+_read_only|users_basic_information)$/
const STORE_HASH = /^[a-z0-9]{4,32}$/

export const BIGCOMMERCE_WRITE_SCOPE = 'This BigCommerce install granted Aggregate permission to change the store, which it never asks for, so it wasn’t connected. Uninstall Aggregate in BigCommerce (Apps → My Apps) and install it again.'

export interface BigCommerceApp {
  clientId: string
  clientSecret: string
  /** The auth callback registered in the app profile; the token request must send the same one. */
  authCallback: string
}

export interface BigCommerceInstall {
  secret: BigCommerceSecret
  scopes: string[]
  /** Who installed it (BigCommerce's user email), lowercased; the Aggregate person who links it must match. */
  userEmail: string | null
}

export interface BigCommercePayload {
  storeHash: string
  userEmail: string | null
  ownerEmail: string | null
}

const bad = (what: string) => new ConnectorError('permanent', `That request from BigCommerce ${what}.`, { provider: PROVIDER })
const email = (v: unknown): string | null => (isRecord(v) && typeof v.email === 'string' && v.email.includes('@') ? v.email.trim().toLowerCase() : null)

/** The store hash in a `stores/{hash}` context or subject, or null. */
export function storeHashOf(context: unknown): string | null {
  const m = typeof context === 'string' ? /^stores\/([a-z0-9]+)$/.exec(context) : null
  return m && STORE_HASH.test(m[1]!) ? m[1]! : null
}

/** True when every scope only reads. An empty grant isn't read-only, it's nothing: refused too. */
export function readOnlyScopes(scopes: string[]): boolean {
  return scopes.length > 0 && scopes.every((s) => READ_SCOPE.test(s))
}

/** Auth callback: trade the code for the store's token. Refuses a grant that could write. */
export async function exchangeInstallCode(app: BigCommerceApp, q: Record<string, string | undefined>, fetch: FetchLike): Promise<BigCommerceInstall> {
  const storeHash = storeHashOf(q.context)
  if (!q.code || !q.scope || !storeHash) throw bad('is missing its code, scope or store')
  if (!readOnlyScopes(q.scope.split(/\s+/).filter(Boolean))) throw new ConnectorError('permanent', BIGCOMMERCE_WRITE_SCOPE, { provider: PROVIDER, forUser: true })
  const res = await fetch(BIGCOMMERCE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, code: q.code, context: q.context, scope: q.scope, grant_type: 'authorization_code', redirect_uri: app.authCallback }),
  })
  // Written from the status alone: the body can echo the code.
  if (!res.ok) throw new ConnectorError(res.status >= 500 ? 'transient' : 'permanent', `BigCommerce token exchange HTTP ${res.status}`, { provider: PROVIDER, status: res.status })
  const body: unknown = await res.json().catch(() => null)
  if (!isRecord(body) || typeof body.access_token !== 'string' || !body.access_token) throw bad('sent no access token')
  // The scopes actually granted, which can differ from the ones on the callback.
  const scopes = typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : []
  if (!readOnlyScopes(scopes)) throw new ConnectorError('permanent', BIGCOMMERCE_WRITE_SCOPE, { provider: PROVIDER, forUser: true })
  if (storeHashOf(body.context) !== storeHash) throw bad('named a different store')
  return { secret: { storeHash, accessToken: body.access_token }, scopes, userEmail: email(body.user) }
}

const b64 = (s: string) => Buffer.from(s, 'base64url')

/** Load, uninstall and remove_user: check signed_payload_jwt (HS256, client secret, aud, iss, time) and read it. */
export function verifySignedPayload(app: Pick<BigCommerceApp, 'clientId' | 'clientSecret'>, jwt: string, nowMs: number): BigCommercePayload {
  const parts = jwt.split('.')
  if (parts.length !== 3) throw bad('is not signed')
  const [h, p, sig] = parts as [string, string, string]
  let header: unknown
  let claims: unknown
  try {
    header = JSON.parse(b64(h).toString('utf8'))
    claims = JSON.parse(b64(p).toString('utf8'))
  } catch {
    throw bad('is not signed')
  }
  if (!isRecord(header) || header.alg !== 'HS256') throw bad('is not signed the expected way')
  const want = createHmac('sha256', app.clientSecret).update(`${h}.${p}`).digest()
  const given = b64(sig)
  if (given.length !== want.length || !timingSafeEqual(given, want)) throw bad('has a bad signature')
  if (!isRecord(claims)) throw bad('is not signed')
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!aud.includes(app.clientId)) throw bad('is for another app')
  if (claims.iss !== 'bc') throw bad('is not from BigCommerce')
  const now = Math.floor(nowMs / 1000)
  // A minute of leeway for clock skew either side.
  if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw bad('has expired')
  if (typeof claims.nbf === 'number' && claims.nbf > now + 60) throw bad('isn’t valid yet')
  const storeHash = storeHashOf(claims.sub)
  if (!storeHash) throw bad('names no store')
  return { storeHash, userEmail: email(claims.user), ownerEmail: email(claims.owner) }
}
