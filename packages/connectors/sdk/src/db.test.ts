import { afterEach, describe, expect, it } from 'vitest'
import { connect, migrateToLatest, newId, nowIso, type CoreTables, type DbHandle } from '@agfn/db'
import { findImportMapping, recordWebhookReceipt, saveImportMapping, type ConnectorTables } from './db.ts'

let h: DbHandle<CoreTables & ConnectorTables> | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

async function setup() {
  h = connect<CoreTables & ConnectorTables>('sqlite::memory:')
  const res = await migrateToLatest(h.db)
  expect(res.results?.find((r) => r.migrationName === '0200_connectors')?.status).toBe('Success')
  const ws = newId()
  await h.db.insertInto('workspaces').values({ id: ws, name: 'T', base_currency: 'USD', created_at: nowIso() }).execute()
  return { db: h.db, ws }
}

describe('migration 0200', () => {
  it('dedupes webhook receipts', async () => {
    const { db } = await setup()
    const r = { provider: 'plaid', dedupeKey: 'k1', action: 'sync', match: { field: 'itemId', value: 'i1' }, at: nowIso() }
    expect(await recordWebhookReceipt(db, { ...r, id: newId() })).toBe('new')
    expect(await recordWebhookReceipt(db, { ...r, id: newId() })).toBe('duplicate')
    expect(await recordWebhookReceipt(db, { ...r, id: newId(), provider: 'stripe' })).toBe('new')
  })

  it('saves and replaces import mappings by header signature', async () => {
    const { db, ws } = await setup()
    await saveImportMapping(db, { id: newId(), workspaceId: ws, name: 'Chase CSV', format: 'csv', headerSignature: 'sig', mapping: { date: 0 }, at: nowIso() })
    await saveImportMapping(db, { id: newId(), workspaceId: ws, name: 'Chase CSV v2', format: 'csv', headerSignature: 'sig', mapping: { date: 1 }, at: nowIso() })
    expect(await findImportMapping(db, ws, 'sig')).toMatchObject({ name: 'Chase CSV v2', mapping: { date: 1 } })
    expect(await findImportMapping(db, ws, 'other')).toBeUndefined()
  })
})
