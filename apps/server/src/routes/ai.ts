// AI-side routes for the web UI (S7): Connect your AI, Review, cash entries, bucket edits, undo.
// Mounted under /api after session auth (c.get('person')). Shapes: apps/web/src/api/types.ts.

import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { AI_DISCLOSURE, WriteRejected } from '@agfn/contracts'
import { parseGrantShape, ToolError, type AgfnMcpHandle, type AiWorkspaceSummary, type BucketPatch, type CashEntry, type PersonActor, type ReviewDecision } from '@agfn/mcp'
import type { RequestPerson } from '../app.ts'
import { consentShown } from '../consent.ts'
import type { Services } from '../services.ts'

type Env = { Variables: { person: RequestPerson } }

const STATUS: Record<ToolError['code'], 400 | 403 | 404 | 409 | 423 | 429 | 503> = {
  not_found: 404, forbidden: 403, invalid: 400, paused: 423, rate_limited: 429, cap_reached: 429, conflict: 409, unavailable: 503,
}

function reply(status: number, body: Record<string, unknown>): never {
  throw new HTTPException(status as 400, { res: new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) })
}

/** ToolError → the UI's error contract: {error, message}; passkey re-check as 403 recheck. */
export function rethrow(err: unknown): never {
  if (err instanceof ToolError) {
    // The app's error handler answers a re-check: it knows the person, so it says how they can confirm (`method`).
    if (err.hint === 'step_up_required') throw err
    reply(STATUS[err.code], { error: err.code, message: err.message })
  }
  // The ledger refusing a write ("Nothing to undo", a closed period…) is an answer, not a server error.
  if (err instanceof WriteRejected) reply(err.code === 'not_found' ? 404 : 422, { error: err.code, message: err.message })
  // A shape the grant rules refuse (e.g. an expiry in the past) is the caller's mistake, not a server error.
  if (err instanceof Error && err.name === 'GrantShapeError') reply(400, { error: 'invalid', message: `Invalid access settings: ${err.message}` })
  throw err
}

function uiOf(s: Pick<Services, 'mcp'>): AgfnMcpHandle['ui'] {
  const ui = (s.mcp as Partial<AgfnMcpHandle> | undefined)?.ui
  if (!ui) reply(503, { message: 'The AI connection is not installed on this server yet.' })
  return ui
}

function actorOf(c: Context<Env>): PersonActor {
  const p = c.get('person')
  if (!p.workspaceId) reply(409, { error: 'onboarding', message: 'Create your first company to get started.' })
  return { workspaceId: p.workspaceId, personId: p.personId, ip: p.ip, userAgent: c.req.header('user-agent') }
}

async function body(c: Context<Env>): Promise<Record<string, unknown>> {
  const v = (await c.req.json().catch(() => null)) as unknown
  if (!v || typeof v !== 'object' || Array.isArray(v)) reply(400, { message: 'Send a JSON object.' })
  return v as Record<string, unknown>
}

function idemKey(b: Record<string, unknown>): string {
  const k = b.idempotencyKey
  if (typeof k !== 'string' || !/^[A-Za-z0-9._:\-]{8,128}$/.test(k)) reply(400, { message: 'Missing idempotencyKey.' })
  return k
}

function money(v: unknown): { minor: number; currency: string } {
  const m = v as { minor?: unknown; currency?: unknown } | null
  if (!m || typeof m.minor !== 'number' || !Number.isSafeInteger(m.minor) || typeof m.currency !== 'string' || !/^[A-Za-z]{3}$/.test(m.currency)) reply(400, { message: 'Amounts are {minor, currency}.' })
  return { minor: m.minor, currency: m.currency.toUpperCase() }
}

function cashEntry(b: Record<string, unknown>): CashEntry {
  const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '')
  if (!s('entityId')) reply(400, { message: 'Pick a company.' })
  if (b.direction !== 'in' && b.direction !== 'out') reply(400, { message: 'Money in or money out?' })
  if (b.paidBy !== 'company' && b.paidBy !== 'me') reply(400, { message: 'Whose money paid?' })
  return { entityId: s('entityId'), direction: b.direction, amount: money(b.amount), date: s('date'), counterparty: s('counterparty'), ...(s('note') ? { note: s('note') } : {}), paidBy: b.paidBy }
}

function bucketPatch(b: Record<string, unknown>): BucketPatch {
  const patch: BucketPatch = {}
  if (b.name !== undefined) {
    if (typeof b.name !== 'string') reply(400, { message: 'name must be text.' })
    patch.name = b.name
  }
  if (b.fields !== undefined) {
    if (!Array.isArray(b.fields)) reply(400, { message: 'fields must be a list.' })
    patch.fields = b.fields.map((f: unknown) => {
      const x = f as Record<string, unknown>
      if (typeof x?.key !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(x.key) || typeof x.label !== 'string' || !['text', 'money', 'date', 'number'].includes(String(x.type))) reply(400, { message: 'Each field needs a key, label and type.' })
      return { key: x.key, label: x.label, type: x.type as 'text', value: typeof x.value === 'string' ? x.value : String(x.value ?? '') }
    })
  }
  // Checked in full by the write path (mcp set-aside-input, core validateSetAside).
  if (b.setAside !== undefined) {
    if (b.setAside !== null && !Array.isArray((b.setAside as { allocations?: unknown }).allocations)) reply(400, { message: 'A set-aside needs at least one account.' })
    patch.setAside = b.setAside as BucketPatch['setAside']
  }
  if (b.schedule !== undefined) {
    if (b.schedule === null) patch.schedule = null
    else {
      const s = b.schedule as Record<string, unknown>
      if (!['weekly', 'monthly', 'quarterly', 'yearly'].includes(String(s.cadence)) || typeof s.dueDay !== 'number' || s.dueDay < 1 || s.dueDay > 31) reply(400, { message: 'A schedule needs an amount, cadence and due day.' })
      patch.schedule = { amount: money(s.amount), cadence: s.cadence as 'monthly', dueDay: s.dueDay, endDate: typeof s.endDate === 'string' ? s.endDate : null }
    }
  }
  return patch
}

function decision(b: Record<string, unknown>): ReviewDecision {
  if (b.action === 'confirm' || b.action === 'reject') return { action: b.action }
  if (b.action === 'edit' && b.values && typeof b.values === 'object' && !Array.isArray(b.values)) {
    return { action: 'edit', values: Object.fromEntries(Object.entries(b.values as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')])) }
  }
  reply(400, { message: 'action must be confirm, reject or edit.' })
}

/** Workspace.ais / aiPaused / reviewCount / reviewModeOn for GET /api/workspace. */
export async function aiWorkspaceSummary(s: Pick<Services, 'mcp'>, workspaceId: string, person: { personId: string }): Promise<AiWorkspaceSummary> {
  const ui = (s.mcp as Partial<AgfnMcpHandle> | undefined)?.ui
  if (!ui) return { ais: [], aiPaused: false, reviewCount: 0, reviewModeOn: false }
  return ui.workspaceSummary({ workspaceId, personId: person.personId })
}

export function aiRoutes(s: Pick<Services, 'mcp'>): Hono<Env> {
  const app = new Hono<Env>()
  const run = <T>(fn: () => Promise<T>) => fn().catch(rethrow)

  // Literal paths before :grantId.
  app.post('/ai/pause-all', async (c) => {
    const b = await body(c)
    await run(() => uiOf(s).pauseAll(actorOf(c), b.paused !== false))
    return c.json({ ok: true })
  })
  app.post('/ai/keys', async (c) => {
    const b = await body(c)
    if (typeof b.name !== 'string' || !b.name.trim()) reply(400, { message: 'Give the key a name.' })
    const shape = await run(async () => parseGrantShape(b.shape))
    const consent = consentShown(b.disclosureVersion, AI_DISCLOSURE.keyText)
    return c.json(await run(() => uiOf(s).createKey(actorOf(c), b.name as string, shape, consent)), 201)
  })
  app.get('/ai/activity/latest', async (c) => c.json(await run(() => uiOf(s).latestActivity(actorOf(c)))))

  app.get('/ai/:grantId', async (c) => c.json(await run(() => uiOf(s).detail(actorOf(c), c.req.param('grantId')))))
  app.patch('/ai/:grantId', async (c) => {
    // { shape } changes access; { name } renames a key (1–60 characters); both may come together.
    const b = await body(c)
    const name = typeof b.name === 'string' ? b.name : undefined
    const shape = b.shape === undefined && name !== undefined ? undefined : await run(async () => parseGrantShape(b.shape))
    return c.json(await run(() => uiOf(s).updateGrant(actorOf(c), c.req.param('grantId'), shape, name)))
  })
  app.post('/ai/:grantId/pause', async (c) => {
    const b = await body(c)
    await run(() => uiOf(s).setPaused(actorOf(c), c.req.param('grantId'), b.paused !== false))
    return c.json({ ok: true })
  })
  app.post('/ai/:grantId/revoke', async (c) => {
    await run(() => uiOf(s).deps.control.revokeGrant(actorOf(c), c.req.param('grantId')))
    return c.json({ ok: true })
  })

  app.get('/review', async (c) => c.json(await run(() => uiOf(s).review(actorOf(c)))))
  // Before /review/:id: these two words aren't item ids.
  app.get('/review/filed', async (c) => c.json(await run(() => uiOf(s).filed(actorOf(c)))))
  app.post('/review/filed/:id/undo', async (c) => {
    await run(() => uiOf(s).undoFiled(actorOf(c), c.req.param('id')))
    return c.json({ ok: true })
  })
  app.post('/review/group/:key', async (c) => {
    const b = (await body(c)) as { action?: unknown; ids?: unknown }
    if (b.action !== 'confirm' || !Array.isArray(b.ids) || !b.ids.every((i) => typeof i === 'string')) throw new HTTPException(400, { message: 'Send action "confirm" and the ids shown.' })
    const r = await run(() => uiOf(s).confirmGroup(actorOf(c), c.req.param('key'), b.ids as string[]))
    return c.json({ ok: true, ...r })
  })
  app.post('/review/:id', async (c) => {
    const d = decision(await body(c))
    const r = await run(() => uiOf(s).resolve(actorOf(c), c.req.param('id'), d))
    return c.json({ ok: true, ...(r ?? {}) })
  })

  app.post('/entries/cash', async (c) => {
    const b = await body(c)
    const r = await run(() => uiOf(s).addCash(actorOf(c), cashEntry(b), idemKey(b)))
    return c.json(r, r.status === 'applied' ? 201 : 200)
  })
  app.post('/records/:id/undo', async (c) => {
    const b = await body(c)
    return c.json(await run(() => uiOf(s).undo(actorOf(c), c.req.param('id'), idemKey(b))))
  })
  app.post('/buckets', async (c) => {
    const b = await body(c)
    if (typeof b.entityId !== 'string' || !b.entityId) reply(400, { message: 'Pick the company (or Personal) for this bucket.' })
    const created = await run(() => uiOf(s).createBucket(actorOf(c), b.entityId as string, bucketPatch(b), idemKey(b)))
    return c.json(created, 201)
  })
  app.get('/buckets/:id', async (c) => c.json(await run(() => uiOf(s).bucket(actorOf(c), c.req.param('id')))))
  app.patch('/buckets/:id', async (c) => {
    const b = await body(c)
    return c.json(await run(() => uiOf(s).updateBucket(actorOf(c), c.req.param('id'), bucketPatch(b), idemKey(b))))
  })

  return app
}
