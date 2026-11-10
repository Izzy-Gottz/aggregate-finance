// Amazon's log-in URI: after consent Amazon sends the browser here, and it goes back to Amazon with the person's own
// connect state; without a connect started here, the person is sent to start one.
import { afterEach, describe, expect, it } from 'vitest'
import { createAmazonConnector } from '@agfn/connector-amazon'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { MemoryFileStore } from '@agfn/files'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'

const BASE = 'https://books.example.com'
const CALLBACK = 'https://amazon.com/apps/authorize/confirm/amzn1.sellerapps.app.sample'
let booted: Booted | undefined
afterEach(() => booted?.shutdown())

async function start() {
  const outbox: string[] = []
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  const app_ = { appId: 'amzn1.sellerapps.app.sample', clientId: 'c', clientSecret: 's', redirectUri: `${BASE}/api/connectors/amazon/callback` }
  booted = await boot({
    config,
    keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }),
    mailer: { send: async (m) => void outbox.push(m.text) },
    connectors: [(deps) => createAmazonConnector({ app: app_, draft: true }, deps)],
    fileStore: new MemoryFileStore(),
  })
  const app = createApp(booted.services)
  await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: 'owner@example.com', callbackURL: '/' }) })
  const link = outbox.at(-1)!.match(/https?:\/\/\S+/)![0]
  const cookie = (await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  await app.request('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify({ companyName: 'Acme' }) })
  const login = (q: Record<string, string>) => app.request(`/api/connectors/amazon/login?${new URLSearchParams(q)}`, { headers: { origin: BASE, cookie } })
  const begin = async () => (await (await app.request('/api/connectors/amazon/start', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: '{}' })).json()) as { kind: string; url: string; state: string }
  return { login, begin }
}

describe('Amazon log-in URI', () => {
  it('sends the browser back to Amazon with this person’s connect state and the redirect URI', async () => {
    const { login, begin } = await start()
    const b = await begin()
    expect(new URL(b.url).searchParams.get('state')).toBe(b.state)
    const res = await login({ amazon_callback_uri: CALLBACK, amazon_state: 'amz-st', selling_partner_id: 'A1SAMPLESELLER', version: 'beta' })
    expect(res.status).toBe(302)
    // No referrer reaches Amazon: same-origin sends none off this origin.
    expect(res.headers.get('referrer-policy')).toMatch(/^(same-origin|no-referrer)$/)
    const u = new URL(res.headers.get('location')!)
    expect(u.origin + u.pathname).toBe(CALLBACK)
    expect(Object.fromEntries(u.searchParams)).toEqual({ amazon_state: 'amz-st', state: b.state, redirect_uri: `${BASE}/api/connectors/amazon/callback`, version: 'beta' })
  })

  it('without a connect started here (an Appstore install), says where to start; a callback that isn’t Amazon’s goes nowhere', async () => {
    const { login, begin } = await start()
    const none = await login({ amazon_callback_uri: CALLBACK, amazon_state: 'amz-st' })
    expect(none.status).toBe(302)
    expect(decodeURIComponent(none.headers.get('location')!)).toBe('/#/?connect_error=Start from Aggregate: Connections → Add → Amazon.&connector=amazon')
    await begin()
    const evil = await login({ amazon_callback_uri: 'https://evil.example.com/apps/authorize/confirm/x', amazon_state: 'amz-st' })
    expect(evil.headers.get('location')!.startsWith('/#/?connect_error=')).toBe(true)
  })
})
