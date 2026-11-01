// The app's equity writes on a fully booted server: through S7's pipeline (idempotency, activity, review mode,
// undo) into S6's equity service, with SAFE cash landing in S1's ledger.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { boot, type Booted } from '../boot.ts'
import { createApp } from '../app.ts'
import { loadConfig } from '../config.ts'
import { ledgerFor, mcpFor } from '../modules.ts'
import { financeFor } from '../finance.ts'

const BASE = 'http://localhost:8787'
let booted: Booted
let app: ReturnType<typeof createApp>
let outbox: Array<{ to: string; text: string }>

beforeEach(async () => {
  outbox = []
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  booted = await boot({
    config,
    keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }),
    mailer: { send: async (m) => void outbox.push({ to: m.to, text: m.text }) },
    ledger: (h) => ledgerFor(h.db),
    mcp: (s) => mcpFor(s, financeFor(s)),
  })
  app = createApp(booted.services)
})
afterEach(() => booted.shutdown())

async function signIn(email: string): Promise<string> {
  await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
  const link = outbox.filter((m) => m.to === email).at(-1)!.text.match(/https?:\/\/\S+/)![0]
  const res = await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}
const req = (cookie: string, method: string, body?: unknown) => ({ method, headers: { 'content-type': 'application/json', origin: BASE, cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
const usd = (d: number) => ({ minor: d * 100, currency: 'USD' })

describe('equity writes from the app, through the pipeline', () => {
  it('records once per key, shows on the cap table, and undoes', async () => {
    const cookie = await signIn('founder@example.com')
    const { companyId } = (await (await app.request('/api/workspaces', req(cookie, 'POST', { companyName: 'Acme' }))).json()) as { companyId: string }
    const url = `/api/entities/${companyId}/equity/events`
    const body = { kind: 'safe', date: '2026-03-15', stakeholder: 'Kite Ventures', amount: usd(250_000), valuationCap: usd(8_000_000), idempotencyKey: 'eq-ui-0001' }

    const first = await app.request(url, req(cookie, 'POST', body))
    expect(first.status).toBe(201)
    const r = (await first.json()) as { status: string; recordId: string; summary: string; possibleDuplicates: string[] }
    expect(r).toMatchObject({ status: 'applied', possibleDuplicates: [] })
    expect(r.recordId).toBeTruthy()
    expect(r.summary).toMatch(/SAFE|Recorded/)

    // Same key again: not recorded twice.
    const again = (await (await app.request(url, req(cookie, 'POST', body))).json()) as { status: string }
    expect(['duplicate', 'applied']).toContain(again.status)
    const d = (await (await app.request(`/api/entities/${companyId}/equity`, { headers: { cookie } })).json()) as { convertibles: Array<{ holder: string }> }
    expect(d.convertibles.map((x) => x.holder)).toEqual(['Kite Ventures'])

    // Bad input reads as a plain sentence.
    const bad = await app.request(url, req(cookie, 'POST', { kind: 'safe', date: 'soon', stakeholder: 'X', idempotencyKey: 'eq-ui-0002' }))
    expect(bad.status).toBe(422)
    expect(((await bad.json()) as { message: string }).message).toBeTruthy()

    // Undo from the toast.
    const u = await app.request(`/api/records/${r.recordId}/undo`, req(cookie, 'POST', { idempotencyKey: 'eq-undo-0001' }))
    expect(u.status).toBeLessThan(300)
    const after = (await (await app.request(`/api/entities/${companyId}/equity`, { headers: { cookie } })).json()) as { convertibles: unknown[] }
    expect(after.convertibles).toEqual([])
  })

  it('a bank link that can’t be made records nothing (other workspace, missing row, or refused by the ledger)', async () => {
    const a = await signIn('a@example.com')
    const { companyId: acmeA } = (await (await app.request('/api/workspaces', req(a, 'POST', { companyName: 'Acme' }))).json()) as { companyId: string }
    const dep = (await (await app.request('/api/entries/cash', req(a, 'POST', { entityId: acmeA, direction: 'in', amount: usd(50_000), date: '2026-10-01', counterparty: 'Kite', paidBy: 'company', idempotencyKey: 'dep-a-0001' }))).json()) as { recordId: string }
    expect(dep.recordId).toBeTruthy()

    const b = await signIn('b@example.com')
    const { companyId: acmeB } = (await (await app.request('/api/workspaces', req(b, 'POST', { companyName: 'Beta' }))).json()) as { companyId: string }
    const safe = (key: string, bankTransactionId: string) => ({ kind: 'safe', date: '2026-10-01', stakeholder: 'Kite', amount: usd(50_000), bankTransactionId, idempotencyKey: key })
    const empty = async (cookie: string, id: string) => ((await (await app.request(`/api/entities/${id}/equity`, { headers: { cookie } })).json()) as { convertibles: unknown[] }).convertibles

    // Workspace B points at A's deposit, or at nothing: refused, and B's cap table stays empty.
    for (const [key, txn] of [['x-ws-0001', dep.recordId], ['x-ws-0002', 'no-such-row']] as const) {
      const r = await app.request(`/api/entities/${acmeB}/equity/events`, req(b, 'POST', safe(key, txn)))
      expect(r.status).toBe(422)
      expect(((await r.json()) as { message: string }).message).toMatch(/^Nothing was recorded/)
    }
    expect(await empty(b, acmeB)).toEqual([])

    // In A: the first SAFE links to the deposit. A second SAFE for the same, fully explained deposit passes the
    // up-front check but the ledger refuses the link, so the event is rolled back: never recorded without its link.
    expect((await app.request(`/api/entities/${acmeA}/equity/events`, req(a, 'POST', safe('a-safe-0001', dep.recordId)))).status).toBe(201)
    const second = await app.request(`/api/entities/${acmeA}/equity/events`, req(a, 'POST', { ...safe('a-safe-0002', dep.recordId), stakeholder: 'Other' }))
    expect(second.status).toBe(422)
    expect(((await second.json()) as { message: string }).message).toMatch(/^Nothing was recorded: that bank transaction can’t be linked/)
    expect(await empty(a, acmeA)).toHaveLength(1)
  })

  it('closing and reopening the books goes through the pipeline and can be undone', async () => {
    const cookie = await signIn('closer@example.com')
    const { companyId } = (await (await app.request('/api/workspaces', req(cookie, 'POST', { companyName: 'Acme' }))).json()) as { companyId: string }
    const url = `/api/entities/${companyId}/period`
    const detail = async () => (await (await app.request(`/api/entities/${companyId}`, { headers: { cookie } })).json()) as { periodLock: { through: string } | null; canClosePeriod: boolean }
    expect(await detail()).toMatchObject({ periodLock: null, canClosePeriod: true })
    expect((await app.request(url, req(cookie, 'POST', { action: 'close', through: '2999-01-01', idempotencyKey: 'close-0001' }))).status).toBe(400)
    const closed = await app.request(url, req(cookie, 'POST', { action: 'close', through: '2026-08-31', note: 'Q3 filed', idempotencyKey: 'close-0002' }))
    expect(closed.status).toBe(200)
    const r = (await closed.json()) as { status: string; recordId: string }
    expect(r.status).toBe('applied')
    expect((await detail()).periodLock).toMatchObject({ through: '2026-08-31' })
    expect((await app.request(`/api/records/${r.recordId}/undo`, req(cookie, 'POST', { idempotencyKey: 'close-undo-1' }))).status).toBeLessThan(300)
    expect((await detail()).periodLock).toBeNull()
    await app.request(url, req(cookie, 'POST', { action: 'close', through: '2026-07-31', idempotencyKey: 'close-0003' }))
    expect((await app.request(url, req(cookie, 'POST', { action: 'reopen', idempotencyKey: 'reopen-0001' }))).status).toBe(200)
    expect((await detail()).periodLock).toBeNull()
  })
})
