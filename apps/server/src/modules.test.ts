import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connect, migrateToLatest, newId, nowIso, type CoreTables, type DbHandle } from '@agfn/db'
import { ledgerFor } from './modules.ts'

let h: DbHandle<CoreTables>
beforeEach(async () => {
  h = connect<CoreTables>('sqlite::memory:')
  await migrateToLatest(h.db)
})
afterEach(() => h.close())

describe('ledgerFor', () => {
  it('registers the cap table as the fully_diluted metric', async () => {
    const ws = newId()
    await h.db.insertInto('workspaces').values({ id: ws, name: 'W', base_currency: 'USD', created_at: nowIso() }).execute()
    const engine = ledgerFor(h.db)
    const provider = engine.metricProviders.get('fully_diluted')
    expect(provider).toBeTypeOf('function')
    const answer = await provider!({ workspaceId: ws, entityIds: 'all' } as never, {} as never)
    expect(answer).toMatchObject({ name: 'fully_diluted', state: 'no_data', value: null })
  })
})
