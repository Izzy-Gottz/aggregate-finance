// One service layer behind MCP, REST and stdio: authenticate → list tools for this grant → call a tool.
// MCP tools and REST routes are thin wrappers over callTool, so the three surfaces can't drift apart.

import * as z from 'zod/v4'
import type { DataType } from '@agfn/contracts'
import { appendActivity } from './activity.ts'
import { ControlApi } from './control.ts'
import { perfEnabled, perfLine, withBypass, withPerf, withWorkspace } from '@agfn/db'
import { dataLabel, defaultGrantShape, grantState, PUBLIC_DEMO_CLIENT } from './grants.ts'
import { hashKey, looksLikeAgentKey } from './keys.ts'
import { systemClock, type Clock, type ConnectPort, type ControlHooks, type FinanceReader, type FreshnessAspect, type LiveBalancePort, type SharePort, type SourceEntry, type SourcesPort, type McpTokenVerifier, type PeopleDirectory, type RecordWriter } from './ports.ts'
import { DEFAULT_RATE_LIMITS, MemoryRateLimiter, type RateLimiter, type RateLimits } from './ratelimit.ts'
import { Access, ToolError, type Principal } from './scope.ts'
import { safeLabel } from './untrusted.ts'
import { ControlStore, type McpDb } from './store/store.ts'
import type { AgentKeysTable } from './store/schema.ts'
import type { ToolContext, ToolDef, ToolOutput } from './tools/common.ts'
import { READ_TOOLS, READ_WITH_SET_ASIDES } from './tools/read.ts'
import { LIVE_TOOLS } from './tools/live.ts'
import { WRITE_TOOLS, WRITE_WITH_SET_ASIDES } from './tools/write.ts'
import { SHARE_TOOLS } from './tools/share.ts'
import { CONNECT_TOOLS } from './tools/connect.ts'
import { WritePipeline } from './writes.ts'
import { AiUi } from './ui.ts'

/** Fixed order (cache-friendly for clients, MCP 2026-07-28). */
export const ALL_TOOLS: readonly ToolDef[] = [...READ_TOOLS, ...LIVE_TOOLS, ...WRITE_TOOLS, ...SHARE_TOOLS]
const SET_ASIDE_OVERLAY = new Map([...READ_WITH_SET_ASIDES, ...WRITE_WITH_SET_ASIDES].map((t) => [t.name, t]))
/** The same tools with set-asides on (AGFN_SET_ASIDES): same names and order, wider inputs. */
export const TOOLS_WITH_SET_ASIDES: readonly ToolDef[] = ALL_TOOLS.map((t) => SET_ASIDE_OVERLAY.get(t.name) ?? t)

/** The public no-sign-up demo's one connection (apps/server/src/public-demo.ts). Read-only, and never reaches outside. */
export { PUBLIC_DEMO_CLIENT }
export const PUBLIC_DEMO_READ_ONLY = 'This is Aggregate’s public demo, so it’s read-only. Connect your own books at aggregate.finance to record changes.'
/** Tools that reach a bank, processor, mailbox or webhook, or create something to publish: never run for the public demo. */
const PUBLIC_DEMO_REFUSED = new Set(['refresh_balance', 'share_answer'])
const isPublicDemo = (p: Principal) => p.grant.clientId === PUBLIC_DEMO_CLIENT
const DEMO_READ_TTL_MS = 60_000
const DEMO_READ_MAX = 500
const DEMO_READ_MAX_ROWS = 1_000
const DEMO_READ_MAX_BYTES = 256_000

/** JSON with object keys sorted, so the same arguments in any order are one cache key. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v) ?? 'null'
}

export const SCOPES = { read: 'finance:read', write: 'records:write' } as const

/** Reads that aren't data answers (no numbers), so they carry no `sources` block or "Data as of" line. */
const NO_SOURCES = new Set(['whoami', 'connect_source', 'share_answer'])

/** Which provider timestamp a read leans on, so the host picks the matching freshness field. */
export function aspectFor(tool: string): FreshnessAspect {
  if (tool === 'get_holdings') return 'investments'
  if (['query_transactions', 'search_transactions', 'query_invoices', 'search_invoices', 'list_upcoming', 'list_recurring', 'get_mrr_movements', 'get_record', 'get_counterparty', 'get_activity', 'get_payroll'].includes(tool)) return 'transactions'
  if (['list_accounts', 'get_coverage', 'get_liabilities', 'get_owner_balance', 'list_buckets', 'get_bucket', 'get_cap_table'].includes(tool)) return 'balances'
  return 'overview'
}

/** A short "how long ago" for the summary line; the `sources` block carries the exact ISO times. */
export function freshnessAgo(iso: string | null, now: Date): string {
  if (!iso) return 'time unknown'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 'time unknown'
  const mins = Math.round((now.getTime() - t) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  if (days < 7) return `${days}d ago`
  return new Date(t).toISOString().slice(0, 10)
}

/** Plain-words versions of the Plaid Item error codes a person can act on; unknown codes fall back to the raw code. */
const CODE_WORDS: Record<string, string> = {
  ITEM_LOGIN_REQUIRED: 'you may need to reconnect it',
  PENDING_EXPIRATION: 'the connection will expire soon — reconnect it',
  PENDING_DISCONNECT: 'the bank is ending this connection — reconnect it',
  USER_SETUP_REQUIRED: 'the bank needs you to finish setup on their site',
  INSTITUTION_DOWN: 'the bank was temporarily down',
  INSTITUTION_NOT_RESPONDING: 'the bank was not responding',
  INSTITUTION_NO_LONGER_SUPPORTED: 'this institution is no longer supported',
  INTERNAL_SERVER_ERROR: 'a temporary provider error',
}
function plainCode(code: string): string {
  return /^[A-Z0-9_]{1,64}$/.test(code) ? (CODE_WORDS[code] ?? code) : ''
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** A plain-English day like "Nov 3" (adds the year when it isn't the current one), from a 'YYYY-MM-DD' date. */
function friendlyDay(iso: string, now: Date): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return iso
  const base = `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`
  return Number(m[1]) === now.getUTCFullYear() ? base : `${base}, ${m[1]}`
}

/** The one compact line that ends a read answer's summary: how current each source behind it is. */
export function dataAsOfLine(entries: SourceEntry[], now: Date): string {
  const parts = entries.slice(0, 6).map((e) => {
    const refresh = e.typical_refresh ? ` (${e.typical_refresh})` : ''
    const staleMark = e.stale ? ' — stale' : ''
    // A stuck source: the last refresh failed after the last success. Lead with the failure; fall back to the last
    // good data as "data from"; add a plain-words reason when the provider gave an error code.
    if (e.refresh_failed_at) {
      const good = e.refresh_last_good ? `; data from ${friendlyDay(e.refresh_last_good, now)}` : '; no good data yet'
      const why = e.error_code ? plainCode(e.error_code) : ''
      return `${e.source}: last refresh failed ${friendlyDay(e.refresh_failed_at, now)}${good}${why ? ` — ${why}` : ''}`
    }
    if (e.kind === 'live') return `${e.source} live, checked ${freshnessAgo(e.last_checked, now)}${staleMark}`
    // A cached source with no provider time: show when WE checked, but never imply that's the source's own data time.
    if (e.kind === 'cached' && !e.data_as_of) return `${e.source}: checked ${freshnessAgo(e.last_checked, now)} (its own update time not reported yet)${staleMark}`
    // A file (statement) source's data_as_of is the statement closing date, not an elapsed time — say so plainly.
    if (e.kind === 'file' && e.data_as_of) return `${e.source}: statements through ${e.data_as_of.slice(0, 10)}${staleMark}`
    // Manual sources are hand-keyed: dated by the last entry, never sync-stale, but flag plainly when the entry is old.
    if (e.kind === 'manual') {
      if (!e.data_as_of) return `${e.source}: no entries yet`
      const old = now.getTime() - Date.parse(e.data_as_of) > 30 * 86_400_000
      return `${e.source}: as of your last entry, ${friendlyDay(e.data_as_of, now)}${old ? ' (over a month ago)' : ''}`
    }
    return `${e.source} ${freshnessAgo(e.data_as_of ?? e.last_checked, now)}${refresh}${staleMark}`
  })
  const more = entries.length > 6 ? ` · +${entries.length - 6} more` : ''
  return `Data as of: ${parts.join(' · ')}${more}.`
}

export interface AgfnMcpDeps {
  db: McpDb
  reader: FinanceReader
  writer: RecordWriter
  people: PeopleDirectory
  /** OAuth access-token verification (S0). Omit for key-only deployments (local stdio). */
  verifier?: McpTokenVerifier
  hooks?: ControlHooks
  clock?: Clock
  rateLimiter?: RateLimiter
  rateLimits?: Partial<RateLimits>
  /** Live bank balance checks (refresh_balance). */
  liveBalance?: LiveBalancePort
  /** Drafting share cards (share_answer). Unset = the tool isn't offered (AGFN_MCP_SHARE=1 wires it). */
  share?: SharePort
  /** The prompt packs (packs.ts) next to the three guided prompts (AGFN_MCP_PROMPTS=1). */
  promptPacks?: boolean
  /** get_investments (AGFN_TOOL_INVESTMENTS=1); also names equity "the cap table and investments". Off until both directory reviews close. */
  investments?: boolean
  /** Set-asides in the bucket tools, and available_cash (AGFN_SET_ASIDES=1). Off until the directory reviews close: it changes tools/list. */
  setAsides?: boolean
  /** connect_source, minting connect-from-chat links (AGFN_CONNECT_FROM_CHAT=1). Needs `connect`; off until the directory reviews close and Yisrael says yes, because it adds a tool to tools/list. */
  connectFromChat?: boolean
  /** The host's connect-from-chat implementation (apps/server/src/connect-source.ts). Without it connect_source isn't offered even with the flag. */
  connect?: ConnectPort
  /** Per-source freshness for the `sources` block + "Data as of" line on every read (apps/server/src/freshness.ts). Without it, reads carry no sources block. */
  sources?: SourcesPort
  /** The app's address, for approval links in held writes (BASE_URL). */
  appUrl?: string
}

export interface RequestMeta {
  ip?: string
  userAgent?: string
  /** The canonical MCP resource URL (RFC 8707 audience), e.g. https://you.example/mcp. */
  resource: string
}

export type AuthOutcome = { ok: true; principal: Principal } | { ok: false; status: 401 | 403; error: 'invalid_token' | 'insufficient_scope'; description: string }

export type CallOutcome = { ok: true; output: ToolOutput } | { ok: false; error: ToolError }

const TOUCH_EVERY_MS = 60_000

export class AgfnMcp {
  readonly store: ControlStore
  /** Public demo calls since boot, by "tool:status" (log() keeps no rows for them). */
  readonly publicDemoCounts = new Map<string, number>()
  readonly access: Access
  readonly pipeline: WritePipeline
  readonly control: ControlApi
  /** View models for the web UI (S8). */
  readonly ui: AiUi
  readonly reader: FinanceReader
  readonly people: PeopleDirectory
  readonly clock: Clock
  private readonly verifier: McpTokenVerifier | undefined
  private readonly hooks: ControlHooks | undefined
  private readonly liveBalance: LiveBalancePort | undefined
  private readonly share: SharePort | undefined
  readonly connect: ConnectPort | undefined
  private readonly sources: SourcesPort | undefined
  /** share_answer is wired (AGFN_MCP_SHARE=1). */
  get offersShare(): boolean {
    return !!this.share
  }
  /** connect_source is wired (AGFN_CONNECT_FROM_CHAT=1 and a ConnectPort). */
  readonly offersConnectFromChat: boolean
  readonly appUrl: string | undefined
  /** The prompt packs are listed (AGFN_MCP_PROMPTS=1). */
  readonly offersPromptPacks: boolean
  readonly offersInvestments: boolean
  readonly offersSetAsides: boolean
  readonly tools: readonly ToolDef[]
  private readonly limiter: RateLimiter
  private readonly limits: RateLimits
  private readonly touched = new Map<string, number>()

  constructor(deps: AgfnMcpDeps) {
    this.clock = deps.clock ?? systemClock
    this.store = new ControlStore(deps.db)
    this.reader = deps.reader
    this.people = deps.people
    this.verifier = deps.verifier
    this.hooks = deps.hooks
    this.liveBalance = deps.liveBalance
    this.share = deps.share
    this.connect = deps.connect
    this.sources = deps.sources
    this.appUrl = deps.appUrl?.replace(/\/+$/, '')
    this.offersPromptPacks = deps.promptPacks === true
    this.offersInvestments = deps.investments === true
    this.offersSetAsides = deps.setAsides === true
    this.offersConnectFromChat = deps.connectFromChat === true && !!deps.connect
    // Compose, don't swap: the set-asides overlay and connect_source are independent. Off → the tool set is unchanged,
    // so tools/list stays frozen for the directory reviews; each flag adds only its own.
    const base = this.offersSetAsides ? TOOLS_WITH_SET_ASIDES : ALL_TOOLS
    this.tools = this.offersConnectFromChat ? [...base, ...CONNECT_TOOLS] : base
    this.access = new Access(deps.reader, deps.people, this.clock)
    this.pipeline = new WritePipeline({ store: this.store, reader: deps.reader, writer: deps.writer, people: deps.people, clock: this.clock, hooks: deps.hooks })
    this.control = new ControlApi({ store: this.store, reader: deps.reader, people: deps.people, pipeline: this.pipeline, clock: this.clock, hooks: deps.hooks, ...(this.offersInvestments ? { investments: true } : {}) })
    this.ui = new AiUi({ store: this.store, control: this.control, pipeline: this.pipeline, reader: deps.reader, people: deps.people, ...(this.offersSetAsides ? { setAsides: true } : {}) })
    this.limiter = deps.rateLimiter ?? new MemoryRateLimiter()
    this.limits = { ...DEFAULT_RATE_LIMITS, ...deps.rateLimits }
  }

  get issuer(): string | undefined {
    return this.verifier?.issuer
  }

  // ---------- authentication ----------

  /** Bearer token → principal. Agent keys (agfn_live_…) are verified here; anything else goes to the OAuth verifier. */
  async authenticate(token: string, meta: RequestMeta): Promise<AuthOutcome> {
    const now = this.clock.now()
    const invalid = (description: string): AuthOutcome => ({ ok: false, status: 401, error: 'invalid_token', description })
    if (!token || token.length > 4096) return invalid('missing token')

    if (token.startsWith('agfn_')) {
      if (!looksLikeAgentKey(token)) return invalid('malformed agent key')
      // Found by its hash before the workspace is known: a narrow named bypass, then everything else inside it.
      const key = await withBypass('auth:agent-key', () => this.store.findKeyByHash(hashKey(token)))
      if (!key || key.revoked_at) return invalid('unknown or revoked key')
      return withWorkspace(key.workspace_id, () => this.authenticateKey(key, meta, now))
    }

    if (!this.verifier) return invalid('OAuth is not configured on this server; use an agent key')
    const v = await this.verifier.verifyAccessToken(token, meta.resource)
    if (!v) return invalid('invalid, expired or wrong-audience token')
    return withWorkspace(v.workspaceId, () => this.authenticateOauth(v, meta, now))
  }

  private async authenticateKey(key: AgentKeysTable, meta: RequestMeta, now: Date): Promise<AuthOutcome> {
    const invalid = (description: string): AuthOutcome => ({ ok: false, status: 401, error: 'invalid_token', description })
      if (key.expires_at && Date.parse(key.expires_at) <= now.getTime()) return invalid('key expired')
      if (key.ip_allowlist_json) {
        const allowed = JSON.parse(key.ip_allowlist_json) as string[]
        if (!meta.ip || !allowed.includes(meta.ip)) return { ok: false, status: 403, error: 'insufficient_scope', description: 'this key is not allowed from this address' }
      }
      const grant = await this.store.getGrant(key.workspace_id, key.grant_id)
      if (!grant || grantState(grant, now) !== 'active') return invalid('access revoked or expired')
      if (this.hooks?.personAllowed && !(await this.hooks.personAllowed(grant.workspaceId, grant.personId))) return invalid('access revoked or expired')
      await this.touch(`k:${key.id}`, () => this.store.touchKey(key.id, now.toISOString()))
      await this.touch(`g:${grant.id}`, () => this.store.touchGrant(grant.id, now.toISOString()))
      return { ok: true, principal: { workspaceId: grant.workspaceId, personId: grant.personId, grant, via: 'key', keyId: key.id, label: await this.label(grant.clientName, grant.personId), scopes: grantScopes(grant.write), ip: meta.ip, userAgent: meta.userAgent } }
  }

  private async authenticateOauth(v: NonNullable<Awaited<ReturnType<McpTokenVerifier['verifyAccessToken']>>>, meta: RequestMeta, now: Date): Promise<AuthOutcome> {
    const invalid = (description: string): AuthOutcome => ({ ok: false, status: 401, error: 'invalid_token', description })
    const grant = await this.store.getGrantById(v.grantId)
    if (!grant || grant.personId !== v.personId || grant.workspaceId !== v.workspaceId) return invalid('token does not match a grant')
    if (grantState(grant, now) !== 'active') return invalid('access revoked or expired')
    if (this.hooks?.personAllowed && !(await this.hooks.personAllowed(grant.workspaceId, grant.personId))) return invalid('access revoked or expired')
    if (!v.scopes.includes(SCOPES.read) && !v.scopes.includes(SCOPES.write)) return { ok: false, status: 403, error: 'insufficient_scope', description: `requires ${SCOPES.read}` }
    await this.touch(`g:${grant.id}`, () => this.store.touchGrant(grant.id, now.toISOString()))
    return { ok: true, principal: { workspaceId: grant.workspaceId, personId: grant.personId, grant, via: 'oauth', label: await this.label(v.clientName || grant.clientName, grant.personId), scopes: v.scopes, ip: meta.ip, userAgent: meta.userAgent } }
  }

  /**
   * Demo mode: give a demo workspace one AI connection with a little real history (a read and a write through
   * callTool, so the activity log, write request and provenance are all genuine). Refused unless the workspace is
   * flagged demo. Safe to call again: the write is idempotent and an existing demo grant is reused.
   */
  async seedDemoAi(input: { workspaceId: string; personId: string; clientName?: string; write: { company: string; amount: string; currency: string; date: string; counterparty: string; description: string } }): Promise<{ grantId: string; writeStatus: string }> {
    const actor = { workspaceId: input.workspaceId, personId: input.personId }
    const clientName = input.clientName ?? 'Claude'
    const existing = (await this.store.listGrants(input.workspaceId)).find((g) => g.clientId === 'demo' && g.personId === input.personId && !g.revokedAt)
    const grant = existing ?? (await this.control.createDemoGrant(actor, { clientName, shape: { ...defaultGrantShape(this.clock.now()), write: true, reviewMode: 'instant' } }))
    const principal: Principal = { workspaceId: grant.workspaceId, personId: grant.personId, grant, via: 'oauth', label: await this.label(grant.clientName, grant.personId), scopes: grantScopes(true) }
    const read = await this.callTool(principal, 'get_metric', { metric: 'cash', company: input.write.company })
    if (!read.ok) throw read.error
    const w = input.write
    const r = await this.callTool(principal, 'add_entry', { company: w.company, kind: 'cash_income', amount: { amount: w.amount, currency: w.currency }, date: w.date, paid_by: w.company, counterparty: w.counterparty, description: w.description, idempotency_key: `demo-seed-${grant.id}`, reason: 'Demo data' })
    if (!r.ok) throw r.error
    return { grantId: grant.id, writeStatus: String(r.output.data.status) }
  }

  private async label(client: string, personId: string): Promise<string> {
    return `${client} · ${await this.people.displayName(personId)}`
  }

  private async touch(key: string, fn: () => Promise<void>): Promise<void> {
    const now = this.clock.now().getTime()
    const last = this.touched.get(key) ?? 0
    if (now - last < TOUCH_EVERY_MS) return
    this.touched.set(key, now)
    await fn()
  }

  // ---------- tool listing ----------

  /** Tools this principal may call. `withData` also hides read tools with nothing behind them (MASTER §7). */
  /**
   * What tools/list advertises: every tool this server can run, the same for every connection. Directories (Claude,
   * ChatGPT) list a connector from one snapshot of tools/list, so it must not depend on the grant or on data present.
   * Access is decided per call (allowedTools, re-read on every call); a tool outside the grant is refused with why.
   */
  async listTools(p?: Principal): Promise<ToolDef[]> {
    // The public demo never lists connect_source: it's read-only and would refuse it at call time anyway, and this keeps
    // the /demo/mcp tools/list (the directory gate's snapshot) stable even once AGFN_CONNECT_FROM_CHAT is on there.
    const hideForDemo = p && isPublicDemo(p)
    return this.tools.filter((t) => this.serverCan(t) && !(hideForDemo && t.requires === 'connect'))
  }

  /** Tools that need a capability this server lacks (live balance, coverage…) can't run for anyone. */
  private serverCan(t: ToolDef): boolean {
    if (t.requires === 'liveBalance' && !this.liveBalance) return false
    if (t.requires === 'share' && !this.share) return false
    if (t.requires === 'investments' && !(this.offersInvestments && typeof this.reader.investments === 'function')) return false
    if (t.requires === 'coverage' && typeof this.reader.coverage !== 'function') return false
    if (t.requires === 'liabilities' && typeof this.reader.liabilities !== 'function') return false
    if (t.requires === 'holdings' && typeof this.reader.holdings !== 'function') return false
    if (t.requires === 'mrrMovements' && typeof this.reader.mrrMovements !== 'function') return false
    if (t.requires === 'connect' && !(this.offersConnectFromChat && this.connect)) return false
    return true
  }

  /** What this connection may call: its grant's data types, write access and scopes (and, withData, data present). */
  async allowedTools(p: Principal, opts: { withData: boolean } = { withData: true }): Promise<ToolDef[]> {
    const g = p.grant
    const canWriteScope = p.via === 'key' || p.scopes.includes(SCOPES.write)
    let available: Set<DataType> | null = null
    if (opts.withData) {
      const ents = await this.access.anyVisible(p)
      available = new Set(ents.length ? await this.reader.dataAvailability({ workspaceId: p.workspaceId, entityIds: ents.map((e) => e.id) }) : [])
    }
    return this.tools.filter((t) => {
      if (t.requires === 'liveBalance' && !this.liveBalance) return false
    if (t.requires === 'share' && !this.share) return false
      if (t.requires === 'investments' && !(this.offersInvestments && typeof this.reader.investments === 'function')) return false
      if (t.requires === 'coverage' && typeof this.reader.coverage !== 'function') return false
      if (t.requires === 'liabilities' && typeof this.reader.liabilities !== 'function') return false
      if (t.requires === 'holdings' && typeof this.reader.holdings !== 'function') return false
      if (t.requires === 'mrrMovements' && typeof this.reader.mrrMovements !== 'function') return false
      if (t.requires === 'connect' && !(this.offersConnectFromChat && this.connect)) return false
      if (t.listWhen === 'always') return true
      const granted = t.dataTypes.filter((d) => g.dataTypes.includes(d))
      if (!granted.length) return false
      if (t.kind === 'write' && (!g.write || !canWriteScope)) return false
      if (t.listWhen === 'grant_and_data' && available && !granted.some((d) => available!.has(d))) return false
      return true
    })
  }

  /** A plain reason a listed tool is refused for this connection. */
  private whyNot(p: Principal, t: ToolDef): string {
    const canWriteScope = p.via === 'key' || p.scopes.includes(SCOPES.write)
    if (isPublicDemo(p) && (t.kind === 'write' || PUBLIC_DEMO_REFUSED.has(t.name))) return PUBLIC_DEMO_READ_ONLY
    if (t.kind === 'write' && t.dataTypes.some((d) => p.grant.dataTypes.includes(d)) && (!p.grant.write || !canWriteScope)) return `This connection is read-only, so it can't use ${t.name}.`
    const missing = t.dataTypes.filter((d) => !p.grant.dataTypes.includes(d)).map((d) => dataLabel(d, { investments: this.offersInvestments }))
    return `This connection can't see ${missing.join(' or ') || 'that data'}, so it can't use ${t.name}. Ask the owner to allow it.`
  }

  // ---------- tool calls ----------

  async callTool(principal: Principal, name: string, rawArgs: unknown): Promise<CallOutcome> {
    // Every query a tool makes runs in the principal's workspace (row-level security prototype; inert unless AGFN_PG_RLS=1).
    const run = () => withWorkspace(principal.workspaceId, () => this.callToolIn(principal, name, rawArgs))
    if (!perfEnabled()) return run()
    // AGFN_PERF_LOG=1: what each tool call cost in the database (statements, lock and pool waits), never its arguments.
    const r = await withPerf(run)
    console.info(`[agfn] perf tool ${name}: ${perfLine(r, { ok: r.value.ok ? 'yes' : 'no' })}`)
    return r.value
  }

  private async callToolIn(principal: Principal, name: string, rawArgs: unknown): Promise<CallOutcome> {
    const started = this.clock.now()
    // Re-read the grant on every call: a revoke, narrowing or expiry applies to long-lived (stdio) sessions at once.
    const fresh = await this.store.getGrant(principal.workspaceId, principal.grant.id)
    if (!fresh || grantState(fresh, started) !== 'active') {
      return { ok: false, error: new ToolError('forbidden', 'This connection was revoked or has expired.', 'Reconnect Aggregate to continue.') }
    }
    const p: Principal = { ...principal, grant: fresh }
    // The public demo: no write and nothing that reaches outside Aggregate runs, whatever its grant says.
    if (isPublicDemo(p)) {
      const def = this.tools.find((t) => t.name === name)
      if (def && (def.kind === 'write' || PUBLIC_DEMO_REFUSED.has(def.name) || def.hints?.openWorldHint)) {
        await this.log(p, name, undefined, started, { status: 'denied' })
        return { ok: false, error: new ToolError('forbidden', PUBLIC_DEMO_READ_ONLY) }
      }
    }
    const tool = (await this.allowedTools(p, { withData: false })).find((t) => t.name === name)
    const fail = async (error: ToolError, args?: unknown): Promise<CallOutcome> => {
      await this.log(p, name, args, started, { status: error.code === 'forbidden' || error.code === 'paused' ? 'denied' : 'error', detail: error.message })
      return { ok: false, error }
    }
    if (!tool) {
      const def = this.tools.find((t) => t.name === name)
      if (!def || !this.serverCan(def)) return fail(new ToolError('not_found', `Unknown tool ${name}.`))
      return fail(new ToolError('forbidden', this.whyNot(p, def), 'Tell the user; the owner can change what this connection may do in Aggregate under Connect your AI.'))
    }

    const settings = await this.store.getAiSettings(p.workspaceId)
    if (settings.paused_at && name !== 'whoami') return fail(new ToolError('paused', 'The owner has paused all AI access to Aggregate.', 'Tell the user; they can resume it in Aggregate under Connect your AI.'))
    if (p.grant.pausedAt && name !== 'whoami') return fail(new ToolError('paused', 'The owner has paused this connection.', 'Tell the user; they can resume it in Aggregate under Connect your AI.'))

    // The public demo's one connection is shared by every visitor: its limits are per visitor, at the door (/demo/mcp).
    const retry = isPublicDemo(p)
      ? 0
      : tool.kind === 'read'
        ? (await this.limiter.hit(`r:${p.grant.id}`, this.limits.readsPerMinute, 60_000, started.getTime())) ||
          (await this.limiter.hit(`rh:${p.grant.id}`, this.limits.readsPerHour, 3_600_000, started.getTime()))
        : await this.limiter.hit(`w:${p.grant.id}`, this.limits.writesPerHour, 3_600_000, started.getTime())
    if (retry) return fail(new ToolError('rate_limited', `Too many ${tool.kind === 'read' ? 'reads' : 'writes'}; try again in ${retry}s.`, tool.kind === 'read' ? 'Use fewer, broader calls (get_overview, sums in search results).' : undefined))

    // Unknown arguments used to be dropped without a word, so a filter the model meant (account_id, direction) silently
    // didn't apply and the total covered everything. Refuse them with where the filter goes instead.
    // The filters models reach for first (account_id, direction, category…) are read into the query, and the answer says
    // so; only what has no meaning here is refused.
    const mapped = mapFilterArgs(tool, rawArgs)
    rawArgs = mapped.args
    const unknown = unknownArgs(tool, rawArgs)
    if (unknown.length) console.info('[agfn] mcp unknown-arg', { tool: name, args: unknown.map((k) => k.slice(0, 40)).join(',') })
    if (unknown.length) return fail(new ToolError('invalid', `Unknown argument${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`, argHint(tool, unknown)), rawArgs)

    const parsed = tool.input.safeParse(rawArgs ?? {})
    if (!parsed.success) return fail(new ToolError('invalid', `Invalid arguments: ${formatIssues(parsed.error)}`), rawArgs)

    const ctx: ToolContext = { principal: p, ...(this.offersSetAsides ? { setAsides: true } : {}), access: this.access, reader: this.reader, pipeline: this.pipeline, store: this.store, clock: this.clock, ...(this.liveBalance ? { liveBalance: this.liveBalance } : {}), ...(this.share ? { share: this.share } : {}), ...(this.offersConnectFromChat && this.connect ? { connect: this.connect } : {}), ...(this.offersInvestments ? { investments: true } : {}), ...(this.appUrl ? { appUrl: this.appUrl } : {}) }
    try {
      const output = isPublicDemo(p) && tool.kind === 'read' ? await this.#demoRead(p, name, parsed.data, () => tool.run(ctx, parsed.data)) : await tool.run(ctx, parsed.data)
      // Writes log themselves in the pipeline (with the outcome); reads log here.
      if (tool.kind === 'read') await this.log(p, name, parsed.data, started, { status: 'ok', rows: output.rows ?? null, entityIds: output.entityIds })
      const extra = [...mapped.notes]
      // "all" means the companies; say so when a Personal space was left out, so "what did <name> pay in rent" can find it.
      if (this.access.leftOutPersonal(p)) extra.push(`Personal (${await this.people.displayName(p.personId)}'s own money) is left out of "all"; name company "Personal" to include it.`)
      if (extra.length) {
        const prior = Array.isArray(output.data.notes) ? (output.data.notes as unknown[]) : []
        output.data = { ...output.data, notes: [...prior, ...extra] }
        output.summary = `${output.summary} ${extra.join(' ')}`
      }
      // Per-source freshness on every data read: the shared `sources` block plus a closing "Data as of" line, so the AI
      // can always say how current each source is. The public demo's books are synthetic, so it carries none.
      if (this.sources && tool.kind === 'read' && !isPublicDemo(p) && !NO_SOURCES.has(name)) {
        const scopeIds = output.entityIds?.length ? output.entityIds : (await this.access.anyVisible(p)).map((e) => e.id)
        const raw = await this.sources.forEntities({ workspaceId: p.workspaceId, entityIds: scopeIds, aspect: aspectFor(name) }).catch(() => [] as SourceEntry[])
        // source and institution carry provider-set text: clean and flag it like any other third-party label, so an
        // injected institution name can't reach the AI unmarked (redteam §1).
        const entries = raw.map((e) => ({ ...e, source: safeLabel(e.source, 'counterparty_name') ?? e.source, institution: e.institution == null ? null : safeLabel(e.institution, 'counterparty_name') ?? null }))
        if (entries.length) {
          output.data = { ...output.data, sources: entries }
          output.summary = `${output.summary} ${dataAsOfLine(entries, this.clock.now())}`
        }
      }
      return { ok: true, output }
    } catch (err) {
      if (err instanceof ToolError) return fail(err, parsed.data)
      // The ledger's query parser explains what's wrong with a search in words an AI can fix.
      if (err instanceof Error && err.name === 'QueryError') return fail(new ToolError('invalid', `Query: ${err.message}.`, QUERY_HINT), parsed.data)
      await this.log(p, name, parsed.data, started, { status: 'error', detail: 'internal error' })
      throw err
    }
  }

  /**
   * The public demo's reads, kept for DEMO_READ_TTL_MS per (demo workspace, tool, arguments). Every visitor runs as the
   * same read-only principal on the same books, so the answers are the same; computing each one per visitor made demo
   * traffic queue real people's reads on the database pool (f8's launch-load test: get_overview p95 0.7 s → 5–6.6 s).
   * The workspace comes from the pointer, so the nightly swap starts fresh keys, and an hourly re-sync shows within the
   * TTL. Reads only (writes and the refused tools never get here). Each caller gets its own copy.
   */
  readonly #demoReads = new Map<string, { at: number; value: Promise<ToolOutput> }>()

  async #demoRead(p: Principal, tool: string, args: unknown, run: () => Promise<ToolOutput>): Promise<ToolOutput> {
    const now = this.clock.now().getTime()
    const key = `${p.workspaceId}|${tool}|${canonicalJson(args)}`
    let hit = this.#demoReads.get(key)
    if (!hit || now - hit.at >= DEMO_READ_TTL_MS) {
      hit = { at: now, value: run() }
      const mine = hit
      const drop = () => this.#demoReads.get(key) === mine && this.#demoReads.delete(key)
      // A big answer (a long transaction search) is served but not kept: 500 of them would be tens of MB per machine.
      hit.value.then((o) => ((o.rows ?? 0) > DEMO_READ_MAX_ROWS || JSON.stringify(o).length > DEMO_READ_MAX_BYTES) && drop(), drop)
      this.#demoReads.delete(key)
      this.#demoReads.set(key, hit)
      // Oldest first: arguments are the visitor's, so keep the map bounded.
      while (this.#demoReads.size > DEMO_READ_MAX) this.#demoReads.delete(this.#demoReads.keys().next().value as string)
    }
    return structuredClone(await hit.value)
  }

  private async log(p: Principal, tool: string, args: unknown, started: Date, e: { status: 'ok' | 'denied' | 'error'; rows?: number | null; entityIds?: string[]; detail?: string }): Promise<void> {
    // The public demo keeps no activity rows (visitors are anonymous): only how often each tool ran, and how.
    if (isPublicDemo(p)) {
      const k = `${tool}:${e.status}`
      this.publicDemoCounts.set(k, (this.publicDemoCounts.get(k) ?? 0) + 1)
      return
    }
    // The chain is per workspace, so only one workspace's own calls contend. If the append still fails, the answer
    // goes out anyway and the failure is logged and alerted: a correct answer matters more than one audit row.
    // (Writes keep their strict log: the pipeline records each change with its outcome.)
    try {
      await this.appendLog(p, tool, args, started, e)
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      console.error('[agfn] mcp audit-append-failed', { workspaceId: p.workspaceId, grantId: p.grant.id, tool, status: e.status, error: why.slice(0, 200) })
      await this.hooks?.onAlert?.({ workspaceId: p.workspaceId, kind: 'audit_append_failed', text: `Activity row for ${tool} not written: ${why.slice(0, 200)}`, grantId: p.grant.id })?.catch(() => undefined)
    }
  }

  private async appendLog(p: Principal, tool: string, args: unknown, started: Date, e: { status: 'ok' | 'denied' | 'error'; rows?: number | null; entityIds?: string[]; detail?: string }): Promise<void> {
    await appendActivity(
      this.store.db,
      {
        workspaceId: p.workspaceId,
        actorKind: 'agent',
        personId: p.personId,
        grantId: p.grant.id,
        actorLabel: p.label,
        action: `tool.${tool}`,
        entityIds: e.entityIds ?? null,
        args: args && typeof args === 'object' ? (args as Record<string, unknown>) : null,
        status: e.status,
        rowsReturned: e.rows ?? null,
        detail: [e.detail, `${this.clock.now().getTime() - started.getTime()}ms`].filter(Boolean).join(' · '),
        ip: p.ip ?? null,
        userAgent: p.userAgent ?? null,
      },
      this.clock.now(),
    )
  }
}

export function grantScopes(write: boolean): string[] {
  return write ? [SCOPES.read, SCOPES.write] : [SCOPES.read]
}

const QUERY_HINT = 'Terms: words, "two words", -word, counterparty:X, amount>500, amount:100..500, in/out, date:2026-09, after:/before:, account:X, category:X (search only), currency:EUR.'

function formatIssues(err: z.ZodError): string {
  return err.issues
    .slice(0, 6)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ')
}

/** Top-level argument names the tool doesn't take (keys starting with "_" are client metadata and pass). */
function unknownArgs(tool: ToolDef, raw: unknown): string[] {
  const shape = (tool.input as { shape?: Record<string, unknown> }).shape
  if (!shape || !raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  return Object.keys(raw).filter((k) => !k.startsWith('_') && !(k in shape))
}

/** Where the unknown argument's meaning goes, for the filters models reach for first. */
function argHint(tool: ToolDef, unknown: string[]): string {
  const shape = (tool.input as { shape?: Record<string, unknown> }).shape ?? {}
  const takesQuery = 'query' in shape
  const tips: string[] = []
  for (const k of unknown) {
    const key = k.toLowerCase()
    if (takesQuery && /^(account|account_id|account_ids|accounts|source|source_id)$/.test(key)) tips.push(`put account:<id or name> in query`)
    else if (takesQuery && /^(direction|side|flow|type)$/.test(key)) tips.push('put in or out in query')
    else if (takesQuery && /^(counterparty|merchant|payee|vendor)$/.test(key) && !('counterparty' in shape)) tips.push('put counterparty:"<name>" in query')
    else if (takesQuery && /^(category|categories)$/.test(key)) tips.push('put category:<name> in query')
    else if (takesQuery && /^(min_amount|max_amount|amount)$/.test(key)) tips.push('put amount>N or amount<N in query')
  }
  const known = Object.keys(shape).join(', ')
  return `${[...new Set(tips)].map((t) => t[0]!.toUpperCase() + t.slice(1)).join('; ')}${tips.length ? '. ' : ''}${tool.name} takes: ${known || 'no arguments'}.`
}

/** A query value as a term: quoted when it has spaces or quotes are needed. */
const term = (key: string, v: string) => `${key}:${/[\s"]/.test(v) ? `"${v.replace(/"/g, '')}"` : v}`

/**
 * On tools that take a query (search_transactions, query_transactions): arguments models commonly pass as their own
 * fields (account_id, direction, category, counterparty, min/max amount) become the matching query terms, with a note
 * saying how they were read. Anything else is left for unknownArgs to refuse.
 */
function mapFilterArgs(tool: ToolDef, raw: unknown): { args: unknown; notes: string[] } {
  const shape = (tool.input as { shape?: Record<string, unknown> }).shape
  if (!shape || !('query' in shape) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return { args: raw, notes: [] }
  const args = { ...(raw as Record<string, unknown>) }
  const terms: string[] = []
  const read: string[] = []
  const strings = (v: unknown): string[] | null => (typeof v === 'string' && v.trim() ? [v.trim()] : Array.isArray(v) && v.length && v.length <= 5 && v.every((x) => typeof x === 'string' && x.trim()) ? (v as string[]).map((x) => x.trim()) : null)
  for (const k of Object.keys(args)) {
    if (k in shape) continue
    const key = k.toLowerCase()
    const v = args[k]
    let t: string[] | null = null
    if (/^(text|q|search|keyword|keywords|term|terms|phrase)$/.test(key)) {
      // Free text the model meant as search words: one phrase, quoted when it has spaces.
      const xs = strings(v)
      if (xs && xs.length === 1) t = [/\s/.test(xs[0]!) ? `"${xs[0]!.replace(/"/g, '')}"` : xs[0]!]
    } else if (/^(account|account_id|account_ids|accounts|source|source_id)$/.test(key)) {
      const xs = strings(v)
      // Several accounts can't be one query (no OR): leave it to be refused with the hint.
      if (xs && xs.length === 1) t = [term('account', xs[0]!)]
    } else if (/^(direction|side|flow)$/.test(key) && typeof v === 'string') {
      const d = v.trim().toLowerCase()
      t = /^(in|inflow|inflows|money_in|income|credit|received)$/.test(d) ? ['in'] : /^(out|outflow|outflows|money_out|spend|spending|expense|debit|paid)$/.test(d) ? ['out'] : null
    } else if (/^(category)$/.test(key)) {
      const xs = strings(v)
      if (xs && xs.length === 1) t = [term('category', xs[0]!)]
    } else if (/^(counterparty|merchant|payee|vendor)$/.test(key) && !('counterparty' in shape)) {
      const xs = strings(v)
      if (xs && xs.length === 1) t = [term('counterparty', xs[0]!)]
    } else if (/^(min_amount|amount_min)$/.test(key) && (typeof v === 'number' || (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())))) {
      t = [`amount>=${String(v).trim()}`]
    } else if (/^(max_amount|amount_max)$/.test(key) && (typeof v === 'number' || (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())))) {
      t = [`amount<=${String(v).trim()}`]
    }
    if (!t) continue
    terms.push(...t)
    read.push(`${k} as ${t.join(' ')}`)
    delete args[k]
  }
  if (!terms.length) return { args: raw, notes: [] }
  const q = typeof args.query === 'string' ? args.query.trim() : ''
  args.query = [q, ...terms].filter(Boolean).join(' ')
  console.info('[agfn] mcp mapped-arg', { tool: tool.name, args: read.map((r) => r.split(' as ')[0]!.slice(0, 40)).join(',') })
  return { args, notes: [`Read ${read.join(', ')} in query (this tool takes filters in query).`] }
}
