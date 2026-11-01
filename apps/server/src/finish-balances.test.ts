// The "Which company is each account?" step shows each account's real balance right after connecting.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Connector } from '@agfn/contracts'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { MemoryFileStore } from '@agfn/files'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { ledgerFor } from './modules.ts'

const BASE = 'http://localhost:8787'
let booted: Booted
let app: ReturnType<typeof createApp>
let outbox: string[]

const bank = (): Connector => ({
  describe: () => ({ key: 'fakebank', name: 'Fake Bank', group: 'banks', provides: ['balances'], freshness: 'instant', auth: 'api_key' }),
  connect: async () => ({ secret: { k: 1 }, config: {} }),
  health: async () => ({ status: 'ok' }),
  sync: async (conn) => ({
    events: [
      { type: 'account.upsert', externalId: 'a1', connectionId: conn.id, name: 'Operating', accountType: 'depository', currency: 'USD', mask: '0001', institution: 'Fake', businessHint: 'business' },
      { type: 'balance.snapshot', externalId: 'a1:bal1', connectionId: conn.id, accountExternalId: 'a1', at: '2026-10-09T00:00:00Z', current: { minor: 11000, currency: 'USD' } },
      { type: 'balance.snapshot', externalId: 'a1:bal2', connectionId: conn.id, accountExternalId: 'a1', at: '2026-10-10T00:00:00Z', current: { minor: 4320000, currency: 'USD' } },
    ],
    cursor: null,
    hasMore: false,
  }),
})

beforeEach(async () => {
  outbox = []
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push(m.text) }, connectors: [bank as never], fileStore: new MemoryFileStore(), ledger: (h) => ledgerFor(h.db) as never })
  app = createApp(booted.services)
})
afterEach(() => booted.shutdown())

describe('POST /api/connectors/:key/finish', () => {
  it('returns each account’s latest balance from the first sync', async () => {
    await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: 'f@example.com', callbackURL: '/' }) })
    const link = outbox.at(-1)!.match(/https?:\/\/\S+/)![0]
    const cookie = (await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify(body) })
    await post('/api/workspaces', { companyName: 'Acme' })
    const db = booted.services.db
    const p = await db.selectFrom('people').select(['id', 'auth_user_id']).executeTakeFirstOrThrow()
    const anyDb = db as unknown as import('kysely').Kysely<Record<string, Record<string, unknown>>>
    await anyDb.insertInto('passkey').values({ id: 'pk', name: 'Mac', publicKey: 'x', userId: p.auth_user_id, credentialID: 'c', counter: 0, deviceType: 'singleDevice', backedUp: 0, transports: 'internal', createdAt: new Date().toISOString() }).execute()
    await db.insertInto('reauth_events').values({ id: 're', person_id: p.id, method: 'passkey', at: new Date().toISOString() }).execute()
    const start = (await (await post('/api/connectors/fakebank/start', { entityId: null })).json()) as { state: string }
    const fin = (await (await post('/api/connectors/fakebank/finish', { state: start.state, apiKey: 'x' })).json()) as { accounts: Array<{ name: string; balance: { minor: number } | null }> }
    expect(fin.accounts).toEqual([expect.objectContaining({ name: 'Operating', balance: { minor: 4320000, currency: 'USD' } })])
  })
})
