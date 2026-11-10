// The service attaches the shared `sources` block and the closing "Data as of" line to every data read, picks the
// right freshness aspect per tool, and skips non-data reads (whoami). The sources themselves are built by the host
// (apps/server/src/freshness.ts); here we drive the attachment with a fake port.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeHarness, READ_ALL, type Harness } from './fakes/harness.ts'
import { aspectFor, dataAsOfLine } from './service.ts'
import type { SourceEntry, SourcesPort } from './ports.ts'

const ENTRY: SourceEntry = { source: 'Chase', institution: 'Chase', kind: 'cached', data_as_of: '2026-11-05T09:00:00.000Z', last_checked: '2026-11-05T09:05:00.000Z', typical_refresh: 'updates every few hours', stale: false }

class FakeSources implements SourcesPort {
  calls: Array<{ entityIds: string[]; aspect: string }> = []
  async forEntities(i: { entityIds: string[]; aspect: string }): Promise<SourceEntry[]> {
    this.calls.push({ entityIds: i.entityIds, aspect: i.aspect })
    return [ENTRY]
  }
}

let H: Harness
let sources: FakeSources
beforeAll(async () => {
  sources = new FakeSources()
  H = await makeHarness({ sources })
})
afterAll(async () => await H.close())

describe('sources attachment on reads', () => {
  it('attaches sources + a "Data as of" line to a data read, with the overview aspect', async () => {
    const { principal } = await H.connectAi(READ_ALL)
    const r = await H.agfn.service.callTool(principal, 'get_overview', {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.output.data.sources).toEqual([ENTRY])
    expect(r.output.summary).toMatch(/Data as of: Chase .*\(updates every few hours\)\.$/)
    expect(sources.calls.at(-1)?.aspect).toBe('overview')
  })

  it('skips non-data reads (whoami carries no sources)', async () => {
    const { principal } = await H.connectAi(READ_ALL)
    const r = await H.agfn.service.callTool(principal, 'whoami', {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.output.data.sources).toBeUndefined()
    expect(r.output.summary).not.toMatch(/Data as of/)
  })
})

describe('pure helpers', () => {
  it('maps tools to the right freshness aspect', () => {
    expect(aspectFor('get_holdings')).toBe('investments')
    expect(aspectFor('query_transactions')).toBe('transactions')
    expect(aspectFor('list_accounts')).toBe('balances')
    expect(aspectFor('get_overview')).toBe('overview')
    expect(aspectFor('get_reports')).toBe('overview')
  })

  it('formats the line: live sources say "checked", cached say the provider time, stale is flagged', () => {
    const now = new Date('2026-11-05T10:00:00.000Z')
    const line = dataAsOfLine(
      [
        { source: 'Stripe', institution: null, kind: 'live', data_as_of: null, last_checked: '2026-11-05T09:48:00.000Z', typical_refresh: 'webhooks', stale: false },
        { source: 'Chase', institution: 'Chase', kind: 'cached', data_as_of: '2026-11-04T10:00:00.000Z', last_checked: '2026-11-05T09:00:00.000Z', typical_refresh: 'updates every few hours', stale: true },
      ],
      now,
    )
    expect(line).toContain('Stripe live, checked 12 min ago')
    expect(line).toContain('Chase 1d ago (updates every few hours) — stale')
  })

  it('a cached source with no provider time shows when WE checked, never implying a fresher data time', () => {
    const now = new Date('2026-11-05T10:00:00.000Z')
    const line = dataAsOfLine(
      [{ source: 'Chase', institution: 'Chase', kind: 'cached', data_as_of: null, last_checked: '2026-11-05T07:00:00.000Z', typical_refresh: 'updates every few hours', stale: false }],
      now,
    )
    expect(line).toContain('Chase: checked 3h ago (its own update time not reported yet)')
  })

  it('a file source states the statement closing date plainly, not an elapsed time', () => {
    const now = new Date('2026-11-05T10:00:00.000Z')
    const line = dataAsOfLine(
      [{ source: 'Statements', institution: 'Wells Fargo', kind: 'file', data_as_of: '2026-10-31', last_checked: '2026-11-01T10:00:00.000Z', typical_refresh: 'updates when you upload', stale: false }],
      now,
    )
    expect(line).toContain('Statements: statements through 2026-10-31')
  })

  it('a manual source is dated by its last entry, says so in plain words, and flags an old entry', () => {
    const now = new Date('2026-11-05T10:00:00.000Z')
    const manual = (data_as_of: string | null) => ({ source: 'Cash on hand', institution: null, kind: 'manual' as const, data_as_of, last_checked: null, typical_refresh: 'updates when you add an entry', stale: false })
    // A recent entry: "as of your last entry, Nov 3", no "over a month ago", never a sync "— stale".
    const recent = dataAsOfLine([manual('2026-11-03')], now)
    expect(recent).toContain('Cash on hand: as of your last entry, Nov 3')
    expect(recent).not.toContain('over a month ago')
    expect(recent).not.toContain('stale')
    // An entry over 30 days old is flagged plainly.
    expect(dataAsOfLine([manual('2026-09-20')], now)).toContain('Cash on hand: as of your last entry, Sep 20 (over a month ago)')
    // No entries at all.
    expect(dataAsOfLine([manual(null)], now)).toContain('Cash on hand: no entries yet')
  })

  it('a failed refresh leads with the failure and falls back to the last good data', () => {
    const now = new Date('2026-11-05T10:00:00.000Z')
    const base = { institution: 'Capital One', kind: 'cached' as const, data_as_of: '2026-11-02T01:18:27Z', last_checked: null, typical_refresh: 'updates every few hours', stale: true }
    // 2a's live case: failed after success, no error code.
    expect(dataAsOfLine([{ source: 'Capital One', ...base, refresh_failed_at: '2026-11-03T08:07:10Z', refresh_last_good: '2026-11-02T01:18:27Z' }], now))
      .toContain('Capital One: last refresh failed Nov 3; data from Nov 2')
    // A known error code becomes plain words.
    expect(dataAsOfLine([{ source: 'Chase', ...base, refresh_failed_at: '2026-11-03T08:07:10Z', refresh_last_good: '2026-11-02T01:18:27Z', error_code: 'ITEM_LOGIN_REQUIRED' }], now))
      .toContain('Chase: last refresh failed Nov 3; data from Nov 2 — you may need to reconnect it')
    // An unknown code falls back to the raw code; a never-succeeded Item says so.
    expect(dataAsOfLine([{ source: 'Ally', ...base, refresh_failed_at: '2026-11-03T08:07:10Z', refresh_last_good: null, error_code: 'SOME_NEW_CODE' }], now))
      .toContain('Ally: last refresh failed Nov 3; no good data yet — SOME_NEW_CODE')
  })
})
