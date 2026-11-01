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

describe('MCP OAuth flow', () => {
  it('registers a client, signs in, binds a grant, and issues an audience-bound token with grant_id', async () => {
    const auth = createAuth(cfg)
    const call = (path: string, init: RequestInit = {}) =>
      auth.handler(new Request(path.startsWith('http') ? path : BASE + path, { ...init, headers: { origin: BASE, ...(init.headers ?? {}) } }))

    // 1. Dynamic client registration (what Claude does on first connect).
    const reg = await call('/api/auth/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'openid offline_access finance:read records:write' }),
    })
    expect(reg.status).toBeLessThan(300)
    const client = (await reg.json()) as { client_id: string }

    // 2. Person signs in (magic link).
    const jar = cookieJar()
    await call('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'f@x.com', callbackURL: '/' }) })
    const verify = await call(outbox[0]!.text.match(/https?:\/\/\S+/)![0])
    jar.take(verify)

    // 3. Authorize with PKCE + resource indicator.
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      scope: 'openid offline_access finance:read records:write',
      state: 'st1',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: `${BASE}/mcp`,
    })
    const authz = await call(`/api/auth/oauth2/authorize?${q}`, { headers: { cookie: jar.header() } })
    const loc1 = authz.headers.get('location') ?? ''
    // Not chosen yet → our control-sentence page.
    expect(loc1).toContain('/#/connect-ai/consent')

    // 4. The consent page creates the grant (S7) and continues.
    const session = await auth.api.getSession({ headers: new Headers({ cookie: jar.header() }) })
    const personRow = await h.db.selectFrom('people').select('id').executeTakeFirstOrThrow()
    await pending.set(session!.session.id, client.client_id, personRow.id, 'grant_123')
    const oauthQuery = loc1.includes('?') ? loc1.slice(loc1.indexOf('?') + 1) : q.toString()
    const cont = await call('/api/auth/oauth2/continue', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: jar.header() },
      body: JSON.stringify({ postLogin: true, oauth_query: oauthQuery }),
    })
    let body = (await cont.json()) as { url?: string; redirect?: boolean }
    let next = body.url ?? cont.headers.get('location') ?? ''
    // A consent screen may follow; accept it (the control sentence was the real consent).
    if (next.includes('/#/connect-ai/consent')) {
      const consent = await call('/api/auth/oauth2/consent', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: jar.header() },
        body: JSON.stringify({ accept: true, oauth_query: next.slice(next.indexOf('?') + 1) }),
      })
      body = (await consent.json()) as { url?: string }
      next = body.url ?? consent.headers.get('location') ?? ''
    }
    expect(next).toContain('https://claude.ai/api/mcp/auth_callback')
    const code = new URL(next).searchParams.get('code')!
    expect(new URL(next).searchParams.get('state')).toBe('st1')

    // 5. Token exchange.
    const tok = await call('/api/auth/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', client_id: client.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }),
    })
    const tokens = (await tok.json()) as { access_token: string; refresh_token?: string; token_type: string }
    expect(tok.status).toBe(200)
    expect(tokens.refresh_token).toBeTruthy()
    const payload = JSON.parse(Buffer.from(tokens.access_token.split('.')[1]!, 'base64url').toString())
    expect(payload.grant_id).toBe('grant_123')
    expect([payload.aud].flat()).toContain(`${BASE}/mcp`)
    expect(String(payload.scope)).toContain('finance:read')

    // 6. The MCP side verifies it (signature, issuer, audience, live grant, same person).
    const person = await h.db.selectFrom('people').select('id').executeTakeFirstOrThrow()
    let revoked: string | null = null
    const tokenVerifier = createMcpTokenVerifier({
      db: h.db,
      issuer: BASE,
      getJwks: () => auth.api.getJwks() as never,
      getGrant: async (id) => (id === 'grant_123' ? { workspaceId: 'ws1', personId: person.id, revokedAt: revoked, expiresAt: null, clientName: 'Claude' } : null),
    })
    const v = await tokenVerifier.verifyAccessToken(tokens.access_token, `${BASE}/mcp`)
    expect(v).toMatchObject({ grantId: 'grant_123', personId: person.id, workspaceId: 'ws1', clientName: 'Claude' })
    expect(v!.scopes).toContain('records:write')
    expect(await tokenVerifier.verifyAccessToken(tokens.access_token, `${BASE}/other`)).toBeNull()
    expect(await tokenVerifier.verifyAccessToken(tokens.access_token.slice(0, -2) + 'xx', `${BASE}/mcp`)).toBeNull()
    revoked = new Date().toISOString()
    expect(await tokenVerifier.verifyAccessToken(tokens.access_token, `${BASE}/mcp`)).toBeNull()

    // Sign-in by magic link was recorded as a re-check; it is not a passkey.
    const reauth = createReauth(h.db)
    expect(await reauth.requireRecentAuth(person.id, 60_000)).toBe(true)
    expect(await reauth.requireRecentPasskey(person.id, 60_000)).toBe(false)
  })
})
