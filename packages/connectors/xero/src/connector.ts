// Xero connector (MASTER.md §5 "Accounting & invoices").
//
// OAuth 2.0 (Xero identity). Read-only: chart of accounts, invoices and bills (ACCREC/ACCPAY), credit notes,
// payments, overpayments, prepayments, and the P&L shown as "Books".
//
// Incremental sync uses If-Modified-Since on each list; Xero never hard-deletes accounting documents (they come
// back with Status DELETED/VOIDED), so no separate deletion feed is needed.
//
// Limits per organisation: 60 calls/minute, 5 concurrent, 5,000/day (1,000/day on the free Starter tier since
// 2026-03-02). We pace at 1/s; a long Retry-After (the daily limit) stops the sync instead of sleeping for hours.
import type { Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent } from '@agfn/contracts'
import {
  type ConnectorDeps,
  ConnectorError,
  cursorCodec,
  healthFromError,
  HttpClient,
  hmac,
  isRecord,
  localDay,
  monthPeriods,
  normalizeCurrency,
  OAuthClient,
  type OAuthTokens,
  requireSecret,
  signatureMatches,
  str,
  type SyncResultWithSecret,
  systemClock,
  type WebhookOutcome,
  type WebhookRequest,
} from '@agfn/connector-sdk'
import { mapAccount, mapBankTransaction, mapManualJournal, mapCreditNote, mapInvoice, mapPayment, mapPrepayment, mapProfitAndLoss, roleForAccount, type MapContext, type XeroObject } from './map.ts'
import { xeroTimeZone } from './timezone.ts'

export const PROVIDER = 'xero'
/** Response header with the provider's request id, quoted to provider support. */
const REQUEST_ID_HEADER = 'xero-correlation-id'
const AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize'
const TOKEN_URL = 'https://identity.xero.com/connect/token'
const REVOKE_URL = 'https://identity.xero.com/connect/revocation'
const CONNECTIONS_URL = 'https://api.xero.com/connections'
const API = 'https://api.xero.com/api.xro/2.0'
/**
 * Granular read scopes, exactly what the sync reads (apps created after 2026-03-02 get only granular scopes):
 * Organisation + Accounts (settings), Invoices + CreditNotes (invoices), Payments + Overpayments + Prepayments
 * (payments), BankTransactions + BankTransfers, ManualJournals, and the Profit and Loss report.
 */
export const DEFAULT_SCOPES = [
  'openid',
  'offline_access',
  'accounting.settings.read',
  'accounting.invoices.read',
  'accounting.payments.read',
  // Spend/receive money and transfers (BankTransactions, BankTransfers) and manual journals: on the P&L too.
  'accounting.banktransactions.read',
  'accounting.manualjournals.read',
  'accounting.reports.profitandloss.read',
]
/** For apps created before 2026-03-02 that still use broad scopes (set XERO_SCOPES to these). */
export const BROAD_SCOPES = ['openid', 'offline_access', 'accounting.settings.read', 'accounting.transactions.read', 'accounting.contacts.read', 'accounting.reports.read']
const OVERLAP_MS = 5 * 60_000
/** A Retry-After longer than this is the daily limit: stop and let the scheduler come back later. */
const MAX_WAIT_MS = 2 * 60_000

const LISTS = [
  { phase: 'Invoices', path: '/Invoices', key: 'Invoices' },
  { phase: 'CreditNotes', path: '/CreditNotes', key: 'CreditNotes' },
  { phase: 'Payments', path: '/Payments', key: 'Payments' },
  { phase: 'Overpayments', path: '/Overpayments', key: 'Overpayments' },
  { phase: 'Prepayments', path: '/Prepayments', key: 'Prepayments' },
  // Spend/receive money and manual journals (payroll accruals, depreciation, corrections): on the P&L too.
  { phase: 'BankTransactions', path: '/BankTransactions', key: 'BankTransactions' },
  { phase: 'ManualJournals', path: '/ManualJournals', key: 'ManualJournals' },
] as const
const PHASES = ['Organisation', 'Accounts', ...LISTS.map((l) => l.phase), 'pnl'] as const

export interface XeroSecret {
  tokens: OAuthTokens
}

export interface XeroConfig {
  tenantId: string
  tenantName?: string
  baseCurrency: string
  pnlMonths?: number
}

export interface XeroOptions {
  deps: ConnectorDeps
  oauth: { clientId: string; clientSecret: string; redirectUri: string; scopes?: string[] }
  /** Items per page (Xero allows up to 1000 on the paged endpoints). Default 100. */
  pageSize?: number
  /** The app's webhook signing key (Xero developer portal → Webhooks). Without it, change notices are off. */
  webhookKey?: string
}

interface CursorState {
  p: number
  page: number
  since: string | null
  mark: string
  /** Account code → ledger role, so bill lines get categories on later pages. */
  roles: Record<string, string>
  currency?: string
  /** The organisation's IANA timezone (from Organisation.Timezone): P&L months are its local months. */
  tz?: string
}

const isState = (v: unknown): v is CursorState =>
  isRecord(v) && typeof v.p === 'number' && typeof v.page === 'number' && (v.since === null || typeof v.since === 'string') && typeof v.mark === 'string' && isRecord(v.roles)
/**
 * Mapping version: bump when the mapping changes, so existing connections re-read everything once.
 * 2: spend/receive money, manual journals, sections and balance-sheet lines by account type.
 */
export const MAPPING_VERSION = 2
const codec = cursorCodec<CursorState>(PROVIDER, MAPPING_VERSION, isState)
const isSecret = (s: unknown): s is XeroSecret => isRecord(s) && isRecord(s.tokens) && typeof s.tokens.accessToken === 'string'

function readConfig(conn: ConnectionRef): XeroConfig {
  const tenantId = str(conn.config.tenantId)
  if (!tenantId) throw new ConnectorError('invalid_input', 'connection has no Xero organisation (tenantId)', { provider: PROVIDER })
  const cfg: XeroConfig = { tenantId, baseCurrency: normalizeCurrency(str(conn.config.baseCurrency), 'USD') }
  if (typeof conn.config.pnlMonths === 'number') cfg.pnlMonths = Math.max(0, Math.min(24, Math.floor(conn.config.pnlMonths)))
  return cfg
}

export function classifyXeroError({ status, headers, body }: { status: number; headers: Headers; body: unknown }): ConnectorError | undefined {
  const b = isRecord(body) ? body : {}
  const detail = str(b.Detail) ?? str(b.Message) ?? str(b.Title) ?? `HTTP ${status}`
  const opts = { provider: PROVIDER, status }
  if (status === 401 || status === 403) return new ConnectorError('auth', detail.slice(0, 300), opts)
  if (status === 429) {
    const ra = Number(headers.get('retry-after') ?? '')
    const which = headers.get('x-rate-limit-problem') ?? 'minute'
    const retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 60_000
    if (retryAfterMs > MAX_WAIT_MS) {
      // Not retryable within this run: surfaces as rate_limited health, and the scheduler waits.
      return new ConnectorError('rate_limited', `Xero ${which} limit reached; retry in ${Math.ceil(retryAfterMs / 60_000)} min`, { ...opts, code: `limit_${which}` })
    }
    return new ConnectorError('rate_limited', `Xero ${which} limit`, { ...opts, retryAfterMs })
  }
  if (status >= 500) return new ConnectorError('transient', detail.slice(0, 300), opts)
  return new ConnectorError('permanent', detail.slice(0, 300), opts)
}

export function createXeroConnector(opts: XeroOptions): Connector & {
  authorizationUrl(state: string): string
  verifyWebhook(req: WebhookRequest, webhookKey: string): { valid: boolean; outcomes: WebhookOutcome[] }
  /** Mounted by the server at POST /api/webhooks/xero when a webhook key is set. */
  webhook?: { verify(req: WebhookRequest): Promise<void>; interpret(req: WebhookRequest): WebhookOutcome[]; emptyAck: true }
} {
  const { deps } = opts
  const clock = deps.clock ?? systemClock
  const pageSize = Math.min(1000, Math.max(1, opts.pageSize ?? 100))
  const oauth = new OAuthClient({
    provider: PROVIDER,
    authorizeUrl: AUTHORIZE_URL,
    tokenUrl: TOKEN_URL,
    clientId: opts.oauth.clientId,
    clientSecret: opts.oauth.clientSecret,
    redirectUri: opts.oauth.redirectUri,
    scopes: opts.oauth.scopes ?? DEFAULT_SCOPES,
    clientAuth: 'basic',
    requestIdHeader: REQUEST_ID_HEADER,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    clock,
  })

  /** Current tokens for a connection; a refresh (single-use refresh tokens) is saved before anything else. */
  async function usable(conn: ConnectionRef): Promise<OAuthTokens> {
    const secret = requireSecret(PROVIDER, conn.secret, isSecret)
    const { tokens, refreshed } = await oauth.ensureFresh(secret.tokens)
    if (refreshed) await deps.saveSecret?.(conn.id, { tokens } satisfies XeroSecret)
    return tokens
  }

  function client(tokens: OAuthTokens, tenantId?: string): HttpClient {
    return new HttpClient({
      provider: PROVIDER,
      baseUrl: API,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      clock,
      ...(deps.random ? { random: deps.random } : {}),
      requestIdHeader: REQUEST_ID_HEADER,
      rateLimit: { perSecond: 1, burst: 5 },
      headers: { authorization: `Bearer ${tokens.accessToken}`, ...(tenantId ? { 'xero-tenant-id': tenantId } : {}) },
      classifyError: classifyXeroError,
    })
  }

  const description: ConnectorDescription = {
    key: PROVIDER,
    name: 'Xero',
    group: 'accounting',
    provides: ['invoices', 'bills', 'reports'],
    freshness: 'syncs every few hours, and within minutes when Xero sends a change notice',
    auth: 'oauth',
    dataVersion: MAPPING_VERSION,
  }

  return {
    describe: () => description,

    authorizationUrl(state) {
      return oauth.authorizationUrl({ state })
    },

    /**
     * input: { code, tenantId? }. Without tenantId: every organisation ticked in this sign-in (Xero's consent screen
     * is the picker), one Aggregate connection each. They share one token pair, which rotates on refresh, so their
     * configs carry the same sharedSecretKey (the sign-in's authentication event).
     */
    async connect(input) {
      const code = str(input.code)
      if (!code) throw new ConnectorError('invalid_input', 'Xero sign-in did not return a code', { provider: PROVIDER })
      const tokens = await oauth.exchangeCode(code)
      const http = client(tokens)
      const conns = await http.request<unknown>({ path: CONNECTIONS_URL })
      const orgs = (Array.isArray(conns.data) ? conns.data.filter(isRecord) : []).filter((c) => str(c.tenantType) === 'ORGANISATION')
      const wanted = str(input.tenantId)
      const picked = wanted ? orgs.filter((o) => str(o.tenantId) === wanted) : authorizedInThisSignIn(orgs, tokens.accessToken)
      if (!picked.length || !str(picked[0]!.tenantId)) throw new ConnectorError('invalid_input', 'no Xero organisation was shared with Aggregate', { provider: PROVIDER })
      const grant = picked.length > 1 ? authEvent(tokens.accessToken) : undefined
      const secret: XeroSecret = { tokens }
      const results: Array<{ secret: XeroSecret; config: Record<string, unknown> }> = []
      for (const org of picked) {
        const tenantId = str(org.tenantId)
        if (!tenantId) continue
        const orgRes = await client(tokens, tenantId).request<XeroObject>({ path: '/Organisation' })
        const o = Array.isArray(orgRes.data.Organisations) && isRecord(orgRes.data.Organisations[0]) ? orgRes.data.Organisations[0] : {}
        const cfg: XeroConfig = { tenantId, baseCurrency: normalizeCurrency(str(o.BaseCurrency), 'USD') }
        const name = str(org.tenantName) ?? str(o.Name)
        if (name) cfg.tenantName = name
        const xeroConnectionId = str(org.id)
        // The connection shows as "Xero · <organisation>" (one org per connection).
        results.push({
          secret,
          config: { ...cfg, ...(name ? { displayName: `Xero · ${name}` } : {}), ...(xeroConnectionId ? { xeroConnectionId } : {}), ...(grant ? { sharedSecretKey: `xero:${grant}` } : {}) },
        })
      }
      const [first, ...rest] = results
      return { ...first!, ...(rest.length ? { additional: rest } : {}) }
    },

    /**
     * Every organisation this connection's grant can reach. Xero lists all the organisations this person ever shared
     * with Aggregate (a sign-in that found one "already connected" doesn't tick it again), so the person can add one
     * that this sign-in didn't tick. The caller leaves out the ones the workspace already has.
     */
    async listShared(conn: ConnectionRef): Promise<Array<{ id: string; name: string; match: { field: 'tenantId'; value: string } }>> {
      const tokens = await usable(conn)
      const res = await client(tokens).request<unknown>({ path: CONNECTIONS_URL })
      return (Array.isArray(res.data) ? res.data.filter(isRecord) : [])
        .filter((c) => str(c.tenantType) === 'ORGANISATION' && str(c.tenantId))
        .map((c) => ({ id: str(c.tenantId)!, name: str(c.tenantName) ?? 'Xero organisation', match: { field: 'tenantId' as const, value: str(c.tenantId)! } }))
    },

    /** One more organisation on this connection's grant, as its own connection sharing the token (no new consent). */
    async connectShared(conn: ConnectionRef, tenantId: string): Promise<{ secret: XeroSecret; config: Record<string, unknown> }> {
      const tokens = await usable(conn)
      const res = await client(tokens).request<unknown>({ path: CONNECTIONS_URL })
      const org = (Array.isArray(res.data) ? res.data.filter(isRecord) : []).find((c) => str(c.tenantId) === tenantId && str(c.tenantType) === 'ORGANISATION')
      if (!org) throw new ConnectorError('invalid_input', 'That Xero organisation isn’t shared with Aggregate any more', { provider: PROVIDER })
      const orgRes = await client(tokens, tenantId).request<XeroObject>({ path: '/Organisation' })
      const o = Array.isArray(orgRes.data.Organisations) && isRecord(orgRes.data.Organisations[0]) ? orgRes.data.Organisations[0] : {}
      const cfg: XeroConfig = { tenantId, baseCurrency: normalizeCurrency(str(o.BaseCurrency), 'USD') }
      const name = str(org.tenantName) ?? str(o.Name)
      if (name) cfg.tenantName = name
      const xeroConnectionId = str(org.id)
      // Both connections now hold one rotating token: they share a key so a refresh reaches both.
      const sharedSecretKey = str(conn.config.sharedSecretKey) ?? `xero:${authEvent(tokens.accessToken) ?? conn.id}`
      return { secret: { tokens }, config: { ...cfg, ...(name ? { displayName: `Xero · ${name}` } : {}), ...(xeroConnectionId ? { xeroConnectionId } : {}), sharedSecretKey } }
    },

    /**
     * Disconnect one organisation: DELETE /connections/<id> removes only that tenant from the grant. The token is
     * revoked only when no other connection from the same sign-in still uses it (the engine sets lastOfGrant;
     * a connection that never shared its token is always the last).
     */
    async disconnect(conn) {
      const secret = requireSecret(PROVIDER, conn.secret, isSecret)
      const last = conn.config.sharedSecretKey ? conn.config.lastOfGrant === true : true
      const { tokens, refreshed } = await oauth.ensureFresh(secret.tokens)
      // Other organisations from the same sign-in keep using this token: a refresh here rotated it for them too.
      if (refreshed && !last) await deps.saveSecret?.(conn.id, { tokens } satisfies XeroSecret)
      const problems: string[] = []
      // Connections made before the id was stored: find this organisation's connection under the grant.
      let id = str(conn.config.xeroConnectionId)
      if (!id) {
        const tenantId = str(conn.config.tenantId)
        try {
          const res = await client(tokens).request<unknown>({ path: CONNECTIONS_URL })
          const match = (Array.isArray(res.data) ? res.data.filter(isRecord) : []).find((c) => str(c.tenantId) === tenantId)
          id = match ? str(match.id) : undefined
        } catch (e) {
          if (!last) problems.push(`couldn't list Xero connections (${e instanceof ConnectorError && e.status ? `HTTP ${e.status}` : 'network error'})`)
        }
      }
      if (id) {
        try {
          await client(tokens).request({ method: 'DELETE', path: `${CONNECTIONS_URL}/${encodeURIComponent(id)}` })
        } catch (e) {
          // Already gone is fine (safe to call twice).
          if (!(e instanceof ConnectorError && e.status === 404)) problems.push(`Xero refused to remove the organisation (${e instanceof ConnectorError && e.status ? `HTTP ${e.status}` : 'network error'})`)
        }
      }
      if (last && tokens.refreshToken) {
        const basic = Buffer.from(`${opts.oauth.clientId}:${opts.oauth.clientSecret}`).toString('base64')
        const send = deps.fetch ?? fetch
        try {
          const res = await send(REVOKE_URL, { method: 'POST', headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tokens.refreshToken }).toString() })
          if (!res.ok) problems.push(`Xero refused to revoke access (HTTP ${res.status})`)
        } catch {
          problems.push('Xero could not be reached to revoke access')
        }
      }
      // Never a token in the message. The local secret is wiped either way; say what to do in Xero.
      if (problems.length) {
        throw new ConnectorError('permanent', `${problems.join('; ')}. Remove "Aggregate" in Xero under Settings → Connected apps.`, { provider: PROVIDER, forUser: true })
      }
    },

    async sync(conn, cursor): Promise<SyncResultWithSecret> {
      const cfg = readConfig(conn)
      const secret = requireSecret(PROVIDER, conn.secret, isSecret)
      const { tokens, refreshed } = await oauth.ensureFresh(secret.tokens)
      // Xero refresh tokens are single-use: keep the new one before any page can fail and strand it.
      if (refreshed) await deps.saveSecret?.(conn.id, { tokens } satisfies XeroSecret)
      const http = client(tokens, cfg.tenantId)
      const now = clock.now()

      let state = codec.decode(cursor)
      if (!state || state.p >= PHASES.length || (state.p === 0 && state.page === 1)) {
        state = { p: 0, page: 1, since: state?.since ?? null, mark: new Date(now - OVERLAP_MS).toISOString().slice(0, 19), roles: {} }
      }
      const ctx: MapContext = { connectionId: conn.id, baseCurrency: state.currency ?? cfg.baseCurrency, roles: state.roles }
      const phase = PHASES[state.p] as (typeof PHASES)[number]
      const events: NormalizedEvent[] = []
      let next: CursorState = { ...state, p: state.p + 1, page: 1 }

      if (phase === 'Organisation') {
        const res = await http.request<XeroObject>({ path: '/Organisation' })
        const o = Array.isArray(res.data.Organisations) && isRecord(res.data.Organisations[0]) ? res.data.Organisations[0] : {}
        next.currency = normalizeCurrency(str(o.BaseCurrency), cfg.baseCurrency)
        const tz = xeroTimeZone(o.Timezone)
        if (tz) next.tz = tz
        else delete next.tz
      } else if (phase === 'Accounts') {
        // Always the full chart (small, unpaged): the role map must cover every code bills can use.
        const res = await http.request<XeroObject>({ path: '/Accounts' })
        const list = Array.isArray(res.data.Accounts) ? res.data.Accounts.filter(isRecord) : []
        const roles: Record<string, string> = {}
        for (const a of list) {
          const id = str(a.AccountID)
          if (!id) continue
          const r = roleForAccount(a)
          if (r) roles[r[0]] = r[1]
          const rawRef = await deps.raw.put(conn.id, `${PROVIDER}.Account`, id, a)
          const e = mapAccount(a, { ...ctx, rawRef })
          if (e) events.push(e)
        }
        next.roles = roles
      } else if (phase === 'pnl') {
        events.push(...(await profitAndLoss(http, conn, ctx, cfg, now, state.tz ?? conn.timeZone)))
      } else {
        const list = LISTS.find((l) => l.phase === phase) as (typeof LISTS)[number]
        const res = await http.request<XeroObject>({
          path: list.path,
          query: { page: state.page, pageSize, order: 'UpdatedDateUTC ASC', ...(phase === 'Invoices' ? { summaryOnly: 'false' } : {}) },
          headers: state.since ? { 'if-modified-since': state.since } : {},
        })
        const items = Array.isArray(res.data[list.key]) ? (res.data[list.key] as unknown[]).filter(isRecord) : []
        for (const o of items) events.push(...(await mapItem(phase, o, conn, ctx)))
        if (items.length >= pageSize) next = { ...state, page: state.page + 1 }
      }

      const done = next.p >= PHASES.length
      const result: SyncResultWithSecret = {
        events,
        cursor: codec.encode(done ? { p: 0, page: 1, since: next.mark, mark: next.mark, roles: {} } : next),
        hasMore: !done,
      }
      if (refreshed) result.updatedSecret = { tokens } satisfies XeroSecret
      return result
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        const cfg = readConfig(conn)
        const secret = requireSecret(PROVIDER, conn.secret, isSecret)
        // Never refreshes: Xero refresh tokens are single-use, and health has nowhere to keep the new one. An expired
        // access token renews on the next sync.
        const t = secret.tokens
        if (t.expiresAt !== undefined && t.expiresAt <= clock.now() && t.refreshToken) return { status: 'ok', message: 'The access token renews on the next sync.' }
        await client(t, cfg.tenantId).request({ path: '/Organisation' })
        return { status: 'ok', lastSuccessAt: new Date(clock.now()).toISOString() }
      } catch (e) {
        return healthFromError(e)
      }
    },

    /**
     * Xero webhooks: HMAC-SHA256 of the raw body with the webhook key, base64 in `x-xero-signature`.
     * `valid: false` must be answered with 401 (Xero's "intent to receive" check depends on it).
     */
    verifyWebhook: verifyXeroWebhook,
    // Xero's "intent to receive": signed deliveries (events: [] at first) get 200 with an empty body, anything else 401.
    ...(opts.webhookKey
      ? {
          webhook: {
            emptyAck: true as const,
            async verify(req: WebhookRequest) {
              if (!verifyXeroWebhook(req, opts.webhookKey!).valid) throw new ConnectorError('auth', 'bad Xero webhook signature', { provider: PROVIDER })
            },
            interpret: (req: WebhookRequest) => {
              const out = verifyXeroWebhook(req, opts.webhookKey!).outcomes
              return out.length ? out : [{ action: 'ignore' as const, dedupeKey: hmac('sha256', 'dedupe', req.body).toString('hex') }]
            },
          },
        }
      : {}),
  }

  async function mapItem(phase: (typeof LISTS)[number]['phase'], o: XeroObject, conn: ConnectionRef, ctx: MapContext): Promise<NormalizedEvent[]> {
    const idField = { Invoices: 'InvoiceID', CreditNotes: 'CreditNoteID', Payments: 'PaymentID', Overpayments: 'OverpaymentID', Prepayments: 'PrepaymentID', BankTransactions: 'BankTransactionID', ManualJournals: 'ManualJournalID' }[phase]
    const id = str(o[idField])
    if (!id) return []
    const rawRef = await deps.raw.put(conn.id, `${PROVIDER}.${phase}`, id, o)
    const c = { ...ctx, rawRef }
    if (phase === 'BankTransactions') return mapBankTransaction(o, c)
    if (phase === 'ManualJournals') {
      const j = mapManualJournal(o, c)
      return j ? [j] : []
    }
    const e =
      phase === 'Invoices'
        ? mapInvoice(o, c)
        : phase === 'CreditNotes'
          ? mapCreditNote(o, c)
          : phase === 'Payments'
            ? mapPayment(o, c)
            : mapPrepayment(o, c, phase === 'Overpayments' ? 'overpayment' : 'prepayment')
    return e ? [e] : []
  }

  async function profitAndLoss(http: HttpClient, conn: ConnectionRef, ctx: MapContext, cfg: XeroConfig, now: number, tz: string | undefined): Promise<NormalizedEvent[]> {
    const periods = monthPeriods(localDay(now, tz), cfg.pnlMonths ?? 3)
    const out: NormalizedEvent[] = []
    for (const p of periods) {
      const res = await http.request<XeroObject>({ path: '/Reports/ProfitAndLoss', query: { fromDate: p.from, toDate: p.to } })
      const rawRef = await deps.raw.put(conn.id, `${PROVIDER}.ProfitAndLoss`, `${p.from}:${p.to}`, res.data)
      const e = mapProfitAndLoss(res.data, { ...ctx, rawRef }, p)
      if (e) out.push(e)
    }
    return out
  }
}

/**
 * The organisation the person picked in this sign-in. /connections lists every organisation ever shared with the app
 * (an earlier test org stays first), so match the token's authentication_event_id to each connection's authEventId;
 * otherwise the most recently connected one.
 */
export function justAuthorized(orgs: Array<Record<string, unknown>>, accessToken: string): Record<string, unknown> | undefined {
  return authorizedInThisSignIn(orgs, accessToken)[0]
}

/** The access token's authentication_event_id (one per sign-in), if it's a readable JWT. */
function authEvent(accessToken: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>
    return str(payload.authentication_event_id)
  } catch {
    return undefined
  }
}

/** Every organisation ticked in this sign-in, newest first; without a match, only the most recently connected one. */
export function authorizedInThisSignIn(orgs: Array<Record<string, unknown>>, accessToken: string): Array<Record<string, unknown>> {
  const event = authEvent(accessToken)
  const newest = (xs: Array<Record<string, unknown>>) => [...xs].sort((a, b) => (str(b.createdDateUtc) ?? '').localeCompare(str(a.createdDateUtc) ?? ''))
  const fromThisSignIn = event ? orgs.filter((o) => str(o.authEventId) === event) : []
  return fromThisSignIn.length ? newest(fromThisSignIn) : newest(orgs).slice(0, 1)
}

/** HMAC-SHA256 of the raw body with the webhook key, base64 in `x-xero-signature`; one "sync" per organisation named. */
function verifyXeroWebhook(req: WebhookRequest, webhookKey: string): { valid: boolean; outcomes: WebhookOutcome[] } {
  const sig = req.headers['x-xero-signature']
  if (!sig || !signatureMatches(hmac('sha256', webhookKey, req.body), sig, 'base64')) return { valid: false, outcomes: [] }
  let body: unknown
  try {
    body = JSON.parse(req.body)
  } catch {
    return { valid: false, outcomes: [] }
  }
  const events = isRecord(body) && Array.isArray(body.events) ? body.events.filter(isRecord) : []
  const tenants = [...new Set(events.map((e) => str(e.tenantId)).filter((t): t is string => !!t))]
  const digest = hmac('sha256', 'dedupe', req.body).toString('hex')
  return { valid: true, outcomes: tenants.map((t) => ({ match: { field: 'tenantId', value: t }, action: 'sync' as const, dedupeKey: `${digest}:${t}` })) }
}
