// The overview's answer is kept until the next write, per set of companies and day (s1-answers). It never depends on the
// caller's grant: get_overview filters what a grant may see after the cache. Two keys on the same workspace, one
// without payroll and one for a single company, asked right after a full key filled the cache, see only their part.
import { describe, expect, it } from 'vitest'
import { connectAi, connectProvider, entities, READ_WRITE_ALL, signIn, startServer } from './harness.ts'

const usd = (m: number) => ({ minor: m, currency: 'USD' })
type Overview = { companies: Array<{ company: string; next_payroll?: unknown; hidden?: string[] }> }

describe('overview answers kept between calls respect each grant', () => {
  it('a narrower key never sees what the wider key that filled the cache saw', async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'founder-grants@example.com', 'Acme')
      const E = await entities(s)
      expect((await s.post('/api/entities', { name: 'Bluebird' })).status).toBe(201)
      const all = await entities(s)
      const bank = await connectProvider(srv, s, 'plaid', { entityId: E.Acme, name: 'Chase' })
      bank.push((c) => [
        { type: 'account.upsert', externalId: 'chk', connectionId: c, name: 'Acme Checking', accountType: 'depository', currency: 'USD', institution: 'Chase' },
        { type: 'balance.snapshot', externalId: 'b0', connectionId: c, accountExternalId: 'chk', at: '2026-10-09T08:00:00Z', current: usd(10_000_000) },
        ...['2026-09-11', '2026-09-25', '2026-10-09'].flatMap((d, i) => [
          { type: 'txn.upsert' as const, externalId: `net${i}`, connectionId: c, accountExternalId: 'chk', date: d, amount: usd(-610_000), status: 'posted' as const, counterparty: 'Gusto', rawText: 'GUSTO NET 8RTF2' },
          { type: 'txn.upsert' as const, externalId: `tax${i}`, connectionId: c, accountExternalId: 'chk', date: d, amount: usd(-255_000), status: 'posted' as const, counterparty: 'Gusto', rawText: 'GUSTO TAX 8RTF2' },
        ]),
      ])
      expect((await bank.sync()).status).toBe('ok')

      const full = await connectAi(srv, s, READ_WRITE_ALL, 'Full')
      const noPayroll = await connectAi(srv, s, { ...READ_WRITE_ALL, write: false, dataTypes: ['balances', 'transactions'] }, 'No payroll')
      const acmeOnly = await connectAi(srv, s, { ...READ_WRITE_ALL, write: false, entityIds: [E.Acme!] }, 'Acme only')
      const acme = (ov: Overview) => ov.companies.find((c) => c.company === 'Acme')

      // The full key fills the cache; the narrower ones ask the same scope right after.
      const a = await full.call<Overview>('get_overview', {})
      expect(acme(a)?.next_payroll).toMatchObject({ date: '2026-10-23' })
      expect(a.companies.map((c) => c.company).sort()).toEqual(['Acme', 'Bluebird'])
      const b = await noPayroll.call<Overview>('get_overview', {})
      expect(acme(b)).not.toHaveProperty('next_payroll')
      expect(acme(b)?.hidden).toContain('payroll')
      const c = await acmeOnly.call<Overview>('get_overview', {})
      expect(c.companies.map((x) => x.company)).toEqual(['Acme'])
      // And the other way round: a narrow answer first doesn't narrow the wide one.
      expect(acme(await full.call<Overview>('get_overview', {}))?.next_payroll).toMatchObject({ date: '2026-10-23' })
      expect(Object.keys(all)).toContain('Bluebird')
      for (const ai of [full, noPayroll, acmeOnly]) await ai.close()
    } finally {
      await srv.close()
    }
  }, 120_000)
})
