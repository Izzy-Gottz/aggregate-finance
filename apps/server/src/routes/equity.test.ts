// Equity routes on SQLite with a fake ledger and fake permissions: view/add checks, record, import, export, and
// "Undo" in the app reaching the equity writer through the composed finance writer.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { connect, migrateToLatest, newId, nowIso, type CoreTables, type DbHandle } from '@agfn/db'
import type { EquityTables } from '@agfn/equity'
import type { Services } from '../services.ts'
import type { RequestPerson } from '../app.ts'
import { equityRoutes } from './equity.ts'
import { equityPartFor } from '../equity.ts'
import { composeFinance } from '../finance.ts'

type T = CoreTables & EquityTables
let h: DbHandle<T>
let ws: string
let acme: string
let hidden: string
let canAdd: boolean
let posted: Array<{ kind: string; amount?: { minor: number } }>
let s: Pick<Services, 'db' | 'ledger' | 'permissions'>
let app: Hono<{ Variables: { person: RequestPerson } }>

beforeEach(async () => {
  h = connect<T>('sqlite::memory:')
  await migrateToLatest(h.db)
  ws = newId()
  acme = newId()
  hidden = newId()
  await h.db.insertInto('workspaces').values({ id: ws, name: 'W', base_currency: 'USD', created_at: nowIso() }).execute()
  for (const id of [acme, hidden])
    await h.db.insertInto('entities').values({ id, workspace_id: ws, kind: 'company', name: id === acme ? 'Acme' : 'Other', base_currency: 'USD', owner_person_id: null, parent_entity_id: null, fiscal_year_start_month: 1, created_at: nowIso(), archived_at: null }).execute()
  canAdd = true
  posted = []
  const ledger = { post: async (_ws: string, ev: { kind: string; amount?: { minor: number } }) => (posted.push(ev), { journalEntryId: 'je' }) }
  const permissions = {
    entitiesFor: async () => [{ id: acme, name: 'Acme', kind: 'company' as const }],
    can: async (_a: unknown, action: string) => action === 'view' || canAdd,
    canManageWorkspace: async () => false,
  }
  s = { db: h.db, ledger, permissions } as unknown as typeof s
  const person: RequestPerson = { personId: 'p1', name: 'Yisrael', email: 'y@example.test', sessionId: 's1', workspaceId: ws }
  app = new Hono()
  app.onError((err) => (err instanceof HTTPException ? err.getResponse() : new Response(String(err), { status: 500 })))
  app.use('/api/*', async (c, next) => {
    c.set('person', person)
    await next()
  })
  app.route('/api', equityRoutes(s))
})
afterEach(() => h.close())

const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const usd = (d: number) => ({ minor: d * 100, currency: 'USD' })

describe('equity routes', () => {
  it('records events, shows the cap table, exports OCF and imports it back', async () => {
    const empty = (await (await app.request(`/api/entities/${acme}/equity`)).json()) as { fullyDiluted: { total: number } }
    expect(empty.fullyDiluted.total).toBe(0)
    let r = await app.request(`/api/entities/${acme}/equity/events`, post({ kind: 'issuance', date: '2025-01-02', stakeholder: 'Ada', shares: 8_000_000, idempotencyKey: 'k1' }))
    expect(r.status).toBe(201)
    r = await app.request(`/api/entities/${acme}/equity/events`, post({ kind: 'safe', date: '2025-03-15', stakeholder: 'Kite', amount: usd(250_000), valuationCap: usd(8_000_000), idempotencyKey: 'k2' }))
    const safe = (await r.json()) as { recordId: string; summary: string }
    expect(safe.summary).toBe('Recorded a $250,000 SAFE from Kite at a $8,000,000 cap.')
    expect(posted.map((p) => p.kind)).toEqual(['safe']) // a no-price issuance moves no cash

    const d = (await (await app.request(`/api/entities/${acme}/equity`)).json()) as { holders: Array<{ name: string }>; convertibles: unknown[] }
    expect(d.holders.map((x) => x.name)).toEqual(['Ada'])
    expect(d.convertibles).toHaveLength(1)

    const ocf = await app.request(`/api/entities/${acme}/equity/ocf`)
    expect(ocf.headers.get('content-disposition')).toMatch(/attachment/)
    const files = await ocf.text()

    // Import the export into a fresh company.
    await h.db.deleteFrom('equity_objects').execute()
    const fd = new FormData()
    fd.set('file', new File([files], 'cap.json', { type: 'application/json' }))
    const imp = await app.request(`/api/entities/${acme}/equity/import`, { method: 'POST', body: fd })
    expect(imp.status).toBe(201)
    const again = (await (await app.request(`/api/entities/${acme}/equity`)).json()) as { holders: Array<{ name: string }>; convertibles: unknown[] }
    expect(again.holders.map((x) => x.name)).toEqual(['Ada'])
    expect(again.convertibles).toHaveLength(1)
  })

  it('records a warrant and RSUs through the same route (grantType)', async () => {
    let r = await app.request(`/api/entities/${acme}/equity/events`, post({ kind: 'issuance', date: '2025-01-02', stakeholder: 'Ada', shares: 1_000_000, idempotencyKey: 'w0' }))
    r = await app.request(`/api/entities/${acme}/equity/events`, post({ kind: 'option_grant', grantType: 'warrant', date: '2025-06-01', stakeholder: 'Harbor Bank', shares: 50_000, pricePerShare: usd(0.5), expirationDate: '2032-06-01', idempotencyKey: 'w1' }))
    expect(r.status).toBe(201)
    expect(((await r.json()) as { summary: string }).summary).toBe('Issued a warrant to Harbor Bank for 50,000 Common shares at $0.50, expiring Jun 1, 2032.')
    r = await app.request(`/api/entities/${acme}/equity/events`, post({ kind: 'option_grant', grantType: 'rsu', date: '2025-06-01', stakeholder: 'Rui', shares: 12_000, idempotencyKey: 'w2' }))
    expect(r.status).toBe(201)
    const d = (await (await app.request(`/api/entities/${acme}/equity`)).json()) as { fullyDiluted: { warrants: number; rsus: number }; warrants: Array<{ holder: string }>; home: { currency: string } }
    expect(d.fullyDiluted).toMatchObject({ warrants: 50_000, rsus: 12_000 })
    expect(d.warrants.map((w) => w.holder)).toEqual(['Harbor Bank'])
    expect(d.home.currency).toBe('USD')
  })

  it('rejects bad input in plain words, hides other companies and refuses changes without add', async () => {
    const bad = await app.request(`/api/entities/${acme}/equity/events`, post({ kind: 'safe', date: 'soon', stakeholder: 'Kite', idempotencyKey: 'k' }))
    expect(bad.status).toBe(422)
    expect(((await bad.json()) as { message: string }).message).toBe('The date must look like 2026-10-09.')
    expect((await app.request(`/api/entities/${hidden}/equity`)).status).toBe(404)
    const junk = new FormData()
    junk.set('file', new File(['{oops'], 'cap.json'))
    expect((await app.request(`/api/entities/${acme}/equity/import`, { method: 'POST', body: junk })).status).toBe(400)
    // A damaged .xlsx and an old .xls are refused in plain words, never parsed as CSV.
    for (const [bytes, name, says] of [[new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), 'cap.xlsx', /readable \.xlsx/], [new TextEncoder().encode('ÐÏ\u0011'), 'cap.xls', /Old \.xls files/]] as const) {
      const fd = new FormData()
      fd.set('file', new File([bytes], name))
      const r = await app.request(`/api/entities/${acme}/equity/import`, { method: 'POST', body: fd })
      expect(r.status).toBe(422)
      expect(((await r.json()) as { message: string }).message).toMatch(says)
    }
    canAdd = false
    expect((await app.request(`/api/entities/${acme}/equity`)).status).toBe(200)
    expect((await app.request(`/api/entities/${acme}/equity/events`, post({ kind: 'issuance', date: '2025-01-02', stakeholder: 'Ada', shares: 1, idempotencyKey: 'k3' }))).status).toBe(403)
  })

  it('"Undo" in the app (void_record on the composed writer) reverts an equity write', async () => {
    const r = await app.request(`/api/entities/${acme}/equity/events`, post({ kind: 'safe', date: '2025-03-15', stakeholder: 'Kite', amount: usd(50_000), idempotencyKey: 'k4' }))
    const { recordId } = (await r.json()) as { recordId: string }
    const { writer, reader } = composeFinance({ entities: async () => [], equity: equityPartFor(s) })
    expect(await reader.getRecord(ws, recordId)).not.toBeNull()
    const prov = { writeRequestId: 'w', actorKind: 'person' as const, personId: 'p1', label: 'Yisrael' }
    const done = await writer.apply({ op: 'void_record', workspaceId: ws, entityId: acme, payload: { recordId, reason: 'undone in the app' } }, prov)
    expect(done.summary).toBe('Undid the cap table change.')
    expect(posted.at(-1)).toMatchObject({ kind: 'safe', amount: { minor: 0 } })
    const d = (await (await app.request(`/api/entities/${acme}/equity`)).json()) as { convertibles: unknown[] }
    expect(d.convertibles).toEqual([])
  })
})
