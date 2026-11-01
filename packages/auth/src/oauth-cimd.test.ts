// Client ID Metadata Documents (AGFN_OAUTH_CIMD=1): an AI client's client_id is an https URL whose JSON describes it.
// Off by default; when on, dynamic registration (what Claude and ChatGPT use today) is unchanged.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { connect, migrateToLatest, type CoreTables, type DbHandle } from '@agfn/db'
import { createAuth, createPendingGrants, migrateAuth, oauthProviderAuthServerMetadata, type AuthConfig } from './index.ts'

const BASE = 'http://localhost:8787'
const CLIENT_ID = 'https://client.example/oauth/client.json'
const REDIRECT = 'https://client.example/callback'
let h: DbHandle<CoreTables>
let cfg: AuthConfig
let outbox: Array<{ text: string }>
let pending: ReturnType<typeof createPendingGrants>
let fetched: string[]
let doc: Record<string, unknown>

beforeEach(async () => {
  h = connect<CoreTables>('sqlite::memory:')
  await migrateToLatest(h.db)
  outbox = []
  fetched = []
  doc = { client_id: CLIENT_ID, client_name: 'Example AI', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }
  pending = createPendingGrants(h.db)
  cfg = {
    db: h.db,
    dbKind: h.kind,
    baseUrl: BASE,
    secret: 'test-secret-test-secret-test-secret-1234',
    mailer: { send: async (m) => void outbox.push(m) },
    mcpResources: [`${BASE}/mcp`],
    pendingGrant: (sid, clientId, o) => pending.get(sid, clientId, o),
    cimd: {
      fetch: async (input) => {
        const url = String(input instanceof Request ? input.url : input)
        fetched.push(url)
        if (url !== CLIENT_ID) return new Response('not found', { status: 404 })
        return new Response(JSON.stringify(doc), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'max-age=3600' } })
      },
    },
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

async function signedIn(auth: ReturnType<typeof createAuth>) {
  const call = (path: string, init: RequestInit = {}) =>
    auth.handler(new Request(path.startsWith('http') ? path : BASE + path, { ...init, headers: { origin: BASE, ...(init.headers ?? {}) } }))
  const jar = cookieJar()
  await call('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'f@x.com', callbackURL: '/' }) })
  jar.take(await call(outbox[0]!.text.match(/https?:\/\/\S+/)![0]))
  return { call, jar }
}

function authorizeQuery(overrides: Record<string, string> = {}) {
  const verifier = randomBytes(32).toString('base64url')
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    scope: 'openid offline_access finance:read',
    state: 'st1',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: `${BASE}/mcp`,
    ...overrides,
  })
  return { q, verifier }
}

describe('Client ID Metadata Documents', () => {
  it('advertises support, fetches the document, and completes the flow with a URL client_id', async () => {
    const auth = createAuth(cfg)
    const { call, jar } = await signedIn(auth)
    const meta = (await (await oauthProviderAuthServerMetadata(auth)(new Request(`${BASE}/.well-known/oauth-authorization-server`))).json()) as Record<string, unknown>
    expect(meta.client_id_metadata_document_supported).toBe(true)
    expect(meta.registration_endpoint).toBeTruthy()

    const { q, verifier } = authorizeQuery()
    const authz = await call(`/api/auth/oauth2/authorize?${q}`, { headers: { cookie: jar.header() } })
    const loc1 = authz.headers.get('location') ?? ''
    expect(loc1).toContain('/#/connect-ai/consent')
    expect(fetched).toEqual([CLIENT_ID])
    // The consent screen's name lookup finds the discovered client.
    const pub = await call(`/api/auth/oauth2/public-client?client_id=${encodeURIComponent(CLIENT_ID)}`, { headers: { cookie: jar.header() } })
    expect(((await pub.json()) as { client_name?: string }).client_name).toBe('Example AI')

    const session = await auth.api.getSession({ headers: new Headers({ cookie: jar.header() }) })
    const person = await h.db.selectFrom('people').select('id').executeTakeFirstOrThrow()
    await pending.set(session!.session.id, CLIENT_ID, person.id, 'grant_cimd')
    const cont = await call('/api/auth/oauth2/continue', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: jar.header() },
      body: JSON.stringify({ postLogin: true, oauth_query: loc1.slice(loc1.indexOf('?') + 1) }),
    })
    let body = (await cont.json()) as { url?: string }
    let next = body.url ?? cont.headers.get('location') ?? ''
    if (next.includes('/#/connect-ai/consent')) {
      const consent = await call('/api/auth/oauth2/consent', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: jar.header() },
        body: JSON.stringify({ accept: true, oauth_query: next.slice(next.indexOf('?') + 1) }),
      })
      body = (await consent.json()) as { url?: string }
      next = body.url ?? consent.headers.get('location') ?? ''
    }
    expect(next.startsWith(REDIRECT)).toBe(true)
    const code = new URL(next).searchParams.get('code')!

    const tok = await call('/api/auth/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: CLIENT_ID, code_verifier: verifier, resource: `${BASE}/mcp` }),
    })
    expect(tok.status).toBe(200)
    const tokens = (await tok.json()) as { access_token: string }
    const payload = JSON.parse(Buffer.from(tokens.access_token.split('.')[1]!, 'base64url').toString())
    expect(payload.grant_id).toBe('grant_cimd')
    expect([payload.aud].flat()).toContain(`${BASE}/mcp`)
    // Cached: the whole flow fetched the document once.
    expect(fetched).toEqual([CLIENT_ID])
  })

  it('refuses a redirect_uri the document does not list, without redirecting there', async () => {
    const { call, jar } = await signedIn(createAuth(cfg))
    const { q } = authorizeQuery({ redirect_uri: 'https://evil.example/steal' })
    const res = await call(`/api/auth/oauth2/authorize?${q}`, { headers: { cookie: jar.header() } })
    expect(res.headers.get('location') ?? '').not.toContain('evil.example')
    expect(res.status).toBeGreaterThanOrEqual(300)
  })

  it('refuses a document whose client_id is not its own URL', async () => {
    doc = { ...doc, client_id: 'https://other.example/client.json' }
    const { call, jar } = await signedIn(createAuth(cfg))
    const res = await call(`/api/auth/oauth2/authorize?${authorizeQuery().q}`, { headers: { cookie: jar.header() } })
    expect(res.headers.get('location') ?? '').not.toContain('/#/connect-ai/consent')
    expect(await h.db.selectFrom('oauthClient' as never).selectAll().execute()).toEqual([])
  })

  it('never fetches private or loopback client_id URLs', async () => {
    const { call, jar } = await signedIn(createAuth(cfg))
    for (const id of ['https://127.0.0.1/c.json', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/c.json', 'http://client.example/c.json']) {
      const res = await call(`/api/auth/oauth2/authorize?${authorizeQuery({ client_id: id }).q}`, { headers: { cookie: jar.header() } })
      expect(res.headers.get('location') ?? '').not.toContain('/#/connect-ai/consent')
    }
    expect(fetched).toEqual([])
  })

  it('is off unless configured: no metadata flag, URL client_ids are unknown clients, nothing fetched', async () => {
    const { cimd: _, ...plain } = cfg
    const auth = createAuth(plain)
    const { call, jar } = await signedIn(auth)
    const meta = (await (await oauthProviderAuthServerMetadata(auth)(new Request(`${BASE}/.well-known/oauth-authorization-server`))).json()) as Record<string, unknown>
    expect(meta.client_id_metadata_document_supported).toBeUndefined()
    const res = await call(`/api/auth/oauth2/authorize?${authorizeQuery().q}`, { headers: { cookie: jar.header() } })
    expect(res.headers.get('location') ?? '').not.toContain('/#/connect-ai/consent')
    expect(fetched).toEqual([])
  })
})
