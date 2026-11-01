// Reviewer access links (reviewer.ts): a directory reviewer opens a link and is signed into a demo-only account with no
// email step. The red team guesses tokens, aims a reviewer session (and the AI connections it can make) at the
// victim's ids through every surface, replays it after the nightly reseed, after revocation and after expiry, and tries
// to spend the fresh-sign-in re-check window on anything but connecting an AI.
import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { newId } from '@agfn/db'
import { BASE, READ_WRITE_ALL, startServer, type Server, type Session } from '../scenarios/harness.ts'
import { mintReviewerLink, reseedReviewerDemos, revokeReviewerLink, serverDemoBuilder } from '../reviewer.ts'
import { asTest, leaks, victimWorld, type Victim } from './world.ts'

type AnyDb = import('kysely').Kysely<Record<string, Record<string, unknown>>>
const ON = { env: { AGFN_REVIEWER_LINKS: '1' } }
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback'
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'rt', version: '1' } } }

interface Reviewer extends Session {
  linkId: string
  url: string
  token: string
  email: string
  demoWs: string
}

async function mint(srv: Server, label = 'Anthropic directory review') {
  const link = await asTest(() => mintReviewerLink({ db: srv.booted.services.db, buildDemo: serverDemoBuilder(srv.booted.services) }, { label, baseUrl: BASE }))
  return { ...link, token: link.url.slice(link.url.lastIndexOf('/') + 1) }
}

/** Open a reviewer link the way a browser does: the 302 to the captured magic link, then its verify step. */
async function open(srv: Server, path: string): Promise<{ status: number; body: string; cookie: string }> {
  const r = await srv.app.request(path)
  const body = await r.text()
  if (r.status !== 302) return { status: r.status, body, cookie: '' }
  const verify = await srv.app.request(r.headers.get('location')!.replace(BASE, ''), { headers: { origin: BASE } })
  return { status: 302, body, cookie: verify.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') }
}

function sessionFor(srv: Server, cookie: string, personId: string, workspaceId: string): Session {
  const call = async <T>(method: string, path: string, body?: unknown, init: { headers?: Record<string, string>; raw?: BodyInit } = {}) => {
    const headers: Record<string, string> = { origin: BASE, cookie, ...init.headers }
    let payload: BodyInit | undefined = init.raw
    if (body !== undefined && payload === undefined) {
      headers['content-type'] ??= 'application/json'
      payload = JSON.stringify(body)
    }
    const res = await srv.app.request(path, { method, headers, ...(payload !== undefined ? { body: payload } : {}) })
    const text = await res.text()
    let parsed: unknown = text
    try {
      parsed = JSON.parse(text)
    } catch {
      /* not json */
    }
    return { status: res.status, body: parsed as T }
  }
  return { personId, workspaceId, get: (p) => call('GET', p), post: (p, b, i) => call('POST', p, b, i), send: (m, p, b, h) => call(m, p, b, h ? { headers: h } : {}), cookie: () => cookie }
}

async function reviewer(srv: Server, label?: string): Promise<Reviewer> {
  const link = await mint(srv, label)
  const o = await open(srv, `/review-access/${link.token}`)
  expect(o.status).toBe(302)
  const me = await srv.app.request('/api/me', { headers: { cookie: o.cookie } })
  const body = (await me.json()) as { personId: string; workspaceId: string; reviewerDemo?: boolean }
  expect(body.reviewerDemo).toBe(true)
  expect(body.workspaceId).toBe(link.workspaceId)
  return { ...sessionFor(srv, o.cookie, body.personId, body.workspaceId), linkId: link.id, url: link.url, token: link.token, email: link.email, demoWs: link.workspaceId }
}

const keyShape = (over: Partial<typeof READ_WRITE_ALL> = {}) => ({ ...READ_WRITE_ALL, ...over })

async function mcpCall(srv: Server, bearer: string, tool: string, args: Record<string, unknown>): Promise<{ status: number; text: string }> {
  const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${bearer}`, 'mcp-protocol-version': '2025-06-18' }
  const init = await srv.app.request('/mcp', { method: 'POST', headers: h, body: JSON.stringify(INIT) })
  const initText = await init.text()
  if (init.status !== 200) return { status: init.status, text: initText }
  const res = await srv.app.request('/mcp', { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }) })
  return { status: res.status, text: await res.text() }
}

/** The reviewer connects "Claude" through the real OAuth flow (DCR, authorize, consent, token). */
async function oauthToken(srv: Server, r: Reviewer): Promise<{ status: number; token?: string; grantId?: string }> {
  const app = srv.app
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie: r.cookie() }, body: JSON.stringify(body) })
  const client = (await (await app.request('/api/auth/oauth2/register', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'openid offline_access finance:read records:write' }) })).json()) as { client_id: string }
  const verifier = randomBytes(32).toString('base64url')
  const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: CALLBACK, scope: 'openid offline_access finance:read records:write', state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: `${BASE}/mcp` })
  const loc = (await app.request(`/api/auth/oauth2/authorize?${q}`, { headers: { cookie: r.cookie() } })).headers.get('location') ?? ''
  const consent = await post('/api/ai/consent', { clientId: client.client_id, clientName: 'Claude', shape: { entityIds: 'all', dataTypes: ['balances', 'transactions', 'invoices', 'bills', 'buckets', 'documents', 'reports'], write: true, reviewMode: 'instant', expiresAt: null } })
  if (consent.status !== 200) return { status: consent.status }
  const { grantId } = (await consent.json()) as { grantId: string }
  let next = ((await (await post('/api/auth/oauth2/continue', { postLogin: true, oauth_query: loc.slice(loc.indexOf('?') + 1) })).json()) as { url?: string }).url ?? ''
  if (next.includes('/#/connect-ai/consent')) next = ((await (await post('/api/auth/oauth2/consent', { accept: true, oauth_query: next.slice(next.indexOf('?') + 1) })).json()) as { url?: string }).url ?? ''
  const code = new URL(next).searchParams.get('code')!
  const tok = (await (await app.request('/api/auth/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: client.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }) })).json()) as { access_token?: string }
  return { status: 200, token: tok.access_token, grantId }
}

/** Every surface, aimed at the victim's ids. Nothing may succeed, and no victim marker may come back. */
async function probeVictim(srv: Server, r: Session, v: Victim, bearers: string[]): Promise<string[]> {
  const bad: string[] = []
  const hdr = { 'x-agfn-workspace': v.ws }
  const routes: Array<[string, string, unknown?]> = [
    ['GET', '/api/me'],
    ['GET', '/api/workspace'],
    ['GET', `/api/entities/${v.entityId}`],
    ['GET', `/api/entities/${v.entityId}/transactions`],
    ['GET', `/api/entities/${v.entityId}/mrr`],
    ['GET', `/api/entities/${v.entityId}/equity`],
    ['GET', `/api/entities/${v.entityId}/equity/ocf`],
    ['GET', `/api/entities/${v.personalId}`],
    ['GET', `/api/connections/${v.bankId}`],
    ['POST', `/api/connections/${v.bankId}/sync`, {}],
    ['POST', `/api/connections/${v.bankId}/company`, { entityId: v.entityId }],
    ['POST', `/api/connections/${v.bankId}/disconnect`, { deleteData: true }],
    ['POST', `/api/connections/${v.bankId}/reconnect`, {}],
    ['POST', `/api/connections/${v.bankId}/refresh-balance`, {}],
    ['POST', '/api/accounts/assign', { assignments: [{ accountId: v.accountId, entityId: v.entityId }] }],
    ['GET', `/api/documents`],
    ['GET', `/api/documents/${v.documentId}`],
    ['GET', `/api/documents/${v.documentId}/file`],
    ['POST', `/api/documents/${v.documentId}/account`, { accountId: 'new' }],
    ['GET', `/api/ai/${v.grantId}`],
    ['PATCH', `/api/ai/${v.grantId}`, { shape: { ...READ_WRITE_ALL } }],
    ['POST', `/api/ai/${v.grantId}/pause`, { paused: true }],
    ['POST', `/api/ai/${v.grantId}/revoke`, {}],
    ['GET', '/api/review'],
    ['POST', `/api/review/${v.reviewId}`, { decision: 'approve' }],
    ['GET', `/api/buckets/${v.bucketId}`],
    ['PATCH', `/api/buckets/${v.bucketId}`, { name: 'pwned' }],
    ['POST', `/api/records/${v.txnId}/undo`, {}],
    ['POST', `/api/entities/${v.entityId}/period`, { action: 'close', through: '2026-09-30' }],
    ['POST', `/api/entities/${v.entityId}/equity/events`, { kind: 'issuance', date: '2026-01-02', stakeholder: 'Mallory', shares: 1, idempotencyKey: 'rt-rev-eq-0001' }],
    ['POST', '/api/entries/cash', { entityId: v.entityId, kind: 'cash_income', amount: { amount: '1.00', currency: 'USD' }, date: '2026-10-04', counterparty: 'x' }],
    ['GET', `/api/inbound/${v.entityId}`],
    ['GET', '/api/usage'],
    ['GET', '/api/preferences'],
    ['POST', '/api/export', {}],
    // Control surface on the MCP host, with the reviewer's cookie.
    ['GET', '/v1/control/grants'],
    ['GET', `/v1/control/grants/${v.grantId}`],
    ['DELETE', `/v1/control/grants/${v.grantId}`],
    ['GET', '/v1/control/activity'],
    ['GET', '/v1/control/review'],
    ['POST', `/v1/control/review/${v.reviewId}/approve`, {}],
    ['GET', '/v1/control/settings'],
  ]
  const victimBefore = JSON.stringify(await v.s.get(`/api/ai/${v.grantId}`))
  for (const [method, path, body] of routes) {
    const res = await r.send<unknown>(method, path, body, hdr)
    const leak = leaks(res.body)
    // Anything inside the reviewer's own demo answering is fine; what matters is that no victim data comes back.
    if (leak) bad.push(`${method} ${path}: leaked ${leak} (${res.status})`)
    // Ids from the victim must never resolve.
    if (res.status < 300 && (path.includes(v.entityId) || path.includes(v.bankId) || path.includes(v.documentId) || path.includes(v.grantId) || path.includes(v.reviewId) || path.includes(v.bucketId) || path.includes(v.txnId) || path.includes(v.personalId))) bad.push(`${method} ${path}: ${res.status}`)
  }
  // The victim's own AI connection is untouched.
  if (JSON.stringify(await v.s.get(`/api/ai/${v.grantId}`)) !== victimBefore) bad.push('victim grant changed')

  // A victim export link, from the reviewer's session.
  const exp = await v.s.post<{ url: string }>('/api/export', {})
  expect(exp.status).toBe(200)
  const dl = await r.send<unknown>('GET', exp.body.url, undefined, hdr)
  if (dl.status < 300 || leaks(dl.body)) bad.push(`victim export download: ${dl.status}`)

  // /mcp and /v1 REST: with no key, with the reviewer's cookie, and with every bearer the reviewer could make.
  const noKey = await srv.app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', cookie: r.cookie(), origin: BASE }, body: JSON.stringify(INIT) })
  if (noKey.status !== 401) bad.push(`/mcp with a reviewer cookie: ${noKey.status}`)
  const restCookie = await srv.app.request('/v1/whoami', { headers: { cookie: r.cookie() } })
  if (restCookie.status !== 401) bad.push(`/v1/whoami with a reviewer cookie: ${restCookie.status}`)
  for (const b of bearers) {
    for (const [tool, args] of [
      ['search_transactions', { company: 'Victim Co' }],
      ['search_transactions', { entity_id: v.entityId }],
      ['get_metric', { metric: 'cash', company: 'Victim Co' }],
      ['get_bucket', { id: v.bucketId }],
      ['search_invoices', { company: 'Victim Co', side: 'owed_to_you' }],
      ['get_document', { id: v.documentId }],
      ['get_overview', {}],
    ] as const) {
      const res = await mcpCall(srv, b, tool, args)
      // An error that repeats the company name it was sent ("Victim Co" not found) isn't a leak.
      if (leaks(res.text, args)) bad.push(`/mcp ${tool}: leaked ${leaks(res.text, args)}`)
    }
    for (const path of [`/v1/transactions?company=Victim%20Co`, `/v1/buckets/${v.bucketId}`, '/v1/whoami']) {
      const res = await srv.app.request(path, { headers: { authorization: `Bearer ${b}` } })
      const text = await res.text()
      if (leaks(text, path.includes('Victim') ? 'Victim Co' : undefined) || text.includes(v.ws)) bad.push(`${path}: ${res.status} ${text.slice(0, 120)}`)
    }
  }
  return bad
}

describe('red team: reviewer access links', () => {
  it('(a) wrong, random, truncated, extended and case-changed tokens are refused identically and quickly', async () => {
    const srv = await startServer(ON)
    try {
      const link = await mint(srv)
      const t = link.token
      const flipCase = t.replace(/[a-zA-Z]/, (ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()))
      const oneOff = t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A')
      const guesses = [
        randomBytes(32).toString('base64url'),
        'A'.repeat(43),
        t.slice(0, 42),
        t.slice(0, 20),
        `${t}A`,
        `${t}${t}`,
        t.toUpperCase(),
        t.toLowerCase(),
        flipCase,
        oneOff,
        encodeURIComponent(`${t.slice(0, 42)}=`),
        `${t.slice(0, 42)}%00`,
        `${t.slice(0, 42)}.`,
        createHash('sha256').update(t).digest('hex'), // the stored hash itself is not a token
        'x'.repeat(5000),
      ]
      const statuses = new Set<number>()
      const bodies = new Set<string>()
      for (const g of guesses) {
        if (g === t) continue
        const start = performance.now()
        const r = await open(srv, `/review-access/${g}`)
        const ms = performance.now() - start
        statuses.add(r.status)
        bodies.add(r.body)
        expect(r.cookie, g).toBe('')
        expect(ms, `${g.slice(0, 50)} took ${ms}ms`).toBeLessThan(500)
      }
      // Expired, revoked and "account not demo-only" answer the very same way as a guess.
      const exp = await mint(srv, 'expired')
      await asTest(() => srv.booted.services.db.updateTable('reviewer_links').set({ expires_at: '2000-01-01T00:00:00.000Z' }).where('id', '=', exp.id).execute())
      const rev = await mint(srv, 'revoked')
      await asTest(() => revokeReviewerLink(srv.booted.services.db, rev.id))
      for (const g of [exp.token, rev.token]) {
        const r = await open(srv, `/review-access/${g}`)
        statuses.add(r.status)
        bodies.add(r.body)
        expect(r.cookie).toBe('')
      }
      expect([...statuses]).toEqual([404])
      expect(bodies.size).toBe(1)
      expect([...bodies][0]).not.toMatch(/expired|revoked|unsafe|demo/i)
      // A guess never counts as a use; the real token still works afterwards (not burned by guessing).
      const row = await asTest(() => srv.booted.services.db.selectFrom('reviewer_links').select(['uses', 'last_used_at']).where('id', '=', link.id).executeTakeFirstOrThrow())
      expect(Number(row.uses)).toBe(0)
      expect((await open(srv, `/review-access/${t}`)).status).toBe(302)
      // Off by default: even the real token is a plain 404 on a server without AGFN_REVIEWER_LINKS.
      const off = await startServer()
      try {
        const l2 = await mint(off)
        expect((await off.app.request(`/review-access/${l2.token}`)).status).toBe(404)
      } finally {
        await off.close()
      }
    } finally {
      await srv.close()
    }
  }, 120_000)

  it('(b) a reviewer session, its agent key and its OAuth token reach nothing of a real workspace', async () => {
    const srv = await startServer(ON)
    try {
      const v = await victimWorld(srv)
      const r = await reviewer(srv)
      // Inside the fresh-sign-in window: one agent key and one OAuth connection, the widest the reviewer can make.
      const key = await r.post<{ key: string; grantId: string }>('/api/ai/keys', { name: 'Reviewer key', shape: keyShape() })
      expect(key.status, JSON.stringify(key.body)).toBe(201)
      const oauth = await oauthToken(srv, r)
      expect(oauth.token).toBeTruthy()
      const bad = await probeVictim(srv, r, v, [key.body.key, oauth.token!])
      expect(bad).toEqual([])
      // Every grant the reviewer made lives in its demo workspace.
      const grants = (await asTest(() => (srv.booted.services.db as unknown as AnyDb).selectFrom('grants').select(['workspace_id']).where('person_id', '=', r.personId).execute())) as Array<{ workspace_id: string }>
      expect(grants.length).toBe(2)
      expect(grants.every((g) => g.workspace_id === r.demoWs)).toBe(true)
      // The reviewer address can't be invited into the victim's workspace (any case).
      for (const email of [r.email, r.email.toUpperCase(), ` ${r.email} `]) expect((await v.s.post('/api/people', { email, role: 'owner', entityIds: 'all' })).status).toBeGreaterThanOrEqual(400)
      // Nor can anyone sign in by email as it: a magic link to that address is never captured outside the link route.
      const before = srv.outbox.length
      await srv.app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: r.email, callbackURL: '/' }) })
      expect(srv.outbox.slice(before).join('\n')).not.toMatch(/review-access/)
    } finally {
      await srv.close()
    }
  }, 180_000)

  it('(b) a membership added by mistake to a real workspace shuts the reviewer out of every surface', async () => {
    const srv = await startServer(ON)
    try {
      const v = await victimWorld(srv)
      const r = await reviewer(srv)
      const db = srv.booted.services.db
      // Put the stray membership first in order (older than the demo one), as owner: the worst case.
      await asTest(() => db.insertInto('memberships').values({ id: newId(), workspace_id: v.ws, person_id: r.personId, role: 'owner', grid_json: null, expires_at: null, invited_by: null, created_at: '2000-01-01T00:00:00.000Z', revoked_at: null }).execute())
      expect((await r.get('/api/me')).status).toBe(403)
      const bad = await probeVictim(srv, r, v, [])
      expect(bad).toEqual([])
      // The control surface refuses outright too (it can't fall back to "the first workspace").
      for (const path of ['/v1/control/grants', '/v1/control/activity', '/v1/control/review', '/v1/control/settings']) expect((await r.get(path)).status, path).toBeGreaterThanOrEqual(400)
      expect((await r.post('/v1/control/keys', { name: 'k', shape: { entity_ids: 'all', data_types: ['balances'], write: false, expires_at: new Date(Date.now() + 86_400_000).toISOString() } })).status).toBeGreaterThanOrEqual(400)
      expect((await r.post('/v1/control/pause', {})).status).toBeGreaterThanOrEqual(400)
      // And the link itself won't sign anyone in.
      expect((await open(srv, `/review-access/${r.token}`)).status).toBe(404)
    } finally {
      await srv.close()
    }
  }, 180_000)

  it('(c) after the nightly reseed: same link and session, a new demo; the old demo and its AI access are gone', async () => {
    const srv = await startServer(ON)
    try {
      const v = await victimWorld(srv)
      const r = await reviewer(srv)
      const db = srv.booted.services.db
      const key = await r.post<{ key: string }>('/api/ai/keys', { name: 'Reviewer key', shape: keyShape() })
      expect(key.status).toBe(201)
      const oauth = await oauthToken(srv, r)
      expect((await mcpCall(srv, key.body.key, 'get_overview', {})).status).toBe(200)
      const victimGrantsBefore = JSON.stringify(await asTest(() => (db as unknown as AnyDb).selectFrom('grants').selectAll().where('workspace_id', '=', v.ws).orderBy('id').execute()))

      expect(await asTest(() => reseedReviewerDemos({ db, buildDemo: serverDemoBuilder(srv.booted.services) }))).toBe(1)
      // By design the session lives on and now lands in the new demo; the old one can't be picked by header.
      const me = await r.get<{ workspaceId: string; reviewerDemo?: boolean }>('/api/me')
      expect(me.status).toBe(200)
      expect(me.body.reviewerDemo).toBe(true)
      expect(me.body.workspaceId).not.toBe(r.demoWs)
      expect(me.body.workspaceId).not.toBe(v.ws)
      const newWs = me.body.workspaceId
      for (const ws of [r.demoWs, v.ws]) expect((await r.send<{ workspaceId: string }>('GET', '/api/me', undefined, { 'x-agfn-workspace': ws })).body.workspaceId).toBe(newWs)
      // Yesterday's AI connections are dead.
      expect((await mcpCall(srv, key.body.key, 'get_overview', {})).status).toBe(401)
      expect((await mcpCall(srv, oauth.token!, 'get_overview', {})).status).toBe(401)
      // The link still opens (it isn't single-use) — into the new demo, never the old one or the victim's.
      const again = await open(srv, `/review-access/${r.token}`)
      expect(again.status).toBe(302)
      const me2 = (await (await srv.app.request('/api/me', { headers: { cookie: again.cookie } })).json()) as { workspaceId: string }
      expect(me2.workspaceId).toBe(newWs)
      // Still exactly one live membership, and the re-check window from the reseed doesn't exist (no new sign-in).
      const m = await asTest(() => db.selectFrom('memberships').select('workspace_id').where('person_id', '=', r.personId).where('revoked_at', 'is', null).execute())
      expect(m.map((x) => x.workspace_id)).toEqual([newWs])
      expect(await probeVictim(srv, r, v, [])).toEqual([])
      // The victim's workspace was never touched by the reseed.
      expect(JSON.stringify(await asTest(() => (db as unknown as AnyDb).selectFrom('grants').selectAll().where('workspace_id', '=', v.ws).orderBy('id').execute()))).toBe(victimGrantsBefore)
    } finally {
      await srv.close()
    }
  }, 240_000)

  it('(c) revoking or expiring the link ends everything the reviewer holds: sessions, agent keys, OAuth tokens', async () => {
    const srv = await startServer(ON)
    try {
      const db = srv.booted.services.db
      // Revoked.
      const r = await reviewer(srv, 'to revoke')
      const key = await r.post<{ key: string }>('/api/ai/keys', { name: 'Reviewer key', shape: keyShape() })
      expect(key.status).toBe(201)
      const oauth = await oauthToken(srv, r)
      expect((await mcpCall(srv, key.body.key, 'get_overview', {})).status).toBe(200)
      expect((await mcpCall(srv, oauth.token!, 'get_overview', {})).status).toBe(200)
      expect(await asTest(() => revokeReviewerLink(db, r.linkId))).toBe(true)
      expect((await r.get('/api/me')).status).toBe(401)
      expect((await mcpCall(srv, key.body.key, 'get_overview', {})).status).toBe(401)
      expect((await mcpCall(srv, oauth.token!, 'get_overview', {})).status).toBe(401)
      const refresh = (await asTest(() => (db as unknown as AnyDb).selectFrom('oauthRefreshToken').selectAll().where('referenceId', '=', oauth.grantId!).execute())) as unknown[]
      expect(refresh).toEqual([])

      // Expired (not revoked): a live 30-day rolling session must not outlast the link.
      const e = await reviewer(srv, 'to expire')
      const ekey = await e.post<{ key: string }>('/api/ai/keys', { name: 'Reviewer key', shape: keyShape() })
      expect(ekey.status).toBe(201)
      await asTest(() => db.updateTable('reviewer_links').set({ expires_at: new Date(Date.now() - 1000).toISOString() }).where('id', '=', e.linkId).execute())
      expect((await e.get('/api/me')).status).toBe(403)
      expect((await e.get('/v1/control/grants')).status).toBeGreaterThanOrEqual(400)
      // Its AI key stops at once too, before any nightly job has run.
      expect((await mcpCall(srv, ekey.body.key, 'get_overview', {})).status).toBe(401)
      // The nightly job tidies expired links: their AI access is revoked too.
      await asTest(() => reseedReviewerDemos({ db, buildDemo: serverDemoBuilder(srv.booted.services) }))
      expect((await mcpCall(srv, ekey.body.key, 'get_overview', {})).status).toBe(401)
    } finally {
      await srv.close()
    }
  }, 240_000)

  it('(d) a reviewer session connects an AI and does nothing else', async () => {
    const srv = await startServer(ON)
    try {
      await victimWorld(srv) // a real workspace on the same server
      const r = await reviewer(srv)
      const db = srv.booted.services.db
      const conn = await asTest(() => db.selectFrom('connections').select('id').where('workspace_id', '=', r.demoWs).executeTakeFirstOrThrow())
      const entity = await asTest(() => db.selectFrom('entities').select('id').where('workspace_id', '=', r.demoWs).where('kind', '=', 'company').executeTakeFirstOrThrow())
      const memberCount = async () => (await asTest(() => db.selectFrom('memberships').select('id').where('workspace_id', '=', r.demoWs).execute())).length
      const members = await memberCount()

      // Sensitive actions, all inside the window: refused (403), and nothing happened.
      const attempts: Array<[string, string, unknown?]> = [
        ['POST', '/api/export', {}],
        ['POST', '/api/export', { format: 'beancount' }],
        ['DELETE', '/api/workspace', { confirm: 'DELETE' }],
        ['DELETE', '/api/me', { confirm: 'DELETE' }],
        ['POST', '/api/people', { email: 'friend@b.example', role: 'owner', entityIds: 'all' }],
        ['PATCH', `/api/people/${r.personId}`, { role: 'owner' }],
        ['POST', '/api/workspaces', { companyName: 'Real Co' }],
        ['POST', '/api/demo', {}],
        ['DELETE', '/api/demo'],
        ['POST', '/api/connectors/plaid/start', { entityId: entity.id }],
        ['POST', '/api/connectors/stripe/finish', { state: 'x', apiKey: 'sk_test_x' }],
        ['POST', `/api/connections/${conn.id}/disconnect`, { deleteData: true }],
        ['POST', `/api/connections/${conn.id}/reconnect`, {}],
        ['PUT', `/api/inbound/${entity.id}`, { allowedSenders: ['@evil.example'] }],
        ['POST', `/api/inbound/${entity.id}/rotate`, {}],
        ['POST', '/api/ai/pause-all', { paused: true }],
        ['POST', '/v1/control/pause', {}],
        ['GET', '/api/auth/passkey/generate-register-options'],
        ['POST', '/api/auth/passkey/verify-registration', {}],
        ['POST', '/api/auth/change-email', { newEmail: 'me@b.example' }],
        ['POST', '/api/auth/update-user', { name: 'x' }],
        ['POST', '/api/auth/delete-user', {}],
        ['GET', '/api/auth/list-accounts'],
        ['POST', '/api/auth/link-social', { provider: 'google' }],
        ['POST', '/api/auth/passkey/', {}],
        ['DELETE', '/api/workspace/', { confirm: 'DELETE' }],
      ]
      const bad: string[] = []
      for (const [method, path, body] of attempts) {
        const res = await r.send<{ message?: string }>(method, path, body)
        // 404 is fine only for a trailing-slash variant that matches no route at all.
        if (res.status !== 403 && res.status !== 401 && !(res.status === 404 && path.endsWith('/'))) bad.push(`${method} ${path}: ${res.status} ${JSON.stringify(res.body).slice(0, 100)}`)
      }
      expect(bad).toEqual([])
      expect((await r.get('/api/me')).status).toBe(200) // still signed in: the account wasn't deleted
      expect(await memberCount()).toBe(members)
      const conns = await asTest(() => db.selectFrom('connections').select(['status']).where('workspace_id', '=', r.demoWs).execute())
      expect(conns.every((c) => c.status !== 'disconnected')).toBe(true)
      const passkeys = (await asTest(() => (db as unknown as AnyDb).selectFrom('passkey').selectAll().execute())) as unknown[]
      expect(passkeys).toEqual([])

      // The one thing the window is for: an AI connection (agent key or OAuth consent), in the demo only.
      const key = await r.post<{ grantId: string }>('/api/ai/keys', { name: 'Reviewer key', shape: keyShape({ write: false, dataTypes: ['balances'] }) })
      expect(key.status).toBe(201)
      // Widening it afterwards is a second re-check, which a reviewer never passes.
      const widen = await r.send('PATCH', `/api/ai/${key.body.grantId}`, { shape: keyShape() })
      expect(widen.status).toBe(403)
      const widenCtl = await r.send('PATCH', `/v1/control/grants/${key.body.grantId}`, { shape: { entity_ids: 'all', data_types: ['balances', 'transactions'], write: true, expires_at: READ_WRITE_ALL.expiresAt } })
      expect(widenCtl.status).toBe(403)

      // Long after sign-in (changed 2026-10-27: OpenAI's review failed on "sign in again"), connecting an AI still works,
      // and still only into the demo workspace; widening stays refused.
      await asTest(() => db.updateTable('reauth_events').set({ at: new Date(Date.now() - 11 * 60_000).toISOString() }).where('person_id', '=', r.personId).execute())
      const late = await r.post<{ grantId: string }>('/api/ai/keys', { name: 'Late key', shape: keyShape({ write: false, dataTypes: ['balances'] }) })
      expect(late.status).toBe(201)
      expect((await r.post('/api/ai/consent', { clientId: 'late', clientName: 'Late', shape: { entityIds: 'all', dataTypes: ['balances'], write: false, reviewMode: 'instant', expiresAt: null } })).status).toBe(200)
      const grantWs = (await asTest(() => (db as unknown as AnyDb).selectFrom('grants').select(['workspace_id']).where('person_id', '=', r.personId).execute())) as Array<{ workspace_id: string }>
      expect(grantWs.length).toBeGreaterThan(0)
      expect(grantWs.every((g) => g.workspace_id === r.demoWs)).toBe(true)
      expect((await r.send('PATCH', `/api/ai/${late.body.grantId}`, { shape: keyShape() })).status).toBe(403)
      // The victim was never involved.
      expect(leaks(await r.get('/api/workspace'))).toBeNull()
    } finally {
      await srv.close()
    }
  }, 240_000)
})
