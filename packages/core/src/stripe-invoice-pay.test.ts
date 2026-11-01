// A Stripe invoice and the charge that paid it: the invoice lists the charge's payment intent, so the charge settles
// the invoice (accrual: AR clears) instead of being revenue a second time.
import { afterEach, describe, expect, it } from 'vitest'
import { invoice, makeKit, stripe, usd, type Backend, type Kit } from './test-kit.ts'

const backends: Backend[] = ['memory', 'sqlite']

describe.each(backends)('Stripe invoice paid by a charge (%s)', (backend) => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('two alike $49 invoices each settle exactly by payment intent; revenue counts once', async () => {
    k = await makeKit(backend, { now: '2026-10-11T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const conn = await k.connection({ entityId: acme, key: 'stripe' })
    const st = await k.account({ entityId: acme, type: 'processor_balance', name: 'Stripe', connectionId: conn })
    const inv = (id: string, pi: string) => invoice(conn, { externalId: id, counterparty: 'Customer', total: usd(4_900), amountPaid: usd(4_900), status: 'paid', issueDate: '2026-10-11', paymentRefs: [pi] })
    await k.engine.postBatch(k.ws, [
      inv('in_1', 'pi_1'),
      inv('in_2', 'pi_2'),
      stripe(st, '2026-10-11T18:05:00Z', 'charge', 4_900, 172, { externalId: 'txn_1', linkRefs: { payment_intent: 'pi_1' } }),
      stripe(st, '2026-10-11T18:05:03Z', 'charge', 4_900, 172, { externalId: 'txn_2', linkRefs: { payment_intent: 'pi_2' } }),
      stripe(st, '2026-10-11T18:05:07Z', 'charge', 25_000, 755, { externalId: 'txn_3', linkRefs: { payment_intent: 'pi_3' } }),
    ])
    await k.engine.reconcile(k.ws)
    const links = await k.engine.store.listLinks(k.ws, { types: ['invoice_payment'] })
    expect(links.map((l) => [l.method, l.status])).toEqual([
      ['exact_id', 'confirmed'],
      ['exact_id', 'confirmed'],
    ])
    expect(await k.bal(acme, 'ar', 'accrual')).toBe(0)
    // Each link explains the invoice in full (the charge's gross, not its net after the fee; seen on hosted AGFN).
    expect(links.map((l) => l.amount?.minor)).toEqual([4_900, 4_900])
    // Revenue: the two invoices (accrual) or the two payments (cash), plus the one-off charge; never both.
    expect(await k.bal(acme, 'revenue', 'accrual')).toBe(-(4_900 * 2 + 25_000))
    expect(await k.bal(acme, 'revenue', 'cash')).toBe(-(4_900 * 2 + 25_000))
  })
})
