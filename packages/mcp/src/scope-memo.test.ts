// One tool call reads the entities and the person's permission rows once, however many scopes it resolves (get_overview
// resolves five); the next call reads them again, so a role change or a revoke applies from the very next call.
import { describe, expect, it } from 'vitest'
import type { Can } from '@agfn/contracts'
import type { Grant } from './grants.ts'
import type { FinanceReader, PeopleDirectory } from './ports.ts'
import { Access, type Principal } from './scope.ts'

const NOW = new Date('2026-10-12T12:00:00.000Z')
const grant: Grant = {
  id: 'g1', workspaceId: 'w', personId: 'p', kind: 'oauth', clientId: 'c', clientName: 'Claude', entityIds: 'all',
  dataTypes: ['balances', 'transactions', 'invoices', 'bills', 'payroll'], write: false, reviewMode: 'instant', dailyWriteCap: 200,
  expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(), createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), revokedAt: null, lastUsedAt: null, pausedAt: null,
} as Grant

function setup() {
  const n = { entities: 0, checkers: 0, checks: 0 }
  const state = { allowed: true }
  const reader = { entities: async () => (n.entities++, [{ id: 'e_a', name: 'Acme', kind: 'company', currency: 'USD' }, { id: 'e_b', name: 'Bluebird', kind: 'company', currency: 'USD' }]) } as unknown as FinanceReader
  const can: Can = async () => (n.checks++, state.allowed)
  const people = { can, forCall: () => (n.checkers++, can) } as unknown as PeopleDirectory
  const access = new Access(reader, people, { now: () => NOW } as never)
  // What callToolIn does on every call: a fresh principal object.
  const call = (): Principal => ({ workspaceId: 'w', personId: 'p', grant, via: 'oauth', label: 'Claude', scopes: [] })
  return { n, state, access, call }
}

describe('Access within one tool call', () => {
  it('reads entities and makes one checker per call, and each scope once', async () => {
    const { n, access, call } = setup()
    const p = call()
    for (const t of ['balances', 'invoices', 'bills', 'payroll', 'transactions', 'balances'] as const) await access.entities(p, 'view', t)
    expect(n).toEqual({ entities: 1, checkers: 1, checks: 10 })
  })

  it('two tool calls share nothing: a permission taken away applies from the next call', async () => {
    const { n, state, access, call } = setup()
    expect((await access.entities(call(), 'view', 'balances')).map((e) => e.id)).toEqual(['e_a', 'e_b'])
    state.allowed = false
    expect(await access.entities(call(), 'view', 'balances')).toEqual([])
    expect([n.entities, n.checkers]).toEqual([2, 2])
  })

  it('a caller changing the list it got does not change what the call answers next', async () => {
    const { access, call } = setup()
    const p = call()
    ;(await access.entities(p, 'view', 'balances')).pop()
    expect(await access.entities(p, 'view', 'balances')).toHaveLength(2)
  })
})

describe('the public demo cache key', () => {
  it('is the same for the same arguments in any order, and differs for different ones', async () => {
    const { canonicalJson } = await import('./service.ts')
    expect(canonicalJson({ company: 'A', filter: { to: 2, from: 1 } })).toBe(canonicalJson({ filter: { from: 1, to: 2 }, company: 'A' }))
    expect(canonicalJson({ company: 'A', x: undefined })).toBe(canonicalJson({ company: 'A' }))
    expect(canonicalJson({ company: 'A' })).not.toBe(canonicalJson({ company: 'B' }))
    expect(canonicalJson({ ids: [1, 2] })).not.toBe(canonicalJson({ ids: [2, 1] }))
  })
})
