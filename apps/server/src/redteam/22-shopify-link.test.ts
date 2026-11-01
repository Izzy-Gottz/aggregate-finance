// Red team 22: Shopify managed install. The store's token comes from exchanging the embedded page's session token and
// waits (sealed) until someone signs in and picks a workspace through a one-time link. Through the real server and the
// real Shopify connector: only a session token Shopify signed for this app yields a link; a link carries only its own
// store; it works once and expires; the waiting token is sealed and goes when the store is connected or uninstalled.
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { withBypass } from '@agfn/db'
import { createShopifyConnector } from '@agfn/connector-shopify'
import { BASE, signIn, startServer, type Server } from '../scenarios/harness.ts'

const APP = { clientId: 'rt-client', clientSecret: 'rt-secret' }
const SHOP_A = 'store-a.myshopify.com'
const SHOP_B = 'store-b.myshopify.com'

function sessionToken(shop: string, secret = APP.clientSecret): string {
  const enc = (x: object) => Buffer.from(JSON.stringify(x)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const body = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ iss: `https://${shop}/admin`, dest: `https://${shop}`, aud: APP.clientId, sub: '7', exp: now + 60, nbf: now - 5, iat: now - 5, jti: 'j', sid: 's' })}`
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}

/** Shopify's side: token exchange per shop, and a store without Payments (so the connect itself is simple). */
function shopify() {
  const exchanged: string[] = []
  /** Which Shopify staff member each store's admin session belongs to (the online exchange returns it). */
  const staff: Record<string, string> = { [SHOP_A]: 'Alice22@Example.com', [SHOP_B]: 'mallory22@example.com' }
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.pathname === '/admin/oauth/access_token') {
      const form = new URLSearchParams(String(init?.body ?? ''))
      expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange')
      if (form.get('requested_token_type') === 'urn:shopify:params:oauth:token-type:online-access-token') {
        return json({ access_token: 'shpua_online', scope: '', expires_in: 86_399, associated_user_scope: '', associated_user: { id: 7, first_name: 'S', email: staff[url.host], email_verified: true, account_owner: true } })
      }
      exchanged.push(url.host)
      return json({ access_token: `shpua_${url.host.split('.')[0]}_token`, scope: 'read_shopify_payments_payouts,read_shopify_payments_accounts', expires_in: 3600, refresh_token: 'shprt_rt', refresh_token_expires_in: 7_776_000 })
    }
    if (url.pathname.endsWith('/graphql.json')) return json({ data: { shop: { name: url.host.split('.')[0], currencyCode: 'USD' }, shopifyPaymentsAccount: null } })
    return new Response('{}', { status: 404 })
  }) as typeof globalThis.fetch
  return { fetch, exchanged, staff }
}

async function world(): Promise<{ srv: Server; exchanged: string[]; staff: Record<string, string> }> {
  const sh = shopify()
  const srv = await startServer({ connectors: [(deps) => createShopifyConnector({ ...APP }, { ...deps, fetch: sh.fetch })] })
  return { srv, exchanged: sh.exchanged, staff: sh.staff }
}
const status = (srv: Server, token: string) => srv.app.request('/api/connectors/shopify/embedded/status', { headers: { authorization: `Bearer ${token}` } })
const linkFor = async (srv: Server, shop: string) => ((await (await status(srv, sessionToken(shop))).json()) as { connectUrl: string }).connectUrl.replace(BASE, '')
const cookieOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
async function useLink(srv: Server, cookie: string, link: string): Promise<string> {
  const opened = await srv.app.request(link, { headers: { cookie } })
  const done = await srv.app.request('/api/connectors/shopify/install/resume', { headers: { origin: BASE, cookie: `${cookie}; ${cookieOf(opened)}` } })
  return done.headers.get('location') ?? ''
}
const shopsOf = async (srv: Server, ws: string) =>
  withBypass('test:read', async () =>
    (await srv.booted.services.db.selectFrom('connections').select(['config_json', 'workspace_id']).where('connector_key', '=', 'shopify').where('workspace_id', '=', ws).execute()).map((r) => (JSON.parse(r.config_json) as { shop: string }).shop),
  )

describe('red team 22: Shopify managed install links', () => {
  it('only a session token Shopify signed for this app gets a link; a forged one exchanges nothing', async () => {
    const { srv, exchanged } = await world()
    try {
      expect((await status(srv, sessionToken(SHOP_A, 'not-our-secret'))).status).toBe(401)
      expect(exchanged).toEqual([])
      expect((await status(srv, sessionToken(SHOP_A))).status).toBe(200)
      expect(exchanged).toEqual([SHOP_A])
    } finally {
      await srv.close()
    }
  })

  it("a link attaches only its own store, works once, and the waiting token is sealed and then gone", async () => {
    const { srv } = await world()
    try {
      const a = await linkFor(srv, SHOP_A)
      const b = await linkFor(srv, SHOP_B)
      const raw = await withBypass('test:read', () => (srv.booted.services.db as never as import('kysely').Kysely<{ shopify_pending_installs: { shop: string; secret_enc: string } }>).selectFrom('shopify_pending_installs').select(['shop', 'secret_enc']).execute())
      expect(raw).toHaveLength(2)
      for (const r of raw) expect(r.secret_enc).not.toMatch(/shpua_|shprt_/) // sealed, never the token itself

      const alice = await signIn(srv, 'alice22@example.com', 'Alice Co')
      const mallory = await signIn(srv, 'mallory22@example.com', 'Mallory Co')
      expect(await useLink(srv, alice.cookie(), a)).toMatch(/d=connection:/)
      expect(await shopsOf(srv, alice.workspaceId)).toEqual([SHOP_A])
      // The same link again, by anyone: refused, and store A doesn't move or duplicate.
      expect(await useLink(srv, mallory.cookie(), a)).toMatch(/connect_error=/)
      expect(await useLink(srv, alice.cookie(), a)).toMatch(/connect_error=/)
      expect(await shopsOf(srv, mallory.workspaceId)).toEqual([])
      // B's link brings B only.
      expect(await useLink(srv, mallory.cookie(), b)).toMatch(/d=connection:/)
      expect(await shopsOf(srv, mallory.workspaceId)).toEqual([SHOP_B])
      expect(await shopsOf(srv, alice.workspaceId)).toEqual([SHOP_A])
      expect(await withBypass('test:read', () => (srv.booted.services.db as never as import('kysely').Kysely<{ shopify_pending_installs: { shop: string } }>).selectFrom('shopify_pending_installs').select('shop').execute())).toEqual([])
    } finally {
      await srv.close()
    }
  }, 60_000)

  it('a link stops working after 15 minutes, and a newer link replaces an older one', async () => {
    const w = await world()
    const { srv } = w
    try {
      const { staff } = w
      staff[SHOP_A] = 'alice22b@example.com'
      const first = await linkFor(srv, SHOP_A)
      const second = await linkFor(srv, SHOP_A)
      const alice = await signIn(srv, 'alice22b@example.com', 'Alice Co')
      expect(await useLink(srv, alice.cookie(), first)).toMatch(/connect_error=/) // replaced
      await withBypass('test:age', () => (srv.booted.services.db as never as import('kysely').Kysely<{ shopify_pending_installs: { link_expires_at: string } }>).updateTable('shopify_pending_installs').set({ link_expires_at: new Date(Date.now() - 1000).toISOString() }).execute())
      expect(await useLink(srv, alice.cookie(), second)).toMatch(/connect_error=/) // expired
      expect(await shopsOf(srv, alice.workspaceId)).toEqual([])
      // A fresh one from the admin works.
      expect(await useLink(srv, alice.cookie(), await linkFor(srv, SHOP_A))).toMatch(/d=connection:/)
    } finally {
      await srv.close()
    }
  }, 60_000)

  it("only the Shopify staff member the link was issued to can use it: same email (any case), else a plain refusal and the link stays theirs", async () => {
    const { srv } = await world()
    try {
      const a = await linkFor(srv, SHOP_A) // issued to Alice22@Example.com
      const mallory = await signIn(srv, 'mallory22c@example.com', 'Mallory Co')
      const refused = await useLink(srv, mallory.cookie(), a)
      // Named, masked (the store's own staff recognise it; nobody else learns it), in the Shopify drawer, not a toast.
      expect(decodeURIComponent(refused)).toContain('Sign in to Aggregate with the email you use for this Shopify store (a•••@example.com).')
      expect(refused).toMatch(/&connector=shopify$/)
      expect(await shopsOf(srv, mallory.workspaceId)).toEqual([])
      // Not used up by the refusal: Alice, signed in with the same email in another case, attaches it.
      const alice = await signIn(srv, 'alice22@example.com', 'Alice Co')
      expect(await useLink(srv, alice.cookie(), a)).toMatch(/d=connection:/)
      expect(await shopsOf(srv, alice.workspaceId)).toEqual([SHOP_A])
    } finally {
      await srv.close()
    }
  }, 60_000)
})

