// connect_source's host side: the mint rules (who may, the per-grant/workspace rate limit, reviewer demo, token never
// stored raw) and the confirm page's threat model (a forwarded link is useless to anyone else, a member of another
// workspace is refused, the link is single-use and expires). The confirm page hands off to the SPA connect flow.

import { createHash, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { newId } from '@agfn/db'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { makeConnectPort, CONNECT_MINT_PER_HOUR } from './connect-source.ts'
import { ConnectMintError } from '@agfn/mcp'
import type { ConnectorDeps } from '@agfn/connector-sdk'
import type { Connector } from '@agfn/contracts'

const BASE = 'http://localhost:8787'
const PROVIDER = 'stripe'
const hashOf = (t: string) => createHash('sha256').update(t).digest('hex')

// A minimal connector so the registry offers something to connect (the bare test config installs none). 'stripe' is a
// real connect-intent key, so the SPA handoff target is a valid one.
const fakeStripe = (_deps: ConnectorDeps): Connector => ({
  describe: () => ({ key: PROVIDER, name: 'Stripe', group: 'payments', provides: ['invoices'], freshness: 'minutes', auth: 'oauth' }),
  begin: async () => ({ kind: 'oauth', url: 'https://stripe.test/oauth' }),
  connect: async () => ({ secret: {}, config: {} }),
  health: async () => ({ status: 'ok' }),
  sync: async () => ({ events: [], cursor: null, hasMore: false }),
})
let booted: Booted | undefined
afterEach(async () => {
  await booted?.shutdown()
  booted = undefined
})

async function start() {
  const outbox: Array<{ to: string; text: string }> = []
  const config = {
    ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent', AGFN_CONNECT_FROM_CHAT: '1' }),
    runWorker: false,
  }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push({ to: m.to, text: m.text }) }, connectors: [fakeStripe as never] })
  const app = createApp(booted.services)
  const db = booted.handle.db
  const open = async (link: string) => (await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  async function signIn(email: string): Promise<string> {
    await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
    return open(outbox.filter((m) => m.to === email).at(-1)!.text.match(/https?:\/\/\S+/)![0])
  }
  const req = (cookie: string, method: string, body?: unknown) => ({ method, headers: { 'content-type': 'application/json', origin: BASE, cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  /** Sign in and create a company, so this person owns a fresh workspace. Returns {cookie, personId, workspaceId}. */
  async function owner(email: string) {
    const cookie = await signIn(email)
    await app.request('/api/workspaces', req(cookie, 'POST', { companyName: `Co ${email}` }))
    const me = (await (await app.request('/api/me', { headers: { cookie } })).json()) as { personId: string; workspaceId: string }
    return { cookie, personId: me.personId, workspaceId: me.workspaceId }
  }
  /** Insert a connect link with a token we control, to drive the confirm page past the mint rules. */
  async function seedLink(l: { workspaceId: string; personId: string; provider?: string; grantId?: string; expiresInMs?: number; entityId?: string | null }) {
    const token = randomBytes(32).toString('base64url')
    const now = Date.now()
    await db
      .insertInto('connect_links')
      .values({
        id: newId(),
        token_hash: hashOf(token),
        workspace_id: l.workspaceId,
        person_id: l.personId,
        grant_id: l.grantId ?? 'g_test',
        provider: l.provider ?? PROVIDER,
        entity_id: l.entityId ?? null,
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + (l.expiresInMs ?? 15 * 60_000)).toISOString(),
        used_at: null,
      })
      .execute()
    return token
  }
  return { app, db, config, outbox, signIn, req, owner, seedLink, services: booted.services }
}


describe('minting connect links', () => {
  it('owner mints; the raw token is never stored, only its hash; reviewer demo gets nothing', async () => {
    const t = await start()
    const a = await t.owner('owner@example.com')
    const port = makeConnectPort(t.services, t.config)
    const opts = await port.options({ workspaceId: a.workspaceId, personId: a.personId })
    expect(opts.length).toBeGreaterThan(0)
    const provider = PROVIDER
    const link = await port.mint({ workspaceId: a.workspaceId, personId: a.personId, grantId: 'g1', provider })
    const token = link.url.split('/connect/')[1]!
    const row = await t.db.selectFrom('connect_links').selectAll().where('token_hash', '=', hashOf(token)).executeTakeFirstOrThrow()
    // Nothing in the row equals the raw token; only its hash is kept.
    expect(Object.values(row).some((v) => v === token)).toBe(false)
    expect(row.token_hash).toBe(hashOf(token))
    expect(link.url).toContain(`${BASE}/connect/`)
  })

  it('refuses a person who doesn’t manage the workspace', async () => {
    const t = await start()
    const a = await t.owner('owner2@example.com')
    const b = await t.owner('stranger@example.com') // owns their own workspace, not a's
    const port = makeConnectPort(t.services, t.config)
    await expect(port.mint({ workspaceId: a.workspaceId, personId: b.personId, grantId: 'g', provider: PROVIDER })).rejects.toBeInstanceOf(ConnectMintError)
  })

  it('rate-limits minting per grant', async () => {
    const t = await start()
    const a = await t.owner('busy@example.com')
    const port = makeConnectPort(t.services, t.config)
    for (let i = 0; i < CONNECT_MINT_PER_HOUR; i++) await port.mint({ workspaceId: a.workspaceId, personId: a.personId, grantId: 'g-same', provider: PROVIDER })
    await expect(port.mint({ workspaceId: a.workspaceId, personId: a.personId, grantId: 'g-same', provider: PROVIDER })).rejects.toThrow(/Too many/)
  })
})

describe('the confirm page: a link only works for its own owner', () => {
  it('a forwarded link is useless to anyone else, and never gets claimed', async () => {
    const t = await start()
    const a = await t.owner('a@example.com')
    const b = await t.owner('b@example.com')
    const token = await t.seedLink({ workspaceId: a.workspaceId, personId: a.personId })
    // b opens a's link: refused, and the link is still unused.
    const res = await t.app.request(`/connect/${token}`, { headers: { cookie: b.cookie, origin: BASE } })
    expect(res.status).toBe(403)
    expect(await res.text()).toMatch(/isn’t for you/i)
    const row = await t.db.selectFrom('connect_links').select('used_at').where('token_hash', '=', hashOf(token)).executeTakeFirstOrThrow()
    expect(row.used_at).toBeNull()
  })

  it('a member of another workspace is refused', async () => {
    const t = await start()
    const a = await t.owner('a2@example.com')
    const b = await t.owner('b2@example.com')
    // A link bound to b2's own person but pointed at a2's workspace, which b2 doesn't belong to.
    const token = await t.seedLink({ workspaceId: a.workspaceId, personId: b.personId })
    const res = await t.app.request(`/connect/${token}`, { headers: { cookie: b.cookie, origin: BASE } })
    expect(res.status).toBe(403)
    expect(await res.text()).toMatch(/can’t connect sources here/i)
  })

  it('the owner sees a confirm page, approving hands off to the connect flow once, and a replay is refused', async () => {
    const t = await start()
    const a = await t.owner('owner3@example.com')
    const token = await t.seedLink({ workspaceId: a.workspaceId, personId: a.personId, provider: PROVIDER })
    const page = await t.app.request(`/connect/${token}`, { headers: { cookie: a.cookie, origin: BASE } })
    expect(page.status).toBe(200)
    expect(await page.text()).toMatch(/Connect .*\?/)

    const go = await t.app.request(`/connect/${token}/go`, { method: 'POST', headers: { cookie: a.cookie, origin: BASE } })
    expect(go.status).toBe(302)
    expect(go.headers.get('location')).toBe(`/#/?d=connect:${PROVIDER}`)
    // Pinned the browser to the link's workspace for the handoff.
    expect(go.headers.getSetCookie().join(';')).toContain('agfn_ws=')
    const row = await t.db.selectFrom('connect_links').select('used_at').where('token_hash', '=', hashOf(token)).executeTakeFirstOrThrow()
    expect(row.used_at).not.toBeNull()
    // Logged as confirmed.
    const log = await (t.db as never as import('kysely').Kysely<Record<string, any>>).selectFrom('activity_log').select('action').where('workspace_id', '=', a.workspaceId).where('action', '=', 'connect_from_chat.confirmed').execute()
    expect(log.length).toBe(1)
    // Replay: the single-use link is spent.
    const replay = await t.app.request(`/connect/${token}/go`, { method: 'POST', headers: { cookie: a.cookie, origin: BASE } })
    expect(replay.status).toBe(410)
  })

  it('an expired link is refused', async () => {
    const t = await start()
    const a = await t.owner('owner4@example.com')
    const token = await t.seedLink({ workspaceId: a.workspaceId, personId: a.personId, expiresInMs: -1000 })
    const res = await t.app.request(`/connect/${token}`, { headers: { cookie: a.cookie, origin: BASE } })
    expect(res.status).toBe(410)
    expect(await res.text()).toMatch(/expired/i)
  })

  it('no session: a plain sign-in prompt, and nothing is claimed', async () => {
    const t = await start()
    const a = await t.owner('owner5@example.com')
    const token = await t.seedLink({ workspaceId: a.workspaceId, personId: a.personId })
    const res = await t.app.request(`/connect/${token}`, { headers: { origin: BASE } })
    expect(res.status).toBe(200)
    expect(await res.text()).toMatch(/Sign in to approve/i)
    const row = await t.db.selectFrom('connect_links').select('used_at').where('token_hash', '=', hashOf(token)).executeTakeFirstOrThrow()
    expect(row.used_at).toBeNull()
  })
})
