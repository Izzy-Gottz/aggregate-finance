// Bank rows against open invoices, from the local reconciliation run (QuickBooks sandbox + a Plaid custom user):
// the rest of a partly paid invoice, a cent off, a deposit with no name, and two checks deposited together.
import { afterEach, describe, expect, it } from 'vitest'
import type { PaymentApplied } from '@agfn/contracts'
import { invoice, makeKit, txn, usd, type Backend, type Kit } from './test-kit.ts'

const backends: Backend[] = ['memory', 'sqlite']

describe.each(backends)('bank rows matched to open invoices (%s)', (backend) => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  async function setup() {
    k = await makeKit(backend, { now: '2026-10-11T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const qb = await k.connection({ entityId: acme, key: 'quickbooks' })
    const bank = await k.account({ entityId: acme })
    const inv = (n: string, minor: number, counterparty: string, o: Parameters<typeof invoice>[1] extends infer T ? Partial<T> : never = {}) =>
      invoice(qb, { externalId: n, number: n, counterparty, total: usd(minor), issueDate: '2026-09-01', dueDate: '2026-10-01', ...o })
    const proposals = async (bankExternalId: string) => {
      const row = (await k.engine.store.listRecords(k.ws, { sourceAccountId: bank.id })).find((r) => r.externalId === bankExternalId)
      const links = (await k.engine.store.listLinks(k.ws, { types: ['invoice_payment'] })).filter((l) => l.toId === row?.id)
      const docs = await k.engine.store.getRecords(k.ws, links.map((l) => l.fromId))
      return links
        .map((l) => ({ doc: docs.find((d) => d.id === l.fromId)?.externalId, amount: l.amount?.minor, status: l.status }))
        .sort((a, b) => String(a.doc).localeCompare(String(b.doc)))
    }
    return { acme, qb, bank, inv, proposals }
  }

  it('the rest of an invoice partly paid in the books is matched to the bank row that pays it', async () => {
    const { acme, qb, bank, inv, proposals } = await setup()
    const partial: PaymentApplied = { type: 'payment.applied', externalId: 'P-1', connectionId: qb, direction: 'receivable', date: '2026-09-05', amount: usd(30_000), applications: [{ invoiceExternalId: '1007', amount: usd(30_000) }] }
    await k.engine.postBatch(k.ws, [inv('1007', 75_000, 'John Melton', { status: 'partially_paid', amountPaid: usd(30_000) }), partial, txn(bank, '2026-09-21', 45_000, { externalId: 'b1', rawText: 'JOHN MELTON ZELLE' })])
    await k.engine.reconcile(k.ws)
    expect(await proposals('b1')).toMatchObject([{ doc: '1007', amount: 45_000 }])
    // Confirmed (or automatic): the invoice is settled, nothing owed, the books balance.
    for (const l of await k.engine.store.listLinks(k.ws, { types: ['invoice_payment'], statuses: ['proposed'] })) await k.engine.decideLink(k.ws, l.id, 'confirmed', 'person')
    expect(await k.bal(acme, 'ar', 'accrual')).toBe(0)
    expect(await k.tb(acme, 'accrual')).toBe(0)
    expect(await k.tb(acme, 'cash')).toBe(0)
  })

  it('a cent off is suggested for the amount owed, never linked by itself', async () => {
    const { acme, bank, inv, proposals } = await setup()
    await k.engine.postBatch(k.ws, [inv('1032', 41_472, 'Travis Waldron'), txn(bank, '2026-10-10', 41_471, { externalId: 'b2', rawText: 'TRAVIS WALDRON PAYMENT' })])
    await k.engine.reconcile(k.ws)
    expect(await proposals('b2')).toEqual([{ doc: '1032', amount: 41_471, status: 'proposed' }])
    expect((await k.engine.reviewItems(k.ws)).find((i) => i.kind === 'suggested_match')?.confirmLabel).toBe('Confirm: payment of invoice 1032; $0.01 stays owed on the invoice')
    // Accepted: a cent stays owed, it isn't closed at the wrong amount.
    for (const l of await k.engine.store.listLinks(k.ws, { types: ['invoice_payment'] })) await k.engine.decideLink(k.ws, l.id, 'confirmed', 'person')
    expect(await k.bal(acme, 'ar', 'accrual')).toBe(1)
    expect(await k.tb(acme, 'accrual')).toBe(0)
  })

  it('a deposit nothing names is a question between invoices of that amount', async () => {
    const { bank, inv, proposals } = await setup()
    await k.engine.postBatch(k.ws, [inv('1022', 8_100, "Jeff's Jalopies", { issueDate: '2026-08-01', dueDate: '2026-08-31' }), inv('1028', 8_100, '55 Twin Lane', { issueDate: '2026-08-01', dueDate: '2026-08-31' }), txn(bank, '2026-08-30', 8_100, { externalId: 'b3', rawText: 'MOBILE DEPOSIT' })])
    await k.engine.reconcile(k.ws)
    expect(await proposals('b3')).toEqual([
      { doc: '1022', amount: 8_100, status: 'proposed' },
      { doc: '1028', amount: 8_100, status: 'proposed' },
    ])
  })

  it('two checks deposited together: the one pair of open invoices that adds up is suggested', async () => {
    const { acme, bank, inv, proposals } = await setup()
    await k.engine.postBatch(k.ws, [
      inv('1035', 31_428, 'Mark Cho'),
      inv('1034', 7_860, 'Rondonuwu Fruit and Vegi'),
      inv('1036', 20_000, 'Someone Else'),
      txn(bank, '2026-10-10', 39_288, { externalId: 'b4', rawText: 'MOBILE DEPOSIT 2 CHECKS' }),
    ])
    await k.engine.reconcile(k.ws)
    expect(await proposals('b4')).toEqual([
      { doc: '1034', amount: 7_860, status: 'proposed' },
      { doc: '1035', amount: 31_428, status: 'proposed' },
    ])
    // One question for both; confirming it pays both invoices.
    const items = (await k.engine.reviewItems(k.ws)).filter((i) => i.kind === 'suggested_match')
    expect(items).toHaveLength(1)
    expect(items[0]?.title).toBe('Same money? (2 invoices paid together)')
    expect(items[0]?.confirmLabel).toMatch(/^Confirm: payment of invoices 103[45] and 103[45]$/)
    await k.engine.decideLink(k.ws, items[0]?.linkId as string, 'confirmed', 'person')
    expect((await proposals('b4')).map((p) => p.status)).toEqual(['confirmed', 'confirmed'])
    expect(await k.bal(acme, 'ar', 'accrual')).toBe(20_000)
  })

  it('a pair is not asked once either invoice is paid another way', async () => {
    const { bank, inv } = await setup()
    await k.engine.postBatch(k.ws, [inv('1035', 31_428, 'Mark Cho'), inv('1034', 7_860, 'Rondonuwu Fruit and Vegi'), txn(bank, '2026-10-10', 39_288, { externalId: 'b6', rawText: 'MOBILE DEPOSIT 2 CHECKS' })])
    await k.engine.reconcile(k.ws)
    const pairQuestions = async () => (await k.engine.reviewItems(k.ws)).filter((i) => i.kind === 'suggested_match' && i.title.includes('paid together'))
    expect(await pairQuestions()).toHaveLength(1)
    // Mark Cho pays 1035 by its own transfer, naming the invoice.
    await k.engine.postBatch(k.ws, [txn(bank, '2026-10-11', 31_428, { externalId: 'b7', rawText: 'MARK CHO', linkRefs: { invoice: '1035' } })])
    await k.engine.reconcile(k.ws)
    expect(await pairQuestions()).toEqual([])
  })

  it('a deposit a person already answered is not asked again as a guessed match', async () => {
    const { bank, inv, proposals } = await setup()
    await k.engine.postBatch(k.ws, [txn(bank, '2026-08-30', 8_100, { externalId: 'b5', rawText: 'MOBILE DEPOSIT' })])
    const row = (await k.engine.store.listRecords(k.ws, { sourceAccountId: bank.id }))[0]
    await k.engine.setOverride(k.ws, row?.id as string, { kind: 'revenue' }, 'person')
    await k.engine.postBatch(k.ws, [inv('1022', 8_100, "Jeff's Jalopies", { issueDate: '2026-08-01', dueDate: '2026-08-31' })])
    await k.engine.reconcile(k.ws)
    expect(await proposals('b5')).toEqual([])
    // A guess made before the answer stays on file but isn't asked.
    const row5 = (await k.engine.store.listRecords(k.ws, { sourceAccountId: bank.id })).find((r) => r.externalId === 'b5')
    const inv1022 = (await k.engine.store.listRecords(k.ws, { eventTypes: ['invoice.upsert'] }))[0]
    await k.engine.store.saveLink({ id: 'old-guess', workspaceId: k.ws, type: 'invoice_payment', fromId: inv1022?.id as string, toId: row5?.id as string, amount: usd(8_100), confidence: 0.6, method: 'fuzzy', status: 'proposed', scores: null, createdBy: null, decidedBy: null, decidedAt: null, createdAt: '2026-10-01T00:00:00.000Z' })
    expect((await k.engine.reviewItems(k.ws)).filter((i) => i.kind === 'suggested_match')).toEqual([])
  })
})
