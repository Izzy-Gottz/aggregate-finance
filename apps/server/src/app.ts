import { Hono, type Context } from 'hono'
import { errorForLog } from './log-safe.ts'
import { CompanyDeleteError, deleteEmptyCompany, isWorkspaceOwner } from './delete-company.ts'
import { liveCode, REF_COOKIE, refFromCookie } from './creator-links.ts'
import { freeGrants, freeLabel } from './free-grants.ts'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { SETUP_DOCS_PATH, setupMarkdown, unconfiguredConnectors } from '@agfn/connector-registry'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { randomBytes } from 'node:crypto'
import { aiDisclosure } from '@agfn/contracts'
import { consentShown } from './consent.ts'
import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata, createWorkspace, addCompany, isTimeZone, signInPending, SIGNIN_NONCE_COOKIE, newNonce, sha256, normalizeCode, codeHash, sameHash, CODE_TRIES, workspaceDeletingEmail } from '@agfn/auth'
import { seal, unseal } from '@agfn/security'
import { applyPendingReassignments, createConnection, SECRET_PURPOSE, SYNC_JOB } from '@agfn/sync'
import { DemoMixError, assertConnectorAllowed, createDemoWorkspace, demoFillPlace, demoImporting, isDemoReady, isDemoWorkspace, leaveDemoWorkspace } from '@agfn/demo'
import { AgfnHttp, buildOpenApi, DbRateLimiter, MemoryRateLimiter, ToolError } from '@agfn/mcp'
import { clearAttention, listAttention, recordWebhookReceipt, setAttention, type ConnectorTables } from '@agfn/connector-sdk/db'
import { isConnectorError, plainError } from '@agfn/connector-sdk'
import { ownerOf, ADVISORY_KEYS, advisoryLock, newId, nowIso, PoolBusyError, withBypass, withWorkspace, type CoreTables } from '@agfn/db'
import type { Kysely } from 'kysely'
import type { GrantShape, MetricAnswer } from '@agfn/contracts'
import type { LedgerEngine } from '@agfn/core'
import type { Services } from './services.ts'
import { authRedirectsAreSafe, clientIp, securityHeaders, sameOriginForWrites } from './security.ts'
import { serveWeb } from './static.ts'
import { createPublicDemoDoor, isPublicDemoKey, mountPublicDemo } from './public-demo-route.ts'
import { UploadError } from './documents.ts'
import { aiRoutes, aiWorkspaceSummary } from './routes/ai.ts'
import { equityFor } from './equity.ts'
import { settingsRoutes } from './routes/settings.ts'
import { DEMO_HEADER, DEMO_REFRESH_HEADER, DEMO_REFRESH_TOKEN, demoCached, demoCacheKey, demoGate, demoRefreshed, demoRemember, PUBLIC_DEMO_SESSION } from './public-demo-web.ts'
import { publicBadgeRoutes, publicShareRoutes, shareRoutes } from './routes/share.ts'
import { inboundAddresses, inboundRoutes, inboundWebhookRoutes } from './routes/inbound.ts'
import { financeRoutes, holdingsOf } from './routes/finance.ts'
import { mcpTiming } from './mcp-timing.ts'
import { equityRoutes } from './routes/equity.ts'
import { investmentRoutes } from './routes/investments.ts'
import { deleteWorkspace, personalAffected } from './delete-workspace.ts'
import { deleteAccount, SoleOwnerError } from './delete-account.ts'
import { deleteIfMemberless, queueIfMemberless, workspacesOf } from './orphans.ts'
import { confirmRecheckCode, confirmRecheckLink, RECHECK_LINK_MINUTES, safeReturnTo, sendRecheckLink } from './recheck.ts'
import { revokeUnboundOauthGrants } from './retention.ts'
import { findLegalFonts, loadGuides, loadLegalPages, loadPublicDocs, renderDoc, renderDocsHome, renderLegal, withBaseUrl } from './legal.ts'
import { apiDocsMarkdown, type OpenApiDoc } from './api-docs.ts'
import { readFileSync } from 'node:fs'
import { demoDocuments, isReviewerEmail, redeemReviewerLink, reviewerAccess, reviewerBlocked } from './reviewer.ts'
import { peopleFromAuth } from '@agfn/mcp'
import { financeFor } from './finance.ts'
import { confirmPage, dropPending, embeddedPage, SHOPIFY_LINK_COOKIE, shopifyEmbeddedRoutes, takePendingByLink } from './shopify-embedded.ts'
import { deleteUploadedFile, FileDeleteError } from './delete-file.ts'
import { APP_DISALLOW, type CrawlPage, llmsFullTxt, llmsTxt, robotsTxt } from './docs-crawl.ts'
import { docsHost } from './docs-host.ts'
import { INSTITUTIONS_JS, INSTITUTIONS_PATH, loadInstitutions } from './docs-institutions.ts'
import { FRIEND_COOKIE, validFriendCode } from './friend-invites.ts'
import { friendInviteRoutes, friendInviteStopRoutes } from './routes/friend-invites.ts'
import { DOCS_JS, DOCS_JS_PATH, DOCS_SEARCH_PATH, docsSearchIndex, loadDocsIcons } from './docs-shell.ts'
import { adoptStatementAccounts, deleteConnectionFiles, ERASE_ON_DISCONNECT, ERASE_WHEN_REVOKED, eraseConnectionData, SHOPIFY_ERASE_WARNING, logConnectionChange, noteConnection, providerOrgOf, retireDeleted, retireReplaced } from './retire.ts'
import { personalHidden } from './personal.ts'
import { termsByAccount } from './account-terms.ts'
import { connectionRoutes, plaidDuplicateMessage } from './routes/connections.ts'
import { passkeysPossible, type ServerConfig } from './config.ts'
import { startDemoWorkspace } from './demo-start.ts'

export interface RequestPerson {
  personId: string
  name: string
  email: string
  sessionId: string
  workspaceId: string | null
  /** Every workspace the person belongs to (for the switcher in GET /api/me). */
  workspaces?: Array<{ id: string; name: string; role: string }>
  /** From the trusted proxy header only (see clientIp); undefined otherwise. */
  ip?: string
}

/** The workspace this browser last chose, for requests that can't carry the header (OAuth returns, new tabs). */
const WORKSPACE_COOKIE = 'agfn_ws'
/** How long /healthz waits on its database probe before answering "busy" (Fly's check times out at 5 s). */
export const HEALTH_DB_WAIT_MS = 2000

type Env = { Variables: { person: RequestPerson } }

/** Plain-words error the UI shows as written. */
/** Holds a verified Shopify shop domain between the install link and sign-in (30 minutes). */

export function fail(status: 400 | 401 | 403 | 404 | 409 | 422 | 503, message: string, extra: Record<string, unknown> = {}): never {
  throw new HTTPException(status, { res: new Response(JSON.stringify({ message, ...extra }), { status, headers: { 'content-type': 'application/json' } }) })
}

/**
 * Content-Disposition for a download whose name came from a user or an email. Header values must be Latin-1, so
 * names in other scripts get an ASCII fallback plus RFC 5987 filename* (UTF-8); quotes and control characters go.
 */
export function attachmentDisposition(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f"\\]/g, '').trim() || 'file'
  const ascii = clean.normalize('NFKD').replace(/[^\x20-\x7e]/g, '_')
  return ascii === clean ? `attachment; filename="${ascii}"` : `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`
}

const retireHooked = new WeakSet<object>()

/** Public icon paths → brand-kit files (apps/site/brand). */
export const BRAND_ICONS: Array<[path: string, file: string, type: string]> = [
  ['/favicon.ico', 'favicon.ico', 'image/x-icon'],
  ['/favicon.svg', 'favicon.svg', 'image/svg+xml'],
  ['/apple-touch-icon.png', 'app-icons/aggregate-gold-on-black-180.png', 'image/png'],
  ['/icon-64.png', 'app-icons/aggregate-gold-on-black-64.png', 'image/png'],
  ['/icon-192.png', 'app-icons/aggregate-gold-on-black-192.png', 'image/png'],
  ['/icon-512.png', 'app-icons/aggregate-gold-on-black-512.png', 'image/png'],
]

/** The sign-in methods this server offers. The challenge deployment: GitHub (and passkeys added later) only. */
function signInMethodsFor(config: ServerConfig): string[] {
  if (config.challenge) return ['passkey', ...(config.github ? ['github'] : [])]
  return ['passkey', 'magic_link', ...(config.google ? ['google'] : []), ...(config.apple ? ['apple'] : []), ...(config.github ? ['github'] : [])]
}

const SECURITY_TXT = [
  'Contact: mailto:security@aggregate.finance',
  'Expires: 2027-10-31T00:00:00.000Z',
  'Preferred-Languages: en',
  'Canonical: https://app.aggregate.finance/.well-known/security.txt',
  'Canonical: https://docs.aggregate.finance/.well-known/security.txt',
  'Policy: https://app.aggregate.finance/security',
  '',
].join('\n')

export function createApp(s: Services): Hono<Env> {
  const app = new Hono<Env>()
  const { db, config } = s
  const investmentsOn = () => !!config.investments && !!financeFor(s).reader.investments
  // After every sync: a reconnect retires what its disconnected predecessor still counts (retire.ts).
  if (!retireHooked.has(s.syncDeps)) {
    retireHooked.add(s.syncDeps)
    ;(s.syncDeps.afterSync ??= []).push(async (ws, connectionId) => {
      await retireReplaced(s, ws, connectionId)
      await adoptStatementAccounts(s, ws, connectionId)
    })
  }

  app.use('*', securityHeaders(config))
  // The docs on their own host, and the old /docs URLs moved there (docs-host.ts). The lists are read per request: they
  // fill in further down.
  if (config.docsHost) {
    app.use(
      '*',
      docsHost({
        host: config.docsHost,
        baseUrl: config.baseUrl,
        isDoc: (p) => p === SETUP_DOCS_PATH || listedDocs().includes(p),
        sitemap: () => sitemapXml(`https://${config.docsHost}`, listedDocs().map((p) => p.replace(/^\/docs\/?/, '/')), (p) => docsUpdated(`/docs${p === '/' ? '' : p}`)),
        text: (p) => {
          const origin = `https://${config.docsHost}`
          if (p === '/robots.txt') return robotsTxt([`${origin}/sitemap.xml`])
          if (p === '/llms.txt') return llmsTxt(origin, crawlPages())
          if (p === '/llms-full.txt') return llmsFullTxt(origin, crawlPages())
          return null
        },
        render: (p, c) => Promise.resolve(app.fetch(new Request(new URL(p, config.baseUrl), { method: c.req.method }), { docsInner: true } as never)),
      }),
    )
  }
  // initialize and tools/list: method, ms and status only (mcp-timing.ts).
  for (const path of ['/mcp', '/demo/mcp']) app.use(path, mcpTiming())
  // Forwarded emails carry several attachments: their webhook gets 30 MB (each file still has the 8 MB document cap).
  const inboundLimit = bodyLimit({ maxSize: 30 * 1024 * 1024, onError: (c) => c.json({ message: 'That email is too large (30 MB max).' }, 413) })
  const apiLimit = bodyLimit({ maxSize: 8 * 1024 * 1024, onError: (c) => c.json({ message: 'That file or request is too large (8 MB max).' }, 413) })
  app.use('/api/*', (c, next) => (c.req.path.startsWith('/api/inbound/email/') ? inboundLimit(c, next) : apiLimit(c, next)))
  app.use('/api/*', sameOriginForWrites(config.baseUrl, ['/api/auth/', '/api/webhooks/', '/api/inbound/email/']))

  const lastUnhandledAlert = new Map<string, number>()
  app.onError(async (err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    if (err instanceof ToolError) {
      const status = ({ not_found: 404, forbidden: 403, invalid: 422, paused: 423, rate_limited: 429, cap_reached: 429, conflict: 409, unavailable: 503 } as const)[err.code] ?? 400
      if (err.code === 'forbidden' && (err.hint === 'step_up_required' || /passkey|confirm/i.test(err.message))) return c.json(await recheckBody(c), 403)
      return c.json({ message: err.message }, status)
    }
    // The pool stayed full past the checkout timeout (logged where it happened): busy, not broken.
    if (err instanceof PoolBusyError) return c.json({ error: 'busy', message: err.message }, 503, { 'retry-after': '5' })
    // c.req.json() on a body that isn't JSON: the sender's mistake, so no error log and no alert.
    if (err instanceof SyntaxError && /JSON/.test(err.message) && c.req.method !== 'GET') return c.json({ message: 'Send a JSON object.' }, 400)
    const logged = errorForLog(err)
    console.error('[agfn] unhandled error', JSON.stringify(logged))
    // A 500 nobody sees is how a bug stays live: tell the founder, once an hour per kind of error.
    const kind = logged.code ? `${logged.name}:${logged.code}` : logged.name
    const at = Date.now()
    if ((lastUnhandledAlert.get(kind) ?? -Infinity) <= at - 3600_000) {
      lastUnhandledAlert.set(kind, at)
      s.alert?.('error', 'unhandled error', { kind, error: logged.message, route: c.req.routePath })
    }
    return c.json({ message: 'Something went wrong on our side. Try again in a moment.' }, 500)
  })

  // ---------- Health and discovery ----------
  app.get('/healthz', async (c) => {
    // Still loading stored results after boot (AGFN_READY_GATE): not ready for traffic yet, but alive.
    if (s.readiness && !s.readiness.ready) return c.json({ ok: false, warming: true }, 503)
    // A pool busy behind slow work answers late, not wrong. Past HEALTH_DB_WAIT_MS this still counts as healthy: with one
    // machine, failing Fly's check only turns slow pages into 503s for everyone (staging, 2026-10-13). A DB error fails.
    const started = Date.now()
    const probe = db.selectFrom('workspaces').select('id').limit(1).execute()
    let timer: ReturnType<typeof setTimeout> | undefined
    const busy = await Promise.race([probe.then(() => false), new Promise<boolean>((r) => (timer = setTimeout(r, HEALTH_DB_WAIT_MS, true)))])
    clearTimeout(timer)
    if (busy) {
      probe.catch(() => undefined)
      s.health?.busy(probe, started)
    } else s.health?.ok()
    return c.json(busy ? { ok: true, db: 'busy' } : { ok: true })
  })

  // The demo app (AGFN_ROLE=demo): only the public demo, at /mcp and /demo/mcp. No sign-in, no web app, no API.
  if (config.role === 'demo') {
    mountPublicDemo(app, s, ['/mcp', '/demo/mcp'])
    app.all('*', (c) => c.json({ error: 'not_found', message: 'This server only runs Aggregate’s public demo, at /mcp.' }, 404))
    return app
  }
  const asMeta = oauthProviderAuthServerMetadata(s.auth)
  const oidcMeta = oauthProviderOpenIdConfigMetadata(s.auth)
  app.get('/.well-known/oauth-authorization-server', (c) => asMeta(c.req.raw))
  app.get('/.well-known/oauth-authorization-server/*', (c) => asMeta(c.req.raw))
  app.get('/.well-known/openid-configuration', (c) => oidcMeta(c.req.raw))
  // OpenAI app submission's domain check (docs/compliance/mcp-directory.md §5); 404 unless the token is configured.
  app.get('/.well-known/openai-apps-challenge', (c) =>
    config.openaiAppsChallenge ? c.text(config.openaiAppsChallenge, 200, { 'cache-control': 'no-store' }) : c.notFound(),
  )
  // Where to report a security problem (RFC 9116). Expires has to stay in the future: renew it before then.
  app.get('/.well-known/security.txt', (c) => c.text(SECURITY_TXT, 200, { 'cache-control': 'public, max-age=86400' }))
  // Glama's connector ownership check (docs/launch/directories.md); 404 unless a claim token is configured.
  app.get('/.well-known/glama.json', (c) =>
    config.glamaClaim
      ? c.json({ $schema: 'https://glama.ai/mcp/schemas/connector.json', claim: config.glamaClaim.length === 1 ? config.glamaClaim[0] : config.glamaClaim }, 200, { 'cache-control': 'no-store' })
      : c.notFound(),
  )

  // ---------- Creator links ----------
  // /r/<code>: remember a live creator code in a first-party cookie (the code only), then go to the home page. Unknown or
  // expired codes just redirect. Its own small per-IP limit, apart from the sign-in limits.
  const refLimiter = new DbRateLimiter(db)
  // An invite link (friend-invites.ts): remembered in a cookie, so sign-up can say who invited this person.
  app.use('/', async (c, next) => {
    await next()
    const code = c.req.query('from')
    if (code && validFriendCode(code) && c.req.method === 'GET') c.res.headers.append('set-cookie', `${FRIEND_COOKIE}=${code}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86_400}${config.baseUrl.startsWith('https:') ? '; Secure' : ''}`)
  })
  app.get('/r/:code', async (c) => {
    const ip = clientIp(c.req.raw.headers, config.clientIpHeader)
    if (ip && (await refLimiter.hit(`ref:ip:${ip}`, 30, 60_000, Date.now())) > 0) return c.redirect('/', 302)
    const code = c.req.param('code').toLowerCase()
    const live = await withBypass('ref:lookup', () => liveCode(db, code))
    // ?ref=1 lets the sign-in screen say "3 months free" (the cookie itself is HttpOnly); an unknown, expired or full code
    // adds nothing, so the screen never promises a perk sign-up can't grant.
    const res = c.redirect(live ? '/?ref=1' : '/', 302)
    if (live) {
      res.headers.append('set-cookie', `${REF_COOKIE}=${encodeURIComponent(code)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86_400}${config.baseUrl.startsWith('https:') ? '; Secure' : ''}`)
    }
    return res
  })

  // ---------- Auth (Better Auth) ----------
  // Sign-in emails are limited per address (and per client IP when a trusted proxy header says who the client is), so
  // nobody can flood someone's inbox. This works with or without CLIENT_IP_HEADER.
  const signInLimiter = new DbRateLimiter(db)
  // The challenge deployment signs players in with GitHub only: no email (it holds no mail keys), so no magic links or codes.
  if (config.challenge) {
    const noEmail = (c: Context) => c.json({ error: 'not_found', message: 'Sign in with GitHub.' }, 404)
    app.post('/api/auth/sign-in/magic-link', noEmail)
    app.post('/api/signin/code', noEmail)
  }
  app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
    if (!(await authRedirectsAreSafe(c.req.raw, config.baseUrl))) return c.json({ message: 'That sign-in link points to another site.' }, 400)
    if (c.req.method === 'POST' && c.req.path === '/api/auth/sign-in/magic-link') {
      const body = (await c.req.raw.clone().json().catch(() => ({}))) as { email?: unknown }
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
      const ip = clientIp(c.req.raw.headers, config.clientIpHeader)
      const now = Date.now()
      const perEmail = email ? await signInLimiter.hit(`signin:email:${email}`, 5, 15 * 60_000, now) : 0
      if (perEmail) return tooMany(c, 'Too many sign-in emails.', perEmail)
      const perNetwork =
        (ip ? await signInLimiter.hit(`signin:ip:${ip}`, config.signInIpLimit ?? 20, 15 * 60_000, now) : 0) ||
        (await signInLimiter.hit('signin:all', config.clientIpHeader ? 2000 : 200, 15 * 60_000, now))
      if (perNetwork) return tooMany(c, 'Too many sign-ins from this network.', perNetwork)
      // The email also carries a code for this browser: a nonce cookie ties it here (POST /api/signin/code).
      const nonce = newNonce()
      const res = await signInPending.run({ nonceHash: sha256(nonce) }, () => s.auth.handler(c.req.raw))
      if (res.status === 429) return authTooMany(c, res)
      const out = new Response(res.body, res)
      out.headers.append('set-cookie', `${SIGNIN_NONCE_COOKIE}=${nonce}; Path=/api/signin; HttpOnly; SameSite=Lax; Max-Age=600${config.baseUrl.startsWith('https:') ? '; Secure' : ''}`)
      return out
    }
    // Reviewer accounts can't add sign-in methods or change who they are (reviewer.ts).
    if (reviewerBlocked(c.req.method, c.req.path)) {
      const session = await s.auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null)
      if (session && isReviewerEmail(session.user.email)) return c.json({ message: 'Not available in the reviewer demo.' }, 403)
    }
    // RFC 8707 lets the authorization server pick the audience when a client names no resource. Some MCP clients (Meta
    // Muse) send none, and without one Better Auth issues an opaque token that /mcp can't verify. Default it to /mcp.
    let req = c.req.raw
    if (c.req.method === 'GET' && c.req.path === '/api/auth/oauth2/authorize') {
      const url = new URL(req.url)
      if (!url.searchParams.has('resource')) {
        url.searchParams.set('resource', `${config.baseUrl.replace(/\/+$/, '')}/mcp`)
        req = new Request(url, req)
      }
    }
    const res = await s.auth.handler(req)
    // RFC 7009 §2.2: revoking a token the server doesn't know (unknown, expired, already revoked) answers 200, not an
    // error, so a client's sign-out never fails. A JWT access token keeps its unsupported_token_type answer: it can't be
    // revoked on its own (it ends with its grant), and a 200 would claim it was.
    if (c.req.method === 'POST' && c.req.path === '/api/auth/oauth2/revoke' && res.status === 400) {
      const body = (await res.clone().json().catch(() => ({}))) as { error?: string; error_description?: string }
      if (body.error === 'invalid_request' && body.error_description === 'token not found') return c.body(null, 200)
    }
    // Better Auth's own limit (e.g. opening sign-in links from one shared network): one plain line, never its default.
    return res.status === 429 ? authTooMany(c, res) : res
  })

  // ---------- Sign-in code (email-codes.ts) ----------
  // The waiting "Check your email" page sends the code from the email when the link opened somewhere else. Only the
  // browser that asked has the nonce cookie; 5 tries per email; then the same link verification signs this browser in.
  app.post('/api/signin/code', async (c) => {
    const nonce = getCookie(c, SIGNIN_NONCE_COOKIE)
    const ip = clientIp(c.req.raw.headers, config.clientIpHeader)
    const now = Date.now()
    if ((ip && (await signInLimiter.hit(`signin-code:ip:${ip}`, 30, 15 * 60_000, now)) > 0) || (await signInLimiter.hit('signin-code:all', config.clientIpHeader ? 3000 : 300, 15 * 60_000, now)) > 0)
      return c.json({ error: 'rate_limited', message: 'Too many tries. Wait a few minutes and try again.' }, 429)
    const gone = () => c.json({ error: 'no_code', message: 'That sign-in was already used (on this or another device) or has expired. Ask for a new email.' }, 410)
    if (!nonce) return gone()
    const { code: raw } = await c.req.json<{ code?: unknown }>().catch(() => ({ code: undefined }))
    const at = new Date(now).toISOString()
    // signin_codes is person-level (no workspace_id), so row-level security doesn't apply and no bypass is needed.
    const row = await ownerOf(db).selectFrom('signin_codes').selectAll().where('nonce_hash', '=', sha256(nonce)).where('used_at', 'is', null).where('expires_at', '>', at).orderBy('created_at', 'desc').executeTakeFirst()
    if (!row) return gone()
    const code = normalizeCode(raw)
    const attempts = row.attempts + 1
    if (!code || !sameHash(codeHash(row.id, code), row.code_hash)) {
      const spent = attempts >= CODE_TRIES
      await ownerOf(db).updateTable('signin_codes').set({ attempts, ...(spent ? { used_at: at } : {}) }).where('id', '=', row.id).execute()
      if (spent) return c.json({ error: 'too_many', message: 'Too many wrong codes. Ask for a new email.' }, 429)
      return c.json({ error: 'wrong_code', message: `That code didn’t match. ${CODE_TRIES - attempts} ${CODE_TRIES - attempts === 1 ? 'try' : 'tries'} left.`, triesLeft: CODE_TRIES - attempts }, 400)
    }
    const claimed = await ownerOf(db).updateTable('signin_codes').set({ used_at: at, attempts }).where('id', '=', row.id).where('used_at', 'is', null).executeTakeFirst()
    if (Number(claimed.numUpdatedRows ?? 0) !== 1) return gone()
    // Verify the same magic link here, so this browser gets the session (and the link can't be used again). The creator
    // link cookie rides along (only it), so a first sign-up by code is attributed like one by link.
    const ref = refFromCookie(c.req.header('cookie'))
    const verify = await s.auth.handler(new Request(`${config.baseUrl.replace(/\/+$/, '')}/api/auth/magic-link/verify?token=${encodeURIComponent(row.link_token)}&callbackURL=${encodeURIComponent('/')}`, { headers: { 'user-agent': c.req.header('user-agent') ?? '', ...(ref ? { cookie: `${REF_COOKIE}=${encodeURIComponent(ref)}` } : {}) } }))
    const cookies = verify.headers.getSetCookie()
    if (!cookies.some((x) => x.includes('session_token')) || /[?&]error=/.test(verify.headers.get('location') ?? '')) return gone()
    const out = c.json({ ok: true })
    for (const x of cookies) out.headers.append('set-cookie', x)
    out.headers.append('set-cookie', `${SIGNIN_NONCE_COOKIE}=; Path=/api/signin; HttpOnly; SameSite=Lax; Max-Age=0`)
    return out
  })

  // ---------- Email re-check links (recheck.ts) ----------
  // Public: whoever holds the link proves access to the inbox. Then back into the app, where they try again.
  app.get('/recheck/:token', async (c) => {
    const r = await confirmRecheckLink(db, c.req.param('token'))
    if (!r.ok) {
      const why = r.reason === 'used' ? 'This link was already used.' : r.reason === 'expired' ? 'This link has expired.' : 'This link isn’t valid.'
      return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aggregate</title><body style="font-family:-apple-system,system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#1F1B1C"><h1 style="font-weight:400">${why}</h1><p>Go back to Aggregate and ask for a new one.</p></body>`, 410, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
    }
    return c.redirect(safeReturnTo(c.req.query('r')), 302)
  })

  // ---------- Reviewer access links (reviewer.ts; off unless AGFN_REVIEWER_LINKS=1) ----------
  app.get('/review-access/:token', async (c) => {
    if (!config.reviewerLinks) return c.notFound()
    const r = await redeemReviewerLink(
      {
        db,
        signIn: (email) => s.auth.api.signInMagicLink({ body: { email, callbackURL: '/' }, headers: c.req.raw.headers }),
        log: (detail, f) => console.warn('[agfn]', detail, f),
      },
      c.req.param('token'),
    )
    if (!r.ok) return c.html('<!doctype html><meta charset="utf-8"><title>Aggregate</title><p style="font:15px system-ui;margin:48px">This reviewer link isn’t valid any more. Ask whoever sent it for a new one.</p>', 404)
    return c.redirect(r.redirect, 302)
  })
  // The same reviewer access as a credential typed on the sign-in page (OpenAI's review requires an account that works
  // without magic links; the sign-in page is also what an OAuth popup shows). The code is the link's token (or the
  // whole link pasted); the same checks apply: live, unrevoked, demo-only account. Rate-limited per IP.
  app.post('/api/review-access/code', async (c) => {
    if (!config.reviewerLinks) return c.notFound()
    const ip = clientIp(c.req.raw.headers, config.clientIpHeader)
    const now = Date.now()
    if ((ip && (await signInLimiter.hit(`review-code:ip:${ip}`, 20, 15 * 60_000, now)) > 0) || (await signInLimiter.hit('review-code:all', 300, 15 * 60_000, now)) > 0)
      return c.json({ error: 'rate_limited', message: 'Too many tries. Wait a few minutes and try again.' }, 429)
    // `email` is set when the reviewer signs in with email + password (the password is the access code): a plain
    // username/password login, which is what app-review forms ask for. It must be the code's own account.
    const { code, email } = await c.req.json<{ code?: unknown; email?: unknown }>().catch(() => ({ code: undefined, email: undefined }))
    const token = typeof code === 'string' ? (code.trim().split('/').pop() ?? '').trim() : ''
    const r = await redeemReviewerLink(
      { db, signIn: (email) => s.auth.api.signInMagicLink({ body: { email, callbackURL: '/' }, headers: c.req.raw.headers }), log: (detail, f) => console.warn('[agfn]', detail, f) },
      token,
      typeof email === 'string' ? email : undefined,
    )
    if (!r.ok) return c.json({ error: 'invalid_code', message: 'That reviewer access code isn’t valid. Check it, or ask for a new one.' }, 400)
    // Verify the captured sign-in link here, so this browser (or OAuth popup) gets the session directly.
    const verify = await s.auth.handler(new Request(r.redirect, { headers: { 'user-agent': c.req.header('user-agent') ?? '' } }))
    const cookies = verify.headers.getSetCookie()
    if (!cookies.some((x) => x.includes('session_token'))) return c.json({ error: 'invalid_code', message: 'That reviewer access code isn’t valid. Check it, or ask for a new one.' }, 400)
    const out = c.json({ ok: true })
    for (const x of cookies) out.headers.append('set-cookie', x)
    return out
  })

  // ---------- MCP (S7) ----------
  // A demo key (AGFN_PUBLIC_DEMO_KEYS) reaches the public demo through its own door and limits: for a directory's
  // health check, which can only send a bearer token to the listed URL. Every other token goes to the real /mcp.
  const demoDoor = config.publicDemoKeyHashes?.length && s.publicDemo ? createPublicDemoDoor(s) : null
  const mcp = (c: Context) =>
    demoDoor && isPublicDemoKey(c.req.header('authorization'), config.publicDemoKeyHashes)
      ? demoDoor(c, '/mcp')
      : s.mcp
        ? s.mcp.fetch(c.req.raw)
        : c.json({ message: 'The AI connection is not installed on this server yet.' }, 503)
  app.all('/mcp', mcp)
  app.all('/mcp/*', mcp)
  app.get('/.well-known/oauth-protected-resource/mcp', mcp)
  app.all('/v1/*', mcp)

  // The public no-sign-up demo (public-demo.ts, AGFN_PUBLIC_DEMO=1): MCP only, read-only, as one server-chosen principal.
  // On its own demo app when AGFN_PUBLIC_DEMO_URL names it (so demo load never competes with real people here).
  if (config.publicDemoUrl) app.all('/demo/mcp', (c) => c.redirect(config.publicDemoUrl!, 308))
  else mountPublicDemo(app, s, ['/demo/mcp'])

  // ---------- Webhooks (provider-signed, no session) ----------
  app.post('/api/webhooks/:connectorKey', async (c) => {
    const key = c.req.param('connectorKey')
    if (!s.registry.has(key)) return c.json({ message: 'unknown connector' }, 404)
    const connector = s.registry.create(key, { raw: { put: async () => '' } }) as { webhook?: WebhookHandler }
    if (!connector.webhook) return c.json({ message: 'webhooks not supported' }, 404)
    const headers: Record<string, string> = {}
    c.req.raw.headers.forEach((v, k) => (headers[k.toLowerCase()] = v))
    const req = { headers, body: await c.req.text() }
    try {
      await connector.webhook.verify(req)
    } catch {
      return c.json({ message: 'invalid signature' }, 401)
    }
    // A verified provider delivery names a connection by provider ids, in any workspace. Only finding it (and the
    // receipt) is cross-workspace; everything done to a connection runs inside its workspace (docs/security/rls.md).
    return handleWebhook(c, key, connector.webhook!, req)
  })
  const handleWebhook = async (c: Context<Env>, key: string, webhook: WebhookHandler, req: { headers: Record<string, string>; body: string }) => {
    // One delivery can name several connections (Intuit batches change notices for many companies): each one once.
    const out = webhook.interpret(req)
    for (const outcome of Array.isArray(out) ? out : [out]) await handleOutcome(key, outcome)
    return webhook.emptyAck ? c.body(null, 200) : c.json({ ok: true })
  }
  const handleOutcome = async (key: string, outcome: WebhookOutcomeShape): Promise<void> => {
    // Providers retry deliveries; act on each one once.
    const receipt = await withBypass(`webhook:${key}:receipt`, () => recordWebhookReceipt(db as unknown as Kysely<import('@agfn/db').CoreTables & ConnectorTables>, {
      id: newId(),
      provider: key,
      dedupeKey: outcome.dedupeKey,
      action: outcome.action,
      ...(outcome.match ? { match: outcome.match } : {}),
      at: nowIso(),
    }))
    if (receipt === 'duplicate') return
    if (outcome.action === 'ignore' || !outcome.match) return
    const rows = await withBypass(`webhook:${key}:lookup`, () => db.selectFrom('connections').select(['id', 'workspace_id', 'config_json', 'status', 'created_at']).where('connector_key', '=', key).execute())
    const match = outcome.match
    // An uninstalled or erased store's waiting install token goes too (it was never linked to a workspace).
    if (key === 'shopify' && match.field === 'shop' && (outcome.action === 'disconnected' || outcome.action === 'erase')) await dropPending(s, match.value)
    const matches = rows.filter((r) => {
      const v = (JSON.parse(r.config_json) as Record<string, unknown>)[match.field]
      return v === match.value || (Array.isArray(v) && v.includes(match.value))
    })
    // A store or login connected again keeps its old, disconnected row: act on the live one, not the first one found.
    const conn = matches.find((r) => r.status !== 'disconnected') ?? matches[0]
    // Privacy erasure (Shopify shop/redact, 48 hours after uninstall): every connection for that store, in any
    // workspace. Access stops, the provider's raw records go, and the entries made from them stop counting, the same as
    // "remove with its data" (the uninstall warned about this in the activity log).
    if (outcome.action === 'erase') {
      const all = rows.filter((r) => {
        const v = (JSON.parse(r.config_json) as Record<string, unknown>)[match.field]
        return v === match.value || (Array.isArray(v) && v.includes(match.value))
      })
      // A store that reinstalled since (a new connection, made after the uninstall) keeps that new connection.
      const reinstalled = (r: { status: string; created_at: string }) => r.status !== 'disconnected' && Date.parse(r.created_at) > Date.now() - 3 * 86_400_000
      for (const r of all.filter((x) => !reinstalled(x))) {
        await withWorkspace(r.workspace_id, async () => {
          await s.sync.disconnect(r.id).catch(() => undefined)
          await db.updateTable('connections').set({ status: 'disconnected', secret_enc: null, disconnected_at: nowIso() }).where('id', '=', r.id).execute()
          await retireDeleted(s, r.workspace_id, r.id)
          await db.deleteFrom('raw_records').where('connection_id', '=', r.id).execute()
          await db.updateTable('accounts').set({ include_in_cash: 0, closed_at: nowIso() }).where('connection_id', '=', r.id).execute()
        })
      }
      return
    }
    if (!conn) return
    if (outcome.action === 'disconnected') {
      // Every live connection for it (a store can be connected in more than one workspace), each inside its workspace.
      const adb = db as unknown as Kysely<CoreTables & ConnectorTables>
      for (const r of matches.filter((x) => x.status !== 'disconnected'))
        await withWorkspace(r.workspace_id, async () => {
          await db.updateTable('connections').set({ status: 'disconnected', secret_enc: null, disconnected_at: nowIso() }).where('id', '=', r.id).execute()
          await clearAttention(adb, r.id)
          // Shopify follows an uninstall with shop/redact 48 hours later: say now what that will remove.
          if (key === 'shopify') await noteConnection(s, r.workspace_id, r.id, SHOPIFY_ERASE_WARNING)
        })
      return
    }
    await withWorkspace(conn.workspace_id, () => actOnConnection(key, outcome, conn))
  }
  const actOnConnection = async (key: string, outcome: WebhookOutcomeShape, conn: { id: string; workspace_id: string }): Promise<void> => {
    const adb = db as unknown as Kysely<CoreTables & ConnectorTables>
    const flag = (kind: 'reconnect_soon' | 'new_accounts', message: string) => setAttention(adb, { connectionId: conn.id, workspaceId: conn.workspace_id, kind, message, at: nowIso() })
    // Deliveries can arrive out of order, so state changes are confirmed by a sync (the provider's API is the truth):
    // a stale "login broken" heals on the next successful sync, which marks the connection active again.
    switch (outcome.action) {
      case 'sync':
        await s.sync.request(conn.workspace_id, conn.id)
        break
      case 'needs_reauth':
        await db.updateTable('connections').set({ status: 'needs_reauth', last_error: 'Your bank needs you to sign in again. Your data until now is safe.' }).where('id', '=', conn.id).execute()
        await s.sync.request(conn.workspace_id, conn.id)
        break
      case 'repaired':
        await clearAttention(adb, conn.id, 'reconnect_soon')
        await s.sync.request(conn.workspace_id, conn.id)
        break
      case 'reconnect_soon':
        await flag('reconnect_soon', 'Your bank asks you to reconnect within 7 days to keep data coming in.')
        break
      case 'new_accounts':
        await flag('new_accounts', 'You have new accounts at this bank. Reconnect to choose which ones to add.')
        break
    }
    return
  }

  // ---------- Email-in (provider webhook with a shared secret, no session) ----------
  app.route('/api', inboundWebhookRoutes(s))

  // ---------- Sign-in options (public: the sign-in page shows only what this server has) ----------
  app.get('/api/sign-in-methods', (c) => c.json({ methods: signInMethodsFor(config), ...(config.reviewerLinks ? { reviewerCode: true } : {}) }))

  // ---------- Shopify installs start from Shopify (App Store / admin "Install app") ----------
  // Shopify opens our app URL with a signed ?shop&hmac&timestamp. After checking it, the shop is kept in a short-lived
  // cookie: a signed-in person continues straight to Shopify's consent screen (/install/resume); anyone else signs in
  // first and the app resumes (GET /api/me says pendingInstall: 'shopify').
  // Managed install: Shopify installs the app (scopes from shopify.app.toml) and opens our App URL inside the admin
  // with a signed ?shop&hmac&timestamp&embedded=1&host. That's the embedded page; it gets the store's token by token
  // exchange and links it to a workspace after sign-in (shopify-embedded.ts). Opened anywhere else, the app lives in
  // the admin, so the browser goes there.
  const shopifyInstall = (embeddedOk: boolean) => async (c: Context<Env>) => {
    const connector = s.registry.has('shopify') ? (s.registry.create('shopify', { raw: { put: async () => '' } }) as { verifyInstall?: (q: Record<string, string>) => string; apiKey?: string }) : undefined
    if (!connector?.verifyInstall) return c.redirect(`/#/?connect_error=${encodeURIComponent('Shopify installs aren’t set up on this server.')}`)
    let shop: string
    try {
      shop = connector.verifyInstall(Object.fromEntries(new URL(c.req.url).searchParams))
    } catch {
      return c.redirect(`/#/?connect_error=${encodeURIComponent('That install link from Shopify is invalid or expired. Install again from Shopify.')}`)
    }
    const q = new URL(c.req.url).searchParams
    if (embeddedOk && q.get('embedded') === '1' && q.get('host')) return embeddedPage(c, s, shop)
    return c.redirect(`https://${shop}/admin/apps/${encodeURIComponent(connector.apiKey ?? '')}`)
  }
  app.get('/api/connectors/shopify/install', shopifyInstall(true))
  // The embedded page opened outside the admin sends the browser here: back into the admin.
  app.get('/api/connectors/shopify/install/top', shopifyInstall(false))
  shopifyEmbeddedRoutes(app, s)

  // ---------- Session for everything else under /api ----------
  app.use('/api/*', async (c, next) => {
    const session = await s.auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) {
      // The no-sign-up web demo (public-demo-web.ts): only without a session, only allowed reads, as the demo's own
      // person in the demo's workspace (never one the request names).
      if (s.publicDemo && c.req.header(DEMO_HEADER) === '1') {
        const blocked = await demoGate(c, clientIp(c.req.raw.headers, config.clientIpHeader), Date.now(), config.publicDemoWebPerMinute)
        if (blocked) return blocked
        const pr = await s.publicDemo.principal()
        if (!pr) return c.json({ error: 'demo_rebuilding', message: 'The demo is being refreshed. Try again in a minute.' }, 503)
        // The same books for everyone: a fresh answer is shared for a few seconds (public-demo-web.ts).
        const key = demoCacheKey(pr.workspaceId, c.req.url)
        const cached = c.req.header(DEMO_REFRESH_HEADER) === DEMO_REFRESH_TOKEN ? undefined : demoCached(key)
        if (cached) {
          // Older than the window: served anyway, and refreshed once behind it (the same request, run again in-process).
          if (cached.refresh) void Promise.resolve(app.fetch(new Request(c.req.url, { headers: { [DEMO_HEADER]: '1', [DEMO_REFRESH_HEADER]: DEMO_REFRESH_TOKEN, accept: 'application/json' } }))).catch(() => undefined).finally(() => demoRefreshed(key))
          return c.body(cached.hit.body, cached.hit.status as 200, { 'content-type': cached.hit.type })
        }
        c.set('person', { personId: pr.personId, name: 'Demo', email: '', sessionId: PUBLIC_DEMO_SESSION, workspaceId: pr.workspaceId, workspaces: [{ id: pr.workspaceId, name: 'Demo', role: 'viewer' }] })
        await withWorkspace(pr.workspaceId, next)
        await demoRemember(key, c.res)
        return
      }
      return c.json({ message: 'Please sign in.' }, 401)
    }
    const person = await db.selectFrom('people').select(['id', 'name', 'email']).where('auth_user_id', '=', session.user.id).executeTakeFirst()
    if (!person) return c.json({ message: 'Please sign in.' }, 401)
    // Memberships across workspaces, before one is chosen: a narrow named bypass (docs/security/rls.md).
    const workspaces = await withBypass('auth:memberships', () => s.permissions.workspacesFor(person.id))
    // The app names its workspace on every call; full-page requests (a provider sending the browser back, a link opened
    // in a new tab) can't, so the browser's last choice rides in a cookie. Either only counts if the person belongs to it.
    const member = (id: string | undefined) => (id ? workspaces.find((w) => w.id === id) : undefined)
    const named = member(c.req.header('x-agfn-workspace'))
    const remembered = getCookie(c, WORKSPACE_COOKIE)
    let ws = named ?? member(remembered) ?? workspaces[0]
    if (named && named.id !== remembered) setCookie(c, WORKSPACE_COOKIE, named.id, { path: '/', httpOnly: true, secure: config.baseUrl.startsWith('https:'), sameSite: 'Lax', maxAge: 400 * 24 * 3600 })
    // A provider's OAuth return belongs to the workspace the connect started in, whichever one this browser shows now.
    const returnState = workspaces.length > 1 && /^\/api\/connectors\/[\w-]+\/callback$/.test(c.req.path) ? c.req.query('state') : undefined
    if (returnState) {
      const started = await withBypass('auth:connect-state', () =>
        db.selectFrom('settings').select('workspace_id').where('workspace_id', 'in', workspaces.map((w) => w.id)).where('key', 'in', [`connect_state:${returnState}`, `connect_done:${returnState}`]).executeTakeFirst(),
      )
      ws = member(started?.workspace_id) ?? ws
    }
    // A reviewer session only works while its link is live and its account holds exactly one demo workspace, and
    // only inside it.
    if (isReviewerEmail(person.email)) {
      const demoWs = await reviewerAccess(db, person.id)
      if (!demoWs) return c.json({ message: 'This reviewer account isn’t available.' }, 403)
      if (reviewerBlocked(c.req.method, c.req.path)) return c.json({ message: 'Not available in the reviewer demo.' }, 403)
      ws = workspaces.find((w) => w.id === demoWs)
      if (!ws) return c.json({ message: 'This reviewer account isn’t available.' }, 403)
    }
    c.set('person', { personId: person.id, name: person.name, email: person.email, sessionId: session.session.id, workspaceId: ws?.id ?? null, workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, role: w.role })), ...(clientIp(c.req.raw.headers, config.clientIpHeader) ? { ip: clientIp(c.req.raw.headers, config.clientIpHeader)! } : {}) })
    // The rest of the request runs in this workspace (row-level security prototype; inert unless AGFN_PG_RLS=1).
    await (ws ? withWorkspace(ws.id, next) : next())
  })

  const requireWs = (c: Context<Env>): string => {
    const id = c.get('person').workspaceId
    if (!id) fail(409, 'Create your first company to get started.', { error: 'onboarding' })
    return id
  }
  const actorOf = (c: Context<Env>) => ({ kind: 'person' as const, personId: c.get('person').personId, workspaceId: requireWs(c) })

  /**
   * May this person attach a connection to this company? Owners and admins manage connections ("manage"), so any company
   * in the workspace, and their own Personal space but never someone else's; what they can then see is still their
   * role's. Everyone else needs "add balances" there.
   */
  async function canConnectTo(c: Context<Env>, ws: string, entityId: string): Promise<boolean> {
    const personId = c.get('person').personId
    if (await s.permissions.canManageWorkspace(ws, personId)) {
      const e = await db.selectFrom('entities').select(['kind', 'owner_person_id']).where('id', '=', entityId).where('workspace_id', '=', ws).executeTakeFirst()
      if (e && (e.kind !== 'personal' || e.owner_person_id === personId)) return true
    }
    return s.permissions.can(actorOf(c), 'add', entityId, 'balances')
  }

  /**
   * A fresh "it's you" for destructive actions (delete the workspace or the account): a passkey for people who have
   * one, otherwise any sign-in in the last 10 minutes. The 403 says which (`method`), so the app can offer
   * "Email me a link" (POST /api/recheck/email) to someone who only signs in by email, instead of a passkey prompt
   * that can never succeed.
   */
  async function requireRecheck(personId: string): Promise<void> {
    const people = peopleFromAuth({ db, permissions: s.permissions, reauth: s.reauth, passkeysPossible: passkeysPossible(s.config.baseUrl), noRecheck: s.config.challenge === true })
    if (await people.requireRecentPasskey(personId, 10 * 60_000)) return
    const method = (await hasPasskey(personId)) ? 'passkey' : 'email'
    // A passkey that isn't on this device: the email link works for them too (`fallback`).
    fail(403, method === 'passkey' ? 'Confirm it’s you with your passkey, or by email.' : 'Confirm it’s you: we’ll email you a link.', { error: 'recheck', method, fallback: 'email' })
  }
  /**
   * The 403 for a re-check that @agfn/mcp asked for (control.requirePasskey: connecting an AI, widening its access, instant
   * writes). Says how this person can confirm, like requireRecheck: a passkey prompt only for someone who has one;
   * otherwise the email link. Reviewer demo accounts get no email (.invalid), so theirs is a fresh sign-in with the code.
   */
  async function recheckBody(c: Context<Env>): Promise<Record<string, string>> {
    const personId = (c.get('person') as { personId?: string } | undefined)?.personId
    const email = personId ? (await db.selectFrom('people').select('email').where('id', '=', personId).executeTakeFirst())?.email : undefined
    if (isReviewerEmail(email)) return { error: 'recheck', method: 'signin', message: 'In the reviewer demo, a fresh sign-in with your access code is the check, and only for connecting an AI. Sign in again, then connect.' }
    if (personId && passkeysPossible(s.config.baseUrl) && (await hasPasskey(personId).catch(() => false))) return { error: 'recheck', method: 'passkey', fallback: 'email', message: 'Confirm it’s you with your passkey, or by email.' }
    return { error: 'recheck', method: 'email', fallback: 'email', message: 'Confirm it’s you: we’ll email you a link.' }
  }
  async function hasPasskey(personId: string): Promise<boolean> {
    const person = await db.selectFrom('people').select('auth_user_id').where('id', '=', personId).executeTakeFirst()
    if (!person?.auth_user_id) return false
    const anyDb = db as unknown as Kysely<Record<string, Record<string, unknown>>>
    return Boolean(await ownerOf(anyDb).selectFrom('passkey').select('id').where('userId', '=', person.auth_user_id).limit(1).executeTakeFirst().catch(() => undefined))
  }

  // The email re-check (recheck.ts): a one-time link to the person's own address, for anyone whose passkey isn't on
  // this device or who never added one. Opening it anywhere counts as the re-check for 10 minutes.
  // The code from the same re-check email, typed where the person was asked (the link opened on another device).
  app.post('/api/recheck/code', async (c) => {
    const { personId } = c.get('person')
    const codeWait = await signInLimiter.hit(`recheck-code:person:${personId}`, 15, 15 * 60_000, Date.now())
    if (codeWait) return tooMany(c, 'Too many tries.', codeWait, { error: 'rate_limited' })
    const { code } = await c.req.json<{ code?: unknown }>().catch(() => ({ code: undefined }))
    const r = await confirmRecheckCode(db, personId, code)
    if (r.ok) return c.json({ ok: true })
    if (r.reason === 'none') return c.json({ error: 'no_code', message: 'That code was already used (or the link was opened, on any device) or has expired. Ask for a new email.' }, 410)
    if (r.reason === 'too_many') return c.json({ error: 'too_many', message: 'Too many wrong codes. Ask for a new email.' }, 429)
    return c.json({ error: 'wrong_code', message: `That code didn’t match. ${r.triesLeft} ${r.triesLeft === 1 ? 'try' : 'tries'} left.`, triesLeft: r.triesLeft }, 400)
  })

  app.post('/api/recheck/email', async (c) => {
    const { personId, email } = c.get('person')
    if (!s.mailer) fail(503, 'Email isn’t set up on this server.')
    const { returnTo } = await c.req.json<{ returnTo?: string }>().catch(() => ({ returnTo: undefined }))
    const now = Date.now()
    // Re-check links have their own limits (they only go to the person's own address, from a signed-in session), so
    // asking for a few no longer blocks signing in by email for 15 minutes too.
    const wait = (await signInLimiter.hit(`recheck:person15:${personId}`, 3, 15 * 60_000, now)) || (await signInLimiter.hit(`recheck:person:${personId}`, 6, 60 * 60_000, now))
    if (wait) return tooMany(c, 'Too many emails.', wait)
    await sendRecheckLink({ db, mailer: s.mailer!, baseUrl: config.baseUrl }, { id: personId, email }, safeReturnTo(returnTo))
    return c.json({ ok: true, sentTo: email, expiresInMinutes: RECHECK_LINK_MINUTES })
  })

  // Before deleting: the other members whose Personal connections go with it (counts only; Personal stays private).
  app.get('/api/workspace/delete-preview', async (c) => {
    const ws = requireWs(c)
    const personId = c.get('person').personId
    if (!(await isWorkspaceOwner(db, ws, personId))) fail(403, 'Only an owner can delete the workspace.')
    const affected = await personalAffected(db, ws, personId)
    return c.json({ affected: affected.map((a) => ({ personId: a.personId, name: a.name, email: a.email, personalConnections: a.connections.length })) })
  })

  // Delete the whole workspace: owner only, a fresh re-check, and DELETE typed to confirm.
  app.delete('/api/workspace', async (c) => {
    const ws = requireWs(c)
    const personId = c.get('person').personId
    const m = await db.selectFrom('memberships').select('role').where('workspace_id', '=', ws).where('person_id', '=', personId).where('revoked_at', 'is', null).executeTakeFirst()
    if (m?.role !== 'owner') fail(403, 'Only an owner can delete the workspace.')
    await requireRecheck(personId)
    const { confirm } = await c.req.json<{ confirm?: string }>().catch(() => ({ confirm: undefined }))
    if ((confirm ?? '').trim() !== 'DELETE') fail(422, 'Type DELETE to confirm.')
    // Everyone else whose Personal connections go with it hears first (the owner saw who in the preview).
    const affected = await personalAffected(db, ws, personId)
    if (affected.length && s.mailer) {
      const w = await db.selectFrom('workspaces').select('name').where('id', '=', ws).executeTakeFirst()
      for (const a of affected) {
        await s.mailer.send({ to: a.email, ...workspaceDeletingEmail({ workspaceName: w?.name ?? 'A workspace', ownerName: c.get('person').name || c.get('person').email, connections: a.connections }) }).catch((err: unknown) => console.warn('[agfn] workspace delete notice failed', { error: err instanceof Error ? err.message : 'unknown' }))
      }
    }
    const result = await deleteWorkspace({ db, files: s.files, sync: s.sync, log: (msg, f) => console.warn('[agfn]', msg, f ?? '') }, ws)
    console.warn('[agfn] workspace deleted', { workspaceId: ws, ...result })
    return c.json({ ok: true, ...result })
  })

  // Delete my account (data-retention §7): a fresh re-check and DELETE typed to confirm; refused while the only owner of a
  // workspace others belong to. Workspaces only they are in are deleted with it.
  app.delete('/api/me', async (c) => {
    const personId = c.get('person').personId
    await requireRecheck(personId)
    const { confirm } = await c.req.json<{ confirm?: string }>().catch(() => ({ confirm: undefined }))
    if ((confirm ?? '').trim() !== 'DELETE') fail(422, 'Type DELETE to confirm.')
    try {
      const mine = await workspacesOf(db, personId)
      // Spans every workspace the person is in: deleteAccount finds them under a narrow bypass, then works inside each.
      const result = await deleteAccount(
        {
          db,
          files: s.files,
          sync: s.sync,
          log: (msg, f) => console.warn('[agfn]', msg, f ?? ''),
          ...(s.mcp ? { revokeGrant: (workspaceId: string, pid: string, grantId: string) => withWorkspace(workspaceId, () => s.mcp!.control.revokeGrant({ workspaceId, personId: pid }, grantId)) } : {}),
        },
        personId,
      )
      // Workspaces nobody belongs to any more (their demo, or ones they were last in) go with the account.
      const workspacesDeleted = result.workspacesDeleted + (await deleteIfMemberless({ db, files: s.files, sync: s.sync, log: (msg, f) => console.warn('[agfn]', msg, f ?? '') }, mine))
      console.warn('[agfn] account deleted', { personId, ...result, workspacesDeleted })
      return c.json({ ok: true, ...result, workspacesDeleted })
    } catch (err) {
      if (err instanceof SoleOwnerError) return c.json({ error: 'sole_owner', message: err.message, workspaces: err.workspaces }, 409)
      throw err
    }
  })

  app.get('/api/me', async (c) => {
    const signedIn = c.get('person')
    // The challenge deployment: a new player gets their own made-up books at once, no setup.
    const p = config.challenge && !signedIn.workspaceId ? { ...signedIn, workspaceId: (await startDemo(signedIn.personId)).workspaceId } : signedIn
    return c.json({
      personId: p.personId,
      name: p.name,
      email: p.email,
      workspaceId: p.workspaceId ?? '',
      // The no-sign-up web demo: read-only, a banner and "Sign up" instead of the account menu.
      ...(p.sessionId === PUBLIC_DEMO_SESSION ? { publicDemo: true } : {}),
      // "Verified by Aggregate" badges (AGFN_BADGES): the company drawer offers one to owners and admins.
      ...(config.badges ? { badges: true } : {}),
      // The Investments page (AGFN_INVESTMENTS), only where core's reader can answer it.
      ...(investmentsOn() ? { investments: true } : {}),
      // The no-sign-up demo's AI link (made-up books), so a new person can ask before their own data is in.
      ...(s.publicDemo || config.publicDemoUrl ? { demoMcpUrl: `${config.baseUrl.replace(/\/+$/, '')}/demo/mcp` } : {}),
      // More than one: the app offers a switcher (reviewers only ever have their demo).
      workspaces: isReviewerEmail(p.email) ? (p.workspaces ?? []).filter((w) => w.id === p.workspaceId) : (p.workspaces ?? []),
      needsOnboarding: !p.workspaceId,
      mcpUrl: `${config.baseUrl}/mcp`,
      selfHosted: config.selfHosted,
      demo: p.workspaceId ? await isDemoWorkspace(db, p.workspaceId) : false,
      // Reviewer access link session: the app shows a "Reviewer demo" banner.
      ...(isReviewerEmail(p.email) ? { reviewerDemo: true } : {}),
      // A Shopify install that started signed out: the app sends the browser to /api/connectors/shopify/install/resume.
      ...(getCookie(c, SHOPIFY_LINK_COOKIE) ? { pendingInstall: 'shopify' } : {}),
      // Demo only: false while the demo is still filling (show "Filling the demo…"), true once it's loaded.
      ...(p.workspaceId && (await isDemoWorkspace(db, p.workspaceId)) ? { demoReady: await isDemoReady(db, p.workspaceId), ...(await demoQueue(p.workspaceId)) } : {}),
      signInMethods: signInMethodsFor(config),
      // Signed up through a creator link (creator-links.ts): the perk is shown as "3 months free", nothing else.
      ...((await withBypass('ref:perk', () => db.selectFrom('creator_attributions' as never).select('person_id' as never).where('person_id' as never, '=', p.personId as never).executeTakeFirst())) ? { perk: { label: '3 months free' } } : {}),
      // Free time on the workspace (free-grants.ts: YC Deal, manual, the creator perk) as one line for Preferences.
      ...(await (async () => {
        const label = p.workspaceId ? freeLabel(await freeGrants(db, p.workspaceId)) : null
        return label ? { freeGrant: { label } } : {}
      })()),
    })
  })

  // Onboarding: creates the workspace, the owner membership and the private Personal space, plus the first company
  // when companyName is given. No companyName (absent or null) = Personal only, for individuals; a blank one is a typo.
  app.post('/api/workspaces', async (c) => {
    const p = c.get('person')
    // Someone invited somewhere before they signed up still gets their own: only owning one already blocks it.
    if ((p.workspaces ?? []).some((w) => w.role === 'owner')) fail(409, 'You already have a workspace.')
    const body = await c.req.json<{ companyName?: string | null; currency?: string; timeZone?: string }>().catch(() => ({}) as { companyName?: string | null; currency?: string; timeZone?: string })
    const personalOnly = body.companyName === undefined || body.companyName === null
    if (!personalOnly && (typeof body.companyName !== 'string' || !body.companyName.trim())) fail(422, 'What’s your company called?')
    // An unknown zone from an odd browser shouldn't block signup: it just falls back to the default.
    const timeZone = isTimeZone(body.timeZone) ? body.timeZone : undefined
    // Pick the id first and create everything inside the new workspace (row-level security).
    const workspaceId = newId()
    const ids = await withWorkspace(workspaceId, () => createWorkspace(db, { workspaceId, personId: p.personId, workspaceName: personalOnly ? 'Personal' : body.companyName!, firstCompanyName: personalOnly ? null : body.companyName!, ...(body.currency ? { currency: body.currency } : {}), ...(timeZone ? { timeZone } : {}) }))
    return c.json(ids, 201)
  })

  app.post('/api/entities', async (c) => {
    const ws = requireWs(c)
    if (!(await s.permissions.canManageWorkspace(ws, c.get('person').personId))) fail(403, 'Only an owner or admin can add a company.')
    const body = await c.req.json<{ name?: string; currency?: string }>()
    if (!body.name?.trim()) fail(422, 'Give your company a name.')
    const id = await addCompany(db, ws, body.name, body.currency)
    await s.ledger.directoryChanged?.(ws)
    const e = await db.selectFrom('entities').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
    return c.json({ id: e.id, kind: e.kind, name: e.name, currency: e.base_currency, cash: null, hidden: false }, 201)
  })

  // A company nothing connects to or counts in any more can be deleted, by an owner (admins do everything except
  // deleting companies or the owner); otherwise the 409 says what to remove first (delete-company.ts).
  app.delete('/api/entities/:id', async (c) => {
    const ws = requireWs(c)
    if (!(await isWorkspaceOwner(db, ws, c.get('person').personId))) fail(403, 'Only an owner can delete a company.')
    try {
      const { name } = await deleteEmptyCompany(db, ws, c.req.param('id'))
      await s.ledger.directoryChanged?.(ws)
      return c.json({ ok: true, name })
    } catch (err) {
      if (err instanceof CompanyDeleteError) fail(err.status, err.message, err.block ? { error: err.block.error, ...(err.block.connections ? { connections: err.block.connections } : {}) } : {})
      throw err
    }
  })

  app.get('/api/workspace', async (c) => {
    const ws = requireWs(c)
    const p = c.get('person')
    const entities = await s.permissions.entitiesFor(ws, p.personId)
    const rows = await db.selectFrom('entities').select(['id', 'base_currency']).where('workspace_id', '=', ws).execute()
    const currency = new Map(rows.map((r) => [r.id, r.base_currency]))
    const summaries = await Promise.all(
      entities.map(async (e) => {
        const canSee = await s.permissions.can(actorOf(c), 'view', e.id, 'balances')
        const m = canSee ? await cashOf(s, ws, e.id) : null
        // Market value of its holdings, the company page's Holdings total (get_holdings's source): a quiet line under
        // cash, never added to it. Absent when there are none.
        const inv = canSee ? await investmentsOf(s, ws, e.id) : []
        return { id: e.id, kind: e.kind, name: e.name, currency: currency.get(e.id) ?? 'USD', cash: m?.cash ?? null, ...(m?.caveat ? { cashCaveat: m.caveat } : {}), ...(inv.length ? { investments: inv } : {}), hidden: await personalHidden(db, ws, e, p.personId) }
      }),
    )
    const connections = await connectionSummaries(s, ws)
    const connectedKeys = new Set(connections.map((x) => x.connectorKey))
    const demo = await isDemoWorkspace(db, ws)
    return c.json({
      me: { ...(config.friendInvites ? { friendInvites: true } : {}), personId: p.personId, name: p.name, email: p.email, workspaceId: ws, mcpUrl: `${config.baseUrl}/mcp`, selfHosted: config.selfHosted, demo, ...(demo ? { demoReady: await isDemoReady(db, ws), ...(await demoQueue(ws)) } : {}) },
      entities: summaries,
      connections,
      suggested: demo ? [] : suggestConnectors(offered(p.email), connectedKeys),
      ais: [],
      aiPaused: false,
      inbound: await inboundAddresses(s, ws, p.personId),
      reviewCount: 0,
      reviewModeOn: false,
      ...(s.mcp ? await aiWorkspaceSummary(s, ws, { personId: p.personId }) : {}),
      // One grey line under the numbers: "All reconciled" or "2 things need a look…" (S1 data health). The same
      // scope as get_metric data_health for "all": every company and Personal this person sees (not a private one).
      health: await dataHealthOf(s, ws, summaries.filter((e) => !e.hidden).map((e) => e.id)),
    })
  })

  /**
   * Real connectors that may still join a demo here: the challenge's sandbox Plaid (players link its test bank into their
   * made-up books), and a test deployment's AGFN_DEMO_EXTRA_CONNECTORS (config.ts). The web's connect drawer reads it
   * from /api/connectors (demoAllowed), so it offers the connect instead of "leave the demo".
   */
  const allowedInDemo = (key: string): boolean => (config.challenge === true && key === 'plaid') || (config.demoExtraConnectors?.includes(key) ?? false)

  /** Real and demo data never mix: real connectors are refused in the demo workspace and vice versa. */
  async function guardDemo(ws: string, key: string): Promise<void> {
    // The challenge deployment: players may link Plaid's sandbox bank (test logins) into their made-up books.
    if (allowedInDemo(key) && (config.challenge || (await isDemoWorkspace(db, ws)))) return
    try {
      await assertConnectorAllowed(db, ws, key)
    } catch (err) {
      if (err instanceof DemoMixError) fail(409, err.message, { error: 'demo' })
      throw err
    }
  }

  // ---------- Demo workspace (MASTER §4): three fictional companies + Personal, filled by the demo connector ----------
  app.post('/api/demo', async (c) => {
    const p = c.get('person')
    // Allowed before any data of their own: no workspace yet, the demo itself, or a company named but still empty (no
    // connections, records, entries, documents or accounts). The demo is its own workspace beside theirs, never mixed in.
    if (p.workspaceId && !(await isDemoWorkspace(db, p.workspaceId)) && !(await holdsNoData(p.workspaceId)))
      fail(409, 'The demo is for before you add your own data. Your books are already here.', { error: 'has_data' })
    const demo = await startDemo(p.personId)
    return c.json({ workspaceId: demo.workspaceId, created: demo.created, entities: demo.entities.map((e) => ({ id: e.id, name: e.name })) }, demo.created ? 201 : 200)
  })

  const startDemo = (personId: string) => startDemoWorkspace(s, personId)
  /** Nothing of their own in this workspace yet (runs in its row-level scope, like the request). */
  async function holdsNoData(ws: string): Promise<boolean> {
    const anyDb = db as unknown as Kysely<Record<string, { workspace_id: string }>>
    for (const table of ['connections', 'ledger_records', 'journal_entries', 'documents', 'accounts']) {
      if (await anyDb.selectFrom(table).select('workspace_id').where('workspace_id', '=', ws).limit(1).executeTakeFirst()) return false
    }
    return true
  }
  /** A demo waiting for a fill slot (hosted fills one at a time): its place in line and about how long. */
  const demoQueue = async (ws: string): Promise<{ demoQueue?: { position: number; minutes: number } }> => {
    if (!config.demoFillConcurrency) return {}
    const place = await withBypass('demo:place', () => demoFillPlace(db, ws, { limit: config.demoFillConcurrency! }))
    return place ? { demoQueue: place } : {}
  }

  app.delete('/api/demo', async (c) => {
    const personId = c.get('person').personId
    const mine = await workspacesOf(db, personId)
    const left = await leaveDemoWorkspace(db, personId)
    if (!left) fail(404, 'There’s no demo workspace to leave.')
    // Its made-up books are deleted, not kept around (their only member just left), by a job: a year of them takes
    // seconds, and they're already out of sight (the membership is revoked, so it's gone from their switcher).
    await queueIfMemberless({ db, queue: s.queue }, mine)
    return c.json({ ok: true })
  })

  // ---------- Connectors ----------
  // Self-hosted: app-based connectors without keys are listed too, with their setup guide (setup.configured: false).
  // Connectors offered for new connections: hosted holds some back (config.unlisted), except Plaid for reviewers; an
  // operator's pause (config.hidden, AGFN_HIDE_CONNECTORS) holds back for everyone.
  const unlistedFor = (email: string) => [...(config.unlisted ?? []).filter((k) => !(k === 'plaid' && isReviewerEmail(email))), ...(config.hidden ?? [])]
  const offered = (email: string) =>
    s.registry
      .list()
      .filter((d) => !unlistedFor(email).includes(d.key))
      .map((d) => (config.beta?.includes(d.key) ? { ...d, beta: true } : d))
      .map((d) => (allowedInDemo(d.key) ? { ...d, demoAllowed: true } : d))
  const guides = () => (config.hosted ? [] : unconfiguredConnectors({ BASE_URL: config.baseUrl }, s.registry.list().map((d) => d.key)))
  app.get('/api/connectors', (c) => c.json([...offered(c.get('person').email).filter((d) => d.key !== 'demo'), ...guides()]))
  const notConfigured = (key: string) => guides().some((g) => g.key === key) && fail(409, 'This connection needs its own app on this server first. Open it in Connect to see the steps.', { error: 'not_configured' })

  /**
   * Early-access cap on Plaid bank connections (config.plaidMaxItems). Checked before a link token exists, so no Item is
   * created or billed; reconnecting an existing Item (update mode) uses its own route and never counts.
   */
  async function assertPlaidRoom(ws: string): Promise<void> {
    const max = config.plaidMaxItems
    if (!max) return
    const row = await db
      .selectFrom('connections')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('workspace_id', '=', ws)
      .where('connector_key', '=', 'plaid')
      .where('status', '!=', 'disconnected')
      .executeTakeFirst()
    if (Number(row?.n ?? 0) >= max) fail(409, `You've connected ${max} banks — the most during early access. Disconnect one to add another.`, { error: 'plaid_limit', limit: max })
  }

  /**
   * Xero's per-app connection cap (config.xeroMaxConnections): Xero counts organisations across every customer, so this
   * counts distinct connected tenants in all workspaces (one named bypass read). Checked before the person is sent to
   * Xero, where a full app only gets Xero's own refusal. Reconnecting an organisation that's already connected adds
   * nothing at Xero, so it's let through when this workspace already has one.
   */
  async function assertXeroRoom(ws: string): Promise<void> {
    const max = config.xeroMaxConnections
    if (!max) return
    const rows = await withBypass('xero:connection_cap', () => db.selectFrom('connections').select(['workspace_id', 'config_json']).where('connector_key', '=', 'xero').where('status', '!=', 'disconnected').execute())
    const tenants = new Set(rows.map((r) => (JSON.parse(r.config_json || '{}') as { tenantId?: unknown }).tenantId).filter((t): t is string => typeof t === 'string' && t !== ''))
    if (tenants.size < max) return
    if (rows.some((r) => r.workspace_id === ws)) return
    console.warn('[agfn] xero connection cap reached', { tenants: tenants.size, max })
    fail(409, XERO_FULL, { error: 'xero_limit', limit: max })
  }

  /** Xero tenants connected anywhere on this server (not disconnected): what Xero counts against the plan. */
  async function xeroTenants(): Promise<Set<string>> {
    const rows = await withBypass('xero:connection_cap', () => db.selectFrom('connections').select('config_json').where('connector_key', '=', 'xero').where('status', '!=', 'disconnected').execute())
    return new Set(rows.map((r) => (JSON.parse(r.config_json || '{}') as { tenantId?: unknown }).tenantId).filter((t): t is string => typeof t === 'string' && t !== ''))
  }

  /**
   * One capped finish at a time per provider (Xero's organisations, Finch's companies), from counting the room until
   * every new row exists, so two people finishing at once can't both take the last place. In this process first (one
   * pooled connection waits, not one per finish), then on Postgres an advisory lock, which covers every machine (launch
   * runs several; a blue-green deploy overlaps two).
   */
  const capFinishing = new Map<'xero' | 'finch', Promise<void>>()
  async function lockCapFinish(which: 'xero' | 'finch'): Promise<() => Promise<void>> {
    let open!: () => void
    const prev = capFinishing.get(which) ?? Promise.resolve()
    capFinishing.set(which, new Promise<void>((r) => (open = r)))
    await prev
    let unlock: () => Promise<void>
    try {
      unlock = await advisoryLock(db, which === 'xero' ? ADVISORY_KEYS.xeroFinish : ADVISORY_KEYS.finchFinish)
    } catch (err) {
      open()
      throw err
    }
    let released = false
    return async () => {
      if (released) return
      released = true
      try {
        await unlock()
      } finally {
        open()
      }
    }
  }

  /**
   * The cap again at the callback, where Xero says which organisations were ticked: one sign-in can tick several, and
   * a workspace that already has Xero gets past the start check. Organisations already connected cost nothing; new ones
   * are kept in Xero's order while there's room. Each one past it is removed at Xero (DELETE /connections, the token
   * revoked only when nothing was kept), so the app never holds more than the plan allows. Returns what to keep and,
   * when some were left out, the sentence that says so.
   */
  async function fitXeroRoom(ws: string, connector: import('@agfn/contracts').Connector, result: import('@agfn/contracts').ConnectResult): Promise<{ result: import('@agfn/contracts').ConnectResult; note?: string }> {
    const max = config.xeroMaxConnections
    if (!max) return { result }
    const all = [{ secret: result.secret, config: result.config }, ...(result.additional ?? [])]
    const counted = await xeroTenants()
    let room = max - counted.size
    const keep: typeof all = []
    const drop: typeof all = []
    for (const r of all) {
      const t = typeof r.config.tenantId === 'string' ? r.config.tenantId : ''
      if (t && counted.has(t)) keep.push(r)
      else if (room > 0) {
        keep.push(r)
        room--
        if (t) counted.add(t)
      } else drop.push(r)
    }
    if (!drop.length) return { result }
    console.warn('[agfn] xero connection cap reached at callback', { kept: keep.length, ticked: all.length, max })
    for (const [i, d] of drop.entries()) {
      const last = keep.length === 0 && i === drop.length - 1
      await connector
        .disconnect?.({ id: 'xero_over_cap', workspaceId: ws, connectorKey: 'xero', secret: d.secret, config: { ...d.config, lastOfGrant: last } })
        .catch((err: unknown) => console.warn('[agfn] xero over-cap removal failed', { detail: err instanceof Error ? err.message.slice(0, 200) : 'unknown' }))
    }
    if (!keep.length) fail(409, XERO_FULL, { error: 'xero_limit', limit: max })
    const [first, ...rest] = keep
    const names = (list: typeof all) => list.map((r) => (typeof r.config.tenantName === 'string' ? r.config.tenantName : 'a Xero organisation')).join(', ')
    const note = `Xero is full for now, so we kept ${keep.length} of your ${all.length} companies (${names(keep)}). We'll have room for ${names(drop)} in a day or two; add it then from this Xero connection, or email support@aggregate.finance.`
    return { result: { ...result, secret: first!.secret, config: first!.config, additional: rest.length ? rest : undefined }, note }
  }

  /**
   * Finch's caps (config.finchMaxPerWorkspace, config.finchMaxConnections): Finch bills each connected company monthly.
   * Checked before the person is sent to Finch Connect. Connections that need reconnecting don't count toward the
   * workspace's limit, because reconnecting goes through this same start and replaces them. A workspace that already
   * has Finch may also reconnect when the overall limit is full.
   */
  async function assertFinchRoom(ws: string): Promise<void> {
    const perWs = config.finchMaxPerWorkspace
    const total = config.finchMaxConnections
    if (!perWs && !total) return
    const counted = ['active', 'paused'] as const
    const mine = await db.selectFrom('connections').select('status').where('workspace_id', '=', ws).where('connector_key', '=', 'finch').where('status', '!=', 'disconnected').execute()
    if (perWs && mine.filter((r) => (counted as readonly string[]).includes(r.status)).length >= perWs) {
      fail(409, perWs === 1 ? 'Payroll is already connected. Disconnect it in Connections to connect a different payroll system.' : `You've connected ${perWs} payroll systems, the most for now. Disconnect one to add another.`, { error: 'finch_limit', limit: perWs })
    }
    if (!total || mine.length) return
    const row = await withBypass('finch:connection_cap', () => db.selectFrom('connections').select((eb) => eb.fn.countAll<number>().as('n')).where('connector_key', '=', 'finch').where('status', 'in', [...counted]).executeTakeFirst())
    if (Number(row?.n ?? 0) < total) return
    console.warn('[agfn] finch connection cap reached', { n: Number(row?.n ?? 0), max: total })
    fail(409, 'New payroll connections are full right now. Try again in a few days, or email support@aggregate.finance and we’ll tell you when there’s room. Payroll still shows up from your bank data meanwhile.', { error: 'finch_limit', limit: total })
  }

  /**
   * One Plaid finish at a time per workspace, from the cap and duplicate checks until the connection row exists: the
   * public-token exchange (a new, billed Item) happens in between, so concurrent finishes (two tabs, two admins) would
   * each pass the checks and all exchange. A settings row is the lock, so it holds across server instances; a holder
   * that died leaves it stale after two minutes. Returns the release.
   */
  async function lockPlaidFinish(ws: string): Promise<() => Promise<void>> {
    const key = 'lock:plaid_finish'
    const token = JSON.stringify(randomBytes(12).toString('base64url'))
    // Wall clock, not loop turns: each turn is three queries, so counting turns would wait far longer than 20s.
    for (const deadline = Date.now() + 20_000; ; ) {
      await db.deleteFrom('settings').where('workspace_id', '=', ws).where('key', '=', key).where('updated_at', '<', new Date(Date.now() - 120_000).toISOString()).execute()
      await db.insertInto('settings').values({ workspace_id: ws, key, value_json: token, updated_at: new Date().toISOString() }).onConflict((oc) => oc.columns(['workspace_id', 'key']).doNothing()).execute()
      const held = await db.selectFrom('settings').select('value_json').where('workspace_id', '=', ws).where('key', '=', key).executeTakeFirst()
      if (held?.value_json === token) break
      if (Date.now() >= deadline) fail(409, 'Another bank is being connected right now. Try again in a moment.', { error: 'busy' })
      await new Promise((r) => setTimeout(r, 50))
    }
    return async () => void (await db.deleteFrom('settings').where('workspace_id', '=', ws).where('key', '=', key).where('value_json', '=', token).execute())
  }

  app.post('/api/connectors/:key/start', async (c) => {
    const ws = requireWs(c)
    const key = c.req.param('key')
    if (!s.registry.has(key)) notConfigured(key) || fail(404, 'That connection isn’t available on this server.')
    if (config.hidden?.includes(key)) fail(404, 'New connections to this service are paused for now. Ones you already have keep updating.')
    if (unlistedFor(c.get('person').email).includes(key)) fail(404, UNLISTED_MESSAGE[key] ?? 'That connection isn’t available yet.')
    await guardDemo(ws, key)
    if (!(await s.permissions.canManageWorkspace(ws, c.get('person').personId))) fail(403, 'Only an owner or admin can add connections.')
    await requirePasskeyCheck(s, c.get('person').personId)
    if (key === 'plaid') await assertPlaidRoom(ws)
    if (key === 'xero') await assertXeroRoom(ws)
    if (key === 'finch') await assertFinchRoom(ws)
    const connector = s.registry.create(key, { raw: { put: async () => '' } })
    const d = connector.describe()
    const startBody = await c.req
      .json<{ entityId?: string | null; returnTo?: string; investmentsFirst?: boolean }>()
      .catch(() => ({}) as { entityId?: string | null; returnTo?: string; investmentsFirst?: boolean })
    const entityId = startBody.entityId ?? null
    // Where a redirect sign-in comes back to (the app's own route, e.g. "/onboarding"), so onboarding carries on.
    const returnTo = safeAppRoute(startBody.returnTo)
    if (entityId && !(await canConnectTo(c, ws, entityId))) fail(403, 'You can’t add connections to that company.')
    // Pressed Reconnect on a connection a few minutes ago (routes/connections.ts): this sign-in is for that one, so the
    // finish can put the new sign-in into it even when the provider names no company to match on.
    const target = await db.selectFrom('settings').select(['value_json', 'updated_at']).where('workspace_id', '=', ws).where('key', '=', `reconnect_target:${key}:${c.get('person').personId}`).executeTakeFirst()
    await db.deleteFrom('settings').where('workspace_id', '=', ws).where('key', '=', `reconnect_target:${key}:${c.get('person').personId}`).execute()
    const reconnectId = target && Date.now() - Date.parse(target.updated_at) < 30 * 60_000 ? (JSON.parse(target.value_json) as string) : undefined
    const state = randomBytes(24).toString('base64url')
    await db
      .insertInto('settings')
      .values({ workspace_id: ws, key: `connect_state:${state}`, value_json: JSON.stringify({ key, personId: c.get('person').personId, entityId, at: Date.now(), ...(returnTo ? { returnTo } : {}), ...(reconnectId ? { reconnectId } : {}) }), updated_at: new Date().toISOString() })
      .execute()
    if (connector.begin) {
      // investmentsFirst: Plaid Link for a brokerage-only login (the app retries with it after Link's NO_ACCOUNTS).
      const begin = await connector.begin({
        workspaceId: ws,
        redirectUri: `${config.baseUrl}/api/connectors/${key}/callback`,
        state,
        userRef: c.get('person').personId,
        ...(key === 'plaid' && startBody.investmentsFirst === true ? { investmentsFirst: true } : {}),
      })
      const ui = begin.kind === 'link_widget' && begin.provider === 'plaid' ? { kind: 'plaid_link', linkToken: begin.token } : begin
      return c.json({ ...ui, state })
    }
    if (d.auth === 'file') return c.json({ kind: 'upload', accept: '.csv,.ofx,.qfx,.qbo,.xml,.pdf', state })
    return c.json({ kind: 'api_key', label: `${d.name} key`, helpUrl: '', placeholder: '', state })
  })

  /** Validates the single-use connect state, exchanges the input for a secret, saves and syncs the connection. */
  /**
   * The connection in this workspace that already reads what a new sign-in reads: the same provider company or account
   * (providerOrgOf, from config, or from the secret for BILL's organisation), or, for providers that name none (Deel,
   * Wefunder, Coinbase), the one the person pressed Reconnect on. Records are keyed on the connection, so a second row
   * for the same company would count it twice.
   */
  async function sameSource(ws: string, key: string, r: { secret: unknown; config: Record<string, unknown> }, reconnectId?: string): Promise<{ id: string; status: string; display_name: string; config_json: string } | null> {
    const rows = await db.selectFrom('connections').select(['id', 'status', 'display_name', 'config_json', 'secret_enc']).where('workspace_id', '=', ws).where('connector_key', '=', key).where('status', '!=', 'disconnected').execute()
    const want = providerOrgOf(JSON.stringify(r.config)) ?? (r.secret && typeof r.secret === 'object' ? providerOrgOf(JSON.stringify(r.secret)) : null)
    if (want) {
      for (const row of rows) {
        let have = providerOrgOf(row.config_json)
        if (!have && row.secret_enc) {
          try {
            have = providerOrgOf(JSON.stringify(unseal(s.keys, row.secret_enc, { workspaceId: ws, recordId: row.id, purpose: SECRET_PURPOSE })))
          } catch {
            /* unreadable secret: not a match */
          }
        }
        if (have === want) return row
      }
      return null
    }
    return (reconnectId && rows.find((row) => row.id === reconnectId && !LIVE_STATUSES.has(row.status))) || null
  }

  /** A reconnect: the new sign-in goes into the existing connection (its config kept, the provider's answer on top). */
  async function adoptInto(ws: string, row: { id: string; config_json: string }, r: { secret: unknown; config: Record<string, unknown> }): Promise<string> {
    const config = { ...(JSON.parse(row.config_json || '{}') as Record<string, unknown>), ...r.config }
    await db
      .updateTable('connections')
      .set({ secret_enc: seal(s.keys, r.secret, { workspaceId: ws, recordId: row.id, purpose: SECRET_PURPOSE }), config_json: JSON.stringify(config), status: 'active', last_error: null })
      .where('id', '=', row.id)
      .where('workspace_id', '=', ws)
      .execute()
    await clearAttention(db as unknown as Kysely<CoreTables & ConnectorTables>, row.id)
    return row.id
  }

  /** `out.note`: a sentence for the person when the connect finished with less than they picked (Xero's cap). */
  async function finishConnect(c: Context<Env>, key: string, input: Record<string, string> & Record<string, unknown>, out?: { note?: string }) {
    const ws = requireWs(c)
    // Not installed answers first (409 with a guide, else 404), whatever the state: no "expired, start again" loop.
    if (!s.registry.has(key)) notConfigured(key) || fail(404, 'That connection isn’t available on this server.')
    const state = input.state
    if (!state) fail(400, 'This connection attempt expired. Start again.')
    const st = await db.selectFrom('settings').select('value_json').where('workspace_id', '=', ws).where('key', '=', `connect_state:${state}`).executeTakeFirst()
    await db.deleteFrom('settings').where('workspace_id', '=', ws).where('key', '=', `connect_state:${state}`).execute()
    const parsed = st ? (JSON.parse(st.value_json) as { key: string; personId: string; entityId: string | null; at: number; returnTo?: string; reconnectId?: string }) : null
    if (!parsed) {
      // The same callback again (a provider redirecting twice, a browser retry, a refresh): answer with the connection
      // the first one made instead of "expired", waiting while the first is still exchanging the code (pending).
      for (let i = 0; i < 20; i++) {
        const done = await connectDone(ws, state)
        if (!done || done.key !== key || done.personId !== c.get('person').personId) break
        if (done.connectionId) return done.connectionId
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    if (!parsed || parsed.key !== key || parsed.personId !== c.get('person').personId || Date.now() - parsed.at > 30 * 60_000) fail(400, 'This connection attempt expired. Start again.')
    const doneKey = `connect_done:${state}`
    const markDone = async (connectionId: string | null) => {
      const value_json = JSON.stringify({ key, personId: c.get('person').personId, connectionId, ...(parsed.returnTo ? { returnTo: parsed.returnTo } : {}) })
      await db.insertInto('settings').values({ workspace_id: ws, key: doneKey, value_json, updated_at: new Date().toISOString() }).onConflict((oc) => oc.columns(['workspace_id', 'key']).doUpdateSet({ value_json, updated_at: new Date().toISOString() })).execute()
    }
    await db.deleteFrom('settings').where('workspace_id', '=', ws).where('key', 'like', 'connect_done:%').where('updated_at', '<', new Date(Date.now() - CONNECT_DONE_MS).toISOString()).execute()
    await markDone(null)
    await guardDemo(ws, key)
    const connector = s.registry.create(key, { raw: { put: async () => '' } })
    // Plaid never dedupes: refuse a second Item for a login this workspace already has, before exchanging the token.
    // The cap is checked again here (two tabs could both have started under it); before the exchange, nothing is billed.
    // Held until the connection row exists, so concurrent finishes are counted one after another.
    const release = key === 'plaid' ? await lockPlaidFinish(ws) : async () => {}
    // Xero's and Finch's room is counted again here and held until every new row exists (released below).
    let releaseCap: (() => Promise<void>) | null = null
    /** Connections that took this sign-in in place of a new row (a reconnect). */
    const reconnected = new Set<string>()
    let result: import('@agfn/contracts').ConnectResult
    let connectionId: string
    // A connector may name the connection after what was connected ("Xero · Demo Company (US)"); else the provider name.
    // Started without a company (the Connections page) in a workspace with just one (often only Personal): it's that
    // one. Otherwise nothing it brings counts until someone picks, and the picker lists companies, not Personal.
    // Banks (Plaid) place each account instead.
    let only: string | null | undefined
    const onlyEntity = async (): Promise<string | null> => {
      if (only !== undefined) return only
      const all = key === 'plaid' ? [] : await db.selectFrom('entities').select('id').where('workspace_id', '=', ws).where('archived_at', 'is', null).limit(2).execute()
      only = all.length === 1 && (await canConnectTo(c, ws, all[0]!.id)) ? all[0]!.id : null
      return only
    }
    const nameOf = (cfg: Record<string, unknown>) => (typeof cfg.displayName === 'string' && cfg.displayName.trim() ? cfg.displayName.trim().slice(0, 120) : connector.describe().name)
    try {
      // Finch bills each connected company: the cap again before the exchange, like Plaid's, held until the row exists.
      if (key === 'finch') {
        releaseCap = await lockCapFinish('finch')
        await assertFinchRoom(ws)
      }
      if (key === 'plaid') {
        await assertPlaidRoom(ws)
        const dup = await plaidDuplicateMessage(db, ws, input)
        if (dup) fail(409, dup.message, { error: 'duplicate', connectionId: dup.connectionId })
      }
      // The provider's own `state` param stays here; the connect attempt's state goes as connectState, for connectors
      // that derive a per-attempt value from it (Wefunder's PKCE verifier). It was checked and used up above.
      const { state: _s, ...rest } = input
      try {
        result = await connector.connect({ ...rest, connectState: state, redirectUri: `${config.baseUrl}/api/connectors/${key}/callback` })
      } catch (err) {
        // The provider's own words go to the log (with its request id); the person gets a sentence they can act on.
        console.warn('[agfn] connect failed', { connector: key, ...(isConnectorError(err) ? { kind: err.kind, code: err.code, status: err.status, requestId: err.requestId } : {}), detail: err instanceof Error ? err.message.slice(0, 300) : 'unknown' })
        fail(422, plainError(err, connector.describe().name, 'connect').message)
      }
      if (key === 'xero') {
        releaseCap = await lockCapFinish('xero')
        const fit = await fitXeroRoom(ws, connector, result)
        result = fit.result
        if (fit.note && out) out.note = fit.note
      }
      // The same provider company already here: a connection whose sign-in ended takes the new one (same records, same
      // history, nothing counted twice); a working one is never added a second time. Plaid dedupes its own way above.
      const same = key === 'plaid' ? null : await sameSource(ws, key, result, parsed.reconnectId)
      if (same && LIVE_STATUSES.has(same.status)) fail(409, `${same.display_name} is already connected. Open it under Connections instead of adding it again.`, { error: 'duplicate', connectionId: same.id })
      if (same) {
        connectionId = await adoptInto(ws, same, result)
        reconnected.add(connectionId)
      } else connectionId = await createConnection(db, s.keys, { workspaceId: ws, connectorKey: key, displayName: nameOf(result.config), secret: result.secret, config: result.config, createdBy: c.get('person').personId, entityId: parsed.entityId ?? (await onlyEntity()) })
    } catch (err) {
      // Failed: a repeated callback should say so too, not wait on a connection that won't come.
      await db.deleteFrom('settings').where('workspace_id', '=', ws).where('key', '=', doneKey).execute()
      await releaseCap?.()
      throw err
    } finally {
      await release()
    }
    // More connections from the same sign-in (each Xero organisation ticked): one each. The first gets the company
    // the person started from; the others a company of the same name, if there is one, else the workspace's only one.
    const extra: string[] = []
    try {
      if (result.additional?.length) {
        const companies = await db.selectFrom('entities').select(['id', 'name']).where('workspace_id', '=', ws).where('kind', '=', 'company').where('archived_at', 'is', null).execute()
        for (const more of result.additional) {
          const org = typeof more.config.tenantName === 'string' ? more.config.tenantName.trim().toLowerCase() : ''
          const match = org ? companies.find((e) => e.name.trim().toLowerCase() === org) : undefined
          const same = await sameSource(ws, key, more)
          if (same && LIVE_STATUSES.has(same.status)) continue // already here and working
          if (same) {
            const id = await adoptInto(ws, same, more)
            reconnected.add(id)
            extra.push(id)
          } else extra.push(await createConnection(db, s.keys, { workspaceId: ws, connectorKey: key, displayName: nameOf(more.config), secret: more.secret, config: more.config, createdBy: c.get('person').personId, entityId: match?.id ?? (await onlyEntity()) }))
        }
      }
    } finally {
      await releaseCap?.()
    }
    for (const id of [connectionId, ...extra]) {
      const row = await db.selectFrom('connections').select('display_name').where('id', '=', id).executeTakeFirst()
      await logConnectionChange(s, ws, id, c.get('person').personId, 'connection.connected', `${reconnected.has(id) ? 'Reconnected' : 'Connected'} ${row?.display_name ?? connector.describe().name}`)
    }
    // Remember the outcome for a few minutes, so a repeated callback lands on the same connection.
    await markDone(connectionId)
    for (const id of [connectionId, ...extra]) await s.sync.sync(id).catch(() => undefined)
    return connectionId
  }

  /** A connect that already finished with this state, within the last few minutes. */
  async function connectDone(ws: string, state: string): Promise<{ key: string; personId: string; connectionId: string | null; returnTo?: string } | null> {
    const row = await db.selectFrom('settings').select(['value_json', 'updated_at']).where('workspace_id', '=', ws).where('key', '=', `connect_done:${state}`).executeTakeFirst()
    if (!row || Date.now() - Date.parse(row.updated_at) > CONNECT_DONE_MS) return null
    return JSON.parse(row.value_json) as { key: string; personId: string; connectionId: string | null; returnTo?: string }
  }

  app.post('/api/connectors/:key/finish', async (c) => {
    const connectionId = await finishConnect(c, c.req.param('key'), await c.req.json<Record<string, string>>())
    const accounts = await db.selectFrom('accounts').selectAll().where('connection_id', '=', connectionId).execute()
    const balances = await latestBalances(db, c.get('person').workspaceId!, accounts.map((a) => a.id))
    return c.json({
      connectionId,
      accounts: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        ...(a.mask ? { mask: a.mask } : {}),
        // The bank's own latest balance (from the first sync); null when the provider sent none.
        balance: balances.get(a.id) ?? null,
        suggestedEntityId: a.business_hint === 'personal' ? 'personal' : null,
      })),
    })
  })

  const shopifyAttach = async (c: Context<Env>, confirmed: boolean) => {
    const link = getCookie(c, SHOPIFY_LINK_COOKIE)
    const drop = () => deleteCookie(c, SHOPIFY_LINK_COOKIE, { path: '/api' })
    // `connector` opens the Shopify drawer with the note pinned there (a toast in a fresh tab is easy to miss).
    const back = (msg: string) => (drop(), c.redirect(`/#/?connect_error=${encodeURIComponent(msg)}&connector=shopify`))
    const ws = c.get('person').workspaceId
    if (!ws) return back('Create your workspace first, then open Aggregate from your Shopify admin again.')
    try {
      await guardDemo(ws, 'shopify')
    } catch {
      return back('The demo can’t hold real stores. Leave the demo, then open Aggregate from your Shopify admin again.')
    }
    if (!(await s.permissions.canManageWorkspace(ws, c.get('person').personId))) return back('Only an owner or admin can add connections.')
    const person = await db.selectFrom('people').select('email').where('id', '=', c.get('person').personId).executeTakeFirst()
    const pending = link && person?.email ? await takePendingByLink(s, link, person.email, { confirmed }) : null
    // Not consumed: the right person can still open the link from the Shopify admin until it expires.
    if (pending && 'wrongPerson' in pending) return back(`Sign in to Aggregate with the email you use for this Shopify store (${pending.wrongPerson}).`)
    if (pending && 'needsConfirm' in pending) {
      // The link stays in its cookie for the Connect button (a same-origin POST).
      const wsRow = await db.selectFrom('workspaces').select('name').where('id', '=', ws).executeTakeFirst()
      return confirmPage(c, pending.needsConfirm.replace(/\.myshopify\.com$/, ''), wsRow?.name ?? 'this workspace')
    }
    if (!pending) return back('That Shopify link expired or was already used. Open Aggregate from your Shopify admin again.')
    drop()
    // The store reinstalled while this workspace's connection to it needs reconnecting: the new token goes into that
    // connection (same history, same company, nothing counted twice), not into a second one next to it.
    const stuck = (await db.selectFrom('connections').select(['id', 'config_json', 'display_name']).where('workspace_id', '=', ws).where('connector_key', '=', 'shopify').where('status', '=', 'needs_reauth').execute()).find(
      (r) => (JSON.parse(r.config_json) as { shop?: string }).shop === pending.shop,
    )
    if (stuck) {
      try {
        const result = await s.registry.create('shopify', { raw: { put: async () => '' } }).connect({ shop: pending.shop, adopt: pending.secret } as never)
        const config = { ...(JSON.parse(stuck.config_json) as Record<string, unknown>), ...result.config }
        await db
          .updateTable('connections')
          .set({ secret_enc: seal(s.keys, result.secret, { workspaceId: ws, recordId: stuck.id, purpose: SECRET_PURPOSE }), config_json: JSON.stringify(config), status: 'active', last_error: null })
          .where('id', '=', stuck.id)
          .where('workspace_id', '=', ws)
          .execute()
        await clearAttention(db as unknown as Kysely<CoreTables & ConnectorTables>, stuck.id)
        await dropPending(s, pending.shop)
        await logConnectionChange(s, ws, stuck.id, c.get('person').personId, 'connection.connected', `Reconnected ${stuck.display_name} from Shopify admin`)
        await s.sync.request(ws, stuck.id)
        return c.redirect(`/#/?d=connection:${stuck.id}`)
      } catch (err) {
        console.warn('[agfn] shopify reconnect failed', { detail: err instanceof Error ? err.message.slice(0, 200) : 'unknown' })
        return back('Reconnecting the store didn’t finish. Open Aggregate from your Shopify admin again.')
      }
    }
    // Through the normal finish (demo, naming, first sync, activity), with a one-time state for this person.
    const state = randomBytes(24).toString('base64url')
    await db
      .insertInto('settings')
      .values({ workspace_id: ws, key: `connect_state:${state}`, value_json: JSON.stringify({ key: 'shopify', personId: c.get('person').personId, entityId: null, at: Date.now() }), updated_at: new Date().toISOString() })
      .execute()
    try {
      const connectionId = await finishConnect(c, 'shopify', { state, shop: pending.shop, adopt: pending.secret } as never)
      await dropPending(s, pending.shop)
      return c.redirect(`/#/?d=connection:${connectionId}`)
    } catch (err) {
      const msg = err instanceof HTTPException ? ((await err.getResponse().json().catch(() => ({}))) as { message?: string }).message : undefined
      return back(msg ?? 'That connection didn’t finish. Open Aggregate from your Shopify admin again.')
    }
  }
  // The "Connect to Aggregate" link from the embedded page, after sign-in: the store's waiting token becomes a
  // connection in this person's workspace. The link is one-time, short-lived and bound to the Shopify staff member's
  // email; when Shopify named nobody, the person confirms "Connect <store> to <workspace>?" first.
  app.get('/api/connectors/shopify/install/resume', (c) => shopifyAttach(c, false))
  app.post('/api/connectors/shopify/install/confirm', (c) => shopifyAttach(c, true))
  app.post('/api/connectors/shopify/install/cancel', (c) => {
    deleteCookie(c, SHOPIFY_LINK_COOKIE, { path: '/api' })
    return c.redirect('/')
  })

  /** The app route saved with a connect state ("/" when none, or the state is unknown). Doesn't use the state up. */
  async function connectReturnTo(ws: string | null | undefined, state: string | undefined): Promise<string> {
    if (!ws || !state) return '/'
    const row = await db.selectFrom('settings').select('value_json').where('workspace_id', '=', ws).where('key', '=', `connect_state:${state}`).executeTakeFirst()
    const saved = row ? (JSON.parse(row.value_json) as { returnTo?: unknown }).returnTo : (await connectDone(ws, state))?.returnTo
    return safeAppRoute(saved) ?? '/'
  }

  // OAuth providers (Stripe, QuickBooks, Xero…) send the browser back here with ?code&state.
  app.get('/api/connectors/:key/callback', async (c) => {
    const q = Object.fromEntries(new URL(c.req.url).searchParams)
    // `connector` lets the app reopen the same connector with a "Try again", rather than a dead end.
    const which = `&connector=${encodeURIComponent(c.req.param('key'))}`
    // Back to where the person started (onboarding, a company page), read before the state is used up.
    const route = await connectReturnTo(c.get('person').workspaceId, q.state)
    if (q.error) return c.redirect(`/#${route}?connect_error=${encodeURIComponent(q.error_description ?? q.error)}${which}`)
    try {
      // The untouched query rides along as `query`: providers that sign the whole callback (Shopify) verify it.
      const out: { note?: string } = {}
      const connectionId = await finishConnect(c, c.req.param('key'), Object.assign({ ...q }, { query: q }), out)
      // A note (some Xero organisations left out) shows as one line over the new connection's drawer.
      return c.redirect(`/#${route}?d=connection:${connectionId}${out.note ? `&connect_error=${encodeURIComponent(out.note)}` : ''}`)
    } catch (err) {
      const msg = err instanceof HTTPException ? ((await err.getResponse().json().catch(() => ({}))) as { message?: string }).message : undefined
      return c.redirect(`/#${route}?connect_error=${encodeURIComponent(msg ?? 'That connection didn’t finish. Try again.')}${which}`)
    }
  })

  app.post('/api/accounts/assign', async (c) => {
    const ws = requireWs(c)
    const { assignments } = await c.req.json<{ assignments: Array<{ accountId: string; entityId: string }> }>()
    const personal = await db.selectFrom('entities').select('id').where('workspace_id', '=', ws).where('kind', '=', 'personal').where('owner_person_id', '=', c.get('person').personId).executeTakeFirst()
    for (const a of assignments ?? []) {
      const acct = await db.selectFrom('accounts').select(['id', 'workspace_id']).where('id', '=', a.accountId).executeTakeFirst()
      if (!acct || acct.workspace_id !== ws) fail(404, 'One of those accounts no longer exists.')
      if (a.entityId === 'skip') {
        await db.updateTable('accounts').set({ include_in_cash: 0, closed_at: new Date().toISOString() }).where('id', '=', a.accountId).execute()
        await s.ledger.accountChanged?.(ws, a.accountId)
        continue
      }
      const entityId = a.entityId === 'personal' ? personal?.id : a.entityId
      if (!entityId || !(await s.permissions.can(actorOf(c), 'add', entityId, 'balances'))) fail(403, 'You can’t add accounts to that company.')
      await db.updateTable('accounts').set({ entity_id: entityId }).where('id', '=', a.accountId).execute()
      await s.ledger.accountChanged?.(ws, a.accountId)
    }
    return c.json({ ok: true })
  })

  // Connection drawer: the summary row plus its accounts (only those in companies this person can see balances for).
  app.get('/api/connections/:id', async (c) => {
    const ws = requireWs(c)
    const id = c.req.param('id')
    const summary = (await connectionSummaries(s, ws)).find((x) => x.id === id)
    if (!summary) fail(404, 'That connection no longer exists.')
    const rows = await db
      .selectFrom('accounts')
      .select(['id', 'entity_id', 'name', 'mask', 'institution', 'account_type', 'currency'])
      .where('workspace_id', '=', ws)
      .where('connection_id', '=', id)
      .where('closed_at', 'is', null)
      .execute()
    const visible = (await s.permissions.entitiesFor(ws, c.get('person').personId)).map((e) => e.id)
    const allowed: string[] = []
    for (const e of [...new Set(rows.map((r) => r.entity_id).filter((x): x is string => !!x && visible.includes(x)))])
      if (await s.permissions.can(actorOf(c), 'view', e, 'balances')) allowed.push(e)
    // Balances come from the ledger when it has them; an account with none yet shows 0 and "synced …".
    const views = allowed.length ? await financeFor(s).reader.accounts({ workspaceId: ws, entityIds: allowed }, {}).catch(() => []) : []
    const byId = new Map(views.map((v) => [v.id, v]))
    const terms = await termsByAccount(financeFor(s).reader, { workspaceId: ws, entityIds: allowed })
    const now = Date.now()
    const accounts = rows
      .filter((r) => r.entity_id && allowed.includes(r.entity_id))
      .map((r) => {
        const v = byId.get(r.id)
        const at = v?.lastSyncAt ?? summary.lastSyncAt
        return {
          id: r.id,
          name: r.name,
          // Which company (or Personal) it counts toward: the drawer's per-account "Move to another company".
          entityId: r.entity_id,
          institution: r.institution ?? summary.name,
          ...(r.mask ? { mask: r.mask } : {}),
          kind: ACCOUNT_KIND[r.account_type] ?? 'bank',
          // Never reported a balance: null (the drawer says "unknown"), never a made-up $0.
          balance: v?.balance ?? null,
          asOf: at ?? new Date(now).toISOString(),
          stale: !at || now - Date.parse(at) > 48 * 3600_000,
          ...(terms.has(r.id) ? { terms: terms.get(r.id) } : {}),
        }
      })
    // Accounts nobody has placed yet: owners and admins choose a company (or Personal, or don't sync) right here.
    const unassigned = (await s.permissions.canManageWorkspace(ws, c.get('person').personId))
      ? rows.filter((r) => !r.entity_id).map((r) => ({ id: r.id, name: r.name, ...(r.mask ? { mask: r.mask } : {}) }))
      : []
    const provides = s.registry.has(summary.connectorKey) ? s.registry.list().find((d) => d.key === summary.connectorKey)?.provides ?? [] : []
    // Live balance checks exist only for connectors that support them (Plaid); the drawer hides the button otherwise.
    const canRefreshBalance = s.registry.has(summary.connectorKey) && typeof s.registry.create(summary.connectorKey, { raw: { put: async () => '' } }).refreshBalances === 'function'
    // Accounting and payroll connections bring records, not bank accounts: say whether anything came in yet.
    const records = accounts.length
      ? undefined
      : Number((await db.selectFrom('raw_records').select((eb) => eb.fn.countAll<number>().as('n')).where('workspace_id', '=', ws).where('connection_id', '=', id).executeTakeFirst())?.n ?? 0)
    // The disconnect drawer can't promise "it stays" where the rule (retire.ts) deletes the data anyway.
    const erasesOnDisconnect = ERASE_ON_DISCONNECT.has(summary.connectorKey) ? ('always' as const) : ERASE_WHEN_REVOKED.has(summary.connectorKey) ? ('maybe' as const) : undefined
    return c.json({ ...summary, accounts, unassigned, provides, canRefreshBalance, ...(records !== undefined ? { records } : {}), ...(erasesOnDisconnect ? { erasesOnDisconnect } : {}) })
  })

  app.post('/api/connections/:id/sync', async (c) => {
    const ws = requireWs(c)
    const conn = await db.selectFrom('connections').select('id').where('id', '=', c.req.param('id')).where('workspace_id', '=', ws).executeTakeFirst()
    if (!conn) fail(404, 'That connection no longer exists.')
    await s.sync.request(ws, conn.id)
    return c.json({ ok: true })
  })

  // Which company a connection belongs to (e.g. a second Xero organisation from one sign-in). Its accounts that were
  // unplaced or on the old company follow; held and posted rows re-post locally, with no provider calls.
  app.post('/api/connections/:id/company', async (c) => {
    const ws = requireWs(c)
    const id = c.req.param('id')
    const conn = await db.selectFrom('connections').select(['id', 'entity_id']).where('id', '=', id).where('workspace_id', '=', ws).executeTakeFirst()
    if (!conn) fail(404, 'That connection no longer exists.')
    if (!(await s.permissions.canManageWorkspace(ws, c.get('person').personId))) fail(403, 'Only an owner or admin can move a connection.')
    const { entityId } = await c.req.json<{ entityId?: string }>().catch(() => ({ entityId: undefined }))
    const entity = entityId ? await db.selectFrom('entities').select('id').where('id', '=', entityId).where('workspace_id', '=', ws).executeTakeFirst() : undefined
    if (!entity) fail(404, 'That company no longer exists.')
    if (!(await canConnectTo(c, ws, entity.id))) fail(403, 'You can’t add connections to that company.')
    if (conn.entity_id === entity.id) return c.json({ ok: true, moved: 0 })
    const accounts = await db
      .selectFrom('accounts')
      .select('id')
      .where('workspace_id', '=', ws)
      .where('connection_id', '=', id)
      .where((eb) => (conn.entity_id ? eb.or([eb('entity_id', 'is', null), eb('entity_id', '=', conn.entity_id)]) : eb('entity_id', 'is', null)))
      .execute()
    const at = new Date().toISOString()
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('connections').set({ entity_id: entity.id }).where('id', '=', id).execute()
      if (accounts.length) await tx.updateTable('accounts').set({ entity_id: entity.id }).where('id', 'in', accounts.map((a) => a.id)).execute()
      // Queued in the same transaction, so a crash before the re-post finishes is picked up at boot.
      const q = tx as unknown as Kysely<{ account_reassignments: { id: string; workspace_id: string; account_id: string; created_at: string } }>
      for (const a of accounts) await q.insertInto('account_reassignments').values({ id: `move_${a.id}_${Date.parse(at)}`, workspace_id: ws, account_id: a.id, created_at: at }).execute()
    })
    // Invoices, bills and payroll runs the books store holds for it follow; then the ledger re-posts.
    await financeFor(s).books.connectionMoved(ws, id, entity.id)
    await applyPendingReassignments(db, s.ledger)
    await s.ledger.connectionChanged?.(ws, id)
    await s.ledger.directoryChanged?.(ws)
    return c.json({ ok: true, moved: accounts.length })
  })

  // Organisations this connection's sign-in can reach that aren't connected here yet (Xero lists every one the person
  // ever shared with Aggregate; a later sign-in can't tick those again). Offered, never added on their own.
  app.get('/api/connections/:id/shared', async (c) => {
    const ws = requireWs(c)
    if (!(await s.permissions.canManageWorkspace(ws, c.get('person').personId))) return c.json({ offers: [] })
    const id = c.req.param('id')
    const conn = await db.selectFrom('connections').select(['id', 'status']).where('id', '=', id).where('workspace_id', '=', ws).executeTakeFirst()
    if (!conn || conn.status === 'disconnected') fail(404, 'That connection no longer exists.')
    const offers = await s.sync.sharedOffers(id).catch(() => [])
    return c.json({ offers: offers.map((o) => ({ id: o.id, name: o.name })) })
  })

  app.post('/api/connections/:id/shared', async (c) => {
    const ws = requireWs(c)
    const personId = c.get('person').personId
    if (!(await s.permissions.canManageWorkspace(ws, personId))) fail(403, 'Only an owner or admin can add connections.')
    const id = c.req.param('id')
    const conn = await db.selectFrom('connections').select(['id', 'status', 'connector_key']).where('id', '=', id).where('workspace_id', '=', ws).executeTakeFirst()
    if (!conn || conn.status === 'disconnected') fail(404, 'That connection no longer exists.')
    await guardDemo(ws, conn.connector_key)
    // Adding a connection is connecting an account: the same re-check.
    await requirePasskeyCheck(s, personId)
    const { id: offerId } = await c.req.json<{ id?: string }>().catch(() => ({ id: undefined }))
    if (!offerId) fail(400, 'Choose what to add.')
    const offers = await s.sync.sharedOffers(id)
    const offer = offers.find((o) => o.id === offerId)
    if (!offer) fail(409, 'That isn’t available to add any more (it may already be connected).')
    // A company of the same name, if there is one, like the organisations ticked at sign-in.
    const companies = await db.selectFrom('entities').select(['id', 'name']).where('workspace_id', '=', ws).where('kind', '=', 'company').where('archived_at', 'is', null).execute()
    const match = companies.find((e) => e.name.trim().toLowerCase() === offer.name.trim().toLowerCase())
    const added = await s.sync.addShared(id, offerId, { createdBy: personId, entityId: match?.id ?? null })
    await logConnectionChange(s, ws, added.connectionId, personId, 'connection.added', `Added ${added.displayName}, already shared with Aggregate in Xero`)
    await s.sync.sync(added.connectionId).catch(() => undefined)
    return c.json({ connectionId: added.connectionId, name: added.displayName }, 201)
  })

  app.post('/api/connections/:id/disconnect', async (c) => {
    const ws = requireWs(c)
    if (!(await s.permissions.canManageWorkspace(ws, c.get('person').personId))) fail(403, 'Only an owner or admin can remove connections.')
    const asked = await c.req.json<{ deleteData?: boolean }>().catch(() => ({ deleteData: false }))
    const id = c.req.param('id')
    const conn = await db.selectFrom('connections').select(['id', 'display_name', 'connector_key']).where('id', '=', id).where('workspace_id', '=', ws).executeTakeFirst()
    if (!conn) fail(404, 'That connection no longer exists.')
    // Some providers' terms require their data deleted when the person disconnects: deleted, not only retired.
    const out = await s.sync.disconnect(id)
    const erase = ERASE_ON_DISCONNECT.has(conn.connector_key) || (ERASE_WHEN_REVOKED.has(conn.connector_key) && out.revoked)
    const deleteData = asked.deleteData === true || erase
    await logConnectionChange(s, ws, id, c.get('person').personId, 'connection.disconnected', `Disconnected ${conn.display_name}${erase ? ', and its data deleted' : deleteData ? ', and its data no longer counts' : '; its data until now still counts'}`)
    if (erase) {
      await eraseConnectionData(s, ws, id)
      await db.deleteFrom('raw_records').where('connection_id', '=', id).execute()
      await db.updateTable('accounts').set({ include_in_cash: 0, closed_at: new Date().toISOString() }).where('connection_id', '=', id).execute()
    } else if (deleteData) {
      // Its entries stop counting in the books (reconnecting the same provider would otherwise count it twice), its
      // documents and payroll runs too, and the activity log says so.
      await retireDeleted(s, ws, id)
      await db.deleteFrom('raw_records').where('connection_id', '=', id).execute()
      await db.updateTable('accounts').set({ include_in_cash: 0, closed_at: new Date().toISOString() }).where('connection_id', '=', id).execute()
    }
    // Its uploaded files go with its data (a company with nothing else left in it can then be deleted).
    if (deleteData) await deleteConnectionFiles(db, s.files, ws, id, (msg, f) => console.warn('[agfn]', msg, f ?? ''))
    // Removed here either way; `warning` says what to finish at the provider (e.g. Xero's Connected apps).
    return c.json({ ok: true, dataDeleted: deleteData, ...(out.warning ? { warning: out.warning } : {}) })
  })

  // ---------- Connect your AI: the control-sentence consent step ----------
  app.post('/api/ai/consent', async (c) => {
    const ws = requireWs(c)
    if (!s.mcp) fail(503, 'The AI connection is not installed on this server yet.')
    const p = c.get('person')
    const body = await c.req.json<{ clientId: string; clientName?: string; shape: unknown; disclosureVersion?: string; oauthQuery?: string }>()
    if (!body.clientId) fail(400, 'This AI connection request is incomplete. Start again from your AI app.')
    // An expired or altered link creates nothing, so no unused AI shows up on the person's list. Better Auth doesn't
    // export its check, but runs it on any request carrying oauth_query; with no step named, continue then stops there.
    if (body.oauthQuery) {
      const checked = await s.auth.handler(new Request(`${config.baseUrl.replace(/\/+$/, '')}/api/auth/oauth2/continue`, { method: 'POST', headers: { 'content-type': 'application/json', origin: config.baseUrl, cookie: c.req.header('cookie') ?? '' }, body: JSON.stringify({ oauth_query: body.oauthQuery }) }))
      if (((await checked.json().catch(() => ({}))) as { error?: string }).error === 'invalid_signature') return c.json({ message: 'This link expired. Start again from your AI app.', error: 'invalid_signature' }, 400)
    }
    const consent = consentShown(body.disclosureVersion, aiDisclosure(body.clientName ?? body.clientId))
    const shape = body.shape as GrantShape | undefined
    if (!shape || typeof shape !== 'object' || !Array.isArray(shape.dataTypes) || !(shape.entityIds === 'all' || Array.isArray(shape.entityIds))) fail(422, 'Choose what this AI can see before continuing.')
    // Starting this client again: an earlier attempt that never finished is revoked, not left behind as a phantom AI.
    await revokeUnboundOauthGrants(db, { olderThanMs: 0, personId: p.personId, clientId: body.clientId })
    const grant = await s.mcp.control.createGrant(
      { workspaceId: ws, personId: p.personId, ...(p.ip ? { ip: p.ip } : {}), ...(c.req.header('user-agent') ? { userAgent: c.req.header('user-agent')! } : {}) },
      { clientId: body.clientId, clientName: body.clientName ?? body.clientId, kind: 'oauth', shape, ...(consent ? { consent } : {}) },
    )
    const grantId = grant.id
    await s.pendingGrants.set(p.sessionId, body.clientId, p.personId, grantId)
    return c.json({ grantId, next: '/api/auth/oauth2/continue' })
  })

  // ---------- Documents: upload a statement, receipt or paper bill ----------
  app.post('/api/documents', async (c) => {
    const ws = requireWs(c)
    const form = await c.req.formData().catch(() => null)
    const file = form?.get('file')
    const entityId = String(form?.get('entityId') ?? '')
    if (!file || typeof file === 'string') fail(422, 'Choose a file to upload.')
    if (!entityId || !(await s.permissions.can(actorOf(c), 'add', entityId, 'documents'))) fail(403, 'You can’t add files to that company.')
    try {
      const accountId = String(form?.get('accountId') ?? '') || undefined
      const out = await s.documents.upload({ workspaceId: ws, entityId, personId: c.get('person').personId, filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()), arrivedVia: 'upload', ...(accountId ? { accountId } : {}) })
      return c.json({ documentId: out.documentId, name: out.name, state: out.state, message: out.message, ...(out.accounts ? { accounts: out.accounts } : {}), ...(out.question ? { question: out.question } : {}) }, out.duplicate ? 200 : 201)
    } catch (err) {
      if (err instanceof UploadError) fail(422, err.message, err.code ? { error: err.code } : {})
      throw err
    }
  })

  // Statements waiting for "which account is this for?" (email-in, or an upload left unanswered), only for companies
  // this person may add documents to. GET /api/documents?state=needs_account → [{documentId, name, entityId, arrivedVia,
  // createdAt, accounts}]. GET /api/documents (state=unread) → documents waiting to be read: [{documentId, name,
  // entityId, arrivedVia, createdAt, mimeType, sizeBytes}], newest first, at most 100.
  app.get('/api/documents', async (c) => {
    const ws = requireWs(c)
    const state = c.req.query('state') ?? 'unread'
    if (state === 'unread') {
      // Waiting to be read: newest first, only companies this person can see documents in.
      const rows = await db.selectFrom('documents').select(['id', 'original_name', 'entity_id', 'arrived_via', 'created_at', 'mime_type', 'size_bytes']).where('workspace_id', '=', ws).where('status', '=', 'unread').orderBy('created_at', 'desc').limit(200).execute()
      const list = []
      for (const d of rows) {
        if (!d.entity_id || !(await s.permissions.can(actorOf(c), 'view', d.entity_id, 'documents'))) continue
        list.push({ documentId: d.id, name: d.original_name ?? 'document', entityId: d.entity_id, arrivedVia: d.arrived_via, createdAt: d.created_at, mimeType: d.mime_type, sizeBytes: d.size_bytes })
        if (list.length === 100) break
      }
      return c.json(list)
    }
    if (state !== 'needs_account') fail(400, 'state is unread (default) or needs_account.')
    const out = []
    for (const d of await s.documents.waitingStatements(ws)) if (await s.permissions.can(actorOf(c), 'add', d.entityId, 'documents')) out.push(d)
    return c.json(out)
  })

  app.get('/api/documents/:id', async (c) => {
    const ws = requireWs(c)
    const doc = await db.selectFrom('documents').select(['id', 'entity_id', 'original_name', 'status', 'record_id', 'extracted_json']).where('id', '=', c.req.param('id')).where('workspace_id', '=', ws).executeTakeFirst()
    if (!doc || !doc.entity_id || !(await s.permissions.can(actorOf(c), 'view', doc.entity_id, 'documents'))) fail(404, 'That file no longer exists.')
    const st = JSON.parse(doc.extracted_json ?? '{}') as { status?: string; question?: { text: string } }
    if (st.status === 'needs_mapping' && st.question) return c.json({ documentId: doc.id, name: doc.original_name, entityId: doc.entity_id, state: 'needs_mapping', message: st.question.text, question: st.question })
    const [waiting] = await s.documents.waitingStatements(ws, doc.id)
    if (waiting) return c.json({ documentId: doc.id, name: waiting.name, entityId: doc.entity_id, state: 'needs_account', accounts: waiting.accounts })
    return c.json({ documentId: doc.id, name: doc.original_name, entityId: doc.entity_id, state: doc.status === 'processed' ? 'imported' : 'unread' })
  })

  // "Which account is this statement for?": an existing account id, or 'new' for a separate statements account.
  app.post('/api/documents/:id/account', async (c) => {
    const ws = requireWs(c)
    const doc = await db.selectFrom('documents').select(['entity_id']).where('id', '=', c.req.param('id')).where('workspace_id', '=', ws).executeTakeFirst()
    if (!doc || !doc.entity_id || !(await s.permissions.can(actorOf(c), 'add', doc.entity_id, 'documents'))) fail(404, 'That file no longer exists.')
    const { accountId } = await c.req.json<{ accountId?: string }>().catch(() => ({ accountId: undefined }))
    if (!accountId) fail(422, 'Choose an account, or a new one.')
    try {
      const out = await s.documents.chooseAccount({ workspaceId: ws, documentId: c.req.param('id'), accountId, personId: c.get('person').personId })
      return c.json({ documentId: out.documentId, name: out.name, state: out.state, message: out.message })
    } catch (err) {
      if (err instanceof UploadError) fail(422, err.message, err.code ? { error: err.code } : {})
      throw err
    }
  })

  // One answer to a statement's question ("Which column is the amount?"): {field, value} from the question's options.
  // Replies with the next question, "which account?", or the import result.
  app.post('/api/documents/:id/answer', async (c) => {
    const ws = requireWs(c)
    const doc = await db.selectFrom('documents').select(['entity_id']).where('id', '=', c.req.param('id')).where('workspace_id', '=', ws).executeTakeFirst()
    if (!doc || !doc.entity_id || !(await s.permissions.can(actorOf(c), 'add', doc.entity_id, 'documents'))) fail(404, 'That file no longer exists.')
    const body = await c.req.json<{ field?: string; value?: string }>().catch(() => ({}) as { field?: string; value?: string })
    try {
      const out = await s.documents.answerMapping({ workspaceId: ws, documentId: c.req.param('id'), field: String(body.field ?? ''), value: String(body.value ?? ''), personId: c.get('person').personId })
      return c.json({ documentId: out.documentId, name: out.name, state: out.state, message: out.message, ...(out.accounts ? { accounts: out.accounts } : {}), ...(out.question ? { question: out.question } : {}) })
    } catch (err) {
      if (err instanceof UploadError) fail(422, err.message, err.code ? { error: err.code } : {})
      throw err
    }
  })

  // Delete one file no connection brought (a receipt, or a statement waiting for an answer): owner or admin. → {ok, name}
  // 404 gone; 409 an imported statement (its connection's "Delete its data" removes it).
  app.delete('/api/documents/:id', async (c) => {
    const ws = requireWs(c)
    const personId = c.get('person').personId
    const doc = await db.selectFrom('documents').select(['entity_id']).where('id', '=', c.req.param('id')).where('workspace_id', '=', ws).executeTakeFirst()
    if (!doc || (doc.entity_id && !(await s.permissions.can(actorOf(c), 'view', doc.entity_id, 'documents')))) fail(404, 'That file no longer exists.')
    if (!(await s.permissions.canManageWorkspace(ws, personId))) fail(403, 'Only an owner or admin can delete files.')
    try {
      const out = await deleteUploadedFile({ db, files: s.files, log: (msg, f) => console.warn('[agfn]', msg, f ?? '') }, ws, c.req.param('id'), personId)
      return c.json({ ok: true, name: out.name })
    } catch (err) {
      if (err instanceof FileDeleteError) fail(err.status, err.message)
      throw err
    }
  })

  app.get('/api/documents/:id/file', async (c) => {
    const ws = requireWs(c)
    const doc = await db.selectFrom('documents').select(['entity_id']).where('id', '=', c.req.param('id')).where('workspace_id', '=', ws).executeTakeFirst()
    if (!doc || !doc.entity_id || !(await s.permissions.can(actorOf(c), 'view', doc.entity_id, 'documents'))) fail(404, 'That file no longer exists.')
    const f = await s.documents.read(ws, c.req.param('id'))
    if (!f) fail(404, 'That file no longer exists.')
    // Always a download from a cookieless-safe response: never rendered inline (no HTML/SVG execution).
    return c.body(Buffer.from(f.bytes), 200, {
      'content-type': f.mime,
      'content-disposition': attachmentDisposition(f.name),
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store',
    })
  })

  // ---------- AI, review, cash entries, undo, buckets (S7 routes) ----------
  app.route('/api', aiRoutes(s))
  app.route('/api', settingsRoutes(s))
  if (config.friendInvites) app.route('/api', friendInviteRoutes(s))
  // Stays on with the flag off: a link in an email already sent must keep working.
  app.route('/', friendInviteStopRoutes(s))
  app.route('/api', connectionRoutes(s))
  app.route('/api', inboundRoutes(s))
  app.route('/api', financeRoutes(s, { setAsides: !!config.setAsides }))
  app.route('/api', equityRoutes(s))
  // AGFN_INVESTMENTS: the Investments page's routes; off, these paths 404 like any unknown /api path.
  if (investmentsOn()) app.route('/api', investmentRoutes(s))
  app.route('/api', shareRoutes(s, config.baseUrl, { badges: !!config.badges }))

  // ---------- Privacy and terms (public, rendered once at boot) ----------
  const legal = loadLegalPages(undefined, findLegalFonts(config.webDist))
  for (const name of ['privacy', 'terms', 'security', 'support'] as const) app.get(`/${name}`, (c) => c.html(withBaseUrl(legal[name].html, config.baseUrl, `/${name}`), 200, { 'cache-control': 'public, max-age=300' }))
  // Public docs (connect-your-ai.md, recipes.md; legal.ts PUBLIC_DOCS), same renderer: stable URLs for the directory listings.
  const docs = loadPublicDocs(undefined, findLegalFonts(config.webDist), loadDocsIcons(config.webDist))
  const docsHomePage = renderDocsHome(findLegalFonts(config.webDist))
  app.get('/docs', (c) => c.html(withBaseUrl(docsHomePage.html, config.baseUrl, '/docs'), 200, { 'cache-control': 'public, max-age=300' }))
  app.get(DOCS_JS_PATH, (c) => c.body(DOCS_JS + INSTITUTIONS_JS, 200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' }))
  const institutions = loadInstitutions()
  if (institutions) app.get(INSTITUTIONS_PATH, (c) => c.json({ names: institutions.names }, 200, { 'cache-control': 'public, max-age=86400' }))
  for (const slug of Object.keys(docs) as Array<keyof typeof docs>) app.get(`/docs/${slug}`, (c) => c.html(withBaseUrl(docs[slug].html, config.baseUrl, `/docs/${slug}`), 200, { 'cache-control': 'public, max-age=300' }))
  // REST reference (api-docs.ts), built once from this server's own /v1/openapi.json so it matches the tools it serves
  // (without the MCP module, from the default tool set).
  let apiPage: Promise<string | null> | undefined
  app.get('/docs/api', async (c) => {
    apiPage ??= (async () => {
      const res = s.mcp ? await s.mcp.fetch(new Request(new URL('/v1/openapi.json', config.baseUrl))) : null
      if (res && !res.ok) return null
      const spec = (res ? await res.json() : buildOpenApi(new URL('/mcp', config.baseUrl).href)) as OpenApiDoc
      return renderDoc(`---\ntitle: Aggregate REST API\nstatus: final\n---\n\n${apiDocsMarkdown(spec)}`, findLegalFonts(config.webDist), '/docs/api').html
    })().catch((e) => (console.warn('[agfn] /docs/api', e), null))
    const html = await apiPage
    if (!html) {
      apiPage = undefined
      return c.notFound()
    }
    return c.html(withBaseUrl(html, config.baseUrl, '/docs/api'), 200, { 'cache-control': 'public, max-age=300' })
  })
  // Guides (docs/guides, legal.ts loadGuides): a fixed map built at boot; an unknown slug is a 404.
  const guideDocs = loadGuides(undefined, findLegalFonts(config.webDist))
  const guidePage = (slug: string, path: string) => (c: Context) => {
    const page = guideDocs.get(slug)
    return page ? c.html(withBaseUrl(page.html, config.baseUrl, path), 200, { 'cache-control': 'public, max-age=300' }) : c.notFound()
  }
  app.get('/docs/guides', guidePage('', '/docs/guides'))
  app.get('/docs/guides/:slug{[a-z0-9-]+}', (c) => guidePage(c.req.param('slug'), `/docs/guides/${c.req.param('slug')}`)(c))
  app.get(DOCS_SEARCH_PATH, (c) =>
    c.json(
      docsSearchIndex([
        { path: '/docs', title: docsHomePage.title, html: docsHomePage.html },
        ...Object.entries(docs).map(([d, p]) => ({ path: `/docs/${d}`, title: p.title, html: p.html })),
        ...[...guideDocs].map(([g, p]) => ({ path: g ? `/docs/guides/${g}` : '/docs/guides', title: p.title, html: p.html })),
        { path: '/docs/api', title: 'Aggregate REST API', html: '' },
      ]),
      200,
      { 'cache-control': 'public, max-age=300' },
    ),
  )
  const crawlPages = (): CrawlPage[] =>
    [...Object.entries(docs).map(([d, page]) => [`/docs/${d}`, page] as const), ...[...guideDocs].map(([g, page]) => [g ? `/docs/guides/${g}` : '/docs/guides', page] as const)].map(([path, page]) => ({ path, title: page.title, description: page.description ?? '', md: page.md ?? '' }))
  const docsUpdated = (path: string) => (path.startsWith('/docs/guides/') ? guideDocs.get(path.slice('/docs/guides/'.length))?.updated : undefined)
  const listedDocs = () => ['/docs', ...Object.keys(docs).map((d) => `/docs/${d}`), '/docs/api', ...[...guideDocs.keys()].map((g) => (g ? `/docs/guides/${g}` : '/docs/guides'))]
  // After a disconnect made inside QuickBooks or Xero, they send the person here (the app's Disconnect URL in their portals):
  // a plain page saying what happened and how to reconnect. Static and public, like the legal pages.
  const PROVIDER_PAGES = { quickbooks: 'QuickBooks', xero: 'Xero' } as const
  const disconnectedPages = new Map(
    Object.entries(PROVIDER_PAGES).map(([key, name]) => [
      key,
      renderLegal(
        `---\ntitle: Aggregate is disconnected from ${name}\nstatus: final\n---\n\n# Aggregate is disconnected from ${name}\n\nAggregate can no longer read your ${name} company, and it has stopped syncing it.\n\n**To reconnect:** sign in at [app.aggregate.finance](/), open the ${name} connection under Connections, and choose **Connect to ${name}**.\n\n${ERASE_ON_DISCONNECT.has(key) ? `Once access to ${name} is removed, Aggregate deletes everything it brought in from ${name}. Reconnecting brings it back.` : `**To delete what Aggregate kept:** open the same connection and choose **Disconnect and delete its data**, or delete the workspace under Preferences.`}\n\nQuestions: [support@aggregate.finance](mailto:support@aggregate.finance) or the [support page](/support).\n`,
        findLegalFonts(config.webDist),
      ),
    ]),
  )
  app.get('/disconnected/:key{quickbooks|xero}', (c) => {
    const page = disconnectedPages.get(c.req.param('key'))!
    return c.html(withBaseUrl(page.html, config.baseUrl, `/disconnected/${c.req.param('key')}`), 200, { 'cache-control': 'public, max-age=300' })
  })
  // Search engines get the public pages of the hosted service; a self-hosted server lists nothing. Docs on their own host
  // are listed there.
  if (config.hosted) {
    const pages = ['/', ...(s.publicDemo ? ['/demo'] : []), '/privacy', '/terms', '/security', '/support', ...(config.docsHost ? [] : listedDocs())]
    const sitemap = sitemapXml(config.baseUrl, pages, docsUpdated)
    app.get('/sitemap.xml', (c) => c.body(sitemap, 200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' }))
    const robots = robotsTxt([`${config.baseUrl}/sitemap.xml`, ...(config.docsHost ? [`https://${config.docsHost}/sitemap.xml`] : [])], APP_DISALLOW)
    app.get('/robots.txt', (c) => c.text(robots, 200, { 'cache-control': 'public, max-age=3600' }))
  }
  // Connector setup for self-hosters, built from the same guides as the app and `agfn doctor` (registry setup.ts). On a
  // self-hosted server the redirect URIs are this server's and each section says whether it's set up; hosted shows a
  // placeholder address.
  const setupPage = renderLegal(`---\ntitle: Set up connections\nstatus: final\n---\n\n${setupMarkdown(config.hosted ? {} : { ...process.env, BASE_URL: config.baseUrl }, { showStatus: !config.hosted })}`, findLegalFonts(config.webDist))
  // Hosted shows no address of ours on this page, so its preview image link stays relative there.
  app.get(SETUP_DOCS_PATH, (c) => c.html(withBaseUrl(setupPage.html, config.hosted ? '' : config.baseUrl, SETUP_DOCS_PATH), 200, { 'cache-control': 'public, max-age=300' }))

  // ---------- Icons (the Convergence mark, gold on black) ----------
  // Served from the brand kit, not the web build, so every server has them: MCP clients and directories show the
  // domain's favicon, and initialize's serverInfo.icons point here (mcp-server.ts).
  for (const [path, file, type] of BRAND_ICONS) {
    let bytes: Buffer | null = null
    try {
      bytes = readFileSync(new URL(`../../site/brand/${file}`, import.meta.url))
    } catch {
      /* not shipped: fall through to the web app */
    }
    if (bytes) {
      const body = new Uint8Array(bytes)
      app.get(path, (c) => c.body(body, 200, { 'content-type': type, 'cache-control': 'public, max-age=86400' }))
    }
  }

  // ---------- Shared answer cards (public, /a/<id>) ----------
  app.route('/', publicShareRoutes(s, config.baseUrl, findLegalFonts(config.webDist)))
  if (config.badges) app.route('/', publicBadgeRoutes(s, config.baseUrl, findLegalFonts(config.webDist)))

  // ---------- The no-sign-up web demo ----------
  app.get('/demo', (c) => (s.publicDemo ? c.redirect('/#/?demo=1', 302) : c.notFound()))

  // ---------- Unknown API paths: a JSON 404, never the web app's page (which would read as a 200 to a scanner) ----------
  const noRoute = (c: Context) => c.json({ error: 'not_found', message: 'No such route.' }, 404)
  for (const p of ['/api/*', '/mcp/*', '/v1/*', '/.well-known/*']) app.all(p, noRoute)

  // ---------- The web app ----------
  app.get('*', serveWeb(config.webDist, config.baseUrl))

  return app
}

interface WebhookOutcomeShape {
  match?: { field: string; value: string }
  action: 'sync' | 'needs_reauth' | 'disconnected' | 'repaired' | 'reconnect_soon' | 'new_accounts' | 'erase' | 'ignore'
  dedupeKey: string
  reason?: string
}
interface WebhookHandler {
  verify(req: { headers: Record<string, string>; body: string }): Promise<void>
  /** One outcome, or one per connection a batched delivery names. */
  interpret(req: { headers: Record<string, string>; body: string }): WebhookOutcomeShape | WebhookOutcomeShape[]
  /** Answer a verified delivery with 200 and no body (Xero's "intent to receive" check requires it). */
  emptyAck?: boolean
}

/** Latest balance.snapshot per account, straight from the ledger's source records (works before accounts are assigned). */
async function latestBalances(db: Kysely<CoreTables>, workspaceId: string, accountIds: string[]): Promise<Map<string, { minor: number; currency: string }>> {
  const out = new Map<string, { minor: number; currency: string }>()
  if (!accountIds.length) return out
  const anyDb = db as unknown as Kysely<Record<string, Record<string, unknown>>>
  const rows = (await anyDb
    .selectFrom('ledger_records')
    .select(['source_account_id', 'event_json', 'date'])
    .where('workspace_id', '=', workspaceId)
    .where('event_type', '=', 'balance.snapshot')
    .where('source_account_id', 'in', accountIds)
    .execute()
    .catch(() => [])) as Array<{ source_account_id: string; event_json: string; date: string }>
  const best = new Map<string, { at: string; current: { minor: number; currency: string } }>()
  for (const r of rows) {
    const ev = JSON.parse(r.event_json) as { at?: string; current?: { minor: number; currency: string } }
    if (!ev.current) continue
    const at = ev.at ?? r.date
    const prev = best.get(r.source_account_id)
    if (!prev || prev.at < at) best.set(r.source_account_id, { at, current: { minor: Number(ev.current.minor), currency: ev.current.currency } })
  }
  for (const [id, v] of best) out.set(id, v.current)
  return out
}

/**
 * Connecting a bank or any financial account needs a fresh "it's you" (docs/security/recheck.md): for someone with a
 * passkey, the passkey in the last 10 minutes (or the one-time email link when it isn't on this device); for someone
 * without one, the email link or any sign-in in the last 10 minutes. The 403 says which (`method`), and the app offers
 * "Email me a link" plus "Add a passkey" afterwards.
 */
/** A 429 that says the real wait ("Try again in about 12 minutes"), with Retry-After and retryAfter in seconds. */
/** Better Auth answered 429: our wording; a sign-in link opened in the browser gets a sentence, not JSON. */
function authTooMany(c: Context<Env>, res: Response): Response {
  const seconds = Math.max(1, Number(res.headers.get('x-retry-after') ?? res.headers.get('retry-after')) || 60)
  if (c.req.method === 'GET') return c.text('Too many sign-ins from this network. Try again in a minute, then open the link again.', 429, { 'retry-after': String(seconds) })
  return tooMany(c, 'Too many sign-ins from this network.', seconds)
}

function tooMany(c: Context<Env>, what: string, seconds: number, extra: Record<string, unknown> = {}): Response {
  const mins = Math.ceil(seconds / 60)
  const when = seconds < 60 ? 'in a minute' : `in about ${mins} minute${mins === 1 ? '' : 's'}`
  return c.json({ ...extra, message: `${what} Try again ${when}.`, retryAfter: seconds }, 429, { 'retry-after': String(seconds) })
}

async function requirePasskeyCheck(s: Services, personId: string): Promise<void> {
  // The challenge app: made-up books and no email to confirm with, so no check before connecting (Yisrael, 2026-10-13).
  if (s.config.challenge) return
  // Browsers only allow passkeys on https or localhost. A self-hosted server on http://<LAN IP> can't offer them, so
  // there a fresh sign-in (magic link) within 10 minutes is the check instead.
  if (!passkeysPossible(s.config.baseUrl)) {
    if (!(await s.reauth.requireRecentAuth(personId, 10 * 60_000))) fail(403, 'Sign in again to confirm it’s you (passkeys need https).', { error: 'recheck' })
    return
  }
  const person = await s.db.selectFrom('people').select(['auth_user_id', 'email']).where('id', '=', personId).executeTakeFirst()
  // Reviewer demo accounts never pass: their fresh sign-in must not count as the check (reviewer.ts).
  if (isReviewerEmail(person?.email)) fail(403, 'Not available in the reviewer demo.', { error: 'demo' })
  const anyDb = s.db as unknown as Kysely<Record<string, Record<string, unknown>>>
  const has = person?.auth_user_id ? await ownerOf(anyDb).selectFrom('passkey').select('id').where('userId', '=', person.auth_user_id).limit(1).executeTakeFirst() : undefined
  if (!has) {
    // No passkey: the email link (or a fresh sign-in) is the check. Refusing outright left email-only people unable
    // to connect anything even after confirming by email.
    if (!(await s.reauth.requireRecentAuth(personId, 10 * 60_000))) fail(403, 'Confirm it’s you: we’ll email you a link.', { error: 'recheck', method: 'email', fallback: 'email' })
    return
  }
  if (!(await s.reauth.requireRecentPasskey(personId, 10 * 60_000))) fail(403, 'Confirm it’s you with your passkey, or by email.', { error: 'recheck', method: 'passkey', fallback: 'email' })
}

async function dataHealthOf(s: Services, workspaceId: string, entityIds: string[]): Promise<unknown> {
  const ledger = s.ledger as { dataHealth?: (ws: string, ids: string[] | 'all') => Promise<unknown> }
  if (!ledger.dataHealth || entityIds.length === 0) return null
  return ledger.dataHealth(workspaceId, entityIds).catch(() => null)
}

async function cashOf(s: Services, workspaceId: string, entityId: string): Promise<{ cash: { minor: number; currency: string } | null; caveat?: { state: 'unknown' | 'stale'; reason: string } }> {
  const a: MetricAnswer = await s.ledger.metric('cash', { workspaceId, entityIds: [entityId] })
  const cash = a.value && typeof a.value === 'object' ? a.value : null
  // unknown: no honest total (value null); stale: a total that leans on old balances. Either way, say why.
  const caveat = a.state === 'unknown' || a.state === 'stale' ? { state: a.state, reason: a.unknownReason ?? (a.state === 'unknown' ? 'Not enough data for a total.' : 'Some balances are out of date.') } : undefined
  return { cash: a.state === 'unknown' ? null : cash, ...(caveat ? { caveat } : {}) }
}

/** The holdings' value per currency (never added across currencies), as the company page totals them. */
async function investmentsOf(s: Services, workspaceId: string, entityId: string): Promise<Array<{ minor: number; currency: string }>> {
  const r = financeFor(s).reader
  if (!r.holdings) return []
  const rows = await r.holdings({ workspaceId, entityIds: [entityId] }).catch(() => null)
  return holdingsOf(rows).holdingsTotal.filter((x) => x.minor !== 0)
}

/** "Stripe · Aggregate". Banks keep their name, and so does a name that already says the provider. */
function providerFirst(key: string, provider: string | undefined, name: string): string {
  return !provider || key === 'plaid' || key === 'simplefin' || name.toLowerCase().startsWith(provider.toLowerCase()) ? name : `${provider} · ${name}`
}

function sitemapXml(origin: string, pages: string[], updated: (page: string) => string | undefined = () => undefined): string {
  const url = (p: string) => {
    const date = updated(p)
    return `  <url><loc>${origin}${p}</loc>${date ? `<lastmod>${date}</lastmod>` : ''}</url>`
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map(url).join('\n')}\n</urlset>\n`
}

async function connectionSummaries(s: Services, workspaceId: string) {
  const rows = await s.db.selectFrom('connections').selectAll().where('workspace_id', '=', workspaceId).where('status', '!=', 'disconnected').orderBy('created_at').execute()
  const accts = await s.db
    .selectFrom('accounts')
    .leftJoin('entities', 'entities.id', 'accounts.entity_id')
    .select(['accounts.connection_id as connection_id', 'accounts.entity_id as entity_id', 'accounts.institution as institution', 'entities.name as entity_name', 'entities.kind as entity_kind'])
    .where('accounts.workspace_id', '=', workspaceId)
    .where('accounts.closed_at', 'is', null)
    .execute()
  const attention = await listAttention(s.db as unknown as Kysely<import('@agfn/db').CoreTables & ConnectorTables>, workspaceId)
  // "syncing" = a sync job for the connection is running or due within 3 minutes (the next page of a long import is
  // queued 5 s out, early history follow-ups 30 s and 2 min out), so an import in progress doesn't flicker to "ok".
  // Later follow-ups (10/30 min) stay "ok". The connection's own status column is untouched (a crash mid-sync must
  // never leave it stuck).
  const soon = new Date(Date.now() + 3 * 60_000).toISOString()
  const today = new Date().toISOString().slice(0, 10)
  const busy = new Set(
    (
      await s.db
        .selectFrom('jobs')
        .select('unique_key')
        .where('workspace_id', '=', workspaceId)
        .where('kind', '=', SYNC_JOB)
        .where((eb) => eb.or([eb('status', '=', 'running'), eb.and([eb('status', '=', 'queued'), eb('run_at', '<=', soon)])]))
        .execute()
    ).map((j) => j.unique_key),
  )
  const genericName = new Map(s.registry.list().map((d) => [d.key, d.name]))
  // Connections without bank accounts (QuickBooks, Xero, payroll) belong to a company through the connection itself.
  const owners = new Map(
    (await s.db.selectFrom('entities').select(['id', 'name', 'kind']).where('workspace_id', '=', workspaceId).execute()).map((e) => [e.id, e.kind === 'personal' ? 'Personal' : e.name]),
  )
  return rows.map((r) => {
    const mine = accts.filter((a) => a.connection_id === r.id)
    const flags = attention.filter((a) => a.connection_id === r.id)
    const fromAccounts = [...new Set(mine.map((a) => (a.entity_kind === 'personal' ? 'Personal' : a.entity_name)).filter((n): n is string => !!n))]
    const own = !mine.length && r.entity_id ? owners.get(r.entity_id) : undefined
    const names = own ? [own] : fromAccounts
    // A bank is called by its name ("Chase"), not by the connector that reached it.
    const institution = r.connector_key === 'plaid' ? mine.find((a) => a.institution)?.institution : null
    const needsCompany = mine.filter((a) => !a.entity_id).length
    return {
      id: r.id,
      connectorKey: r.connector_key,
      // A name the connector chose ("Xero · Demo Company") beats the institution; the generic provider name doesn't. Provider
      // first, always: a Stripe account called Aggregate must not read as Aggregate itself. A bank is called by its own name.
      name: r.connector_key === 'manual' ? 'Added by hand' : r.display_name !== genericName.get(r.connector_key) ? providerFirst(r.connector_key, genericName.get(r.connector_key), r.display_name) : (institution ?? r.display_name),
      entityNames: names,
      ...(needsCompany ? { needsCompany } : {}),
      status: r.status === 'active' ? (busy.has(r.id) || demoImporting(r.connector_key, r.cursor, today) ? 'syncing' : 'ok') : r.status,
      lastSyncAt: r.last_success_at,
      accountCount: mine.length,
      ...(r.last_error ? { message: r.last_error } : flags[0] ? { message: flags[0].message } : r.warnings_json ? { message: (JSON.parse(r.warnings_json) as string[])[0] } : {}),
      // Still working, but a person should reconnect (consent ending) or pick newly opened accounts.
      ...(flags.length ? { attention: flags.map((f) => f.kind) } : {}),
    }
  })
}

const ACCOUNT_KIND: Record<string, 'bank' | 'card' | 'payments' | 'cash' | 'loan' | 'investment' | 'crypto'> = {
  depository: 'bank',
  credit_card: 'card',
  processor_balance: 'payments',
  cash_on_hand: 'cash',
  loan: 'loan',
  investment: 'investment',
  crypto: 'crypto',
}

/** An app route to come back to after a redirect sign-in ("/welcome/3", "/review"): a plain path inside the app, else none. */
export function safeAppRoute(v: unknown): string | undefined {
  return typeof v === 'string' && /^\/(?!\/)[A-Za-z0-9/_-]{0,80}$/.test(v) ? v : undefined
}

export { SHOPIFY_ERASE_WARNING }

/** How long a finished connect answers a repeated callback with the same connection. */
const CONNECT_DONE_MS = 10 * 60_000
/** A connection in these states is working: a second sign-in to the same company is refused, not added. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['active', 'paused'])
const XERO_FULL = 'New Xero connections are full right now while we add room on Xero’s side. Try again in a day or two, or email support@aggregate.finance and we’ll tell you when it’s ready.'

/** Most founders' next useful connection first; niche tools last. */
const SUGGEST_ORDER = ['plaid', 'stripe', 'quickbooks', 'xero', 'finch', 'gusto', 'rippling', 'justworks', 'deel', 'square', 'shopify', 'mercury', 'brex', 'ramp', 'paypal', 'billcom', 'wise', 'paddle', 'polar', 'chargebee', 'lemonsqueezy', 'appstore', 'googleplay', 'simplefin']
/** Tools whose data another connected tool already brings (an accounting tool carries bills and invoices). */
const COVERED_BY: Record<string, string[]> = {
  xero: ['quickbooks'],
  quickbooks: ['xero'],
  billcom: ['quickbooks', 'xero'],
  simplefin: ['plaid'],
  finch: ['rippling', 'justworks', 'deel'],
  rippling: ['finch'],
  justworks: ['finch'],
}

/** Connectors worth suggesting, most useful first: not connected yet, not covered by something connected. */
const UNLISTED_MESSAGE: Record<string, string> = {
  plaid: 'Bank connections through Plaid are coming soon. For now, connect through SimpleFIN Bridge or upload a statement.',
  stripe: 'Connecting Stripe is coming soon, once Stripe approves the Aggregate app.',
}

export function suggestConnectors<T extends { key: string }>(all: readonly T[], connected: ReadonlySet<string>): T[] {
  const rank = (k: string) => {
    const i = SUGGEST_ORDER.indexOf(k)
    return i < 0 ? SUGGEST_ORDER.length : i
  }
  return all
    .filter((d) => d.key !== 'demo' && !d.key.startsWith('payroll-') && !connected.has(d.key) && !(COVERED_BY[d.key] ?? []).some((k) => connected.has(k)))
    .sort((a, b) => rank(a.key) - rank(b.key))
}

