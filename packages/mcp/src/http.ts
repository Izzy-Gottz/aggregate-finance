// Web-standard fetch handler: /mcp (Streamable HTTP, stateless), RFC 9728 protected-resource metadata, REST /v1
// (the same operations as the MCP tools), OpenAPI, and the person-only /v1/control routes.
// apps/server mounts it: app.all('/mcp', c => h.fetch(c.req.raw)) etc.

import * as z from 'zod/v4'
import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server'
import type { GrantShape } from '@agfn/contracts'
import { withWorkspace } from '@agfn/db'
import type { PersonActor } from './control.ts'
import { buildMcpServer } from './mcp-server.ts'
import { buildOpenApi } from './openapi.ts'
import { ToolError, type Principal, type ToolErrorCode } from './scope.ts'
import { SCOPES, type AgfnMcp } from './service.ts'
import type { ToolDef } from './tools/common.ts'

export interface HttpOptions {
  /** Canonical MCP URL, e.g. https://you.example/mcp. Tokens must be issued for exactly this resource. */
  resourceUrl: string
  /** Browser origins allowed to call /mcp and /v1 (DNS-rebinding and CSRF guard). Requests without Origin are allowed. */
  allowedOrigins?: string[]
  /** Client IP for activity and key allowlists (the host knows whether to trust X-Forwarded-For). */
  clientIp?: (req: Request) => string | undefined
  /** The signed-in person for /v1/control routes (session cookie, S0). Null = 401. */
  /** null: not signed in (401). 'not_found': signed in, but the workspace asked for isn't theirs (404). */
  authenticatePerson?: (req: Request) => Promise<PersonActor | null | 'not_found'>
  onError?: (err: unknown) => void
  /**
   * The public demo: every request runs as this server-chosen principal (no bearer token, no OAuth metadata), and only
   * the MCP path is served. Nothing in the request can pick the workspace.
   */
  fixedPrincipal?: () => Promise<Principal | null>
}

const STATUS: Record<ToolErrorCode, number> = { not_found: 404, forbidden: 403, invalid: 400, paused: 423, rate_limited: 429, cap_reached: 429, conflict: 409, unavailable: 503 }

const SECURITY_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...SECURITY_HEADERS, ...headers } })
}

function toolErrorResponse(e: ToolError): Response {
  const headers: Record<string, string> = {}
  if (e.code === 'rate_limited') headers['retry-after'] = /(\d+)s/.exec(e.message)?.[1] ?? '60'
  return json({ error: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) }, STATUS[e.code], headers)
}

interface CompiledRoute {
  method: 'GET' | 'POST'
  re: RegExp
  params: string[]
  tool: ToolDef
}

function compile(tools: readonly ToolDef[]): CompiledRoute[] {
  const routes = tools.map((t) => {
    const params: string[] = []
    const re = new RegExp('^' + t.rest.path.replace(/\{(\w+)\}/g, (_m, p: string) => (params.push(p), '([^/]+)')) + '$')
    return { method: t.rest.method, re, params, tool: t }
  })
  // Literal paths before parameterized ones, longer first.
  return routes.sort((a, b) => a.params.length - b.params.length || b.tool.rest.path.length - a.tool.rest.path.length)
}

/** Coerce query-string values using the tool's JSON Schema (numbers, booleans, arrays, JSON objects). */
function coerceQuery(tool: ToolDef, q: URLSearchParams): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.input, { io: 'input', unrepresentable: 'any' }) as { properties?: Record<string, { type?: string | string[]; anyOf?: Array<{ type?: string }> }> }
  const props = schema.properties ?? {}
  const out: Record<string, unknown> = {}
  for (const key of new Set(q.keys())) {
    const values = q.getAll(key)
    const p = props[key]
    const type = (Array.isArray(p?.type) ? p?.type[0] : p?.type) ?? p?.anyOf?.find((x) => x.type && x.type !== 'null')?.type
    const one = values[values.length - 1] ?? ''
    if (type === 'array') out[key] = values.flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean)
    else if (type === 'number' || type === 'integer') out[key] = one.trim() === '' || Number.isNaN(Number(one)) ? one : Number(one)
    else if (type === 'boolean') out[key] = one === 'true' ? true : one === 'false' ? false : one
    else if (type === 'object') {
      try {
        out[key] = JSON.parse(one)
      } catch {
        out[key] = one
      }
    } else out[key] = one
  }
  return out
}

export class AgfnHttp {
  readonly service: AgfnMcp
  readonly opts: HttpOptions
  private readonly mcp: ReturnType<typeof createMcpHandler>
  private readonly routes: CompiledRoute[]
  private readonly resourcePath: string
  private openapi: unknown

  constructor(service: AgfnMcp, opts: HttpOptions) {
    this.service = service
    this.opts = opts
    this.resourcePath = new URL(opts.resourceUrl).pathname
    this.routes = compile(service.tools)
    this.mcp = createMcpHandler(
      async (ctx) => {
        const principal = ctx.authInfo?.extra?.principal as Principal | undefined
        if (!principal) throw new Error('MCP request reached the server without a principal')
        return buildMcpServer(service, principal, await service.listTools(principal))
      },
      { legacy: 'stateless', onerror: (e) => opts.onError?.(e) },
    )
  }

  /** The resource metadata URL advertised in WWW-Authenticate (RFC 9728 §3.1 path-insertion form). */
  get resourceMetadataUrl(): string {
    const u = new URL(this.opts.resourceUrl)
    return `${u.origin}/.well-known/oauth-protected-resource${u.pathname === '/' ? '' : u.pathname}`
  }

  fetch = async (req: Request): Promise<Response> => {
    try {
      const url = new URL(req.url)
      const path = url.pathname.replace(/\/+$/, '') || '/'
      if (this.opts.fixedPrincipal) {
        if (path !== this.resourcePath) return json({ error: 'not_found', message: 'not found' }, 404)
        if (!this.originAllowed(req)) return json({ error: 'forbidden', message: 'origin not allowed' }, 403)
        return await this.handleMcp(req)
      }
      if (path === '/.well-known/oauth-protected-resource' || path === `/.well-known/oauth-protected-resource${this.resourcePath}`) return this.protectedResourceMetadata()
      if (!this.originAllowed(req)) return json({ error: 'forbidden', message: 'origin not allowed' }, 403)
      if (path === this.resourcePath) return await this.handleMcp(req)
      if (path === '/v1/openapi.json' && req.method === 'GET') return json((this.openapi ??= buildOpenApi(this.opts.resourceUrl, { setAsides: this.service.offersSetAsides, share: this.service.offersShare, investments: this.service.offersInvestments })))
      if (path.startsWith('/v1/control/')) return await this.handleControl(req, path.slice('/v1/control'.length), url)
      if (path.startsWith('/v1/')) return await this.handleRest(req, path, url)
      return json({ error: 'not_found', message: 'not found' }, 404)
    } catch (err) {
      if (err instanceof ToolError) return toolErrorResponse(err)
      this.opts.onError?.(err)
      return json({ error: 'internal', message: 'Something went wrong. Nothing was changed by this request unless a record id was returned.' }, 500)
    }
  }

  // ---------- auth ----------

  private originAllowed(req: Request): boolean {
    const origin = req.headers.get('origin')
    if (!origin) return true
    const own = new URL(this.opts.resourceUrl).origin
    return origin === own || (this.opts.allowedOrigins ?? []).includes(origin)
  }

  private challenge(status: 401 | 403, error: string, description: string): Response {
    const scope = ` scope="${SCOPES.read} ${SCOPES.write}",`
    return json({ error, error_description: description }, status, {
      'www-authenticate': `Bearer resource_metadata="${this.resourceMetadataUrl}",${scope} error="${error}", error_description="${description.replace(/"/g, "'")}"`,
    })
  }

  private async principal(req: Request): Promise<Principal | Response> {
    if (this.opts.fixedPrincipal) {
      const p = await this.opts.fixedPrincipal()
      return p ?? json({ error: 'unavailable', message: 'The demo is being rebuilt. Try again in a minute.' }, 503, { 'retry-after': '60' })
    }
    const h = req.headers.get('authorization') ?? ''
    const m = /^Bearer\s+(\S+)$/i.exec(h)
    if (!m) return this.challenge(401, 'invalid_token', 'missing bearer token')
    const res = await this.service.authenticate(m[1]!, { resource: this.opts.resourceUrl, ip: this.opts.clientIp?.(req), userAgent: req.headers.get('user-agent') ?? undefined })
    if (!res.ok) return this.challenge(res.status, res.error, res.description)
    return res.principal
  }

  private protectedResourceMetadata(): Response {
    const issuer = this.service.issuer
    return json(
      {
        resource: this.opts.resourceUrl,
        ...(issuer ? { authorization_servers: [issuer] } : {}),
        scopes_supported: [SCOPES.read, SCOPES.write],
        bearer_methods_supported: ['header'],
        resource_name: 'Aggregate',
        resource_documentation: new URL('/v1/openapi.json', this.opts.resourceUrl).href,
      },
      200,
      { 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' },
    )
  }

  // ---------- /mcp ----------

  private async handleMcp(req: Request): Promise<Response> {
    const p = await this.principal(req)
    if (p instanceof Response) return p
    const authInfo: AuthInfo = { token: '[redacted]', clientId: p.grant.clientId, scopes: p.scopes, resource: new URL(this.opts.resourceUrl), extra: { principal: p } }
    // The whole MCP exchange (tools/list included) runs in the principal's workspace (row-level security).
    const res = await withWorkspace(p.workspaceId, () => this.mcp.fetch(req, { authInfo }))
    // Stateless: GET and DELETE get 405, which must say what is allowed (RFC 9110 §15.5.6).
    if (res.status !== 405 || res.headers.has('allow')) return res
    const headers = new Headers(res.headers)
    headers.set('allow', 'POST')
    return new Response(res.body, { status: 405, headers })
  }

  // ---------- REST tools ----------

  private async handleRest(req: Request, path: string, url: URL): Promise<Response> {
    if (req.method !== 'GET' && req.method !== 'POST') return json({ error: 'method_not_allowed', message: 'use GET or POST' }, 405, { allow: 'GET, POST' })
    let match: { route: CompiledRoute; params: Record<string, string> } | undefined
    for (const r of this.routes) {
      if (r.method !== req.method) continue
      const m = r.re.exec(path)
      if (m) {
        match = { route: r, params: Object.fromEntries(r.params.map((p, i) => [p, decodeURIComponent(m[i + 1]!)])) }
        break
      }
    }
    if (!match) return json({ error: 'not_found', message: `No route ${req.method} ${path}. See /v1/openapi.json.` }, 404)
    const p = await this.principal(req)
    if (p instanceof Response) return p
    let args: Record<string, unknown>
    if (req.method === 'GET') args = coerceQuery(match.route.tool, url.searchParams)
    else {
      const ct = req.headers.get('content-type') ?? ''
      if (!/^application\/json\b/i.test(ct)) return json({ error: 'invalid', message: 'send application/json' }, 415)
      const text = await req.text()
      if (text.length > 1_000_000) return json({ error: 'invalid', message: 'body too large' }, 413)
      try {
        args = text ? (JSON.parse(text) as Record<string, unknown>) : {}
      } catch {
        return json({ error: 'invalid', message: 'body is not valid JSON' }, 400)
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) return json({ error: 'invalid', message: 'body must be a JSON object' }, 400)
      const idem = req.headers.get('idempotency-key')
      if (idem && args.idempotency_key === undefined) args.idempotency_key = idem
    }
    Object.assign(args, match.params)
    const r = await this.service.callTool(p, match.route.tool.name, args)
    if (!r.ok) return toolErrorResponse(r.error)
    const status = match.route.tool.kind === 'write' && r.output.data.status === 'applied' ? 201 : match.route.tool.kind === 'write' && r.output.data.status === 'pending_review' ? 202 : 200
    return json({ ...r.output.data, summary: r.output.summary }, status)
  }

  // ---------- /v1/control (people only) ----------

  private async handleControl(req: Request, sub: string, url: URL): Promise<Response> {
    if (!this.opts.authenticatePerson) return json({ error: 'not_found', message: 'not found' }, 404)
    // AI credentials never reach the control surface, even if the host's person auth would accept a bearer.
    if (/^Bearer\s+agfn_/i.test(req.headers.get('authorization') ?? '')) return json({ error: 'forbidden', message: 'AI connections cannot change AI access.' }, 403)
    const actor = await this.opts.authenticatePerson(req)
    if (actor === 'not_found') return json({ error: 'not_found', message: 'not found' }, 404)
    if (!actor) return json({ error: 'unauthorized', message: 'sign in' }, 401)
    const full = { ...actor, ip: actor.ip ?? this.opts.clientIp?.(req), userAgent: actor.userAgent ?? req.headers.get('user-agent') ?? undefined }
    return withWorkspace(full.workspaceId, () => this.control(req, sub, url, full))
  }

  private async control(req: Request, sub: string, url: URL, full: PersonActor): Promise<Response> {
    const c = this.service.control
    const body = async (): Promise<Record<string, unknown>> => {
      if (!/^application\/json\b/i.test(req.headers.get('content-type') ?? '')) throw new ToolError('invalid', 'send application/json')
      const v = (await req.json()) as unknown
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ToolError('invalid', 'body must be a JSON object')
      return v as Record<string, unknown>
    }
    const m = (re: RegExp) => re.exec(sub)
    let r: RegExpExecArray | null
    const M = req.method

    if (M === 'GET' && sub === '/grants') return json({ grants: await c.listGrants(full, { includeRevoked: url.searchParams.get('include_revoked') === 'true' }) })
    if (M === 'POST' && sub === '/grants/propose') {
      const b = await body()
      return json(await c.proposeGrant(full, String(b.client_name ?? 'AI'), b.shape ? parseShape(b.shape) : undefined))
    }
    if ((r = m(/^\/grants\/([^/]+)$/))) {
      const id = decodeURIComponent(r[1]!)
      if (M === 'GET') return json(await c.describeGrant(full, id))
      if (M === 'PATCH') return json({ grant: await c.updateGrant(full, id, parseShape((await body()).shape)) })
      if (M === 'DELETE') return (await c.revokeGrant(full, id), json({ ok: true }))
    }
    if (M === 'POST' && sub === '/keys') {
      const b = await body()
      const created = await c.createAgentKey(full, { name: String(b.name ?? ''), shape: parseShape(b.shape), ipAllowlist: Array.isArray(b.ip_allowlist) ? b.ip_allowlist.map(String) : undefined })
      return json(created, 201)
    }
    if ((r = m(/^\/keys\/([^/]+)$/)) && M === 'DELETE') return (await c.revokeAgentKey(full, decodeURIComponent(r[1]!)), json({ ok: true }))
    if (M === 'GET' && sub === '/settings') return json(await c.aiSettings(full))
    if (M === 'POST' && sub === '/pause') return (await c.pauseAll(full), json({ ok: true, paused: true }))
    if (M === 'POST' && sub === '/resume') return (await c.resumeAll(full), json({ ok: true, paused: false }))
    if (M === 'PUT' && sub === '/settings/review-mode') {
      const mode = (await body()).mode
      if (mode !== 'instant' && mode !== 'review_all') throw new ToolError('invalid', 'mode must be instant or review_all')
      return (await c.setReviewDefault(full, mode), json({ ok: true }))
    }
    if (M === 'GET' && sub === '/activity') {
      const n = (k: string) => (url.searchParams.get(k) ? Number(url.searchParams.get(k)) : undefined)
      return json({ activity: await c.activity(full, { grantId: url.searchParams.get('grant_id') ?? undefined, limit: n('limit'), beforeSeq: n('before_seq') }) })
    }
    if (M === 'GET' && sub === '/activity/verify') return json(await c.verifyActivity(full))
    if (M === 'GET' && sub === '/review') return json({ pending: await c.pendingWrites(full) })
    if ((r = m(/^\/review\/([^/]+)\/(approve|reject)$/)) && M === 'POST') {
      const id = decodeURIComponent(r[1]!)
      if (r[2] === 'approve') return json(await c.approveWrite(full, id))
      const note = req.headers.get('content-type') ? (await body()).note : undefined
      return (await c.rejectWrite(full, id, typeof note === 'string' ? note : undefined), json({ ok: true }))
    }
    if (M === 'POST' && sub === '/undo') {
      const b = await body()
      return (await c.undo(full, { writeId: typeof b.write_id === 'string' ? b.write_id : undefined, recordId: typeof b.record_id === 'string' ? b.record_id : undefined }), json({ ok: true }))
    }
    return json({ error: 'not_found', message: 'not found' }, 404)
  }
}

const shapeSchema = z.object({
  entity_ids: z.union([z.literal('all'), z.array(z.string().min(1).max(64)).max(500)]),
  data_types: z.array(z.enum(['balances', 'transactions', 'invoices', 'bills', 'buckets', 'payroll', 'equity', 'documents', 'reports', 'personal'])).min(1),
  write: z.boolean(),
  review_mode: z.enum(['instant', 'review_all']).default('instant'),
  daily_write_cap: z.number().int().optional(),
  expires_at: z.string().datetime().nullable(),
})

const camelShapeSchema = z.object({
  entityIds: z.union([z.literal('all'), z.array(z.string().min(1).max(64)).max(500)]),
  dataTypes: z.array(z.enum(['balances', 'transactions', 'invoices', 'bills', 'buckets', 'payroll', 'equity', 'documents', 'reports', 'personal'])).min(1),
  write: z.boolean(),
  reviewMode: z.enum(['instant', 'review_all']).default('instant'),
  dailyWriteCap: z.number().int().optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
})

/** Grant shape from the web UI (contracts GrantShape, camelCase). */
export function parseGrantShape(v: unknown): GrantShape {
  const r = camelShapeSchema.safeParse(v)
  if (!r.success) throw new ToolError('invalid', `Invalid access settings: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  return { entityIds: r.data.entityIds, dataTypes: r.data.dataTypes, write: r.data.write, reviewMode: r.data.reviewMode, dailyWriteCap: r.data.dailyWriteCap, expiresAt: r.data.expiresAt }
}

/** Grant shape from JSON (snake_case on the wire). */
export function parseShape(v: unknown): GrantShape {
  const r = shapeSchema.safeParse(v)
  if (!r.success) throw new ToolError('invalid', `Invalid access settings: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  return { entityIds: r.data.entity_ids, dataTypes: r.data.data_types, write: r.data.write, reviewMode: r.data.review_mode, dailyWriteCap: r.data.daily_write_cap, expiresAt: r.data.expires_at }
}
