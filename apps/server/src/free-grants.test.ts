import { describe, expect, it } from 'vitest'
import { newId, nowIso, withBypass } from '@agfn/db'
import { createWorkspace } from '@agfn/auth'
import { startServer } from './scenarios/harness.ts'
import { freeGrants, freeLabel, grantFree, resolveWorkspace, revokeFree } from './free-grants.ts'
import { createCreatorLink } from './creator-links.ts'

for (const pglite of [false, true]) {
  describe(`free grants (${pglite ? 'Postgres' : 'SQLite'})`, () => {
    it('grants by owner email, lists with the creator perk, labels, validates, revokes', async () => {
      const srv = await startServer({ pglite })
      try {
        const db = srv.booted.services.db
        await withBypass('t', async () => {
          const person = async (email: string) => {
            const id = newId()
            await db.insertInto('people').values({ id, auth_user_id: null, name: email, email, created_at: nowIso() }).execute()
            return id
          }
          const founder = await person('founder@example.com')
          const { workspaceId: ws } = await createWorkspace(db, { personId: founder, workspaceName: 'Startup', firstCompanyName: 'Startup' })
          // A demo workspace the founder also owns is never the target.
          const { workspaceId: demo } = await createWorkspace(db, { personId: founder, workspaceName: 'Demo', firstCompanyName: 'Demo' })
          await db.insertInto('settings').values({ workspace_id: demo, key: 'demo', value_json: 'true', updated_at: nowIso() }).execute()

          expect(await resolveWorkspace(db, 'Founder@Example.com')).toEqual({ id: ws, name: expect.any(String) })
          expect(await resolveWorkspace(db, ws)).toMatchObject({ id: ws })
          await expect(resolveWorkspace(db, 'nobody@example.com')).rejects.toThrow(/owns no workspace/)
          await expect(resolveWorkspace(db, 'ws_missing')).rejects.toThrow(/no workspace/)

          expect(await freeGrants(db, ws)).toEqual([])
          expect(freeLabel([])).toBeNull()
          await expect(grantFree(db, { workspaceId: ws, kind: 'yc', reason: 'YC Deal', grantedBy: 'ops' })).rejects.toThrow(/--months or --until/)
          await expect(grantFree(db, { workspaceId: ws, kind: 'yc', months: 12, until: '2027-10-31', reason: 'YC Deal', grantedBy: 'ops' })).rejects.toThrow(/--months or --until/)
          await expect(grantFree(db, { workspaceId: ws, kind: 'yc', months: 0, reason: 'YC Deal', grantedBy: 'ops' })).rejects.toThrow(/1 to 120/)
          await expect(grantFree(db, { workspaceId: ws, kind: 'manual', until: '2027-13-45', reason: 'x', grantedBy: 'ops' })).rejects.toThrow(/must be a date/)
          await expect(grantFree(db, { workspaceId: ws, kind: 'manual', months: 1, reason: '  ', grantedBy: 'ops' })).rejects.toThrow(/reason/)

          const yc = await grantFree(db, { workspaceId: ws, kind: 'yc', months: 12, reason: 'YC Deal', grantedBy: 'f5', now: new Date('2026-10-13T12:00:00Z') })
          await grantFree(db, { workspaceId: ws, kind: 'manual', until: '2027-01-31', reason: 'beta tester', grantedBy: 'ops', now: new Date('2026-10-14T12:00:00Z') })
          const all = await freeGrants(db, ws)
          expect(all.map((g) => [g.kind, g.months, g.until, g.reason, g.grantedBy])).toEqual([
            ['yc', 12, null, 'YC Deal', 'f5'],
            ['manual', null, '2027-01-31', 'beta tester', 'ops'],
          ])
          expect(freeLabel(all)).toBe('12 months free (YC Deal)')
          expect(await freeGrants(db, demo)).toEqual([])

          expect(await revokeFree(db, ws, yc.id)).toBe(true)
          expect(await revokeFree(db, ws, yc.id)).toBe(false)
          expect(freeLabel(await freeGrants(db, ws))).toBe('Free through 2027-01-31')

          // A second real workspace makes the email ambiguous: it names both.
          const { workspaceId: ws2 } = await createWorkspace(db, { personId: founder, workspaceName: 'Side', firstCompanyName: 'Side' })
          await expect(resolveWorkspace(db, 'founder@example.com')).rejects.toThrow(new RegExp(`owns 2 workspaces.*${ws}|owns 2 workspaces.*${ws2}`))

          // The creator-link perk is listed alongside, derived from its attribution.
          const fan = await person('fan@example.com')
          const { workspaceId: fanWs } = await createWorkspace(db, { personId: fan, workspaceName: 'Fan', firstCompanyName: 'Fan' })
          await createCreatorLink(db, { label: 'Jane', code: 'jane' })
          await (db as never as import('kysely').Kysely<{ creator_attributions: { person_id: string; code: string; created_at: string } }>).insertInto('creator_attributions').values({ person_id: fan, code: 'jane', created_at: nowIso() }).execute()
          const fanGrants = await freeGrants(db, fanWs)
          expect(fanGrants.map((g) => g.kind)).toEqual(['creator'])
          expect(freeLabel(fanGrants)).toBe('3 months free (creator link)')
        })
      } finally {
        await srv.close()
      }
    }, 60_000)
  })
}
