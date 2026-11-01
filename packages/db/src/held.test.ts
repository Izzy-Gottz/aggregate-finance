import { afterEach, describe, expect, it, vi } from 'vitest'
import { heldCheckPool, holdingConnection, NestedCheckoutError, outsideHeldConnection } from './held.ts'

const pool = () => heldCheckPool({ connect: async () => ({ release() {} }) })

describe('pool checkouts while a ledger transaction holds a connection', () => {
  const env = process.env.AGFN_NESTED_CHECKOUT
  afterEach(() => {
    if (env === undefined) delete process.env.AGFN_NESTED_CHECKOUT
    else process.env.AGFN_NESTED_CHECKOUT = env
    vi.restoreAllMocks()
  })

  it('are refused under throw, warned once per call site under log, and fine outside one', async () => {
    const p = pool()
    process.env.AGFN_NESTED_CHECKOUT = 'throw'
    await expect(p.connect()).resolves.toBeTruthy()
    await expect(holdingConnection(() => p.connect())).rejects.toBeInstanceOf(NestedCheckoutError)
    await expect(holdingConnection(() => outsideHeldConnection(() => p.connect()))).resolves.toBeTruthy()
    // Carried through awaits and timers started inside it.
    await expect(holdingConnection(async () => (await new Promise((r) => setTimeout(r, 1)), p.connect()))).rejects.toBeInstanceOf(NestedCheckoutError)

    process.env.AGFN_NESTED_CHECKOUT = 'log'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const twice = () => holdingConnection(() => p.connect())
    for (let i = 0; i < 3; i++) await twice()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toMatch(/pool checkout while a ledger transaction holds a connection/)
  })
})
