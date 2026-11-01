// FinanceReader + RecordWriter over the ledger: what S7's MCP tools see and do. Runs on memory, SQLite and Postgres.
import { listReviewItems } from './review.ts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WriteRejected, type Provenance, type WriteCommand } from '@agfn/contracts'
import { createFinance, type Finance } from './finance.ts'
import { invoice, makeKit, snapshot, txn, usd, type Backend, type Kit } from './test-kit.ts'

const backends: Backend[] = ['memory', 'sqlite', 'pglite']

let seq = 0
function prov(over: Partial<Provenance> = {}): Provenance {
  return { writeRequestId: `wr_${++seq}_${Math.random().toString(36).slice(2, 8)}`, actorKind: 'agent', personId: 'person-owner', grantId: 'grant-claude', label: 'Claude · Yisrael', ...over }
}

describe.each(backends)('finance reader + writer (%s)', (backend) => {
  let k: Kit
  let f: Finance
  let acme: string
  let me: string
  let scope: { workspaceId: string; entityIds: string[] }

  beforeEach(async () => {
    k = await makeKit(backend)
    acme = await k.company('Acme')
    me = await k.personal('Yisrael')
    // The kit gives the personal entity a random owner; S7 resolves "owner" to the person behind the grant.
    const personal = (await k.engine.directory.listEntities(k.ws)).find((e) => e.id === me)
    owner = personal?.ownerPersonId as string
    f = createFinance(k.engine)
    scope = { workspaceId: k.ws, entityIds: [acme] }
  })
  afterEach(async () => {
    await k.close()
  })
  let owner = ''

  const cmd = (op: WriteCommand['op'], payload: Record<string, unknown>, entityId = acme): WriteCommand => ({ op, workspaceId: k.ws, entityId, payload })
  const entry = (kind: string, minor: number, extra: Record<string, unknown> = {}) =>
    cmd('add_entry', { kind, amountMinor: minor, currency: 'USD', date: '2026-10-02', paidBy: { type: 'entity', entityId: acme }, forEntityId: acme, counterparty: null, category: null, bucketId: null, accountId: null, toAccountId: null, toEntityId: null, description: null, ...extra })

  describe('writes', () => {
    it('cash income told by an AI: revenue, cash on hand, provenance, counted in metrics', async () => {
      const res = await f.writer.apply(entry('cash_income', 80_000, { counterparty: 'Farmers market' }), prov())
      expect(res).toMatchObject({ recordType: 'entry', cashImpact: [{ entityId: acme, amount: usd(80_000) }], possibleDuplicates: [] })
      expect(await k.bal(acme, 'revenue')).toBe(-80_000)
      const rec = await f.reader.getRecord(k.ws, res.recordId)
      expect(rec).toMatchObject({ type: 'entry', entityId: acme, dataType: 'transactions', addedBy: { kind: 'agent', name: 'Claude · Yisrael', grantId: 'grant-claude' }, voided: false })
      const cash = await f.reader.metric('cash', { workspaceId: k.ws, entityIds: [acme] })
      expect(cash.value).toEqual(usd(80_000))
      expect(cash.agentEntriesIncluded).toBe(1)
      // Same write request again is the same record (idempotent end to end).
      const again = await f.writer.apply(entry('cash_income', 80_000), { ...prov(), writeRequestId: (await k.engine.store.getRecord(k.ws, res.recordId))?.provenance?.writeRequestId as string })
      expect(again.recordId).toBe(res.recordId)
    })

    it('an expense the owner paid personally: the company owes the owner', async () => {
      const res = await f.writer.apply(entry('expense', 30_000, { paidBy: { type: 'owner', personId: owner }, category: 'Cloud and infrastructure', counterparty: 'AWS' }), prov({ personId: owner }))
      expect(res.cashImpact).toEqual([])
      expect(await k.bal(acme, 'cloud')).toBe(30_000)
      expect(await k.bal(acme, `owner_payable:${me}`)).toBe(-30_000)
      const ob = await f.reader.ownerBalances({ workspaceId: k.ws, entityIds: [acme] }, owner)
      expect(ob).toEqual([expect.objectContaining({ entityId: acme, balance: usd(30_000), unreimbursedExpenses: usd(30_000), loans: usd(0) })])
      // The company pays it back in cash.
      await f.writer.apply(entry('reimbursement', 30_000), prov({ personId: owner }))
      expect(await k.bal(acme, `owner_payable:${me}`)).toBe(0)
    })

    it('owner money in: a loan, never revenue', async () => {
      await f.writer.apply(entry('owner_loan', 1_000_000, { paidBy: { type: 'owner', personId: owner } }), prov({ personId: owner }))
      expect(await k.bal(acme, `owner_payable:${me}`)).toBe(-1_000_000)
      expect(await k.bal(acme, 'revenue')).toBe(0)
      await expect(f.writer.apply(entry('owner_contribution', 5_000), prov())).rejects.toMatchObject({ code: 'invalid' })
    })

    it('a transfer between own accounts posts both legs and links them', async () => {
      const a = await k.account({ entityId: acme, name: 'Checking' })
      const b = await k.account({ entityId: acme, name: 'Savings' })
      const res = await f.writer.apply(entry('transfer', 50_000, { accountId: a.id, toAccountId: b.id }), prov())
      expect(res.cashImpact).toEqual([
        { entityId: acme, amount: usd(-50_000) },
        { entityId: acme, amount: usd(50_000) },
      ])
      expect(await k.bal(acme, 'clearing_transfers')).toBe(0)
      expect(await k.bal(acme, 'uncategorized_expense')).toBe(0)
    })

    it('rejects unknown categories, accounts of other companies and currency mismatches', async () => {
      await expect(f.writer.apply(entry('expense', 100, { category: 'Yachts' }), prov())).rejects.toBeInstanceOf(WriteRejected)
      const other = await k.company('Other')
      const theirs = await k.account({ entityId: other })
      await expect(f.writer.apply(entry('expense', 100, { accountId: theirs.id }), prov())).rejects.toMatchObject({ code: 'wrong_company' })
      await expect(f.writer.apply(entry('expense', 100, { currency: 'EUR' }), prov())).rejects.toMatchObject({ code: 'currency_mismatch' })
      expect(await k.engine.store.listRecords(k.ws, { eventTypes: ['txn.upsert'] })).toEqual([])
    })

    it('an AI expense that a card later reports is a possible duplicate', async () => {
      const card = await k.account({ entityId: acme, type: 'credit_card' })
      await k.engine.post(k.ws, txn(card, '2026-10-02', -4_200, { counterparty: 'Uber' }))
      const res = await f.writer.apply(entry('expense', 4_200, { counterparty: 'Uber', category: 'travel' }), prov())
      expect(res.possibleDuplicates).toHaveLength(1)
    })

    it('invoices, payments against a bank row, overpayment and duplicates', async () => {
      const bank = await k.account({ entityId: acme })
      const inv = await f.writer.apply(
        cmd('add_invoice', { direction: 'receivable', counterparty: 'Globex', number: 'INV-9', issueDate: '2026-09-01', dueDate: '2026-09-30', currency: 'USD', lines: [{ description: 'Work', quantity: 1, unitPriceMinor: 100_000, amountMinor: 100_000 }], taxMinor: 0, totalMinor: 100_000, linesMismatchMinor: 0, status: 'open', note: null }),
        prov(),
      )
      expect(inv.recordType).toBe('invoice')
      expect(await k.bal(acme, 'ar', 'accrual')).toBe(100_000)
      const dup = await f.writer.apply(
        cmd('add_invoice', { direction: 'receivable', counterparty: 'Globex', number: 'INV-9', issueDate: '2026-09-01', currency: 'USD', lines: [], taxMinor: 0, totalMinor: 100_000, linesMismatchMinor: -100_000, status: 'open', note: null }),
        prov(),
      )
      expect(dup.possibleDuplicates).toContain(inv.recordId)
      await f.writer.apply(cmd('void_record', { recordId: dup.recordId, reason: 'duplicate' }), prov())

      await k.engine.post(k.ws, txn(bank, '2026-10-01', 60_000, { counterparty: 'GLOBEX' }))
      const bankRow = (await k.engine.store.listRecords(k.ws, { sourceAccountId: bank.id }))[0]?.id as string
      const pay = (amount: number, apps: number, bankId: string | null = bankRow) =>
        cmd('record_payment', { direction: 'receivable', amountMinor: amount, currency: 'USD', date: '2026-10-01', applications: [{ invoiceId: inv.recordId, amountMinor: apps }], unappliedMinor: amount - apps, bankTransactionId: bankId, method: null, counterparty: 'Globex' })
      await expect(f.writer.apply(pay(60_000, 60_000, null), { ...prov() }).then(() => f.writer.apply(pay(50_000, 50_000, null), prov()))).rejects.toMatchObject({ code: 'overpayment' })
    })

    it('an invoice note shows on its own row only, read once for the whole list', async () => {
      const add = (number: string, note: string | null) =>
        f.writer.apply(cmd('add_invoice', { direction: 'receivable', counterparty: 'Globex', number, issueDate: '2026-09-01', currency: 'USD', lines: [], taxMinor: 0, totalMinor: 10_000, linesMismatchMinor: 0, status: 'open', note }), prov())
      const a = await add('INV-21', 'Net 30 agreed by phone')
      const b = await add('INV-22', null)
      const rows = (await f.reader.searchInvoices(scope, { limit: 10 })).rows
      expect(rows.find((r) => r.id === a.recordId)?.note).toBe('Net 30 agreed by phone')
      expect(rows.find((r) => r.id === b.recordId)).not.toHaveProperty('note')
    })

    it('a payment that names its bank row links to it: AR down, cash revenue once', async () => {
      const bank = await k.account({ entityId: acme })
      const inv = await f.writer.apply(
        cmd('add_invoice', { direction: 'receivable', counterparty: 'Globex', number: 'INV-1', issueDate: '2026-09-01', currency: 'USD', lines: [], taxMinor: 0, totalMinor: 100_000, linesMismatchMinor: 0, status: 'open', note: null }),
        prov(),
      )
      await k.engine.post(k.ws, txn(bank, '2026-10-01', 60_000, { counterparty: 'GLOBEX' }))
      const bankRow = (await k.engine.store.listRecords(k.ws, { sourceAccountId: bank.id }))[0]?.id as string
      await f.writer.apply(cmd('record_payment', { direction: 'receivable', amountMinor: 60_000, currency: 'USD', date: '2026-10-01', applications: [{ invoiceId: inv.recordId, amountMinor: 60_000 }], unappliedMinor: 0, bankTransactionId: bankRow, method: 'wire', counterparty: 'Globex' }), prov())
      expect(await k.bal(acme, 'ar', 'accrual')).toBe(40_000)
      expect(await k.bal(acme, 'revenue', 'cash')).toBe(-60_000)
      expect(await k.bal(acme, 'suspense')).toBe(0)
      const found = await f.reader.searchInvoices(scope, { limit: 10 })
      expect(found.rows[0]).toMatchObject({ id: inv.recordId, status: 'partially_paid', amountPaid: usd(60_000) })
      await expect(
        f.writer.apply(cmd('record_payment', { direction: 'receivable', amountMinor: 50_000, currency: 'USD', date: '2026-10-02', applications: [{ invoiceId: inv.recordId, amountMinor: 50_000 }], unappliedMinor: 0, bankTransactionId: null, method: null, counterparty: null }), prov()),
      ).rejects.toMatchObject({ code: 'overpayment' })
    })

    it('buckets and rules: create, route, update, undo', async () => {
      const bank = await k.account({ entityId: acme })
      const b = await f.writer.apply(
        cmd('create_bucket', { name: 'Rent', fields: [{ key: 'landlord', label: 'Landlord', type: 'text' }], values: { landlord: 'WeWork' }, schedule: { amountMinor: 400_000, currency: 'USD', cadence: 'monthly', dueDay: 1, endDate: null }, rule: { descriptionContains: 'wework', counterparty: null, minAbsMinor: null, maxAbsMinor: null, currency: null, accountId: null } }),
        prov(),
      )
      await k.engine.post(k.ws, txn(bank, '2026-10-01', -400_000, { counterparty: 'WEWORK' }))
      const view = await f.reader.bucket(k.ws, b.recordId)
      expect(view).toMatchObject({ name: 'Rent', values: { landlord: 'WeWork' }, schedule: { amount: usd(400_000), cadence: 'monthly', dueDay: 1 } })
      expect(view?.rules).toHaveLength(1)
      expect(view?.payments?.filter((x) => x.state === 'paid')).toHaveLength(1)
      await f.writer.apply(cmd('update_bucket', { bucketId: b.recordId, changes: { name: 'Office rent' } }), prov())
      expect((await f.reader.bucket(k.ws, b.recordId))?.name).toBe('Office rent')
      await f.writer.revert(k.ws, b.recordId, prov())
      expect((await f.reader.bucket(k.ws, b.recordId))?.name).toBe('Rent')
      await f.writer.revert(k.ws, b.recordId, prov())
      expect(await f.reader.buckets(scope)).toEqual([])
    })

    it('a bucket made in the app names the person who made it', async () => {
      const named = createFinance(k.engine, { providers: { names: async (_ws, id) => (id === 'person-dana' ? 'Dana Ruiz' : null) } })
      const mine = await named.writer.apply(cmd('create_bucket', { name: 'Stake', fields: [], values: {}, schedule: null, rule: null }), prov({ actorKind: 'person', grantId: undefined, personId: 'person-dana', label: undefined }))
      expect((await named.reader.bucket(k.ws, mine.recordId))?.addedBy).toEqual({ kind: 'person', name: 'Dana Ruiz' })
      const theirs = await named.writer.apply(cmd('create_bucket', { name: 'Other', fields: [], values: {}, schedule: null, rule: null }), prov({ actorKind: 'person', grantId: undefined, personId: 'person-gone', label: undefined }))
      expect((await named.reader.bucket(k.ws, theirs.recordId))?.addedBy).toEqual({ kind: 'person', name: 'Someone' })
    })

    it('a rule without "apply to existing" leaves past rows alone', async () => {
      const bank = await k.account({ entityId: acme })
      await k.engine.post(k.ws, txn(bank, '2026-09-01', -1_000, { counterparty: 'Figma' }))
      k.setNow('2026-10-09T13:00:00.000Z')
      await f.writer.apply(cmd('create_rule', { match: { descriptionContains: 'figma', counterparty: null, minAbsMinor: null, maxAbsMinor: null, currency: null, accountId: null }, set: { category: 'Software', bucketId: null, kind: null, entityId: null }, applyToExisting: false }), prov())
      expect(await k.bal(acme, 'software')).toBe(0)
      k.setNow('2026-10-09T14:00:00.000Z')
      await k.engine.post(k.ws, txn(bank, '2026-10-09', -1_000, { counterparty: 'Figma' }))
      expect(await k.bal(acme, 'software')).toBe(1_000)
      await f.writer.apply(cmd('create_rule', { match: { descriptionContains: 'figma', counterparty: null, minAbsMinor: null, maxAbsMinor: null, currency: null, accountId: null }, set: { category: 'software', bucketId: null, kind: null, entityId: null }, applyToExisting: true }), prov())
      expect(await k.bal(acme, 'software')).toBe(2_000)
    })

    it('update_record: category by name, whose money, link; undo restores', async () => {
      const bank = await k.account({ entityId: acme })
      const sub = await k.company('Memoe')
      await k.engine.post(k.ws, txn(bank, '2026-10-01', -2_000, { counterparty: 'Vercel' }))
      const id = (await k.engine.store.listRecords(k.ws, { sourceAccountId: bank.id }))[0]?.id as string
      await f.writer.apply(cmd('update_record', { recordId: id, changes: { category: 'Software' } }), prov())
      expect(await k.bal(acme, 'software')).toBe(2_000)
      await f.writer.apply(cmd('update_record', { recordId: id, changes: { forEntityId: sub } }), prov())
      expect(await k.bal(sub, 'software')).toBe(2_000)
      expect(await k.bal(acme, `due_from:${sub}`)).toBe(2_000)
      await f.writer.revert(k.ws, id, prov())
      expect(await k.bal(sub, 'software')).toBe(0)
      expect(await k.bal(acme, 'software')).toBe(2_000)
      await expect(f.writer.apply(cmd('update_record', { recordId: id, changes: { paidBy: { type: 'owner', personId: owner } } }), prov())).rejects.toMatchObject({ code: 'not_supported' })
    })

    it('cash recorded by hand, then undone: cash stays known and the undone entry is not counted', async () => {
      const bank = await k.account({ entityId: acme })
      await k.engine.post(k.ws, snapshot(bank, '2026-10-08T12:00:00.000Z', 149_438))
      const scoped = { workspaceId: k.ws, entityIds: [acme] }
      const e = await f.writer.apply(entry('cash_income', 100), prov())
      let cash = await f.reader.metric('cash', scoped)
      expect(cash).toMatchObject({ state: 'ok', value: usd(149_538), agentEntriesIncluded: 1 })
      // Undone in the app: the hand-kept account has no live row left, and that's a known zero, not unknown.
      await f.writer.revert(k.ws, e.recordId, prov())
      cash = await f.reader.metric('cash', scoped)
      expect(cash).toMatchObject({ state: 'ok', value: usd(149_438), agentEntriesIncluded: 0 })
      expect(cash.rowIds).not.toContain(e.recordId)
      expect(await k.engine.cashHistory(k.ws, { entityIds: [acme], days: ['2026-10-08', '2026-10-09'] })).toEqual([usd(149_438), usd(149_438)])
    })

    it('void: only hand-added records; undo restores them', async () => {
      const bank = await k.account({ entityId: acme })
      await k.engine.post(k.ws, txn(bank, '2026-10-01', -2_000))
      const synced = (await k.engine.store.listRecords(k.ws, { sourceAccountId: bank.id }))[0]?.id as string
      await expect(f.writer.apply(cmd('void_record', { recordId: synced, reason: 'oops' }), prov())).rejects.toMatchObject({ code: 'synced' })
      const e = await f.writer.apply(entry('cash_income', 10_000), prov())
      const v = await f.writer.apply(cmd('void_record', { recordId: e.recordId, reason: 'wrong' }), prov())
      expect(v.cashImpact).toEqual([{ entityId: acme, amount: usd(-10_000) }])
      expect(await k.bal(acme, 'revenue')).toBe(0)
      expect((await f.reader.getRecord(k.ws, e.recordId))?.voided).toBe(true)
      await f.writer.revert(k.ws, e.recordId, prov())
      expect(await k.bal(acme, 'revenue')).toBe(-10_000)
      // Undo of the original write voids it again.
      await f.writer.revert(k.ws, e.recordId, prov())
      expect(await k.bal(acme, 'revenue')).toBe(0)
      await expect(f.writer.revert(k.ws, 'nope', prov())).rejects.toMatchObject({ code: 'not_found' })
    })

    it('resolve_review_item: confirm a match, answer "loan or investment?"', async () => {
      const mine = await k.account({ entityId: me })
      const bank = await k.account({ entityId: acme })
      await k.engine.postBatch(k.ws, [txn(mine, '2026-10-01', -500_000), txn(bank, '2026-10-01', 500_000)])
      await k.engine.reconcile(k.ws)
      let items = await f.reader.reviewItems(scope)
      const match = items.find((i) => i.kind === 'suggested_match')
      expect(match?.options).toEqual(['confirm', 'reject'])
      await f.writer.apply(cmd('resolve_review_item', { reviewItemId: match?.id, kind: 'suggested_match', decision: 'confirm', edits: null }), prov())
      items = await f.reader.reviewItems(scope)
      const owner = items.find((i) => i.kind === 'whose_money')
      expect(owner?.title).toContain('loan or an investment')
      await f.writer.apply(cmd('resolve_review_item', { reviewItemId: owner?.id, kind: 'whose_money', decision: 'edit', edits: { kind: 'owner_contribution' } }), prov())
      expect(await k.bal(acme, 'owner_contributions')).toBe(-500_000)
      expect((await f.reader.reviewItems(scope)).filter((i) => i.kind === 'whose_money')).toEqual([])
    })
    it('rules use the search language: query, a new name, and stop', async () => {
      const bank = await k.account({ entityId: acme, name: 'Chase' })
      await k.engine.postBatch(k.ws, [
        txn(bank, '2026-09-14', -61_250, { counterparty: 'AMZN Mktp', rawText: 'AMAZON WEB SERVICES AWS.AMAZON.CO' }),
        txn(bank, '2026-09-15', -2_000, { counterparty: 'AMZN Mktp', rawText: 'AMAZON MARKETPLACE BOOKS' }),
      ])
      const named = await f.writer.apply(cmd('create_rule', { match: { query: 'aws* amount>100' }, set: { renameTo: 'AWS', category: 'cloud' }, stopProcessing: true, applyToExisting: true }), prov())
      expect(named.summary).toBe('aws* amount>100 → call it "AWS", cloud, stop')
      await f.writer.apply(cmd('create_rule', { match: { query: 'amzn' }, set: { category: 'software' }, applyToExisting: true }), prov())
      // The first rule stops the second on the AWS row; the marketplace row only meets the second.
      expect(await k.bal(acme, 'cloud')).toBe(61_250)
      expect(await k.bal(acme, 'software')).toBe(2_000)
      const found = await f.reader.searchTransactions(scope, { q: 'counterparty:AWS date:2026-09', limit: 10 })
      expect(found.rows.map((r) => [r.counterparty, r.rawText])).toEqual([['AWS', 'AMAZON WEB SERVICES AWS.AMAZON.CO']])
      expect((await f.reader.searchTransactions(scope, { q: 'category:software', limit: 10 })).rows.map((r) => r.amount)).toEqual([usd(-2_000)])
      await expect(f.writer.apply(cmd('create_rule', { match: { query: 'date:2026-09' }, set: { category: 'cloud' } }), prov())).rejects.toMatchObject({ code: 'invalid' })
      await expect(f.writer.apply(cmd('create_rule', { match: { query: 'category:cloud aws' }, set: { category: 'cloud' } }), prov())).rejects.toMatchObject({ code: 'invalid' })
    })

    it('preview: the exact answer apply would give, with nothing kept', async () => {
      const bank = await k.account({ entityId: acme, name: 'Chase' })
      await k.engine.post(k.ws, txn(bank, '2026-09-14', -61_250, { counterparty: 'AWS' }))
      const rule = cmd('create_rule', { match: { query: 'aws' }, set: { category: 'cloud' }, applyToExisting: true })
      const seen = await f.writer.preview!(rule, prov())
      expect(seen.summary).toContain('cloud')
      expect(await k.bal(acme, 'cloud')).toBe(0)
      expect(await k.engine.store.listRules(k.ws)).toEqual([])
      await expect(f.writer.preview!(cmd('create_rule', { match: { query: 'date:2026-09' }, set: { category: 'cloud' } }), prov())).rejects.toMatchObject({ code: 'invalid' })
      const real = await f.writer.apply(rule, prov())
      expect(real.summary).toBe(seen.summary)
      expect(await k.bal(acme, 'cloud')).toBe(61_250)
    })

    it('pin_balance on cash on hand is checked like any account', async () => {
      await f.writer.apply(entry('cash_income', 80_000, { counterparty: 'Farmers market' }), prov())
      const till = (await k.engine.directory.listSourceAccounts(k.ws)).find((a) => a.entityId === acme && a.accountType === 'cash_on_hand')
      expect(till).toBeDefined()
      await f.writer.apply(cmd('pin_balance', { accountId: till?.id, date: '2026-10-05', balance: usd(70_000), source: 'Counted the till' }), prov())
      const failing = (await k.engine.checks(k.ws, { problemsOnly: true })).filter((c) => c.name === 'balance_assertion')
      expect(failing).toEqual([expect.objectContaining({ status: 'fail', expectedMinor: 70_000, actualMinor: 80_000 })])
    })

    it('pin_balance: a checked statement balance, never posted, undoable', async () => {
      const bank = await k.account({ entityId: acme, name: 'Chase' })
      await k.engine.post(k.ws, txn(bank, '2026-09-02', 500_000))
      const pinned = await f.writer.apply(cmd('pin_balance', { accountId: bank.id, date: '2026-09-30', balance: usd(500_000), source: 'September statement' }), prov())
      expect(pinned).toMatchObject({ recordType: 'balance_assertion', cashImpact: [], summary: 'Pinned: Chase held 5000.00 USD on 2026-09-30; the ledger agrees' })
      const off = await f.writer.apply(cmd('pin_balance', { accountId: bank.id, date: '2026-09-30', balance: usd(490_000) }), prov())
      expect(off.summary).toContain('the ledger differs (ledger 5000.00 USD, difference -100.00 USD)')
      expect(off.balanceCheck).toEqual({ matches: false, stated: usd(490_000), ledger: usd(500_000), difference: usd(-10_000) })
      expect(pinned.balanceCheck).toMatchObject({ matches: true })
      expect((await k.engine.checks(k.ws, { problemsOnly: true })).filter((c) => c.name === 'balance_assertion')).toHaveLength(1)
      await f.writer.revert(k.ws, off.recordId, prov())
      expect((await k.engine.checks(k.ws, { problemsOnly: true })).filter((c) => c.name === 'balance_assertion')).toEqual([])
      await expect(f.writer.apply(cmd('pin_balance', { accountId: bank.id, date: '2099-01-01', balance: usd(1) }), prov())).rejects.toMatchObject({ code: 'invalid' })
      await expect(f.writer.apply(cmd('pin_balance', { accountId: bank.id, date: '2026-09-30', balance: { minor: 1, currency: 'EUR' } }), prov())).rejects.toMatchObject({ code: 'currency_mismatch' })
      expect(await k.bal(acme, `cash:${bank.id}`)).toBe(500_000)
      // A card is stated as the positive amount owed, and compared that way.
      const amex = await k.account({ entityId: acme, type: 'credit_card', name: 'Amex' })
      await k.engine.post(k.ws, txn(amex, '2026-09-05', -30_000, { counterparty: 'Delta' }))
      const owed = await f.writer.apply(cmd('pin_balance', { accountId: amex.id, date: '2026-09-30', balance: usd(30_000) }), prov())
      expect(owed.balanceCheck).toEqual({ matches: true, stated: usd(30_000), ledger: usd(30_000), difference: usd(0) })
      const wrong = await f.writer.apply(cmd('pin_balance', { accountId: amex.id, date: '2026-09-30', balance: usd(99_900) }), prov())
      expect(wrong.balanceCheck).toEqual({ matches: false, stated: usd(99_900), ledger: usd(30_000), difference: usd(69_900) })
    })

    it('close_period / reopen_period: closed months stay as reported; undo restores the lock before', async () => {
      const bank = await k.account({ entityId: acme, name: 'Chase' })
      await k.engine.post(k.ws, txn(bank, '2026-08-10', -10_000, { externalId: 'aug' }))
      const july = await f.writer.apply(cmd('close_period', { through: '2026-07-31', note: 'July filed' }), prov())
      expect(july).toMatchObject({ recordType: 'period_lock', summary: "Acme's books are closed through 2026-07-31; later changes to that period post on the next day" })
      const aug = await f.writer.apply(cmd('close_period', { through: '2026-08-31' }), prov())
      expect(await f.reader.periodLocks!(scope)).toMatchObject([{ entityId: acme, through: '2026-08-31', note: null }])
      await k.engine.post(k.ws, txn(bank, '2026-08-10', -12_000, { externalId: 'aug' }))
      expect(await k.bal(acme, `cash:${bank.id}`, 'cash', '2026-08-31')).toBe(-10_000)
      await f.writer.revert(k.ws, aug.recordId, prov())
      expect((await f.reader.periodLocks!(scope)).map((l) => [l.through, l.note])).toEqual([['2026-07-31', 'July filed']])
      const reopened = await f.writer.apply(cmd('reopen_period', {}), prov())
      expect(reopened.summary).toBe("Acme's books are open again (they were closed through 2026-07-31)")
      expect(await f.reader.periodLocks!(scope)).toEqual([])
      await expect(f.writer.apply(cmd('reopen_period', {}), prov())).rejects.toMatchObject({ code: 'invalid' })
      await f.writer.revert(k.ws, reopened.recordId, prov())
      expect((await f.reader.periodLocks!(scope)).map((l) => l.through)).toEqual(['2026-07-31'])
      await expect(f.writer.apply(cmd('close_period', { through: '2026-10-09' }), prov())).rejects.toMatchObject({ code: 'invalid' })
      await expect(f.writer.apply(cmd('close_period', { through: 'August' }), prov())).rejects.toMatchObject({ code: 'invalid' })
    })

    it('resolve_review_item: "which company?" assigns the account and posts the rows it held', async () => {
      const loose = await k.account({ entityId: null, name: 'Checking', mask: '0042' })
      await k.engine.postBatch(k.ws, [txn(loose, '2026-10-02', -12_000, { counterparty: 'Staples' }), txn(loose, '2026-10-03', -3_000, { counterparty: 'Uber' })])
      const item = (await f.reader.reviewItems(scope)).find((i) => i.kind === 'which_company')
      expect(item).toMatchObject({ id: `which_company:${loose.id}`, entityId: null, accountId: loose.id, options: ['edit'], title: 'Which company is Checking ··0042?' })
      // The app needs the connection ("put all in Personal") from the view, not just the core item.
      expect(item?.connectionId).toBe(loose.connectionId)
      expect(item?.recordIds.length).toBe(2)
      expect((await f.reader.reviewItems(scope, ['suggested_match'])).some((i) => i.kind === 'which_company')).toBe(false)
      await expect(f.writer.apply(cmd('resolve_review_item', { reviewItemId: item?.id, kind: 'which_company', decision: 'edit', edits: {} }), prov())).rejects.toMatchObject({ code: 'invalid' })
      await expect(f.writer.apply(cmd('resolve_review_item', { reviewItemId: item?.id, kind: 'which_company', decision: 'edit', edits: { companyId: 'nope' } }), prov())).rejects.toMatchObject({ code: 'wrong_company' })
      const res = await f.writer.apply(cmd('resolve_review_item', { reviewItemId: item?.id, kind: 'which_company', decision: 'edit', edits: { companyId: acme } }), prov())
      expect(res.summary).toBe('Checking now belongs to Acme')
      expect(await k.bal(acme, 'uncategorized_expense')).toBe(15_000)
      expect((await f.reader.reviewItems(scope)).filter((i) => i.kind === 'which_company')).toEqual([])
      expect((await k.engine.dataHealth(k.ws)).counts.toReview).toBe(0)
    })

    it('"which company?" carries the connection and the provider\'s guess, never applied by itself', async () => {
      const conn = await k.connection()
      const ira = await k.account({ entityId: null, name: 'IRA', connectionId: conn, businessHint: 'personal' })
      const card = await k.account({ entityId: null, name: 'Business card', connectionId: conn, businessHint: 'business' })
      const odd = await k.account({ entityId: null, name: 'Money market', connectionId: conn, businessHint: 'unknown' })
      const items = await listReviewItems(k.engine.metricContext(k.ws), { entityIds: [acme, me] })
      const of = (id: string) => items.find((i) => i.id === `which_company:${id}`)
      expect(of(ira.id)).toMatchObject({ connectionId: conn, suggested: 'personal', entityId: null })
      expect(of(card.id)).toMatchObject({ connectionId: conn, suggested: acme })
      expect(of(odd.id)).not.toHaveProperty('suggested')
      // The reader passes both on for Review's "Put all in Personal".
      const view = (await f.reader.reviewItems({ workspaceId: k.ws, entityIds: [acme, me] })).find((i) => i.id === `which_company:${ira.id}`)
      expect(view).toMatchObject({ connectionId: conn, suggested: 'personal' })
      expect((await k.engine.directory.getSourceAccount(k.ws, ira.id))?.entityId).toBeNull()
    })
  })

  describe('reads', () => {
    beforeEach(async () => {
      const conn = await k.connection({ key: 'plaid', lastSuccessAt: '2026-10-09T10:00:00Z' })
      const bank = await k.account({ entityId: acme, connectionId: conn, name: 'Chase', mask: '1234' })
      const card = await k.account({ entityId: acme, type: 'credit_card', name: 'Amex' })
      const books = await k.connection({ entityId: acme, key: 'quickbooks' })
      await k.engine.postBatch(k.ws, [
        snapshot(bank, '2026-10-08', 2_000_000),
        txn(bank, '2026-09-03', 120_000, { counterparty: 'Globex Corp', rawText: 'GLOBEX CORP ACH' }),
        txn(bank, '2026-09-05', -9_900, { counterparty: 'AWS' }),
        txn(card, '2026-09-07', -4_500, { counterparty: 'Uber' }),
        txn(card, '2026-10-01', -4_500, { counterparty: 'Uber' }),
        invoice(books, { externalId: 'inv-a', total: usd(300_000), number: 'INV-1', counterparty: 'Globex Corp', issueDate: '2026-08-01', dueDate: '2026-08-31' }),
        invoice(books, { externalId: 'bill-a', direction: 'payable', total: usd(50_000), counterparty: 'Landlord', issueDate: '2026-10-01', dueDate: '2026-10-20' }),
      ])
    })

    it('lists data types, sources and accounts', async () => {
      expect(await f.reader.dataAvailability(scope)).toEqual(['balances', 'bills', 'invoices', 'reports', 'transactions'])
      expect(await f.reader.dataAvailability({ workspaceId: k.ws, entityIds: [me] })).toEqual(['personal'])
      const sources = await f.reader.sources(scope)
      expect(sources.map((s) => [s.name, s.health, s.stale])).toEqual(expect.arrayContaining([['plaid', 'ok', false]]))
      const accounts = await f.reader.accounts(scope, {})
      expect(accounts.find((a) => a.name === 'Chase')).toMatchObject({ balance: usd(2_000_000), mask: '1234', type: 'depository' })
      expect(accounts.find((a) => a.name === 'Amex')?.balance).toEqual(usd(-9_000))
    })

    it('searches transactions with filters, sums over all pages, and pagination', async () => {
      const all = await f.reader.searchTransactions(scope, { limit: 2 })
      expect(all.totalCount).toBe(4)
      expect(all.rows).toHaveLength(2)
      expect(all.nextCursor).toBe('2')
      expect(all.sums).toEqual([usd(120_000 - 9_900 - 9_000)])
      const page2 = await f.reader.searchTransactions(scope, { limit: 2, cursor: all.nextCursor as string })
      expect(page2.rows).toHaveLength(2)
      expect(page2.nextCursor).toBeNull()
      const uber = await f.reader.searchTransactions(scope, { limit: 10, counterparty: 'uber', source: 'card' })
      expect(uber.rows.map((r) => r.amount)).toEqual([usd(-4_500), usd(-4_500)])
      const inflow = await f.reader.searchTransactions(scope, { limit: 10, direction: 'in' })
      expect(inflow.rows[0]).toMatchObject({ needsReview: true, category: 'suspense', addedBy: { kind: 'sync', name: 'plaid' } })
    })

    it('searches invoices with totals and aging', async () => {
      const r = await f.reader.searchInvoices(scope, { limit: 10 })
      expect(r.totals).toEqual(
        expect.arrayContaining([
          { direction: 'receivable', open: usd(300_000), overdue: usd(300_000) },
          { direction: 'payable', open: usd(50_000), overdue: usd(0) },
        ]),
      )
      const ar = r.aging.find((a) => a.direction === 'receivable')
      expect(ar?.d31_60).toEqual(usd(300_000))
      expect(r.rows.find((v) => v.number === 'INV-1')).toMatchObject({ status: 'overdue', daysOverdue: 39, source: 'quickbooks' })
    })

    it('an overdue invoice partly paid is shown overdue, and a partially_paid filter finds it', async () => {
      const books = await k.connection({ entityId: acme, key: 'xero' })
      await k.engine.post(k.ws, invoice(books, { externalId: 'inv-p', total: usd(200_000), amountPaid: usd(50_000), status: 'partially_paid', number: 'INV-2', counterparty: 'Initech', issueDate: '2026-08-01', dueDate: '2026-08-31' }))
      const partly = await f.reader.searchInvoices(scope, { status: 'partially_paid', limit: 50 })
      expect(partly.rows.map((r) => [r.number, r.status, r.amountPaid])).toEqual([['INV-2', 'overdue', usd(50_000)]])
      // Unpaid overdue INV-1 is overdue, not partly paid.
      expect((await f.reader.searchInvoices(scope, { status: 'overdue', limit: 50 })).rows.map((r) => r.number).sort()).toEqual(['INV-1', 'INV-2'])
    })

    it('overview: one row per company with attention items', async () => {
      const o = await f.reader.overview(scope)
      expect(o.homeCurrency).toBe('USD')
      expect(o.entities[0]).toMatchObject({ entityId: acme, cash: usd(2_000_000), cardDebt: usd(9_000), owedToYou: { total: usd(300_000), overdue: usd(300_000) }, billsDue30d: usd(50_000) })
      expect(o.attention.map((a) => a.kind)).toEqual(expect.arrayContaining(['overdue_invoice', 'needs_review']))
    })

    it('counterparty, upcoming, reports, record view', async () => {
      const cp = await f.reader.counterparty(scope, 'Globex')
      expect(cp).toMatchObject({ name: 'Globex Corp', receivedFromThemAllTime: [usd(120_000)], paidToThemAllTime: [] })
      expect(cp?.openInvoices).toHaveLength(1)
      const up = await f.reader.upcoming(scope, 30)
      expect(up.map((u) => [u.kind, u.what])).toEqual(expect.arrayContaining([['bill', 'Landlord']]))
      // INV-1 is 39 days overdue: over 30 days late isn't income to expect now (it stays in receivables).
      expect(up.some((u) => u.what === 'INV-1 Globex Corp')).toBe(false)
      const [pl] = await f.reader.reports(scope, 'profit_and_loss', '2026-09-01', '2026-09-30', 'accrual')
      expect(pl?.sections[0]?.name).toBe('Revenue')
      const [bs] = await f.reader.reports(scope, 'balance_sheet', '2026-01-01', '2026-10-09', 'cash')
      expect(bs?.total.currency).toBe('USD')
      const anyTxn = (await f.reader.searchTransactions(scope, { limit: 1, counterparty: 'aws' })).rows[0]
      const rec = await f.reader.getRecord(k.ws, anyTxn?.id as string)
      expect(rec).toMatchObject({ type: 'transaction', dataType: 'transactions', voided: false })
      expect((rec?.data['entries'] as unknown[]).length).toBe(1)
    })

    it('reports with nothing posted say so, rather than a page of zeros', async () => {
      // August: only INV-1 was issued, nothing paid. Cash basis has no lines; accrual has the invoice.
      const [cash] = await f.reader.reports(scope, 'profit_and_loss', '2026-08-01', '2026-08-31', 'cash')
      expect(cash?.noData).toMatch(/^No cash-basis activity in this period: there are invoices or bills/)
      const [accrual] = await f.reader.reports(scope, 'profit_and_loss', '2026-08-01', '2026-08-31', 'accrual')
      expect(accrual?.noData).toBeUndefined()
      expect(accrual?.sections[0]?.rows.length).toBeGreaterThan(0)
      const [empty] = await f.reader.reports(scope, 'profit_and_loss', '2025-01-01', '2025-01-31', 'cash')
      expect(empty?.noData).toBe('No income or expenses posted in this period.')
      const [bs] = await f.reader.reports(scope, 'balance_sheet', '2025-01-01', '2025-01-31', 'accrual')
      expect(bs?.noData).toBe('Nothing posted on or before 2025-01-31.')
      const [cf] = await f.reader.reports(scope, 'cash_flow', '2025-01-01', '2025-01-31', 'cash')
      expect(cf?.noData).toBe('No cash or card activity in this period.')
      // Periods with activity carry no note.
      const [sep] = await f.reader.reports(scope, 'profit_and_loss', '2026-09-01', '2026-09-30', 'cash')
      expect(sep?.noData).toBeUndefined()
    })
  })
})
