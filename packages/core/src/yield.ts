// Long synchronous passes over a whole ledger (parsing, filtering and building ~10k rows) held the event loop for
// hundreds of milliseconds, so cheap requests on the same machine waited behind them (f8's run P: overview finished in
// 0.1 s, clients waited 7–11 s). These let other work run between chunks.

// Taken at load: a yield is not a timer, so tests with fake timers (which replace the global) don't freeze it.
const immediate = typeof setImmediate === 'function' ? setImmediate : undefined
const timeout = setTimeout

/** Let queued I/O and timers run. */
export function yieldNow(): Promise<void> {
  return new Promise((go) => (immediate ? immediate(go) : timeout(go, 0)))
}

/** Rows handled between yields: a few milliseconds of work. */
export const YIELD_EVERY = 500

/** map() over a big list, yielding every YIELD_EVERY items; a small list is mapped at once. */
export async function mapYielding<T, U>(rows: readonly T[], fn: (row: T) => U): Promise<U[]> {
  if (rows.length <= YIELD_EVERY) return rows.map(fn)
  const out: U[] = new Array(rows.length)
  for (let i = 0; i < rows.length; i++) {
    if (i > 0 && i % YIELD_EVERY === 0) await yieldNow()
    out[i] = fn(rows[i] as T)
  }
  return out
}
