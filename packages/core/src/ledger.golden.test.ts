// Golden-answer tests for every money rule. Each scenario runs on the in-memory store and on SQLite;
// Postgres runs in-process via PGlite, so hosted (Postgres) behavior is covered too.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@agfn/contracts'
import { EventValidationError } from './validate.ts'
import { PostingError } from './posting.ts'
import { LinkError } from './engine.ts'
import { invoice, makeKit, snapshot, stripe, txn, usd, eur, type Backend, type Kit } from './test-kit.ts'
import { createFinance } from './finance.ts'

const backends: Backend[] = ['memory', 'sqlite', 'pglite']

describe.each(backends)('ledger golden answers (%s)', (backend) => {
  let k: Kit
  let acme: string

  beforeEach(async () => {
    k = await makeKit(backend)
    acme = await k.company('Acme')
  })
  afterEach(async () => {
    await k.close()
  })

  async function expectBalanced(...entities: string[]): Promise<void> {
    for (const e of entities) {
      expect(await k.tb(e, 'cash')).toBe(0)
      expect(await k.tb(e, 'accrual')).toBe(0)
    }
    const failing = (await k.engine.checks(k.ws, { entityIds: entities, problemsOnly: true })).filter((c) => c.name === 'trial_balance')
    expect(failing).toEqual([])
  }

  describe('bank and card basics', () => {
    it('posts spending with no category to Uncategorized spending, balanced', async () => {
      const bank = await k.account({ entityId: acme, name: 'Chase' })
      const res = await k.engine.post(k.ws, txn(bank, '2026-09-05', -12_000, { counterparty: 'Office Depot' }))
      expect(res.status).toBe('posted')
      expect(res.journalEntryId).toBeTruthy()
      expect(await k.bal(acme, 'uncategorized_expense')).toBe(12_000)
      expect(await k.bal(acme, `cash:${bank.id}`)).toBe(-12_000)
      await expectBalanced(acme)
    })

    it('is idempotent per (connection, type, external id) and treats changes as updates', async () => {
      const bank = await k.account({ entityId: acme })
      const ev = txn(bank, '2026-09-05', -12_000)
      const first = await k.engine.post(k.ws, ev)
      const again = await k.engine.post(k.ws, { ...ev, rawRef: 'raw-2' } as NormalizedEvent)
      expect(again).toEqual({ journalEntryId: first.journalEntryId, status: 'duplicate' })

      const changed = await k.engine.post(k.ws, { ...ev, amount: usd(-15_000) })
      expect(changed.status).toBe('posted')
      expect(changed.journalEntryId).not.toBe(first.journalEntryId)
      expect(await k.bal(acme, 'uncategorized_expense')).toBe(15_000)
      // The original stays in history, reversed.
      const original = await k.engine.store.getEntry(k.ws, first.journalEntryId as string)
      expect(original?.reversedById).toBeTruthy()

      const voided = await k.engine.post(k.ws, { ...ev, status: 'void', amount: usd(0) })
      expect(voided.status).toBe('recorded')
      expect(await k.bal(acme, 'uncategorized_expense')).toBe(0)
      expect(await k.bal(acme, `cash:${bank.id}`)).toBe(0)
      await expectBalanced(acme)
    })

    it('holds unexplained money in suspense and asks about it', async () => {
      const bank = await k.account({ entityId: acme })
      const r = await k.engine.post(k.ws, txn(bank, '2026-09-08', 50_000, { counterparty: 'Unknown sender' }))
      expect(await k.bal(acme, 'suspense')).toBe(-50_000)
      expect(await k.bal(acme, 'revenue')).toBe(0)
      const items = await k.engine.reviewItems(k.ws, { entityIds: [acme] })
      expect(items.map((i) => i.kind)).toContain('unexplained_money')
      expect(items.find((i) => i.kind === 'unexplained_money')?.recordIds).toHaveLength(1)
      void r
    })

    it('never posts pending rows and links pending → posted by provider id', async () => {
      const card = await k.account({ entityId: acme, type: 'credit_card' })
      const pending = txn(card, '2026-09-10', -4_510, { status: 'pending', counterparty: 'Blue Bottle' })
      expect((await k.engine.post(k.ws, pending)).status).toBe('recorded')
      expect(await k.bal(acme, 'uncategorized_expense')).toBe(0)
      await k.engine.post(k.ws, txn(card, '2026-09-11', -4_730, { pendingExternalId: pending.externalId, counterparty: 'Blue Bottle' }))
      expect(await k.bal(acme, 'uncategorized_expense')).toBe(4_730)
      const links = await k.engine.store.listLinks(k.ws, { types: ['pending_posted'] })
      expect(links).toHaveLength(1)
      expect(links[0]?.status).toBe('confirmed')
      // Plaid also voids the pending row; nothing changes.
      await k.engine.post(k.ws, { ...pending, status: 'void', amount: usd(0) })
      expect(await k.bal(acme, 'uncategorized_expense')).toBe(4_730)
      await expectBalanced(acme)
    })

    it('counts a card purchase once: at the swipe, not again when the card is paid', async () => {
      const bank = await k.account({ entityId: acme })
      const card = await k.account({ entityId: acme, type: 'credit_card', name: 'Amex' })
      await k.engine.postBatch(k.ws, [
        txn(card, '2026-09-12', -5_000, { counterparty: 'Notion' }),
        txn(bank, '2026-09-25', -5_000, { rawText: 'AMEX EPAYMENT ACH PMT' }),
        txn(card, '2026-09-25', 5_000, { rawText: 'PAYMENT THANK YOU' }),
      ])
      expect(await k.bal(acme, 'uncategorized_expense')).toBe(5_000)
      expect(await k.bal(acme, 'clearing_transfers')).toBe(0)
      expect(await k.bal(acme, `card:${card.id}`)).toBe(0)
      const links = await k.engine.store.listLinks(k.ws, { types: ['card_payment'], statuses: ['confirmed'] })
      expect(links).toHaveLength(1)
      const burn = await k.engine.metric('gross_burn', { workspaceId: k.ws, entityIds: [acme], from: '2026-09-01', to: '2026-09-30' })
      expect(burn.value).toEqual(usd(5_000))
      await expectBalanced(acme)
    })

    it('a card payment with no card connected is the spending', async () => {
      const bank = await k.account({ entityId: acme })
      const r = await k.engine.post(k.ws, txn(bank, '2026-09-25', -7_500, { rawText: 'CHASE CARD AUTOPAY' }))
      const rec = (await k.engine.store.listRecords(k.ws, { eventTypes: ['txn.upsert'] }))[0]
      await k.engine.setOverride(k.ws, rec?.id as string, { kind: 'card_payment' }, 'person-1')
      expect(await k.bal(acme, 'uncategorized_expense')).toBe(7_500)
      expect(await k.bal(acme, 'clearing_transfers')).toBe(0)
      void r
    })

    it('interest the bank labels as interest is income, not "what is this money?"', async () => {
      const bank = await k.account({ entityId: acme })
      await k.engine.postBatch(k.ws, [
        txn(bank, '2026-09-30', 1_250, { rawText: 'INTRST PYMNT', categoryHint: 'INCOME_INTEREST_EARNED' }),
        txn(bank, '2026-09-30', 900, { rawText: 'DIVIDEND', categoryHint: 'INCOME_DIVIDENDS' }),
        txn(bank, '2026-09-30', -400, { rawText: 'LOAN INTEREST', categoryHint: 'LOAN_PAYMENTS_INTEREST' }),
        txn(bank, '2026-09-30', 3_100, { rawText: 'Cash sales (counted at close)', categoryHint: 'INCOME_SALES' }),
        txn(bank, '2026-09-30', 6_250, { rawText: 'NORTHWIND LABS PAYROLL', categoryHint: 'INCOME_WAGES' }),
        // Plaid PFC v2: military pay is wages, disability benefits other income, gig income still asked about.
        txn(bank, '2026-09-30', 2_000, { rawText: 'DFAS MIL PAY', categoryHint: 'INCOME_MILITARY' }),
        txn(bank, '2026-09-30', 700, { rawText: 'LTD BENEFIT', categoryHint: 'INCOME_LONG_TERM_DISABILITY' }),
        txn(bank, '2026-09-30', 450, { rawText: 'UBER DRIVER PAYOUT', categoryHint: 'INCOME_GIG_ECONOMY' }),
      ])
      expect(await k.bal(acme, 'interest_income')).toBe(-1_250)
      expect(await k.bal(acme, 'other_income')).toBe(-900 - 700)
      // A paycheck is wages ("Wages and salary"), so "wages" or "salary" finds it.
      expect(await k.bal(acme, 'wages_income')).toBe(-6_250 - 2_000)
      expect(await k.bal(acme, 'revenue')).toBe(-3_100)
      expect(await k.bal(acme, 'suspense')).toBe(-450)
      // A broad provider code isn't enough to call a deposit income.
      await k.engine.post(k.ws, txn(bank, '2026-09-30', 7_000, { rawText: 'DEPOSIT', categoryHint: 'INCOME_OTHER_INCOME' }))
      expect(await k.bal(acme, 'revenue')).toBe(-3_100)
    })

    it('a transfer linked by its reference is not asked about again as a cash deposit', async () => {
      const bank = await k.account({ entityId: acme, name: 'Checking' })
      const till = await k.account({ entityId: acme, name: 'Cash', type: 'cash_on_hand' })
      await k.engine.postBatch(k.ws, [
        txn(bank, '2026-08-17', -127_133, { rawText: 'Bank deposit', linkRefs: { transfer: 'T-1' } }),
        txn(till, '2026-08-17', 127_133, { rawText: 'Cash deposit', linkRefs: { transfer: 'T-1' } }),
      ])
      const links = await k.engine.store.listLinks(k.ws)
      expect(links.map((l) => [l.type, l.method, l.status])).toEqual([['transfer', 'exact_id', 'confirmed']])
      expect((await k.engine.reviewItems(k.ws)).filter((i) => i.kind === 'suggested_match')).toEqual([])
    })

    it('a posted row whose pending row was linked can still be a transfer', async () => {
      const checking = await k.account({ entityId: acme, name: 'Checking' })
      const savings = await k.account({ entityId: acme, name: 'Savings' })
      await k.engine.postBatch(k.ws, [{ ...txn(checking, '2026-09-09', -100_000, { rawText: 'ONLINE TRANSFER TO SAV' }), status: 'pending', externalId: 'p1' }])
      await k.engine.postBatch(k.ws, [
        { ...txn(checking, '2026-09-10', -100_000, { rawText: 'ONLINE TRANSFER TO SAV' }), pendingExternalId: 'p1' },
        txn(savings, '2026-09-10', 100_000, { rawText: 'ONLINE TRANSFER FROM CHK' }),
      ])
      const types = (await k.engine.store.listLinks(k.ws, { statuses: ['confirmed'] })).map((l) => l.type).sort()
      expect(types).toEqual(['pending_posted', 'transfer'])
    })

    it('matches transfers between own accounts automatically and keeps them out of burn', async () => {
      const checking = await k.account({ entityId: acme, name: 'Checking' })
      const savings = await k.account({ entityId: acme, name: 'Savings' })
      await k.engine.postBatch(k.ws, [txn(checking, '2026-09-10', -100_000, { rawText: 'ONLINE TRANSFER TO SAV 1234' }), txn(savings, '2026-09-11', 100_000, { rawText: 'ONLINE TRANSFER FROM CHK' })])
      const link = (await k.engine.store.listLinks(k.ws, { types: ['transfer'] }))[0]
      expect(link?.status).toBe('confirmed')
      expect(link?.confidence).toBe(0.99)
      expect(await k.bal(acme, 'clearing_transfers')).toBe(0)
      expect(await k.bal(acme, 'suspense')).toBe(0)
      expect(await k.bal(acme, 'uncategorized_expense')).toBe(0)
      const burn = await k.engine.metric('net_burn', { workspaceId: k.ws, entityIds: [acme], from: '2026-09-01', to: '2026-09-30' })
      expect(burn.value).toEqual(usd(0))
      await expectBalanced(acme)
    })

    it('excludes rows from an account marked as a duplicate of another', async () => {
      const a = await k.account({ entityId: acme, name: 'Mercury (Plaid)' })
      const b = await k.account({ entityId: acme, name: 'Mercury (direct)' })
      await k.engine.post(k.ws, txn(a, '2026-09-05', -1_000))
      await k.engine.post(k.ws, txn(b, '2026-09-05', -1_000))
      expect(await k.bal(acme, 'uncategorized_expense')).toBe(2_000)
      await k.markDuplicate(a.id, b.id)
      expect(await k.bal(acme, 'uncategorized_expense')).toBe(1_000)
      await expectBalanced(acme)
    })

    it('a statement for an account we already sync merges in: older rows count, repeated rows count once', async () => {
      const plaid = await k.account({ entityId: acme, name: 'Checking' })
      const upload = await k.account({ entityId: acme, name: 'Checking (statement)', connectionId: await k.connection({ key: 'files' }) })
      await k.engine.postBatch(k.ws, [txn(plaid, '2026-09-09', -50_000, { counterparty: 'United Airlines' }), txn(plaid, '2026-09-20', -7_000, { counterparty: 'Staples' }), txn(plaid, '2026-09-25', -3_000, { counterparty: 'Uber' })])
      await k.markDuplicate(upload.id, plaid.id)
      await k.engine.postBatch(k.ws, [
        txn(upload, '2026-06-02', -1_000, { counterparty: 'Before sync began' }),
        txn(upload, '2026-09-09', -50_000, { counterparty: 'UNITED AIRLINES' }),
        txn(upload, '2026-09-22', -7_000, { counterparty: 'Staples' }),
        txn(upload, '2026-09-26', -3_000, { counterparty: 'Lyft' }),
      ])
      const links = await k.engine.store.listLinks(k.ws, { types: ['duplicate'] })
      expect(links.map((l) => [l.status, l.confidence, l.scores?.['pass']]).sort()).toEqual([
        ['confirmed', 0.97, 2],
        ['proposed', 0.7, 3],
        ['proposed', 0.85, 2],
      ])
      // The certain copy counts once; a strong suggestion holds its copy back; a weak one counts until answered.
      expect(await k.bal(acme, 'uncategorized_expense')).toBe(60_000 + 1_000 + 3_000)
      for (const l of links.filter((x) => x.status === 'proposed')) await k.engine.decideLink(k.ws, l.id, 'confirmed', 'person-1')
      expect(await k.bal(acme, 'uncategorized_expense')).toBe(61_000)
      // Every row lands in the synced account's ledger account; the statement adds no cash account of its own.
      const ledger = await k.engine.store.listLedgerAccounts(k.ws, [acme])
      expect(ledger.filter((a) => a.role.startsWith('cash:')).map((a) => a.role)).toEqual([`cash:${plaid.id}`])
      await expectBalanced(acme)
    })

    it('an uploaded statement that repeats synced rows is flagged, not silently counted twice', async () => {
      const plaid = await k.account({ entityId: acme, name: 'Plaid Checking' })
      const upload = await k.account({ entityId: acme, name: 'Uploaded statements', connectionId: await k.connection({ key: 'files' }) })
      await k.engine.postBatch(k.ws, [txn(plaid, '2026-09-09', -50_000, { counterparty: 'United Airlines' }), txn(plaid, '2026-10-09', -50_000, { counterparty: 'United Airlines' })])
      await k.engine.postBatch(k.ws, [txn(upload, '2026-09-09', -50_000, { counterparty: 'United Airlines' }), txn(upload, '2026-10-09', -50_000, { counterparty: 'United Airlines' }), txn(upload, '2026-10-01', -2_000, { counterparty: 'Only here' })])
      const links = await k.engine.store.listLinks(k.ws, { types: ['duplicate'] })
      expect(links.map((l) => [l.status, l.confidence])).toEqual([['proposed', 0.9], ['proposed', 0.9]])
      expect((await k.engine.reviewItems(k.ws)).filter((i) => i.kind === 'suggested_match').length).toBe(2)
      // Held until answered: cash isn't counted twice meanwhile. "Not the same" releases the row.
      expect(await k.bal(acme, 'uncategorized_expense')).toBe(102_000)
      await k.engine.decideLink(k.ws, links[0]?.id as string, 'rejected', 'person-1')
      expect(await k.bal(acme, 'uncategorized_expense')).toBe(152_000)
      await expectBalanced(acme)
    })

    it('journal: the current books for export, balanced, without reversed entries', async () => {
      const bank = await k.account({ entityId: acme, name: 'Checking' })
      await k.engine.post(k.ws, txn(bank, '2026-09-05', -1_000, { counterparty: 'Figma' }))
      const rec = (await k.engine.store.listRecords(k.ws, { eventTypes: ['txn.upsert'] }))[0]
      await k.engine.setOverride(k.ws, rec?.id as string, { category: 'software' }, null)
      const j = await k.engine.journal(k.ws, { entityIds: [acme] })
      expect(j).toHaveLength(1)
      expect(j[0]?.lines.map((l) => [l.account.role, l.debitMinor, l.creditMinor])).toEqual(expect.arrayContaining([['software', 1_000, 0], [`cash:${bank.id}`, 0, 1_000]]))
      for (const e of j) expect(e.lines.reduce((s, l) => s + l.baseDebitMinor - l.baseCreditMinor, 0)).toBe(0)
      expect(await k.engine.journal(k.ws, { entityIds: [acme], from: '2026-10-01' })).toEqual([])
    })

    it('holds rows from an account with no company until it is assigned', async () => {
      const bank = await k.account({ entityId: null, name: 'New Chase' })
      const res = await k.engine.post(k.ws, txn(bank, '2026-09-05', -2_500))
      expect(res).toEqual({ journalEntryId: null, status: 'unassigned' })
      expect((await k.engine.reviewItems(k.ws)).map((i) => i.kind)).toContain('which_company')
      await k.assign(bank.id, acme)
      expect(await k.bal(acme, 'uncategorized_expense')).toBe(2_500)
      expect((await k.engine.reviewItems(k.ws)).map((i) => i.kind)).not.toContain('which_company')
    })
  })

  describe('processors (Stripe)', () => {
    async function stripeSetup(): Promise<{ st: Awaited<ReturnType<Kit['account']>>; bank: Awaited<ReturnType<Kit['account']>> }> {
      const st = await k.account({ entityId: acme, type: 'processor_balance', name: 'Stripe' })
      const bank = await k.account({ entityId: acme, name: 'Mercury' })
      return { st, bank }
    }

    it('revenue is gross charges, fees are expense, the payout is not revenue (exact payout id)', async () => {
      const { st, bank } = await stripeSetup()
      await k.engine.postBatch(k.ws, [
        stripe(st, '2026-09-01', 'charge', 10_000, 320, { customer: 'cus_1' }),
        stripe(st, '2026-09-03', 'payout', -9_680, 0, { externalId: 'po_1', payoutExternalId: 'po_1' }),
        txn(bank, '2026-09-05', 9_680, { rawText: 'STRIPE TRANSFER', linkRefs: { payout_id: 'po_1' } }),
      ])
      expect(await k.bal(acme, 'revenue')).toBe(-10_000)
      expect(await k.bal(acme, 'processor_fees')).toBe(320)
      expect(await k.bal(acme, `processor:${st.id}`)).toBe(0)
      expect(await k.bal(acme, 'clearing_payouts')).toBe(0)
      expect(await k.bal(acme, `cash:${bank.id}`)).toBe(9_680)
      const link = (await k.engine.store.listLinks(k.ws, { types: ['payout'] }))[0]
      expect(link?.method).toBe('exact_id')
      const rev = await k.engine.metric('revenue', { workspaceId: k.ws, entityIds: [acme], from: '2026-09-01', to: '2026-09-30' })
      expect(rev.value).toEqual(usd(10_000))
      await expectBalanced(acme)
    })

    it('matches a payout to its deposit without an id when the amount, window and name agree', async () => {
      const { st, bank } = await stripeSetup()
      await k.engine.postBatch(k.ws, [stripe(st, '2026-09-01', 'charge', 10_000, 320), stripe(st, '2026-09-03', 'payout', -9_680, 0), txn(bank, '2026-09-05', 9_680, { rawText: 'STRIPE PAYOUT' })])
      const link = (await k.engine.store.listLinks(k.ws, { types: ['payout'] }))[0]
      expect(link?.status).toBe('confirmed')
      expect(link?.confidence).toBe(0.97)
      expect(await k.bal(acme, 'clearing_payouts')).toBe(0)
      expect(await k.bal(acme, 'suspense')).toBe(0)
    })

    it('a re-emitted charge with a payout id is an update, not a duplicate to ignore', async () => {
      const { st } = await stripeSetup()
      const ch = stripe(st, '2026-09-01', 'charge', 10_000, 320)
      await k.engine.post(k.ws, ch)
      const again = await k.engine.post(k.ws, { ...ch, payoutExternalId: 'po_9' })
      expect(again.status).toBe('posted')
      expect(await k.bal(acme, 'revenue')).toBe(-10_000)
    })

    it('refunds and disputes reduce revenue; the processor identity holds', async () => {
      const { st } = await stripeSetup()
      await k.engine.postBatch(k.ws, [
        snapshot(st, '2026-08-31', 0),
        stripe(st, '2026-09-01', 'charge', 10_000, 320),
        stripe(st, '2026-09-02', 'charge', 5_000, 175),
        stripe(st, '2026-09-04', 'refund', -5_000, 0),
        stripe(st, '2026-09-06', 'dispute', -2_000, 1_500),
        stripe(st, '2026-09-07', 'payout', -3_000, 0),
        snapshot(st, '2026-09-30', 10_000 - 320 + 5_000 - 175 - 5_000 - 3_500 - 3_000),
      ])
      expect(await k.bal(acme, 'revenue')).toBe(-15_000)
      expect(await k.bal(acme, 'refunds')).toBe(7_000)
      expect(await k.bal(acme, 'processor_fees')).toBe(320 + 175 + 1_500)
      const checks = await k.engine.checks(k.ws, { entityIds: [acme] })
      const processor = checks.filter((c) => c.name === 'processor')
      expect(processor).toHaveLength(1)
      expect(processor[0]?.status).toBe('ok')
      const rev = await k.engine.metric('revenue', { workspaceId: k.ws, entityIds: [acme], from: '2026-09-01', to: '2026-09-30' })
      expect(rev.value).toEqual(usd(8_000))
      await expectBalanced(acme)
    })

    it('flags a processor whose rows do not explain its balance change', async () => {
      const { st } = await stripeSetup()
      await k.engine.postBatch(k.ws, [snapshot(st, '2026-08-31', 0), stripe(st, '2026-09-01', 'charge', 10_000, 320), snapshot(st, '2026-09-30', 9_000)])
      const p = (await k.engine.checks(k.ws, { entityIds: [acme] })).find((c) => c.name === 'processor')
      expect(p?.status).toBe('fail')
      expect(p?.differenceMinor).toBe(9_680 - 9_000)
    })

    it('rejects a processor row where gross − fee ≠ net and writes nothing from that batch', async () => {
      const { st, bank } = await stripeSetup()
      const bad = { ...stripe(st, '2026-09-01', 'charge', 10_000, 320), net: usd(9_999) }
      await expect(k.engine.postBatch(k.ws, [txn(bank, '2026-09-01', -100), bad])).rejects.toBeInstanceOf(PostingError)
      expect(await k.engine.store.listRecords(k.ws)).toEqual([])
      expect(await k.bal(acme, 'uncategorized_expense')).toBe(0)
    })

    it('without the processor connected, a payout deposit marked as payout is revenue net of fees', async () => {
      const bank = await k.account({ entityId: acme })
      await k.engine.post(k.ws, txn(bank, '2026-09-05', 9_680, { rawText: 'STRIPE TRANSFER' }))
      const rec = (await k.engine.store.listRecords(k.ws, { eventTypes: ['txn.upsert'] }))[0]
      await k.engine.setOverride(k.ws, rec?.id as string, { kind: 'payout' }, null)
      expect(await k.bal(acme, 'revenue')).toBe(-9_680)
      expect(await k.bal(acme, 'suspense')).toBe(0)
    })
  })

  describe('cash, whose money, intercompany', () => {
    it('cash told to the AI and deposited within a week links automatically (QA story 2)', async () => {
      const bank = await k.account({ entityId: acme, institution: 'Chase' } as never)
      const coh = await k.account({ entityId: acme, type: 'cash_on_hand', name: 'Cash on hand' })
      await k.engine.post(k.ws, snapshot(bank, '2026-10-01', 1_000_000))
      await k.engine.post(k.ws, txn(coh, '2026-10-02', 50_000, { counterparty: 'Walk-in customer' }), { origin: 'agent' })
      const cashRec = (await k.engine.store.listRecords(k.ws, { sourceAccountId: coh.id }))[0]
      await k.engine.setOverride(k.ws, cashRec?.id as string, { kind: 'cash_income' }, 'grant-1')
      await k.engine.postBatch(k.ws, [txn(bank, '2026-10-05', 50_000, { counterparty: 'Cash deposit', rawText: 'BRANCH CASH DEPOSIT' }), snapshot(bank, '2026-10-06', 1_050_000)])
      const link = (await k.engine.store.listLinks(k.ws, { types: ['cash_deposit'] }))[0]
      expect(link).toMatchObject({ status: 'confirmed', confidence: 0.96 })
      expect(await k.bal(acme, `cash:${coh.id}`)).toBe(0)
      expect((await k.engine.metric('cash', { workspaceId: k.ws, entityIds: [acme] })).value).toEqual(usd(1_050_000))
      const rev = await k.engine.metric('revenue', { workspaceId: k.ws, entityIds: [acme], from: '2026-10-01', to: '2026-10-31' })
      expect(rev.value).toEqual(usd(50_000))
      expect((await k.engine.reviewItems(k.ws, { entityIds: [acme] })).map((i) => i.kind)).not.toContain('unexplained_money')
    })

    it('a Square cash drawer: sales are revenue, a cash refund lowers sales, and the bank deposit of the takings settles the drawer', async () => {
      const bank = await k.account({ entityId: acme, name: 'Acme checking' })
      const drawer = await k.account({ entityId: acme, type: 'cash_on_hand', name: 'Square cash drawer (Main Street)' })
      const sale = (date: string, minor: number, id: string) => txn(drawer, date, minor, { externalId: `cash:${id}`, rawText: 'Square cash sale', categoryHint: 'INCOME_SALES', linkRefs: { square_payment: id } })
      await k.engine.postBatch(k.ws, [
        sale('2026-10-01', 900, 'p1'),
        sale('2026-10-01', 1_500, 'p2'),
        sale('2026-10-02', 4_000, 'p3'),
        txn(drawer, '2026-10-02', -500, { externalId: 'cashref:r1', rawText: 'Square refund paid from the cash drawer', categoryHint: 'SALES_REFUND', linkRefs: { refund_of: 'p2', square_refund: 'r1' } }),
      ])
      // Sales are revenue as they're rung up, the cash refund lowers them, and nothing asks "what is this money?".
      expect(await k.bal(acme, 'revenue')).toBe(-6_400)
      expect(await k.bal(acme, 'refunds')).toBe(500)
      expect(await k.bal(acme, 'suspense')).toBe(0)
      expect(await k.bal(acme, `cash:${drawer.id}`)).toBe(5_900)
      // Two days later the owner takes the drawer's takings to the bank: one deposit for all of it, less the refund.
      await k.engine.post(k.ws, txn(bank, '2026-10-04', 5_900, { rawText: 'BRANCH CASH DEPOSIT' }))
      const proposals = await k.engine.store.listLinks(k.ws, { types: ['cash_deposit'] })
      expect(proposals.map((l) => [l.status, l.confidence, l.amount?.minor]).sort()).toEqual([
        ['proposed', 0.9, 1_000],
        ['proposed', 0.9, 4_000],
        ['proposed', 0.9, 900],
      ].sort())
      for (const l of proposals) await k.engine.decideLink(k.ws, l.id, 'confirmed', 'person-1')
      // The drawer is empty, the bank holds the cash, and revenue is counted once.
      expect(await k.bal(acme, `cash:${drawer.id}`)).toBe(0)
      expect(await k.bal(acme, `cash:${bank.id}`)).toBe(5_900)
      expect(await k.bal(acme, 'revenue')).toBe(-6_400)
      expect(await k.bal(acme, 'suspense')).toBe(0)
      expect((await k.engine.reviewItems(k.ws, { entityIds: [acme] })).map((i) => i.kind)).not.toContain('unexplained_money')
      await expectBalanced(acme)
    })

    it('a cash refund from the drawer is not a trip to the bank: a single sale deposited later still matches', async () => {
      const bank = await k.account({ entityId: acme })
      const drawer = await k.account({ entityId: acme, type: 'cash_on_hand', name: 'Square cash drawer (Pop-up)' })
      await k.engine.postBatch(k.ws, [
        txn(drawer, '2026-10-01', 2_500, { externalId: 'cash:q1', categoryHint: 'INCOME_SALES' }),
        txn(drawer, '2026-10-01', 300, { externalId: 'cash:q2', categoryHint: 'INCOME_SALES' }),
        txn(drawer, '2026-10-01', -300, { externalId: 'cashref:q2r', categoryHint: 'SALES_REFUND', linkRefs: { refund_of: 'q2' } }),
      ])
      await k.engine.post(k.ws, txn(bank, '2026-10-03', 2_500, { rawText: 'CASH DEPOSIT' }))
      const links = await k.engine.store.listLinks(k.ws, { types: ['cash_deposit'] })
      expect(links.some((l) => l.amount?.minor === 2_500)).toBe(true)
    })

    it('cash told to the AI, later deposited, is income once', async () => {
      const coh = await k.account({ entityId: acme, type: 'cash_on_hand', name: 'Cash on hand' })
      const bank = await k.account({ entityId: acme })
      const r = await k.engine.post(k.ws, txn(coh, '2026-09-02', 50_000, { counterparty: 'Farmers market sales' }), { origin: 'agent', createdBy: 'grant-1' })
      const cashRec = (await k.engine.store.listRecords(k.ws, { sourceAccountId: coh.id }))[0]
      await k.engine.setOverride(k.ws, cashRec?.id as string, { kind: 'cash_income' }, 'grant-1')
      expect(await k.bal(acme, 'revenue')).toBe(-50_000)
      await k.engine.post(k.ws, txn(bank, '2026-09-10', 50_000, { rawText: 'CASH DEPOSIT BRANCH 042' }))
      // Eight days later is outside the auto window: proposed, and the deposit isn't also asked about.
      expect((await k.engine.reviewItems(k.ws, { entityIds: [acme] })).map((i) => i.kind)).toEqual(['suggested_match'])
      const proposal = (await k.engine.store.listLinks(k.ws, { types: ['cash_deposit'] }))[0]
      expect(proposal?.status).toBe('proposed')
      expect(proposal?.confidence).toBe(0.9)
      await k.engine.decideLink(k.ws, proposal?.id as string, 'confirmed', 'person-1')
      expect(await k.bal(acme, 'revenue')).toBe(-50_000)
      expect(await k.bal(acme, `cash:${coh.id}`)).toBe(0)
      expect(await k.bal(acme, `cash:${bank.id}`)).toBe(50_000)
      expect(await k.bal(acme, 'suspense')).toBe(0)
      const cash = await k.engine.metric('cash', { workspaceId: k.ws, entityIds: [acme] })
      expect(cash.value).toEqual(usd(50_000))
      // The AI-told cash is part of how the balance was reached.
      expect(cash.agentEntriesIncluded).toBe(1)
      void r
      await expectBalanced(acme)
    })

    it('founder pays a company cost personally: the company owes the founder, then repays', async () => {
      const me = await k.personal('Yisrael')
      const amex = await k.account({ entityId: me, type: 'credit_card', name: 'Personal Amex' })
      const myChecking = await k.account({ entityId: me, name: 'Personal checking' })
      const bank = await k.account({ entityId: acme, name: 'Acme Mercury' })
      await k.engine.post(k.ws, txn(amex, '2026-09-03', -30_000, { counterparty: 'AWS' }))
      const rec = (await k.engine.store.listRecords(k.ws, { sourceAccountId: amex.id }))[0]
      await k.engine.setOverride(k.ws, rec?.id as string, { forEntityId: acme, category: 'cloud' }, 'person-1')
      expect(await k.bal(me, `card:${amex.id}`)).toBe(-30_000)
      expect(await k.bal(me, `due_from:${acme}`)).toBe(30_000)
      expect(await k.bal(acme, 'cloud')).toBe(30_000)
      expect(await k.bal(acme, `owner_payable:${me}`)).toBe(-30_000)
      const owed = await k.engine.metric('owner_balance', { workspaceId: k.ws, entityIds: [acme] })
      expect(owed.value).toEqual(usd(30_000))

      await k.engine.postBatch(k.ws, [txn(bank, '2026-09-20', -30_000, { rawText: 'TRANSFER TO A MORGAN' }), txn(myChecking, '2026-09-20', 30_000, { rawText: 'ACME INC TRANSFER' })])
      await k.engine.reconcile(k.ws)
      const link = (await k.engine.store.listLinks(k.ws, { types: ['intercompany'] }))[0]
      expect(link?.status).toBe('proposed')
      await k.engine.decideLink(k.ws, link?.id as string, 'confirmed', 'person-1')
      expect(await k.bal(acme, `owner_payable:${me}`)).toBe(0)
      expect(await k.bal(me, `due_from:${acme}`)).toBe(0)
      expect((await k.engine.metric('owner_balance', { workspaceId: k.ws, entityIds: [acme] })).value).toEqual(usd(0))
      expect(await k.bal(acme, 'cloud')).toBe(30_000)
      await expectBalanced(acme, me)
    })

    it('a founder deposit is owner money, not revenue, until it is called a loan', async () => {
      const me = await k.personal('Yisrael')
      const mine = await k.account({ entityId: me })
      const bank = await k.account({ entityId: acme })
      await k.engine.postBatch(k.ws, [txn(mine, '2026-09-01', -1_000_000), txn(bank, '2026-09-01', 1_000_000)])
      const link = (await k.engine.store.listLinks(k.ws, { types: ['intercompany'] }))[0]
      // Cross-company matches always wait for a person (proposed as soon as both rows are posted).
      expect(link?.status).toBe('proposed')
      const proposed = (await k.engine.store.listLinks(k.ws, { types: ['intercompany'] }))[0]
      await k.engine.decideLink(k.ws, proposed?.id as string, 'confirmed', 'person-1')
      expect(await k.bal(acme, 'owner_money_unspecified')).toBe(-1_000_000)
      expect(await k.bal(acme, 'revenue')).toBe(0)
      expect((await k.engine.reviewItems(k.ws, { entityIds: [acme] })).map((i) => i.kind)).toContain('owner_money')
      const deposit = (await k.engine.store.listRecords(k.ws, { sourceAccountId: bank.id }))[0]
      await k.engine.setOverride(k.ws, deposit?.id as string, { kind: 'owner_loan' }, 'person-1')
      expect(await k.bal(acme, 'owner_money_unspecified')).toBe(0)
      expect(await k.bal(acme, `owner_payable:${me}`)).toBe(-1_000_000)
      expect((await k.engine.metric('owner_balance', { workspaceId: k.ws, entityIds: [acme] })).value).toEqual(usd(1_000_000))
      const rev = await k.engine.metric('revenue', { workspaceId: k.ws, entityIds: [acme], from: '2026-09-01', to: '2026-09-30' })
      expect(rev.value).toEqual(usd(0))
      await expectBalanced(acme, me)
    })

    it('intercompany pairs net to zero', async () => {
      const sub = await k.company('Sub')
      const hb = await k.account({ entityId: acme })
      const sb = await k.account({ entityId: sub })
      await k.engine.postBatch(k.ws, [txn(hb, '2026-10-01', -5_000_000, { rawText: 'WIRE TO SUB' }), txn(sb, '2026-10-01', 5_000_000, { rawText: 'WIRE FROM ACME' })])
      await k.engine.reconcile(k.ws)
      const link = (await k.engine.store.listLinks(k.ws, { types: ['intercompany'] }))[0]
      await k.engine.decideLink(k.ws, link?.id as string, 'confirmed', 'person-1')
      expect(await k.bal(acme, `due_from:${sub}`)).toBe(5_000_000)
      expect(await k.bal(sub, `due_to:${acme}`)).toBe(-5_000_000)
      const ic = (await k.engine.checks(k.ws, { entityIds: [acme, sub] })).filter((c) => c.name === 'intercompany')
      expect(ic.map((c) => c.status)).toEqual(['ok'])
      expect((await k.engine.metric('intercompany_balance', { workspaceId: k.ws, entityIds: [acme, sub] })).value).toEqual(usd(0))
      expect((await k.engine.metric('intercompany_balance', { workspaceId: k.ws, entityIds: [acme] })).value).toEqual(usd(5_000_000))
      await expectBalanced(acme, sub)
    })

    it('flags an intercompany balance that only one side recorded', async () => {
      const sub = await k.company('Sub')
      const hb = await k.account({ entityId: acme })
      const r = await k.engine.post(k.ws, txn(hb, '2026-10-01', -200_000))
      const rec = (await k.engine.store.listRecords(k.ws))[0]
      await k.engine.setOverride(k.ws, rec?.id as string, { kind: 'intercompany', forEntityId: undefined, ownerEntityId: undefined }, null)
      // Without a counterpart the money waits in suspense; naming the company books the receivable.
      await k.engine.setOverride(k.ws, rec?.id as string, { kind: 'intercompany', category: `due_from:${sub}` }, null)
      expect(await k.bal(acme, `due_from:${sub}`)).toBe(200_000)
      const ic = (await k.engine.checks(k.ws, { entityIds: [acme, sub] })).find((c) => c.name === 'intercompany')
      expect(ic?.status).toBe('fail')
      void r
    })
  })

  describe('multi-currency', () => {
    beforeEach(() => {
      k.rates.set('2026-09-01', 'EUR', 'USD', '1.10').set('2026-09-15', 'EUR', 'USD', '1.10').set('2026-09-16', 'EUR', 'USD', '1.08').set('2026-09-20', 'EUR', 'USD', '1.07').set('2026-10-09', 'EUR', 'USD', '1.05')
    })

    it('keeps the original currency on the line and books base at the day rate', async () => {
      const eurAcct = await k.account({ entityId: acme, currency: 'EUR', name: 'Wise EUR' })
      await k.engine.post(k.ws, txn(eurAcct, '2026-09-15', -10_000))
      expect(await k.bal(acme, 'uncategorized_expense')).toBe(11_000)
      const lines = await k.engine.store.listLines(k.ws, { basis: 'cash', entityIds: [acme] })
      const cashLine = lines.find((l) => l.creditMinor > 0)
      expect(cashLine).toMatchObject({ currency: 'EUR', creditMinor: 10_000, baseCreditMinor: 11_000, fxRate: '1.1' })
      await expectBalanced(acme)
    })

    it('books realized FX on a cross-currency transfer', async () => {
      const eurAcct = await k.account({ entityId: acme, currency: 'EUR' })
      const usdAcct = await k.account({ entityId: acme })
      await k.engine.postBatch(k.ws, [txn(eurAcct, '2026-09-15', -100_000, { rawText: 'TRANSFER' }), txn(usdAcct, '2026-09-16', 107_500, { rawText: 'TRANSFER' })])
      const link = (await k.engine.store.listLinks(k.ws, { types: ['transfer'] }))[0]
      expect(link?.status).toBe('confirmed')
      expect(await k.bal(acme, 'clearing_transfers')).toBe(0)
      expect(await k.bal(acme, 'fx_gain_loss')).toBe(2_500)
      await expectBalanced(acme)
    })

    it('settles a foreign invoice at its booked rate; the difference is realized FX (accrual)', async () => {
      const conn = await k.connection({ entityId: acme, key: 'quickbooks' })
      const eurAcct = await k.account({ entityId: acme, currency: 'EUR' })
      const inv = invoice(conn, { total: eur(100_000), issueDate: '2026-09-01', dueDate: '2026-09-30' })
      await k.engine.post(k.ws, inv)
      const pay = txn(eurAcct, '2026-09-20', 100_000, { counterparty: 'Globex Corp' })
      await k.engine.post(k.ws, pay)
      const [invRec] = await k.engine.store.listRecords(k.ws, { eventTypes: ['invoice.upsert'] })
      const [payRec] = await k.engine.store.listRecords(k.ws, { eventTypes: ['txn.upsert'] })
      const res = await k.engine.link(k.ws, { type: 'invoice_payment', fromId: invRec?.id as string, toId: payRec?.id as string, confidence: 1, method: 'human' })
      expect(res.status).toBe('confirmed')
      expect(await k.bal(acme, 'ar', 'accrual')).toBe(0)
      expect(await k.bal(acme, 'revenue', 'accrual')).toBe(-110_000)
      expect(await k.bal(acme, 'fx_gain_loss', 'accrual')).toBe(3_000)
      expect(await k.bal(acme, 'revenue', 'cash')).toBe(-107_000)
      expect(await k.bal(acme, 'fx_gain_loss', 'cash')).toBe(0)
      await expectBalanced(acme)
    })

    it("uses the provider's own rate for its documents, so foreign invoices match their books to the cent", async () => {
      const conn = await k.connection({ entityId: acme, key: 'quickbooks' })
      const eurAcct = await k.account({ entityId: acme, currency: 'EUR' })
      // QuickBooks booked it at 1.0850 (the market said 1.10 that day).
      await k.engine.post(k.ws, { ...invoice(conn, { externalId: 'INV-FX', total: eur(100_000), issueDate: '2026-09-01', dueDate: '2026-09-30' }), fx: { rate: '1.0850', home: 'USD' } })
      expect(await k.bal(acme, 'revenue', 'accrual')).toBe(-108_500)
      expect(await k.bal(acme, 'ar', 'accrual')).toBe(108_500)
      // The open-invoice list values it at the same booked rate, so the AR check agrees with the ledger.
      expect((await k.engine.checks(k.ws, { entityIds: [acme] })).find((c) => c.name === 'subledger_ar')?.status).toBe('ok')
      // Paid into the euro account at the provider's 1.0700: AR clears at the booked 1.0850, the rest is realized FX.
      await k.engine.post(k.ws, { ...txn(eurAcct, '2026-09-20', 100_000, { counterparty: 'Globex Corp' }), fx: { rate: '1.0700', home: 'USD' } })
      const [invRec] = await k.engine.store.listRecords(k.ws, { eventTypes: ['invoice.upsert'] })
      const [payRec] = await k.engine.store.listRecords(k.ws, { eventTypes: ['txn.upsert'] })
      await k.engine.link(k.ws, { type: 'invoice_payment', fromId: invRec?.id as string, toId: payRec?.id as string, confidence: 1, method: 'human' })
      expect(await k.bal(acme, 'ar', 'accrual')).toBe(0)
      expect(await k.bal(acme, 'fx_gain_loss', 'accrual')).toBe(1_500)
      expect(await k.bal(acme, `cash:${eurAcct.id}`, 'accrual')).toBe(107_000)
      // The provider revising its rate reposts the document.
      await k.engine.post(k.ws, { ...invoice(conn, { externalId: 'INV-FX', total: eur(100_000), issueDate: '2026-09-01', dueDate: '2026-09-30' }), fx: { rate: '1.0900', home: 'USD' } })
      expect(await k.bal(acme, 'revenue', 'accrual')).toBe(-109_000)
      expect(await k.bal(acme, 'fx_gain_loss', 'accrual')).toBe(2_000)
      await expectBalanced(acme)
    })

    it("ignores a provider rate into another home currency (the market rate converts instead)", async () => {
      const conn = await k.connection({ entityId: acme, key: 'xero' })
      // The Xero organisation keeps its books in CAD; this company's are in USD.
      await k.engine.post(k.ws, { ...invoice(conn, { externalId: 'INV-CAD', total: eur(100_000), issueDate: '2026-09-01', dueDate: '2026-09-30' }), fx: { rate: '1.4800', home: 'CAD' } })
      expect(await k.bal(acme, 'revenue', 'accrual')).toBe(-110_000)
      await expectBalanced(acme)
    })

    it('a provider rate respects minor-unit sizes (yen has none)', async () => {
      const conn = await k.connection({ entityId: acme, key: 'quickbooks' })
      await k.engine.post(k.ws, { ...invoice(conn, { externalId: 'INV-JPY', total: { minor: 1_000_000, currency: 'JPY' }, issueDate: '2026-09-01', dueDate: '2026-09-30' }), fx: { rate: '0.006712', home: 'USD' } })
      expect(await k.bal(acme, 'revenue', 'accrual')).toBe(-671_200) // ¥1,000,000 × 0.006712 = $6,712.00
      await expectBalanced(acme)
    })

    it('balance sheet revalues foreign balances at the as-of rate and still balances', async () => {
      const eurAcct = await k.account({ entityId: acme, currency: 'EUR' })
      await k.engine.postBatch(k.ws, [snapshot(eurAcct, '2026-09-01', 100_000)])
      const bs = await k.engine.balanceSheet(k.ws, { entityIds: [acme], asOf: '2026-10-09', basis: 'cash' })
      expect(bs.assets.total).toEqual(usd(105_000))
      expect(bs.difference).toBe(0)
      expect(bs.equity.lines.find((l) => l.role === 'fx_revaluation')?.amount).toEqual(usd(-5_000))
    })
  })

  describe('invoices, payments, credit notes', () => {
    it('books AR on issue (accrual) and revenue on payment (cash), splitting tax', async () => {
      const conn = await k.connection({ entityId: acme, key: 'quickbooks' })
      const bank = await k.account({ entityId: acme })
      const inv = invoice(conn, { total: usd(108_000), tax: usd(8_000), number: 'INV-104' })
      await k.engine.post(k.ws, inv)
      expect(await k.bal(acme, 'ar', 'accrual')).toBe(108_000)
      expect(await k.bal(acme, 'revenue', 'accrual')).toBe(-100_000)
      expect(await k.bal(acme, 'sales_tax_payable', 'accrual')).toBe(-8_000)
      expect(await k.bal(acme, 'revenue', 'cash')).toBe(0)

      await k.engine.post(k.ws, txn(bank, '2026-09-10', 40_000, { counterparty: 'Globex Corp', rawText: 'GLOBEX CORP INV-104' }))
      const [invRec] = await k.engine.store.listRecords(k.ws, { eventTypes: ['invoice.upsert'] })
      const [payRec] = await k.engine.store.listRecords(k.ws, { eventTypes: ['txn.upsert'] })
      await k.engine.link(k.ws, { type: 'invoice_payment', fromId: invRec?.id as string, toId: payRec?.id as string, amount: usd(40_000), confidence: 1, method: 'human' })
      // 40,000 split 100,000 : 8,000 by largest remainder → 37,037 revenue + 2,963 tax.
      expect(await k.bal(acme, 'revenue', 'cash')).toBe(-37_037)
      expect(await k.bal(acme, 'sales_tax_payable', 'cash')).toBe(-2_963)
      expect(await k.bal(acme, 'ar', 'accrual')).toBe(68_000)
      expect(await k.bal(acme, 'suspense', 'cash')).toBe(0)

      const scope = { workspaceId: k.ws, entityIds: [acme] }
      expect((await k.engine.metric('ar_open', scope)).value).toEqual(usd(68_000))
      expect((await k.engine.metric('ar_overdue', scope)).value).toEqual(usd(68_000))
      // The provider later reports the partial payment; nothing is counted twice.
      await k.engine.post(k.ws, { ...inv, amountPaid: usd(40_000), status: 'partially_paid' })
      expect((await k.engine.metric('ar_open', scope)).value).toEqual(usd(68_000))
      const sub = (await k.engine.checks(k.ws, { entityIds: [acme] })).find((c) => c.name === 'subledger_ar')
      expect(sub?.status).toBe('ok')
      await expectBalanced(acme)
    })

    it('checks and review are reused between writes, never after one', async () => {
      const bank = await k.account({ entityId: acme })
      await k.engine.post(k.ws, txn(bank, '2026-09-10', 90_000, { counterparty: 'Unknown sender' }))
      const first = await k.engine.reviewItems(k.ws)
      expect(await k.engine.reviewItems(k.ws)).toEqual(first)
      await k.engine.post(k.ws, txn(bank, '2026-09-11', 70_000, { counterparty: 'Another sender' }))
      expect((await k.engine.reviewItems(k.ws)).length).toBe(first.length + 1)
      // Hits are copies: changing one doesn't change the next answer.
      const again = await k.engine.reviewItems(k.ws)
      again.pop()
      expect((await k.engine.reviewItems(k.ws)).length).toBe(first.length + 1)
    })

    it('a sync page still matches an old invoice and a transfer whose other half came in an earlier page', async () => {
      const conn = await k.connection({ entityId: acme })
      const checking = await k.account({ entityId: acme, name: 'Checking' })
      const savings = await k.account({ entityId: acme, name: 'Savings' })
      await k.engine.post(k.ws, invoice(conn, { total: usd(250_000), number: 'INV-17', counterparty: 'Initech LLC', issueDate: '2025-06-01', dueDate: '2025-07-01' }))
      await k.engine.postBatch(k.ws, [txn(checking, '2026-09-29', -100_000, { rawText: 'ONLINE TRANSFER TO SAV 1234' })])
      await k.engine.postBatch(k.ws, [
        txn(savings, '2026-10-02', 100_000, { rawText: 'ONLINE TRANSFER FROM CHK' }),
        txn(checking, '2026-10-02', 250_000, { counterparty: 'Initech LLC', rawText: 'INITECH LLC PAYMENT INV-17' }),
      ])
      expect((await k.engine.store.listLinks(k.ws, { types: ['transfer'] }))[0]?.status).toBe('confirmed')
      expect((await k.engine.store.listLinks(k.ws, { types: ['invoice_payment'] })).length).toBe(1)
    })

    it('matches a payment to an invoice by amount, name and reference, and auto-confirms at ≥ 0.95', async () => {
      const conn = await k.connection({ entityId: acme })
      const bank = await k.account({ entityId: acme })
      await k.engine.post(k.ws, invoice(conn, { total: usd(250_000), number: 'INV-200', counterparty: 'Initech LLC', issueDate: '2026-09-01', dueDate: '2026-10-01' }))
      await k.engine.post(k.ws, txn(bank, '2026-09-28', 250_000, { counterparty: 'Initech LLC', rawText: 'INITECH LLC PAYMENT INV-200' }))
      const link = (await k.engine.store.listLinks(k.ws, { types: ['invoice_payment'] }))[0]
      expect(link?.status).toBe('confirmed')
      // 0.45 amount + 0.25 × 0.9 name + 0.20 reference + 0.10 date = 0.975
      expect(link?.confidence).toBe(0.975)
      expect(link?.method).toBe('fuzzy')
      expect(await k.bal(acme, 'ar', 'accrual')).toBe(0)
      expect(await k.bal(acme, 'revenue', 'cash')).toBe(-250_000)
    })

    it('a bill paid after the as-of date is still open on it (the subledger agrees with AP)', async () => {
      const conn = await k.connection({ entityId: acme, key: 'xero' })
      // Synced after it was paid: the bill already says paid in full, but the payment is dated 10-11.
      await k.engine.post(k.ws, invoice(conn, { externalId: 'bill-471', direction: 'payable', counterparty: 'Supplier', total: usd(20_000), issueDate: '2026-10-01', dueDate: '2026-10-15', amountPaid: usd(20_000), status: 'paid' }))
      await k.engine.post(k.ws, { type: 'payment.applied', externalId: 'pay-471', connectionId: conn, direction: 'payable', date: '2026-10-11', amount: usd(20_000), applications: [{ invoiceExternalId: 'bill-471', amount: usd(20_000) }] })
      const onTenth = (await k.engine.checks(k.ws, { asOf: '2026-10-10' })).find((c) => c.name === 'subledger_ap' && c.entityId === acme)
      expect(onTenth?.status).toBe('ok')
      expect((await k.engine.metric('ap_due', { workspaceId: k.ws, entityIds: [acme], to: '2026-10-10' })).value).toEqual(usd(20_000))
      const onEleventh = (await k.engine.checks(k.ws, { asOf: '2026-10-11' })).find((c) => c.name === 'subledger_ap' && c.entityId === acme)
      expect(onEleventh?.status).toBe('ok')
    })

    it('a payment told by the invoicing tool clears through the bank row it names', async () => {
      const conn = await k.connection({ entityId: acme, key: 'quickbooks' })
      const bank = await k.account({ entityId: acme })
      await k.engine.post(k.ws, invoice(conn, { externalId: 'inv-50', total: usd(50_000) }))
      await k.engine.post(k.ws, {
        type: 'payment.applied',
        externalId: 'pay-1',
        connectionId: conn,
        direction: 'receivable',
        date: '2026-09-12',
        amount: usd(50_000),
        applications: [{ invoiceExternalId: 'inv-50', amount: usd(50_000) }],
        bankTxnRef: 'bank-77',
      })
      expect(await k.bal(acme, 'clearing_unmatched_receipts')).toBe(50_000)
      await k.engine.post(k.ws, txn(bank, '2026-09-12', 50_000, { externalId: 'bank-77', counterparty: 'Globex Corp' }))
      for (const basis of ['cash', 'accrual'] as const) expect(await k.bal(acme, 'clearing_unmatched_receipts', basis)).toBe(0)
      expect(await k.bal(acme, 'ar', 'accrual')).toBe(0)
      expect(await k.bal(acme, 'revenue', 'cash')).toBe(-50_000)
      expect(await k.bal(acme, 'revenue', 'accrual')).toBe(-50_000)
      expect((await k.engine.metric('ar_open', { workspaceId: k.ws, entityIds: [acme] })).value).toEqual(usd(0))
      // A deleted payment reverses its application.
      await k.engine.post(k.ws, { type: 'payment.applied', externalId: 'pay-1', connectionId: conn, direction: 'receivable', date: '2026-09-12', amount: usd(0), applications: [], status: 'void' } as NormalizedEvent)
      expect(await k.bal(acme, 'ar', 'accrual')).toBe(50_000)
      await expectBalanced(acme)
    })

    it('credit notes reduce revenue; uncollectible invoices go to bad debt', async () => {
      const conn = await k.connection({ entityId: acme })
      await k.engine.post(k.ws, invoice(conn, { externalId: 'inv-7', total: usd(30_000) }))
      await k.engine.post(k.ws, { type: 'credit_note.upsert', externalId: 'cn-1~p', connectionId: conn, direction: 'receivable', invoiceExternalId: 'inv-7', date: '2026-09-05', amount: usd(5_000), appliedTo: 'invoice' })
      await k.engine.post(k.ws, { type: 'credit_note.upsert', externalId: 'cn-1', connectionId: conn, direction: 'receivable', date: '2026-09-05', amount: usd(2_000), appliedTo: 'customer_credit' })
      expect(await k.bal(acme, 'revenue', 'accrual')).toBe(-23_000)
      expect(await k.bal(acme, 'ar', 'accrual')).toBe(25_000)
      expect(await k.bal(acme, 'customer_deposits', 'accrual')).toBe(-2_000)
      await k.engine.post(k.ws, invoice(conn, { externalId: 'inv-8', total: usd(10_000), amountPaid: usd(4_000), status: 'uncollectible' }))
      expect(await k.bal(acme, 'bad_debt', 'accrual')).toBe(6_000)
      // Bad debt never counts as burn.
      expect((await k.engine.metric('gross_burn', { workspaceId: k.ws, entityIds: [acme], from: '2026-09-01', to: '2026-09-30' })).value).toBeNull()
      await expectBalanced(acme)
    })

    it('a customer credit note with tax gives back revenue net of tax and the tax itself', async () => {
      const conn = await k.connection({ entityId: acme })
      await k.engine.post(k.ws, invoice(conn, { externalId: 'inv-t', total: usd(108_000), tax: usd(8_000) }))
      await k.engine.post(k.ws, { type: 'credit_note.upsert', externalId: 'cn-t', connectionId: conn, direction: 'receivable', invoiceExternalId: 'inv-t', date: '2026-09-06', amount: usd(54_100), tax: usd(4_100), appliedTo: 'invoice' })
      expect(await k.bal(acme, 'revenue', 'accrual')).toBe(-50_000)
      expect(await k.bal(acme, 'sales_tax_payable', 'accrual')).toBe(-3_900)
      expect(await k.bal(acme, 'ar', 'accrual')).toBe(53_900)
      await expect(k.engine.post(k.ws, { type: 'credit_note.upsert', externalId: 'cn-bad', connectionId: conn, direction: 'receivable', date: '2026-09-06', amount: usd(1_000), tax: usd(2_000), appliedTo: 'invoice' })).rejects.toThrow(/tax/)
      await expectBalanced(acme)
    })

    it('bills post by line category to expense and AP', async () => {
      const conn = await k.connection({ entityId: acme })
      await k.engine.post(
        k.ws,
        invoice(conn, {
          direction: 'payable',
          counterparty: 'Law firm',
          total: usd(12_000),
          lines: [
            { description: 'Advice', amount: usd(10_000), category: 'professional_fees' },
            { description: 'Hosting', amount: usd(2_000), category: 'cloud' },
          ] as never,
        }),
      )
      expect(await k.bal(acme, 'professional_fees', 'accrual')).toBe(10_000)
      expect(await k.bal(acme, 'cloud', 'accrual')).toBe(2_000)
      expect(await k.bal(acme, 'ap', 'accrual')).toBe(-12_000)
      expect((await k.engine.metric('ap_due', { workspaceId: k.ws, entityIds: [acme] })).value).toEqual(usd(12_000))
    })
  })

  describe('payroll and equity', () => {
    it('accrues a payroll run and settles it with the provider debits', async () => {
      const conn = await k.connection({ entityId: acme, key: 'gusto' })
      const bank = await k.account({ entityId: acme })
      await k.engine.postBatch(k.ws, [txn(bank, '2026-09-14', -750_000, { rawText: 'GUSTO NET 8812' }), txn(bank, '2026-09-15', -326_500, { rawText: 'GUSTO TAX 8812' })])
      await k.engine.post(k.ws, {
        type: 'payroll.run',
        externalId: 'run-1',
        connectionId: conn,
        payDate: '2026-09-15',
        gross: usd(1_000_000),
        employerTaxes: usd(76_500),
        net: usd(750_000),
        employeeTaxes: usd(250_000),
        companyDebit: usd(1_076_500),
        status: 'paid',
      })
      const links = await k.engine.store.listLinks(k.ws, { types: ['payroll_settlement'] })
      expect(links.map((l) => l.status)).toEqual(['confirmed', 'confirmed'])
      expect(await k.bal(acme, 'payroll_expense', 'accrual')).toBe(1_000_000)
      expect(await k.bal(acme, 'payroll_taxes', 'accrual')).toBe(76_500)
      expect(await k.bal(acme, 'payroll_liabilities', 'accrual')).toBe(0)
      expect(await k.bal(acme, 'payroll_expense', 'cash')).toBe(750_000)
      expect(await k.bal(acme, 'payroll_taxes', 'cash')).toBe(326_500)
      const scope = { workspaceId: k.ws, entityIds: [acme], from: '2026-09-01', to: '2026-09-30' }
      expect((await k.engine.metric('payroll_cost', scope)).value).toEqual(usd(1_076_500))
      expect((await k.engine.metric('gross_burn', scope)).value).toEqual(usd(1_076_500))
      await expectBalanced(acme)
    })

    it('a bank-detected payroll run is never accrued twice', async () => {
      const conn = await k.connection({ entityId: acme, key: 'payroll-detect' })
      const bank = await k.account({ entityId: acme })
      const debit = txn(bank, '2026-09-15', -500_000, { rawText: 'ADP PAYROLL' })
      await k.engine.post(k.ws, debit)
      await k.engine.post(k.ws, { type: 'payroll.run', externalId: 'det-1', connectionId: conn, payDate: '2026-09-15', gross: usd(500_000), employerTaxes: usd(0), net: usd(500_000), estimated: true, source: 'bank_detected', settlementTxnExternalIds: [debit.externalId] })
      expect(await k.bal(acme, 'payroll_expense', 'accrual')).toBe(500_000)
      expect(await k.bal(acme, 'payroll_expense', 'cash')).toBe(500_000)
      expect(await k.bal(acme, 'payroll_liabilities', 'accrual')).toBe(0)
    })

    it('a reported run supersedes a bank-detected estimate: cost counted once, debits relinked', async () => {
      const det = await k.connection({ entityId: acme, key: 'payroll-detect' })
      const gusto = await k.connection({ entityId: acme, key: 'gusto' })
      const bank = await k.account({ entityId: acme })
      const net = txn(bank, '2026-09-15', -750_000, { rawText: 'GUSTO NET' })
      const tax = txn(bank, '2026-09-15', -326_500, { rawText: 'GUSTO TAX' })
      await k.engine.postBatch(k.ws, [net, tax])
      const estimate = { type: 'payroll.run' as const, externalId: 'est-1', connectionId: det, payDate: '2026-09-15', gross: usd(1_076_500), employerTaxes: usd(0), net: usd(750_000), estimated: true, source: 'bank_detected' as const, settlementTxnExternalIds: [net.externalId, tax.externalId] }
      await k.engine.post(k.ws, estimate)
      expect((await k.engine.store.listLinks(k.ws, { types: ['payroll_settlement'], statuses: ['confirmed'] })).length).toBe(2)
      // The provider run arrives (its exact links can't take money the estimate holds yet), then the estimate is voided.
      await k.engine.post(k.ws, { type: 'payroll.run', externalId: 'run-9', connectionId: gusto, payDate: '2026-09-15', gross: usd(1_000_000), employerTaxes: usd(76_500), net: usd(750_000), companyDebit: usd(1_076_500), status: 'paid', settlementTxnExternalIds: [net.externalId, tax.externalId] })
      await k.engine.post(k.ws, { ...estimate, status: 'void' })
      const confirmed = await k.engine.store.listLinks(k.ws, { types: ['payroll_settlement'], statuses: ['confirmed'] })
      const run = await k.engine.recordIdFor(k.ws, gusto, 'payroll.run', 'run-9')
      expect(confirmed.map((l) => l.fromId)).toEqual([run, run])
      const scope = { workspaceId: k.ws, entityIds: [acme], from: '2026-09-01', to: '2026-09-30' }
      expect((await k.engine.metric('payroll_cost', scope)).value).toEqual(usd(1_076_500))
      expect(await k.bal(acme, 'payroll_liabilities', 'accrual')).toBe(0)
      expect(await k.bal(acme, 'payroll_expense', 'cash') + (await k.bal(acme, 'payroll_taxes', 'cash'))).toBe(1_076_500)
      await expectBalanced(acme)
    })

    it('SAFE money is financing, never revenue', async () => {
      const conn = await k.connection({ entityId: acme, key: 'carta' })
      const bank = await k.account({ entityId: acme })
      await k.engine.post(k.ws, { type: 'equity.event', externalId: 'safe-1', connectionId: conn, kind: 'safe', date: '2026-09-20', stakeholder: 'Sequoia Capital', amount: usd(50_000_000) })
      await k.engine.post(k.ws, txn(bank, '2026-09-21', 50_000_000, { counterparty: 'SEQUOIA CAPITAL' }))
      const link = (await k.engine.store.listLinks(k.ws, { types: ['equity_cash'] }))[0]
      expect(link?.status).toBe('confirmed')
      expect(await k.bal(acme, 'safes')).toBe(-50_000_000)
      expect(await k.bal(acme, 'clearing_equity')).toBe(0)
      expect(await k.bal(acme, 'revenue')).toBe(0)
      expect(await k.bal(acme, 'suspense')).toBe(0)
      await expectBalanced(acme)
    })
  })

  describe('equity raised before the bank history', () => {
    it('is inside the opening balance, not money in transit; a SAFE inside the history still waits for its wire', async () => {
      const conn = await k.connection({ entityId: acme, key: 'carta' })
      const bank = await k.account({ entityId: acme })
      const seed = { type: 'equity.event' as const, externalId: 'seed', connectionId: conn, kind: 'issuance' as const, date: '2024-03-01', stakeholder: 'Seed investors', amount: usd(150_006_000) }
      const safe = { type: 'equity.event' as const, externalId: 'safe-2', connectionId: conn, kind: 'safe' as const, date: '2026-09-20', stakeholder: 'Angel', amount: usd(2_500_000) }
      // The cap table syncs first: with no bank history yet, both wait in clearing.
      await k.engine.postBatch(k.ws, [seed, safe])
      expect(await k.bal(acme, 'clearing_equity')).toBe(152_506_000)
      // Two years of bank history arrive, starting after the seed round (its money is in the opening balance).
      await k.engine.postBatch(k.ws, [txn(bank, '2025-01-05', -20_000), snapshot(bank, '2026-09-30', 150_000_000)], { settleLater: true })
      await k.engine.settle(k.ws, bank.connectionId as string)
      expect(await k.bal(acme, 'clearing_equity')).toBe(2_500_000) // only the SAFE, whose wire hasn't come
      expect(await k.bal(acme, 'paid_in_capital')).toBe(-150_006_000)
      expect(await k.bal(acme, 'opening_balance_equity')).toBe(-150_020_000 + 150_006_000)
      await expectBalanced(acme)
      // Posted after the history exists, the same rule applies at once.
      await k.engine.post(k.ws, { ...seed, externalId: 'founders', stakeholder: 'Founders', amount: usd(62_000) })
      expect(await k.bal(acme, 'clearing_equity')).toBe(2_500_000)
    })
  })

  describe('opening balances and balance identity', () => {
    it('the first provider balance sets the opening balance, even after a backfill', async () => {
      const bank = await k.account({ entityId: acme })
      await k.engine.postBatch(k.ws, [txn(bank, '2026-09-10', -20_000), txn(bank, '2026-09-20', 5_000), snapshot(bank, '2026-09-30', 1_000_000)])
      expect(await k.bal(acme, 'opening_balance_equity')).toBe(-1_015_000)
      expect(await k.bal(acme, `cash:${bank.id}`, 'cash', '2026-09-30')).toBe(1_000_000)
      expect(await k.bal(acme, `cash:${bank.id}`, 'cash', '2026-09-09')).toBe(1_015_000)
      await k.engine.post(k.ws, txn(bank, '2026-08-01', -3_000))
      expect(await k.bal(acme, `cash:${bank.id}`, 'cash', '2026-09-30')).toBe(1_000_000)
      expect(await k.bal(acme, `cash:${bank.id}`, 'cash', '2026-07-31')).toBe(1_018_000)
      const ok = (await k.engine.checks(k.ws, { entityIds: [acme] })).filter((c) => c.name === 'balance_identity')
      expect(ok.map((c) => c.status)).toEqual(['ok'])
      await expectBalanced(acme)
    })

    it('fails when the provider balance moves without rows to explain it, and recovers when they arrive', async () => {
      const bank = await k.account({ entityId: acme })
      await k.engine.postBatch(k.ws, [snapshot(bank, '2026-09-30', 1_000_000), snapshot(bank, '2026-10-05', 990_000)])
      const bad = (await k.engine.checks(k.ws, { entityIds: [acme] })).find((c) => c.name === 'balance_identity')
      expect(bad).toMatchObject({ status: 'fail', expectedMinor: -10_000, actualMinor: 0, differenceMinor: -10_000 })
      const cash = await k.engine.metric('cash', { workspaceId: k.ws, entityIds: [acme] })
      expect(cash.failedChecks.map((c) => c.name)).toContain('balance_identity')
      await k.engine.post(k.ws, txn(bank, '2026-10-03', -10_000))
      const good = (await k.engine.checks(k.ws, { entityIds: [acme] })).filter((c) => c.name === 'balance_identity')
      expect(good.map((c) => c.status)).toEqual(['ok'])
    })

    // Mon 2026-10-19 … Mon 2026-10-26: a provider balance every day.
    const daily = (acc: Awaited<ReturnType<Kit['account']>>, from: number, moves: Record<string, number>) => {
      let bal = from
      return ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26'].map((d) => snapshot(acc, d, (bal += moves[d] ?? 0)))
    }
    const balanceChecks = async () => (await k.engine.checks(k.ws, { entityIds: [acme] })).filter((c) => c.name === 'balance_identity')

    it("a bank that moves its balance a day after the row's date is posting lag, not a mismatch", async () => {
      k.setNow('2026-10-28T12:00:00.000Z')
      const bank = await k.account({ entityId: acme })
      // The row says the 20th; the balance moved on the 21st. Another on Fri the 23rd shows on Mon the 26th.
      await k.engine.postBatch(k.ws, [...daily(bank, 1_000_000, { '2026-10-21': -6_000, '2026-10-26': -2_500 }), txn(bank, '2026-10-20', -6_000), txn(bank, '2026-10-23', -2_500)])
      expect((await balanceChecks()).map((c) => c.status)).toEqual(['ok'])
    })

    it('a difference still open after two business days fails once per account, with what moved and what was posted', async () => {
      k.setNow('2026-10-28T12:00:00.000Z')
      const bank = await k.account({ entityId: acme })
      // $100 left on the 20th with no row; on the 22nd another $40 with no row; a $25 row that the bank never moved.
      await k.engine.postBatch(k.ws, [...daily(bank, 1_000_000, { '2026-10-20': -10_000, '2026-10-22': -4_000 }), txn(bank, '2026-10-21', -2_500)])
      const checks = await balanceChecks()
      expect(checks).toHaveLength(1)
      expect(checks[0]).toMatchObject({ status: 'fail', subjectId: bank.id })
      expect(checks[0]!.differenceMinor).not.toBe(0)
      const health = await k.engine.dataHealth(k.ws, [acme])
      expect(health.line).toContain("1 balance doesn't match")
    })

    it("a lag that never catches up is a real difference, not posting lag", async () => {
      k.setNow('2026-10-28T12:00:00.000Z')
      const bank = await k.account({ entityId: acme })
      // The row is dated the 20th, but the bank never moves: still open on the 26th.
      await k.engine.postBatch(k.ws, [...daily(bank, 1_000_000, {}), txn(bank, '2026-10-20', -6_000)])
      expect(await balanceChecks()).toEqual([expect.objectContaining({ status: 'fail', expectedMinor: 0, actualMinor: -6_000, differenceMinor: 6_000 })])
    })

    it('a row that posts later than the window clears once the balance catches up', async () => {
      k.setNow('2026-10-28T12:00:00.000Z')
      const bank = await k.account({ entityId: acme })
      // The row is dated Tue the 20th; the bank moves on Mon the 26th, four business days later.
      await k.engine.postBatch(k.ws, [...daily(bank, 1_000_000, { '2026-10-26': -6_000 }), txn(bank, '2026-10-20', -6_000)])
      expect((await balanceChecks()).map((c) => c.status)).toEqual(['ok'])
    })

    it('a gap that opened within the last two business days is a warning, not a mismatch yet', async () => {
      k.setNow('2026-10-27T12:00:00.000Z')
      const bank = await k.account({ entityId: acme })
      await k.engine.postBatch(k.ws, [...daily(bank, 1_000_000, { '2026-10-26': -3_000 })])
      expect((await balanceChecks()).map((c) => [c.status, c.expectedMinor, c.actualMinor])).toEqual([['warn', -3_000, 0]])
    })

    it('a brokerage balance (market value) is never checked against posted rows', async () => {
      const brokerage = await k.account({ entityId: acme, type: 'investment', includeInCash: false })
      await k.engine.postBatch(k.ws, [snapshot(brokerage, '2026-09-30', 872_522), snapshot(brokerage, '2026-10-05', 880_100), txn(brokerage, '2026-10-01', 3)])
      expect(await balanceChecks()).toEqual([])
    })

    it('liability balances are negative (owed) and match card rows', async () => {
      const card = await k.account({ entityId: acme, type: 'credit_card' })
      await k.engine.postBatch(k.ws, [txn(card, '2026-09-10', -20_000), snapshot(card, '2026-09-30', -45_000)])
      expect(await k.bal(acme, `card:${card.id}`)).toBe(-45_000)
      expect((await k.engine.metric('card_balances', { workspaceId: k.ws, entityIds: [acme] })).value).toEqual(usd(45_000))
    })
  })

  describe('rules', () => {
    it('applies a rule to past and future rows and records each application', async () => {
      const bank = await k.account({ entityId: acme })
      await k.engine.post(k.ws, txn(bank, '2026-09-02', -9_900, { counterparty: 'AWS EMEA' }))
      const rule = await k.engine.createRule(k.ws, { name: 'AWS is cloud', conditions: { textPatterns: ['*aws*'], direction: 'out' }, actions: { category: 'cloud' } })
      expect(await k.bal(acme, 'cloud')).toBe(9_900)
      await k.engine.post(k.ws, txn(bank, '2026-10-02', -9_900, { counterparty: 'AWS EMEA' }))
      expect(await k.bal(acme, 'cloud')).toBe(19_800)
      expect((await k.engine.store.getRule(k.ws, rule.id))?.hitCount).toBe(2)
      expect(await k.engine.store.listRuleApplications(k.ws)).toHaveLength(2)
      // A person's choice beats the rule.
      const [first] = await k.engine.store.listRecords(k.ws, { eventTypes: ['txn.upsert'] })
      await k.engine.setOverride(k.ws, first?.id as string, { category: 'software' }, 'person-1')
      expect(await k.bal(acme, 'cloud')).toBe(9_900)
      expect(await k.bal(acme, 'software')).toBe(9_900)
    })

    it('suggests a rule after the same choice three times, applies it once accepted', async () => {
      const bank = await k.account({ entityId: acme })
      for (const [i, d] of ['2026-07-03', '2026-08-03', '2026-09-03'].entries()) {
        await k.engine.post(k.ws, txn(bank, d, -1_500, { counterparty: `FIGMA ${1000 + i}` }))
      }
      const recs = await k.engine.store.listRecords(k.ws, { eventTypes: ['txn.upsert'] })
      const learned = async () => (await k.engine.store.listRules(k.ws)).filter((r) => r.origin === 'learned')
      for (const [i, r] of recs.entries()) {
        await k.engine.setOverride(k.ws, r.id, { category: 'software' }, 'person-1')
        if (i === 1) expect(await learned()).toEqual([])
      }
      // The third answer by hand suggests it on its own (setOverride runs the suggestion).
      const [suggested] = await learned()
      expect(suggested).toMatchObject({ status: 'suggested', origin: 'learned', conditions: { textPatterns: ['*figma*'], direction: 'out' }, actions: { category: 'software' } })
      expect(await k.engine.suggestRules(k.ws)).toEqual([]) // idempotent
      expect((await k.engine.reviewItems(k.ws)).map((i) => i.kind)).toContain('suggested_rule')
      await k.engine.setRuleStatus(k.ws, suggested?.id as string, 'active')
      await k.engine.post(k.ws, txn(bank, '2026-10-03', -1_500, { counterparty: 'FIGMA 2001' }))
      expect(await k.bal(acme, 'software')).toBe(6_000)
    })

    it('routes "whose money" by rule: a shared card used for another company', async () => {
      const sub = await k.company('Memoe')
      const card = await k.account({ entityId: acme, type: 'credit_card' })
      await k.engine.createRule(k.ws, { name: 'Vercel is Memoe', conditions: { textPatterns: ['vercel'] }, actions: { forEntityId: sub, category: 'cloud' } })
      await k.engine.post(k.ws, txn(card, '2026-09-04', -2_000, { counterparty: 'Vercel Inc' }))
      expect(await k.bal(sub, 'cloud')).toBe(2_000)
      expect(await k.bal(sub, `due_to:${acme}`)).toBe(-2_000)
      expect(await k.bal(acme, `due_from:${sub}`)).toBe(2_000)
      expect(await k.bal(acme, 'cloud')).toBe(0)
      const ic = (await k.engine.checks(k.ws, { entityIds: [acme, sub] })).filter((c) => c.name === 'intercompany')
      expect(ic.map((c) => c.status)).toEqual(['ok'])
      await expectBalanced(acme, sub)
    })
  })

  describe('buckets', () => {
    it('computes paid / missed / upcoming from rule-routed payments', async () => {
      const bank = await k.account({ entityId: acme })
      const rent = await k.engine.createBucket(k.ws, {
        entityId: acme,
        name: 'Rent',
        fields: [{ key: 'landlord', label: 'Landlord', type: 'text', required: true }],
        values: { landlord: 'WeWork' },
        schedule: { amount: usd(400_000), direction: 'out', cadence: 'monthly', dueDay: 1, startDate: '2026-07-01' },
      })
      await k.engine.createRule(k.ws, { name: 'WeWork → Rent', conditions: { textPatterns: ['wework'] }, actions: { category: 'rent', bucketId: rent.id } })
      await k.engine.postBatch(k.ws, [txn(bank, '2026-07-01', -400_000, { counterparty: 'WEWORK' }), txn(bank, '2026-08-02', -400_000, { counterparty: 'WEWORK' })])
      const view = await k.engine.getBucket(k.ws, rent.id, '2026-10-09')
      expect(view?.occurrences.map((o) => [o.dueDate, o.status])).toEqual([
        ['2026-07-01', 'paid'],
        ['2026-08-01', 'paid'],
        ['2026-09-01', 'missed'],
        ['2026-10-01', 'missed'],
        ['2026-11-01', 'upcoming'],
      ])
      expect(view?.status).toBe('missed')
      expect(view?.totalPaid).toEqual(usd(-800_000))
      expect(await k.bal(acme, 'rent')).toBe(800_000)
      const rec = await k.engine.metric('recurring_spend', { workspaceId: k.ws, entityIds: [acme] })
      expect(rec.value).toEqual(usd(400_000))
    })
  })

  describe('metrics with provenance', () => {
    it('runway = cash ÷ average net burn of the last 3 complete months', async () => {
      const bank = await k.account({ entityId: acme, name: 'Ops' })
      await k.engine.postBatch(k.ws, [
        txn(bank, '2026-07-01', -1_000_000),
        txn(bank, '2026-08-15', -1_200_000),
        txn(bank, '2026-09-15', -800_000),
        txn(bank, '2026-09-20', 0 + 300_000, { counterparty: 'Customer' }),
        snapshot(bank, '2026-10-08', 6_000_000),
      ])
      const [inflow] = (await k.engine.store.listRecords(k.ws, { eventTypes: ['txn.upsert'] })).filter((r) => (r.amount?.minor ?? 0) > 0)
      await k.engine.setOverride(k.ws, inflow?.id as string, { kind: 'revenue' }, null)
      const r = await k.engine.metric('runway', { workspaceId: k.ws, entityIds: [acme] })
      // Net burn: 1,000,000 + 1,200,000 + 500,000 = 2,700,000 / 3 = 900,000 per month; 6,000,000 / 900,000 = 6.67 → 6.7.
      expect(r.state).toBe('ok')
      expect(r.value).toBe(6.7)
      expect(r.includedAccounts).toEqual([bank.id])
      expect(r.formula).toContain('Cash $60,000.00 ÷ $9,000.00 per month = 6.7 months')
    })

    it('runway averages only the months history reaches (two months of books divide by two; a month begun mid-way counts whole)', async () => {
      const bank = await k.account({ entityId: acme, name: 'Ops' })
      await k.engine.postBatch(k.ws, [txn(bank, '2026-08-01', -1_200_000), txn(bank, '2026-09-15', -800_000), snapshot(bank, '2026-10-08', 6_000_000)])
      const two = await k.engine.metric('runway', { workspaceId: k.ws, entityIds: [acme] })
      // 2,000,000 over 2 months = 1,000,000 per month (÷ 3 said 666,667 and 9.0 months); 6,000,000 / 1,000,000 = 6.0.
      expect(two.value).toBe(6)
      expect(two.formula).toContain('2 months of history in the last 3 complete months')
      // Activity from July 16: July counts whole (the first row says when spending began, not when the history did).
      await k.engine.post(k.ws, txn(bank, '2026-07-16', -500_000))
      const three = await k.engine.metric('runway', { workspaceId: k.ws, entityIds: [acme] })
      // 2,500,000 / 3 = 833,333 per month; 6,000,000 / 833,333 = 7.2.
      expect(three.value).toBe(7.2)
      expect(three.formula).toContain('3 complete months')
    })

    it('burn is a monthly average: the last 3 full months by default, a period divided by its months', async () => {
      const bank = await k.account({ entityId: acme, name: 'Ops' })
      await k.engine.postBatch(k.ws, [txn(bank, '2026-07-01', -300_000), txn(bank, '2026-08-10', -600_000), txn(bank, '2026-09-10', -900_000)])
      const net = await k.engine.metric('net_burn', { workspaceId: k.ws, entityIds: [acme] })
      expect(net.value).toEqual(usd(600_000))
      expect(net.formula).toContain('average per month over 2026-07-01 to 2026-09-30 (3 months)')
      expect((await k.engine.metric('gross_burn', { workspaceId: k.ws, entityIds: [acme], from: '2026-07-01', to: '2026-09-30' })).value).toEqual(usd(600_000))
      // One month asked: that month's total.
      expect((await k.engine.metric('gross_burn', { workspaceId: k.ws, entityIds: [acme], from: '2026-09-01', to: '2026-09-30' })).value).toEqual(usd(900_000))
      // The overview shows the same monthly figure (it used to divide a 3-month total by 3 itself).
      const o = await createFinance(k.engine).reader.overview({ workspaceId: k.ws, entityIds: [acme] })
      expect(o.entities[0]?.netBurn3mo).toEqual(usd(600_000))
    })

    it('with no account counted as cash, cash and runway are unknown (never $0 and "0 months")', async () => {
      const card = await k.account({ entityId: acme, type: 'credit_card', name: 'Amex' })
      await k.engine.postBatch(k.ws, [txn(card, '2026-07-01', -300_000), txn(card, '2026-08-10', -600_000), txn(card, '2026-09-10', -900_000)])
      const cash = await k.engine.metric('cash', { workspaceId: k.ws, entityIds: [acme] })
      expect(cash).toMatchObject({ value: null, state: 'unknown', unknownReason: 'No bank or cash account connected yet' })
      expect(await k.engine.metric('runway', { workspaceId: k.ws, entityIds: [acme] })).toMatchObject({ value: null, state: 'unknown' })
      const o = await createFinance(k.engine).reader.overview({ workspaceId: k.ws, entityIds: [acme] })
      expect(o.entities[0]?.caveats?.map((c) => [c.figure, c.state])).toEqual(expect.arrayContaining([['cash', 'unknown'], ['runwayMonths', 'unknown']]))
      expect(o.attention.map((a) => a.kind)).not.toContain('low_runway')
    })

    it('a month-end date counts the month just ended; a start date with no end stops at the last full month', async () => {
      const bank = await k.account({ entityId: acme, name: 'Ops' })
      await k.engine.postBatch(k.ws, [txn(bank, '2026-07-01', -300_000), txn(bank, '2026-08-10', -600_000), txn(bank, '2026-09-10', -900_000), txn(bank, '2026-10-05', -9_000_000), snapshot(bank, '2026-10-08', 6_000_000)])
      const atEnd = await k.engine.metric('gross_burn', { workspaceId: k.ws, entityIds: [acme], to: '2026-09-30' })
      expect(atEnd.value).toEqual(usd(600_000))
      expect(atEnd.formula).toContain('2026-07-01 to 2026-09-30')
      expect((await k.engine.metric('runway', { workspaceId: k.ws, entityIds: [acme], to: '2026-09-30' })).formula).toContain('2026-07-01 to 2026-09-30')
      // Mid-month is still the months before it.
      expect((await k.engine.metric('gross_burn', { workspaceId: k.ws, entityIds: [acme], to: '2026-09-15' })).formula).toContain('to 2026-08-31')
      // October is under way: it isn't averaged in as a whole month.
      const open = await k.engine.metric('gross_burn', { workspaceId: k.ws, entityIds: [acme], from: '2026-07-01' })
      expect(open.value).toEqual(usd(600_000))
      expect(open.formula).toContain('2026-07-01 to 2026-09-30 (3 months)')
    })

    it('runway is unknown whenever burn is: a missing month in the three, or a card that stopped', async () => {
      const bank = await k.account({ entityId: acme, name: 'Ops' })
      // A busy account with no rows in August: that's a gap (a quiet one wouldn't be).
      const busy = (month: string) => [10, 12, 14, 16, 18].map((d) => txn(bank, `2026-${month}-${d}`, -60_000))
      await k.engine.postBatch(k.ws, [...busy('06'), ...busy('07'), ...busy('09'), snapshot(bank, '2026-10-08', 3_000_000)])
      const cov = await k.engine.metric('net_burn', { workspaceId: k.ws, entityIds: [acme] })
      const run = await k.engine.metric('runway', { workspaceId: k.ws, entityIds: [acme] })
      expect(cov.state).toBe('unknown')
      expect(run).toMatchObject({ value: null, state: 'unknown', unknownReason: cov.unknownReason })
    })

    it('negative cash has no runway', async () => {
      const bank = await k.account({ entityId: acme, name: 'Ops' })
      await k.engine.postBatch(k.ws, [txn(bank, '2026-07-10', -300_000), txn(bank, '2026-08-10', -300_000), txn(bank, '2026-09-10', -300_000), snapshot(bank, '2026-10-08', -100_000)])
      const r = await k.engine.metric('runway', { workspaceId: k.ws, entityIds: [acme] })
      expect(r).toMatchObject({ value: null, state: 'unknown' })
      expect(r.unknownReason).toContain('-$1,000.00')
    })

    it('runway says not enough history, or not burning', async () => {
      const bank = await k.account({ entityId: acme })
      await k.engine.post(k.ws, txn(bank, '2026-09-15', -1_000))
      expect((await k.engine.metric('runway', { workspaceId: k.ws, entityIds: [acme] })).state).toBe('not_enough_history')
      await k.engine.postBatch(k.ws, [txn(bank, '2026-07-02', 900_000), txn(bank, '2026-07-01', -1_000)])
      const recs = (await k.engine.store.listRecords(k.ws, { eventTypes: ['txn.upsert'] })).filter((r) => (r.amount?.minor ?? 0) > 0)
      await k.engine.setOverride(k.ws, recs[0]?.id as string, { kind: 'revenue' }, null)
      const r = await k.engine.metric('runway', { workspaceId: k.ws, entityIds: [acme] })
      expect(r.state).toBe('not_burning')
      expect(r.value).toBeNull()
    })

    it('cash uses provider balances, counts AI entries, lists stale sources and exclusions', async () => {
      const conn = await k.connection({ lastSuccessAt: '2026-10-01T00:00:00Z' })
      const bank = await k.account({ entityId: acme, connectionId: conn, name: 'Chase' })
      const brokerage = await k.account({ entityId: acme, type: 'investment', name: 'Schwab' })
      const coh = await k.account({ entityId: acme, type: 'cash_on_hand' })
      await k.engine.postBatch(k.ws, [snapshot(bank, '2026-10-08', 2_840_000), snapshot(brokerage, '2026-10-08', 9_000_000)])
      await k.engine.post(k.ws, txn(coh, '2026-10-02', 80_000), { origin: 'agent', createdBy: 'grant-1' })
      const cash = await k.engine.metric('cash', { workspaceId: k.ws, entityIds: [acme] })
      expect(cash.value).toEqual(usd(2_920_000))
      expect(cash.includedAccounts.sort()).toEqual([bank.id, coh.id].sort())
      expect(cash.excludedAccounts).toEqual([{ id: brokerage.id, reason: 'not counted as cash (setting)' }])
      expect(cash.staleSources).toContain(conn)
      const manual = await k.connection({ entityId: acme, key: 'manual' })
      await k.account({ entityId: acme, connectionId: manual, type: 'cash_on_hand', name: 'Cash on hand' })
      expect((await k.engine.metric('cash', { workspaceId: k.ws, entityIds: [acme] })).staleSources).not.toContain(manual)
      expect(cash.pendingReviewCount).toBeGreaterThanOrEqual(1)
      expect(cash.basis).toBe('cash')
      // A timestamp, not a bare date that reads as midnight UTC: the oldest good sync among the sources that aren't stale
      // (the till's, just now); the stale bank is listed in staleSources instead.
      expect(cash.asOf).toBe('2026-10-09T12:00:00.000Z')
    })

    it('MRR and ARR from subscriptions (active and past due only)', async () => {
      const conn = await k.connection({ entityId: acme, key: 'stripe' })
      const sub = (id: string, status: string, mrr: number): NormalizedEvent =>
        ({ type: 'subscription.upsert', externalId: id, connectionId: conn, customer: 'cus', status, mrr: usd(mrr), interval: 'month', intervalCount: 1, startedAt: '2026-01-01T00:00:00Z' }) as unknown as NormalizedEvent
      await k.engine.postBatch(k.ws, [sub('s1', 'active', 2_900), sub('s2', 'past_due', 9_900), sub('s3', 'canceled', 0), sub('s4', 'trialing', 0)])
      const scope = { workspaceId: k.ws, entityIds: [acme] }
      expect((await k.engine.metric('mrr', scope)).value).toEqual(usd(12_800))
      expect((await k.engine.metric('arr', scope)).value).toEqual(usd(153_600))
    })

    it('data health: one quiet line with the detail behind it', async () => {
      expect((await k.engine.dataHealth(k.ws)).line).toBe('All reconciled')
      // A connected account that hasn't told us anything yet leaves cash unknown: not "all reconciled".
      const bank = await k.account({ entityId: acme })
      expect((await k.engine.dataHealth(k.ws)).line).toBe('1 thing needs a look: 1 balance not reported yet')
      await k.engine.postBatch(k.ws, [txn(bank, '2026-09-01', 25_000, { counterparty: 'Mystery' }), snapshot(bank, '2026-09-30', 1_000), snapshot(bank, '2026-10-05', 9_000)])
      const h = await k.engine.dataHealth(k.ws)
      expect(h.status).toBe('needs_review')
      expect(h.counts).toMatchObject({ toReview: 1, failedChecks: 1, unexplainedMoneyIn: 1 })
      expect(h.line).toBe("2 things need a look: 1 to review, 1 balance doesn't match")
      expect(h.items[0]?.kind).toBe('failed_check')
    })

    it('personal money is never included in "all"', async () => {
      const me = await k.personal('Me')
      const mine = await k.account({ entityId: me })
      await k.engine.post(k.ws, snapshot(mine, '2026-10-08', 5_000_000))
      const cash = await k.engine.metric('cash', { workspaceId: k.ws, entityIds: 'all' })
      expect(cash.value).toBeNull()
      expect(cash.includedAccounts).toEqual([])
    })
  })

  describe('reports', () => {
    it('P&L shows processor fees per processor when more than one charged fees', async () => {
      const st = await k.account({ entityId: acme, type: 'processor_balance', name: 'Stripe' })
      const sh = await k.account({ entityId: acme, type: 'processor_balance', name: 'Shopify' })
      await k.engine.postBatch(k.ws, [stripe(st, '2026-09-01', 'charge', 200_000, 6_100), stripe(sh, '2026-09-02', 'charge', 50_000, 1_450, { externalId: 'sh_1' })])
      const pl = await k.engine.profitAndLoss(k.ws, { entityIds: [acme], from: '2026-09-01', to: '2026-09-30', basis: 'cash' })
      const fees = pl.operatingExpenses.lines.filter((l) => l.role === 'processor_fees').map((l) => [l.name, l.amount.minor])
      expect(fees).toEqual([['Processor fees · Shopify', 1_450], ['Processor fees · Stripe', 6_100]])
      expect(pl.operatingExpenses.total).toEqual(usd(7_550))
      // One processor: the line keeps its plain name.
      const one = await k.engine.profitAndLoss(k.ws, { entityIds: [acme], from: '2026-09-01', to: '2026-09-01', basis: 'cash' })
      expect(one.operatingExpenses.lines.map((l) => l.name)).toEqual(['Processor fees'])
    })

    it('P&L, balance sheet and cash flow agree with each other', async () => {
      const bank = await k.account({ entityId: acme })
      const card = await k.account({ entityId: acme, type: 'credit_card' })
      const st = await k.account({ entityId: acme, type: 'processor_balance' })
      await k.engine.postBatch(k.ws, [
        snapshot(bank, '2026-08-31', 1_000_000),
        stripe(st, '2026-09-01', 'charge', 200_000, 6_100),
        stripe(st, '2026-09-03', 'payout', -193_900, 0, { externalId: 'po_r', payoutExternalId: 'po_r' }),
        txn(bank, '2026-09-05', 193_900, { linkRefs: { payout_id: 'po_r' } }),
        txn(card, '2026-09-10', -50_000, { counterparty: 'Google Ads' }),
        txn(bank, '2026-09-28', -50_000, { rawText: 'AMEX PAYMENT' }),
        txn(card, '2026-09-28', 50_000, { rawText: 'PAYMENT THANK YOU' }),
      ])
      const pl = await k.engine.profitAndLoss(k.ws, { entityIds: [acme], from: '2026-09-01', to: '2026-09-30', basis: 'cash' })
      expect(pl.revenue.total).toEqual(usd(200_000))
      expect(pl.operatingExpenses.total).toEqual(usd(56_100))
      expect(pl.netIncome).toEqual(usd(143_900))

      const bs = await k.engine.balanceSheet(k.ws, { entityIds: [acme], asOf: '2026-09-30', basis: 'cash' })
      expect(bs.difference).toBe(0)
      expect(bs.assets.total).toEqual(usd(1_143_900))
      expect(bs.equity.lines.find((l) => l.role === 'retained_earnings')?.amount).toEqual(usd(143_900))

      const cf = await k.engine.cashFlow(k.ws, { entityIds: [acme], from: '2026-09-01', to: '2026-09-30' })
      expect(cf.opening).toEqual(usd(1_000_000))
      expect(cf.closing).toEqual(usd(1_143_900))
      expect(cf.operating.total).toEqual(usd(143_900))
      expect(cf.inTransit).toEqual(usd(0))
      expect(cf.fxEffect).toEqual(usd(0))
      await expectBalanced(acme)
    })
  })

  describe('links', () => {
    it('refuses to explain the same money twice, and validates link shapes', async () => {
      const a = await k.account({ entityId: acme })
      const b = await k.account({ entityId: acme })
      const c = await k.account({ entityId: acme })
      await k.engine.postBatch(k.ws, [txn(a, '2026-09-01', -1_000), txn(b, '2026-09-01', 1_000), txn(c, '2026-09-01', 1_000)])
      const [ra, rb, rc] = (await Promise.all([a, b, c].map(async (acc) => (await k.engine.store.listRecords(k.ws, { sourceAccountId: acc.id }))[0]?.id as string))) as [string, string, string]
      const existing = await k.engine.store.listLinks(k.ws, { statuses: ['confirmed'] })
      // Two candidates: nothing auto-confirmed.
      expect(existing).toEqual([])
      await k.engine.link(k.ws, { type: 'transfer', fromId: ra, toId: rb, confidence: 1, method: 'human' })
      await expect(k.engine.link(k.ws, { type: 'transfer', fromId: ra, toId: rc, confidence: 1, method: 'human' })).rejects.toBeInstanceOf(LinkError)
      await expect(k.engine.link(k.ws, { type: 'transfer', fromId: rb, toId: ra, confidence: 1, method: 'human' })).rejects.toBeInstanceOf(LinkError)
      await expect(k.engine.link(k.ws, { type: 'payout', fromId: ra, toId: rc, confidence: 1, method: 'human' })).rejects.toBeInstanceOf(LinkError)
      expect(await k.bal(acme, 'clearing_transfers')).toBe(0)
      expect(await k.bal(acme, 'suspense')).toBe(-1_000)
    })

    it('a card payment credited before the bank debit still matches; a plain transfer the other way round does not', async () => {
      const bank = await k.account({ entityId: acme })
      const card = await k.account({ entityId: acme, type: 'credit_card' })
      await k.engine.postBatch(k.ws, [txn(card, '2026-09-24', 4_000_000, { rawText: 'PAYMENT THANK YOU' }), txn(bank, '2026-09-25', -4_000_000, { rawText: 'AMEX EPAY' })])
      const [link] = await k.engine.store.listLinks(k.ws)
      expect(link).toMatchObject({ type: 'card_payment', status: 'confirmed' })
      expect(await k.bal(acme, 'uncategorized_expense')).toBe(0)
      const savings = await k.account({ entityId: acme })
      await k.engine.postBatch(k.ws, [txn(savings, '2026-09-24', 70_000), txn(bank, '2026-09-25', -70_000)])
      expect(await k.engine.store.listLinks(k.ws)).toHaveLength(1)
    })

    it('once a person confirms two accounts as a pair, later moves between them file themselves, either way round', async () => {
      const a = await k.account({ entityId: acme })
      const b = await k.account({ entityId: acme })
      const other = await k.account({ entityId: acme })
      await k.engine.postBatch(k.ws, [txn(a, '2026-07-01', -10_000), txn(b, '2026-07-01', 10_000)])
      const [first] = await k.engine.store.listLinks(k.ws)
      expect(first?.status).toBe('proposed')
      await k.engine.decideLink(k.ws, first?.id as string, 'confirmed', 'person-1')
      await k.engine.postBatch(k.ws, [txn(a, '2026-08-01', -20_000), txn(b, '2026-08-02', 20_000), txn(b, '2026-09-01', -30_000), txn(a, '2026-09-01', 30_000)])
      await k.engine.postBatch(k.ws, [txn(a, '2026-09-20', -40_000), txn(other, '2026-09-20', 40_000)])
      const byAmount = (m: number) => k.engine.store.listLinks(k.ws).then((ls) => ls.find((l) => Math.abs(l.amount?.minor ?? 0) === m))
      expect(await byAmount(20_000)).toMatchObject({ status: 'confirmed', confidence: 0.99 })
      expect(await byAmount(30_000)).toMatchObject({ status: 'confirmed', confidence: 0.99 })
      // A different pair of accounts stays a question.
      expect(await byAmount(40_000)).toMatchObject({ status: 'proposed' })
    })

    it('equal and opposite amounts with no words are only a suggestion: rent stays spending', async () => {
      const a = await k.account({ entityId: acme })
      const b = await k.account({ entityId: acme })
      await k.engine.postBatch(k.ws, [txn(a, '2026-09-01', -1_200_000, { counterparty: 'Landlord LLC' }), txn(b, '2026-09-03', 1_200_000, { counterparty: 'Globex' })])
      const [link] = await k.engine.store.listLinks(k.ws)
      expect(link).toMatchObject({ status: 'proposed', confidence: 0.85 })
      expect(await k.bal(acme, 'uncategorized_expense')).toBe(1_200_000)
      expect((await k.engine.autoFile(k.ws)).filed).toBe(0)
      expect((await k.engine.store.listLinks(k.ws))[0]?.status).toBe('proposed')
      const burn = await k.engine.metric('gross_burn', { workspaceId: k.ws, entityIds: [acme], from: '2026-09-01', to: '2026-09-30' })
      expect(burn.value).toEqual(usd(1_200_000))
      expect(burn.coverage?.gaps).toContain('$12,000.00 in possible transfers is waiting in Review and is counted as spending until confirmed')
      expect(burn.unknownReason).toContain('possible transfers')
    })

    it('a rejected suggestion is never proposed again; unlinking restores the original posting', async () => {
      const a = await k.account({ entityId: acme })
      const b = await k.account({ entityId: acme })
      await k.engine.postBatch(k.ws, [txn(a, '2026-09-01', -1_000, { rawText: 'ONLINE TRANSFER' }), txn(b, '2026-09-01', 1_000)])
      const [link] = await k.engine.store.listLinks(k.ws)
      expect(link?.status).toBe('confirmed')
      await k.engine.decideLink(k.ws, link?.id as string, 'rejected', 'person-1')
      expect(await k.bal(acme, 'uncategorized_expense')).toBe(1_000)
      expect(await k.bal(acme, 'suspense')).toBe(-1_000)
      await k.engine.reconcile(k.ws)
      expect(await k.engine.store.listLinks(k.ws)).toHaveLength(1)
    })

    it('an AI-added expense that later arrives from the bank is flagged as a possible duplicate', async () => {
      const card = await k.account({ entityId: acme, type: 'credit_card' })
      const manual = await k.account({ entityId: acme, type: 'cash_on_hand', name: 'Paid by AI note' })
      void manual
      await k.engine.post(k.ws, txn(card, '2026-09-05', -4_200, { counterparty: 'Uber' }), { origin: 'agent' })
      await k.engine.post(k.ws, txn(card, '2026-09-06', -4_200, { counterparty: 'UBER TRIP' }))
      await k.engine.reconcile(k.ws)
      const dup = (await k.engine.store.listLinks(k.ws, { types: ['duplicate'] }))[0]
      expect(dup?.status).toBe('proposed')
      await k.engine.decideLink(k.ws, dup?.id as string, 'confirmed', 'person-1')
      expect(await k.bal(acme, 'uncategorized_expense')).toBe(4_200)
    })
  })

  describe('integrity', () => {
    it('rejects malformed money before anything is written', async () => {
      const bank = await k.account({ entityId: acme })
      await expect(k.engine.post(k.ws, txn(bank, '2026-09-01', { minor: 10.5, currency: 'USD' }))).rejects.toBeInstanceOf(EventValidationError)
      await expect(k.engine.post(k.ws, txn(bank, '2026-13-01', -100))).rejects.toBeInstanceOf(EventValidationError)
      await expect(k.engine.post(k.ws, txn(bank, '2026-09-01', { minor: 100, currency: 'usd' }))).rejects.toBeInstanceOf(EventValidationError)
      expect(await k.engine.store.listRecords(k.ws)).toEqual([])
    })

    it('rebuilding the whole ledger from source changes nothing', async () => {
      const bank = await k.account({ entityId: acme })
      const st = await k.account({ entityId: acme, type: 'processor_balance' })
      await k.engine.postBatch(k.ws, [
        snapshot(bank, '2026-08-31', 500_000),
        stripe(st, '2026-09-01', 'charge', 10_000, 320),
        stripe(st, '2026-09-02', 'payout', -9_680, 0),
        txn(bank, '2026-09-04', 9_680, { rawText: 'STRIPE' }),
        txn(bank, '2026-09-05', -3_000, { counterparty: 'AWS' }),
      ])
      const before = await k.engine.store.listLines(k.ws, { basis: 'cash' })
      await k.engine.rebuild(k.ws)
      const after = await k.engine.store.listLines(k.ws, { basis: 'cash' })
      expect(after.length).toBe(before.length)
    })
  })
})
