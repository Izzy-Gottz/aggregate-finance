// The embedded Shopify admin page (App Store rules 2.2 / 2.2.2): opened inside Shopify admin, it shows whether this
// store is connected to Aggregate, opens Aggregate in a new top-level page, and disconnects. No cookies: App Bridge's
// session token (signed with the app's client secret) is sent as a Bearer token and verified on every call.
import { createHash, randomBytes } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { setCookie } from 'hono/cookie'
import type { Kysely } from 'kysely'
import { seal, unseal } from '@agfn/security'
import { appendActivity } from '@agfn/mcp'
import { withBypass, withWorkspace } from '@agfn/db'
import { noteConnection, SHOPIFY_ERASE_WARNING } from './retire.ts'
import type { Services } from './services.ts'

type ShopifyEmbedded = {
  apiKey?: string
  verifySessionToken?: (token: string) => string
  exchangeSessionToken?: (shop: string, token: string) => Promise<unknown>
  staffEmail?: (shop: string, token: string) => Promise<string | undefined>
}

/** The one-time link from the embedded page to Aggregate, kept in a cookie across sign-in (GET /api/me → pendingInstall). */
export const SHOPIFY_LINK_COOKIE = 'agfn_shopify_link'
/** How long the "Connect to Aggregate" link works. Each load of the embedded page issues a new one. */
const LINK_TTL_MS = 15 * 60_000
/** A store's exchanged token waits this long for someone to pick the workspace; after that it's exchanged again. */
const PENDING_TTL_MS = 24 * 60 * 60_000
const SEAL = (shop: string) => ({ workspaceId: 'shopify-pending', recordId: shop, purpose: 'shopify_pending_install' })
const hash = (t: string) => createHash('sha256').update(t).digest('hex')

type PendingDb = Kysely<{ shopify_pending_installs: { shop: string; secret_enc: string; created_at: string; link_hash: string | null; link_expires_at: string | null; link_email: string | null } }>
const pendingDb = (s: Services) => s.db as unknown as PendingDb

/**
 * The link the person opened: its store and token, once, and only for the Shopify staff member it was issued to
 * (their Shopify email must be this person's Aggregate email). The link is cleared in the same statement that checks
 * it, so two tabs can't both use it; an expired or unknown link gives null, a different person 'wrong_person' (the
 * link stays usable for the right one). The token row itself goes when the connection is made (dropPending).
 */
export async function takePendingByLink(
  s: Services,
  linkToken: string,
  personEmail: string,
  opts: { confirmed?: boolean; now?: number } = {},
): Promise<{ shop: string; secret: unknown } | { wrongPerson: string } | { needsConfirm: string } | null> {
  const db = pendingDb(s)
  const h = hash(linkToken)
  const row = await db.selectFrom('shopify_pending_installs').selectAll().where('link_hash', '=', h).executeTakeFirst()
  if (!row || !row.link_expires_at || Date.parse(row.link_expires_at) < (opts.now ?? Date.now())) return null
  if (row.link_email) {
    if (row.link_email !== personEmail.trim().toLowerCase()) return { wrongPerson: maskEmail(row.link_email) }
  } else if (!opts.confirmed) {
    // Shopify named no staff member: the person confirms which store goes into which workspace instead.
    return { needsConfirm: row.shop }
  }
  const r = await db.updateTable('shopify_pending_installs').set({ link_hash: null, link_expires_at: null }).where('shop', '=', row.shop).where('link_hash', '=', h).executeTakeFirst()
  if (Number(r.numUpdatedRows) !== 1) return null
  return { shop: row.shop, secret: unseal(s.keys, row.secret_enc, SEAL(row.shop)) }
}

/** The Shopify staff email a link was issued to (to prefill sign-in), or null. Doesn't use the link. */
export async function pendingEmailForLink(s: Services, linkToken: string): Promise<string | null> {
  const row = await pendingDb(s).selectFrom('shopify_pending_installs').select(['link_email', 'link_expires_at']).where('link_hash', '=', hash(linkToken)).executeTakeFirst()
  return row?.link_email && row.link_expires_at && Date.parse(row.link_expires_at) > Date.now() ? row.link_email : null
}

/** "Connect <store> to <workspace>?": the confirm step when Shopify sent no staff email. Same-origin POST only. */
export function confirmPage(c: Context, store: string, workspace: string): Response {
  const nonce = randomBytes(16).toString('base64')
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect Shopify · Aggregate</title>
<style nonce="${nonce}">:root{color-scheme:light dark;--fg:#1a1a1a;--muted:#616161;--bg:#fff;--line:#e3e3e3}@media (prefers-color-scheme:dark){:root{--fg:#f1f1f1;--muted:#a8a8a8;--bg:#1a1a1a;--line:#333}}
body{margin:0;padding:48px 16px;font:15px/1.5 system-ui,-apple-system,sans-serif;color:var(--fg);background:var(--bg)}main{max-width:440px;margin:0 auto}h1{font-size:20px;margin:0 0 8px}p{color:var(--muted);margin:0 0 20px}
form{display:inline}button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer;margin-right:8px}</style></head>
<body><main><h1>Connect ${esc(store)} to ${esc(workspace)}?</h1><p>Aggregate reads this store's payouts, fees and refunds (read-only). You can disconnect it any time, here or in Shopify.</p>
<form method="post" action="/api/connectors/shopify/install/confirm"><button type="submit">Connect</button></form><form method="post" action="/api/connectors/shopify/install/cancel"><button type="submit">Cancel</button></form></main></body></html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` } })
}

/** "y•••@aggregate.finance": enough for the store's own staff to recognise which address, not to read it. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at < 1) return 'the email you use for this Shopify store'
  return `${email[0]}•••${email.slice(at)}`
}

/** Forget a store's waiting token (connected, uninstalled, or erased). */
export async function dropPending(s: Services, shop: string): Promise<void> {
  await pendingDb(s).deleteFrom('shopify_pending_installs').where('shop', '=', shop).execute()
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)

function connector(s: Services): ShopifyEmbedded | undefined {
  return s.registry.has('shopify') ? (s.registry.create('shopify', { raw: { put: async () => '' } }) as ShopifyEmbedded) : undefined
}

/** The page Shopify admin frames (the App URL with ?embedded=1&host=…, already checked by the install route). */
export function embeddedPage(c: Context, s: Services, shop: string): Response {
  const apiKey = connector(s)?.apiKey
  if (!apiKey) return c.text('Shopify isn’t set up on this server.', 503)
  const nonce = randomBytes(16).toString('base64')
  const base = s.config.baseUrl
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="shopify-api-key" content="${esc(apiKey)}">
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
<title>Aggregate</title>
<style nonce="${nonce}">
:root{color-scheme:light dark;--fg:#1a1a1a;--muted:#616161;--bg:#fff;--line:#e3e3e3}
@media (prefers-color-scheme:dark){:root{--fg:#f1f1f1;--muted:#a8a8a8;--bg:#1a1a1a;--line:#333}}
body{margin:0;padding:24px 16px;font:15px/1.5 system-ui,-apple-system,sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:560px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}p{margin:0 0 16px;color:var(--muted)}
.row{display:flex;justify-content:space-between;gap:12px;padding:12px 0;border-top:1px solid var(--line)}
button,a.btn{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer;text-decoration:none}
[hidden]{display:none!important}.actions{display:flex;gap:8px;margin-top:20px;align-items:center;flex-wrap:wrap}
h2{font-size:15px;margin:28px 0 6px}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:8px 6px;border-top:1px solid var(--line);text-align:left;white-space:nowrap}th{font-weight:500;color:var(--muted)}.n{text-align:right}.danger{color:#c4320a}
</style></head>
<body><main>
<h1>Aggregate</h1>
<p id="lead">Checking this store’s connection…</p>
<div id="list"></div>
<div id="payouts" hidden><h2>Recent payouts</h2><p id="next"></p><div class="scroll"><table><thead><tr><th>Date</th><th>Status</th><th class="n">Gross</th><th class="n">Fees</th><th class="n">Refunds</th><th class="n">Net</th></tr></thead><tbody id="rows"></tbody></table></div><p id="none" hidden>No payouts yet; they'll appear after Shopify's next payout.</p></div>
<div class="actions"><a id="open" class="btn" href="${esc(base)}/" target="_blank" rel="noopener">Open Aggregate</a><button id="disconnect" class="danger" type="button" hidden>Disconnect</button></div>
<div class="actions" id="confirm" hidden><span>Disconnect this store? Aggregate is uninstalled, and what synced is deleted within 48 hours.</span><button id="yes" class="danger" type="button">Disconnect</button><button id="no" type="button">Cancel</button></div>
</main>
<script nonce="${nonce}">
(function () {
  var base = ${JSON.stringify(base)}
  // Opened outside Shopify admin: back into the admin, where the app lives.
  if (window.top === window.self) { location.replace(base + '/api/connectors/shopify/install/top' + location.search); return }
  var lead = document.getElementById('lead'), list = document.getElementById('list'), disc = document.getElementById('disconnect'), connected = false
  var openLink = document.getElementById('open'), confirmRow = document.getElementById('confirm'), yes = document.getElementById('yes'), no = document.getElementById('no')
  function call(method, path) {
    return shopify.idToken().then(function (t) { return fetch(base + path, { method: method, headers: { authorization: 'Bearer ' + t } }) }).then(function (r) { return r.json() })
  }
  function render(d) {
    list.textContent = ''
    connected = !!(d.connections && d.connections.length)
    var stuck = connected && !!d.connectUrl
    // A real link in a new tab: Shopify admin's frame won't let a script navigate the top page. Not connected yet (or
    // only needing a reconnect): a one-time link that signs in to Aggregate and attaches this store there.
    openLink.href = connected && !stuck ? base + '/' : d.connectUrl || base + '/'
    openLink.textContent = stuck ? 'Reconnect to Aggregate' : connected ? 'Open Aggregate' : 'Connect to Aggregate'
    if (!connected) { lead.textContent = d.message || 'This store isn’t connected to Aggregate yet. Connect it to see its payouts, fees and refunds there (read-only).'; disc.hidden = true; document.getElementById('payouts').hidden = true; return }
    lead.textContent = 'This store’s payouts, fees and refunds sync to Aggregate (read-only).'
    d.connections.forEach(function (x) {
      var row = document.createElement('div'); row.className = 'row'
      var a = document.createElement('span'); a.textContent = x.name
      var b = document.createElement('span'); b.textContent = x.status === 'active' ? (x.lastSyncAt ? 'Synced ' + new Date(x.lastSyncAt).toLocaleString() : 'Connected') : x.status === 'needs_reauth' ? 'Needs reconnecting' : 'Paused'
      row.appendChild(a); row.appendChild(b); list.appendChild(row)
    })
    disc.hidden = false
    call('GET', '/api/connectors/shopify/embedded/summary').then(payouts, function () {})
  }
  function money(v, cur) { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(Number(v)) } catch (e) { return v + ' ' + cur } }
  function payouts(d) {
    var box = document.getElementById('payouts'), rows = document.getElementById('rows'), none = document.getElementById('none'), next = document.getElementById('next')
    box.hidden = false; rows.textContent = ''
    next.textContent = d.next ? 'Next payout: ' + money(d.next.net, d.next.currency) + ' on ' + d.next.date + ' (' + d.next.status.replace('_', ' ') + ')' : ''
    none.hidden = !!(d.payouts && d.payouts.length)
    ;(d.payouts || []).forEach(function (p) {
      var tr = document.createElement('tr')
      ;[p.date, p.status.replace('_', ' '), money(p.gross, p.currency), money(p.fees, p.currency), money(p.refunds, p.currency), money(p.net, p.currency)].forEach(function (v, i) {
        var td = document.createElement('td'); td.textContent = v; if (i > 1) td.className = 'n'; tr.appendChild(td)
      })
      rows.appendChild(tr)
    })
  }
  function load() { call('GET', '/api/connectors/shopify/embedded/status').then(render, function () { lead.textContent = 'Couldn’t reach Aggregate. Reload to try again.' }) }
  // Not connected yet: the install flow (sign in, then Shopify's consent screen); otherwise Aggregate itself.
  // Two steps inline: embedded apps can't open browser dialogs.
  disc.addEventListener('click', function () { disc.hidden = true; confirmRow.hidden = false })
  no.addEventListener('click', function () { confirmRow.hidden = true; disc.hidden = false })
  yes.addEventListener('click', function () {
    yes.disabled = true
    call('POST', '/api/connectors/shopify/embedded/disconnect').then(function (d) { yes.disabled = false; confirmRow.hidden = true; render(d) }, function () { yes.disabled = false; lead.textContent = 'That didn’t work. Try again.' })
  })
  load()
})()
</script></body></html>`
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // Framed only by this shop's admin (Shopify's rule for embedded apps).
      'content-security-policy': [
        "default-src 'self'",
        `script-src https://cdn.shopify.com 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        `connect-src 'self' ${new URL(base).origin} https://*.shopify.com`,
        "img-src 'self' data:",
        `frame-ancestors https://${shop} https://admin.shopify.com`,
        "base-uri 'none'",
        "object-src 'none'",
      ].join('; '),
    },
  })
}

/** Session-token routes the embedded page calls (mounted before the cookie session middleware). */
export function shopifyEmbeddedRoutes(app: Hono<any>, s: Services): void {
  const verified = (c: Context): { shop: string; token: string } | null => {
    const token = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')?.[1]
    const verify = connector(s)?.verifySessionToken
    if (!token || !verify) return null
    try {
      return { shop: verify(token), token }
    } catch {
      return null
    }
  }
  const shopOf = (c: Context): string | null => verified(c)?.shop ?? null

  /**
   * Not connected yet: make sure this store's offline token is waiting (Shopify installed the app; exchange the
   * session token for it), then hand out a fresh one-time link that attaches it to a workspace after sign-in.
   */
  const connectUrlFor = async (shop: string, sessionToken: string): Promise<string> => {
    const db = pendingDb(s)
    const now = Date.now()
    const row = await db.selectFrom('shopify_pending_installs').select(['created_at']).where('shop', '=', shop).executeTakeFirst()
    if (!row || now - Date.parse(row.created_at) > PENDING_TTL_MS) {
      const exchange = connector(s)?.exchangeSessionToken
      if (!exchange) throw new Error('Shopify isn’t set up on this server.')
      const secret = await exchange(shop, sessionToken)
      const values = { secret_enc: seal(s.keys, secret, SEAL(shop)), created_at: new Date(now).toISOString(), link_hash: null, link_expires_at: null, link_email: null }
      if (row) await db.updateTable('shopify_pending_installs').set(values).where('shop', '=', shop).execute()
      else await db.insertInto('shopify_pending_installs').values({ shop, ...values }).execute()
    }
    // Who is asking, in Shopify: only an Aggregate person with the same email can use this link. Shopify naming
    // nobody (rare) leaves it to a confirm step after sign-in instead.
    const email = (await connector(s)?.staffEmail?.(shop, sessionToken).catch(() => undefined)) ?? null
    const link = randomBytes(32).toString('base64url')
    await db.updateTable('shopify_pending_installs').set({ link_hash: hash(link), link_expires_at: new Date(now + LINK_TTL_MS).toISOString(), link_email: email }).where('shop', '=', shop).execute()
    return `${s.config.baseUrl}/api/connectors/shopify/link?t=${link}`
  }
  // The one cross-workspace step: which connections (in any workspace) belong to this verified store.
  const connectionsFor = async (shop: string) => {
    const rows = await withBypass('shopify:connections', () => s.db.selectFrom('connections').select(['id', 'workspace_id', 'display_name', 'status', 'config_json', 'last_success_at']).where('connector_key', '=', 'shopify').where('status', '!=', 'disconnected').execute())
    return rows.filter((r) => (JSON.parse(r.config_json) as { shop?: string }).shop === shop)
  }
  const view = async (shop: string) => ({
    shop,
    connections: (await connectionsFor(shop)).map((r) => ({ name: r.display_name, status: r.status, lastSyncAt: r.last_success_at })),
  })

  app.get('/api/connectors/shopify/embedded/status', async (c) => {
    const v = verified(c)
    if (!v) return c.json({ message: 'Open this page from Shopify admin.' }, 401)
    // The verified token names a store, not a workspace: a named bypass for this request (docs/security/rls.md).
    return c.json(
      await withBypass('shopify:embedded', async () => {
        const out = await view(v.shop)
        // Connected and working (or paused) somewhere: nothing to link. Only needing a reconnect: a fresh link, which
        // puts the new token into that connection after sign-in.
        if (out.connections.some((x) => x.status !== 'needs_reauth')) return out
        try {
          return { ...out, connectUrl: await connectUrlFor(v.shop, v.token) }
        } catch (e) {
          console.warn('[agfn] shopify token exchange failed', { shop: v.shop, reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) })
          return { ...out, message: 'Aggregate couldn’t finish setting up this store with Shopify. Reload this page to try again.' }
        }
      }),
    )
  })

  // The store's recent payouts inside the admin (App Store rule 2.2.2: the embedded page does something there), from
  // what the connection synced: the latest copy of each payout Shopify sent.
  app.get('/api/connectors/shopify/embedded/summary', async (c) => {
    const shop = shopOf(c)
    if (!shop) return c.json({ message: 'Open this page from Shopify admin.' }, 401)
    return c.json(
      await (async () => {
        const conns = await connectionsFor(shop)
        const ids = conns.map((r) => r.id)
        // Read each connection's payouts inside its own workspace (row-level security), newest first.
        const rows: Array<{ external_id: string; payload_json: string; received_at: string }> = []
        for (const ws of new Set(conns.map((r) => r.workspace_id)))
          rows.push(
            ...(await withWorkspace(ws, () =>
              (s.db as unknown as Kysely<{ raw_records: { connection_id: string; kind: string; external_id: string; payload_json: string; received_at: string } }>)
                .selectFrom('raw_records')
                .select(['external_id', 'payload_json', 'received_at'])
                .where('connection_id', 'in', conns.filter((r) => r.workspace_id === ws).map((r) => r.id))
                .where('kind', '=', 'shopify.payout')
                .orderBy('received_at', 'desc')
                .limit(500)
                .execute(),
            )),
          )
        rows.sort((a, b) => (a.received_at < b.received_at ? 1 : -1))
        const latest = new Map<string, Record<string, unknown>>()
        for (const r of rows) if (!latest.has(r.external_id)) latest.set(r.external_id, JSON.parse(r.payload_json) as Record<string, unknown>)
        const all = [...latest.values()].map(payoutRow).filter((x): x is PayoutRow => !!x).sort((a, b) => (a.date < b.date ? 1 : -1))
        const upcoming = all.filter((x) => x.status === 'scheduled' || x.status === 'in_transit').sort((a, b) => (a.date < b.date ? -1 : 1))
        return { connected: ids.length > 0, payouts: all.slice(0, 10), next: upcoming[0] ?? null }
      })(),
    )
  })

  // The "Connect to Aggregate" link, opened in a new tab: keep it across sign-in, then attach (GET /install/resume).
  app.get('/api/connectors/shopify/link', async (c) => {
    const t = c.req.query('t') ?? ''
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(t)) return c.redirect(`/#/?connect_error=${encodeURIComponent('That link from Shopify is invalid. Open Aggregate from your Shopify admin again.')}&connector=shopify`)
    setCookie(c, SHOPIFY_LINK_COOKIE, t, { path: '/api', httpOnly: true, secure: s.config.baseUrl.startsWith('https:'), sameSite: 'Lax', maxAge: 30 * 60 })
    const session = await s.auth.api.getSession({ headers: c.req.raw.headers })
    if (session) return c.redirect('/api/connectors/shopify/install/resume')
    // Signed out: sign-in opens with the Shopify staff email filled in, the one the link needs.
    // shopify_pending_installs has no workspace_id: no row-level security, no bypass.
    const email = await pendingEmailForLink(s, t)
    return c.redirect(email ? `/#/?signin_email=${encodeURIComponent(email)}&signin_for=shopify` : '/#/?signin_for=shopify')
  })

  // A store admin in Shopify can remove the connection (rule 5.7.12). That uninstalls Aggregate once the store's last
  // connection goes, and shop/redact deletes what synced 48 hours later, so each workspace's log says so now.
  app.post('/api/connectors/shopify/embedded/disconnect', async (c) => {
    const shop = shopOf(c)
    if (!shop) return c.json({ message: 'Open this page from Shopify admin.' }, 401)
    return c.json(
      await (async () => {
        const rows = await connectionsFor(shop)
        let uninstalled = false
        for (const r of rows) {
          await withWorkspace(r.workspace_id, async () => {
            if ((await s.sync.disconnect(r.id)).revoked) uninstalled = true
            await appendActivity(s.db as never, { workspaceId: r.workspace_id, actorKind: 'system', actorLabel: 'Shopify admin', action: 'connection.disconnected', targetType: 'connection', targetId: r.id, status: 'ok', detail: `Disconnected ${r.display_name} from Shopify admin; its data until now still counts` }, new Date())
          })
        }
        if (uninstalled) for (const r of rows) await withWorkspace(r.workspace_id, () => noteConnection(s, r.workspace_id, r.id, SHOPIFY_ERASE_WARNING))
        return view(shop)
      })(),
    )
  })
}

interface PayoutRow {
  date: string
  status: string
  currency: string
  gross: string
  fees: string
  refunds: string
  net: string
}

const num = (m: unknown): number => {
  const v = m && typeof m === 'object' ? Number((m as { amount?: unknown }).amount) : NaN
  return Number.isFinite(v) ? v : 0
}

/** One payout as Shopify sent it (PAYOUTS_QUERY): gross charges, all fees, refunds, and the net paid. */
function payoutRow(p: Record<string, unknown>): PayoutRow | null {
  const date = typeof p.issuedAt === 'string' ? p.issuedAt.slice(0, 10) : null
  const net = p.net && typeof p.net === 'object' ? (p.net as { amount?: unknown; currencyCode?: unknown }) : null
  if (!date || !net) return null
  const sm = p.summary && typeof p.summary === 'object' ? (p.summary as Record<string, unknown>) : {}
  const fees = ['chargesFee', 'refundsFee', 'adjustmentsFee', 'advanceFees', 'reservedFundsFee', 'retriedPayoutsFee'].reduce((t, k) => t + Math.abs(num(sm[k])), 0)
  const fixed = (n: number) => n.toFixed(2)
  return {
    date,
    status: typeof p.status === 'string' ? p.status.toLowerCase() : 'unknown',
    currency: typeof net.currencyCode === 'string' ? net.currencyCode : 'USD',
    gross: fixed(num(sm.chargesGross)),
    fees: fixed(fees),
    refunds: fixed(Math.abs(num(sm.refundsFeeGross))),
    net: fixed(num(net)),
  }
}

