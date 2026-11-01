// Threat model #8 (webhook spoofing / replay): provider webhooks arrive without a session. A forged, tampered, stale
// or replayed delivery must do nothing — above all, it must not disconnect someone's connection (Stripe's
// account.application.deauthorized drops the stored secret). Uses the real Stripe connector and signature scheme.
import { describe, expect, it } from 'vitest'
import { createStripeConnector, signStripePayload } from '@agfn/connector-stripe'
import { createConnection } from '@agfn/sync'
import { startServer, type Server } from '../scenarios/harness.ts'
import { asTest, victimWorld } from './world.ts'

const SECRET = 'whsec_redteam_test_only_0000000000'
const now = () => Math.floor(Date.now() / 1000)

async function deliver(srv: Server, body: string, sig?: string, key = 'stripe') {
  const res = await srv.app.request(`/api/webhooks/${key}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(sig ? { 'stripe-signature': sig } : {}) }, body })
  await res.text()
  return res.status
}

describe('red team: webhook forgery and replay', () => {
  it('only correctly signed, fresh, first-time deliveries act', async () => {
    const srv = await startServer({ connectors: [(deps) => createStripeConnector({ webhookSecret: SECRET }, deps)] })
    try {
      const v = await victimWorld(srv)
      const sv = srv.booted.services
      const connId = await asTest(() => createConnection(sv.db, sv.keys, { workspaceId: v.ws, connectorKey: 'stripe', displayName: 'Stripe', secret: { apiKey: 'rk_test_x' }, config: { accountId: 'acct_victim' }, createdBy: v.s.personId, entityId: v.entityId }))
      const conn = async () => asTest(() => sv.db.selectFrom('connections').select(['status', 'secret_enc']).where('id', '=', connId).executeTakeFirstOrThrow())
      const deauth = JSON.stringify({ id: 'evt_deauth_1', type: 'account.application.deauthorized', account: 'acct_victim' })

      // ---- forgeries: nothing happens ----
      const t = now()
      const forged: Array<[string, string | undefined, string]> = [
        ['no signature', undefined, deauth],
        ['garbage signature', 't=1,v1=zz', deauth],
        ['wrong secret', signStripePayload('whsec_attacker', deauth, t), deauth],
        ['tampered body', signStripePayload(SECRET, deauth, t), deauth.replace('acct_victim', 'acct_victim ')],
        ['signed for another account, body swapped', signStripePayload(SECRET, deauth.replace('acct_victim', 'acct_mallory'), t), deauth],
        ['stale (replay after 10 min)', signStripePayload(SECRET, deauth, t - 600), deauth],
        ['from the future', signStripePayload(SECRET, deauth, t + 600), deauth],
        ['v0 only', `t=${t},v0=${signStripePayload(SECRET, deauth, t).split('v1=')[1]}`, deauth],
        ['timestamp swapped', signStripePayload(SECRET, deauth, t).replace(`t=${t}`, `t=${t - 1}`), deauth],
      ]
      for (const [label, sig, body] of forged) expect(await deliver(srv, body, sig), label).toBe(401)
      expect(await conn()).toMatchObject({ status: 'active' })
      expect((await conn()).secret_enc).not.toBeNull()
      expect(await deliver(srv, deauth, signStripePayload(SECRET, deauth, t), 'nosuchprovider')).toBe(404)
      expect(await deliver(srv, deauth, signStripePayload(SECRET, deauth, t), 'plaid')).toBe(404) // no webhook support → nothing to forge

      // ---- a real delivery acts once; the same delivery replayed (within tolerance) doesn't act again ----
      const sig = signStripePayload(SECRET, deauth, now())
      expect(await deliver(srv, deauth, sig)).toBe(200)
      expect(await conn()).toMatchObject({ status: 'disconnected', secret_enc: null })
      // The person reconnects; an attacker who captured the delivery replays it.
      await asTest(() => sv.db.updateTable('connections').set({ status: 'active', secret_enc: 'reconnected' }).where('id', '=', connId).execute())
      expect(await deliver(srv, deauth, sig)).toBe(200)
      expect(await conn()).toMatchObject({ status: 'active', secret_enc: 'reconnected' })

      // ---- a signed event for an account nobody connected touches nothing ----
      const stray = JSON.stringify({ id: 'evt_stray', type: 'account.application.deauthorized', account: 'acct_nobody' })
      expect(await deliver(srv, stray, signStripePayload(SECRET, stray, now()))).toBe(200)
      expect(await conn()).toMatchObject({ status: 'active' })
      // ---- the victim's other connections never moved ----
      const others = await asTest(() => sv.db.selectFrom('connections').select(['id', 'status']).where('workspace_id', '=', v.ws).where('id', '!=', connId).execute())
      for (const o of others) expect(o.status, o.id).toBe('active')
    } finally {
      await srv.close()
    }
  }, 120_000)
})
