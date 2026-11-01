import type { MiddlewareHandler } from 'hono'
import type { ServerConfig } from './config.ts'

/** Strict headers for every response. The web app ships no inline scripts, so script-src stays 'self'. */
export function securityHeaders(config: ServerConfig): MiddlewareHandler {
  const https = config.baseUrl.startsWith('https://')
  return async (c, next) => {
    await next()
    const h = c.res.headers
    h.set('x-content-type-options', 'nosniff')
    h.set('referrer-policy', 'same-origin')
    // The embedded Shopify page sets its own frame-ancestors (Shopify admin); everything else is never framed.
    if (!/frame-ancestors https:/.test(h.get('content-security-policy') ?? '')) h.set('x-frame-options', 'DENY')
    h.set('cross-origin-opener-policy', 'same-origin')
    h.set('permissions-policy', 'camera=(self), microphone=(), geolocation=(), payment=()')
    if (https) h.set('strict-transport-security', 'max-age=31536000; includeSubDomains')
    // The app's pages and every API answer, errors and 401s included, are never stored by a browser or proxy (Intuit's
    // security requirements). Pages a route marks `public` (legal, docs, published share cards: no private data) and
    // hashed assets keep their own cache; an answer that already says no-store keeps its value.
    const cc = h.get('cache-control') ?? ''
    const appHtml = (h.get('content-type') ?? '').startsWith('text/html') && !/\bpublic\b/.test(cc)
    if ((appHtml || c.req.path.startsWith('/api/')) && !/no-store/.test(cc)) h.set('cache-control', 'no-cache, no-store')
    if (!h.has('content-security-policy')) {
      h.set(
        'content-security-policy',
        [
          "default-src 'self'",
          "script-src 'self' https://cdn.plaid.com",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self'",
          "connect-src 'self' https://*.plaid.com",
          'frame-src https://cdn.plaid.com',
          "frame-ancestors 'none'",
          "base-uri 'none'",
          "form-action 'self' https:",
          "object-src 'none'",
        ].join('; '),
      )
    }
  }
}

/**
 * Rejects cross-site state-changing requests (CSRF) by checking Origin/Sec-Fetch-Site on writes.
 * Auth and webhooks are excluded: Better Auth does its own origin checks and webhooks are signature-verified.
 */
export function sameOriginForWrites(baseUrl: string, exemptPrefixes: string[]): MiddlewareHandler {
  const origin = new URL(baseUrl).origin
  return async (c, next) => {
    const m = c.req.method
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS' || exemptPrefixes.some((p) => c.req.path.startsWith(p))) return next()
    const site = c.req.header('sec-fetch-site')
    const reqOrigin = c.req.header('origin')
    if (site === 'cross-site' || (reqOrigin && reqOrigin !== origin) || (!reqOrigin && site !== 'same-origin')) {
      return c.json({ message: 'This request came from another site and was blocked.' }, 403)
    }
    return next()
  }
}

/** Redirect targets Better Auth accepts from callers (sign-in links, OAuth, errors). */
const REDIRECT_KEYS = /^(callbackurl|newusercallbackurl|errorcallbackurl|redirectto|redirect_uri_after|returnto)$/i

/** A redirect target is safe when it's a path on this site, or a full URL with exactly this origin. */
export function isSafeRedirect(value: string, baseUrl: string): boolean {
  if (value.startsWith('/')) return !value.startsWith('//') && !value.startsWith('/\\') && !/[\r\n\t]/.test(value)
  try {
    return new URL(value).origin === new URL(baseUrl).origin
  } catch {
    return false
  }
}

/**
 * Open-redirect guard for /api/auth/*: a sign-in link someone else requested for your email must never land you on
 * their site after you click it. Checks redirect parameters in the query and in a JSON body.
 */
export async function authRedirectsAreSafe(req: Request, baseUrl: string): Promise<boolean> {
  const url = new URL(req.url)
  for (const [k, v] of url.searchParams) if (REDIRECT_KEYS.test(k) && !isSafeRedirect(v, baseUrl)) return false
  if (req.method !== 'POST') return true
  const type = (req.headers.get('content-type') ?? '').toLowerCase()
  let fields: Array<[string, unknown]> = []
  if (type.includes('application/json')) {
    const body = (await req.clone().json().catch(() => null)) as Record<string, unknown> | null
    if (body && typeof body === 'object') fields = Object.entries(body)
  } else if (type.includes('application/x-www-form-urlencoded')) {
    fields = [...new URLSearchParams(await req.clone().text())]
  } else if (type.includes('multipart/form-data')) {
    const form = await req.clone().formData().catch(() => null)
    if (form) fields = [...form.entries()]
  }
  // A redirect key that isn't a string (an array, an object) can't be checked, so it isn't accepted either.
  for (const [k, v] of fields) if (REDIRECT_KEYS.test(k) && (typeof v !== 'string' || !isSafeRedirect(v, baseUrl))) return false
  return true
}

/**
 * The client's IP, only from the one header a trusted proxy sets (CLIENT_IP_HEADER, e.g. fly-client-ip). Never from
 * x-forwarded-for, whose first hop is whatever the client sent. Undefined when no trusted header is configured.
 */
export function clientIp(headers: Headers, trustedHeader: string | undefined): string | undefined {
  if (!trustedHeader) return undefined
  return headers.get(trustedHeader)?.split(',')[0]?.trim() || undefined
}
