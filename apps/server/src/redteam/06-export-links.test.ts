// Export-link theft: "Export everything" makes a one-off download link. A link that leaks (shared screen, browser
// history, a forwarded email) must be useless to anyone but the person who made it, in that workspace, before it
// expires; and the export itself carries no secrets and nothing from other workspaces.
import { describe, expect, it } from 'vitest'
import { signIn, startServer } from '../scenarios/harness.ts'
import { asTest, attackerWorld, victimWorld } from './world.ts'

describe('red team: export links', () => {
  it('only the maker, in the workspace, before expiry; no secrets inside', async () => {
    const srv = await startServer()
    try {
      const v = await victimWorld(srv)
      const m = await attackerWorld(srv)
      const made = await v.s.post<{ url: string }>('/api/export', {})
      expect(made.status).toBe(200)
      const url = made.body.url
      const token = url.split('/').pop() as string

      // The maker downloads it: an attachment, never cached, never sniffed.
      const dl = await srv.app.request(url, { headers: { cookie: v.s.cookie() } })
      const text = await dl.text()
      expect(dl.status).toBe(200)
      expect(dl.headers.get('content-disposition')).toMatch(/^attachment;/)
      expect(dl.headers.get('cache-control')).toMatch(/no-store/)
      expect(dl.headers.get('x-content-type-options')).toBe('nosniff')

      // No secrets: stored provider secrets, key hashes, auth sessions/tokens, other links' tokens.
      const db = srv.booted.services.db as unknown as import('kysely').Kysely<Record<string, Record<string, unknown>>>
      const secrets: string[] = [v.ai.key]
      await asTest(async () => {
      for (const r of await db.selectFrom('connections').select('secret_enc').execute()) if (typeof r.secret_enc === 'string') secrets.push(r.secret_enc)
      for (const r of await db.selectFrom('agent_keys').select('key_hash').execute()) secrets.push(String(r.key_hash))
      for (const t of await srv.booted.services.db.introspection.getTables()) {
        if (!/^(auth_|session|verification|account$|passkey|jwks|oauth)/i.test(t.name)) continue
        for (const col of t.columns.filter((c) => /token|secret|password|key/i.test(c.name))) {
          for (const r of await db.selectFrom(t.name).select(col.name).execute()) if (typeof r[col.name] === 'string' && (r[col.name] as string).length >= 12) secrets.push(r[col.name] as string)
        }
      }
      })
      expect(secrets.length).toBeGreaterThan(3)
      for (const sec of secrets) expect(text.includes(sec), `export contains a secret (${sec.slice(0, 6)}…)`).toBe(false)
      expect(text).not.toContain(token)
      expect(text).not.toContain('Mallory') // nothing from the other workspace
      expect(text).toContain('VICTIMSECRET') // but it is the victim's data

      // Stolen by someone in another workspace, with or without asking for the victim's workspace.
      for (const h of [{}, { 'x-agfn-workspace': v.ws }] as Array<Record<string, string>>) {
        const r = await srv.app.request(url, { headers: { cookie: m.s.cookie(), ...h } })
        expect(r.status).toBe(404)
        expect(await r.text()).not.toContain('VICTIMSECRET')
      }
      // Stolen by a colleague in the same workspace.
      expect((await v.s.post('/api/people', { email: 'colleague@a.example', role: 'accountant', entityIds: 'all' })).status).toBe(201)
      const colleague = await signIn(srv, 'colleague@a.example')
      const r2 = await srv.app.request(url, { headers: { cookie: colleague.cookie(), 'x-agfn-workspace': v.ws } })
      expect(r2.status).toBe(404)
      expect(await r2.text()).not.toContain('VICTIMSECRET')
      expect((await colleague.send('POST', '/api/export', {}, { 'x-agfn-workspace': v.ws })).status).toBe(403)
      // No session at all.
      expect((await srv.app.request(url)).status).toBe(401)
      // Guessed or altered tokens.
      for (const t of [token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'), 'A'.repeat(32), '../../exports', `${token}/../x`, token.toLowerCase() === token ? token.toUpperCase() : token.toLowerCase()]) {
        const r = await srv.app.request(`/api/export/${encodeURIComponent(t)}`, { headers: { cookie: v.s.cookie() } })
        expect(r.status, t).toBe(404)
      }

      // Expired: the maker can't use it either.
      await asTest(async () => db.updateTable('settings').set({ value_json: JSON.stringify({ ...JSON.parse(String((await db.selectFrom('settings').select('value_json').where('key', '=', `export:${token}`).executeTakeFirstOrThrow()).value_json)), expiresAt: new Date(Date.now() - 1000).toISOString() }) }).where('key', '=', `export:${token}`).execute())
      expect((await srv.app.request(url, { headers: { cookie: v.s.cookie() } })).status).toBe(404)
      // And the file itself is gone, not just the link.
      expect([...srv.files.files.keys()].filter((k) => k.startsWith(`exports/${v.ws}/`))).toEqual([])
      // The worker's sweep does the same for links nobody opens again.
      const again = await v.s.post<{ url: string }>('/api/export', {})
      const t2 = again.body.url.split('/').pop() as string
      expect([...srv.files.files.keys()].some((k) => k.includes(t2))).toBe(true)
      const { pruneExpiredExports } = await import('../exports.ts')
      expect(await asTest(() => pruneExpiredExports(srv.booted.services.db, srv.files, { now: Date.now() + 2 * 3600_000 }))).toBe(1)
      expect([...srv.files.files.keys()].filter((k) => k.startsWith('exports/'))).toEqual([])
    } finally {
      await srv.close()
    }
  }, 120_000)
})
