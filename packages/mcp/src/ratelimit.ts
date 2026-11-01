import { sql, type Kysely } from 'kysely'
import type { McpTables } from './store/schema.ts'
// Per-grant sliding-window limits (roundtable §7.4). In-process: one hosted web role per region, or a shared
// limiter can be injected by S9 through the RateLimiter interface.

export interface RateLimiter {
  /** Records a hit and returns 0 if allowed, else the seconds until the next slot frees up. */
  hit(key: string, limit: number, windowMs: number, nowMs: number): Promise<number>
}

export class MemoryRateLimiter implements RateLimiter {
  private hits = new Map<string, number[]>()
  private lastSweep = 0

  async hit(key: string, limit: number, windowMs: number, nowMs: number): Promise<number> {
    if (nowMs - this.lastSweep > 60_000) this.sweep(nowMs, windowMs)
    const since = nowMs - windowMs
    const list = (this.hits.get(key) ?? []).filter((t) => t > since)
    if (list.length >= limit) {
      this.hits.set(key, list)
      return Math.max(1, Math.ceil((list[0]! + windowMs - nowMs) / 1000))
    }
    list.push(nowMs)
    this.hits.set(key, list)
    return 0
  }

  private sweep(nowMs: number, windowMs: number): void {
    this.lastSweep = nowMs
    for (const [k, v] of this.hits) if (!v.some((t) => t > nowMs - Math.max(windowMs, 3_600_000))) this.hits.delete(k)
  }
}

/**
 * Shared limiter for several instances (hosted): a sliding-window counter in the database. Two fixed windows per key;
 * the estimate weights the previous window by how much of it still overlaps. One upsert per hit.
 */
export class DbRateLimiter implements RateLimiter {
  private readonly db: Kysely<McpTables>
  private lastSweep = 0
  /** Any Kysely instance whose schema includes McpTables (e.g. Kysely<CoreTables & McpTables>). */
  constructor(db: Kysely<any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
    this.db = db as Kysely<McpTables>
  }

  async hit(key: string, limit: number, windowMs: number, nowMs: number): Promise<number> {
    const start = nowMs - (nowMs % windowMs)
    const row = await this.db
      .insertInto('rate_limit_counters')
      .values({ key, window_start: start, count: 1 })
      .onConflict((oc) => oc.columns(['key', 'window_start']).doUpdateSet({ count: sql<number>`${sql.ref('rate_limit_counters.count')} + 1` }))
      .returning('count')
      .executeTakeFirstOrThrow()
    const prev = await this.db.selectFrom('rate_limit_counters').select('count').where('key', '=', key).where('window_start', '=', start - windowMs).executeTakeFirst()
    const overlap = 1 - (nowMs - start) / windowMs
    const estimate = Number(row.count) + Number(prev?.count ?? 0) * overlap
    if (nowMs - this.lastSweep > 600_000) {
      this.lastSweep = nowMs
      await this.db.deleteFrom('rate_limit_counters').where('window_start', '<', nowMs - Math.max(2 * windowMs, 7_200_000)).execute()
    }
    if (estimate <= limit) return 0
    // Refused hits don't count against the caller.
    await this.db.updateTable('rate_limit_counters').set({ count: sql<number>`${sql.ref('count')} - 1` }).where('key', '=', key).where('window_start', '=', start).execute()
    return Math.max(1, Math.ceil((start + windowMs - nowMs) / 1000))
  }
}

export interface RateLimits {
  readsPerMinute: number
  /** The sustained cap behind the per-minute one: a busy session bursts, a scraper runs all hour. */
  readsPerHour: number
  writesPerHour: number
}

/**
 * Reads: one question in claude.ai or ChatGPT fans out to 10–20 parallel reads and an agent loops faster, so 60 a
 * minute cut real sessions off mid-answer (the benchmark's Haiku hit it inside one question). 120 a minute covers a
 * fast agent; 2400 an hour (40 a minute on average) still stops a grant from reading all day.
 */
export const DEFAULT_RATE_LIMITS: RateLimits = { readsPerMinute: 120, readsPerHour: 2400, writesPerHour: 60 }
