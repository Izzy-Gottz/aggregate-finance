// "Today" is the workspace's own day, not UTC's: closing the books, the cash trend's month ends and what's due.
import type { FinanceReader } from '@agfn/contracts'
import { connect, migrateToLatest, type CoreTables } from '@agfn/db'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RequestPerson } from './app.ts'
import { composeFinance } from './finance.ts'
import { cashTrend, financeRoutes } from './routes/finance.ts'

const WS = 'ws_tz'
const ACME = 'ent_acme'

afterEach(() => vi.useRealTimers())

async function setup(timeZone: string) {
  const h = await connect<CoreTables>('sqlite::memory:')
  await migrateToLatest(h.db)
  const at = '2026-10-01T12:00:00.000Z'
  await h.db.insertInto('workspaces').values({ id: WS, name: 'W', base_currency: 'USD', created_at: at, time_zone: timeZone } as never).execute()
  await h.db.insertInto('entities').values({ id: ACME, workspace_id: WS, kind: 'company', name: 'Acme', base_currency: 'USD', owner_person_id: null, parent_entity_id: null, fiscal_year_start_month: 1, created_at: at, archived_at: null }).execute()
  const submitted: Array<Record<string, unknown>> = []
  const permissions = { entitiesFor: async () => [{ id: ACME, name: 'Acme', kind: 'company' as const }], can: async () => true, canManageWorkspace: async () => true }
  const mcp = { pipeline: { submit: async (w: Record<string, unknown>) => (submitted.push(w), { status: 'applied', summary: 'closed' }) } }
  const s = { db: h.db as never, ledger: {} as never, syncDeps: { afterSync: [] } as never, permissions: permissions as never, mcp: mcp as never }
  const app = new Hono<{ Variables: { person: RequestPerson } }>()
  app.onError((err) => (err instanceof HTTPException ? err.getResponse() : new Response(String(err), { status: 500 })))
  app.use('/api/*', async (c, next) => {
    c.set('person', { personId: 'p', name: 'Y', email: 'y@example.test', sessionId: 's', workspaceId: WS })
    await next()
  })
  app.route('/api', financeRoutes(s as never))
  const close = (through: string) => app.request(`/api/entities/${ACME}/period`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'close', through, idempotencyKey: `k-${through}` }) })
  return { h, s, close, submitted }
}

describe('today in the workspace’s time zone', () => {
  it('closing the books: “a day before today” is the workspace’s today', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // 03:00 UTC on the 16th is still the 15th in Los Angeles: closing through the 15th closes today.
    vi.setSystemTime(new Date('2026-10-16T03:00:00Z'))
    const la = await setup('America/Los_Angeles')
    try {
      expect((await la.close('2026-10-15')).status).toBe(400)
      expect((await la.close('2026-10-14')).status).toBe(200)
    } finally {
      await la.h.close()
    }
    // Noon UTC on the 16th is already the 17th in Kiritimati (UTC+14): the 16th is yesterday there.
    vi.setSystemTime(new Date('2026-10-16T12:00:00Z'))
    const ki = await setup('Pacific/Kiritimati')
    try {
      expect((await ki.close('2026-10-16')).status).toBe(200)
    } finally {
      await ki.h.close()
    }
  })

  it('the cash trend leaves out months before cash is known, and has no trend across a gap', async () => {
    const { h, s } = await setup('America/New_York')
    try {
      const usd = (minor: number) => ({ minor, currency: 'USD' })
      const r = {} as FinanceReader
      const at = (days: Array<{ minor: number; currency: string } | null>) => cashTrend({ ...(s as object), ledger: { cashHistory: async () => days } } as never, r, WS, ACME, new Date('2026-11-01T12:00:00Z'))
      // A company that started in August: three known month-ends and today, never nine $0 months before them.
      expect(await at([...Array(8).fill(null), usd(100_00), usd(200_00), usd(300_00), usd(400_00)])).toEqual([100, 200, 300, 400])
      expect(await at([usd(100_00), null, ...Array(10).fill(usd(100_00))])).toEqual([])
      expect(await at(Array(12).fill(null))).toEqual([])
    } finally {
      await h.close()
    }
  })

  it('the cash trend ends on the workspace’s today and its month ends', async () => {
    const { h, s } = await setup('America/New_York')
    try {
      const asked: string[] = []
      const r = { metric: async (_k: string, scope: { to: string }) => (asked.push(scope.to), { state: 'ok', value: { minor: 100, currency: 'USD' } }) } as unknown as FinanceReader
      // 02:00 UTC on November 1st is October 31st in New York: October is still the current month.
      await cashTrend(s as never, r, WS, ACME, new Date('2026-11-01T02:00:00Z'))
      expect(asked.at(-1)).toBe('2026-10-31')
      expect(asked.at(-2)).toBe('2026-09-30')
      expect(asked[0]).toBe('2025-11-30')
      expect(asked).toHaveLength(12)
    } finally {
      await h.close()
    }
  })

  it('what’s due counts from the workspace’s today', async () => {
    const seen: string[] = []
    const terms = { paymentsDue: async (_scope: unknown, today: string) => (seen.push(today), []) } as never
    const f = composeFinance({ core: { reader: { upcoming: async () => [] }, writer: {} as never, owns: async () => false }, terms, today: async () => '2026-10-15' as never })
    await f.reader.upcoming({ workspaceId: WS, entityIds: [ACME] }, 30)
    expect(seen).toEqual(['2026-10-15'])
  })
})
