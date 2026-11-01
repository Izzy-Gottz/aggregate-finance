import { describe, expect, it, vi } from 'vitest'
import { HttpApi, HttpError, ROUTES } from './http.ts'
import { MockApi } from './mock.ts'

function fakeFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const f = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const r = responses.shift() ?? { status: 200, body: {} }
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status })
  })
  return { f: f as unknown as typeof fetch, calls }
}

describe('HttpApi', () => {
  it('fills params, sends JSON, and returns the view model', async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { id: 'b1', name: 'Rent' } }])
    const api = new HttpApi({ fetch: f })
    const b = await api.bucket('b 1')
    expect(b).toMatchObject({ name: 'Rent' })
    expect(calls[0]!.url).toBe('/api/buckets/b%201')
    expect(calls[0]!.init.method).toBe('GET')
  })
  it('stays in one workspace: sends x-agfn-workspace once it knows it, and follows a newly created one', async () => {
    const { f, calls } = fakeFetch([
      { status: 200, body: { me: { workspaceId: 'ws_a' }, entities: [] } },
      { status: 200, body: { id: 'b1' } },
      { status: 200, body: { workspaceId: 'ws_b', companyId: 'e', personalId: 'p' } },
      { status: 200, body: { id: 'b1' } },
    ])
    const api = new HttpApi({ fetch: f })
    await api.workspace()
    expect((calls[0]!.init.headers as Record<string, string>)['x-agfn-workspace']).toBeUndefined()
    await api.bucket('b1')
    expect((calls[1]!.init.headers as Record<string, string>)['x-agfn-workspace']).toBe('ws_a')
    await api.createWorkspace('Beta')
    await api.bucket('b1')
    expect((calls[3]!.init.headers as Record<string, string>)['x-agfn-workspace']).toBe('ws_b')
  })
  it('a rate-limited sign-in email says to wait, whatever the limiter returns', async () => {
    const { f } = fakeFetch([{ status: 429, body: {} }])
    const api = new HttpApi({ fetch: f })
    expect(await api.signIn('email', 'me@acme.example')).toEqual({ ok: false, message: 'Too many tries. Wait a few minutes, then try again.' })
    // The server's own message wins when it has one (Better Auth's sign-in limiter does).
    const { f: f2 } = fakeFetch([{ status: 429, body: { message: 'Too many emails. Wait a few minutes and try again.' } }])
    expect(await new HttpApi({ fetch: f2 }).signIn('email', 'me@acme.example')).toEqual({ ok: false, message: 'Too many emails. Wait a few minutes and try again.' })
  })
  it('"Which company?" picks become one answer per company, the suggested one first, batched by connection', async () => {
    const { f } = fakeFetch([{ status: 200, body: [{ id: 'which_company:a1', kind: 'whose_money', title: 'Which company is IRA?', detail: '', entityName: '', createdAt: '2026-10-11T00:00:00Z', confirmLabel: 'Assign', pick: { accountId: 'a1', choices: [{ id: 'e1', name: 'Acme' }, { id: 'personal', name: 'Personal' }], suggested: 'personal', connectionId: 'c1' } }] }])
    const [it] = await new HttpApi({ fetch: f }).review()
    expect(it!.answers!.map((a) => a.label)).toEqual(['Personal', 'Acme'])
    expect(it!.answers![1]!.values).toEqual({ companyId: 'e1' })
    expect(it!.batch).toEqual({ key: 'c1:personal', label: 'Personal', values: { companyId: 'personal' } })
    expect(it).not.toHaveProperty('pick')
  })
  it('puts GET bodies in the query string', async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: [] }])
    await new HttpApi({ fetch: f }).searchTransactions('e_acme', 'figma & co')
    expect(calls[0]!.url).toBe('/api/entities/e_acme/transactions?q=figma+%26+co')
  })
  it('adds an idempotency key to writes', async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { status: 'applied' } }])
    await new HttpApi({ fetch: f }).addCash({ entityId: 'e', direction: 'in', amount: { minor: 100, currency: 'USD' }, date: '2026-10-09', counterparty: 'Lee', paidBy: 'company' })
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>
    expect(typeof body.idempotencyKey).toBe('string')
    expect(body.amount).toEqual({ minor: 100, currency: 'USD' })
  })
  it('retries once after a passkey re-check', async () => {
    const { f, calls } = fakeFetch([{ status: 403, body: { error: 'recheck' } }, { status: 200, body: { grantId: 'g', key: 'k' } }])
    const recheck = vi.fn(async () => true)
    const r = await new HttpApi({ fetch: f, recheck }).createKey('Bot', { entityIds: 'all', dataTypes: [], write: false, reviewMode: 'instant', expiresAt: null })
    expect(r.key).toBe('k')
    expect(recheck).toHaveBeenCalledOnce()
    expect(calls).toHaveLength(2)
  })
  for (const method of ['email', 'signin']) {
    it(`never prompts for a passkey when the re-check is by ${method}: the error carries the method for the screen`, async () => {
      const { f, calls } = fakeFetch([{ status: 403, body: { error: 'recheck', method, message: 'Check it’s you.' } }])
      const recheck = vi.fn(async () => true)
      const err = await new HttpApi({ fetch: f, recheck }).createKey('Bot', { entityIds: 'all', dataTypes: [], write: false, reviewMode: 'instant', expiresAt: null }).catch((e: HttpError) => e)
      expect(recheck).not.toHaveBeenCalled()
      expect(calls).toHaveLength(1)
      expect(err).toMatchObject({ status: 403, code: 'recheck', message: 'Check it’s you.', data: { method } })
    })
  }
  it('sets up a first passkey when connecting needs one, then retries', async () => {
    const { f, calls } = fakeFetch([{ status: 403, body: { error: 'passkey_required', message: 'Add a passkey' } }, { status: 200, body: { grantId: 'g', key: 'k' } }])
    const setupPasskey = vi.fn(async () => true)
    await new HttpApi({ fetch: f, setupPasskey }).createKey('Bot', { entityIds: 'all', dataTypes: [], write: false, reviewMode: 'instant', expiresAt: null })
    expect(setupPasskey).toHaveBeenCalledOnce()
    expect(calls).toHaveLength(2)
    const declined = fakeFetch([{ status: 403, body: { error: 'passkey_required', message: 'Add a passkey' } }])
    await expect(new HttpApi({ fetch: declined.f, setupPasskey: async () => false }).createKey('Bot', { entityIds: 'all', dataTypes: [], write: false, reviewMode: 'instant', expiresAt: null })).rejects.toThrow('Add a passkey')
  })
  it('turns 401 into signed out, and errors into plain messages', async () => {
    const onSignedOut = vi.fn()
    const { f } = fakeFetch([{ status: 401 }, { status: 500, body: { message: 'Chase is down. Nothing was changed.' } }])
    const api = new HttpApi({ fetch: f, onSignedOut })
    expect(await api.me()).toBeNull()
    expect(onSignedOut).toHaveBeenCalled()
    await expect(api.workspace()).rejects.toThrow(new HttpError(500, 'Chase is down. Nothing was changed.', undefined, { message: 'Chase is down. Nothing was changed.' }))
  })
  it('lists every route once', () => {
    expect(new Set(ROUTES).size).toBe(ROUTES.length)
  })
})

describe('MockApi', () => {
  it('serves the demo workspace', async () => {
    const api = new MockApi()
    const w = await api.workspace()
    expect(w.entities.map((e) => e.name)).toEqual(['Acme', 'Bluebird Studio', 'Harbor Coffee', 'Personal'])
    expect(w.reviewCount).toBeGreaterThan(0)
    expect(w.ais[0]).not.toHaveProperty('activity')
  })
  it('adds companies before Personal and rejects empty names', async () => {
    const api = new MockApi()
    await api.createCompany('Delta')
    expect((await api.workspace()).entities.map((e) => e.name)).toEqual(['Acme', 'Bluebird Studio', 'Harbor Coffee', 'Delta', 'Personal'])
    expect(() => api.createCompany('  ')).toThrow()
  })
  it('records cash in minor units and offers undo', async () => {
    const api = new MockApi()
    const r = await api.addCash({ entityId: 'e_acme', direction: 'out', amount: { minor: 50000, currency: 'USD' }, date: '2026-10-09', counterparty: 'Designer', paidBy: 'company' })
    expect(r.status).toBe('applied')
    expect(r.undoUntil).toBeTruthy()
    const rows = await api.searchTransactions('e_acme', 'designer')
    expect(rows[0]!.amount).toEqual({ minor: -50000, currency: 'USD' })
  })
  it('undoing an AI-created bucket removes it from the company', async () => {
    const api = new MockApi()
    await api.undo('b_rent')
    const c = await api.company('e_acme')
    expect(c.buckets.map((b) => b.id)).not.toContain('b_rent')
  })
  it('returns copies so screens cannot mutate state by accident', async () => {
    const api = new MockApi()
    const w = await api.workspace()
    w.entities.pop()
    expect((await api.workspace()).entities).toHaveLength(4)
  })
})

describe('HttpApi against the S0 server shapes', () => {
  it('maps magic_link to email and passes needsOnboarding through', async () => {
    const { f } = fakeFetch([{ status: 200, body: { personId: 'p', name: 'Y', email: 'y@x', workspaceId: '', needsOnboarding: true, mcpUrl: '/mcp', selfHosted: true, demo: false, signInMethods: ['passkey', 'magic_link'] } }])
    const me = await new HttpApi({ fetch: f }).me()
    expect(me?.signInMethods).toEqual(['passkey', 'email'])
    expect(me?.needsOnboarding).toBe(true)
  })
  it('first company creates the workspace', async () => {
    const { f, calls } = fakeFetch([{ status: 201, body: { workspaceId: 'w', companyId: 'c', personalId: 'p' } }])
    expect(await new HttpApi({ fetch: f }).createWorkspace('Acme')).toEqual({ workspaceId: 'w', companyId: 'c', personalId: 'p' })
    expect(calls[0]!.url).toBe('/api/workspaces')
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ companyName: 'Acme' })
  })
  it('consent creates the grant, then continues OAuth with the untouched query', async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { grantId: 'g', next: '/api/auth/oauth2/continue' } }, { status: 200, body: { url: 'https://claude.ai/cb?code=1' } }])
    const shape = { entityIds: 'all' as const, dataTypes: [], write: false, reviewMode: 'instant' as const, expiresAt: null }
    const r = await new HttpApi({ fetch: f }).consent({ clientId: 'cl', clientName: 'Claude', shape, oauthQuery: 'client_id=cl&sig=a%2Bb' })
    expect(r.redirectTo).toBe('https://claude.ai/cb?code=1')
    expect(calls[1]!.url).toBe('/api/auth/oauth2/continue')
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ postLogin: true, oauth_query: 'client_id=cl&sig=a%2Bb' })
  })
  it('consent accepts the OAuth consent step when continue points back at the consent page', async () => {
    const { f, calls } = fakeFetch([
      { status: 200, body: { grantId: 'g', next: '/api/auth/oauth2/continue' } },
      { status: 200, body: { redirect: true, url: '/#/connect-ai/consent?client_id=cl&ba_pl=x&sig=s' } },
      { status: 200, body: { url: 'http://127.0.0.1:5000/cb?code=1' } },
    ])
    const shape = { entityIds: 'all' as const, dataTypes: [], write: false, reviewMode: 'instant' as const, expiresAt: null }
    const r = await new HttpApi({ fetch: f }).consent({ clientId: 'cl', clientName: 'Claude', shape, oauthQuery: 'client_id=cl' })
    expect(r.redirectTo).toBe('http://127.0.0.1:5000/cb?code=1')
    expect(calls[2]!.url).toBe('/api/auth/oauth2/consent')
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ accept: true, oauth_query: 'client_id=cl&ba_pl=x&sig=s' })
  })
  it('finish sends the single-use state back', async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { connectionId: 'c', accounts: [] } }])
    await new HttpApi({ fetch: f }).finishConnect('plaid', { state: 's1', publicToken: 'pt', institution: { name: 'Chase' } })
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ state: 's1', publicToken: 'pt', institution: { name: 'Chase' } })
  })
})
