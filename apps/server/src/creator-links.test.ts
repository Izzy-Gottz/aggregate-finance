import { describe, expect, it } from 'vitest'
import { withBypass } from '@agfn/db'
import { BASE, startServer, type Server } from './scenarios/harness.ts'
import { attributeSignup, createCreatorLink, creatorPerk, listCreatorLinks, refFromCookie } from './creator-links.ts'
import { createWorkspace } from '@agfn/auth'
import { deleteAccount } from './delete-account.ts'
import { grantFree, resolveWorkspace } from './free-grants.ts'

/** Session cookies by email, from the last sign-up. */
const sessions = new Map<string, string>()
/** Sign up by magic link, as a browser that visited /r/<code> first (it carries that cookie). */
async function signUp(srv: Server, email: string, cookie?: string): Promise<string> {
  const before = srv.outbox.length
  await srv.app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
  const link = srv.outbox.slice(before).join('\n').match(/https?:\/\/\S+/)![0]
  const res = await srv.app.request(link.replace(BASE, ''), { headers: { origin: BASE, ...(cookie ? { cookie } : {}) } })
  sessions.set(email, res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '))
  const p = await withBypass('t', () => srv.booted.services.db.selectFrom('people').select('id').where('email', '=', email).executeTakeFirstOrThrow())
  return p.id
}
/** Attribution is recorded just after sign-up: wait for it to settle. */
const settle = () => new Promise((r) => setTimeout(r, 200))
const attributions = async (srv: Server) => (await settle(), attributionRows(srv))
const attributionRows = (srv: Server) => withBypass('t', () => (srv.booted.services.db as never as import('kysely').Kysely<{ creator_attributions: { person_id: string; code: string; created_at: string } }>).selectFrom('creator_attributions').selectAll().execute())
const visit = async (srv: Server, code: string, ip = '203.0.113.7') => {
  const res = await srv.app.request(`/r/${code}`, { headers: { 'x-test-ip': ip } })
  return { status: res.status, location: res.headers.get('location'), cookie: res.headers.getSetCookie().find((c) => c.startsWith('agfn_ref=')) }
}

for (const pglite of [false, true]) {
  describe(`creator links (${pglite ? 'Postgres' : 'SQLite'})`, () => {
    it('a live code sets the cookie; signing up through it records one attribution, nothing else', async () => {
      const srv = await startServer({ pglite })
      try {
        const db = srv.booted.services.db
        const { code } = await withBypass('t', () => createCreatorLink(db, { label: "Jane's channel", code: 'jane' }))
        const v = await visit(srv, 'JANE')
        expect(v).toMatchObject({ status: 302, location: '/?ref=1' })
        expect(v.cookie).toMatch(/^agfn_ref=jane; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000/)
        // Unknown codes redirect the same way, with no cookie.
        expect(await visit(srv, 'nobody')).toMatchObject({ status: 302, location: '/', cookie: undefined })
        expect(refFromCookie('a=1; agfn_ref=jane; b=2')).toBe('jane')
        expect(refFromCookie('agfn_ref=%E0%A4%A')).toBeNull() // malformed escape: ignored, never thrown

        const p = await signUp(srv, 'fan@example.com', `agfn_ref=${code}`)
        await signUp(srv, 'plain@example.com')
        const rows = await attributions(srv)
        expect(rows).toEqual([{ person_id: p, code: 'jane', created_at: expect.any(String) }])
        // Signing in again (same person) never adds or moves an attribution.
        await signUp(srv, 'fan@example.com', 'agfn_ref=jane')
        expect(await attributions(srv)).toHaveLength(1)
        // The app says "3 months free" to the person who came through the link, and nothing to anyone else.
        const me = async (email: string) => (await (await srv.app.request('/api/me', { headers: { origin: BASE, cookie: sessions.get(email)! } })).json()) as { perk?: unknown }
        expect((await me('fan@example.com')).perk).toEqual({ label: '3 months free' })
        expect((await me('plain@example.com')).perk).toBeUndefined()
        expect(await withBypass('t', () => listCreatorLinks(db))).toEqual([{ code: 'jane', label: "Jane's channel", cap: 100, used: 1, expiresAt: '2026-12-31T23:59:59.000Z' }])

        // Deleting the account removes the attribution; deleting a person row cascades.
        await withBypass('t', () => deleteAccount({ db } as never, p))
        expect(await attributions(srv)).toEqual([])
        // Once each has a workspace, its free time is one line (free-grants.ts): the creator perk, or a YC Deal grant.
        const onboard = (email: string) => srv.app.request('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie: sessions.get(email)! }, body: JSON.stringify({ companyName: 'Co' }) })
        const freeGrant = async (email: string) => ((await me(email)) as { freeGrant?: unknown }).freeGrant
        await signUp(srv, 'fan2@example.com', `agfn_ref=${code}`)
        await settle()
        expect((await onboard('fan2@example.com')).status).toBe(201)
        expect((await onboard('plain@example.com')).status).toBe(201)
        expect(await freeGrant('fan2@example.com')).toEqual({ label: '3 months free (creator link)' })
        expect(await freeGrant('plain@example.com')).toBeUndefined()
        const plainWs = (await withBypass('t', () => resolveWorkspace(db, 'plain@example.com'))).id
        await grantFree(db, { workspaceId: plainWs, kind: 'yc', months: 12, reason: 'YC Deal', grantedBy: 'test' })
        expect(await freeGrant('plain@example.com')).toEqual({ label: '12 months free (YC Deal)' })
        expect((await me('plain@example.com')).perk).toBeUndefined()
      } finally {
        await srv.close()
      }
    }, 60_000)

    it('a first sign-up by email code (not the link) is attributed too', async () => {
      const srv = await startServer({ pglite })
      try {
        await withBypass('t', () => createCreatorLink(srv.booted.services.db, { label: 'Code', code: 'by-code' }))
        const ref = (await visit(srv, 'by-code')).cookie!.split(';')[0]!
        const before = srv.outbox.length
        const asked = await srv.app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie: ref }, body: JSON.stringify({ email: 'coder@example.com', callbackURL: '/' }) })
        const jar = [ref, ...asked.headers.getSetCookie().map((c) => c.split(';')[0]!).filter((c) => !c.endsWith('='))].join('; ')
        const code = srv.outbox.slice(before).join('\n').match(/\n(\d{3} \d{3})\n/)![1]!
        const signed = await srv.app.request('/api/signin/code', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie: jar }, body: JSON.stringify({ code }) })
        expect(signed.status).toBe(200)
        const p = await withBypass('t', () => srv.booted.services.db.selectFrom('people').select('id').where('email', '=', 'coder@example.com').executeTakeFirstOrThrow())
        expect((await attributions(srv)).filter((r: { person_id: string }) => r.person_id === p.id).map((r: { code: string }) => r.code)).toEqual(['by-code'])
      } finally {
        await srv.close()
      }
    }, 60_000)

    it('caps at the link’s limit, also when sign-ups land at once; expired links record nothing', async () => {
      const srv = await startServer({ pglite })
      try {
        const db = srv.booted.services.db
        const kind = srv.booted.handle.kind
        await withBypass('t', () => createCreatorLink(db, { label: 'Small', code: 'small', cap: 3 }))
        await withBypass('t', () => createCreatorLink(db, { label: 'Old', code: 'old-link', expiresAt: '2026-01-01T00:00:00Z' }))
        const people: string[] = []
        for (const n of ['a', 'b', 'c', 'd', 'e']) people.push(await signUp(srv, `${n}@example.com`))
        const results = await Promise.all(people.map((p) => withBypass('t', () => attributeSignup(db, kind, p, 'small'))))
        expect(results.filter((r) => r === 'recorded')).toHaveLength(3)
        expect(results.filter((r) => r === 'full')).toHaveLength(2)
        expect(await withBypass('t', () => attributeSignup(db, kind, people[0]!, 'small'))).toBe('already')
        expect(await withBypass('t', () => attributeSignup(db, kind, people[4]!, 'old-link'))).toBe('unknown')
        expect(await visit(srv, 'old-link')).toMatchObject({ cookie: undefined })
        expect((await attributions(srv)).filter((r: { code: string }) => r.code === 'small')).toHaveLength(3)
        // Full: /r promises nothing (no ?ref=1, no cookie), since sign-up couldn't grant the perk.
        expect(await visit(srv, 'small')).toMatchObject({ status: 302, location: '/', cookie: undefined })
      } finally {
        await srv.close()
      }
    }, 60_000)

    it("a workspace owned by someone who came through a link has the perk (3 months); others don't", async () => {
      const srv = await startServer({ pglite })
      try {
        const db = srv.booted.services.db
        await withBypass('t', () => createCreatorLink(db, { label: "Jane's channel", code: 'jane' }))
        const fan = await signUp(srv, 'fan2@example.com', 'agfn_ref=jane')
        const plain = await signUp(srv, 'plain2@example.com')
        await settle()
        const ws = await withBypass('t', () => createWorkspace(db, { personId: fan, workspaceName: 'Fan Co', firstCompanyName: 'Fan Co' }))
        const other = await withBypass('t', () => createWorkspace(db, { personId: plain, workspaceName: 'Plain Co', firstCompanyName: 'Plain Co' }))
        expect(await withBypass('t', () => creatorPerk(db, ws.workspaceId))).toMatchObject({ code: 'jane', label: "Jane's channel", months: 3 })
        expect(await withBypass('t', () => creatorPerk(db, other.workspaceId))).toBeNull()
        // Gone with the attribution (account deletion removes it).
        await withBypass('t', () => db.deleteFrom('creator_attributions' as never).where('person_id' as never, '=', fan as never).execute())
        expect(await withBypass('t', () => creatorPerk(db, ws.workspaceId))).toBeNull()
      } finally {
        await srv.close()
      }
    })
  })
}

describe('creator links: /r is limited per IP', () => {
  it('stops setting cookies after 30 visits a minute from one address', async () => {
    const srv = await startServer({ env: { CLIENT_IP_HEADER: 'x-test-ip' } })
    try {
      await withBypass('t', () => createCreatorLink(srv.booted.services.db, { label: 'Busy', code: 'busy' }))
      const got = []
      for (let i = 0; i < 32; i++) got.push((await visit(srv, 'busy', '198.51.100.9')).cookie !== undefined)
      expect(got.filter(Boolean)).toHaveLength(30)
      expect((await visit(srv, 'busy', '198.51.100.10')).cookie).toBeDefined()
    } finally {
      await srv.close()
    }
  }, 60_000)
})
