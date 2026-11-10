// Threat model #6 (cross-tenant access): an attacker who is a real user of the same server guesses or learns ids from
// another workspace and aims every session route, MCP tool and REST mirror at them. Every call must fail without
// revealing anything, and the victim's data and settings must be exactly as before.
import { describe, expect, it } from 'vitest'
import { withWorkspace } from '@agfn/db'
import { signIn, startServer } from '../scenarios/harness.ts'
import { asTest, attackerWorld, leaks, PDF, upload, victimState, victimWorld } from './world.ts'

describe('red team: cross-workspace id guessing', () => {
  it('no session route, tool or REST call reaches another workspace', async () => {
    const srv = await startServer()
    try {
      const v = await victimWorld(srv)
      const m = await attackerWorld(srv)
      const before = await victimState(srv, v)

      // ---- session routes with the victim's ids ----
      const gets = [
        `/api/entities/${v.entityId}`,
        `/api/entities/${v.entityId}/transactions`,
        `/api/entities/${v.entityId}/equity`,
        `/api/entities/${v.entityId}/equity/ocf`,
        `/api/entities/${v.personalId}`,
        `/api/connections/${v.bankId}`,
        `/api/documents/${v.documentId}/file`,
        `/api/buckets/${v.bucketId}`,
        `/api/ai/${v.grantId}`,
        `/api/inbound/${v.entityId}`,
      ]
      for (const path of gets) {
        const r = await m.s.get(path)
        expect(r.status, `GET ${path}`).toBeGreaterThanOrEqual(400)
        expect(leaks(r.body), `GET ${path}`).toBeNull()
      }
      const posts: Array<[string, unknown]> = [
        [`/api/connections/${v.bankId}/sync`, {}],
        [`/api/connections/${v.bankId}/disconnect`, {}],
        ['/api/accounts/assign', { assignments: [{ accountId: v.accountId, entityId: m.entityId }] }],
        ['/api/accounts/dismiss-duplicate', { subjectId: v.accountId, relatedId: v.personalId, dupKey: 'x' }],
        ['/api/accounts/mark-duplicate', { duplicateId: v.accountId, ofId: v.personalId }],
        [`/api/entities/${v.entityId}/equity/events`, { kind: 'issuance', date: '2026-01-01', stakeholder: 'Mallory', shares: 1_000_000 }],
        [`/api/ai/${v.grantId}/pause`, {}],
        [`/api/ai/${v.grantId}/revoke`, {}],
        [`/api/review/${v.reviewId}`, { action: 'reject' }],
        [`/api/records/${v.txnId}/undo`, {}],
        [`/api/inbound/${v.entityId}/rotate`, {}],
        ['/api/entries/cash', { entityId: v.entityId, amount: { minor: 100, currency: 'USD' }, date: '2026-10-05', direction: 'in', note: 'x' }],
      ]
      for (const [path, body] of posts) {
        const r = await m.s.post(path, body)
        expect(r.status, `POST ${path}`).toBeGreaterThanOrEqual(400)
        expect(leaks(r.body), `POST ${path}`).toBeNull()
      }
      const register = await m.s.post(`/api/entities/${v.entityId}/payroll-register`, undefined, { headers: { 'content-type': 'text/csv' }, raw: 'Check date,Gross pay,Employer taxes,Net pay\n10/01/2026,100.00,1.00,90.00\n' })
      expect(register.status).toBeGreaterThanOrEqual(400)
      expect((await upload(m.s, v.entityId, 'x.pdf', PDF)).status).toBeGreaterThanOrEqual(400)
      for (const [method, path, body] of [
        ['PATCH', `/api/ai/${v.grantId}`, { name: 'pwned' }],
        ['PATCH', `/api/buckets/${v.bucketId}`, { name: 'pwned' }],
        ['PUT', `/api/inbound/${v.entityId}`, { allowedSenders: ['@b.example'] }],
      ] as const) {
        const r = await m.s.send(method, path, body)
        expect(r.status, `${method} ${path}`).toBeGreaterThanOrEqual(400)
        expect(leaks(r.body), `${method} ${path}`).toBeNull()
      }
      // Asking for the victim's workspace by header falls back to the attacker's own.
      const ws = await m.s.send('GET', '/api/workspace', undefined, { 'x-agfn-workspace': v.ws })
      expect(leaks(ws.body)).toBeNull()

      // ---- MCP tools with the victim's ids (the attacker's key can do anything in its own workspace) ----
      const attempts: Array<[string, Record<string, unknown>]> = [
        ['get_record', { id: v.txnId }],
        ['get_record', { id: v.invoiceId }],
        ['get_record', { id: v.documentId }],
        ['get_record', { id: v.bucketId }],
        ['get_bucket', { id: v.bucketId }],
        ['get_document', { id: v.documentId }],
        ['get_counterparty', { name_or_id: 'VICTIMSECRET Vendor' }],
        ['search_transactions', { account_id: v.accountId }],
        ['get_metric', { metric: 'cash', company: 'Victim Co' }],
        ['update_record', { id: v.txnId, category: 'software', idempotency_key: 'xws-upd-00001' }],
        ['update_record', { id: m.ownTxnId, link_to: { record_id: v.txnId, type: 'transfer' }, idempotency_key: 'xws-link-0001' }],
        ['void_record', { id: v.txnId, reason: 'cleanup', idempotency_key: 'xws-void-0001' }],
        ['update_bucket', { bucket_id: v.bucketId, name: 'pwned', idempotency_key: 'xws-bkt-00001' }],
        ['resolve_review_item', { id: v.reviewId, decision: 'reject', idempotency_key: 'xws-rev-00001' }],
        ['record_payment', { company: 'Mallory LLC', side: 'owed_to_you', amount: { amount: '1.00', currency: 'USD' }, date: '2026-10-05', applications: [{ invoice_id: v.invoiceId, amount: { amount: '1.00', currency: 'USD' } }], idempotency_key: 'xws-pay-00001' }],
        ['record_payment', { company: 'Mallory LLC', side: 'owed_to_you', amount: { amount: '1.00', currency: 'USD' }, date: '2026-10-05', applications: [{ invoice_id: m.ownInvoiceId, amount: { amount: '1.00', currency: 'USD' } }], bank_transaction_id: v.txnId, idempotency_key: 'xws-pay-00002' }],
        ['add_entry', { company: 'Mallory LLC', kind: 'expense', amount: { amount: '1.00', currency: 'USD' }, date: '2026-10-05', paid_by: 'Mallory LLC', account_id: v.accountId, idempotency_key: 'xws-add-00001' }],
        ['add_entry', { company: 'Mallory LLC', kind: 'expense', amount: { amount: '1.00', currency: 'USD' }, date: '2026-10-05', paid_by: 'Mallory LLC', bucket_id: v.bucketId, idempotency_key: 'xws-add-00002' }],
        ['record_equity_event', { company: 'Mallory LLC', kind: 'safe', date: '2026-10-01', stakeholder: 'X', amount: { amount: '1.00', currency: 'USD' }, bank_transaction_id: v.inflowId, idempotency_key: 'xws-eq-000001' }],
        ['create_rule', { company: 'Mallory LLC', match: { account_id: v.accountId }, set: { category: 'software' }, apply_to_existing: true, idempotency_key: 'xws-rule-0001' }],
      ]
      for (const [tool, args] of attempts) {
        const r = await m.ai.try(tool, args).catch((e: unknown) => ({ isError: true, text: String(e), data: undefined }))
          const applied = !r.isError && (r.data as { status?: string } | undefined)?.status === 'applied'
        expect(applied && tool !== 'search_transactions' && tool !== 'get_counterparty' && tool !== 'get_metric', `${tool} ${JSON.stringify(args)} → ${r.text.slice(0, 200)}`).toBe(false)
        expect(leaks(r, args), `${tool} ${JSON.stringify(args)}`).toBeNull()
      }

      // Nothing half-applied on the attacker's side either (e.g. an equity event recorded before its bank link failed).
      const cap = await m.ai.try('get_cap_table', { company: 'Mallory LLC' }).catch(() => ({ isError: true, text: '', data: undefined }))
      expect(JSON.stringify(cap.data ?? {})).not.toContain('"X"')
      const pays = await m.ai.call<{ owed_to_you: { invoices: Array<{ paid: { amount: string } }> } }>('search_invoices', { company: 'Mallory LLC', side: 'owed_to_you' })
      expect(pays.owed_to_you.invoices.map((i) => i.paid.amount)).toEqual(['0.00'])

      // ---- the REST mirror with the attacker's key ----
      for (const path of [`/v1/records/${v.txnId}`, `/v1/records/${v.invoiceId}`, `/v1/transactions?account_id=${v.accountId}`, `/v1/buckets/${v.bucketId}`, `/v1/documents/${v.documentId}`, `/v1/metrics/cash?company=Victim%20Co`]) {
        const res = await srv.app.request(path, { headers: { authorization: `Bearer ${m.ai.key}` } })
        const text = await res.text()
        expect(leaks(text, decodeURIComponent(path)), `GET ${path} (${res.status}): ${text.slice(0, 200)}`).toBeNull()
      }

      expect(await victimState(srv, v)).toEqual(before)

      // With row-level security on (AGFN_TEST_PG_RLS=1), the database refuses too: inside the attacker's workspace
      // the victim's rows don't exist, and writes to them change nothing — a second wall behind can().
      if (process.env.AGFN_TEST_PG_RLS === '1') {
        const db = srv.booted.services.db
        const mws = m.s.workspaceId
        await withWorkspace(mws, async () => {
          for (const [table, id] of [['ledger_records', v.txnId], ['documents', v.documentId], ['connections', v.bankId], ['accounts', v.accountId], ['entities', v.entityId]] as const) {
            expect(await db.selectFrom(table as never).select('id' as never).where('id' as never, '=', id as never).execute(), table).toEqual([])
          }
          const upd = await db.updateTable('connections').set({ status: 'disconnected' }).where('id', '=', v.bankId).executeTakeFirst()
          expect(Number(upd.numUpdatedRows ?? 0)).toBe(0)
          const del = await db.deleteFrom('documents').where('id', '=', v.documentId).executeTakeFirst()
          expect(Number(del.numDeletedRows ?? 0)).toBe(0)
        })
        expect(await victimState(srv, v)).toEqual(before)
      }
    } finally {
      await srv.close()
    }
  }, 120_000)

  // Threat model #6, the tables outside row-level security (docs/security/threat-model.md): people, workspaces and the
  // membership link aren't workspace_id tables, so can() in app code is their only backstop. An attacker who is a real
  // user aims the people-management and workspace-scoped routes at the victim's person and workspace ids; every attempt
  // must be refused or fall back to the attacker's own, and the victim's membership must be untouched. (The member
  // invite link /api/invites/:id is a 144-bit capability URL, like the export link in #10, not an id-guessing surface,
  // so it is out of scope here; friend-invite ids have no read-by-id route at all — covered in the next test.)
  it('another workspace’s people and workspace stay unreachable by id', async () => {
    const srv = await startServer()
    try {
      const v = await victimWorld(srv)
      const m = await attackerWorld(srv)
      const db = srv.booted.services.db

      // The victim invites a teammate, so there is a pending person and a membership to aim at.
      const invited = await v.s.post<{ id?: string }>('/api/people', { email: 'victim-pawn@a.example', role: 'employee', entityIds: 'all' })
      expect(invited.status, JSON.stringify(invited.body)).toBeLessThan(400)
      const victimOwnerId = (await asTest(() => db.selectFrom('people').select('id').where('email', '=', 'victim@a.example').executeTakeFirstOrThrow())).id
      const invitedId = (await asTest(() => db.selectFrom('people').select('id').where('email', '=', 'victim-pawn@a.example').executeTakeFirstOrThrow())).id
      const beforeMembers = await asTest(() => db.selectFrom('memberships').select(['person_id', 'role', 'revoked_at']).where('workspace_id', '=', v.ws).orderBy('person_id').execute())
      const beforeState = await victimState(srv, v)

      // ---- people-management routes aimed at the victim's person ids (the attacker is owner of their own workspace) ----
      for (const [method, path, body] of [
        ['PATCH', `/api/people/${victimOwnerId}`, { role: 'employee' }],
        ['PATCH', `/api/people/${invitedId}`, { name: 'pwned', role: 'admin' }],
        ['DELETE', `/api/people/${victimOwnerId}`, undefined],
        ['DELETE', `/api/people/${invitedId}`, undefined],
        ['POST', `/api/people/${invitedId}/resend`, {}],
      ] as const) {
        const r = await m.s.send(method, path, body)
        expect(r.status, `${method} ${path}`).toBeGreaterThanOrEqual(400)
        expect(leaks(r.body), `${method} ${path}`).toBeNull()
        expect(JSON.stringify(r.body).includes('victim@a.example') || JSON.stringify(r.body).includes('victim-pawn@a.example'), `${method} ${path} leaked a victim email`).toBe(false)
      }

      // ---- workspace-scoped reads, pointed at the victim's workspace by header: must fall back to the attacker's own ----
      for (const path of ['/api/preferences', '/api/workspace', '/api/usage']) {
        const r = await m.s.send('GET', path, undefined, { 'x-agfn-workspace': v.ws })
        const body = JSON.stringify(r.body)
        expect(leaks(r.body), `GET ${path}`).toBeNull()
        expect(body.includes('victim@a.example') || body.includes('victim-pawn@a.example'), `GET ${path} leaked a victim email`).toBe(false)
      }

      // An unknown member-invite id is a plain 404 (the capability itself is a 144-bit secret, tested as a control).
      const bogus = await m.s.get('/api/invites/' + 'A'.repeat(24))
      expect(bogus.status).toBe(404)
      expect(leaks(bogus.body)).toBeNull()

      // ---- the REST mirror and MCP expose no people/workspace-by-id surface ----
      for (const path of ['/v1/people', '/v1/members', `/v1/workspaces/${v.ws}`, `/v1/people/${victimOwnerId}`]) {
        const res = await srv.app.request(path, { headers: { authorization: `Bearer ${m.ai.key}` } })
        const text = await res.text()
        expect(leaks(text, path), `GET ${path}`).toBeNull()
        expect(text.includes('victim@a.example'), `GET ${path}`).toBe(false)
      }
      const who = await m.ai.try('whoami', {}).catch(() => ({ isError: true, text: '', data: undefined }))
      expect(JSON.stringify(who.data ?? who)).not.toContain('Victim Co')
      expect(JSON.stringify(who.data ?? who)).not.toContain('victim@a.example')

      // ---- nothing changed in the victim's workspace ----
      expect(await asTest(() => db.selectFrom('memberships').select(['person_id', 'role', 'revoked_at']).where('workspace_id', '=', v.ws).orderBy('person_id').execute())).toEqual(beforeMembers)
      expect(await victimState(srv, v)).toEqual(beforeState)

      // With RLS on, the membership link (a workspace_id table) is a second wall: the victim's memberships don't exist
      // inside the attacker's workspace. people and workspaces are NOT workspace_id tables, so RLS doesn't cover them —
      // that is the point of the threat-model note, and can() above is their backstop.
      if (process.env.AGFN_TEST_PG_RLS === '1') {
        await withWorkspace(m.s.workspaceId, async () => {
          expect(await db.selectFrom('memberships').select('id').where('workspace_id', '=', v.ws).execute()).toEqual([])
        })
      }
    } finally {
      await srv.close()
    }
  }, 120_000)

  // friend_* invites are person-scoped and store only hashed addresses; there is no read-by-id route, so B's ids give
  // no surface to aim at. The only GET returns the caller's own invite link, derived from the session.
  it('friend invites have no cross-person read surface', async () => {
    const srv = await startServer({ env: { AGFN_FRIEND_INVITES: '1' } })
    try {
      const a = await signIn(srv, 'alice@a.example', 'Alice Co')
      const b = await signIn(srv, 'bob@b.example', 'Bob Co')
      const aLink = (await a.get<{ link?: string }>('/api/friend-invite')).body.link ?? ''
      const bLink = (await b.get<{ link?: string }>('/api/friend-invite')).body.link ?? ''
      // Each person's link carries only their own code; it is session-derived and takes no id, so B can't request A's.
      expect(aLink).toMatch(/from=[a-f0-9]{16}$/)
      expect(bLink).toMatch(/from=[a-f0-9]{16}$/)
      expect(aLink).not.toEqual(bLink)
      const aCode = /from=([a-f0-9]{16})/.exec(aLink)?.[1] ?? 'a'
      expect((await b.get<{ link?: string }>('/api/friend-invite')).body.link ?? '').not.toContain(aCode)
      // The opt-out/stop link is a signed capability: a guessed hash and signature are refused, so an address can't be
      // opted out (or its state read) by anyone who doesn't hold the signed link.
      const stop = await b.send('POST', '/invites/stop', { h: 'a'.repeat(64), s: 'b'.repeat(64) })
      expect(stop.status).toBeGreaterThanOrEqual(400)
    } finally {
      await srv.close()
    }
  }, 120_000)
})
