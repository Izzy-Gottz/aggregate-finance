// Usage metering (hosted readiness): what each workspace costs to run, so pricing can follow measured costs.
// Live counts come from the tables themselves; sync durations and emails are sampled as they happen
// (usage_samples), and a daily job writes one rollup row per workspace per day (usage_daily). Read-only for people.

import { sql, type Kysely } from 'kysely'
import type { DbKind } from '@agfn/db'

export interface UsageSamplesTable {
  workspace_id: string
  day: string
  metric: string
  value: number
  created_at: string
}
export interface UsageDailyTable {
  workspace_id: string
  day: string
  json: string
  created_at: string
}
export interface UsageTables {
  usage_samples: UsageSamplesTable
  usage_daily: UsageDailyTable
}

/** Instance-wide rows (emails are not tied to a workspace). */
export const INSTANCE = '_'
const KEEP_SAMPLE_DAYS = 35
const KEEP_DAILY_DAYS = 400

export interface UsageSnapshot {
  day: string
  /** Active Plaid Items: each is billed per month by Plaid. Products beyond transactions are add-ons. */
  plaidItems: { active: number; products: Record<string, number> }
  connections: Record<string, { active: number; total: number }>
  transactionsStored: number
  documents: { count: number; bytes: number }
  syncJobs: { count: number; p50Ms: number | null; p95Ms: number | null; failed: number }
  mcpCalls: { total: number; byTool: Record<string, number> }
  /** Live balance checks (Plaid /accounts/balance/get, billed per call) made that day. */
  liveBalanceChecks: number
  /** Rough share of database rows that belong to this workspace, and the bytes that implies. */
  db: { rowShare: number; estimatedBytes: number | null }
}

export interface InstanceSnapshot {
  day: string
  emailsSent: number
  dbBytes: number | null
  workspaces: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = Kysely<any>

const dayOf = (d: Date) => d.toISOString().slice(0, 10)
const num = (v: unknown) => Number(v ?? 0)

export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[i]!
}

const notPublicDemo = (eb: any) => eb.not(eb.exists(eb.selectFrom('settings').select('key').whereRef('settings.workspace_id', '=', 'workspaces.id').where('settings.key', '=', 'public_demo')))

export class UsageMeter {
  readonly db: AnyDb
  readonly kind: DbKind
  readonly now: () => Date
  constructor(db: Kysely<never> | AnyDb, kind: DbKind, now: () => Date = () => new Date()) {
    this.db = db as AnyDb
    this.kind = kind
    this.now = now
  }

  /** Record one event sample. Never throws: metering must not break the work it measures. */
  async sample(workspaceId: string | null, metric: 'sync_ms' | 'sync_failed' | 'email' | 'live_balance', value = 1): Promise<void> {
    const now = this.now()
    await this.db
      .insertInto('usage_samples')
      .values({ workspace_id: workspaceId ?? INSTANCE, day: dayOf(now), metric, value: Math.max(0, Math.round(value)), created_at: now.toISOString() })
      .execute()
      .catch(() => undefined)
  }

  async dbBytes(): Promise<number | null> {
    try {
      if (this.kind === 'postgres') {
        const r = await sql<{ size: string | number }>`select pg_database_size(current_database()) as size`.execute(this.db)
        return num(r.rows[0]?.size)
      }
      const pc = await sql<{ page_count: number }>`pragma page_count`.execute(this.db)
      const ps = await sql<{ page_size: number }>`pragma page_size`.execute(this.db)
      return num(pc.rows[0]?.page_count) * num(ps.rows[0]?.page_size)
    } catch {
      return null
    }
  }

  /** Counts for one workspace as of `day` (counts of stored things are "now"; per-day activity is for `day`). */
  async snapshot(workspaceId: string, day: string = dayOf(this.now())): Promise<UsageSnapshot> {
    const db = this.db
    const conns = await db.selectFrom('connections').select(['connector_key', 'status', 'config_json']).where('workspace_id', '=', workspaceId).execute()
    const connections: UsageSnapshot['connections'] = {}
    const products: Record<string, number> = {}
    let plaidActive = 0
    for (const c of conns as Array<{ connector_key: string; status: string; config_json: string }>) {
      const e = (connections[c.connector_key] ??= { active: 0, total: 0 })
      e.total++
      if (c.status === 'disconnected') continue
      e.active++
      if (c.connector_key === 'plaid') {
        plaidActive++
        products.transactions = (products.transactions ?? 0) + 1
        let extra: unknown = []
        try {
          extra = (JSON.parse(c.config_json || '{}') as { products?: unknown }).products ?? []
        } catch {
          /* unreadable config counts as transactions only */
        }
        if (Array.isArray(extra)) for (const p of extra) if (typeof p === 'string') products[p] = (products[p] ?? 0) + 1
      }
    }

    const count = async (table: string, where: (q: any) => any = (q) => q): Promise<number> => {
      try {
        const r = await where(db.selectFrom(table).select(db.fn.countAll().as('n')).where('workspace_id', '=', workspaceId)).executeTakeFirst()
        return num(r?.n)
      } catch {
        return 0
      }
    }
    const transactionsStored = await count('ledger_records', (q) => q.where('event_type', '=', 'txn.upsert'))
    const docRow = await db.selectFrom('documents').select([db.fn.countAll().as('n'), db.fn.sum('size_bytes').as('bytes')]).where('workspace_id', '=', workspaceId).executeTakeFirst()

    const samples = (await db.selectFrom('usage_samples').select(['metric', 'value']).where('workspace_id', '=', workspaceId).where('day', '=', day).execute()) as Array<{ metric: string; value: number }>
    const durations = samples.filter((s) => s.metric === 'sync_ms').map((s) => num(s.value)).sort((a, b) => a - b)

    const calls = (await db
      .selectFrom('activity_log')
      .select(['action', db.fn.countAll().as('n')])
      .where('workspace_id', '=', workspaceId)
      .where('action', 'like', 'tool.%')
      .where('at', '>=', `${day}T00:00:00.000Z`)
      .where('at', '<', `${dayOf(new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000))}T00:00:00.000Z`)
      .groupBy('action')
      .execute()
      .catch(() => [])) as Array<{ action: string; n: unknown }>
    const byTool: Record<string, number> = {}
    for (const c of calls) byTool[c.action.slice(5)] = num(c.n)

    // Row share across the big tables, times the database size: rough, but enough to see who dominates storage.
    const big = ['ledger_records', 'raw_records', 'journal_lines', 'activity_log', 'documents']
    let mine = 0
    let all = 0
    for (const t of big) {
      mine += await count(t)
      try {
        all += num((await db.selectFrom(t).select(db.fn.countAll().as('n')).executeTakeFirst())?.n)
      } catch {
        /* table not installed */
      }
    }
    const rowShare = all ? mine / all : 0
    const bytes = await this.dbBytes()

    return {
      day,
      plaidItems: { active: plaidActive, products },
      connections,
      transactionsStored,
      documents: { count: num(docRow?.n), bytes: num(docRow?.bytes) },
      syncJobs: { count: durations.length, p50Ms: percentile(durations, 50), p95Ms: percentile(durations, 95), failed: samples.filter((s) => s.metric === 'sync_failed').length },
      mcpCalls: { total: Object.values(byTool).reduce((a, b) => a + b, 0), byTool },
      liveBalanceChecks: samples.filter((s) => s.metric === 'live_balance').length,
      db: { rowShare: Math.round(rowShare * 10_000) / 10_000, estimatedBytes: bytes === null ? null : Math.round(bytes * rowShare) },
    }
  }

  async instance(day: string = dayOf(this.now())): Promise<InstanceSnapshot> {
    const emails = await this.db.selectFrom('usage_samples').select(this.db.fn.countAll().as('n')).where('workspace_id', '=', INSTANCE).where('metric', '=', 'email').where('day', '=', day).executeTakeFirst()
    // The public demo's books (rebuilt nightly, public-demo.ts) aren't anyone's workspace: not counted, not rolled up.
    const ws = await this.db.selectFrom('workspaces').select(this.db.fn.countAll().as('n')).where(notPublicDemo).executeTakeFirst()
    return { day, emailsSent: num(emails?.n), dbBytes: await this.dbBytes(), workspaces: num(ws?.n) }
  }

  /** The daily job: roll up yesterday (complete) for every workspace and the instance, then prune old rows. */
  async rollup(day: string = dayOf(new Date(this.now().getTime() - 86_400_000))): Promise<number> {
    const now = this.now().toISOString()
    const wss = (await this.db.selectFrom('workspaces').select('id').where(notPublicDemo).execute()) as Array<{ id: string }>
    const rows: Array<{ workspace_id: string; json: string }> = []
    for (const w of wss) rows.push({ workspace_id: w.id, json: JSON.stringify(await this.snapshot(w.id, day)) })
    rows.push({ workspace_id: INSTANCE, json: JSON.stringify(await this.instance(day)) })
    for (const r of rows) {
      await this.db.deleteFrom('usage_daily').where('workspace_id', '=', r.workspace_id).where('day', '=', day).execute()
      await this.db.insertInto('usage_daily').values({ ...r, day, created_at: now }).execute()
    }
    const cut = (days: number) => dayOf(new Date(this.now().getTime() - days * 86_400_000))
    await this.db.deleteFrom('usage_samples').where('day', '<', cut(KEEP_SAMPLE_DAYS)).execute()
    await this.db.deleteFrom('usage_daily').where('day', '<', cut(KEEP_DAILY_DAYS)).execute()
    return rows.length
  }

  async history(workspaceId: string, days = 30): Promise<Array<UsageSnapshot | InstanceSnapshot>> {
    const from = dayOf(new Date(this.now().getTime() - days * 86_400_000))
    const rows = (await this.db.selectFrom('usage_daily').select('json').where('workspace_id', '=', workspaceId).where('day', '>=', from).orderBy('day').execute()) as Array<{ json: string }>
    return rows.map((r) => JSON.parse(r.json) as UsageSnapshot)
  }
}
