// A ledger transaction holds one pool connection for its whole run. Any other checkout made while it is open (a query
// on the pool instead of the transaction, a withBypass read, another scope's transaction) needs a second connection,
// and with a small pool (staging 3) several such transactions take every connection and then wait for one more: the
// 175 s stall of 2026-10-13. This marks the async context of an open transaction so such checkouts are seen.
//
// AGFN_NESTED_CHECKOUT: 'throw' (tests: fail at the offending call), 'log' (default: one warning per call site), 'off'.

import { AsyncLocalStorage } from 'node:async_hooks'

const held = new AsyncLocalStorage<true>()
const warned = new Set<string>()

/** Run fn as the body of a transaction that holds a connection: checkouts inside it are nested. */
export function holdingConnection<T>(fn: () => T): T {
  return held.run(true, fn)
}

/** Work inside a transaction that deliberately runs on its own connection (and is allowed to): not counted as nested. */
export function outsideHeldConnection<T>(fn: () => T): T {
  return held.exit(fn)
}

export class NestedCheckoutError extends Error {}

/** Called on every pool checkout. */
export function noteCheckout(): void {
  if (!held.getStore()) return
  const mode = process.env.AGFN_NESTED_CHECKOUT ?? 'log'
  if (mode === 'off') return
  const stack = (new Error().stack ?? '').split('\n').slice(2).filter((l) => !l.includes('node_modules') && !l.includes('node:internal')).slice(0, 8).map((l) => l.trim()).join(' < ')
  if (mode === 'throw') throw new NestedCheckoutError(`pool checkout while a ledger transaction holds a connection: ${stack}`)
  if (warned.has(stack)) return
  warned.add(stack)
  console.warn(`[agfn] pool checkout while a ledger transaction holds a connection (needs a second connection): ${stack}`)
}

/** Wrap a pg-style pool so each checkout is checked. */
export function heldCheckPool<P extends { connect(): Promise<any> }>(pool: P): P {
  const wrapped = Object.create(pool) as P
  wrapped.connect = async () => {
    noteCheckout()
    return pool.connect()
  }
  return wrapped
}
