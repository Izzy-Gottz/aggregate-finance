// Threat model #3 (leaked or stale agent keys) and #9 (revocation checked on every request): malformed, guessed,
// tampered, expired, revoked and paused keys get nothing; a session cookie can't drive /mcp and an agent key can't
// drive the session API; and a key can't be created wider than its maker or without an expiry.
import { describe, expect, it } from 'vitest'
import { BASE, connectAi, READ_WRITE_ALL, startServer, type Server } from '../scenarios/harness.ts'
import { asTest, attackerWorld, victimWorld } from './world.ts'

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'rt', version: '1' } } }

async function mcpStatus(srv: Server, headers: Record<string, string>): Promise<number> {
  const res = await srv.app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(INIT) })
  await res.text()
  return res.status
}
async function restStatus(srv: Server, headers: Record<string, string>): Promise<number> {
  const res = await srv.app.request('/v1/whoami', { headers })
  await res.text()
  return res.status
}

describe('red team: agent keys', () => {
  it('rejects malformed, tampered, expired, revoked and paused keys; keys and sessions stay separate', async () => {
    const srv = await startServer()
    try {
      const v = await victimWorld(srv)
      const key = v.ai.key
      expect(await mcpStatus(srv, { authorization: `Bearer ${key}` })).toBe(200)
      expect(await restStatus(srv, { authorization: `Bearer ${key}` })).toBe(200)

      // ---- malformed / guessed / tampered ----
      const flip = key.slice(0, -1) + (key.endsWith('a') ? 'b' : 'a')
      for (const h of [{}, { authorization: 'Bearer ' }, { authorization: 'Bearer x' }, { authorization: `Bearer ${flip}` }, { authorization: `Bearer ${key.toUpperCase()}` }, { authorization: `Basic ${Buffer.from(`u:${key}`).toString('base64')}` }, { authorization: `bearer  ${key} extra` }, { 'x-api-key': key }] as Array<Record<string, string>>) {
        expect(await mcpStatus(srv, h), JSON.stringify(h)).toBe(401)
        expect(await restStatus(srv, h), JSON.stringify(h)).toBe(401)
      }
      // A signed-in browser session is not an agent key.
      expect(await mcpStatus(srv, { cookie: v.s.cookie(), origin: BASE })).toBe(401)
      // And an agent key is not a session.
      for (const path of ['/api/workspace', '/api/me', '/api/review']) {
        const res = await srv.app.request(path, { headers: { authorization: `Bearer ${key}` } })
        expect(res.status, path).toBe(401)
      }

      // ---- pause: the owner's "Pause all AI" stops the open session; resume restores it ----
      expect((await v.s.post('/api/ai/pause-all', { paused: true })).status).toBe(200)
      expect((await v.ai.try('get_metric', { metric: 'cash', company: 'Victim Co' }).catch((e: unknown) => ({ isError: true, text: String(e) }))).isError).toBe(true)
      const w = await v.ai.try('add_entry', { company: 'Victim Co', kind: 'expense', amount: { amount: '1.00', currency: 'USD' }, date: '2026-10-05', paid_by: 'Victim Co', idempotency_key: 'paused-write-01' }).catch((e: unknown) => ({ isError: true, text: String(e), data: undefined }))
      expect(w.isError).toBe(true)
      expect((await v.s.post('/api/ai/pause-all', { paused: false })).status).toBe(200)
      expect((await v.ai.try('get_metric', { metric: 'cash', company: 'Victim Co' })).isError).toBe(false)
      // One grant paused: that key stops, others don't.
      const other = await connectAi(srv, v.s, undefined, 'Other bot')
      expect((await v.s.post(`/api/ai/${v.grantId}/pause`, { paused: true })).status).toBe(200)
      expect((await v.ai.try('get_metric', { metric: 'cash', company: 'Victim Co' }).catch((e: unknown) => ({ isError: true, text: String(e) }))).isError).toBe(true)
      expect((await other.try('get_metric', { metric: 'cash', company: 'Victim Co' })).isError).toBe(false)
      expect((await v.s.post(`/api/ai/${v.grantId}/pause`, { paused: false })).status).toBe(200)

      // ---- expired: the key's time runs out while a session is open ----
      const past = new Date(Date.now() - 60_000).toISOString()
      await asTest(() => srv.booted.services.db.updateTable('grants' as never).set({ expires_at: past } as never).where('id' as never, '=', other.grantId as never).execute())
      await asTest(() => srv.booted.services.db.updateTable('agent_keys' as never).set({ expires_at: past } as never).where('grant_id' as never, '=', other.grantId as never).execute())
      await expect(other.call('get_metric', { metric: 'cash', company: 'Victim Co' })).rejects.toThrow()
      expect(await mcpStatus(srv, { authorization: `Bearer ${other.key}` })).toBe(401)
      expect(await restStatus(srv, { authorization: `Bearer ${other.key}` })).toBe(401)

      // ---- revoked ----
      expect((await v.s.post(`/api/ai/${v.grantId}/revoke`, {})).status).toBe(200)
      await expect(v.ai.call('get_metric', { metric: 'cash', company: 'Victim Co' })).rejects.toThrow(/revoked|invalid_token|401/)
      expect(await mcpStatus(srv, { authorization: `Bearer ${key}` })).toBe(401)
      expect(await restStatus(srv, { authorization: `Bearer ${key}` })).toBe(401)
      // Un-pausing or editing a revoked grant doesn't bring it back.
      await v.s.post(`/api/ai/${v.grantId}/pause`, { paused: false })
      await v.s.send('PATCH', `/api/ai/${v.grantId}`, { name: 'back from the dead' })
      expect(await mcpStatus(srv, { authorization: `Bearer ${key}` })).toBe(401)
    } finally {
      await srv.close()
    }
  }, 120_000)

  it('a key cannot be created without an expiry, already expired, or wider than its maker', async () => {
    const srv = await startServer()
    try {
      const v = await victimWorld(srv)
      const m = await attackerWorld(srv)
      const { expiresAt: _drop, ...noExpiry } = READ_WRITE_ALL
      void _drop
      const bad = [
        { name: 'no expiry', shape: noExpiry },
        { name: 'expired', shape: { ...READ_WRITE_ALL, expiresAt: new Date(Date.now() - 1000).toISOString() } },
        { name: 'other workspace company', shape: { ...READ_WRITE_ALL, entityIds: [v.entityId] } },
        { name: 'other workspace personal', shape: { ...READ_WRITE_ALL, entityIds: [v.personalId] } },
        { name: 'bogus data type', shape: { ...READ_WRITE_ALL, dataTypes: ['everything'] } },
      ]
      for (const b of bad) {
        const r = await m.s.post<{ key?: string }>('/api/ai/keys', { name: b.name, shape: b.shape })
        // Either refused, or (for unknown ids) a key that can see none of the victim's data.
        if (r.status < 400 && r.body.key) {
          const res = await srv.app.request('/v1/metrics/cash?company=Victim%20Co', { headers: { authorization: `Bearer ${r.body.key}` } })
          expect(res.status, b.name).toBeGreaterThanOrEqual(400)
          expect(await res.text(), b.name).not.toContain('50000.00')
          expect(b.name, `${b.name} should have been refused`).toMatch(/other workspace/)
        } else expect([400, 403], `${b.name}: ${r.status}`).toContain(r.status)
      }
      // A member who can't manage AI can't mint keys at all: covered by roles; here, no session → 401.
      const anon = await srv.app.request('/api/ai/keys', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ name: 'x', shape: READ_WRITE_ALL }) })
      expect(anon.status).toBe(401)
    } finally {
      await srv.close()
    }
  }, 120_000)
})
