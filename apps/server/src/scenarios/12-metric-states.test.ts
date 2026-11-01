// Missing means unknown, not zero: an account that never reported makes cash unknown; a balance over a week old
// keeps the number but marks it stale; a month with no bank rows makes burn unknown and names the gap. As each
// source catches up, the answers go back to ok. Checked through the reader, REST and MCP, plus the overview's caveats.
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@agfn/contracts'
import { withBypass } from '@agfn/db'
import { connectAi, connectProvider, entities, signIn, startServer, type Server } from './harness.ts'

const asTest = <T>(_srv: Server, f: () => Promise<T>) => withBypass('test:stall', f)

const usd = (m: number) => ({ minor: m, currency: 'USD' })
type Metric = { value: { amount: string } | number | null; state: string; unknown_reason?: string; coverage?: { accounts: Array<{ name: string; balance_as_of: string | null; stale: boolean }>; gaps: string[] } }

describe('scenario 12: unknown and stale metrics', () => {
  it('cash and burn say unknown or stale, why, and recover as sources catch up', async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'founder12@example.com', 'Acme')
      const E = await entities(s)
      const bank = await connectProvider(srv, s, 'plaid', { entityId: E.Acme, name: 'Chase' })
      const page = (c: string, events: Array<Record<string, unknown>>) => events.map((e) => ({ ...e, connectionId: c }) as NormalizedEvent)
      let n = 0
      const spend = (date: string, dollars: number) => ({ type: 'txn.upsert', externalId: `t${++n}`, accountExternalId: 'chk', date, amount: usd(-dollars * 100), status: 'posted', counterparty: 'AWS', rawText: 'AWS' })
      const bal = (acct: string, at: string, minor: number) => ({ type: 'balance.snapshot', externalId: `${acct}@${at}`, accountExternalId: acct, at, current: usd(minor) })
      // Checking is busy (4+ rows a month) but August is missing; Savings last reported Sep 20.
      const month = (m: string) => ['05', '12', '19', '26'].map((d) => spend(`2026-${m}-${d}`, 1_000))
      bank.push((c) =>
        page(c, [
          { type: 'account.upsert', externalId: 'chk', name: 'Acme Checking', accountType: 'depository', currency: 'USD', institution: 'Chase', mask: '4411' },
          { type: 'account.upsert', externalId: 'sav', name: 'Acme Savings', accountType: 'depository', currency: 'USD', institution: 'Chase', mask: '5522' },
          bal('chk', '2026-10-09T08:00:00Z', 5_000_000),
          bal('sav', '2026-09-20T08:00:00Z', 2_000_000),
          ...month('07'),
          ...month('09'),
          spend('2026-10-02', 1_000),
        ]),
      )
      expect((await bank.sync()).status).toBe('ok')
      const ai = await connectAi(srv, s)
      const metric = async (name: string, args: Record<string, string> = {}) => {
        const viaMcp = await ai.call<Metric>('get_metric', { metric: name, company: 'Acme', ...args })
        const viaRest = await srv.app.request(`/v1/metrics/${name}?${new URLSearchParams({ company: 'Acme', ...args })}`, { headers: { authorization: `Bearer ${ai.key}` } })
        const body = (await viaRest.json()) as { data?: Metric } & Metric
        const pick = (m: Metric) => ({ value: m.value, state: m.state, unknown_reason: m.unknown_reason, coverage: m.coverage })
        expect(pick(body.data ?? body)).toEqual(pick(viaMcp))
        return viaMcp
      }
      const overview = async () => (await ai.call<{ companies: Array<{ company: string; caveats?: Array<{ figure: string; state: string; reason: string }> }> }>('get_overview', {})).companies.find((c) => c.company === 'Acme')!
      const q3 = { from: '2026-07-01', to: '2026-09-30' }

      // Stale: the number is kept, and says which balance is old.
      const cash = await metric('cash')
      expect(cash).toMatchObject({ value: { amount: '70000.00' }, state: 'stale', unknown_reason: 'Acme Savings ··5522 last reported Sep 20; total uses that balance' })
      expect(cash.coverage!.accounts.map((a) => [a.name, a.balance_as_of, a.stale])).toEqual([['Acme Checking ··4411', '2026-10-09', false], ['Acme Savings ··5522', '2026-09-20', true]])
      expect((await overview()).caveats).toEqual(expect.arrayContaining([{ figure: 'cash', state: 'stale', reason: cash.unknown_reason }]))

      // Unknown: a missing month is not a zero month.
      const burn = await metric('net_burn', q3)
      expect(burn).toMatchObject({ value: null, state: 'unknown' })
      expect(burn.unknown_reason).toContain('Acme Checking ··4411: 2026-08 has no data')
      expect(burn.coverage!.gaps).toEqual([expect.stringContaining('2026-08 has no data')])

      // The bank sends August and a fresh Savings balance: both answers are ok again, with no caveats.
      bank.push((c) => page(c, [...month('08'), bal('sav', '2026-10-09T09:00:00Z', 2_000_000)]))
      expect((await bank.sync()).status).toBe('ok')
      expect(await metric('cash')).toMatchObject({ value: { amount: '70000.00' }, state: 'ok' })
      expect((await metric('cash')).unknown_reason).toBeUndefined()
      expect(await metric('net_burn', q3)).toMatchObject({ value: { amount: '4000.00' }, state: 'ok' }) // a monthly average: $12,000 over 3 months
      expect((await overview()).caveats ?? []).toEqual([])

      // The bank stops syncing: a period ending today can't be known past Sep 25.
      await asTest(srv, () => srv.booted.services.db.updateTable('connections').set({ last_success_at: '2026-09-25T08:00:00.000Z' }).where('id', '=', bank.id).execute())
      const recent = await metric('net_burn', { from: '2026-09-01', to: '2026-10-10' })
      expect(recent).toMatchObject({ value: null, state: 'unknown', unknown_reason: 'Acme Checking ··4411 has only synced through Sep 25' })
    } finally {
      await srv.close()
    }
  })
})
