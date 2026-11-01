// Equity routes for the web UI (S6). Shapes: apps/web/src/api/types.ts (EquityDetail, EquityWriteResult,
// EquityImportResult) and apps/web/src/api/http.ts (Routes). Permission: 'equity' view/add on the company.
import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { Actor, DataType, Provenance } from '@agfn/contracts'
import { WriteRejected } from '@agfn/contracts'
import { ToolError, type AgfnMcpHandle } from '@agfn/mcp'
import type { RequestPerson } from '../app.ts'
import { looksLikeXlsx } from '@agfn/equity'
import { equityFor } from '../equity.ts'
import type { Services } from '../services.ts'

type Env = { Variables: { person: RequestPerson } }
type S = Pick<Services, 'db' | 'ledger' | 'permissions'> & Partial<Pick<Services, 'mcp'>>

const MAX_IMPORT_BYTES = 5 * 1024 * 1024

function reply(status: number, body: Record<string, unknown>): never {
  throw new HTTPException(status as 400, { res: new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) })
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof WriteRejected) reply(422, { error: e.code, message: e.message })
    if (e instanceof ToolError) reply(e.code === 'not_found' ? 404 : e.code === 'forbidden' ? 403 : 422, { error: e.code, message: e.message })
    if (e instanceof SyntaxError) reply(400, { message: 'That file isn’t valid JSON.' })
    throw e
  }
}

export function equityRoutes(s: S): Hono<Env> {
  const app = new Hono<Env>()
  const svc = () => equityFor(s)

  async function ctx(c: Context<Env>, action: 'view' | 'add') {
    const p = c.get('person')
    if (!p.workspaceId) reply(409, { error: 'onboarding', message: 'Create your first company to get started.' })
    const ws = p.workspaceId
    const id = c.req.param('id') as string
    const visible = await s.permissions.entitiesFor(ws, p.personId)
    const entity = visible.find((e) => e.id === id)
    if (!entity) reply(404, { message: 'That company was not found.' })
    const actor: Actor = { kind: 'person', personId: p.personId, workspaceId: ws }
    if (!(await s.permissions.can(actor, action, id, 'equity' as DataType))) reply(403, { message: action === 'view' ? 'You can’t see this company’s cap table.' : 'You can’t change this company’s cap table.' })
    const label = p.name ? `${p.name}` : 'you'
    return { ws, id, p, label }
  }

  app.get('/entities/:id/equity', async (c) => {
    const { ws, id } = await ctx(c, 'view')
    return c.json(await svc().detail(ws, id))
  })

  app.post('/entities/:id/equity/events', async (c) => {
    const { ws, id, p, label } = await ctx(c, 'add')
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) reply(400, { message: 'Send the event as JSON.' })
    const { idempotencyKey, ...payload } = body
    const key = typeof idempotencyKey === 'string' && idempotencyKey ? idempotencyKey : ''
    // Through S7's pipeline when installed: provenance, idempotency, review mode, the activity log and 30-day undo.
    const ui = (s.mcp as Partial<AgfnMcpHandle> | undefined)?.ui
    if (ui?.recordEquity) {
      if (!key) reply(400, { message: 'Missing idempotencyKey.' })
      const r = (await run(() => ui.recordEquity({ workspaceId: ws, personId: p.personId, ip: p.ip, userAgent: c.req.header('user-agent') }, id, payload, key))) as {
        status: string
        recordId?: string
        message?: string
        summary?: string
        possibleDuplicates?: string[]
      }
      if (r.status === 'rejected') reply(422, { error: 'rejected', message: r.message ?? 'That wasn’t recorded.' })
      return c.json({ status: r.status, ...(r.recordId ? { recordId: r.recordId } : {}), summary: r.summary ?? r.message ?? (r.status === 'pending_review' ? 'Waiting for review.' : 'Recorded.'), possibleDuplicates: r.possibleDuplicates ?? [] }, r.status === 'applied' ? 201 : 200)
    }
    const prov: Provenance = { writeRequestId: key, actorKind: 'person', personId: p.personId, label }
    const r = await run(() => svc().apply({ op: 'record_equity_event', workspaceId: ws, entityId: id, payload }, prov))
    return c.json({ status: 'applied', recordId: r.recordId, summary: r.summary, possibleDuplicates: r.possibleDuplicates }, 201)
  })

  app.post('/entities/:id/equity/import', async (c) => {
    const { ws, id, p, label } = await ctx(c, 'add')
    const form = await c.req.formData().catch(() => null)
    const file = form?.get('file')
    if (!file || typeof file === 'string') reply(400, { message: 'Attach a Pulley, Carta or OCX .xlsx, an OCF .json or a .csv file.' })
    if (file.size > MAX_IMPORT_BYTES) reply(413, { message: 'That file is too large (5 MB max).' })
    const bytes = new Uint8Array(await file.arrayBuffer())
    const meta = { origin: 'import' as const, createdBy: p.personId, label: `${label} (import)` }
    if (looksLikeXlsx(bytes)) {
      const r = await run(() => svc().importXlsx(ws, id, bytes, meta))
      return c.json(r, r.added ? 201 : 200)
    }
    if (/\.xlsx?$/i.test(file.name)) reply(422, { message: 'That isn’t a readable .xlsx. Old .xls files aren’t supported: open it in Excel and save it as .xlsx.' })
    const text = new TextDecoder().decode(bytes)
    const looksJson = /\.json$/i.test(file.name) || /^\s*[[{]/.test(text)
    const r = await run(() => (looksJson ? svc().importOcf(ws, id, JSON.parse(text), meta) : svc().importCsv(ws, id, text, meta)))
    return c.json(r, r.added ? 201 : 200)
  })

  app.get('/entities/:id/equity/ocf', async (c) => {
    const { ws, id } = await ctx(c, 'view')
    const files = await svc().exportOcf(ws, id)
    c.header('content-disposition', `attachment; filename="cap-table-ocf-${id}.json"`)
    return c.json(files)
  })

  return app
}
