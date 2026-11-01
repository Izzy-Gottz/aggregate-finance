// Opt-in timing (AGFN_PERF_LOG=1): what a unit of work (a sync page, a whole sync) cost in the database. The pool
// counts into the scope the work runs in, through async context, so concurrent work keeps its own numbers.
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'

export interface PerfCounts {
  statements: number
  /** Time spent waiting for the database (summed over statements; overlapping ones count twice). */
  dbMs: number
  checkouts: number
  /** Extra round trips to set the RLS context on a pooled connection. */
  rlsStamps: number
  /** Time spent queued for the workspace's write lock (behind other writes), not working. */
  lockWaitMs: number
  /** Time spent waiting for a pooled connection. */
  poolWaitMs: number
}

const store = new AsyncLocalStorage<PerfCounts[]>()

export const perfEnabled = (env: Record<string, string | undefined> = process.env) => env.AGFN_PERF_LOG === '1'

/** Run `fn` in a scope of its own (nested scopes also count into the outer ones). Returns its result and counts. */
export async function withPerf<T>(fn: () => Promise<T>): Promise<{ value: T; counts: PerfCounts; ms: number; cpuMs: number }> {
  const counts: PerfCounts = { statements: 0, dbMs: 0, checkouts: 0, rlsStamps: 0, lockWaitMs: 0, poolWaitMs: 0 }
  const outer = store.getStore() ?? []
  const t0 = performance.now()
  const cpu0 = process.cpuUsage()
  const value = await store.run([...outer, counts], fn)
  const cpu = process.cpuUsage(cpu0)
  return { value, counts, ms: performance.now() - t0, cpuMs: (cpu.user + cpu.system) / 1000 }
}

/**
 * Run `fn` outside every current scope, counted in a scope of its own: for work a unit of work starts but doesn't
 * wait for (a timer it schedules inherits its async context and would otherwise count into it).
 */
export function withPerfDetached<T>(fn: () => Promise<T>): Promise<{ value: T; counts: PerfCounts; ms: number; cpuMs: number }> {
  return store.exit(() => withPerf(fn))
}

export function perfCount(kind: 'statement' | 'checkout' | 'rlsStamp' | 'lockWait' | 'poolWait', ms = 0): void {
  const scopes = store.getStore()
  if (!scopes) return
  for (const c of scopes) {
    if (kind === 'statement') {
      c.statements++
      c.dbMs += ms
    } else if (kind === 'lockWait') c.lockWaitMs += ms
    else if (kind === 'poolWait') c.poolWaitMs += ms
    else if (kind === 'checkout') c.checkouts++
    else c.rlsStamps++
  }
}

/**
 * One log line: "events 412, 1,234 statements, db 2,800 ms, wall 4,000 ms, other 1,200 ms, lock wait 300 ms,
 * process cpu 700 ms, …". `other` is wall − db; process cpu is the whole process over the same span (concurrent
 * syncs included), so cpu near wall means the machine is busy, and lock wait is time queued behind other writes.
 */
export function perfLine(r: { counts: PerfCounts; ms: number; cpuMs?: number }, extra: Record<string, number | string> = {}): string {
  const c = r.counts
  const parts = Object.entries(extra).map(([k, v]) => `${k} ${v}`)
  parts.push(`${c.statements} statements`, `db ${Math.round(c.dbMs)} ms`, `wall ${Math.round(r.ms)} ms`, `other ${Math.max(0, Math.round(r.ms - c.dbMs))} ms`, `lock wait ${Math.round(c.lockWaitMs)} ms`, `pool wait ${Math.round(c.poolWaitMs)} ms`, ...(r.cpuMs !== undefined ? [`process cpu ${Math.round(r.cpuMs)} ms`] : []), `${c.checkouts} checkouts`, `${c.rlsStamps} RLS stamps`)
  return parts.join(', ')
}

let slowLogged = 0
const slowShapes = new Set<string>()

/**
 * A statement slower than AGFN_PERF_SLOW_MS (default 250) is logged with its SQL text, never its parameters. The time
 * includes waiting behind earlier statements on the same connection and for row locks, which is often the point.
 */
function noteSlow(sqlArg: unknown, ms: number, rows: number | undefined): { hash: string; text: string } | null {
  const limit = Number(process.env.AGFN_PERF_SLOW_MS ?? 250)
  if (!(ms >= limit) || slowLogged >= 500) return null
  slowLogged++
  const text = (typeof sqlArg === 'string' ? sqlArg : typeof (sqlArg as { text?: unknown })?.text === 'string' ? (sqlArg as { text: string }).text : '?').replace(/\s+/g, ' ')
  // The full text once per statement shape, under a short hash; later ones by hash only.
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 8)
  const first = !slowShapes.has(hash)
  slowShapes.add(hash)
  console.info(`[agfn] perf slow statement ${Math.round(ms)} ms${rows !== undefined ? `, ${rows} rows` : ''} [${hash}]${first ? `: ${text.slice(0, 4_000)}` : ''}`)
  return first && /^\s*(select|with)\b/i.test(text) ? { hash, text } : null
}

/**
 * The plan the server chose for a slow read, right after it ran (the first time per shape): same SQL and parameters,
 * so the same plan, as one line of JSON. Quoted literals are blanked out of the logged plan.
 */
async function logPlan(query: (...a: unknown[]) => Promise<unknown>, slow: { hash: string; text: string }, params: unknown): Promise<void> {
  try {
    // One line (JSON) so a log search for the prefix finds the whole plan.
    const res = (await query(`EXPLAIN (FORMAT JSON) ${slow.text}`, params)) as { rows?: Array<Record<string, unknown>> }
    const raw = (res.rows ?? []).map((r) => Object.values(r)[0])
    const plan = JSON.stringify(raw.length === 1 ? raw[0] : raw).replace(/'(?:[^']|'')*'/g, "'?'")
    console.info(`[agfn] perf slow plan [${slow.hash}]: ${plan.slice(0, 16_000)}`)
  } catch {
    // A plan is a nice-to-have; never let it break the work.
  }
}

/** Wrap a pg-style pool so checkouts and statements are counted (only used when AGFN_PERF_LOG=1). */
export function perfPool<P extends { connect(): Promise<any> }>(pool: P): P {
  const wrapped = Object.create(pool) as P
  wrapped.connect = async () => {
    perfCount('checkout')
    const t0 = performance.now()
    const client = await pool.connect()
    perfCount('poolWait', performance.now() - t0)
    if (!(client as { __perf?: boolean }).__perf) {
      const query = client.query.bind(client)
      client.query = async (...a: unknown[]) => {
        const t = performance.now()
        let rows: number | undefined
        let ok = false
        let res: unknown
        try {
          res = await query(...a)
          ok = true
          rows = (res as { rows?: unknown[] } | undefined)?.rows?.length
        } finally {
          const ms = performance.now() - t
          perfCount('statement', ms)
          const slow = noteSlow(a[0], ms, rows)
          if (slow && ok) await logPlan(query, slow, typeof a[0] === 'string' ? a[1] : (a[0] as { values?: unknown }).values)
        }
        return res
      }
      ;(client as { __perf?: boolean }).__perf = true
    }
    return client
  }
  return wrapped
}
