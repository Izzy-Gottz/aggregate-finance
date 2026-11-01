// Check messages are read by people (data health, Review, the AI): amounts in them are money, never minor units.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invoice, makeKit, snapshot, stripe, txn, type Kit } from './test-kit.ts'

/** A digit run left after dates, times and formatted amounts are taken out would be a raw minor-unit number. */
function bareNumbers(text: string): string[] {
  const rest = text
    .replace(/\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?/g, ' ')
    .replace(/-?[$€£]\s?-?[\d,]+(\.\d+)?/g, ' ')
    .replace(/-?[\d,]+(\.\d+)?\s?[A-Z]{3}\b/g, ' ')
  return rest.match(/\d{3,}/g) ?? []
}

describe('check messages show money, not minor units', () => {
  let k: Kit
  let acme: string
  beforeEach(async () => {
    k = await makeKit('memory', { now: '2026-10-09T12:00:00.000Z' })
    acme = await k.company('Acme')
  })
  afterEach(async () => {
    await k.close()
  })

  it('every failing check names amounts as money', async () => {
    const st = await k.account({ entityId: acme, type: 'processor_balance', name: 'Stripe' })
    const bank = await k.account({ entityId: acme, name: 'Mercury' })
    const xero = await k.connection({ entityId: acme, key: 'xero' })
    await k.engine.postBatch(k.ws, [
      // A processor whose rows don't explain its balance (291,046 moved, rows say otherwise).
      snapshot(st, '2026-08-31', 0),
      stripe(st, '2026-09-01', 'charge', 300_000, 8_954),
      snapshot(st, '2026-09-30', 250_000),
      // A bank balance the rows don't reach.
      snapshot(bank, '2026-09-01', 1_000_000),
      txn(bank, '2026-09-10', -123_456, { counterparty: 'Landlord' }),
      snapshot(bank, '2026-09-20', 777_777),
      invoice(xero, { externalId: 'INV-1', total: { minor: 456_789, currency: 'USD' }, issueDate: '2026-09-02', dueDate: '2026-09-30' }),
    ])
    const checks = await k.engine.checks(k.ws, { entityIds: [acme] })
    const failing = checks.filter((c) => c.status !== 'ok')
    expect(failing.map((c) => c.name)).toEqual(expect.arrayContaining(['processor', 'balance_identity']))
    for (const c of checks) expect({ check: c.name, bare: bareNumbers(c.message) }).toEqual({ check: c.name, bare: [] })
    expect(failing.find((c) => c.name === 'processor')?.message).toContain('$2,500.00')
  })

  it('the helper catches a raw number', () => {
    expect(bareNumbers('Stripe: provider balance moved 291046 between 2026-08-31 and 2026-09-30')).toEqual(['291046'])
    expect(bareNumbers('Stripe: provider balance moved $2,910.46 between 2026-08-31 and 2026-09-30')).toEqual([])
  })
})
