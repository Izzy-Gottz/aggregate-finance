import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { connect, migrateToLatest, type CoreTables, type DbHandle } from '@agfn/db'
import { createAuth, createMcpTokenVerifier, createPendingGrants, createReauth, migrateAuth, type AuthConfig } from './index.ts'

const BASE = 'http://localhost:8787'
let h: DbHandle<CoreTables>
let cfg: AuthConfig
let outbox: Array<{ text: string }>
let pending: ReturnType<typeof createPendingGrants>

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
})
afterEach(() => h.close())

function cookieJar() {
  const jar = new Map<string, string>()
  return {
    take(res: Response) {
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';')
        const [k, v] = pair!.split('=')
        if (v) jar.set(k!, v)
        else jar.delete(k!)
      }
    },
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
  }
}

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'

function setup() {
  const auth = createAuth(cfg)
  const call = (path: string, init: RequestInit = {}) => auth.handler(new Request(path.startsWith('http') ? path : BASE + path, { ...init, headers: { origin: BASE, ...(init.headers ?? {}) } }))
  const register = (redirect_uris: string[]) =>
    call('/api/auth/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
    })
  return { auth, call, register }
}

async function signedIn({ call }: ReturnType<typeof setup>) {
  const jar = cookieJar()
  await call('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'f@x.com', callbackURL: '/' }) })
  jar.take(await call(outbox[0]!.text.match(/https?:\/\/\S+/)![0]))
  return jar
}

function authorizeQuery(clientId: string, redirect: string) {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, scope: 'openid offline_access finance:read records:write', state: 'st1', code_challenge: challenge, code_challenge_method: 'S256', resource: `${BASE}/mcp` })
  return { q, verifier }
}

async function codeFor(s: ReturnType<typeof setup>, clientId: string) {
  const jar = await signedIn(s)
  const { q, verifier } = authorizeQuery(clientId, REDIRECT)
  const authz = await s.call(`/api/auth/oauth2/authorize?${q}`, { headers: { cookie: jar.header() } })
  const loc = authz.headers.get('location') ?? ''
  const session = await s.auth.api.getSession({ headers: new Headers({ cookie: jar.header() }) })
  const person = await h.db.selectFrom('people').select('id').executeTakeFirstOrThrow()
  await pending.set(session!.session.id, clientId, person.id, 'grant_123')
  const cont = await s.call('/api/auth/oauth2/continue', { method: 'POST', headers: { 'content-type': 'application/json', cookie: jar.header() }, body: JSON.stringify({ postLogin: true, oauth_query: loc.slice(loc.indexOf('?') + 1) }) })
  let body = (await cont.json()) as { url?: string }
  let next = body.url ?? cont.headers.get('location') ?? ''
  if (next.includes('/#/connect-ai/consent')) {
    const consent = await s.call('/api/auth/oauth2/consent', { method: 'POST', headers: { 'content-type': 'application/json', cookie: jar.header() }, body: JSON.stringify({ accept: true, oauth_query: next.slice(next.indexOf('?') + 1) }) })
    body = (await consent.json()) as { url?: string }
    next = body.url ?? consent.headers.get('location') ?? ''
  }
  return { code: new URL(next).searchParams.get('code')!, verifier }
}

const token = (s: ReturnType<typeof setup>, params: Record<string, string>) => s.call('/api/auth/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) })

describe('OAuth refusals the MCP spec requires', () => {
  it.each([
    ['a different host', 'https://evil.example/api/mcp/auth_callback'],
    ['a longer path', `${REDIRECT}/extra`],
    ['an added query', `${REDIRECT}?x=1`],
    ['another scheme', REDIRECT.replace('https:', 'http:')],
  ])('authorize never sends a code to %s', async (_name, wrong) => {
    const s = setup()
    const { client_id } = (await (await s.register([REDIRECT])).json()) as { client_id: string }
    const jar = await signedIn(s)
    const r = await s.call(`/api/auth/oauth2/authorize?${authorizeQuery(client_id, wrong).q}`, { headers: { cookie: jar.header() } })
    const loc = r.headers.get('location') ?? ''
    expect(loc.startsWith(wrong)).toBe(false)
    expect(loc).not.toContain('/#/connect-ai/consent')
    expect(loc).not.toContain('code=')
  })

  it('the token endpoint refuses a code with a different redirect_uri', async () => {
    const s = setup()
    const { client_id } = (await (await s.register([REDIRECT])).json()) as { client_id: string }
    const { code, verifier } = await codeFor(s, client_id)
    const r = await token(s, { grant_type: 'authorization_code', code, redirect_uri: `${REDIRECT}/extra`, client_id, code_verifier: verifier, resource: `${BASE}/mcp` })
    expect(r.status).toBeGreaterThanOrEqual(400)
  })

  it('registration refuses a plain http redirect, and allows it only on loopback', async () => {
    const s = setup()
    expect((await s.register(['http://evil.example/cb'])).status).toBe(400)
    expect((await s.register(['http://127.0.0.1:3000/cb'])).status).toBeLessThan(300)
  })

  it('a refresh gives a new refresh token, and the old one stops working', async () => {
    const s = setup()
    const { client_id } = (await (await s.register([REDIRECT])).json()) as { client_id: string }
    const { code, verifier } = await codeFor(s, client_id)
    const first = (await (await token(s, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id, code_verifier: verifier, resource: `${BASE}/mcp` })).json()) as { refresh_token: string }
    const refresh = (t: string) => token(s, { grant_type: 'refresh_token', refresh_token: t, client_id, resource: `${BASE}/mcp` })
    const r = await refresh(first.refresh_token)
    expect(r.status).toBe(200)
    const second = (await r.json()) as { refresh_token: string }
    expect(second.refresh_token).toBeTruthy()
    expect(second.refresh_token).not.toBe(first.refresh_token)
    expect((await refresh(first.refresh_token)).status).toBeGreaterThanOrEqual(400)
    // Replaying a used token ends the family: the newest one goes too.
    expect((await refresh(second.refresh_token)).status).toBeGreaterThanOrEqual(400)
  })
})
