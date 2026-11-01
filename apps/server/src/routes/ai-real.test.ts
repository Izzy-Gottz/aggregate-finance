// S7 UI routes and MCP writes against the real ledger (S1 via financeFor), not the demo books.

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
const ai = (key: string, method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })

describe('S7 with the real ledger', () => {
  it('a bucket with money, number and date fields, typed as the screen sends them (43: "Add a stake")', async () => {
    const cookie = await signIn('investor@example.com')
    const { personalId } = (await (await app.request('/api/workspaces', req(cookie, 'POST', {}))).json()) as { personalId: string }
    const fields = [
      { key: 'company', label: 'Company', type: 'text', value: 'Lumen Health' },
      { key: 'amount', label: 'Amount', type: 'money', value: '$25,000' },
      { key: 'shares', label: 'Shares', type: 'number', value: '1,200' },
      { key: 'date', label: 'Date', type: 'date', value: '2026-03-01' },
    ]
    const r = await app.request('/api/buckets', req(cookie, 'POST', { entityId: personalId, name: 'Stake in Lumen Health', fields, idempotencyKey: 'stake-real-0001' }))
    expect(r.status).toBe(201)
    const b = (await r.json()) as { fields: Array<{ key: string; value: string }> }
    expect(b.fields.map((f) => f.value)).toEqual(['Lumen Health', '$25,000.00', '1200', '2026-03-01'])
    const bad = await app.request('/api/buckets', req(cookie, 'POST', { entityId: personalId, name: 'Bad', fields: [{ ...fields[1], value: 'lots' }], idempotencyKey: 'stake-real-0002' }))
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { message: string }).message).toBe('Amount: that amount isn’t a number.')
  })

  it('AI writes, activity, review, cash entries and undo', async () => {
    const cookie = await signIn('founder@example.com')
    const { companyId } = (await (await app.request('/api/workspaces', req(cookie, 'POST', { companyName: 'Acme' }))).json()) as { companyId: string }
    const shape = { entityIds: 'all', dataTypes: ['balances', 'transactions', 'invoices', 'bills', 'documents', 'reports'], write: true, reviewMode: 'instant', expiresAt: '2027-01-01T00:00:00.000Z' }
    const created = await app.request('/api/ai/keys', req(cookie, 'POST', { name: 'Script', shape }))
    expect(created.status).toBe(201)
    const { grantId, key } = (await created.json()) as { grantId: string; key: string }

    // An AI records cash it was told about, over REST (same pipeline as MCP).
    const w = await ai(key, 'POST', '/v1/entries', { company: 'Acme', kind: 'cash_income', amount: { amount: '500.00', currency: 'USD' }, date: '2026-10-09', paid_by: 'Acme', counterparty: 'Walk-in', idempotency_key: 'real-ledger-0001' })
    expect(w.status).toBe(201)
    const wr = (await w.json()) as { status: string; record_id: string }
    expect(wr.status).toBe('applied')
    const cash = (await (await ai(key, 'GET', '/v1/metrics/cash?company=Acme')).json()) as { value: { amount: string } | null; agent_entries_included: number }
    expect(cash.value?.amount).toBe('500.00')

    const detail = (await (await app.request(`/api/ai/${grantId}`, { headers: { cookie } })).json()) as { activity: Array<{ kind: string; summary: string; status?: string }> }
    expect(detail.activity.find((a) => a.kind === 'write')).toMatchObject({ summary: 'added cash received of $500.00 to Acme (Walk-in)', status: 'applied' })

    // Review mode on: the next AI write waits, then the owner applies it with a correction.
    await app.request(`/api/ai/${grantId}`, req(cookie, 'PATCH', { shape: { ...shape, reviewMode: 'review_all' } }))
    const held = await ai(key, 'POST', '/v1/entries', { company: 'Acme', kind: 'expense', amount: { amount: '80.00', currency: 'USD' }, date: '2026-10-09', paid_by: 'Acme', counterparty: 'Staples', idempotency_key: 'real-ledger-0002' })
    expect(held.status).toBe(202)
    const review = (await (await app.request('/api/review', { headers: { cookie } })).json()) as Array<{ id: string; kind: string }>
    const item = review.find((r) => r.kind === 'ai_write')!
    expect((await app.request(`/api/review/${encodeURIComponent(item.id)}`, req(cookie, 'POST', { action: 'edit', values: { amount: '84.20' } }))).status).toBe(200)
    const after = (await (await ai(key, 'GET', '/v1/metrics/cash?company=Acme')).json()) as { value: { amount: string } }
    expect(after.value.amount).toBe('415.80')

    // The owner adds cash by hand and undoes the AI's first entry.
    const hand = await app.request('/api/entries/cash', req(cookie, 'POST', { entityId: companyId, direction: 'in', amount: { minor: 10_000, currency: 'USD' }, date: '2026-10-09', counterparty: 'Market', paidBy: 'company', idempotencyKey: 'hand-cash-0001' }))
    expect(hand.status).toBe(201)
    expect((await app.request(`/api/records/${wr.record_id}/undo`, req(cookie, 'POST', { idempotencyKey: 'undo-0001' }))).status).toBe(200)
    // Undone already: a plain "nothing to undo" answer, never a 500 (43).
    const again = await app.request(`/api/records/${wr.record_id}/undo`, req(cookie, 'POST', { idempotencyKey: 'undo-0002' }))
    expect(again.status, await again.clone().text()).toBeLessThan(500)
    const final = (await (await ai(key, 'GET', '/v1/metrics/cash?company=Acme')).json()) as { value: { amount: string } }
    expect(final.value.amount).toBe('15.80')

    const ws = (await (await app.request('/api/workspace', { headers: { cookie } })).json()) as { ais: unknown[]; reviewModeOn: boolean; reviewCount: number }
    expect(ws).toMatchObject({ reviewModeOn: true })
    expect(ws.ais).toHaveLength(1)
  })
})
