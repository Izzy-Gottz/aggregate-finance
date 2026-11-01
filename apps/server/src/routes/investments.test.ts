// The Investments page's routes on a fully booted server: behind AGFN_INVESTMENTS (not the MCP tool's flag), through S7's pipeline
// (idempotency, activity, undo) into core's investment.event, read back through FinanceReader.investments.
import { afterEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { boot, type Booted } from '../boot.ts'
import { createApp, type RequestPerson } from '../app.ts'
import { loadConfig } from '../config.ts'
import { ledgerFor, mcpFor } from '../modules.ts'
import { financeFor } from '../finance.ts'
import { investmentRoutes } from './investments.ts'

const BASE = 'http://localhost:8787'
let booted: Booted | undefined
type App = ReturnType<typeof createApp>
let outbox: Array<{ to: string; text: string }>

async function start(flag: boolean, env: Record<string, string> = {}) {
  outbox = []
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent', ...(flag ? { AGFN_INVESTMENTS: '1' } : {}), ...env }), runWorker: false }
  booted = await boot({
    config,
    keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }),
    mailer: { send: async (m) => void outbox.push({ to: m.to, text: m.text }) },
    ledger: (h) => ledgerFor(h.db),
    mcp: (s) => mcpFor(s, financeFor(s)),
  })
  return createApp(booted.services)
}
afterEach(async () => {
  await booted?.shutdown()
  booted = undefined
})

async function signIn(app: App, email: string): Promise<string> {
  await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
  const link = outbox.filter((m) => m.to === email).at(-1)!.text.match(/https?:\/\/\S+/)![0]
  const res = await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}
const req = (cookie: string, method: string, body?: unknown) => ({ method, headers: { 'content-type': 'application/json', origin: BASE, cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
const usd = (d: number) => ({ minor: d * 100, currency: 'USD' })
type Position = { positionId: string; issuer: string; securityType: string; series?: string; shares?: number; invested: { minor: number }; value: { minor: number }; valueSource: string; status: string }

async function company(app: App) {
  const cookie = await signIn(app, 'founder@example.com')
  const { companyId } = (await (await app.request('/api/workspaces', req(cookie, 'POST', { companyName: 'Acme' }))).json()) as { companyId: string }
  const url = `/api/entities/${companyId}/investments`
  const positions = async (asOf?: string) => ((await (await app.request(url + (asOf ? `?asOf=${asOf}` : ''), { headers: { cookie } })).json()) as { positions: Position[] }).positions
  return { cookie, companyId, url, positions }
}

describe('investments routes', () => {
  it('off by default, and the MCP tool’s flag alone doesn’t turn it on: the paths 404, /api/me doesn’t offer the page', async () => {
    const app = await start(false, { AGFN_TOOL_INVESTMENTS: '1' })
    const { cookie, url } = await company(app)
    expect((await app.request(url, { headers: { cookie } })).status).toBe(404)
    expect((await app.request(url, req(cookie, 'POST', { kind: 'invest', idempotencyKey: 'k' }))).status).toBe(404)
    const me = (await (await app.request('/api/me', { headers: { cookie } })).json()) as { investments?: boolean }
    expect(me.investments).toBeUndefined()
  })

  it('invest makes a position (once per key); follow-on, mark and convert change it; GET shows it', async () => {
    const app = await start(true)
    const { cookie, url, positions } = await company(app)
    expect(((await (await app.request('/api/me', { headers: { cookie } })).json()) as { investments?: boolean }).investments).toBe(true)
    expect(await positions()).toEqual([])

    const body = { kind: 'invest', issuer: 'Kite Robotics', securityType: 'safe', date: '2025-03-01', amount: usd(100_000), valuationCap: usd(8_000_000), discountPct: 20, idempotencyKey: 'inv-0001' }
    const first = await app.request(url, req(cookie, 'POST', body))
    expect(first.status).toBe(201)
    const r = (await first.json()) as { status: string; positionId: string; recordId: string; summary: string }
    expect(r).toMatchObject({ status: 'applied', summary: 'Invested in Kite Robotics' })
    expect(r.positionId).toMatch(/^pos_/)
    expect(r.recordId).toBeTruthy()
    const again = (await (await app.request(url, req(cookie, 'POST', body))).json()) as { status: string; positionId: string }
    expect(again.positionId).toBe(r.positionId)
    expect(['duplicate', 'applied']).toContain(again.status)
    expect(await positions()).toHaveLength(1)

    const pos = r.positionId
    for (const [key, ev] of [
      ['inv-0002', { kind: 'invest', positionId: pos, date: '2025-09-01', amount: usd(50_000) }],
      ['inv-0003', { kind: 'mark', positionId: pos, date: '2026-01-15', amount: usd(450_000), markSource: 'Series A price' }],
      ['inv-0004', { kind: 'convert', positionId: pos, date: '2026-02-01', securityType: 'preferred_stock', series: 'Series A', shares: 31_250 }],
    ] as const) {
      const res = await app.request(url, req(cookie, 'POST', { ...ev, idempotencyKey: key }))
      expect(res.status, key).toBe(201)
      expect(((await res.json()) as { positionId: string }).positionId).toBe(pos)
    }
    const [p] = await positions()
    expect(p).toMatchObject({ positionId: pos, issuer: 'Kite Robotics', securityType: 'preferred_stock', series: 'Series A', shares: 31_250, invested: usd(150_000), value: usd(450_000), valueSource: 'mark', status: 'active' })
    // Totals are core's investmentTotals, as get_investments reports them: per currency, multiple to 2 places.
    const got = (await (await app.request(url, { headers: { cookie } })).json()) as { totals: Array<{ currency: string; invested: { minor: number }; value: { minor: number }; moic: number | null; positions: number }> }
    expect(got.totals).toEqual([expect.objectContaining({ currency: 'USD', positions: 1, invested: usd(150_000), value: usd(450_000), moic: 3 })])
    // As of a day before the mark: still at cost.
    expect((await positions('2025-12-31'))[0]).toMatchObject({ value: usd(150_000), valueSource: 'cost', securityType: 'safe' })
  })

  it('refuses in plain words: bad shapes 400, a different currency or an unknown position 422/404', async () => {
    const app = await start(true)
    const { cookie, url } = await company(app)
    const bad = async (body: Record<string, unknown>) => {
      const res = await app.request(url, req(cookie, 'POST', { idempotencyKey: `bad-${Math.random()}`, ...body }))
      return { status: res.status, message: ((await res.json()) as { message: string }).message }
    }
    expect(await bad({ kind: 'buy', date: '2025-01-01' })).toMatchObject({ status: 400, message: expect.stringMatching(/^Say what happened/) })
    expect(await bad({ kind: 'invest', date: 'soon', issuer: 'X', securityType: 'safe' })).toMatchObject({ status: 400, message: expect.stringMatching(/date/) })
    expect(await bad({ kind: 'invest', date: '2025-01-01', issuer: 'X', securityType: 'safe', amount: 100 })).toMatchObject({ status: 400, message: expect.stringMatching(/minor units and a currency/) })
    expect(await bad({ kind: 'mark', date: '2025-01-01', amount: usd(1) })).toMatchObject({ status: 400, message: expect.stringMatching(/positionId/) })
    expect((await app.request(url, req(cookie, 'POST', { kind: 'invest', date: '2025-01-01', issuer: 'X', securityType: 'safe' }))).status).toBe(400)

    const made = (await (await app.request(url, req(cookie, 'POST', { kind: 'invest', issuer: 'Kite', securityType: 'safe', date: '2025-01-01', amount: usd(10_000), idempotencyKey: 'cur-0001' }))).json()) as { positionId: string }
    const eur = await bad({ kind: 'invest', positionId: made.positionId, date: '2025-06-01', amount: { minor: 500_000, currency: 'EUR' } })
    expect(eur.status).toBe(422)
    expect(eur.message).toMatch(/held in USD/)
    expect((await bad({ kind: 'mark', positionId: 'pos_nope', date: '2025-06-01', amount: usd(1) })).status).toBeGreaterThanOrEqual(404)
    expect((await app.request(`${url}?asOf=yesterday`, { headers: { cookie } })).status).toBe(400)
  })

  it('undo from the toast takes the event back and the position re-plans', async () => {
    const app = await start(true)
    const { cookie, url, positions } = await company(app)
    const { positionId } = (await (await app.request(url, req(cookie, 'POST', { kind: 'invest', issuer: 'Kite', securityType: 'safe', date: '2025-01-01', amount: usd(100_000), idempotencyKey: 'undo-0001' }))).json()) as { positionId: string }
    const mark = (await (await app.request(url, req(cookie, 'POST', { kind: 'mark', positionId, date: '2026-01-01', amount: usd(300_000), idempotencyKey: 'undo-0002' }))).json()) as { recordId: string }
    expect((await positions())[0]).toMatchObject({ value: usd(300_000), valueSource: 'mark' })
    const u = await app.request(`/api/records/${mark.recordId}/undo`, req(cookie, 'POST', { idempotencyKey: 'undo-0003' }))
    expect(u.status).toBeLessThan(300)
    expect((await positions())[0]).toMatchObject({ value: usd(100_000), valueSource: 'cost' })
  })
})

describe('permissions', () => {
  it('view-only: GET is allowed past the check, POST is 403; another company is 404', async () => {
    const person: RequestPerson = { personId: 'p1', name: 'Viewer', email: 'v@example.test', sessionId: 's1', workspaceId: 'ws1' }
    const s = {
      permissions: { entitiesFor: async () => [{ id: 'acme', name: 'Acme', kind: 'company' }], can: async (_a: unknown, action: string) => action === 'view', canManageWorkspace: async () => false },
    } as unknown as Parameters<typeof investmentRoutes>[0]
    const app = new Hono<{ Variables: { person: RequestPerson } }>()
    app.onError((err) => (err instanceof HTTPException ? err.getResponse() : new Response(String(err), { status: 500 })))
    app.use('/api/*', async (c, next) => (c.set('person', person), next()))
    app.route('/api', investmentRoutes(s))
    const post = (id: string) => app.request(`/api/entities/${id}/investments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'invest', issuer: 'Kite', securityType: 'safe', date: '2025-01-01', amount: usd(1), idempotencyKey: 'k' }) })
    const res = await post('acme')
    expect(res.status).toBe(403)
    expect(((await res.json()) as { message: string }).message).toBe('You can’t change this company’s investments.')
    expect((await post('other')).status).toBe(404)
  })
})
