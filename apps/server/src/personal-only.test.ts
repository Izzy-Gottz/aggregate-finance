// Individuals sign up without a company ("No company? Just my own money"): POST /api/workspaces with no companyName
// makes a Personal-only workspace. Everything else works on it: AI keys (with Personal ticked), whoami, the overview,
// a write and its undo, adding a company later. Run on SQLite and on Postgres with row-level security on.
import { afterEach, describe, expect, it } from 'vitest'
import type { Kysely } from 'kysely'
import { AI_DISCLOSURE } from '@agfn/contracts'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { connectPglite, ensureAppRole, exclusivePool, migrateToLatest, rlsPool, withBypass, type CoreTables } from '@agfn/db'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { loadInstalledModules } from './modules.ts'

const BASE = 'http://localhost:8787'
let booted: Booted | undefined
afterEach(async () => {
  delete process.env.AGFN_PG_RLS
  await booted?.shutdown()
  booted = undefined
})

async function start(kind: 'sqlite' | 'postgres-rls') {
  const outbox: Array<{ to: string; text: string }> = []
  let db: Awaited<ReturnType<typeof connectPglite<CoreTables>>> | undefined
  if (kind === 'postgres-rls') {
    process.env.AGFN_PG_RLS = '1'
    db = await connectPglite<CoreTables>({ wrapPool: (p) => rlsPool(exclusivePool(p), { role: 'agfn_app' }) })
    await withBypass('test', async () => {
      await migrateToLatest(db!.db)
      await ensureAppRole(db!.db as Kysely<any>)
    })
  }
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: db ? 'postgres://unused' : 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  booted = await boot({ config, ...(db ? { db } : {}), keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push({ to: m.to, text: m.text }) }, ...(await loadInstalledModules({})) })
  const app = createApp(booted.services)
  async function signIn(email: string): Promise<string> {
    await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
    const link = outbox.filter((m) => m.to === email).at(-1)!.text.match(/https?:\/\/\S+/)![0]
    return (await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  }
  const req = (cookie: string, method: string, body?: unknown) => ({ method, headers: { 'content-type': 'application/json', origin: BASE, cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const mcp = async (key: string, name: string, args: Record<string, unknown> = {}) => {
    const res = await app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
    const text = await res.text()
    const line = text.split('\n').find((l) => l.startsWith('data: '))
    const msg = JSON.parse(line ? line.slice(6) : text) as { result: { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> } }
    return { isError: Boolean(msg.result.isError), text: msg.result.content[0]!.text, data: msg.result.structuredContent ?? {} }
  }
  const shape = (dataTypes: string[], write: boolean) => ({ entityIds: 'all', dataTypes, write, reviewMode: 'instant', dailyWriteCap: 20, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() })
  return { app, signIn, req, mcp, shape }
}

describe.each(['sqlite', 'postgres-rls'] as const)('a Personal-only workspace (%s)', (kind) => {
  it('signs up with no company, works with AI keys, and can add a company later', async () => {
    const t = await start(kind)
    const me = await t.signIn('solo@example.com')
    // A blank name is a typo, not "no company".
    expect((await t.app.request('/api/workspaces', t.req(me, 'POST', { companyName: '  ' }))).status).toBe(422)
    const made = await t.app.request('/api/workspaces', t.req(me, 'POST', {}))
    expect(made.status, await made.clone().text()).toBe(201)
    const ids = (await made.json()) as { workspaceId: string; companyId: string | null; personalId: string }
    expect(ids.companyId).toBeNull()
    expect(ids.personalId).toBeTruthy()
    const profile = (await (await t.app.request('/api/me', { headers: { cookie: me } })).json()) as { workspaceId: string; needsOnboarding?: boolean }
    expect(profile.workspaceId).toBe(ids.workspaceId)
    expect(profile.needsOnboarding).toBeFalsy()
    const ws = (await (await t.app.request('/api/workspace', { headers: { cookie: me } })).json()) as { entities: Array<{ kind: string; name: string }> }
    expect(ws.entities.map((e) => [e.kind, e.name])).toEqual([['personal', 'Personal']])

    // An AI key with Personal ticked sees and writes Personal.
    const keyRes = await t.app.request('/api/ai/keys', t.req(me, 'POST', { name: 'My assistant', shape: t.shape(['balances', 'transactions', 'personal'], true) }))
    expect(keyRes.status, await keyRes.clone().text()).toBeLessThan(300)
    const { key } = (await keyRes.json()) as { key: string }
    const who = await t.mcp(key, 'whoami')
    expect(who.isError).toBe(false)
    expect(who.text).toMatch(/Personal/)
    expect((who.data.companies as Array<{ name: string; kind: string }>).map((c) => [c.kind, c.name])).toEqual([['personal', 'Personal']])
    const ov = await t.mcp(key, 'get_overview')
    expect(ov.isError, ov.text).toBe(false)
    expect((ov.data.companies as Array<{ company: string }>).map((c) => c.company)).toEqual(['Personal'])
    const wrote = await t.mcp(key, 'add_entry', { company: 'Personal', kind: 'expense', amount: { amount: '12.50', currency: 'USD' }, date: '2026-10-11', paid_by: 'Personal', description: 'Lunch', idempotency_key: 'solo-lunch-1' })
    expect(wrote.isError, wrote.text).toBe(false)
    expect(wrote.data.status).toBe('applied')
    expect((await t.mcp(key, 'search_transactions', { company: 'Personal' })).text).toMatch(/1 transaction/)

    // A key without Personal sees nothing here, and says so plainly instead of failing.
    const narrow = (await (await t.app.request('/api/ai/keys', t.req(me, 'POST', { name: 'Narrow', shape: t.shape(['balances', 'transactions'], false) }))).json()) as { key: string }
    const whoNarrow = await t.mcp(narrow.key, 'whoami')
    expect(whoNarrow.isError).toBe(false)
    expect(whoNarrow.data.companies).toEqual([])
    const ovNarrow = await t.mcp(narrow.key, 'get_overview')
    expect(ovNarrow.text).not.toMatch(/12\.50|Lunch/)

    // The key screen's disclosure: the current version is recorded on the grant; a page showing an older one is refused.
    const current = await t.app.request('/api/ai/keys', t.req(me, 'POST', { name: 'Shown', shape: t.shape(['balances'], false), disclosureVersion: AI_DISCLOSURE.version }))
    expect(current.status, await current.clone().text()).toBe(201)
    const stale = await t.app.request('/api/ai/keys', t.req(me, 'POST', { name: 'Stale', shape: t.shape(['balances'], false), disclosureVersion: '2020-01-01' }))
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ error: 'consent_outdated', message: expect.stringMatching(/Reload this page/) })

    // A company can still be added later.
    expect((await t.app.request('/api/entities', t.req(me, 'POST', { name: 'Side Project LLC' }))).status).toBe(201)
    const after = (await (await t.app.request('/api/workspace', { headers: { cookie: me } })).json()) as { entities: Array<{ kind: string }> }
    expect(after.entities.map((e) => e.kind).sort()).toEqual(['company', 'personal'])
  }, 120_000)
})
