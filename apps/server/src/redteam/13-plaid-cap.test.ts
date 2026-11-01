// Plaid early-access cap (AGFN_PLAID_MAX_ITEMS_PER_WORKSPACE): every new Item is billed, so the cap must hold under
// concurrency (two tabs, two people, one person in two workspaces finishing at once) and across disconnect/reconnect
// (a disconnected Item frees its slot, a reconnect never takes a second one, and a disconnect that lands while a sync
// is in flight stays disconnected).
import { describe, expect, it } from 'vitest'
import type { Connector, ConnectionRef, NormalizedEvent } from '@agfn/contracts'
import type { ConnectorFactory } from '@agfn/sync'
import { addMember } from '@agfn/auth'
import { entities, signIn, startServer, type Server, type Session } from '../scenarios/harness.ts'
import { asTest } from './world.ts'

interface Bank {
  /** Public tokens exchanged (each one a new, billed Item at Plaid). */
  exchanged: number
  removed: string[]
  /** When set, the next token exchange fails (Plaid refused it). */
  failNext?: boolean
  /** While set, every sync waits for it (a sync in flight). */
  gate?: Promise<void>
  factory: ConnectorFactory
}

// A Plaid-shaped connector whose token exchange takes a moment, like the real network call.
function fakeBank(): Bank {
  const bank: Bank = { exchanged: 0, removed: [], factory: undefined as never }
  bank.factory = (deps) =>
    ({
      describe: () => ({ key: 'plaid', name: 'Bank or card (Plaid)', group: 'banks', provides: ['balances', 'transactions'], freshness: 'minutes', auth: 'link_widget' }),
      begin: async () => ({ kind: 'link_widget', provider: 'plaid', token: 'link-new' }),
      connect: async (input: Record<string, unknown>) => {
        await new Promise((r) => setTimeout(r, 5))
        if (bank.failNext) {
          bank.failNext = false
          throw new Error('INVALID_PUBLIC_TOKEN')
        }
        const n = ++bank.exchanged
        const inst = (input.institution as { institution_id?: string } | undefined)?.institution_id ?? 'ins_x'
        return { secret: { accessToken: `access-${n}`, itemId: `item_${n}` }, config: { itemId: `item_${n}`, institutionId: inst, products: [], displayName: `Bank ${n}` } }
      },
      health: async () => ({ status: 'ok' }),
      sync: async (conn: ConnectionRef) => {
        if (bank.gate) await bank.gate
        const rawRef = await deps.raw.put(conn.id, 'a', `acc_${conn.id}`, {})
        return { events: [{ type: 'account.upsert', connectionId: conn.id, rawRef, externalId: `acc_${conn.id}`, name: 'Checking', accountType: 'depository', currency: 'USD', mask: '0000', institution: 'Bank' }] as NormalizedEvent[], cursor: null, hasMore: false }
      },
      disconnect: async (ref: ConnectionRef) => void bank.removed.push(ref.id),
    }) as unknown as Connector
  return bank
}

/** Connecting needs a passkey and a fresh passkey check (app.ts requirePasskeyCheck). */
async function withPasskey(srv: Server, email: string): Promise<void> {
  const db = srv.booted.services.db
  await asTest(async () => {
    const p = await db.selectFrom('people').select(['id', 'auth_user_id']).where('email', '=', email).executeTakeFirstOrThrow()
    const anyDb = db as unknown as import('kysely').Kysely<Record<string, Record<string, unknown>>>
    await anyDb.insertInto('passkey').values({ id: `pk_${p.id}`, name: 'Mac', publicKey: 'x', userId: p.auth_user_id, credentialID: `cred_${p.id}`, counter: 0, deviceType: 'singleDevice', backedUp: 0, transports: 'internal', createdAt: new Date().toISOString() }).execute()
    await db.insertInto('reauth_events').values({ id: `re_${p.id}`, person_id: p.id, method: 'passkey', at: new Date().toISOString() }).execute()
  })
}

async function person(srv: Server, email: string, company?: string): Promise<Session> {
  const s = await signIn(srv, email, company)
  await withPasskey(srv, email)
  return s
}

let inst = 0
/** A distinct bank each time, so the duplicate-Item guard never steps in. */
const linked = () => {
  inst++
  return { institution: { name: `Bank ${inst}`, institution_id: `ins_${inst}` }, accounts: [{ mask: String(1000 + inst), subtype: 'checking' }], linkSessionId: `ls-${inst}` }
}

const ws = (id: string) => ({ 'x-agfn-workspace': id })
async function start(s: Session, wsId: string) {
  return s.send<{ state?: string; error?: string }>('POST', '/api/connectors/plaid/start', {}, ws(wsId))
}
async function finish(s: Session, wsId: string, state: string) {
  return s.send<{ connectionId?: string; error?: string }>('POST', '/api/connectors/plaid/finish', { state, publicToken: `public-${state.slice(0, 6)}`, ...linked() }, ws(wsId))
}
async function connect(s: Session, wsId: string): Promise<{ status: number; body: { connectionId?: string; error?: string } }> {
  const st = await start(s, wsId)
  if (st.status !== 200) return { status: st.status, body: st.body.error ? { error: st.body.error } : {} }
  return finish(s, wsId, st.body.state as string)
}

async function live(srv: Server, wsId: string): Promise<number> {
  const rows = await asTest(() => srv.booted.services.db.selectFrom('connections').select('id').where('workspace_id', '=', wsId).where('connector_key', '=', 'plaid').where('status', '!=', 'disconnected').execute())
  return rows.length
}

async function boot(cap: number) {
  const bank = fakeBank()
  const srv = await startServer({ connectors: [bank.factory], env: { AGFN_PLAID_MAX_ITEMS_PER_WORKSPACE: String(cap) } })
  expect(srv.booted.services.config.plaidMaxItems).toBe(cap)
  return { srv, bank }
}

describe('red team: Plaid Item cap', () => {
  it('concurrent finishes in one workspace never exchange or keep more Items than the cap', async () => {
    const { srv, bank } = await boot(2)
    try {
      const a = await person(srv, 'tabs@a.example', 'Tabs Co')
      // Five tabs all opened Link while the workspace had room.
      const states: string[] = []
      for (let i = 0; i < 5; i++) {
        const st = await start(a, a.workspaceId)
        expect(st.status, JSON.stringify(st.body)).toBe(200)
        states.push(st.body.state as string)
      }
      const results = await Promise.all(states.map((st) => finish(a, a.workspaceId, st)))
      const ok = results.filter((r) => r.status === 200)
      expect(ok.length).toBe(2)
      for (const r of results.filter((x) => x.status !== 200)) expect(r.status, JSON.stringify(r.body)).toBe(409)
      // No Item beyond the cap was ever created (and billed) at Plaid.
      expect(bank.exchanged).toBe(2)
      expect(await live(srv, a.workspaceId)).toBe(2)
      // And the cap still holds for the next try.
      expect((await connect(a, a.workspaceId)).status).toBe(409)
    } finally {
      await srv.close()
    }
  }, 60_000)

  it('two people, and one person in two workspaces, finishing at once: each workspace stays at its cap', async () => {
    const { srv, bank } = await boot(1)
    try {
      const alice = await person(srv, 'alice@a.example', 'Alice Co')
      const bob = await person(srv, 'bob@b.example', 'Bob Co')
      // Alice is also an admin in Bob's workspace.
      await asTest(() => addMember(srv.booted.services.db, { workspaceId: bob.workspaceId, email: 'alice@a.example', role: 'admin', invitedBy: bob.personId }))
      expect((await alice.send<{ workspaceId: string }>('GET', '/api/me', undefined, ws(bob.workspaceId))).body.workspaceId).toBe(bob.workspaceId)

      const jobs: Array<{ s: Session; w: string; state: string }> = []
      for (const [s, w] of [[alice, alice.workspaceId], [alice, alice.workspaceId], [alice, bob.workspaceId], [alice, bob.workspaceId], [bob, bob.workspaceId], [bob, bob.workspaceId]] as Array<[Session, string]>) {
        const st = await start(s, w)
        expect(st.status, JSON.stringify(st.body)).toBe(200)
        jobs.push({ s, w, state: st.body.state as string })
      }
      const results = await Promise.all(jobs.map((j) => finish(j.s, j.w, j.state)))
      expect(results.filter((r) => r.status === 200).length).toBe(2)
      expect(await live(srv, alice.workspaceId)).toBe(1)
      expect(await live(srv, bob.workspaceId)).toBe(1)
      expect(bank.exchanged).toBe(2)

      // A state started in one workspace can't be spent in the other (it would dodge that workspace's count).
      const st = await start(alice, alice.workspaceId)
      expect(st.status).toBe(409) // Alice Co is full
      await asTest(() => srv.booted.services.db.updateTable('connections').set({ status: 'disconnected' }).where('workspace_id', '=', alice.workspaceId).execute())
      const st2 = await start(alice, alice.workspaceId)
      expect(st2.status).toBe(200)
      const cross = await finish(alice, bob.workspaceId, st2.body.state as string)
      expect(cross.status).toBe(400)
      expect(await live(srv, bob.workspaceId)).toBe(1)
    } finally {
      await srv.close()
    }
  }, 60_000)

  it('disconnect frees a slot, reconnect never takes a second one, and a connect/disconnect loop never exceeds the cap', async () => {
    const { srv, bank } = await boot(2)
    try {
      const a = await person(srv, 'loop@a.example', 'Loop Co')
      const first = await connect(a, a.workspaceId)
      expect(first.status).toBe(200)
      expect((await connect(a, a.workspaceId)).status).toBe(200)
      expect((await connect(a, a.workspaceId)).status).toBe(409)
      const firstId = first.body.connectionId as string

      // Update mode on an existing Item: no new slot, no exchange, and still full afterwards.
      const re = await a.send<{ kind: string; state: string }>('POST', `/api/connections/${firstId}/reconnect`, {})
      expect(re.status, JSON.stringify(re.body)).toBe(200)
      expect((await a.send('POST', `/api/connections/${firstId}/reconnect/finish`, { state: re.body.state })).status).toBe(200)
      expect(bank.exchanged).toBe(2)
      expect(await live(srv, a.workspaceId)).toBe(2)
      expect((await connect(a, a.workspaceId)).status).toBe(409)

      // Disconnect frees the slot (and removes the Item at Plaid); the old connection can't be reconnected back in.
      expect((await a.send('POST', `/api/connections/${firstId}/disconnect`, {})).status).toBe(200)
      expect(bank.removed).toContain(firstId)
      expect(await live(srv, a.workspaceId)).toBe(1)
      expect((await a.send('POST', `/api/connections/${firstId}/reconnect`, {})).status).toBe(404)
      expect((await connect(a, a.workspaceId)).status).toBe(200)
      expect(await live(srv, a.workspaceId)).toBe(2)

      // A quick loop: disconnect one, connect two at once. Never more than the cap live at any point.
      for (let i = 0; i < 4; i++) {
        const rows = await asTest(() => srv.booted.services.db.selectFrom('connections').select('id').where('workspace_id', '=', a.workspaceId).where('connector_key', '=', 'plaid').where('status', '!=', 'disconnected').execute())
        expect((await a.send('POST', `/api/connections/${rows[0]!.id}/disconnect`, { deleteData: i % 2 === 0 })).status).toBe(200)
        const s1 = await start(a, a.workspaceId)
        const s2 = await start(a, a.workspaceId)
        const both = await Promise.all([finish(a, a.workspaceId, s1.body.state as string), finish(a, a.workspaceId, s2.body.state as string)])
        expect(both.filter((r) => r.status === 200).length).toBe(1)
        expect(await live(srv, a.workspaceId)).toBe(2)
      }
      // Every Item ever exchanged beyond the live ones was removed at Plaid.
      expect(bank.exchanged - bank.removed.length).toBe(2)
    } finally {
      await srv.close()
    }
  }, 60_000)

  it('a disconnect that lands while a sync is in flight stays disconnected (and keeps its slot free)', async () => {
    const { srv, bank } = await boot(1)
    try {
      const a = await person(srv, 'inflight@a.example', 'Inflight Co')
      const c = await connect(a, a.workspaceId)
      expect(c.status).toBe(200)
      const id = c.body.connectionId as string
      let open!: () => void
      bank.gate = new Promise<void>((r) => (open = r))
      const syncing = asTest(() => srv.booted.services.sync.sync(id)).catch(() => undefined)
      await new Promise((r) => setTimeout(r, 20))
      expect((await a.send('POST', `/api/connections/${id}/disconnect`, {})).status).toBe(200)
      open()
      bank.gate = undefined
      await syncing
      const row = await asTest(() => srv.booted.services.db.selectFrom('connections').select(['status', 'secret_enc']).where('id', '=', id).executeTakeFirstOrThrow())
      expect(row.status).toBe('disconnected')
      expect(row.secret_enc).toBeNull()
      expect(await live(srv, a.workspaceId)).toBe(0)
      expect((await connect(a, a.workspaceId)).status).toBe(200)
    } finally {
      await srv.close()
    }
  }, 60_000)

  it('the cap is per workspace: no cap set means no limit (self-host)', async () => {
    const bank = fakeBank()
    const srv = await startServer({ connectors: [bank.factory] })
    try {
      expect(srv.booted.services.config.plaidMaxItems).toBeUndefined()
      const a = await person(srv, 'free@a.example', 'Free Co')
      const E = await entities(a)
      expect(E['Free Co']).toBeTruthy()
      const states = await Promise.all([0, 1, 2].map(() => start(a, a.workspaceId)))
      const done = await Promise.all(states.map((st) => finish(a, a.workspaceId, st.body.state as string)))
      expect(done.every((r) => r.status === 200)).toBe(true)
      expect(await live(srv, a.workspaceId)).toBe(3)
    } finally {
      await srv.close()
    }
  }, 60_000)

  it('the finish lock is released when the exchange fails, a stale lock expires, and a held one answers busy', async () => {
    const { srv, bank } = await boot(5)
    try {
      const a = await person(srv, 'lock@a.example', 'Lock Co')
      const db = srv.booted.services.db
      const lock = () => asTest(() => db.selectFrom('settings').select(['value_json', 'updated_at']).where('workspace_id', '=', a.workspaceId).where('key', '=', 'lock:plaid_finish').executeTakeFirst())
      // Plaid refuses the token: the lock is gone and the next try goes through.
      bank.failNext = true
      expect((await connect(a, a.workspaceId)).status).toBe(422)
      expect(await lock()).toBeUndefined()
      expect((await connect(a, a.workspaceId)).status).toBe(200)
      expect(await lock()).toBeUndefined()
      // A lock left by a crashed instance more than two minutes ago is cleared, not waited on.
      const put = (at: Date) => asTest(() => db.insertInto('settings').values({ workspace_id: a.workspaceId, key: 'lock:plaid_finish', value_json: '"crashed"', updated_at: at.toISOString() }).execute())
      await put(new Date(Date.now() - 3 * 60_000))
      const t = Date.now()
      expect((await connect(a, a.workspaceId)).status).toBe(200)
      expect(Date.now() - t).toBeLessThan(5_000)
      expect(await lock()).toBeUndefined()
      // A live lock held elsewhere: after the wait, a clear 409 busy (no exchange), and that lock is left alone.
      await put(new Date())
      const before = bank.exchanged
      const waitStart = Date.now()
      const busy = await connect(a, a.workspaceId)
      expect([busy.status, busy.body.error]).toEqual([409, 'busy'])
      expect(Date.now() - waitStart).toBeLessThan(30_000)
      expect(bank.exchanged).toBe(before)
      expect((await lock())?.value_json).toBe('"crashed"')
    } finally {
      await srv.close()
    }
  }, 90_000)

})
