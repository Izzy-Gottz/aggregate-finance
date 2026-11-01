// Threat model #6 (cross-tenant access): an attacker who is a real user of the same server guesses or learns ids from
// another workspace and aims every session route, MCP tool and REST mirror at them. Every call must fail without
// revealing anything, and the victim's data and settings must be exactly as before.
import { describe, expect, it } from 'vitest'
import { withWorkspace } from '@agfn/db'
import { startServer } from '../scenarios/harness.ts'
import { attackerWorld, leaks, PDF, upload, victimState, victimWorld } from './world.ts'

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
})
