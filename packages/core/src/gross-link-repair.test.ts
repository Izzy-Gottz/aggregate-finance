// Links to Stripe charges stored at the charge's net (before links counted gross) left each paid invoice short by
// the fee: subledger_ar failed on hosted AGFN ("open invoices $38.54, AR $0.00"). Matcher v3 corrects them once.
import { afterEach, describe, expect, it } from 'vitest'
import { invoice, makeKit, stripe, usd, type Backend, type Kit } from './test-kit.ts'

const backends: Backend[] = ['memory', 'sqlite']

describe.each(backends)('repairing net-amount links to processor charges (%s)', (backend) => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('the next settle of an older workspace sets them to gross, and the subledger agrees again', async () => {
    k = await makeKit(backend, { now: '2026-10-11T20:00:00.000Z' })
    const acme = await k.company('Acme')
    const conn = await k.connection({ entityId: acme, key: 'stripe' })
    const acc = await k.account({ entityId: acme, type: 'processor_balance', connectionId: conn })
    await k.engine.postBatch(k.ws, [
      invoice(conn, { externalId: 'in_oak', counterparty: 'Oakline Retail', total: usd(120_000), amountPaid: usd(120_000), status: 'paid', issueDate: '2026-10-11', dueDate: '2026-10-11' }),
      stripe(acc, '2026-10-11T18:05:05Z', 'charge', 120_000, 3_510),
    ])
    await k.engine.reconcile(k.ws)
    // As an older version stored it: the charge's net.
    const [link] = await k.engine.store.listLinks(k.ws, { types: ['invoice_payment'], statuses: ['confirmed'] })
    await k.engine.store.saveLink({ ...(link as NonNullable<typeof link>), amount: usd(116_490) })
    const subledger = async () => (await k.engine.checks(k.ws, { entityIds: [acme] })).find((c) => c.name === 'subledger_ar')
    expect((await subledger())?.status).toBe('fail')
    await k.engine.store.setMatchedWith(k.ws, 2, '2026-10-11T00:00:00.000Z')
    await k.engine.settle(k.ws, conn)
    expect((await k.engine.store.getLink(k.ws, link?.id as string))?.amount).toEqual(usd(120_000))
    expect((await subledger())?.status).toBe('ok')
    expect(await k.bal(acme, 'ar', 'accrual')).toBe(0)
  })
})
