// Deleting an account or workspace needs a fresh "it's you". Someone who only signs in by email must be able to give
// it (an emailed link), not be sent to a passkey prompt that can never succeed.
import { afterEach, describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { newId } from '@agfn/db'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'

const BASE = 'http://localhost:8787'
let booted: Booted | undefined
afterEach(async () => {
  await booted?.shutdown()
  booted = undefined
})

async function start() {
  const outbox: Array<{ to: string; text: string }> = []
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push({ to: m.to, text: m.text }) } })
  const app = createApp(booted.services)
  const db = booted.handle.db
  const open = async (link: string) => (await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  async function signIn(email: string): Promise<string> {
    await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
    return open(outbox.filter((m) => m.to === email).at(-1)!.text.match(/https?:\/\/\S+/)![0])
  }
  const req = (cookie: string, method: string, body?: unknown) => ({ method, headers: { 'content-type': 'application/json', origin: BASE, cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  /** Make every sign-in so far older than the 10-minute window. */
  const age = () => db.updateTable('reauth_events').set({ at: new Date(Date.now() - 11 * 60_000).toISOString() }).execute()
  return { app, db, outbox, open, signIn, req, age }
}

const linkIn = (text: string) => text.match(/https?:\/\/\S+\/recheck\/\S+/)![0]

describe('re-check before deleting', () => {
  it('email-only: the 403 says email, the one-time link is the re-check, and the account can then be deleted', async () => {
    const t = await start()
    const cookie = await t.signIn('links-only@example.com')
    await t.age()
    const refused = await t.app.request('/api/me', t.req(cookie, 'DELETE', { confirm: 'DELETE' }))
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ error: 'recheck', method: 'email' })

    const sent = await t.app.request('/api/recheck/email', t.req(cookie, 'POST', { returnTo: '/#/settings?d=delete' }))
    expect(await sent.json()).toEqual({ ok: true, sentTo: 'links-only@example.com', expiresInMinutes: 10 })
    const opened = await t.app.request(linkIn(t.outbox.at(-1)!.text).replace(BASE, '')) // any device, no session needed
    expect(opened.status).toBe(302)
    expect(opened.headers.get('location')).toBe('/#/settings?d=delete') // back to where they were
    // The same session, now re-checked.
    expect((await t.app.request('/api/me', t.req(cookie, 'DELETE', { confirm: 'DELETE' }))).status).toBe(200)
  })

  it('passkey on another device: the email link is the fallback, counts as a passkey check, and is logged', async () => {
    const t = await start()
    const cookie = await t.signIn('has-passkey@example.com')
    await t.app.request('/api/workspaces', t.req(cookie, 'POST', { companyName: 'Acme' }))
    const person = await t.db.selectFrom('people').select(['id', 'auth_user_id']).where('email', '=', 'has-passkey@example.com').executeTakeFirstOrThrow()
    await (t.db as any).insertInto('passkey').values({ id: newId(), userId: person.auth_user_id, publicKey: 'pk', credentialID: newId(), counter: 0, deviceType: 'singleDevice', backedUp: false, createdAt: new Date().toISOString() }).execute()
    await t.age()
    const refused = await t.app.request('/api/me', t.req(cookie, 'DELETE', { confirm: 'DELETE' }))
    expect(await refused.json()).toMatchObject({ error: 'recheck', method: 'passkey', fallback: 'email' })
    // A plain email sign-in still doesn't stand in for the passkey…
    expect(await booted!.services.reauth.requireRecentPasskey(person.id, 600_000)).toBe(false)
    // …the explicit one-time link does: connecting an account, AI access and deleting all accept it.
    await t.app.request('/api/recheck/email', t.req(cookie, 'POST', {}))
    await t.app.request(linkIn(t.outbox.at(-1)!.text).replace(BASE, ''))
    expect(await booted!.services.reauth.requireRecentPasskey(person.id, 600_000)).toBe(true)
    const ws = (await (await t.app.request('/api/me', { headers: { cookie } })).json()) as { workspaceId: string }
    const log = await (t.db as any).selectFrom('activity_log').select(['action', 'detail']).where('workspace_id', '=', ws.workspaceId).where('action', '=', 'recheck.email_link').execute()
    expect(log).toHaveLength(1)
  })

  it('email-only owner: invite, change someone, and export everything take the emailed link too', async () => {
    const t = await start()
    const cookie = await t.signIn('owner-links@example.com')
    await t.app.request('/api/workspaces', t.req(cookie, 'POST', { companyName: 'Acme' }))
    const invite = () => t.app.request('/api/people', t.req(cookie, 'POST', { email: 'accountant@example.com', role: 'accountant', entityIds: 'all' }))
    const exportAll = () => t.app.request('/api/export', t.req(cookie, 'POST', {}))
    await t.age()
    for (const r of [await invite(), await exportAll()]) {
      expect(r.status).toBe(403)
      expect(await r.json()).toMatchObject({ error: 'recheck', method: 'email', fallback: 'email' })
    }
    await t.app.request('/api/recheck/email', t.req(cookie, 'POST', { returnTo: '/#/settings' }))
    await t.app.request(linkIn(t.outbox.filter((m) => m.to === 'owner-links@example.com').at(-1)!.text).replace(BASE, ''))
    const invited = await invite()
    expect(invited.status).toBe(201)
    const { id } = (await invited.json()) as { id: string }
    expect((await t.app.request(`/api/people/${id}`, t.req(cookie, 'PATCH', { role: 'investor' }))).status).toBe(200)
    expect((await exportAll()).status).toBe(200)
    // Ten minutes later it's asked again.
    await t.age()
    expect((await t.app.request(`/api/people/${id}`, t.req(cookie, 'PATCH', { role: 'accountant' }))).status).toBe(403)
  })

  it('a used or expired link is refused', async () => {
    const t = await start()
    const cookie = await t.signIn('once@example.com')
    await t.app.request('/api/recheck/email', t.req(cookie, 'POST', {}))
    const link = linkIn(t.outbox.at(-1)!.text).replace(BASE, '')
    expect((await t.app.request(link)).status).toBe(302)
    expect((await t.app.request(link)).status).toBe(410) // once only
    await t.app.request('/api/recheck/email', t.req(cookie, 'POST', {}))
    const late = linkIn(t.outbox.at(-1)!.text).replace(BASE, '')
    await t.db.updateTable('recheck_links').set({ expires_at: new Date(Date.now() - 1000).toISOString() }).where('used_at', 'is', null).execute()
    expect((await t.app.request(late)).status).toBe(410)
    expect((await t.app.request('/recheck/not-a-real-token')).status).toBe(410)
  })

  it('the link only ever returns into this app, and is rate-limited', async () => {
    const t = await start()
    const cookie = await t.signIn('limits@example.com')
    for (const evil of ['https://evil.example/', '//evil.example/x', '/\\evil.example']) {
      await t.app.request('/api/recheck/email', t.req(cookie, 'POST', { returnTo: evil }))
      const res = await t.app.request(linkIn(t.outbox.at(-1)!.text).replace(BASE, ''))
      expect(res.headers.get('location')).toBe('/#/')
    }
    let last = 0
    for (let i = 0; i < 4; i++) last = (await t.app.request('/api/recheck/email', t.req(cookie, 'POST', {}))).status
    expect(last).toBe(429)
  })

  it('re-check emails have their own limit, say the real wait, and leave sign-in by email working', async () => {
    const t = await start()
    const cookie = await t.signIn('often@example.com')
    for (let i = 0; i < 3; i++) expect((await t.app.request('/api/recheck/email', t.req(cookie, 'POST', {}))).status).toBe(200)
    const over = await t.app.request('/api/recheck/email', t.req(cookie, 'POST', {}))
    expect(over.status).toBe(429)
    const body = (await over.json()) as { message: string; retryAfter: number }
    expect(body.message).toMatch(/^Too many emails\. Try again (in a minute|in about \d+ minutes?)\.$/)
    expect(body.retryAfter).toBeGreaterThan(0)
    expect(over.headers.get('retry-after')).toBe(String(body.retryAfter))
    // Signing in by email still works (it used to share the 5-per-15-minutes sign-in limit).
    const signIn = await t.app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: 'often@example.com', callbackURL: '/' }) })
    expect(signIn.status).toBe(200)
  })
})
