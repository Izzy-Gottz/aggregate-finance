// Investments the company holds, for the web UI's Investments page (S8). Shapes: apps/web/src/lib/investments.ts
// (InvestmentView, InvestmentInput) and apps/web/src/api/http.ts (Routes). Permission: 'equity' view/add on the
// company. Mounted only with AGFN_INVESTMENTS=1 (app.ts); otherwise these paths 404.
import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { Actor, DataType, InvestmentEvent } from '@agfn/contracts'
import { WriteRejected } from '@agfn/contracts'
import { createHash } from 'node:crypto'
import { ToolError, type AgfnMcpHandle } from '@agfn/mcp'
import type { RequestPerson } from '../app.ts'
import { financeFor } from '../finance.ts'
import type { Services } from '../services.ts'

type Env = { Variables: { person: RequestPerson } }
type S = Parameters<typeof financeFor>[0] & Pick<Services, 'permissions'> & Partial<Pick<Services, 'mcp'>>

const KINDS: ReadonlyArray<InvestmentEvent['kind']> = ['invest', 'mark', 'distribution', 'write_off', 'exit', 'convert']
const SECURITY_TYPES: ReadonlyArray<InvestmentEvent['securityType']> = ['safe', 'convertible_note', 'preferred_stock', 'common_stock', 'warrant', 'other']
const DAY = /^\d{4}-\d{2}-\d{2}$/

function reply(status: number, body: Record<string, unknown>): never {
  throw new HTTPException(status as 400, { res: new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) })
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof WriteRejected) reply(422, { error: e.code, message: e.message })
    if (e instanceof ToolError) reply(e.code === 'not_found' ? 404 : e.code === 'forbidden' ? 403 : 422, { error: e.code, message: e.message })
    throw e
  }
}

const isDay = (v: unknown): v is string => typeof v === 'string' && DAY.test(v) && !Number.isNaN(Date.parse(v))
const isMoney = (v: unknown): v is { minor: number; currency: string } =>
  !!v && typeof v === 'object' && Number.isSafeInteger((v as { minor?: unknown }).minor) && typeof (v as { currency?: unknown }).currency === 'string' && /^[A-Z]{3}$/.test((v as { currency: string }).currency)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 200

/** The body, checked for shape in plain words; what the position allows (currency, convert, after an exit) is core's. */
function eventFrom(b: Record<string, unknown>): Record<string, unknown> {
  if (!KINDS.includes(b.kind as InvestmentEvent['kind'])) reply(400, { message: 'Say what happened: invest, mark, distribution, write_off, exit or convert.' })
  if (!isDay(b.date)) reply(400, { message: 'Pick a date (YYYY-MM-DD).' })
  if (b.positionId !== undefined && !text(b.positionId)) reply(400, { message: 'That investment id isn’t valid.' })
  if (b.issuer !== undefined && !text(b.issuer)) reply(400, { message: 'Say which company the investment is in.' })
  if (b.securityType !== undefined && !SECURITY_TYPES.includes(b.securityType as InvestmentEvent['securityType'])) reply(400, { message: 'Pick what was bought: SAFE, note, preferred, common, warrant or other.' })
  for (const k of ['amount', 'valuationCap'] as const) if (b[k] !== undefined && !isMoney(b[k])) reply(400, { message: `${k === 'amount' ? 'The amount' : 'The valuation cap'} needs minor units and a currency, like { minor: 2500000, currency: "USD" }.` })
  if (b.maturityDate !== undefined && !isDay(b.maturityDate)) reply(400, { message: 'Pick a maturity date (YYYY-MM-DD).' })
  for (const k of ['shares', 'discountPct', 'interestPct'] as const) if (b[k] !== undefined && (!isNum(b[k]) || (b[k] as number) < 0)) reply(400, { message: `${k === 'shares' ? 'Shares' : k === 'discountPct' ? 'The discount' : 'The interest rate'} must be a number, 0 or more.` })
  if (b.series !== undefined && !text(b.series)) reply(400, { message: 'The round or series name is too long or empty.' })
  if (b.markSource !== undefined && !text(b.markSource)) reply(400, { message: 'Where the mark came from is too long or empty.' })
  const keep = ['kind', 'positionId', 'issuer', 'securityType', 'date', 'amount', 'shares', 'series', 'valuationCap', 'discountPct', 'interestPct', 'maturityDate', 'markSource']
  return Object.fromEntries(keep.filter((k) => b[k] !== undefined).map((k) => [k, typeof b[k] === 'string' && k !== 'date' && k !== 'maturityDate' ? (b[k] as string).trim() : b[k]]))
}

export function investmentRoutes(s: S): Hono<Env> {
  const app = new Hono<Env>()

  async function ctx(c: Context<Env>, action: 'view' | 'add') {
    const p = c.get('person')
    if (!p.workspaceId) reply(409, { error: 'onboarding', message: 'Create your first company to get started.' })
    const ws = p.workspaceId
    const id = c.req.param('id') as string
    const visible = await s.permissions.entitiesFor(ws, p.personId)
    if (!visible.some((e) => e.id === id)) reply(404, { message: 'That company was not found.' })
    const actor: Actor = { kind: 'person', personId: p.personId, workspaceId: ws }
    if (!(await s.permissions.can(actor, action, id, 'equity' as DataType))) reply(403, { message: action === 'view' ? 'You can’t see this company’s investments.' : 'You can’t change this company’s investments.' })
    return { ws, id, p }
  }

  app.get('/entities/:id/investments', async (c) => {
    const { ws, id } = await ctx(c, 'view')
    const asOf = c.req.query('asOf')
    if (asOf !== undefined && !isDay(asOf)) reply(400, { message: 'Pick a date (YYYY-MM-DD).' })
    const reader = financeFor(s).reader
    if (!reader.investments) reply(404, { message: 'Investments aren’t on this server yet.' })
    const scope = { workspaceId: ws, entityIds: [id] }
    // Totals from core's one definition (investmentTotals), the same rows get_investments reports; never summed here.
    const [positions, totals] = await Promise.all([reader.investments(scope, asOf), reader.investmentTotals ? reader.investmentTotals(scope, asOf) : Promise.resolve([])])
    return c.json({ positions, totals })
  })

  app.post('/entities/:id/investments', async (c) => {
    const { ws, id, p } = await ctx(c, 'add')
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) reply(400, { message: 'Send the investment as JSON.' })
    const key = typeof body.idempotencyKey === 'string' && body.idempotencyKey ? body.idempotencyKey : ''
    if (!key) reply(400, { message: 'Missing idempotencyKey.' })
    if (body.bankTransactionId !== undefined && !text(body.bankTransactionId)) reply(400, { message: 'That bank transaction id isn’t valid.' })
    const event = eventFrom(body)
    if (event.kind !== 'invest' && !event.positionId) reply(400, { message: `A ${String(event.kind).replace('_', '-')} needs the investment it belongs to (positionId).` })
    // The pipeline's result doesn't carry core's position id, so a new position's id is named here and sent along.
    // From the idempotency key, not random: a retry sends the very same write, so it's a duplicate, not a conflict.
    if (!event.positionId) event.positionId = `pos_${createHash('sha256').update(`${ws}:${id}:${key}`).digest('base64url').slice(0, 22)}`
    const ui = (s.mcp as Partial<AgfnMcpHandle> | undefined)?.ui
    if (!ui?.recordInvestment) reply(404, { message: 'Investments aren’t on this server yet.' })
    const payload = { event, ...(typeof body.bankTransactionId === 'string' ? { bankTransactionId: body.bankTransactionId } : {}) }
    const r = (await run(() => ui.recordInvestment({ workspaceId: ws, personId: p.personId, ip: p.ip, userAgent: c.req.header('user-agent') }, id, payload, key))) as {
      status: string
      recordId?: string
      message?: string
      summary?: string
    }
    if (r.status === 'rejected') reply(422, { error: 'rejected', message: r.message ?? 'That wasn’t recorded.' })
    return c.json(
      { status: r.status, positionId: event.positionId, ...(r.recordId ? { recordId: r.recordId } : {}), summary: r.summary ?? r.message ?? (r.status === 'pending_review' ? 'Waiting for review.' : 'Recorded.') },
      r.status === 'applied' ? 201 : 200,
    )
  })

  return app
}
