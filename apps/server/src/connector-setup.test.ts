import { afterEach, describe, expect, it } from 'vitest'
import type { ConnectorDescription } from '@agfn/contracts'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { MemoryFileStore } from '@agfn/files'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'

const BASE = 'https://books.example.com'
let booted: Booted | undefined
afterEach(() => booted?.shutdown())

async function start(extra: Record<string, string> = {}) {
  const outbox: string[] = []
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent', ...extra }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push(m.text) }, connectors: [], fileStore: new MemoryFileStore() })
  const app = createApp(booted.services)
  await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: 'self@example.com', callbackURL: '/' }) })
  const link = outbox.at(-1)!.match(/https?:\/\/\S+/)![0]
  const cookie = (await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  return { app, cookie }
}

describe('setup guides for app-based connectors (self-hosted)', () => {
  it('lists unconfigured ones with steps, env names and this server’s redirect URI; connecting says not_configured', async () => {
    const { app, cookie } = await start()
    const list = (await (await app.request('/api/connectors', { headers: { origin: BASE, cookie } })).json()) as ConnectorDescription[]
    const qb = list.find((d) => d.key === 'quickbooks')
    expect(qb?.setup).toMatchObject({
      configured: false,
      kind: 'app',
      register: { name: 'Intuit Developer', url: expect.stringContaining('developer.intuit.com') },
      redirectUri: `${BASE}/api/connectors/quickbooks/callback`,
      env: ['QUICKBOOKS_CLIENT_ID', 'QUICKBOOKS_CLIENT_SECRET', 'QUICKBOOKS_ENV'],
    })
    expect(qb?.setup?.steps?.length).toBeGreaterThanOrEqual(3)
    expect(list.find((d) => d.key === 'plaid')?.setup?.redirectUri).toBe(`${BASE}/connect/plaid/oauth`)
    expect(list.map((d) => d.key)).toEqual(expect.arrayContaining(['xero', 'finch', 'justworks']))

    await app.request('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify({ companyName: 'Acme' }) })
    const res = await app.request('/api/connectors/quickbooks/start', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: '{}' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'not_configured' })
    expect((await app.request('/api/connectors/nope/start', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: '{}' })).status).toBe(404)
  })

  it('the hosted service hides them', async () => {
    const { app, cookie } = await start({ AGFN_HOSTED: '1' })
    const list = (await (await app.request('/api/connectors', { headers: { origin: BASE, cookie } })).json()) as ConnectorDescription[]
    expect(list.some((d) => d.setup)).toBe(false)
  })
})

describe('the setup docs page (same guides as the app and agfn doctor)', () => {
  it('self-hosted: this server’s redirect URIs, steps, env names, status, and anchors the app’s docsUrl points at', async () => {
    const { app, cookie } = await start()
    const list = (await (await app.request('/api/connectors', { headers: { origin: BASE, cookie } })).json()) as ConnectorDescription[]
    expect(list.find((d) => d.key === 'xero')?.setup?.docsUrl).toBe(`${BASE}/docs/connector-setup#xero`)
    const res = await app.request('/docs/connector-setup')
    expect(res.status).toBe(200)
    const html = await res.text()
    for (const key of ['plaid', 'quickbooks', 'xero', 'finch', 'justworks', 'stripe', 'square', 'shopify']) expect(html).toContain(`id="${key}"`)
    expect(html).toContain(`${BASE}/api/connectors/quickbooks/callback`)
    expect(html).toContain(`${BASE}/connect/plaid/oauth`)
    expect(html).toContain('QUICKBOOKS_CLIENT_ID=…')
    expect(html).toContain('Not set up on this server yet.')
    expect(html).toContain(list.find((d) => d.key === 'quickbooks')!.setup!.steps![0]!.replace('&', '&amp;'))
    expect(html).not.toContain('{#')
  })

  it('hosted: a placeholder address instead of ours, and no per-server status', async () => {
    const { app } = await start({ AGFN_HOSTED: '1' })
    const html = await (await app.request('/docs/connector-setup')).text()
    expect(html).toContain('https://your-server.example/api/connectors/xero/callback')
    expect(html).not.toContain(BASE)
    expect(html).not.toContain('on this server yet')
  })
})
