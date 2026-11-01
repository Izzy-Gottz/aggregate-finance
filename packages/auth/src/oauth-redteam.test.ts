// Red team: a second AI client in the same browser session must never inherit the first client's grant
// (meridn-43's finding). Pending grants are per (session, client), consumed on accept, and checked against the grant.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { connect, migrateToLatest, nowIso, type CoreTables, type DbHandle } from '@agfn/db'
import { createAuth, createPendingGrants, isNativeRedirect, migrateAuth, type AuthConfig } from './index.ts'

const BASE = 'http://localhost:8787'
let h: DbHandle<CoreTables>
let cfg: AuthConfig
let outbox: Array<{ text: string }>
let pending: ReturnType<typeof createPendingGrants>
let auth: ReturnType<typeof createAuth>

beforeEach(async () => {
  h = connect<CoreTables>('sqlite::memory:')
  await migrateToLatest(h.db)
  outbox = []
  pending = createPendingGrants(h.db)
  cfg = {
    db: h.db,
    dbKind: h.kind,
    baseUrl: BASE,
    secret: 'test-secret-test-secret-test-secret-1234',
    mailer: { send: async (m) => void outbox.push(m) },
    mcpResources: [`${BASE}/mcp`],
    pendingGrant: (sid, clientId, o) => pending.get(sid, clientId, o),
  }
  await migrateAuth(cfg)
  auth = createAuth(cfg)
})
afterEach(() => h.close())

const jar = new Map<string, string>()
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
const call = async (path: string, init: RequestInit = {}) => {
  const res = await auth.handler(new Request(path.startsWith('http') ? path : BASE + path, { ...init, headers: { origin: BASE, cookie: cookie(), ...(init.headers ?? {}) } }))
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';')
    const [k, v] = pair!.split('=')
    if (v) jar.set(k!, v)
    else jar.delete(k!)
  }
  return res
}
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

async function register(name: string): Promise<string> {
  const r = await call('/api/auth/oauth2/register', json({ client_name: name, redirect_uris: [`https://${name.toLowerCase()}.example/cb`], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'], scope: 'openid finance:read' }))
  return ((await r.json()) as { client_id: string }).client_id
}

function authorizeQuery(clientId: string, name: string) {
  const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url')
  return new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: `https://${name.toLowerCase()}.example/cb`, scope: 'openid finance:read', state: 's', code_challenge: challenge, code_challenge_method: 'S256', resource: `${BASE}/mcp` })
}

/** Runs authorize → (continue) → consent accept; returns where the browser ends up. */
async function connectClient(clientId: string, name: string, chooseGrant?: string): Promise<{ first: string; final: string }> {
  const a = await call(`/api/auth/oauth2/authorize?${authorizeQuery(clientId, name)}`)
  const first = a.headers.get('location') ?? ''
  const q = first.slice(first.indexOf('?') + 1)
  if (chooseGrant) {
    const session = await auth.api.getSession({ headers: new Headers({ cookie: cookie() }) })
    const person = await h.db.selectFrom('people').select('id').executeTakeFirstOrThrow()
    await pending.set(session!.session.id, clientId, person.id, chooseGrant)
  }
  const cont = await call('/api/auth/oauth2/continue', json({ postLogin: true, oauth_query: q }))
  let next = ((await cont.json().catch(() => ({}))) as { url?: string }).url ?? cont.headers.get('location') ?? ''
  if (next.includes('/#/connect-ai/consent')) {
    const consent = await call('/api/auth/oauth2/consent', json({ accept: true, oauth_query: next.slice(next.indexOf('?') + 1) }))
    next = ((await consent.json().catch(() => ({}))) as { url?: string }).url ?? consent.headers.get('location') ?? `status ${consent.status}`
  }
  return { first, final: next }
}

async function signIn() {
  jar.clear()
  await call('/api/auth/sign-in/magic-link', json({ email: 'f@x.com', callbackURL: '/' }))
  await call(outbox.at(-1)!.text.match(/https?:\/\/\S+/)![0])
}

describe('red team: pending AI grants are per client', () => {
  it('client B in the same session never gets client A’s grant, even within 15 minutes', async () => {
    const A = await register('Alpha')
    const B = await register('Bravo')
    await signIn()

    // A connects normally with grant G_A.
    const a = await connectClient(A, 'Alpha', 'G_A')
    expect(a.first).toContain('/#/connect-ai/consent') // A had to choose first
    expect(a.final).toMatch(/^https:\/\/alpha\.example\/cb\?code=/)
    // Consumed on accept: nothing is left for anyone to pick up.
    expect(await h.db.selectFrom('oauth_pending_grants').selectAll().execute()).toEqual([])

    // B starts right after, in the same browser session: it must get its own control-sentence step...
    const b1 = await call(`/api/auth/oauth2/authorize?${authorizeQuery(B, 'Bravo')}`)
    expect(b1.headers.get('location')).toContain('/#/connect-ai/consent')
    // ...and pushing straight on to consent without choosing issues no code.
    const b = await connectClient(B, 'Bravo')
    expect(b.final).not.toContain('code=')
  })

  it('a leftover pending grant for A (abandoned flow) is not usable by B', async () => {
    const A = await register('Alpha')
    const B = await register('Bravo')
    await signIn()
    const session = await auth.api.getSession({ headers: new Headers({ cookie: cookie() }) })
    const person = await h.db.selectFrom('people').select('id').executeTakeFirstOrThrow()
    await pending.set(session!.session.id, A, person.id, 'G_A_abandoned')
    const b = await connectClient(B, 'Bravo')
    expect(b.first).toContain('/#/connect-ai/consent')
    expect(b.final).not.toContain('code=')
    // A's row is still A's (B didn't consume it).
    expect(await pending.get(session!.session.id, A)).toBe('G_A_abandoned')
  })

  it('refuses a pending row whose grant was made for a different client', async () => {
    const A = await register('Alpha')
    const B = await register('Bravo')
    await signIn()
    const session = await auth.api.getSession({ headers: new Headers({ cookie: cookie() }) })
    const person = await h.db.selectFrom('people').select('id').executeTakeFirstOrThrow()
    await h.db.insertInto('workspaces').values({ id: 'w', name: 'W', base_currency: 'USD', created_at: nowIso() }).execute()
    await (h.db as never as import('kysely').Kysely<Record<string, Record<string, unknown>>>)
      .insertInto('grants')
      .values({ id: 'G_A', workspace_id: 'w', person_id: person.id, kind: 'oauth', client_id: A, client_name: 'Alpha', entity_ids_json: '"all"', data_types_json: '["balances"]', can_write: 0, review_mode: 'instant', daily_write_cap: 10, expires_at: null, created_at: nowIso(), updated_at: nowIso(), revoked_at: null, revoked_by: null, last_used_at: null })
      .execute()
    // Even if a row somehow points B at A's grant, it is not returned.
    await pending.set(session!.session.id, B, person.id, 'G_A')
    expect(await pending.get(session!.session.id, B)).toBeUndefined()
    const b = await connectClient(B, 'Bravo')
    expect(b.final).not.toContain('code=')
  })
})

describe('dynamic client registration', () => {
  const reg = (body: Record<string, unknown>) => call('/api/auth/oauth2/register', json({ token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'], scope: 'openid finance:read', ...body }))

  it('defaults to native when every redirect is loopback or a custom scheme, and leaves the rest alone', async () => {
    const loop = await reg({ client_name: 'Old SDK', redirect_uris: ['http://127.0.0.1:33418/callback', 'http://localhost:9000/cb'] })
    expect(loop.status, await loop.clone().text()).toBeLessThan(300)
    expect(((await loop.json()) as { application_type?: string }).application_type).toBe('native')
    const web = await reg({ client_name: 'Web', redirect_uris: ['https://app.example/cb'] })
    expect(((await web.json()) as { application_type?: string }).application_type ?? 'web').toBe('web')
    // A web client asking for plain http on a public host is still refused.
    expect((await reg({ client_name: 'Bad', redirect_uris: ['http://evil.example/cb'] })).status).toBeGreaterThanOrEqual(400)
    expect([isNativeRedirect('com.example.app:/oauth'), isNativeRedirect('javascript:alert(1)'), isNativeRedirect('http://10.0.0.1/cb'), isNativeRedirect('http://[::1]:8080/cb')]).toEqual([true, false, false, true])
  })
})
