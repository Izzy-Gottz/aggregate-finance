// Etsy, if it's offered again, goes only to the workspaces an operator names (AGFN_ETSY_WORKSPACES), on top of its own
// offer flag. Hosted with no list: nobody sees it. Not in the catalog, refused at start, and left out of
// connect-from-chat for every other workspace. Self-hosted: no limit.
import { afterEach, describe, expect, it } from 'vitest'
import type { Connector } from '@agfn/contracts'
import type { ConnectorDeps } from '@agfn/connector-sdk'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig, notForWorkspace, workspaceList } from './config.ts'

const BASE = 'http://localhost:8787'
const fakeEtsy = (_deps: ConnectorDeps): Connector => ({
  describe: () => ({ key: 'etsy', name: 'Etsy', group: 'payments', provides: ['transactions'], freshness: 'updates every few hours', auth: 'api_key' }),
  connect: async () => ({ secret: { k: 1 }, config: {} }),
  health: async () => ({ status: 'ok' }),
  sync: async () => ({ events: [], cursor: null, hasMore: false }),
})

describe('the setting', () => {
  it('hosted: Etsy is limited to the listed workspaces, nobody when unset; self-hosted: no limit', () => {
    const env = { AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE }
    expect(loadConfig({ ...env, AGFN_HOSTED: '1' }).onlyWorkspaces).toEqual({ etsy: [] })
    expect(loadConfig({ ...env, AGFN_HOSTED: '1', AGFN_ETSY_WORKSPACES: '01JWSAAAAAAAAAAAAAAAAAAAAA, 01JWSBBBBBBBBBBBBBBBBBBBBB' }).onlyWorkspaces).toEqual({ etsy: ['01JWSAAAAAAAAAAAAAAAAAAAAA', '01JWSBBBBBBBBBBBBBBBBBBBBB'] })
    expect(loadConfig(env).onlyWorkspaces).toBeUndefined()
    expect(workspaceList("x, ' or 1=1, 01JWSAAAAAAAAAAAAAAAAAAAAA")).toEqual(['01JWSAAAAAAAAAAAAAAAAAAAAA'])
    expect(notForWorkspace({ onlyWorkspaces: { etsy: ['w_in_list'] } }, 'w_in_list')).toEqual([])
    expect(notForWorkspace({ onlyWorkspaces: { etsy: ['w_in_list'] } }, 'w_other')).toEqual(['etsy'])
    expect(notForWorkspace({ onlyWorkspaces: { etsy: ['w_in_list'] } }, null)).toEqual(['etsy'])
    expect(notForWorkspace({}, 'w_other')).toEqual([])
  })
})

describe('the catalog and connect', () => {
  let booted: Booted
  let outbox: string[]
  afterEach(() => booted?.shutdown())

  async function start(only: Record<string, string[]> | undefined) {
    outbox = []
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false, ...(only ? { onlyWorkspaces: only } : {}) }
    booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push(m.text) }, connectors: [fakeEtsy] })
    const app = createApp(booted.services)
    const signIn = async (email: string) => {
      await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
      const link = outbox.at(-1)!.match(/https?:\/\/\S+/)![0]
      const res = await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })
      const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
      const made = (await (await app.request('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify({ companyName: 'Shop' }) })).json()) as { workspaceId: string }
      return { cookie, ws: made.workspaceId }
    }
    const keys = async (cookie: string) => ((await (await app.request('/api/connectors', { headers: { origin: BASE, cookie } })).json()) as Array<{ key: string }>).map((c) => c.key)
    const startEtsy = (cookie: string) => app.request('/api/connectors/etsy/start', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify({ entityId: null }) })
    return { app, signIn, keys, startEtsy }
  }

  it('an empty list: nobody is offered Etsy, and start is refused', async () => {
    const t = await start({ etsy: [] })
    const a = await t.signIn('a@shop.example')
    expect(await t.keys(a.cookie)).not.toContain('etsy')
    expect((await t.startEtsy(a.cookie)).status).toBe(404)
  })

  it('a listed workspace is offered Etsy; another workspace on the same server is not', async () => {
    const t = await start({ etsy: [] })
    const listed = await t.signIn('listed@shop.example')
    const other = await t.signIn('other@shop.example')
    booted.services.config.onlyWorkspaces = { etsy: [listed.ws] }
    expect(await t.keys(listed.cookie)).toContain('etsy')
    // Past the list (it goes on to the usual checks: here the sign-in re-check), never the "not available" 404.
    expect((await t.startEtsy(listed.cookie)).status).not.toBe(404)
    expect(await t.keys(other.cookie)).not.toContain('etsy')
    expect((await t.startEtsy(other.cookie)).status).toBe(404)
  })

  it('self-hosted (no list): offered as before', async () => {
    const t = await start(undefined)
    const a = await t.signIn('self@shop.example')
    expect(await t.keys(a.cookie)).toContain('etsy')
  })
})
