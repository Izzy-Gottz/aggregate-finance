// Invoices from a processor paid by its own charges (hosted AGFN: three paid Stripe invoices left $1,298 in AR and
// their revenue counted twice, once on the invoice and once on the charge).
import { afterEach, describe, expect, it } from 'vitest'
import { invoice, makeKit, stripe, usd, type Backend, type Kit } from './test-kit.ts'

const backends: Backend[] = ['memory', 'sqlite']

describe.each(backends)('processor charges that pay its invoices (%s)', (backend) => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  async function setup() {
    k = await makeKit(backend, { now: '2026-10-11T20:00:00.000Z' })
    const acme = await k.company('Acme')
    const conn = await k.connection({ entityId: acme, key: 'stripe' })
    const acc = await k.account({ entityId: acme, type: 'processor_balance', connectionId: conn })
    const inv = (id: string, minor: number, counterparty: string) => invoice(conn, { externalId: id, counterparty, total: usd(minor), amountPaid: usd(minor), status: 'paid', issueDate: '2026-10-11', dueDate: '2026-10-11' })
    const subledger = async () => (await k.engine.checks(k.ws, { entityIds: [acme] })).find((c) => c.name === 'subledger_ar')
    return { acme, acc, inv, subledger }
  }

  it('the invoice id on the charge settles it; one alike invoice settles by amount; revenue is counted once', async () => {
    const { acme, acc, inv, subledger } = await setup()
    await k.engine.postBatch(k.ws, [
      inv('in_oak', 120_000, 'Oakline Retail'),
      inv('in_lum', 4_900, 'Lumen Health'),
      stripe(acc, '2026-10-11T18:05:05Z', 'charge', 120_000, 3_510),
      stripe(acc, '2026-10-11T18:05:00Z', 'charge', 4_900, 172, { linkRefs: { invoice: 'in_lum' } } as never),
    ])
    await k.engine.reconcile(k.ws)
    expect(await k.bal(acme, 'ar', 'accrual')).toBe(0)
    expect(await k.bal(acme, 'revenue', 'accrual')).toBe(-124_900)
    expect(await k.bal(acme, 'revenue', 'cash')).toBe(-124_900)
    expect(await k.tb(acme, 'accrual')).toBe(0)
    expect(await k.tb(acme, 'cash')).toBe(0)
    expect((await subledger())?.status).toBe('ok')
  })

  it('two alike invoices and charges with nothing to tell them apart are asked about, never guessed', async () => {
    const { acme, acc, inv } = await setup()
    await k.engine.postBatch(k.ws, [inv('in_a', 4_900, 'Ferris & Co'), inv('in_b', 4_900, 'Lumen Health'), stripe(acc, '2026-10-11', 'charge', 4_900, 172)])
    await k.engine.reconcile(k.ws)
    const links = await k.engine.store.listLinks(k.ws, { types: ['invoice_payment'] })
    expect(links.map((l) => l.status)).toEqual(['proposed', 'proposed'])
    expect(await k.bal(acme, 'ar', 'accrual')).toBe(9_800)
  })
})
