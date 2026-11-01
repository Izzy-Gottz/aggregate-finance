// The 6-digit code next to every sign-in and re-check link (email-codes.ts): the link opened in another browser, so the
// browser that asked types the code instead. Works only in that browser, once, within 10 minutes, 5 tries.
import { afterEach, describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
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
  const cookiesOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(';')[0]!).filter((c) => !c.endsWith('='))
  const last = (to: string) => outbox.filter((m) => m.to === to).at(-1)!.text
  const codeIn = (text: string) => text.match(/\n(\d{3} \d{3})\n/)![1]!
  const linkIn = (text: string) => text.match(/https?:\/\/\S+/)![0]
  /** Browser A asks for a sign-in email; returns its cookie jar (the nonce). */
  async function ask(email: string): Promise<string> {
    const res = await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
    expect(res.status).toBe(200)
    return cookiesOf(res).join('; ')
  }
  const enter = (jar: string, code: string) => app.request('/api/signin/code', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, ...(jar ? { cookie: jar } : {}) }, body: JSON.stringify({ code }) })
  const me = async (jar: string) => (await app.request('/api/me', { headers: { cookie: jar } })).status
  return { app, outbox, last, codeIn, linkIn, ask, enter, me, cookiesOf }
}

describe('sign-in code', () => {
  it('the browser that asked signs in with the code; another browser can’t use it; the link is then spent', async () => {
    const t = await start()
    const jarA = await t.ask('two-browsers@example.com')
    const mail = t.last('two-browsers@example.com')
    expect(mail).toMatch(/Type this code on the page where you asked to sign in/)
    const code = t.codeIn(mail)
    // Browser B (no nonce cookie) can't use the code, and that costs no try.
    expect((await t.enter('', code)).status).toBe(410)
    // A types it wrong once, then right (spaces are fine).
    const wrong = await t.enter(jarA, code === '000000' ? '111111' : '000000')
    expect(wrong.status).toBe(400)
    expect(await wrong.json()).toMatchObject({ error: 'wrong_code', triesLeft: 4 })
    const ok = await t.enter(jarA, code)
    expect(ok.status, await ok.clone().text()).toBe(200)
    const session = t.cookiesOf(ok).join('; ')
    expect(session).toMatch(/session_token/)
    expect(await t.me(session)).toBe(200)
    // Once only, and the emailed link no longer signs anyone in.
    expect((await t.enter(jarA, code)).status).toBe(410)
    const late = await t.app.request(t.linkIn(mail).replace(BASE, ''), { headers: { origin: BASE } })
    expect(t.cookiesOf(late).some((c) => c.includes('session_token'))).toBe(false)
  })

  it('opening the link first spends the code', async () => {
    const t = await start()
    const jarA = await t.ask('link-first@example.com')
    const mail = t.last('link-first@example.com')
    const opened = await t.app.request(t.linkIn(mail).replace(BASE, ''), { headers: { origin: BASE } })
    expect(t.cookiesOf(opened).some((c) => c.includes('session_token'))).toBe(true)
    expect((await t.enter(jarA, t.codeIn(mail))).status).toBe(410)
  })

  it('red team: guessing is capped at 5 tries per email, then even the right code is refused', async () => {
    const t = await start()
    const jarA = await t.ask('brute@example.com')
    const code = t.codeIn(t.last('brute@example.com'))
    const guesses = ['000000', '111111', '222222', '333333', '444444', '555555'].filter((g) => g !== code).slice(0, 5)
    const statuses: number[] = []
    for (const g of guesses) statuses.push((await t.enter(jarA, g)).status)
    expect(statuses).toEqual([400, 400, 400, 400, 429])
    expect((await t.enter(jarA, code)).status).toBe(410)
    // Junk input counts as a try and never matches.
    const jar2 = await t.ask('brute@example.com')
    expect((await t.enter(jar2, '12345')).status).toBe(400)
    expect((await t.enter(jar2, "' or 1=1 --")).status).toBe(400)
    // A different browser's nonce never reaches this email's code.
    const other = await t.ask('someone-else@example.com')
    expect((await t.enter(other, t.codeIn(t.last('brute@example.com')))).status).toBe(400)
  })

  it('invite emails (no waiting page) carry no code', async () => {
    const t = await start()
    const jar = await t.ask('owner@example.com')
    const session = t.cookiesOf(await t.enter(jar, t.codeIn(t.last('owner@example.com')))).join('; ')
    await t.app.request('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie: session }, body: JSON.stringify({ companyName: 'Acme' }) })
    await t.app.request('/api/people', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie: session }, body: JSON.stringify({ email: 'invitee@example.com', role: 'finance', entityIds: 'all' }) })
    const invite = t.outbox.filter((m) => m.to === 'invitee@example.com').at(-1)
    if (invite) expect(invite.text).not.toMatch(/\n\d{3} \d{3}\n/)
  })
})

describe('re-check code', () => {
  it('the code from the re-check email confirms it’s you where you were asked; 5 tries', async () => {
    const t = await start()
    const jar = await t.ask('recheck@example.com')
    const session = t.cookiesOf(await t.enter(jar, t.codeIn(t.last('recheck@example.com')))).join('; ')
    const req = (method: string, body?: unknown) => ({ method, headers: { 'content-type': 'application/json', origin: BASE, cookie: session }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    await booted!.handle.db.updateTable('reauth_events').set({ at: new Date(Date.now() - 11 * 60_000).toISOString() }).execute()
    expect((await t.app.request('/api/me', req('DELETE', { confirm: 'DELETE' }))).status).toBe(403)

    await t.app.request('/api/recheck/email', req('POST', {}))
    const mail = t.last('recheck@example.com')
    expect(mail).toMatch(/Or type this code where you were asked to confirm/)
    const code = t.codeIn(mail)
    expect((await t.app.request('/api/recheck/code', req('POST', { code: code === '999999' ? '888888' : '999999' }))).status).toBe(400)
    expect((await t.app.request('/api/recheck/code', req('POST', { code }))).status).toBe(200)
    expect((await t.app.request('/api/recheck/code', req('POST', { code }))).status).toBe(410) // once
    expect((await t.app.request('/api/me', req('DELETE', { confirm: 'DELETE' }))).status).toBe(200)
  })

  it('red team: 5 wrong re-check codes spend that email', async () => {
    const t = await start()
    const jar = await t.ask('recheck-brute@example.com')
    const session = t.cookiesOf(await t.enter(jar, t.codeIn(t.last('recheck-brute@example.com')))).join('; ')
    const post = (code: string) => t.app.request('/api/recheck/code', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie: session }, body: JSON.stringify({ code }) })
    await t.app.request('/api/recheck/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie: session }, body: '{}' })
    const code = t.codeIn(t.last('recheck-brute@example.com'))
    const guesses = ['000000', '111111', '222222', '333333', '444444', '555555'].filter((g) => g !== code).slice(0, 5)
    const statuses: number[] = []
    for (const g of guesses) statuses.push((await post(g)).status)
    expect(statuses).toEqual([400, 400, 400, 400, 429])
    expect((await post(code)).status).toBe(410)
  })
})
