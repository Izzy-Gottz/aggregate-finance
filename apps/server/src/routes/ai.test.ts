import { WriteRejected } from '@agfn/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { Services } from '../services.ts'
import type { RequestPerson } from '../app.ts'
import { aiRoutes, aiWorkspaceSummary, rethrow } from './ai.ts'
import { ToolError } from '@agfn/mcp'
import { makeHarness, READ_ALL, WS, type Harness } from '../../../../packages/mcp/src/fakes/harness.ts'
import { DEMO } from '../../../../packages/mcp/src/fakes/demo-books.ts'

let H: Harness
let app: Hono<{ Variables: { person: RequestPerson } }>
let person: RequestPerson

beforeEach(async () => {
  H = await makeHarness()
  person = { personId: DEMO.owner, name: 'Yisrael', email: 'y@example.test', sessionId: 's1', workspaceId: WS }
  app = new Hono()
  // Like app.ts: a re-check (step_up_required) reaches the app's handler, which adds how to confirm (`method`).
  app.onError((err) =>
    err instanceof HTTPException
      ? err.getResponse()
      : err instanceof ToolError && err.hint === 'step_up_required'
        ? Response.json({ error: 'recheck', method: 'email', message: err.message }, { status: 403 })
        : new Response(String(err), { status: 500 }),
  )
  app.use('/api/*', async (c, next) => {
    c.set('person', person)
    await next()
  })
  app.route('/api', aiRoutes({ mcp: H.agfn } as unknown as Pick<Services, 'mcp'>))
})
afterEach(async () => {
  await H.close()
})

const json = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
let n = 0
const k = () => `ui-key-${++n}-${Date.now()}`

describe('Connect your AI routes', () => {
  it('detail, activity in plain words, pause one AI, revoke', async () => {
    const { principal, grant } = await H.connectAi({ write: true, entityIds: [DEMO.acme] })
    await H.agfn.service.callTool(principal, 'get_metric', { metric: 'cash' })
    await H.agfn.service.callTool(principal, 'add_entry', { company: 'Acme', kind: 'cash_income', amount: { amount: '500.00', currency: 'USD' }, date: '2026-10-09', paid_by: 'Acme', counterparty: 'Walk-in', idempotency_key: k() })
    await H.agfn.service.callTool(principal, 'get_overview', { company: 'Bluebird' })

    const d = (await (await app.request(`/api/ai/${grant.id}`)).json()) as { client: string; personName: string; paused: boolean; via: string; activity: Array<{ kind: string; summary: string; result: string; status?: string; undoUntil?: string; recordId?: string }> }
    expect(d).toMatchObject({ client: 'Claude', personName: 'Yisrael', paused: false })
    expect(d.via).toMatch(/^Agent key agfn_live_/)
    const [blocked, write, read] = d.activity
    expect(blocked).toMatchObject({ kind: 'blocked', summary: 'looked at the overview' })
    expect(blocked!.result).toMatch(/can't see balances for "Bluebird"/)
    expect(write).toMatchObject({ kind: 'write', summary: 'added cash received of $500.00 to Acme (Walk-in)', result: 'recorded', status: 'applied' })
    expect(write!.undoUntil).toBe('2026-11-08T14:00:00.000Z')
    expect(read).toMatchObject({ kind: 'read', summary: 'asked for cash for Acme' })

    // Latest activity (onboarding) is the newest row.
    const latest = (await (await app.request('/api/ai/activity/latest')).json()) as { summary: string }
    expect(latest.summary).toBe('looked at the overview')

    // Pause just this AI.
    expect((await app.request(`/api/ai/${grant.id}/pause`, json('POST', { paused: true }))).status).toBe(200)
    const paused = await H.agfn.service.callTool(principal, 'get_overview', {})
    expect(!paused.ok && paused.error.code).toBe('paused')
    expect((await H.agfn.service.callTool(principal, 'whoami', {})).ok).toBe(true)
    expect(((await (await app.request(`/api/ai/${grant.id}`)).json()) as { paused: boolean }).paused).toBe(true)
    await app.request(`/api/ai/${grant.id}/pause`, json('POST', { paused: false }))
    expect((await H.agfn.service.callTool(principal, 'get_overview', {})).ok).toBe(true)

    expect((await app.request(`/api/ai/${grant.id}/revoke`, json('POST', {}))).status).toBe(200)
    expect(H.revoked).toEqual([grant.id])
    expect((await app.request(`/api/ai/${grant.id}`)).status).toBe(200)
    expect((await aiWorkspaceSummary({ mcp: H.agfn } as unknown as Pick<Services, 'mcp'>, WS, person)).ais).toHaveLength(0)
  })

  it('a void reads as a void, with no Undo of its own (the add keeps its Undo)', async () => {
    const { principal, grant } = await H.connectAi({ write: true, entityIds: [DEMO.acme] })
    const added = await H.agfn.service.callTool(principal, 'add_invoice', { company: 'Acme', side: 'owed_to_you', counterparty: 'Cobalt Studio', number: 'INV-900', issue_date: '2026-10-09', due_date: '2026-11-08', currency: 'USD', lines: [{ description: 'Design', quantity: 1, unit_price: '500.00' }], total: '500.00', idempotency_key: k() })
    expect(added.ok, JSON.stringify(added)).toBe(true)
    const recordId = (added as unknown as { ok: true; output: { data: { record_id: string } } }).output.data.record_id
    const voided = await H.agfn.service.callTool(principal, 'void_record', { id: recordId, reason: 'entered twice', idempotency_key: k() })
    expect(voided.ok, JSON.stringify(voided)).toBe(true)
    const d = (await (await app.request(`/api/ai/${grant.id}`)).json()) as { activity: Array<{ kind: string; summary: string; undoUntil?: string; recordId?: string }> }
    const [v, a] = d.activity
    expect(v!.summary).toMatch(/^voided an invoice/)
    expect(v!.summary).toMatch(/Cobalt Studio/)
    expect(v).not.toHaveProperty('undoUntil')
    expect(v).not.toHaveProperty('recordId')
    expect(a!.summary).toMatch(/^added an invoice/)
  })

  it('PATCH changes the grant; widening needs the passkey (403 recheck)', async () => {
    const { grant } = await H.connectAi({ write: false })
    const narrower = await app.request(`/api/ai/${grant.id}`, json('PATCH', { shape: { ...READ_ALL, entityIds: [DEMO.acme] } }))
    expect(narrower.status).toBe(200)
    expect(((await narrower.json()) as { shape: { entityIds: string[] } }).shape.entityIds).toEqual([DEMO.acme])
    H.people.recentPasskey.delete(DEMO.owner)
    const wider = await app.request(`/api/ai/${grant.id}`, json('PATCH', { shape: { ...READ_ALL, write: true } }))
    expect(wider.status).toBe(403)
    expect(await wider.json()).toMatchObject({ error: 'recheck' })
    expect((await app.request(`/api/ai/${grant.id}`, json('PATCH', { shape: { entityIds: 'all' } }))).status).toBe(400)
  })

  it('PATCH { name } renames a key (not an app that signed in), without a passkey check', async () => {
    const r = await app.request('/api/ai/keys', json('POST', { name: 'Key for my bot', shape: { ...READ_ALL, expiresAt: '2026-12-01T00:00:00.000Z' } }))
    const { grantId, key } = (await r.json()) as { grantId: string; key: string }
    const grant = await H.agfn.control.createGrant({ workspaceId: WS, personId: DEMO.owner }, { clientId: 'claude-ai', clientName: 'Claude', kind: 'oauth', shape: { ...READ_ALL, expiresAt: '2026-12-01T00:00:00.000Z' } })
    H.people.recentPasskey.delete(DEMO.owner) // renaming isn't widening
    const renamed = await app.request(`/api/ai/${grantId}`, json('PATCH', { name: '  n8n   nightly  ' }))
    expect(renamed.status, await renamed.clone().text()).toBe(200)
    expect(((await renamed.json()) as { client: string }).client).toBe('n8n nightly')
    // The key keeps working and calls itself by the new name.
    const auth = await H.agfn.service.authenticate(key, { resource: 'https://agfn.test/mcp' })
    expect(auth.ok && auth.principal.grant.clientName).toBe('n8n nightly')
    for (const bad of ['', '   ', 'x'.repeat(61)]) expect((await app.request(`/api/ai/${grantId}`, json('PATCH', { name: bad }))).status, JSON.stringify(bad)).toBe(400)
    // An OAuth app keeps the name it showed at consent.
    expect((await app.request(`/api/ai/${grant.id}`, json('PATCH', { name: 'Totally Claude' }))).status).toBe(400)
  })

  it('creates keys shown once and pauses everything', async () => {
    const r = await app.request('/api/ai/keys', json('POST', { name: 'n8n', shape: { ...READ_ALL, expiresAt: '2026-12-01T00:00:00.000Z' } }))
    expect(r.status).toBe(201)
    const { grantId, key } = (await r.json()) as { grantId: string; key: string }
    expect(key).toMatch(/^agfn_live_/)
    expect((await H.agfn.service.authenticate(key, { resource: 'https://agfn.test/mcp' })).ok).toBe(true)
    expect((await app.request('/api/ai/pause-all', json('POST', { paused: true }))).status).toBe(200)
    const sum = await aiWorkspaceSummary({ mcp: H.agfn } as unknown as Pick<Services, 'mcp'>, WS, person)
    expect(sum.aiPaused).toBe(true)
    expect(sum.ais.map((a) => a.grantId)).toEqual([grantId])
    person = { ...person, personId: DEMO.accountant }
    expect((await app.request('/api/ai/pause-all', json('POST', { paused: false }))).status).toBe(403)
  })

  it('Review still works before the ledger is installed', async () => {
    const { ToolError } = await import('@agfn/mcp')
    H.books.reviewItems = async () => {
      throw new ToolError('unavailable', 'not yet')
    }
    expect((await app.request('/api/review')).status).toBe(200)
    expect((await aiWorkspaceSummary({ mcp: H.agfn } as unknown as Pick<Services, 'mcp'>, WS, person)).reviewCount).toBe(0)
  })

  it('needs a workspace', async () => {
    person = { ...person, workspaceId: null }
    expect((await app.request('/api/review')).status).toBe(409)
  })
})

describe('Review routes', () => {
  it('lists held AI writes with S1 items and applies, edits or discards them', async () => {
    const { principal } = await H.connectAi({ write: true, reviewMode: 'review_all' })
    const add = (amount: string) => H.agfn.service.callTool(principal, 'add_entry', { company: 'Acme', kind: 'cash_income', amount: { amount, currency: 'USD' }, date: '2026-10-09', paid_by: 'Acme', counterparty: 'Walk-in', idempotency_key: k(), reason: 'User said so' })
    await add('500.00')
    await add('20.00')
    const items = (await (await app.request('/api/review')).json()) as Array<{ id: string; kind: string; title: string; detail: string; entityName: string; amount?: { minor: number }; editable?: Array<{ key: string; value: string }> }>
    const writes = items.filter((i) => i.kind === 'ai_write')
    expect(writes).toHaveLength(2)
    expect(items.some((i) => i.kind === 'match')).toBe(true)
    const big = writes.find((i) => i.amount?.minor === 50_000)!
    expect(big).toMatchObject({ title: 'Claude added cash received of $500.00 to Acme (Walk-in)', entityName: 'Acme' })
    expect(big.detail).toContain('Reason given: User said so')
    expect(big.editable?.find((e) => e.key === 'amount')?.value).toBe('500.00')

    const sum = await aiWorkspaceSummary({ mcp: H.agfn } as unknown as Pick<Services, 'mcp'>, WS, person)
    expect(sum).toMatchObject({ reviewCount: 3, reviewModeOn: true })

    const cashBefore = (await H.books.metric('cash', { workspaceId: WS, entityIds: [DEMO.acme] })).value as { minor: number }
    expect((await app.request(`/api/review/${encodeURIComponent(big.id)}`, json('POST', { action: 'edit', values: { amount: '450.00', counterparty: 'Market stall' } }))).status).toBe(200)
    const cashAfter = (await H.books.metric('cash', { workspaceId: WS, entityIds: [DEMO.acme] })).value as { minor: number }
    expect(cashAfter.minor - cashBefore.minor).toBe(45_000)
    expect(H.books.log.at(-1)!.provenance.label).toBe('Claude · Yisrael (edited and approved by Yisrael)')

    const small = writes.find((i) => i.amount?.minor === 2_000)!
    expect((await app.request(`/api/review/${encodeURIComponent(small.id)}`, json('POST', { action: 'edit', values: { amount: 'lots' } }))).status).toBe(400)
    expect((await app.request(`/api/review/${encodeURIComponent(small.id)}`, json('POST', { action: 'reject' }))).status).toBe(200)
    expect((await app.request('/api/review/rv_match', json('POST', { action: 'confirm' }))).status).toBe(200)
    expect(await (await app.request('/api/review')).json()).toEqual([])
    expect((await app.request(`/api/review/${encodeURIComponent(small.id)}`, json('POST', { action: 'confirm' }))).status).toBe(409)
  })
})

describe('writes from the app', () => {
  it('adds cash (idempotent), undoes it, and edits buckets through the pipeline', async () => {
    const before = ((await H.books.metric('cash', { workspaceId: WS, entityIds: [DEMO.acme] })).value as { minor: number }).minor
    const entry = { entityId: DEMO.acme, direction: 'in', amount: { minor: 12_000, currency: 'USD' }, date: '2026-10-09', counterparty: 'Market', paidBy: 'company', idempotencyKey: 'cash-entry-0001' }
    const r = await app.request('/api/entries/cash', json('POST', entry))
    expect(r.status).toBe(201)
    const res = (await r.json()) as { status: string; recordId: string; undoUntil: string }
    expect(res.status).toBe('applied')
    expect(((await (await app.request('/api/entries/cash', json('POST', entry))).json()) as { status: string }).status).toBe('duplicate')
    expect(((await H.books.metric('cash', { workspaceId: WS, entityIds: [DEMO.acme] })).value as { minor: number }).minor).toBe(before + 12_000)

    const u = await app.request(`/api/records/${res.recordId}/undo`, json('POST', { idempotencyKey: 'undo-entry-0001' }))
    expect(u.status).toBe(200)
    expect(((await H.books.metric('cash', { workspaceId: WS, entityIds: [DEMO.acme] })).value as { minor: number }).minor).toBe(before)

    expect((await app.request('/api/entries/cash', json('POST', { ...entry, idempotencyKey: undefined }))).status).toBe(400)
    expect((await app.request('/api/entries/cash', json('POST', { ...entry, entityId: DEMO.personal, paidBy: 'me', idempotencyKey: 'cash-entry-0002' }))).status).toBe(201)

    const b = (await (await app.request('/api/buckets/k_rent')).json()) as { name: string; fields: Array<{ key: string; value: string }>; schedule: { dueDay: number } }
    expect(b).toMatchObject({ name: 'Rent', fields: [{ key: 'landlord', value: 'WeWork' }], schedule: { dueDay: 1 } })
    const patched = await app.request('/api/buckets/k_rent', json('PATCH', { name: 'Office rent', fields: [{ key: 'landlord', label: 'Landlord', type: 'text', value: 'Industrious' }], idempotencyKey: 'bucket-edit-0001' }))
    expect(patched.status).toBe(200)
    expect(await patched.json()).toMatchObject({ name: 'Office rent', fields: [{ key: 'landlord', value: 'Industrious' }] })

    // "+ Add a stake" under Personal: a new bucket through the create_bucket write path.
    const stake = await app.request('/api/buckets', json('POST', { entityId: DEMO.personal, name: 'Stake in Lumen Health', fields: [{ key: 'kind', label: 'Kind', type: 'text', value: 'SAFE' }, { key: 'amount', label: 'Amount', type: 'money', value: '25000' }, { key: 'date', label: 'Date', type: 'date', value: '2026-03-01' }], idempotencyKey: 'bucket-new-0001' }))
    expect(stake.status).toBe(201)
    expect(await stake.json()).toMatchObject({ name: 'Stake in Lumen Health', fields: [{ key: 'kind', value: 'SAFE' }, { key: 'amount', value: '$25,000.00' }, { key: 'date', value: '2026-03-01' }] })
    expect((await app.request('/api/buckets', json('POST', { entityId: DEMO.personal, name: ' ', idempotencyKey: 'bucket-new-0002' }))).status).toBe(400)
    expect((await app.request('/api/buckets', json('POST', { name: 'No company', idempotencyKey: 'bucket-new-0003' }))).status).toBe(400)

    // Equity from the app goes through the pipeline too.
    const eq = await H.agfn.ui.recordEquity({ workspaceId: WS, personId: DEMO.owner }, DEMO.acme, { kind: 'issuance', date: '2026-10-01', stakeholder: 'Dana', shares: 100_000, shareClass: 'Common' }, 'equity-ui-0001')
    expect(eq.status).toBe('applied')
    expect(eq.summary).toBeTruthy()
    expect(eq).not.toHaveProperty('possibleDuplicates')
    expect((await H.agfn.ui.recordEquity({ workspaceId: WS, personId: DEMO.owner }, DEMO.acme, { kind: 'issuance', date: '2026-10-01', stakeholder: 'Dana', shares: 100_000, shareClass: 'Common' }, 'equity-ui-0001')).status).toBe('duplicate')
    await expect(H.agfn.ui.recordEquity({ workspaceId: WS, personId: DEMO.owner }, DEMO.acme, { kind: 'gift', date: '2026-10-01', stakeholder: 'X' }, 'equity-ui-0002')).rejects.toThrow()

    // The accountant (no bucket rights) is refused.
    person = { ...person, personId: DEMO.accountant }
    expect((await app.request('/api/buckets/k_rent', json('PATCH', { name: 'X', idempotencyKey: 'bucket-edit-0002' }))).status).toBe(403)
    expect((await app.request('/api/buckets', json('POST', { entityId: DEMO.acme, name: 'X', idempotencyKey: 'bucket-new-0004' }))).status).toBe(403)
  })
})

describe('errors the ledger answers with', () => {
  it('"Nothing to undo" is a 404 with the message, never a 500; other refusals are 422 (43)', async () => {
    const status = (e: unknown) => {
      try {
        rethrow(e)
      } catch (x) {
        return x instanceof HTTPException ? x.status : 500
      }
    }
    expect(status(new WriteRejected('Nothing to undo.', 'not_found'))).toBe(404)
    expect(status(new WriteRejected('That period is closed.', 'period_locked'))).toBe(422)
    expect(status(new Error('boom'))).toBe(500)
  })
})
