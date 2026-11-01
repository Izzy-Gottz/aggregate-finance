// Threat model #3/#9 (a key's scope): a key for Acme with balances + transactions only tries to reach another company
// in the same workspace, the owner's Personal space, and data types it wasn't given — by name, by id, and through
// every write that names a second company or record. Nothing may answer or change.
import { describe, expect, it } from 'vitest'
import { accountIds, connectAi, connectProvider, entities, READ_WRITE_ALL, signIn, startServer } from '../scenarios/harness.ts'

const usd = (m: number) => ({ minor: m, currency: 'USD' })
const OUTSIDE = ['NEXSECRET', '2468.13', 'PERSECRET', '1357.91', 'INVSECRET', '8642.97']
const leak = (x: unknown, sent: unknown) => OUTSIDE.find((m) => JSON.stringify(x).includes(m) && !JSON.stringify(sent).includes(m)) ?? null

describe('red team: grant scope escape (company and data type)', () => {
  it('an Acme balances+transactions key reaches nothing else', async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'owner@scope.example', 'Acme')
      expect((await s.post('/api/entities', { name: 'Bluebird', kind: 'company' })).status).toBe(201)
      const E = await entities(s)
      const bank = await connectProvider(srv, s, 'plaid', { name: 'Chase' })
      bank.push((c) => [
        { type: 'account.upsert', externalId: 'a', connectionId: c, name: 'Acme Checking', accountType: 'depository', currency: 'USD', institution: 'Chase' },
        { type: 'account.upsert', externalId: 'n', connectionId: c, name: 'Nex Checking', accountType: 'depository', currency: 'USD', institution: 'Chase' },
        { type: 'account.upsert', externalId: 'p', connectionId: c, name: 'Personal Checking', accountType: 'depository', currency: 'USD', institution: 'Chase' },
        { type: 'txn.upsert', externalId: 'ta', connectionId: c, accountExternalId: 'a', date: '2026-10-02', amount: usd(-10_000), status: 'posted', counterparty: 'Coffee', rawText: 'COFFEE' },
        { type: 'txn.upsert', externalId: 'tn', connectionId: c, accountExternalId: 'n', date: '2026-10-02', amount: usd(-246_813), status: 'posted', counterparty: 'NEXSECRET Vendor', rawText: 'NEXSECRET' },
        { type: 'txn.upsert', externalId: 'tp', connectionId: c, accountExternalId: 'p', date: '2026-10-02', amount: usd(-135_791), status: 'posted', counterparty: 'PERSECRET Doctor', rawText: 'PERSECRET' },
      ])
      expect((await bank.sync()).status).toBe('ok')
      const A = await accountIds(srv, bank.id)
      expect((await s.post('/api/accounts/assign', { assignments: [{ accountId: A.a, entityId: E.Acme }, { accountId: A.n, entityId: E.Bluebird }, { accountId: A.p, entityId: 'personal' }] })).status).toBe(200)
      const qb = await connectProvider(srv, s, 'quickbooks', { entityId: E.Acme, name: 'QuickBooks' })
      qb.push((c) => [{ type: 'invoice.upsert', externalId: 'i', connectionId: c, direction: 'receivable', number: 'A-1', counterparty: 'INVSECRET Customer', issueDate: '2026-09-01', dueDate: '2026-12-01', total: usd(864_297), amountPaid: usd(0), status: 'open' }] as never)
      expect((await qb.sync()).status).toBe('ok')

      const owner = await connectAi(srv, s, { ...READ_WRITE_ALL, dataTypes: [...READ_WRITE_ALL.dataTypes, 'personal'] }, 'Owner bot')
      const ids = async (company: string) => (await owner.call<{ transactions: Array<{ id: string }> }>('search_transactions', { company })).transactions.map((t) => t.id)
      const [acmeTxn] = await ids('Acme')
      const [nexTxn] = await ids('Bluebird')
      const [perTxn] = await ids('Personal')
      const acmeInvoice = (await owner.call<{ owed_to_you: { invoices: Array<{ id: string }> } }>('search_invoices', { company: 'Acme', side: 'owed_to_you' })).owed_to_you.invoices[0]?.id
      expect(acmeTxn && nexTxn && perTxn && acmeInvoice).toBeTruthy()
      const snapshot = async () => JSON.stringify(await Promise.all(['Acme', 'Bluebird', 'Personal'].map((c) => owner.call('search_transactions', { company: c, response_format: 'detailed' }))))
      const before = await snapshot()

      const key = await connectAi(srv, s, { entityIds: [E.Acme as string], dataTypes: ['balances', 'transactions'], write: true, reviewMode: 'instant', expiresAt: READ_WRITE_ALL.expiresAt }, 'Scoped bot')
      // The tool list is the same for every connection; tools outside this grant are refused on every call (or never
      // reach the handler: an argument error comes first). Either way, nothing is read or written.
      for (const t of ['search_invoices', 'add_invoice', 'record_payment', 'get_payroll', 'get_cap_table', 'record_equity_event', 'list_documents', 'get_reports', 'create_bucket']) {
        const r = (await key.try(t, { company: 'Acme' }).catch((e: unknown) => ({ isError: true, thrown: String(e) }))) as { isError?: boolean; data?: { error?: string }; thrown?: string }
        expect(r.isError, t).toBe(true)
        expect(r.data?.error === 'forbidden' || /invalid|validation/i.test(JSON.stringify(r)), t).toBe(true)
      }

      const k = (n: string) => `scope-${n}-000001`
      const attempts: Array<[string, Record<string, unknown>]> = [
        ...['Bluebird', 'Personal'].flatMap((c): Array<[string, Record<string, unknown>]> => [
          ['get_metric', { metric: 'cash', company: c }],
          ['search_transactions', { company: c }],
          ['list_accounts', { company: c }],
          ['get_overview', { company: c }],
          ['get_owner_balance', { company: c }],
          ['list_upcoming', { company: c }],
          ['add_entry', { company: c, kind: 'expense', amount: { amount: '1.00', currency: 'USD' }, date: '2026-10-05', paid_by: c, idempotency_key: k(`add-${c}`) }],
          ['create_rule', { company: c, match: { counterparty: 'X' }, set: { category: 'software' }, idempotency_key: k(`rule-${c}`) }],
        ]),
        ['search_transactions', { account_id: A.n }],
        ['get_record', { id: nexTxn }],
        ['get_record', { id: perTxn }],
        ['get_record', { id: acmeInvoice }],
        ['get_counterparty', { name_or_id: 'INVSECRET Customer' }],
        ['get_counterparty', { name_or_id: 'NEXSECRET Vendor' }],
        ['update_record', { id: nexTxn, category: 'software', idempotency_key: k('upd-nex') }],
        ['void_record', { id: perTxn, reason: 'cleanup', idempotency_key: k('void-per') }],
        ['update_record', { id: acmeTxn, company: 'Bluebird', idempotency_key: k('move') }],
        ['update_record', { id: acmeTxn, for_company: 'Bluebird', idempotency_key: k('for') }],
        ['update_record', { id: acmeTxn, link_to: { record_id: nexTxn, type: 'transfer' }, idempotency_key: k('link-nex') }],
        ['update_record', { id: acmeTxn, link_to: { record_id: acmeInvoice, type: 'invoice_payment' }, idempotency_key: k('link-inv') }],
        ['add_entry', { company: 'Acme', kind: 'intercompany', amount: { amount: '1.00', currency: 'USD' }, date: '2026-10-05', paid_by: 'Acme', to_company: 'Bluebird', idempotency_key: k('ic') }],
        ['add_entry', { company: 'Acme', kind: 'expense', amount: { amount: '1.00', currency: 'USD' }, date: '2026-10-05', paid_by: 'Personal', idempotency_key: k('paid-per') }],
        ['add_entry', { company: 'Acme', kind: 'transfer', amount: { amount: '1.00', currency: 'USD' }, date: '2026-10-05', paid_by: 'Acme', account_id: A.a, to_account_id: A.n, idempotency_key: k('xfer') }],
        ['create_rule', { company: 'Acme', match: { counterparty: 'Coffee' }, set: { company: 'Bluebird' }, apply_to_existing: true, idempotency_key: k('rule-move') }],
        ['create_rule', { company: 'Acme', match: { account_id: A.n }, set: { category: 'software' }, idempotency_key: k('rule-acct') }],
      ]
      for (const [tool, args] of attempts) {
        const r = await key.try(tool, args).catch((e: unknown) => ({ isError: true, text: String(e), data: undefined }))
        const status = (r.data as { status?: string } | undefined)?.status
        expect(!r.isError && (status === 'applied' || status === 'pending_review'), `${tool} ${JSON.stringify(args)} → ${r.text.slice(0, 200)}`).toBe(false)
        if (!r.isError && tool.startsWith('get_') === false && tool !== 'search_transactions' && tool !== 'list_accounts' && tool !== 'list_upcoming') expect(r.isError, `${tool} → ${r.text.slice(0, 200)}`).toBe(true)
        expect(leak(r, args), `${tool} ${JSON.stringify(args)} → ${r.text.slice(0, 200)}`).toBeNull()
      }
      // The overview with no company only lists Acme.
      const ov = await key.call<{ companies: Array<{ company: string }> }>('get_overview', {})
      expect(ov.companies.map((c) => c.company)).toEqual(['Acme'])
      expect(await snapshot()).toBe(before)
    } finally {
      await srv.close()
    }
  }, 120_000)
})
