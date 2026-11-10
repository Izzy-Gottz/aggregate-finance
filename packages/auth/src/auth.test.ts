import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connect, migrateToLatest, type CoreTables, type DbHandle } from '@agfn/db'
import { captureMagicLink, createAuth, migrateAuth, oauthProviderAuthServerMetadata, type AuthConfig } from './index.ts'

let h: DbHandle<CoreTables>
let outbox: Array<{ to: string; text: string }>
let cfg: AuthConfig

beforeEach(async () => {
  h = connect<CoreTables>('sqlite::memory:')
  await migrateToLatest(h.db)
  outbox = []
  cfg = {
    db: h.db,
    dbKind: h.kind,
    baseUrl: 'http://localhost:8787',
    secret: 'test-secret-test-secret-test-secret-1234',
    mailer: { send: async (m) => void outbox.push(m) },
    mcpResources: ['http://localhost:8787/mcp'],
    pendingGrant: async () => undefined,
  }
  await migrateAuth(cfg)
})
afterEach(() => h.close())

describe('auth', () => {
  it('signs in with a magic link and creates a person', async () => {
    const auth = createAuth(cfg)
    const res = await auth.handler(
      new Request('http://localhost:8787/api/auth/sign-in/magic-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:8787' },
        body: JSON.stringify({ email: 'Founder@Example.com', callbackURL: '/' }),
      }),
    )
    expect(res.status).toBe(200)
    expect(outbox).toHaveLength(1)
    const link = outbox[0]!.text.match(/https?:\/\/\S+/)![0]
    const verify = await auth.handler(new Request(link, { headers: { origin: 'http://localhost:8787' } }))
    expect([200, 302]).toContain(verify.status)
    const cookie = verify.headers.get('set-cookie')
    expect(cookie).toMatch(/session_token/)

    const people = await h.db.selectFrom('people').selectAll().execute()
    expect(people).toHaveLength(1)
    expect(people[0]!.email).toBe('founder@example.com')
    expect(people[0]!.auth_user_id).toBeTruthy()

    const session = await auth.api.getSession({ headers: new Headers({ cookie: cookie!.split(';')[0]! }) })
    expect(session?.user.email).toBe('founder@example.com')
  })

  it('refuses a public sign-in for a reserved *.aggregate.invalid address, emailing and leaking no link', async () => {
    const auth = createAuth(cfg)
    for (const email of ['qa-abc@challenge-qa.aggregate.invalid', 'reviewer-abc@reviewers.aggregate.invalid']) {
      const res = await auth.handler(
        new Request('http://localhost:8787/api/auth/sign-in/magic-link', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'http://localhost:8787' },
          body: JSON.stringify({ email, callbackURL: '/' }),
        }),
      )
      expect(res.status, email).toBeGreaterThanOrEqual(400) // refused
      expect((await res.text()).match(/https?:\/\/\S+/), email).toBeNull() // no link in the response
    }
    expect(outbox).toHaveLength(0) // nothing emailed to a reserved address
    expect(await h.db.selectFrom('people').selectAll().execute()).toHaveLength(0) // no account created
  })

  it('hands a reserved-address link only to the in-process captureMagicLink caller, never emailing it', async () => {
    const auth = createAuth(cfg)
    const link = await captureMagicLink(() => auth.api.signInMagicLink({ body: { email: 'qa-def@challenge-qa.aggregate.invalid', callbackURL: '/' }, headers: new Headers({ origin: 'http://localhost:8787' }) }))
    expect(link).toMatch(/token=/) // the operator got the link back
    expect(outbox).toHaveLength(0) // and it was never emailed
    // It is a real, usable sign-in link: verifying it yields a session.
    const verify = await auth.handler(new Request(link!, { headers: { origin: 'http://localhost:8787' } }))
    expect(verify.headers.get('set-cookie')).toMatch(/session_token/)
  })

  it('serves OAuth authorization server metadata for MCP clients', async () => {
    const auth = createAuth(cfg)
    const res = await oauthProviderAuthServerMetadata(auth)(new Request('http://localhost:8787/.well-known/oauth-authorization-server'))
    expect(res.status).toBe(200)
    const meta = (await res.json()) as Record<string, unknown>
    expect(meta.issuer).toBeTruthy()
    expect(meta.registration_endpoint).toBeTruthy()
    expect(meta.code_challenge_methods_supported).toContain('S256')
  })
})
