import { describe, expect, it, vi } from 'vitest'
import type { Kysely } from 'kysely'
import { connectPglite, migrateToLatest, type CoreTables } from '@agfn/db'
import { createAuth, logAuth, migrateAuth, TRUSTED_CLIENT_IP_HEADER, type AuthConfig } from './index.ts'

describe('auth on Postgres (PGlite)', () => {
  it('migrates auth tables and signs in by magic link', async () => {
    const h = await connectPglite<CoreTables>()
    try {
      await migrateToLatest(h.db)
      const outbox: string[] = []
      const cfg: AuthConfig = {
        db: h.db,
        dbKind: 'postgres',
        baseUrl: 'http://localhost:8787',
        secret: 'test-secret-test-secret-test-secret-1234',
        mailer: { send: async (m) => void outbox.push(m.text) },
        mcpResources: ['http://localhost:8787/mcp'],
        pendingGrant: async () => undefined,
      }
      await migrateAuth(cfg)
      const auth = createAuth(cfg)
      const res = await auth.handler(new Request('http://localhost:8787/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:8787' }, body: JSON.stringify({ email: 'pg@example.com', callbackURL: '/' }) }))
      expect(res.status).toBe(200)
      const verify = await auth.handler(new Request(outbox[0]!.match(/https?:\/\/\S+/)![0], { headers: { origin: 'http://localhost:8787' } }))
      expect(verify.headers.get('set-cookie')).toMatch(/session_token/)
      expect(await h.db.selectFrom('people').select('email').execute()).toEqual([{ email: 'pg@example.com' }])
    } finally {
      await h.close()
    }
  }, 30_000)
})

describe("Better Auth's own rate limiter on Postgres (PGlite)", () => {
  it('stores its counter in the database, answers 429 past the cap per client, and a second boot logs no int8 false alarm', async () => {
    const h = await connectPglite<CoreTables>()
    const warns: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void warns.push(a.map(String).join(' ')))
    try {
      await migrateToLatest(h.db)
      const cfg: AuthConfig = {
        db: h.db,
        dbKind: 'postgres',
        baseUrl: 'http://localhost:8787',
        secret: 'test-secret-test-secret-test-secret-1234',
        mailer: { send: async () => undefined },
        mcpResources: ['http://localhost:8787/mcp'],
        pendingGrant: async () => undefined,
        clientIpHeader: 'fly-client-ip',
      }
      await migrateAuth(cfg)
      await migrateAuth(cfg) // the second boot: the tables exist, so Better Auth compares column types
      expect(warns.filter((w) => w.includes('different type'))).toEqual([])

      const auth = createAuth(cfg)
      // Better Auth reads the canonical header the server resolves and sets (TRUSTED_CLIENT_IP_HEADER), not the raw
      // proxy header, so its per-client limiter works behind Cloudflare → Fly without trusting a forgeable header.
      const hit = (ip: string) => auth.handler(new Request('http://localhost:8787/api/auth/get-session', { headers: { origin: 'http://localhost:8787', [TRUSTED_CLIENT_IP_HEADER]: ip } }))
      const statuses: number[] = []
      for (let i = 0; i < 62; i++) statuses.push((await hit('203.0.113.9')).status)
      expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true)
      expect(statuses.slice(60)).toEqual([429, 429])
      expect((await hit('198.51.100.7')).status).toBe(200) // another client has its own budget
      const anyDb = h.db as unknown as Kysely<Record<string, Record<string, unknown>>>
      const rows = await anyDb.selectFrom('rateLimit').selectAll().execute()
      expect(rows.length).toBeGreaterThan(0)
      expect(Math.abs(Number(rows[0]!.lastRequest) - Date.now())).toBeLessThan(60_000) // ms timestamp, 64-bit
    } finally {
      spy.mockRestore()
      await h.close()
    }
  }, 60_000)
})

describe('logAuth', () => {
  it('drops only the int8 false alarm', () => {
    const warns: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void warns.push(a.map(String).join(' ')))
    try {
      logAuth('warn', 'Field lastRequest in table rateLimit has a different type in the database. Expected number but got int8.')
      logAuth('warn', 'Field lastRequest in table rateLimit has a different type in the database. Expected number but got text.')
      logAuth('warn', 'Rate limiting could not determine a client IP')
    } finally {
      spy.mockRestore()
    }
    expect(warns).toEqual(['[Better Auth]: Field lastRequest in table rateLimit has a different type in the database. Expected number but got text.', '[Better Auth]: Rate limiting could not determine a client IP'])
  })
})
