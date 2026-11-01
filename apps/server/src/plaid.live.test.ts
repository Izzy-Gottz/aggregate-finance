// Live Plaid SANDBOX run through the real server routes (opt-in: AGFN_LIVE_TESTS=1). Keys come from the environment or
// the main checkout's git-ignored .env; they are never printed. Two sandbox personas, so nothing is tuned to one shape.
//   AGFN_LIVE_TESTS=1 npx vitest run apps/server/src/plaid.live.test.ts

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPlaidConnector } from '@agfn/connector-plaid'
import { plaidFromEnv } from '@agfn/connector-registry'
import { generateMasterKey, loadKeyRing, unseal } from '@agfn/security'
import { SECRET_PURPOSE } from '@agfn/sync'
import { MemoryFileStore } from '@agfn/files'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { ledgerFor } from './modules.ts'

const live = process.env.AGFN_LIVE_TESTS === '1'
if (live && !process.env.PLAID_SECRET) {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()
  const envFile = join(dirname(common), '.env')
  if (existsSync(envFile)) process.loadEnvFile(envFile)
}
const ready = live && !!process.env.PLAID_CLIENT_ID && !!process.env.PLAID_SECRET && (process.env.PLAID_ENV ?? 'sandbox') === 'sandbox'

const BASE = 'http://localhost:8787'
let booted: Booted | undefined
afterEach(async () => {
  await booted?.shutdown()
  booted = undefined
})

/** Connecting accounts needs a passkey and a fresh passkey check (see app.test.ts withPasskey). */
async function withPasskey(db: Booted['services']['db'], email: string): Promise<void> {
  const p = await db.selectFrom('people').select(['id', 'auth_user_id']).where('email', '=', email).executeTakeFirstOrThrow()
  const anyDb = db as unknown as import('kysely').Kysely<Record<string, Record<string, unknown>>>
  await anyDb.insertInto('passkey').values({ id: `pk_${p.id}`, name: 'Mac', publicKey: 'x', userId: p.auth_user_id, credentialID: `cred_${p.id}`, counter: 0, deviceType: 'singleDevice', backedUp: 0, transports: 'internal', createdAt: new Date().toISOString() }).execute()
  await db.insertInto('reauth_events').values({ id: `re_${p.id}`, person_id: p.id, method: 'passkey', at: new Date().toISOString() }).execute()
}

describe.runIf(ready)('plaid sandbox through the server (live)', () => {
  it.each(['user_good', 'user_transactions_dynamic'])('%s: link → exchange → sync → cash, duplicate refused, live balance, reconnect, remove', async (persona) => {
    const env = { PLAID_CLIENT_ID: process.env.PLAID_CLIENT_ID, PLAID_SECRET: process.env.PLAID_SECRET, PLAID_ENV: 'sandbox' }
    const plaidFactory = plaidFromEnv(env)!
    const outbox: string[] = []
    const keys = loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() })
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
    booted = await boot({ config, keys, mailer: { send: async (m) => void outbox.push(m.text) }, connectors: [plaidFactory], ledger: (h) => ledgerFor(h.db), fileStore: new MemoryFileStore() })
    const s = booted.services
    const app = createApp(s)
    const post = (cookie: string, body: unknown = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify(body) })

    await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: `${persona}@example.com`, callbackURL: '/' }) })
    const link = outbox.at(-1)!.match(/https?:\/\/\S+/)![0]
    const cookie = (await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    await withPasskey(s.db, `${persona}@example.com`)
    const ws = (await (await app.request('/api/workspaces', post(cookie, { companyName: 'Testco' }))).json()) as { workspaceId: string; companyId: string }

    // Link: the server makes a real link token; the sandbox stands in for the Link UI.
    const start = (await (await app.request('/api/connectors/plaid/start', post(cookie, { entityId: ws.companyId }))).json()) as { kind: string; linkToken: string; state: string }
    expect(start).toMatchObject({ kind: 'plaid_link', linkToken: expect.stringMatching(/^link-sandbox-/) })
    const direct = createPlaidConnector({ clientId: env.PLAID_CLIENT_ID!, secret: env.PLAID_SECRET!, env: 'sandbox' }, { raw: { put: async () => '' } })
    const publicToken = await direct.sandboxPublicToken('ins_109508', ['transactions'], { username: persona })
    const institution = { institution_id: 'ins_109508', name: 'First Platypus Bank' }
    const fin = await app.request('/api/connectors/plaid/finish', post(cookie, { state: start.state, publicToken, institution, accounts: [], linkSessionId: 'live-test' }))
    expect(fin.status).toBe(200)
    const { connectionId, accounts } = (await fin.json()) as { connectionId: string; accounts: Array<{ id: string; mask?: string }> }
    expect(accounts.length).toBeGreaterThan(0)
    await app.request('/api/accounts/assign', post(cookie, { assignments: accounts.map((a) => ({ accountId: a.id, entityId: ws.companyId })) }))

    // Transactions arrive a few seconds after linking in the sandbox; sync until they're posted.
    let txns = 0
    for (let i = 0; i < 15 && txns === 0; i++) {
      await s.sync.sync(connectionId)
      txns = Number((await s.db.selectFrom('raw_records').select(({ fn }) => fn.countAll<number>().as('n')).where('connection_id', '=', connectionId).where('kind', '=', 'plaid.transaction').executeTakeFirstOrThrow()).n)
      if (txns === 0) await new Promise((r) => setTimeout(r, 3000))
    }
    expect(txns).toBeGreaterThan(0)
    const cash = await s.ledger.metric('cash', { workspaceId: ws.workspaceId, entityIds: [ws.companyId] })
    expect(cash.value).not.toBeNull()

    // The same login again is refused before any exchange.
    const start2 = (await (await app.request('/api/connectors/plaid/start', post(cookie, {}))).json()) as { state: string }
    const dup = await app.request('/api/connectors/plaid/finish', post(cookie, { state: start2.state, publicToken: 'unused', institution, accounts: accounts.map((a) => ({ mask: a.mask })) }))
    expect(dup.status).toBe(409)
    expect(await dup.json()).toMatchObject({ error: 'duplicate' })

    // Live balance on request, then the cooldown.
    expect(await (await app.request(`/api/connections/${connectionId}/refresh-balance`, post(cookie))).json()).toMatchObject({ live: true })
    expect(await (await app.request(`/api/connections/${connectionId}/refresh-balance`, post(cookie))).json()).toMatchObject({ live: false, reason: 'cooldown' })

    // Break the login: the next sync marks it, and Reconnect is update mode on the same Item.
    const row = await s.db.selectFrom('connections').select(['secret_enc', 'workspace_id']).where('id', '=', connectionId).executeTakeFirstOrThrow()
    const secret = unseal(keys, row.secret_enc!, { workspaceId: row.workspace_id, recordId: connectionId, purpose: SECRET_PURPOSE }) as { accessToken: string }
    await direct.client.call('/sandbox/item/reset_login', { access_token: secret.accessToken })
    await s.sync.sync(connectionId)
    expect((await s.db.selectFrom('connections').select('status').where('id', '=', connectionId).executeTakeFirstOrThrow()).status).toBe('needs_reauth')
    const re = (await (await app.request(`/api/connections/${connectionId}/reconnect`, post(cookie))).json()) as { kind: string; linkToken: string; state: string }
    expect(re).toMatchObject({ kind: 'plaid_link', linkToken: expect.stringMatching(/^link-sandbox-/) })
    expect((await app.request(`/api/connections/${connectionId}/reconnect/finish`, post(cookie, { state: re.state, linkSessionId: 'live-test-2' }))).status).toBe(200)

    // Disconnect removes the Item at Plaid.
    expect((await app.request(`/api/connections/${connectionId}/disconnect`, post(cookie, { deleteData: false }))).status).toBe(200)
    await expect(direct.client.call('/item/get', { access_token: secret.accessToken })).rejects.toMatchObject({ code: expect.stringMatching(/ITEM_NOT_FOUND|INVALID_ACCESS_TOKEN/) })
  }, 180_000)
})
