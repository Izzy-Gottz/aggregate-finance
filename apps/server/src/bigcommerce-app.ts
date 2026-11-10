// The BigCommerce single-click app's callbacks (Marketplace "Install"; connector app.ts does the checks):
//
// - auth: BigCommerce opens it inside its control panel after the merchant approves. The code becomes the store's token
//   (read-only scopes only), sealed in bigcommerce_pending_installs; the page offers a one-time "Connect to Aggregate"
//   link that opens in a new tab, since the frame can't sign anyone in.
// - link: keeps that link in a cookie across sign-in, then the app attaches the store (app.ts, install/resume). The link
//   works once, for 15 minutes, and only for an Aggregate person with the installer's email.
// - load: the app's page in BigCommerce's Apps menu: whether this store is connected, with a fresh link when it isn't.
// - uninstall: every live connection for the store ends and its data is deleted (BigCommerce is ERASE_ON_DISCONNECT),
//   and a waiting token goes. remove_user: nothing to do (no BigCommerce users are kept), answered 200.
//
// No session on any of these: load, uninstall and remove_user carry a JWT signed with the app's client secret, and auth a
// code only BigCommerce can trade. Mounted before the cookie session middleware.
import { createHash, randomBytes } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { setCookie } from 'hono/cookie'
import type { Kysely } from 'kysely'
import { seal, unseal } from '@agfn/security'
import { appendActivity } from '@agfn/mcp'
import { ownerOf, withBypass, withWorkspace } from '@agfn/db'
import { eraseRevoked } from './retire.ts'
import type { Services } from './services.ts'
import { maskEmail } from './shopify-embedded.ts'

type AppChecks = {
  clientId: string
  exchange(q: Record<string, string | undefined>): Promise<{ secret: { storeHash: string; accessToken: string }; userEmail: string | null }>
  verify(jwt: string): { storeHash: string; userEmail: string | null; ownerEmail: string | null }
}

export const BIGCOMMERCE_LINK_COOKIE = 'agfn_bigcommerce_link'
const LINK_TTL_MS = 15 * 60_000
const SEAL = (storeHash: string) => ({ workspaceId: 'bigcommerce-pending', recordId: storeHash, purpose: 'bigcommerce_pending_install' })
const hash = (t: string) => createHash('sha256').update(t).digest('hex')

type PendingRow = { store_hash: string; secret_enc: string; created_at: string; link_hash: string | null; link_expires_at: string | null; link_email: string | null }
const pendingDb = (s: Services) => s.db as unknown as Kysely<{ bigcommerce_pending_installs: PendingRow }>

/** The app's checks, or undefined when this server has no BigCommerce app (BIGCOMMERCE_CLIENT_ID/SECRET). */
export function bigcommerceApp(s: Services): AppChecks | undefined {
  return s.registry.has('bigcommerce') ? (s.registry.create('bigcommerce', { raw: { put: async () => '' } }) as { app?: AppChecks }).app : undefined
}

/** Issue a fresh one-time link for a waiting store, bound to `email`. Null when nobody can be named. */
async function issueLink(s: Services, storeHash: string, email: string | null, now = Date.now()): Promise<string | null> {
  if (!email) return null
  const link = randomBytes(32).toString('base64url')
  const r = await ownerOf(pendingDb(s)).updateTable('bigcommerce_pending_installs').set({ link_hash: hash(link), link_expires_at: new Date(now + LINK_TTL_MS).toISOString(), link_email: email }).where('store_hash', '=', storeHash).executeTakeFirst()
  return Number(r.numUpdatedRows) === 1 ? `${s.config.baseUrl}/api/connectors/bigcommerce/link?t=${link}` : null
}

/**
 * The link the person opened: its store and token, once, and only for the BigCommerce user it was issued to. Cleared in
 * the same statement that checks it, so two tabs can't both use it. Expired or unknown: null. Another person:
 * 'wrongPerson' (the link stays usable for the right one). The row itself goes when the connection is made (dropPending).
 */
export async function takePendingByLink(s: Services, linkToken: string, personEmail: string, now = Date.now()): Promise<{ storeHash: string; secret: unknown } | { wrongPerson: string } | null> {
  const db = pendingDb(s)
  const h = hash(linkToken)
  const row = await ownerOf(db).selectFrom('bigcommerce_pending_installs').selectAll().where('link_hash', '=', h).executeTakeFirst()
  if (!row || !row.link_expires_at || Date.parse(row.link_expires_at) < now || !row.link_email) return null
  if (row.link_email !== personEmail.trim().toLowerCase()) return { wrongPerson: maskEmail(row.link_email) }
  const r = await ownerOf(db).updateTable('bigcommerce_pending_installs').set({ link_hash: null, link_expires_at: null }).where('store_hash', '=', row.store_hash).where('link_hash', '=', h).executeTakeFirst()
  if (Number(r.numUpdatedRows) !== 1) return null
  return { storeHash: row.store_hash, secret: unseal(s.keys, row.secret_enc, SEAL(row.store_hash)) }
}

/** The email a link was issued to (to prefill sign-in), or null. Doesn't use the link. */
async function emailForLink(s: Services, linkToken: string): Promise<string | null> {
  const row = await ownerOf(pendingDb(s)).selectFrom('bigcommerce_pending_installs').select(['link_email', 'link_expires_at']).where('link_hash', '=', hash(linkToken)).executeTakeFirst()
  return row?.link_email && row.link_expires_at && Date.parse(row.link_expires_at) > Date.now() ? row.link_email : null
}

/** Forget a store's waiting token (connected, or uninstalled). */
export async function dropPending(s: Services, storeHash: string): Promise<void> {
  await ownerOf(pendingDb(s)).deleteFrom('bigcommerce_pending_installs').where('store_hash', '=', storeHash).execute()
}

/** Live connections for this store, in any workspace: the one cross-workspace read, for a verified store only. */
async function connectionsFor(s: Services, storeHash: string) {
  const rows = await withBypass('bigcommerce:connections', () =>
    s.db.selectFrom('connections').select(['id', 'workspace_id', 'display_name', 'status', 'config_json', 'last_success_at']).where('connector_key', '=', 'bigcommerce').where('status', '!=', 'disconnected').execute(),
  )
  return rows.filter((r) => (JSON.parse(r.config_json) as { storeHash?: string }).storeHash === storeHash)
}

const esc = (v: string) => v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)

const MARK = '<svg width="28" height="28" viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round" aria-hidden="true"><path d="M50 12V88M50 12 33 88M50 12 67 88M50 12 16 88M50 12 84 88"/></svg>'

/**
 * The page BigCommerce frames in its control panel: the mark, plain words, at most one link out (a new tab), and how to
 * reach support on every page (a Marketplace requirement). No script.
 */
function page(base: string, lead: string, link?: { href: string; label: string }, status = 200): Response {
  const nonce = randomBytes(16).toString('base64')
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Aggregate</title>
<style nonce="${nonce}">:root{color-scheme:light dark;--fg:#111110;--muted:#5F5E5A;--bg:#FCFCFB;--line:#D5D4D0}@media (prefers-color-scheme:dark){:root{--fg:#F3F2EF;--muted:#A8A7A2;--bg:#141413;--line:#3A3936}}
body{margin:0;padding:32px 16px;font:15px/1.55 system-ui,-apple-system,sans-serif;color:var(--fg);background:var(--bg)}main{max-width:520px;margin:0 auto}
h1{display:flex;align-items:center;gap:10px;font-size:20px;font-weight:600;margin:0 0 12px}p{color:var(--muted);margin:0 0 20px}
a{color:var(--fg)}a.btn{display:inline-block;padding:8px 14px;border-radius:8px;border:1px solid var(--line);text-decoration:none}footer{margin-top:32px;padding-top:16px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}</style></head>
<body><main><h1>${MARK}Aggregate</h1><p>${esc(lead)}</p>${link ? `<a class="btn" href="${esc(link.href)}" target="_blank" rel="noopener">${esc(link.label)}</a>` : ''}
<footer>Questions? <a href="mailto:support@aggregate.finance">support@aggregate.finance</a> · <a href="${esc(base)}/support" target="_blank" rel="noopener">Help</a></footer></main></body></html>`
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // Framed only by BigCommerce's control panel; no script at all.
      'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; frame-ancestors https://*.bigcommerce.com https://*.mybigcommerce.com; base-uri 'none'; form-action 'none'`,
    },
  })
}

const READS = 'Aggregate reads this store’s orders and refunds as monthly totals (read-only), with no customer names, emails or addresses.'

/** BigCommerce's app callbacks, and the link into Aggregate. Mounted before the cookie session middleware. */
export function bigcommerceAppRoutes(app: Hono<any>, s: Services): void {
  const base = '/api/connectors/bigcommerce'
  const off = () => page(s.config.baseUrl, 'BigCommerce installs aren’t set up on this server.', undefined, 503)
  const verified = (c: Context) => {
    const checks = bigcommerceApp(s)
    const jwt = c.req.query('signed_payload_jwt')
    if (!checks || !jwt) return null
    try {
      return checks.verify(jwt)
    } catch {
      return null
    }
  }

  app.get(`${base}/auth`, async (c) => {
    const checks = bigcommerceApp(s)
    if (!checks) return off()
    let install: Awaited<ReturnType<AppChecks['exchange']>>
    try {
      install = await checks.exchange(c.req.query())
    } catch (e) {
      const forUser = e && typeof e === 'object' && (e as { forUser?: boolean }).forUser
      console.warn('[agfn] bigcommerce install failed', { reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) })
      return page(s.config.baseUrl, forUser && e instanceof Error ? e.message : 'Installing Aggregate didn’t finish. Open Apps → My Apps in BigCommerce and install it again.', undefined, 400)
    }
    const { storeHash } = install.secret
    const now = new Date().toISOString()
    const values = { secret_enc: seal(s.keys, install.secret, SEAL(storeHash)), created_at: now, link_hash: null, link_expires_at: null, link_email: null }
    // A reinstall replaces what was waiting: the old token stopped working when BigCommerce issued this one.
    await ownerOf(pendingDb(s)).insertInto('bigcommerce_pending_installs').values({ store_hash: storeHash, ...values }).onConflict((oc) => oc.column('store_hash').doUpdateSet(values)).execute()
    const link = await issueLink(s, storeHash, install.userEmail)
    if (!link) return page(s.config.baseUrl, 'Aggregate is installed, but BigCommerce didn’t say who installed it, so it can’t be linked to an Aggregate account. Uninstall it and install it again.')
    return page(s.config.baseUrl, `Installed. Connect this store to your Aggregate workspace to finish. ${READS}`, { href: link, label: 'Connect to Aggregate' })
  })

  app.get(`${base}/load`, async (c) => {
    if (!bigcommerceApp(s)) return off()
    const v = verified(c)
    if (!v) return page(s.config.baseUrl, 'Open Aggregate from your BigCommerce control panel (Apps → My Apps).', undefined, 401)
    const conns = await connectionsFor(s, v.storeHash)
    if (conns.some((r) => r.status !== 'needs_reauth')) return page(s.config.baseUrl, `This store is connected to Aggregate. ${READS}`, { href: `${s.config.baseUrl}/`, label: 'Open Aggregate' })
    // Not linked yet: a fresh link for whoever opened the app, if the install's token is still waiting.
    const waiting = await ownerOf(pendingDb(s)).selectFrom('bigcommerce_pending_installs').select('store_hash').where('store_hash', '=', v.storeHash).executeTakeFirst()
    const link = waiting ? await issueLink(s, v.storeHash, v.userEmail ?? v.ownerEmail) : null
    if (link) return page(s.config.baseUrl, `This store isn’t connected to Aggregate yet. ${READS}`, { href: link, label: 'Connect to Aggregate' })
    return page(s.config.baseUrl, 'This store isn’t connected to Aggregate. To connect it, uninstall Aggregate in Apps → My Apps and install it again.')
  })

  app.get(`${base}/uninstall`, async (c) => {
    if (!bigcommerceApp(s)) return c.body(null, 204)
    const v = verified(c)
    if (!v) return c.json({ message: 'invalid signature' }, 401)
    await dropPending(s, v.storeHash)
    for (const r of await connectionsFor(s, v.storeHash))
      await withWorkspace(r.workspace_id, async () => {
        await eraseRevoked(s, r.workspace_id, r.id)
        await appendActivity(s.db as never, { workspaceId: r.workspace_id, actorKind: 'system', actorLabel: 'BigCommerce', action: 'connection.disconnected', targetType: 'connection', targetId: r.id, status: 'ok', detail: `Aggregate was uninstalled from ${r.display_name} in BigCommerce; its data was deleted` }, new Date())
      })
    return c.json({ ok: true })
  })

  // Aggregate keeps no BigCommerce users, so removing one changes nothing here.
  app.get(`${base}/remove_user`, (c) => (verified(c) ? c.json({ ok: true }) : c.json({ message: 'invalid signature' }, 401)))

  // The "Connect to Aggregate" link, opened in a new tab: keep it across sign-in, then attach (app.ts, install/resume).
  app.get(`${base}/link`, async (c) => {
    const t = c.req.query('t') ?? ''
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(t)) return c.redirect(`/#/?connect_error=${encodeURIComponent('That link from BigCommerce is invalid. Open Aggregate from Apps → My Apps in BigCommerce again.')}&connector=bigcommerce`)
    setCookie(c, BIGCOMMERCE_LINK_COOKIE, t, { path: '/api', httpOnly: true, secure: s.config.baseUrl.startsWith('https:'), sameSite: 'Lax', maxAge: 30 * 60 })
    if (await s.auth.api.getSession({ headers: c.req.raw.headers })) return c.redirect(`${base}/install/resume`)
    const email = await emailForLink(s, t)
    return c.redirect(email ? `/#/?signin_email=${encodeURIComponent(email)}&signin_for=bigcommerce` : '/#/?signin_for=bigcommerce')
  })
}
