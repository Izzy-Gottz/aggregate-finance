// Live end-to-end through the real server with Plaid SANDBOX (opt-in, AGFN_LIVE_TESTS=1). Keys come from the main
// checkout's .env and are never printed. Proves: connect a bank → accounts → assign to a company → ledger → cash on Workspace.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { MemoryFileStore } from '@agfn/files'
import { boot } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { loadInstalledModules } from './modules.ts'

const live = process.env.AGFN_LIVE_TESTS === '1'
if (live && !process.env.PLAID_SECRET) {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()
  const envFile = join(dirname(common), '.env')
  if (existsSync(envFile)) process.loadEnvFile(envFile)
}
const ready = live && !!process.env.PLAID_SECRET && (process.env.PLAID_ENV ?? 'sandbox') === 'sandbox'
const BASE = 'http://localhost:8787'

describe.runIf(ready)('live: Plaid sandbox through the whole server', () => {
  it('connects a test bank and shows cash for the company', async () => {
    const outbox: string[] = []
    const env = { PLAID_CLIENT_ID: process.env.PLAID_CLIENT_ID!, PLAID_SECRET: process.env.PLAID_SECRET!, PLAID_ENV: 'sandbox' }
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
    const modules = await loadInstalledModules(env)
    const booted = await boot({ config, ...modules, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push(m.text) }, fileStore: new MemoryFileStore() })
    const app = createApp(booted.services)
    try {
      await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: 'live@example.com', callbackURL: '/' }) })
      const v = await app.request(outbox[0]!.match(/https?:\/\/\S+/)![0].replace(BASE, ''), { headers: { origin: BASE } })
      const cookie = v.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
      const post = (p: string, b: unknown) => app.request(p, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify(b) })
      const ws = (await (await post('/api/workspaces', { companyName: 'Acme' })).json()) as { companyId: string }

      const start = (await (await post('/api/connectors/plaid/start', { entityId: ws.companyId })).json()) as { kind: string; linkToken: string; state: string }
      expect(start.kind).toBe('plaid_link')
      expect(start.linkToken).toMatch(/^link-sandbox-/)

      // What Plaid Link would hand the browser after the person picks a test bank.
      const pt = (await (await fetch('https://sandbox.plaid.com/sandbox/public_token/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, institution_id: 'ins_109508', initial_products: ['transactions'] }),
      })).json()) as { public_token: string }

      const fin = await post('/api/connectors/plaid/finish', { state: start.state, publicToken: pt.public_token, institution: { institution_id: 'ins_109508', name: 'First Platypus Bank' } })
      expect(fin.status).toBe(200)
      const { accounts, connectionId } = (await fin.json()) as { connectionId: string; accounts: Array<{ id: string; name: string }> }
      expect(accounts.length).toBeGreaterThan(0)

      expect((await post('/api/accounts/assign', { assignments: accounts.map((a) => ({ accountId: a.id, entityId: ws.companyId })) })).status).toBe(200)
      await booted.services.sync.sync(connectionId)

      const view = (await (await app.request('/api/workspace', { headers: { cookie } })).json()) as { entities: Array<{ id: string; cash: { minor: number; currency: string } | null }>; connections: Array<{ status: string; accountCount: number }> }
      const acme = view.entities.find((e) => e.id === ws.companyId)!
      expect(view.connections[0]).toMatchObject({ status: 'ok' })
      expect(acme.cash).not.toBeNull()
      expect(acme.cash!.currency).toBe('USD')
      console.log(`live: ${accounts.length} accounts, Acme cash ${acme.cash!.minor / 100} ${acme.cash!.currency}`)

      // An AI with a read-only agent key sees the same cash over REST (same operations as MCP).
      const personId = (await booted.handle.db.selectFrom('people').select('id').executeTakeFirstOrThrow()).id
      const wsId = (await booted.services.permissions.workspacesFor(personId))[0]!.id
      const key = await booted.services.mcp!.control.createAgentKey(
        { workspaceId: wsId, personId },
        { name: 'live test bot', shape: { entityIds: [ws.companyId], dataTypes: ['balances', 'transactions'], write: false, reviewMode: 'instant', expiresAt: new Date(Date.now() + 86400_000).toISOString() } },
      )
      const ov = await app.request('/v1/overview', { headers: { authorization: `Bearer ${key.key}` } })
      const body = (await ov.json()) as Record<string, unknown>
      expect(ov.status).toBe(200)
      expect(JSON.stringify(body)).toContain(String(acme.cash!.minor / 100))
      console.log('live: AI overview matches cash')
    } finally {
      await booted.shutdown()
    }
  }, 120_000)
})
