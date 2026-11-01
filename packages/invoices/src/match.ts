// One payment covering several invoices or bills: an exact subset-sum over open documents, preferring the oldest
// (capped at 12 candidates). Matching payments to invoices is core's invoice pass (packages/core/src/matching.ts);
// this is the subset search it and payroll detection share.
import type { Money } from '@agfn/contracts'
import type { InvoiceView } from './subledger.ts'

const MAX_SUBSET_CANDIDATES = 12

/**
 * Exact subset-sum, preferring the oldest documents: among all subsets whose remaining amounts sum to the
 * target, return the one whose sorted index list is lexicographically smallest. n <= 12, so 4096 subsets max.
 */
export function oldestExactSubset(pool: Array<Pick<InvoiceView, 'remaining'>>, target: Money): number[] | null {
  const n = Math.min(pool.length, MAX_SUBSET_CANDIDATES)
  let best: number[] | null = null
  for (let mask = 1; mask < 1 << n; mask++) {
    let total = 0
    const idx: number[] = []
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        total += (pool[i] as { remaining: Money }).remaining.minor
        idx.push(i)
      }
    }
    if (total !== target.minor) continue
    if (!best || lexLess(idx, best)) best = idx
  }
  return best
}

function lexLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return (a[i] as number) < (b[i] as number)
  }
  return a.length < b.length
}
