// /v1/control acts in the workspace the request names (checked against the person's memberships) or their default,
// never "whichever row came first", and a workspace they don't belong to is 404.
import { describe, expect, it } from 'vitest'
import { connectAi, signIn, startServer } from '../scenarios/harness.ts'
import { asTest } from './world.ts'

describe('red team: /v1/control picks the workspace like the app does', () => {
  it('a person with two workspaces: control actions land only in the one asked for', async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'twoworkspaces@example.com', 'First Co')
      const first = s.workspaceId
      const aiFirst = await connectAi(srv, s, undefined, 'First bot')
      // A second workspace they were invited into (later than their own, so their own stays the default).
      const host = await signIn(srv, 'host16@example.com', 'Second Co')
      const second = host.workspaceId
      await asTest(() => srv.booted.services.db.insertInto('memberships').values({ id: `m_${second}`, workspace_id: second, person_id: s.personId, role: 'admin', grid_json: null, expires_at: null, invited_by: host.personId, created_at: '2099-01-01T00:00:00.000Z', revoked_at: null }).execute())
      const other = await signIn(srv, 'stranger16@example.com', 'Stranger Co')
      const control = (path: string, init: RequestInit & { ws?: string } = {}) =>
        srv.app.request(path, { ...init, headers: { cookie: s.cookie(), origin: 'http://localhost:8787', 'content-type': 'application/json', ...(init.ws ? { 'x-agfn-workspace': init.ws } : {}) } })
      // The listed grants, as text (whatever their id field is called).
      const grants = async (ws?: string) => JSON.stringify(((await (await control('/v1/control/grants', ws ? { ws } : {})).json()) as { grants: unknown[] }).grants)
      // Default: the person's first (oldest) workspace; named: exactly that one.
      expect(await grants()).toContain(aiFirst.grantId)
      expect(await grants(first)).toContain(aiFirst.grantId)
      expect(await grants(second)).not.toContain(aiFirst.grantId)
      // Revoking a first-workspace grant "from" the second workspace finds nothing there.
      expect((await control(`/v1/control/grants/${aiFirst.grantId}`, { method: 'DELETE', ws: second })).status).toBe(404)
      expect(await grants(first)).toContain(aiFirst.grantId)
      // A workspace they don't belong to, or one that doesn't exist: 404, nothing listed.
      for (const ws of [other.workspaceId, 'ws_does_not_exist']) {
        const r = await control('/v1/control/grants', { ws })
        expect(r.status, ws).toBe(404)
        expect((await control(`/v1/control/grants?workspace=${encodeURIComponent(ws)}`)).status).toBe(404)
      }
    } finally {
      await srv.close()
    }
  }, 120_000)
})
