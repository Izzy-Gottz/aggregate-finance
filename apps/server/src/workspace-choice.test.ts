// A person in two workspaces (an accountant, an invitee) stays in the one they chose: across reloads, new tabs and a
// provider sending the browser back. Found by 43 on hosted, 2026-10-11.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { createWorkspace } from '@agfn/auth'
import { nowIso } from '@agfn/db'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { mcpFor } from './modules.ts'

const BASE = 'http://localhost:8787'
let booted: Booted
let app: ReturnType<typeof createApp>
let outbox: Array<{ to: string; text: string }>

beforeEach(async () => {
  outbox = []
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push({ to: m.to, text: m.text }) }, mcp: (svc) => mcpFor(svc) })
  app = createApp(booted.services)
})
afterEach(() => booted.shutdown())

async function signIn(email: string): Promise<string> {
  await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
  const link = outbox.filter((m) => m.to === email).at(-1)!.text.match(/https?:\/\/\S+/)![0]
  const res = await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}
const get = (path: string, cookie: string, headers: Record<string, string> = {}) => app.request(path, { headers: { origin: BASE, cookie, ...headers } })
const cookieFrom = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(';')[0]

async function twoWorkspaces() {
  const session = await signIn('accountant@example.com')
  await app.request('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie: session }, body: JSON.stringify({ companyName: 'Own Books' }) })
  const db = booted.handle.db
  const person = await db.selectFrom('people').select('id').where('email', '=', 'accountant@example.com').executeTakeFirstOrThrow()
  const first = (await (await get('/api/me', session)).json()) as { workspaceId: string }
  const client = await createWorkspace(db, { personId: person.id, workspaceName: 'Client', firstCompanyName: 'Client Co' })
  return { session, first: first.workspaceId, client: client.workspaceId, db }
}

describe('choosing a workspace', () => {
  it('lists every workspace in /api/me and remembers the chosen one for requests without the header', async () => {
    const t = await twoWorkspaces()
    const me = (await (await get('/api/me', t.session)).json()) as { workspaces: Array<{ id: string; name: string; role: string }> }
    expect(me.workspaces.map((w) => w.id).sort()).toEqual([t.first, t.client].sort())
    expect(me.workspaces.find((w) => w.id === t.client)).toMatchObject({ name: 'Client', role: 'owner' })

    const chose = await get('/api/me', t.session, { 'x-agfn-workspace': t.client })
    expect(((await chose.json()) as { workspaceId: string }).workspaceId).toBe(t.client)
    const remembered = cookieFrom(chose, 'agfn_ws')
    expect(remembered).toBe(`agfn_ws=${t.client}`)
    expect(chose.headers.getSetCookie().find((c) => c.startsWith('agfn_ws='))).toMatch(/HttpOnly/i)

    // A reload or a new tab (no header): still the client's workspace.
    const reload = (await (await get('/api/me', `${t.session}; ${remembered}`)).json()) as { workspaceId: string }
    expect(reload.workspaceId).toBe(t.client)
  })

  it('never lets the header or the cookie reach a workspace the person isn’t in', async () => {
    const t = await twoWorkspaces()
    const other = await signIn('stranger@example.com')
    await app.request('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie: other }, body: JSON.stringify({ companyName: 'Not Yours' }) })
    const theirs = ((await (await get('/api/me', other)).json()) as { workspaceId: string }).workspaceId
    for (const r of [await get('/api/me', t.session, { 'x-agfn-workspace': theirs }), await get('/api/me', `${t.session}; agfn_ws=${theirs}`)]) {
      const me = (await r.json()) as { workspaceId: string; workspaces: Array<{ id: string }> }
      expect(me.workspaceId).not.toBe(theirs)
      expect(me.workspaces.map((w) => w.id)).not.toContain(theirs)
    }
  })

  it('a provider sending the browser back lands in the workspace the connect started in', async () => {
    const t = await twoWorkspaces()
    // A connect started in the client's workspace (from onboarding there); the browser comes back with no header and
    // no cookie, where it would otherwise land in the first workspace.
    await t.db.insertInto('settings').values({ workspace_id: t.client, key: 'connect_state:abc123', value_json: JSON.stringify({ key: 'stripe', personId: 'x', entityId: null, at: Date.now(), returnTo: '/onboarding' }), updated_at: nowIso() }).execute()
    const back = await get('/api/connectors/stripe/callback?state=abc123&error=access_denied', t.session)
    expect(back.status).toBe(302)
    expect(back.headers.get('location')).toMatch(/^\/#\/onboarding\?connect_error=access_denied/)
  })
})
