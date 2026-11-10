import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Connector } from '@agfn/contracts'
import { ConnectorError, type ConnectorDeps } from '@agfn/connector-sdk'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { MemoryFileStore } from '@agfn/files'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'

const BASE = 'http://localhost:8787'
const STORE = 'abc123'
let booted: Booted
let app: ReturnType<typeof createApp>
let outbox: string[]
let connects: Array<Record<string, unknown>>
let installer: string | null

// A BigCommerce-shaped connector: the app's checks are faked (the real ones are tested in the connector package). A
// signed payload here is "jwt:<store>:<email>"; anything else fails to verify.
const fakeBigCommerce = (_deps: ConnectorDeps): Connector & Record<string, unknown> => ({
  describe: () => ({ key: 'bigcommerce', name: 'BigCommerce', group: 'payments', provides: ['reports'], freshness: 'hours', auth: 'api_key' }),
  app: {
    clientId: 'client-test',
    exchange: async (q: Record<string, string | undefined>) => {
      if (q.scope?.includes('write')) throw new ConnectorError('permanent', 'This BigCommerce install granted Aggregate permission to change the store.', { provider: 'bigcommerce', forUser: true })
      if (q.code !== 'good') throw new Error('bad code')
      return { secret: { storeHash: STORE, accessToken: 'tok_from_install' }, userEmail: installer }
    },
    verify: (jwt: string) => {
      const m = /^jwt:([a-z0-9]+):(.*)$/.exec(jwt)
      if (!m) throw new Error('bad signature')
      return { storeHash: m[1]!, userEmail: m[2] || null, ownerEmail: m[2] || null }
    },
  },
  connect: async (input: Record<string, unknown>) => {
    connects.push(input)
    return { secret: input.adopt, config: { storeHash: (input.adopt as { storeHash: string }).storeHash, via: 'app', displayName: 'BigCommerce' } }
  },
  health: async () => ({ status: 'ok' }),
  sync: async () => ({ events: [], cursor: null, hasMore: false }),
})

beforeEach(async () => {
  outbox = []
  connects = []
  installer = 'owner@example.com'
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push(m.text) }, connectors: [fakeBigCommerce as never], fileStore: new MemoryFileStore() })
  app = createApp(booted.services)
})
afterEach(() => booted.shutdown())

async function signIn(email: string): Promise<string> {
  await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
  const link = outbox.at(-1)!.match(/https?:\/\/\S+/)![0]
  const res = await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}
const post = (cookie: string, body: unknown = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify(body) })
const cookieOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
const pendingRows = () => (booted.services.db as never as import('kysely').Kysely<{ bigcommerce_pending_installs: { store_hash: string; secret_enc: string; link_hash: string | null } }>).selectFrom('bigcommerce_pending_installs').select(['store_hash', 'secret_enc', 'link_hash']).execute()
const install = (scope = 'store_v2_orders_read_only store_v2_information_read_only') => app.request(`/api/connectors/bigcommerce/auth?code=good&scope=${encodeURIComponent(scope)}&context=stores/${STORE}`)
const linkIn = async (res: Response) => (/href="([^"]+\/link\?t=[^"]+)"/.exec(await res.text())?.[1] ?? '').replace(BASE, '')

async function workspace(email: string) {
  const session = await signIn(email)
  await app.request('/api/workspaces', post(session, { companyName: 'Harbor Goods' }))
  return session
}
const liveConnections = () => booted.services.db.selectFrom('connections').select(['id', 'status', 'config_json', 'secret_enc']).where('connector_key', '=', 'bigcommerce').execute()

describe('BigCommerce single-click app (BigCommerce installs; a one-time link picks the workspace)', () => {
  it('install: keeps the token sealed, offers a one-time link that survives sign-in, and attaches the store', async () => {
    const res = await install()
    expect(res.status).toBe(200)
    // Framed by BigCommerce's control panel only, and no script.
    expect(res.headers.get('content-security-policy')).toContain('frame-ancestors https://*.bigcommerce.com https://*.mybigcommerce.com')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    const html = await res.text()
    // Support on every framed page (Marketplace requirement); external links open a new tab.
    expect(html).toContain('mailto:support@aggregate.finance')
    expect(html).toMatch(/href="[^"]+\/link\?t=[^"]+" target="_blank" rel="noopener"/)
    const link = (/href="([^"]+\/link\?t=[^"]+)"/.exec(html)?.[1] ?? '').replace(BASE, '')
    expect(link).toMatch(/^\/api\/connectors\/bigcommerce\/link\?t=[A-Za-z0-9_-]{43}$/)
    const rows = await pendingRows()
    expect(rows).toEqual([{ store_hash: STORE, secret_enc: expect.any(String), link_hash: expect.any(String) }])
    expect(rows[0]!.secret_enc).not.toContain('tok_from_install')

    const opened = await app.request(link)
    expect(opened.headers.get('location')).toBe('/#/?signin_email=owner%40example.com&signin_for=bigcommerce')
    const pending = cookieOf(opened)
    expect(pending).toMatch(/^agfn_bigcommerce_link=/)
    const session = await workspace('owner@example.com')
    const cookie = `${session}; ${pending}`
    const me = (await (await app.request('/api/me', { headers: { origin: BASE, cookie } })).json()) as { pendingInstall?: string }
    expect(me.pendingInstall).toBe('bigcommerce')

    const done = await app.request('/api/connectors/bigcommerce/install/resume', { headers: { origin: BASE, cookie } })
    expect(done.headers.get('location')).toMatch(/^\/#\/\?d=connection:/)
    expect(connects).toEqual([expect.objectContaining({ adopt: { storeHash: STORE, accessToken: 'tok_from_install' } })])
    const conns = await liveConnections()
    expect(conns).toHaveLength(1)
    expect(conns[0]!.status).not.toBe('disconnected')
    expect(await pendingRows()).toEqual([])
    // The link was one-time.
    const again = await app.request('/api/connectors/bigcommerce/install/resume', { headers: { origin: BASE, cookie } })
    expect(decodeURIComponent(again.headers.get('location') ?? '')).toContain('expired or was already used')
  })

  it('the link only works for the installer’s email, and stays usable for them', async () => {
    const link = await linkIn(await install())
    const pending = cookieOf(await app.request(link))
    const other = await workspace('someone@else.test')
    const wrong = await app.request('/api/connectors/bigcommerce/install/resume', { headers: { origin: BASE, cookie: `${other}; ${pending}` } })
    expect(decodeURIComponent(wrong.headers.get('location') ?? '')).toContain('the email you use for this BigCommerce store (o•••@example.com)')
    expect(await liveConnections()).toEqual([])
    const right = await workspace('owner@example.com')
    const done = await app.request('/api/connectors/bigcommerce/install/resume', { headers: { origin: BASE, cookie: `${right}; ${pending}` } })
    expect(done.headers.get('location')).toMatch(/connection:/)
  })

  it('refuses an install that could write, keeps nothing, and says why', async () => {
    const res = await install('store_v2_orders store_v2_information_read_only write')
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('permission to change the store')
    expect(await pendingRows()).toEqual([])
  })

  it('an install where BigCommerce names nobody keeps the token but offers no link', async () => {
    installer = null
    const body = await (await install()).text()
    expect(body).toContain('didn’t say who installed it')
    expect(body).not.toContain('/link?t=')
    expect(await pendingRows()).toHaveLength(1)
  })

  it('load: refuses an unsigned payload, offers a fresh link while waiting, and says connected once linked', async () => {
    expect((await app.request('/api/connectors/bigcommerce/load?signed_payload_jwt=forged')).status).toBe(401)
    await install()
    const waiting = await app.request(`/api/connectors/bigcommerce/load?signed_payload_jwt=${encodeURIComponent(`jwt:${STORE}:owner@example.com`)}`)
    const link = await linkIn(waiting)
    expect(link).toMatch(/link\?t=/)
    const session = await workspace('owner@example.com')
    await app.request('/api/connectors/bigcommerce/install/resume', { headers: { origin: BASE, cookie: `${session}; ${cookieOf(await app.request(link))}` } })
    const connected = await app.request(`/api/connectors/bigcommerce/load?signed_payload_jwt=${encodeURIComponent(`jwt:${STORE}:owner@example.com`)}`)
    expect(await connected.text()).toContain('This store is connected to Aggregate.')
    // Another store, never installed: no link to offer.
    const unknown = await app.request(`/api/connectors/bigcommerce/load?signed_payload_jwt=${encodeURIComponent('jwt:zzz999:owner@example.com')}`)
    expect(await unknown.text()).toContain('install it again')
  })

  it('uninstall: refuses an unsigned call; otherwise ends the connection, deletes its secret and the waiting token', async () => {
    const link = await linkIn(await install())
    const session = await workspace('owner@example.com')
    await app.request('/api/connectors/bigcommerce/install/resume', { headers: { origin: BASE, cookie: `${session}; ${cookieOf(await app.request(link))}` } })
    await install()
    expect(await pendingRows()).toHaveLength(1)
    expect((await app.request('/api/connectors/bigcommerce/uninstall?signed_payload_jwt=forged')).status).toBe(401)
    expect((await liveConnections())[0]!.status).not.toBe('disconnected')
    const res = await app.request(`/api/connectors/bigcommerce/uninstall?signed_payload_jwt=${encodeURIComponent(`jwt:${STORE}:owner@example.com`)}`)
    expect(res.status).toBe(200)
    const [conn] = await liveConnections()
    expect(conn).toMatchObject({ status: 'disconnected', secret_enc: null })
    expect(await pendingRows()).toEqual([])
  })

  it('remove_user answers a signed call and refuses an unsigned one', async () => {
    expect((await app.request(`/api/connectors/bigcommerce/remove_user?signed_payload_jwt=${encodeURIComponent(`jwt:${STORE}:a@b.test`)}`)).status).toBe(200)
    expect((await app.request('/api/connectors/bigcommerce/remove_user')).status).toBe(401)
  })
})
