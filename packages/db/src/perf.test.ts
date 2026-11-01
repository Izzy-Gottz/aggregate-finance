import { describe, expect, it, vi } from 'vitest'
import { perfCount, perfLine, perfPool, withPerf } from './perf.ts'

describe('perf counting (AGFN_PERF_LOG)', () => {
  it('counts statements, checkouts and RLS stamps into the scope the work runs in, nested scopes into both', async () => {
    const client = { query: async (_sql: string) => ({ rows: [] as unknown[] }), release() {} }
    const pool = perfPool({ connect: async () => client })
    const outer = await withPerf(async () => {
      const c = await pool.connect()
      await c.query('select 1')
      perfCount('rlsStamp')
      const inner = await withPerf(async () => {
        const d = await pool.connect()
        await d.query('select 2')
        await d.query('select 3')
      })
      expect([inner.counts.statements, inner.counts.checkouts]).toEqual([2, 1])
    })
    expect([outer.counts.statements, outer.counts.checkouts, outer.counts.rlsStamps]).toEqual([3, 2, 1])
    expect(perfLine(outer, { events: 7 })).toMatch(/^events 7, 3 statements, db \d+ ms, wall \d+ ms, other \d+ ms, lock wait 0 ms, pool wait \d+ ms, process cpu \d+ ms, 2 checkouts, 1 RLS stamps$/)
    // Outside any scope nothing is counted (and nothing breaks).
    await (await pool.connect()).query('select 4')
  })

  it('logs a slow statement with its SQL text, never its parameters', async () => {
    const client = {
      query: async (sql: string, _p?: unknown[]) =>
        sql.startsWith('EXPLAIN (FORMAT JSON)') ? { rows: [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 't', Filter: "(secret = 'hunter2'::text)" } }] }] } : new Promise<{ rows: unknown[] }>((r) => setTimeout(() => r({ rows: [1, 2] }), 30)),
      release() {},
    }
    const pool = perfPool({ connect: async () => client })
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    process.env.AGFN_PERF_SLOW_MS = '10'
    try {
      await (await pool.connect()).query('select *\n  from t where secret = $1', ['hunter2'])
      await (await pool.connect()).query('select *\n  from t where secret = $1', ['hunter3'])
      expect(info).toHaveBeenCalledTimes(3)
      const [line, plan, again] = info.mock.calls.map((c) => String(c[0]))
      // The plan the server chose, once per shape, with literals blanked.
      expect(plan).toMatch(/^\[agfn\] perf slow plan \[[0-9a-f]{8}\]: \[\{"Plan":\{"Node Type":"Seq Scan"/)
      expect(plan).not.toContain('\n')
      expect(plan).toContain("secret = '?'::text")
      expect(plan).not.toMatch(/hunter/)
      expect(line).toMatch(/^\[agfn\] perf slow statement \d+ ms, 2 rows \[[0-9a-f]{8}\]: select \* from t where secret = \$1$/)
      expect(again).toMatch(/^\[agfn\] perf slow statement \d+ ms, 2 rows \[[0-9a-f]{8}\]$/) // same shape: hash only
      expect(`${line}${again}`).not.toMatch(/hunter/)
    } finally {
      delete process.env.AGFN_PERF_SLOW_MS
      info.mockRestore()
    }
  })
})
