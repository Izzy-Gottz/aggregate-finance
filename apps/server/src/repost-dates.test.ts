import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Ledger } from '@agfn/contracts'
import { connect, migrateToLatest, newId, nowIso, type CoreTables, type DbHandle } from '@agfn/db'
import { runRepostDates } from './repost-dates.ts'

let h: DbHandle<CoreTables>
beforeEach(async () => {
  h = connect<CoreTables>('sqlite::memory:')
  await migrateToLatest(h.db)
})
afterEach(() => h.close())

const addConn = async (connectorKey: string, workspaceId: string, id = newId()) => {
  await h.db
    .insertInto('workspaces')
    .values({ id: workspaceId, name: 'W', base_currency: 'USD', created_at: nowIso() })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute()
  await h.db
    .insertInto('connections')
    .values({ id, workspace_id: workspaceId, connector_key: connectorKey, entity_id: null, display_name: connectorKey, status: 'active', secret_enc: null, config_json: '{}', cursor: null, last_sync_at: null, last_success_at: null, last_error: null, created_by: null, created_at: nowIso() })
    .execute()
  return id
}

/** A ledger whose repostToRules reports `perConnection` changes for every connection it is handed. */
const fakeLedger = (perConnection: number, seen: string[][] = []): Pick<Ledger, 'repostToRules'> => ({
  repostToRules: async (_ws, o) => {
    seen.push(o.connectionIds)
    return Object.fromEntries(o.connectionIds.map((id) => [id, perConnection]))
  },
})

describe('runRepostDates', () => {
  it('scans the at-bearing connectors, dispatches per workspace, and tallies by connector', async () => {
    const wsA = newId()
    const wsB = newId()
    await addConn('deel', wsA)
    await addConn('stripe', wsA)
    await addConn('deel', wsB)
    await addConn('plaid', wsA) // not at-bearing — must be ignored
    const seen: string[][] = []
    const r = await runRepostDates(h.db, fakeLedger(2, seen), { dryRun: true })
    expect(r.connectionsInScope).toBe(3) // plaid excluded
    expect(r.workspaces).toBe(2)
    expect(r.total).toBe(6) // 3 connections × 2
    expect(r.byConnector).toEqual({ deel: 4, stripe: 2 })
    expect(seen.length).toBe(2) // one dispatch per workspace
  })

  it('scopes to one connection when asked', async () => {
    const ws = newId()
    const deel = await addConn('deel', ws)
    await addConn('stripe', ws)
    const r = await runRepostDates(h.db, fakeLedger(1), { dryRun: false, connectionId: deel })
    expect(r.connectionsInScope).toBe(1)
    expect(r.byConnector).toEqual({ deel: 1 })
  })

  it('THROWS rather than report a false 0 when no connections are in scope (RLS/scope guard)', async () => {
    // No at-bearing connections at all — the real RLS failure mode looks identical to this.
    await addConn('plaid', newId())
    await expect(runRepostDates(h.db, fakeLedger(0), { dryRun: true })).rejects.toThrow(/found no connections/i)
  })

  it('THROWS when a named connection is not found (not a silent 0)', async () => {
    await addConn('deel', newId())
    await expect(runRepostDates(h.db, fakeLedger(0), { dryRun: true, connectionId: 'does-not-exist' })).rejects.toThrow(/found no connections/i)
  })

  it('reports a legitimate 0 (connections exist, nothing to re-date) without throwing', async () => {
    const ws = newId()
    await addConn('deel', ws)
    const r = await runRepostDates(h.db, fakeLedger(0), { dryRun: false })
    expect(r.connectionsInScope).toBe(1)
    expect(r.total).toBe(0)
    expect(r.byConnector).toEqual({})
  })
})
