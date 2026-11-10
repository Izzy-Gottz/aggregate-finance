import { describe, expect, it } from 'vitest'
import type { Money } from '@agfn/contracts'
import { newId } from '@agfn/db'
import { LedgerEngine } from './engine.ts'
import { MemoryRateSource } from './fx.ts'
import { MemoryDirectory, MemoryLedgerStore } from './memory-store.ts'

const usd = (minor: number): Money => ({ minor, currency: 'USD' })

/** Build a memory-backed engine whose workspace zone we can change, to reproduce date drift. */
function setup(now: string) {
  const store = new MemoryLedgerStore()
  const dir = new MemoryDirectory()
  const ws = newId()
  dir.setReportingCurrency(ws, 'USD')
  dir.setTimeZone(ws, 'UTC')
  const engine = new LedgerEngine({ store, directory: dir, rates: new MemoryRateSource(), now: () => now })
  return { store, dir, engine, ws }
}

describe('repostToRules', () => {
  it('re-dates records left stale by a rule change, counts in dry-run without writing, and is idempotent', async () => {
    const { dir, engine, ws } = setup('2026-12-02T12:00:00.000Z')
    const co = dir.addEntity(ws, { id: newId(), name: 'Acme', kind: 'company', baseCurrency: 'USD' }).id
    const conn = dir.addConnection(ws, { id: newId(), connectorKey: 'deel', entityId: co }).id
    // 03:28Z on Dec 1 is still Dec 1 in UTC, so the run and its entries book on Dec 1 here.
    const run = { type: 'payroll.run' as const, externalId: 'r1', connectionId: conn, payDate: '2026-12-01', at: '2026-12-01T03:28:00Z', gross: usd(100_000), employerTaxes: usd(0), net: usd(100_000), status: 'paid' as const, provider: 'Deel' }
    await engine.post(ws, run)
    // The live books only: entries that aren't reversed and aren't reversals — the same thing f5's drift query measures.
    const dates = async () => [...new Set((await engine.store.listActiveEntries(ws, { entityIds: [co], basis: 'accrual' })).map((e) => e.date))]
    expect(await dates()).toEqual(['2026-12-01'])

    // The workspace moves to New York, where 03:28Z is 22:28 the evening before — the run belongs to Nov 30. redate()
    // (via directoryChanged) only moves balance/processor rows, so the payroll run keeps its stale Dec 1 date and entries.
    dir.setTimeZone(ws, 'America/New_York')
    await engine.directoryChanged(ws)
    expect(await dates()).toEqual(['2026-12-01']) // still stale

    // Dry run: it would re-date one record, but writes nothing.
    expect(await engine.repostToRules(ws, { connectionIds: [conn], eventTypes: ['payroll.run'], dryRun: true })).toEqual({ [conn]: 1 })
    expect(await dates()).toEqual(['2026-12-01']) // dry run changed nothing

    // Real run: the entries move to Nov 30.
    expect(await engine.repostToRules(ws, { connectionIds: [conn], eventTypes: ['payroll.run'], dryRun: false })).toEqual({ [conn]: 1 })
    expect(await dates()).toEqual(['2026-11-30'])

    // Idempotent: nothing left to change, in either mode.
    expect(await engine.repostToRules(ws, { connectionIds: [conn], eventTypes: ['payroll.run'], dryRun: false })).toEqual({})
    expect(await engine.repostToRules(ws, { connectionIds: [conn], eventTypes: ['payroll.run'], dryRun: true })).toEqual({})
  })

  it('leaves a record alone when its date already matches the rules (no spurious re-post)', async () => {
    const { dir, engine, ws } = setup('2026-12-02T12:00:00.000Z')
    const co = dir.addEntity(ws, { id: newId(), name: 'Acme', kind: 'company', baseCurrency: 'USD' }).id
    const conn = dir.addConnection(ws, { id: newId(), connectorKey: 'deel', entityId: co }).id
    await engine.post(ws, { type: 'payroll.run', externalId: 'r1', connectionId: conn, payDate: '2026-12-01', at: '2026-12-01T18:00:00Z', gross: usd(100_000), employerTaxes: usd(0), net: usd(100_000), status: 'paid', provider: 'Deel' })
    // No zone change, no rule drift: a re-post would reproduce the same entries, so nothing is counted or written.
    expect(await engine.repostToRules(ws, { connectionIds: [conn], eventTypes: ['payroll.run'], dryRun: true })).toEqual({})
    expect(await engine.repostToRules(ws, { connectionIds: [conn], eventTypes: ['payroll.run'], dryRun: false })).toEqual({})
  })
})
