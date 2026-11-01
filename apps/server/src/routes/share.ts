// Share cards (../share.ts). Signed-in routes under /api for the app; public routes at /a/<id> for everyone.
//   GET  /api/share                 → { cards: ShareCardRow[] }  (Settings → Shared links; drafts and live)
//   POST /api/share                 { entityId, kind }  → { id }  (a draft; nothing public yet)
//   POST /api/share/:id/preview     { amounts, name }   → { card: ShareSnapshot, words }  (the confirm sheet)
//   GET  /api/share/:id/preview.png ?amounts=1&name=1   → the image it would publish
//   POST /api/share/:id/publish     { amounts, name }   → { url, card }
//   POST /api/share/:id/revoke                          → { ok }  (live → 410; a draft is deleted)
// Badges (kind 'badge', only with AGFN_BADGES): the same routes with { name, fields: ['mrr','growth','runway'] };
//   GET  /api/share/:id/preview.svg ?name=1&fields=mrr,runway → the embed it would publish. Public at /b/<id>.
// Only people who manage the workspace make, publish or revoke cards: a public link is theirs to give.

import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { RequestPerson } from '../app.ts'
import type { Services } from '../services.ts'
import { badgePage, badgeSvg, BADGE_FIELDS, howWeVerifyPage, liveBadge, type BadgeField } from '../badge.ts'
import { cachedRender, cardWords, draftShare, gonePage, listShares, previewShare, publicShare, publishShare, renderCard, revokeShare, ShareError, sharePage, SHARE_KINDS, type ShareKind, type ShareSize } from '../share.ts'

type Env = { Variables: { person: RequestPerson } }
type S = Pick<Services, 'db' | 'ledger' | 'syncDeps' | 'permissions'>

export interface ShareCardRow {
  id: string
  kind: ShareKind
  entityId: string
  company: string
  status: 'draft' | 'live'
  /** "app", or the AI that drafted it. */
  source: string
  url: string | null
  createdAt: string
  publishedAt: string | null
}

function reply(status: number, body: Record<string, unknown>): never {
  throw new HTTPException(status as 400, { res: new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) })
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof ShareError) reply(e.status, { message: e.message })
    throw e
  }
}

export function shareRoutes(s: S, baseUrl: string, flags: { badges?: boolean } = {}): Hono<Env> {
  const app = new Hono<Env>()
  const base = baseUrl.replace(/\/+$/, '')
  const link = (kind: ShareKind, id: string) => `${base}/${kind === 'badge' ? 'b' : 'a'}/${id}`

  async function manager(c: Context<Env>): Promise<{ ws: string; personId: string }> {
    const p = c.get('person')
    if (!p.workspaceId) reply(409, { error: 'onboarding', message: 'Create your first company to get started.' })
    if (!(await s.permissions.canManageWorkspace(p.workspaceId, p.personId))) reply(403, { message: 'Only owners and admins can share cards.' })
    return { ws: p.workspaceId, personId: p.personId }
  }
  const on = (x: unknown) => x === true || x === '1'
  const fields = (x: unknown): BadgeField[] => {
    const list = Array.isArray(x) ? x : typeof x === 'string' ? x.split(',') : []
    return BADGE_FIELDS.filter((f) => list.includes(f))
  }
  const opts = (v: Record<string, unknown>) => ({ amounts: on(v.amounts), name: on(v.name), vendors: on(v.vendors), fields: fields(v.fields) })
  const body = async (c: Context<Env>) => ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>

  app.get('/share', async (c) => {
    const { ws, personId } = await manager(c)
    const [rows, ents] = await Promise.all([listShares(s, ws), s.permissions.entitiesFor(ws, personId)])
    const names = new Map(ents.map((e) => [e.id, e.name]))
    const cards: ShareCardRow[] = rows.map((r) => ({ id: r.id, kind: r.kind, entityId: r.entity_id, company: names.get(r.entity_id) ?? 'A company', status: r.status as 'draft' | 'live', source: r.source, url: r.status === 'live' ? link(r.kind, r.id) : null, createdAt: r.created_at, publishedAt: r.published_at }))
    return c.json({ cards })
  })

  app.post('/share', async (c) => {
    const { ws, personId } = await manager(c)
    const b = await body(c)
    if (typeof b.entityId !== 'string' || !SHARE_KINDS.includes(b.kind as ShareKind) || (b.kind === 'badge' && !flags.badges)) reply(400, { message: 'Send entityId and kind (runway, cash_trend, roast or hype).' })
    return c.json(await guard(() => draftShare(s, { workspaceId: ws, personId, entityId: b.entityId as string, kind: b.kind as ShareKind, source: 'app' })))
  })

  app.post('/share/:id/preview', async (c) => {
    const { ws, personId } = await manager(c)
    const o = opts(await body(c))
    const card = await guard(() => previewShare(s, ws, personId, c.req.param('id'), o))
    return c.json({ card, words: cardWords(card) })
  })

  app.get('/share/:id/preview.png', async (c) => {
    const { ws, personId } = await manager(c)
    const size: ShareSize = c.req.query('size') === 'card' ? 'card' : 'og'
    const card = await guard(() => previewShare(s, ws, personId, c.req.param('id'), opts({ amounts: c.req.query('amounts'), name: c.req.query('name'), vendors: c.req.query('vendors') })))
    return c.body(new Uint8Array(await renderCard(card, size)), 200, { 'content-type': 'image/png', 'cache-control': 'private, no-store' })
  })

  app.get('/share/:id/preview.svg', async (c) => {
    const { ws, personId } = await manager(c)
    const card = await guard(() => previewShare(s, ws, personId, c.req.param('id'), opts({ name: c.req.query('name'), fields: c.req.query('fields') })))
    return c.body(badgeSvg(card), 200, { 'content-type': 'image/svg+xml', 'cache-control': 'private, no-store' })
  })

  app.post('/share/:id/publish', async (c) => {
    const { ws, personId } = await manager(c)
    const id = c.req.param('id')
    const o = opts(await body(c))
    const card = await guard(() => publishShare(s, ws, personId, id, o))
    return c.json({ url: link(card.kind, id), card })
  })

  app.post('/share/:id/revoke', async (c) => {
    const { ws } = await manager(c)
    await guard(() => revokeShare(s, ws, c.req.param('id')))
    return c.json({ ok: true })
  })

  return app
}

/** Public: the page and its two images. Cacheable for 5 minutes; a revoked link answers 410 on this server at once. */
export function publicShareRoutes(s: Pick<Services, 'db'>, baseUrl: string, fonts: { geist?: string } = {}): Hono {
  const app = new Hono()
  const CACHE = 'public, max-age=300'
  const headers = { 'x-robots-tag': 'noindex, nofollow' }
  const gone = (c: Context, found: boolean) => c.html(gonePage(fonts, found), found ? 410 : 404, { ...headers, 'cache-control': CACHE })

  app.get('/a/:id', async (c) => {
    const id = c.req.param('id')
    const hit = await publicShare(s, id)
    if (!hit || hit.status === 'revoked') return gone(c, !!hit)
    return c.html(sharePage(baseUrl, id, hit.snapshot, fonts), 200, { ...headers, 'cache-control': CACHE })
  })

  for (const [file, size] of [['og.png', 'og'], ['card.png', 'card']] as const) {
    app.get(`/a/:id/${file}`, async (c) => {
      const id = c.req.param('id')
      const hit = await publicShare(s, id)
      if (!hit || hit.status === 'revoked') return c.body(null, hit ? 410 : 404, { ...headers, 'cache-control': CACHE })
      const png = await cachedRender(id, hit.snapshot, size)
      return c.body(new Uint8Array(png), 200, { ...headers, 'content-type': 'image/png', 'cache-control': CACHE, ...(c.req.query('download') === '1' ? { 'content-disposition': `attachment; filename="aggregate-${size === 'card' ? 'card' : 'preview'}.png"` } : {}) })
    })
  }
  return app
}

/**
 * Public badges (AGFN_BADGES): /b/<id> (the page), /b/<id>.svg (the embed) and /how-we-verify. A badge is checked
 * again once a day (badge.ts); pages and the embed cache for 5 minutes, and a revoked badge answers 410 here at once.
 */
export function publicBadgeRoutes(s: Pick<Services, 'db' | 'ledger'>, baseUrl: string, fonts: { geist?: string } = {}): Hono {
  const app = new Hono()
  const CACHE = 'public, max-age=300'
  const headers = { 'x-robots-tag': 'noindex, nofollow' }

  app.get('/how-we-verify', (c) => c.html(howWeVerifyPage(fonts), 200, { 'cache-control': 'public, max-age=3600' }))

  app.get('/b/:file', async (c) => {
    const file = c.req.param('file')
    const svg = file.endsWith('.svg')
    const id = svg ? file.slice(0, -4) : file
    const hit = await liveBadge(s, id)
    if (!hit || hit.status === 'revoked') {
      if (svg) return c.body(null, hit ? 410 : 404, { ...headers, 'cache-control': CACHE })
      return c.html(gonePage(fonts, !!hit), hit ? 410 : 404, { ...headers, 'cache-control': CACHE })
    }
    // Embeds load from other sites (a README, a pitch page), so the image may be fetched cross-origin.
    if (svg) return c.body(badgeSvg(hit.snapshot), 200, { ...headers, 'content-type': 'image/svg+xml', 'cache-control': CACHE, 'access-control-allow-origin': '*' })
    return c.html(badgePage(baseUrl, id, hit.snapshot, fonts), 200, { ...headers, 'cache-control': CACHE })
  })
  return app
}
