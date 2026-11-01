// Red team 20: disconnecting QuickBooks revokes Aggregate's access at Intuit (Intuit's production review asks), with
// or without "delete its data", through the real route and the real connector. A refused revoke comes back as the
// disconnect's warning (what to do in QuickBooks), and the secret is wiped either way.
import { describe, expect, it } from 'vitest'
import { withBypass } from '@agfn/db'
import { createQuickBooksConnector } from '@agfn/connector-quickbooks'
import { createConnection } from '@agfn/sync'
import { entities, signIn, startServer } from '../scenarios/harness.ts'

function intuit(status: number) {
  const calls: Array<{ url: string; body: unknown; auth: string | null }> = []
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init?.headers).get('authorization') })
    return new Response('{}', { status, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  return { calls, fetch }
}

async function world(status: number, email: string) {
  const i = intuit(status)
  const srv = await startServer({
    connectors: [(deps) => createQuickBooksConnector({ deps: { ...deps, fetch: i.fetch }, oauth: { clientId: 'client-rt', clientSecret: 'secret-rt', redirectUri: 'https://x/cb' } })],
  })
  const s = await signIn(srv, email, 'Acme')
  const acme = (await entities(s)).Acme as string
  const id = await withBypass('test:seed', () =>
    createConnection(srv.booted.services.db, srv.booted.services.keys, {
      workspaceId: s.workspaceId,
      connectorKey: 'quickbooks',
      displayName: 'QuickBooks · Acme',
      secret: { tokens: { accessToken: 'at-rt', refreshToken: 'rt-rt', expiresAt: Date.now() + 3_600_000 } },
      config: { realmId: '9130000000000001', environment: 'sandbox', homeCurrency: 'USD' },
      createdBy: s.personId,
      entityId: acme,
    }),
  )
  const secretOf = async () => (await withBypass('test:read', () => srv.booted.services.db.selectFrom('connections').select(['secret_enc', 'status']).where('id', '=', id).executeTakeFirstOrThrow()))
  return { srv, s, id, calls: i.calls, secretOf }
}

describe('red team 20: QuickBooks disconnect revokes at Intuit', () => {
  for (const deleteData of [false, true]) {
    it(`disconnect${deleteData ? ' + delete its data' : ''}: one revoke call with the refresh token, then the secret is gone`, async () => {
      const w = await world(200, `rt20-${deleteData}@example.com`)
      try {
        const r = await w.s.post<{ ok: boolean; warning?: string }>(`/api/connections/${w.id}/disconnect`, { deleteData })
        expect(r).toMatchObject({ status: 200, body: { ok: true } })
        expect(r.body.warning).toBeUndefined()
        // The endpoint comes from Intuit's discovery document when it answers (here it doesn't: the fallback).
        const revokes = w.calls.filter((c) => new URL(c.url).pathname === '/v2/oauth2/tokens/revoke')
        expect(revokes).toHaveLength(1)
        expect(revokes[0]).toMatchObject({ body: { token: 'rt-rt' }, auth: `Basic ${Buffer.from('client-rt:secret-rt').toString('base64')}` })
        expect(await w.secretOf()).toEqual({ secret_enc: null, status: 'disconnected' })
      } finally {
        await w.srv.close()
      }
    })
  }

  it('Intuit refusing the revoke: still disconnected here, and the person is told to remove the app in QuickBooks', async () => {
    const w = await world(400, 'rt20-refused@example.com')
    try {
      const r = await w.s.post<{ ok: boolean; warning?: string }>(`/api/connections/${w.id}/disconnect`, { deleteData: false })
      expect(r.body).toMatchObject({ ok: true, warning: expect.stringMatching(/refused to revoke access \(HTTP 400\).*Settings → Apps/) })
      expect(r.body.warning).not.toMatch(/rt-rt|at-rt|secret-rt/)
      expect(await w.secretOf()).toEqual({ secret_enc: null, status: 'disconnected' })
    } finally {
      await w.srv.close()
    }
  })
})
