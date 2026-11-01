// The equity service on a real database: SQLite for the flows, PGlite once to prove the migration and queries run on
// Postgres. A fake ledger records what would be posted.
import type { EquityEvent, MetricScope, Provenance } from '@agfn/contracts'
import { connect, connectPglite, migrateToLatest, newId, nowIso, type CoreTables, type DbHandle } from '@agfn/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EquityService, sameContent, type EquityTables } from './service.ts'
import { importCapTableCsv } from './csv.ts'
import { toOcfObject } from './ocf.ts'
import { fullyDiluted } from './captable.ts'

type T = CoreTables & EquityTables
const usd = (d: number) => ({ minor: Math.round(d * 100 * 10_000) / 10_000, currency: 'USD' })
const person: Provenance = { writeRequestId: 'w1', actorKind: 'person', personId: 'p1', label: 'you' }
const claude: Provenance = { writeRequestId: 'w2', actorKind: 'agent', personId: 'p1', grantId: 'g1', label: 'Claude · Alex' }

async function seed(h: DbHandle<T>) {
  await migrateToLatest(h.db)
  const ws = newId()
  const acme = newId()
  const personal = newId()
  await h.db.insertInto('workspaces').values({ id: ws, name: 'W', base_currency: 'USD', created_at: nowIso() }).execute()
  for (const [id, kind, name] of [[acme, 'company', 'Acme'], [personal, 'personal', 'Personal']] as const)
    await h.db.insertInto('entities').values({ id, workspace_id: ws, kind, name, base_currency: 'USD', owner_person_id: null, parent_entity_id: null, fiscal_year_start_month: 1, created_at: nowIso(), archived_at: null }).execute()
  return { ws, acme, personal }
}

class FakeLedger {
  posted: Array<{ ws: string; ev: EquityEvent }> = []
  async post(ws: string, ev: EquityEvent) {
    this.posted.push({ ws, ev })
    return { journalEntryId: 'je' }
  }
}

describe('EquityService (SQLite)', () => {
  let h: DbHandle<T>
  let ws: string
  let acme: string
  let personal: string
  let ledger: FakeLedger
  let svc: EquityService
  const cmd = (payload: Record<string, unknown>) => ({ op: 'record_equity_event' as const, workspaceId: ws, entityId: acme, payload })

  beforeEach(async () => {
    h = connect<T>('sqlite::memory:')
    ;({ ws, acme, personal } = await seed(h))
    ledger = new FakeLedger()
    svc = new EquityService({ db: h.db, ledger, now: () => '2026-10-09T12:00:00.000Z' })
  })
  afterEach(() => h.close())

  it('records a founder issuance, a SAFE and a grant from plain requests', async () => {
    await svc.apply(cmd({ kind: 'issuance', date: '2025-01-02', stakeholder: 'Ada Lovelace', shares: 8_000_000, pricePerShare: usd(0.0001) }), person)
    const safe = await svc.apply(cmd({ kind: 'safe', date: '2025-03-15', stakeholder: 'Kite Ventures LLC', amount: usd(250_000), valuationCap: usd(8_000_000) }), claude)
    expect(safe.summary).toBe('Recorded a $250,000 SAFE from Kite Ventures LLC at a $8,000,000 cap.')
    expect(safe.recordType).toBe('equity_event')
    const grant = await svc.apply(cmd({ kind: 'option_grant', date: '2025-04-01', stakeholder: 'Eve Park', shares: 100_000, pricePerShare: usd(0.31), vesting: { start: '2025-04-01', months: 48, cliff_months: 12 } }), person)
    expect(grant.summary).toMatch(/There was no option pool/)

    const d = await svc.detail(ws, acme)
    expect(d.fullyDiluted.total).toBe(8_100_000)
    expect(d.holders.map((h) => h.name)).toEqual(['Ada Lovelace', 'Eve Park'])
    expect(d.convertibles[0]).toMatchObject({ holder: 'Kite Ventures LLC', kind: 'SAFE', line: '$8M post-money cap' })
    expect(d.grants[0]!.line).toBe('37,500 of 100,000 vested · 4 years, 12-month cliff · $0.31 strike') // Apr 2025 → Oct 2026 = 18 of 48 months
  })

  it('posts money events to the ledger through one Cap table connection, and reverses them on undo', async () => {
    await svc.apply(cmd({ kind: 'issuance', date: '2025-01-02', stakeholder: 'Ada', shares: 8_000_000, pricePerShare: usd(0.0001) }), person)
    const safe = await svc.apply(cmd({ kind: 'safe', date: '2025-03-15', stakeholder: 'Kite', amount: usd(250_000) }), claude)
    expect(ledger.posted.map((p) => [p.ev.kind, p.ev.amount?.minor, p.ev.stakeholder])).toEqual([
      ['issuance', 80_000, 'Ada'], // 8,000,000 × $0.0001 = $800
      ['safe', 25_000_000, 'Kite'],
    ])
    const conns = await h.db.selectFrom('connections').selectAll().where('workspace_id', '=', ws).execute()
    expect(conns).toHaveLength(1)
    expect(conns[0]).toMatchObject({ connector_key: 'equity', entity_id: acme, status: 'active', display_name: 'Cap table' })
    expect(new Set(ledger.posted.map((p) => p.ev.connectionId))).toEqual(new Set([conns[0]!.id]))

    await svc.revert(ws, safe.recordId, claude)
    expect(ledger.posted.at(-1)!.ev).toMatchObject({ kind: 'safe', amount: { minor: 0, currency: 'USD' } })
    expect((await svc.detail(ws, acme)).convertibles).toEqual([])
    await svc.revert(ws, safe.recordId, claude) // twice is harmless
    expect(ledger.posted).toHaveLength(3)
  })

  it('exercise, transfer and cancellation move the right shares, and refuse impossible ones', async () => {
    await svc.apply(cmd({ kind: 'issuance', date: '2025-01-02', stakeholder: 'Ada', shares: 1_000_000 }), person)
    await svc.apply(cmd({ kind: 'option_grant', date: '2025-01-02', stakeholder: 'Eve', shares: 40_000, pricePerShare: usd(0.25) }), person)
    await svc.apply(cmd({ kind: 'exercise', date: '2026-01-02', stakeholder: 'Eve', shares: 10_000 }), person)
    expect(ledger.posted.at(-1)!.ev).toMatchObject({ kind: 'exercise', amount: usd(2_500), shares: 10_000 })
    await svc.apply(cmd({ kind: 'transfer', date: '2026-02-01', stakeholder: 'Ada', shares: 100_000, toStakeholder: 'Ada Trust' }), person)
    await svc.apply(cmd({ kind: 'cancellation', date: '2026-03-01', stakeholder: 'Eve', shares: 5_000 }), person)
    const s = await svc.state(ws, acme)
    const fd = fullyDiluted(s)
    // stock 1,000,000 + 10,000; options 40,000 − 10,000 − 5,000 = 25,000; pool sized to 40,000 → 40,000 − 35,000 used = 5,000
    expect(fd).toEqual({ issued: 1_010_000, options: 25_000, stockOptions: 25_000, rsus: 0, warrants: 0, poolAvailable: 5_000, total: 1_040_000 })
    await expect(svc.apply(cmd({ kind: 'exercise', date: '2026-04-01', stakeholder: 'Eve', shares: 999_999 }), person)).rejects.toThrow('Eve has 25,000 options left, not 999,999.')
    await expect(svc.apply(cmd({ kind: 'transfer', date: '2026-04-01', stakeholder: 'Ada', shares: 5_000_000, toStakeholder: 'X' }), person)).rejects.toThrow(/Ada holds 900,000 shares/)
    await expect(svc.apply(cmd({ kind: 'safe', date: '2026-04-01', stakeholder: 'X' }), person)).rejects.toThrow('A SAFE needs an amount.')
  })

  it('RSUs: granted, released when vested (some withheld for tax); no cash moves', async () => {
    await svc.apply(cmd({ kind: 'issuance', date: '2025-01-02', stakeholder: 'Ada', shares: 1_000_000 }), person)
    const g = await svc.apply(cmd({ kind: 'option_grant', grantType: 'rsu', date: '2025-01-01', stakeholder: 'Rui', shares: 48_000, vesting: { start: '2025-01-01', months: 48, cliff_months: 12 } }), person)
    expect(g.summary).toMatch(/^Granted 48,000 RSUs to Rui\./)
    // Before the cliff nothing can be released.
    await expect(svc.apply(cmd({ kind: 'exercise', grantType: 'rsu', date: '2025-06-01', stakeholder: 'Rui', shares: 1 }), person)).rejects.toThrow('Rui has 0 vested RSUs to release on 2025-06-01, not 1.')
    // With no options, an exercise for someone who only holds RSUs is a release.
    const r = await svc.apply(cmd({ kind: 'exercise', date: '2026-01-01', stakeholder: 'Rui', shares: 12_000, withheldShares: 4_000 }), person)
    expect(r.summary).toBe('Released 12,000 RSUs to Rui (4,000 kept back for tax, 8,000 shares issued).')
    const fd = fullyDiluted(await svc.state(ws, acme))
    expect(fd).toMatchObject({ issued: 1_008_000, rsus: 36_000 })
    expect(ledger.posted).toEqual([])
  })

  it('warrants: issued with a purchase price, exercised for cash or cashless at the 409A', async () => {
    await svc.apply(cmd({ kind: 'issuance', date: '2025-01-02', stakeholder: 'Ada', shares: 1_000_000 }), person)
    const w = await svc.apply(cmd({ kind: 'option_grant', grantType: 'warrant', date: '2025-06-01', stakeholder: 'Lender Bank', shares: 100_000, pricePerShare: usd(0.5), amount: usd(1_000), expirationDate: '2030-06-30' }), person)
    expect(w.summary).toBe('Issued a warrant to Lender Bank for 100,000 Common shares at $0.50, expiring Jun 30, 2030; $1,000 paid for it.')
    expect(ledger.posted.at(-1)!.ev).toMatchObject({ kind: 'issuance', amount: usd(1_000), stakeholder: 'Lender Bank' })
    const cash = await svc.apply(cmd({ kind: 'exercise', grantType: 'warrant', date: '2026-01-01', stakeholder: 'Lender Bank', shares: 40_000 }), person)
    expect(cash.summary).toBe('Lender Bank exercised warrants for 40,000 shares, paying $20,000.')
    expect(ledger.posted.at(-1)!.ev).toMatchObject({ kind: 'exercise', amount: usd(20_000), shares: 40_000 })
    await expect(svc.apply(cmd({ kind: 'exercise', grantType: 'warrant', netExercise: true, date: '2026-02-01', stakeholder: 'Lender Bank', shares: 60_000 }), person)).rejects.toThrow(/needs the fair value per share/)
    const posted = ledger.posted.length
    const net = await svc.apply(cmd({ kind: 'exercise', grantType: 'warrant', netExercise: true, fairValuePerShare: usd(2), date: '2026-02-01', stakeholder: 'Lender Bank', shares: 60_000 }), person)
    expect(net.summary).toBe('Lender Bank exercised warrants for 60,000 shares, cashless at $2 a share: 45,000 shares issued, no cash.')
    expect(ledger.posted).toHaveLength(posted) // cashless: no money
    // 40,000 cash + 60,000 × 1.5 / 2 = 45,000 cashless.
    expect(fullyDiluted(await svc.state(ws, acme))).toMatchObject({ issued: 1_085_000, warrants: 0 })
    const d = await svc.detail(ws, acme)
    expect(d.warrants[0]).toMatchObject({ holder: 'Lender Bank', outstanding: 0, live: false })
  })

  it('cancelling warrants and undoing a warrant both work', async () => {
    await svc.apply(cmd({ kind: 'issuance', date: '2025-01-02', stakeholder: 'Ada', shares: 1_000_000 }), person)
    const w = await svc.apply(cmd({ kind: 'option_grant', grantType: 'warrant', date: '2025-06-01', stakeholder: 'Lender Bank', shares: 100_000, pricePerShare: usd(0.5) }), person)
    await svc.apply(cmd({ kind: 'cancellation', grantType: 'warrant', date: '2026-01-01', stakeholder: 'Lender Bank', shares: 30_000 }), person)
    expect(fullyDiluted(await svc.state(ws, acme))).toMatchObject({ warrants: 70_000 })
    await svc.revert(ws, w.recordId, person)
    expect(fullyDiluted(await svc.state(ws, acme))).toMatchObject({ warrants: 0, total: 1_000_000 })
  })

  it('detail shows totals in the company’s currency using the ledger’s rates, or unknown without one', async () => {
    await svc.apply(cmd({ kind: 'safe', date: '2026-01-01', stakeholder: 'Vela GmbH', amount: { minor: 50_000_000, currency: 'EUR' } }), person)
    await svc.apply(cmd({ kind: 'safe', date: '2026-02-01', stakeholder: 'Kite', amount: usd(100_000) }), person)
    const priced = new EquityService({ db: h.db, ledger, now: () => '2026-10-09T12:00:00.000Z', rates: { rate: async (_d, from, to) => (from === 'EUR' && to === 'USD' ? '1.1' : Promise.reject(new Error('no rate'))) } })
    // €500,000 → $550,000, plus $100,000.
    expect((await priced.detail(ws, acme)).home).toMatchObject({ currency: 'USD', missing: [], safesAndNotes: usd(650_000) })
    expect((await svc.detail(ws, acme)).home).toMatchObject({ currency: 'USD', missing: ['EUR'], safesAndNotes: null })
  })

  it('flags a SAFE told twice', async () => {
    await svc.apply(cmd({ kind: 'safe', date: '2025-03-15', stakeholder: 'Kite', amount: usd(250_000) }), person)
    const again = await svc.apply(cmd({ kind: 'safe', date: '2025-03-18', stakeholder: 'Kite', amount: usd(250_000) }), claude)
    expect(again.possibleDuplicates).toHaveLength(1)
  })

  it('only companies have a cap table', async () => {
    await expect(svc.apply({ ...cmd({ kind: 'issuance', date: '2025-01-01', stakeholder: 'A', shares: 1 }), entityId: personal }, person)).rejects.toThrow('Only companies have a cap table.')
  })

  it('answers the ledger: capTable, hasEquity and the fully_diluted metric', async () => {
    const scope = { workspaceId: ws, entityIds: [acme, personal] }
    expect(await svc.hasEquity(scope)).toBe(false)
    expect((await svc.fullyDilutedMetric({ workspaceId: ws, entityIds: 'all' } as MetricScope)).state).toBe('no_data')
    await svc.apply(cmd({ kind: 'issuance', date: '2025-01-02', stakeholder: 'Ada', shares: 9_000_000 }), person)
    await svc.apply(cmd({ kind: 'safe', date: '2025-03-15', stakeholder: 'Kite', amount: usd(1_000_000), valuationCap: usd(10_000_000) }), claude)
    expect(await svc.hasEquity(scope)).toBe(true)
    const [view] = await svc.capTable(scope)
    expect(view).toMatchObject({ entityId: acme, fullyDilutedShares: 9_000_000, holders: [{ name: 'Ada', class: 'Common', shares: 9_000_000, fullyDilutedPct: 100 }], safesAndNotes: [{ holder: 'Kite', kind: 'safe', amount: usd(1_000_000), cap: usd(10_000_000) }], optionPool: null })
    const m = await svc.fullyDilutedMetric({ workspaceId: ws, entityIds: 'all' } as MetricScope)
    expect(m).toMatchObject({ name: 'fully_diluted', value: 9_000_000, state: 'ok', agentEntriesIncluded: 2 })
    // Modeling uses the stored table.
    const r = await svc.modelRound(ws, acme, { date: '2026-01-01', preMoney: usd(20_000_000), investment: usd(5_000_000) })
    expect(r.conversions[0]!.shares).toBe(1_000_000)
  })

  it('imports OCF and Carta CSV idempotently, and exports OCF', async () => {
    const csv = 'Stakeholder,Security Type,Shares,Issue Date,Price Per Share\nAda,Common,6000000,2025-01-02,0.0001\nBen,Common,3000000,2025-01-02,0.0001\n'
    const a = await svc.importCsv(ws, acme, csv, { origin: 'import', label: 'Carta import' })
    expect(a.added).toBe(5) // 2 stakeholders, Common, 2 issuances
    // The same file again (43: it used to double every row): nothing new.
    const twice = await svc.importCsv(ws, acme, csv.replace(/\n/g, '\r\n'), { origin: 'import', label: 'Carta import' })
    expect(twice.added).toBe(0)
    const files = await svc.exportOcf(ws, acme)
    expect(Object.keys(files)).toContain('Manifest.ocf.json')
    const again = await svc.importOcf(ws, acme, files, { origin: 'import' })
    expect(again.added).toBe(0)
    expect(again.notes.at(-1)).toBe('5 items were already on the cap table and skipped.')
    expect((await svc.detail(ws, acme)).fullyDiluted.total).toBe(9_000_000)
  })
})

describe('EquityService (Postgres via PGlite)', () => {
  it('runs the migration and a write/read/undo cycle', async () => {
    const h = await connectPglite<T>()
    try {
      const { ws, acme } = await seed(h)
      const ledger = new FakeLedger()
      const svc = new EquityService({ db: h.db, ledger })
      const w = await svc.apply({ op: 'record_equity_event', workspaceId: ws, entityId: acme, payload: { kind: 'convertible_note', date: '2025-01-01', stakeholder: 'Noteholder', amount: usd(100_000), interestPct: 8, valuationCap: usd(5_000_000) } }, person)
      expect((await svc.detail(ws, acme)).convertibles[0]).toMatchObject({ kind: 'NOTE', amount: usd(100_000) })
      await svc.revert(ws, w.recordId, person)
      expect(await svc.hasEquity({ workspaceId: ws, entityIds: [acme] })).toBe(false)
      expect(ledger.posted.map((p) => p.ev.amount?.minor)).toEqual([10_000_000, 0])
    } finally {
      await h.close()
    }
  }, 60_000)
})

describe('sameContent: an import from before ids came from the file', () => {
  it('skips rows already there under other ids, and what hangs off them', () => {
    const csv = [
      'Stakeholder,Security Type,Shares,Issue Date,Price Per Share,Released,Expiration Date,Share Class',
      'Rina Patel,RSU,24000,2025-03-01,,6000,,Common',
      'Oak Bank,Warrant,30000,2025-04-01,0.0125,,2031-04-01,Common',
      'Ada,Common,1000,2025-01-02,0.0001,,,Common',
    ].join('\n')
    const before = importCapTableCsv(csv, { idPrefix: 'csvmv4awwfn' }).objects
    const again = importCapTableCsv(csv, { idPrefix: 'csvdifferent', existing: before }).objects
    const have = new Set(before.map((o) => o.id))
    expect(sameContent(before, again.filter((o) => !have.has(o.id)))).toEqual([])
    // A row that differs (another quantity) is still new.
    const more = importCapTableCsv(csv.replace('1000,2025-01-02', '2000,2025-01-02'), { idPrefix: 'csvthird', existing: before }).objects
    expect(sameContent(before, more.filter((o) => !have.has(o.id))).map((o) => o.type)).toEqual(['TX_STOCK_ISSUANCE'])
  })

  it('exports a bank saved as a person (before banks were recognized) as an institution', () => {
    const o = toOcfObject({ type: 'STAKEHOLDER', id: 's1', name: 'Harbor Bank', stakeholderType: 'INDIVIDUAL' })
    expect(o).toMatchObject({ stakeholder_type: 'INSTITUTION' })
  })
})
