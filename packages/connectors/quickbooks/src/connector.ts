// QuickBooks Online connector (MASTER.md §5 "Accounting & invoices").
//
// OAuth 2.0 (Intuit). Read-only: chart of accounts, invoices, credit memos, payments, bills, vendor credits,
// bill payments, purchases, sales and refund receipts, deposits, deletions (CDC), and the P&L shown as "Books". Never writes to QuickBooks.
//
// Sync is a resumable pass over phases. Each page is one query (STARTPOSITION/MAXRESULTS, ordered by Id so
// paging is stable). Incremental passes filter on MetaData.LastUpdatedTime >= the previous pass's start (minus
// an overlap), and pick up deletions from the CDC endpoint, which only looks back 30 days: an older cursor
// falls back to a full pass (idempotent, so nothing is double counted).
//
// Limits: 500 requests/minute and 10 concurrent per company (realm). We stay under 8/s.
import type { Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent } from '@agfn/contracts'
import {
  type ConnectorDeps,
  ConnectorError,
  cursorCodec,
  healthFromError,
  isConnectorError,
  HttpClient,
  hmac,
  isRecord,
  localDay,
  monthPeriods,
  providerFx,
  withFx,
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
import { accountIndex, itemIndex, mapInvoiceEvents, mapSalesTaxPayments, mapJournalEntry, deletedJournal, voidCogs, CASH_ENTITIES, deletedCashEvents, deletedEvent, mapAccount, mapBillEvents, mapCashEntity, mapCredit, mapPayment, mapProfitAndLoss, type CashEntity, type MapContext, type QboAccountInfo, type QboObject } from './map.ts'

export const PROVIDER = 'quickbooks'
/** Response header with the provider's request id, quoted to provider support. */
const REQUEST_ID_HEADER = 'intuit_tid'
const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2'
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke'
/** Intuit's OpenID discovery documents name the OAuth endpoints; the constants above are the fallback. */
export const DISCOVERY_URL = { production: 'https://developer.api.intuit.com/.well-known/openid_configuration', sandbox: 'https://developer.api.intuit.com/.well-known/openid_sandbox_configuration' } as const
const DISCOVERY_TTL_MS = 24 * 3_600_000
export interface IntuitEndpoints {
  authorize: string
  token: string
  revoke: string
}
export const FALLBACK_ENDPOINTS: IntuitEndpoints = { authorize: AUTHORIZE_URL, token: TOKEN_URL, revoke: REVOKE_URL }
/** Per environment, shared by every connector instance (the server makes one per request). */
const discovered = new Map<'production' | 'sandbox', { at: number; endpoints: IntuitEndpoints }>()
/** Tests start from an empty cache. */
export function resetIntuitDiscovery(): void {
  discovered.clear()
}
/** Only https URLs on intuit.com are taken from a discovery document; anything else keeps the fallback. */
function intuitUrl(v: unknown, fallback: string): string {
  const s = str(v)
  if (!s) return fallback
  try {
    const u = new URL(s)
    return u.protocol === 'https:' && (u.hostname === 'intuit.com' || u.hostname.endsWith('.intuit.com')) ? s : fallback
  } catch {
    return fallback
  }
}
const API = { production: 'https://quickbooks.api.intuit.com', sandbox: 'https://sandbox-quickbooks.api.intuit.com' } as const
const SCOPES = ['com.intuit.quickbooks.accounting']
const MINOR_VERSION = '75'
const OVERLAP_MS = 5 * 60_000
const CDC_MAX_DAYS = 29
/** Intuit's cap on objects in one CDC response. */
const CDC_CAP = 1000

// Purchase, SalesReceipt, RefundReceipt and Deposit are money that moved without an invoice or bill (map.ts).
// JournalEntry: manual journals (depreciation, accruals, payroll postings) that touch the P&L.
const ENTITIES = ['Account', 'Invoice', 'CreditMemo', 'Payment', 'Bill', 'VendorCredit', 'BillPayment', 'Purchase', 'SalesReceipt', 'RefundReceipt', 'Deposit', 'JournalEntry'] as const
type Entity = (typeof ENTITIES)[number]
const PHASES = [...ENTITIES, 'cdc', 'pnl', 'salestax'] as const

export interface QuickBooksSecret {
  tokens: OAuthTokens
}

export interface QuickBooksConfig {
  realmId: string
  environment: 'production' | 'sandbox'
  homeCurrency: string
  companyName?: string
  /** Complete months of P&L to keep as "Books" snapshots, plus the current month to date. Default 3. */
  pnlMonths?: number
}

export interface QuickBooksOptions {
  deps: ConnectorDeps
  oauth: { clientId: string; clientSecret: string; redirectUri: string }
  pageSize?: number
  /** The app's webhook verifier token (Intuit Developer → Webhooks). Without it, change notices are off. */
  webhookVerifier?: string
}

interface CursorState {
  /** Phase index into PHASES. */
  p: number
  /** STARTPOSITION within the phase (1-based). */
  s: number
  /** LastUpdatedTime filter for this pass; null = full pass. */
  since: string | null
  /** When this pass started (becomes `since` for the next pass). */
  mark: string
  /** Entities this company's QuickBooks plan doesn't include, found this pass (skipped, and left out of CDC). */
  skip?: string[]
  /** When this pass began (server clock, before its first request): a full pass's listing.complete names it. */
  started?: string
}

const isState = (v: unknown): v is CursorState =>
  isRecord(v) && typeof v.p === 'number' && typeof v.s === 'number' && (v.since === null || typeof v.since === 'string') && typeof v.mark === 'string' && (v.skip === undefined || (Array.isArray(v.skip) && v.skip.every((x) => typeof x === 'string')))

/** What a person reads when their plan leaves something out: those numbers are unknown here, never zero. */
const PLAN_NAMES: Record<string, string> = { Bill: 'bills', BillPayment: 'bill payments', VendorCredit: 'vendor credits', Purchase: 'expenses', Deposit: 'deposits', SalesReceipt: 'sales receipts', RefundReceipt: 'refund receipts', CreditMemo: 'credit memos', Payment: 'customer payments', Invoice: 'invoices', JournalEntry: 'journal entries', pnl: 'the profit and loss report', salestax: 'sales tax payments' }
export const planLimitWarning = (what: string) => `Your QuickBooks plan doesn't include ${PLAN_NAMES[what] ?? what}, so Aggregate can't read them: they're unknown here, not zero.`
/**
 * Mapping version. Bump it whenever what the sync reads or how it maps changes: an existing connection's older
 * cursor then reads as invalid, and runSync re-reads everything once (idempotent ids make that safe).
 * 2: purchases, sales and refund receipts, deposits, account-type sections, inventory.
 * 3: journal entries, inactive accounts and items, the deposit's payer from its lines.
 */
export const MAPPING_VERSION = 3
const codec = cursorCodec<CursorState>(PROVIDER, MAPPING_VERSION, isState)

const isSecret = (s: unknown): s is QuickBooksSecret => isRecord(s) && isRecord(s.tokens) && typeof s.tokens.accessToken === 'string'

function readConfig(conn: ConnectionRef): QuickBooksConfig {
  const c = conn.config
  const realmId = str(c.realmId)
  if (!realmId) throw new ConnectorError('invalid_input', 'connection has no QuickBooks company (realmId)', { provider: PROVIDER })
  const cfg: QuickBooksConfig = {
    realmId,
    environment: c.environment === 'sandbox' ? 'sandbox' : 'production',
    homeCurrency: normalizeCurrency(str(c.homeCurrency), 'USD'),
  }
  if (typeof c.pnlMonths === 'number') cfg.pnlMonths = Math.max(0, Math.min(24, Math.floor(c.pnlMonths)))
  return cfg
}

function qboTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00')
}

/**
 * Intuit's Fault codes come as "3200" or "003200" depending on where they're read; compare them without leading
 * zeros. Status decides first where it's unambiguous: a 5xx is Intuit's side even when a code rides along.
 */
export function classifyQboError({ status, body }: { status: number; body: unknown }): ConnectorError | undefined {
  const fault = isRecord(body) && isRecord(body.Fault) ? body.Fault : isRecord(body) && isRecord(body.fault) ? body.fault : undefined
  const errs = fault && Array.isArray(fault.Error) ? fault.Error : fault && Array.isArray(fault.error) ? fault.error : []
  const first = isRecord(errs[0]) ? errs[0] : {}
  const code = str(first.code)?.replace(/^0+(?=\d)/, '')
  const type = str(fault?.type)?.toUpperCase()
  const message = [str(first.Message) ?? str(first.message), str(first.Detail) ?? str(first.detail)].filter(Boolean).join(': ').slice(0, 300) || `HTTP ${status}`
  const opts = { provider: PROVIDER, status, ...(code ? { code } : {}) }
  // 500 requests a minute per company: Intuit says wait a minute, and usually sends no Retry-After (a header wins).
  if (status === 429 || code === '3001' || type === 'THROTTLE') return new ConnectorError('rate_limited', message, { ...opts, retryAfterMs: 60_000 })
  if (status >= 500 || type === 'SYSTEMFAULT') return new ConnectorError('transient', message, opts)
  // What a person reads in the drawer; Intuit's own text (and intuit_tid) goes to the log via the error's cause.
  if (status === 401 || type === 'AUTHENTICATION' || code === '3200') return new ConnectorError('auth', 'QuickBooks access was removed or has expired (in QuickBooks, or by a disconnect). Reconnect to keep syncing.', { ...opts, cause: message })
  // A feature this company's QuickBooks plan doesn't have (Simple Start has no bills): not a broken login.
  if (isPlanLimit(code, message)) return new ConnectorError('permanent', message, { ...opts, code: PLAN_LIMIT })
  if (status === 403 || code === '3100') return new ConnectorError('auth', message, opts)
  return new ConnectorError('permanent', message, opts)
}

/** QuickBooks refused the sign-in itself before it was due to end: Aggregate was removed from the company in QuickBooks. */
function revoked(cause: ConnectorError): ConnectorError {
  return new ConnectorError('auth', 'Access to QuickBooks was removed in QuickBooks, so your QuickBooks data was deleted from Aggregate. Connect QuickBooks again to bring it back.', { provider: PROVIDER, code: 'revoked', forUser: true, cause: cause.message })
}

/** Marks an error as "this company's plan doesn't include it": the entity is skipped, the rest of the sync goes on. */
export const PLAN_LIMIT = 'plan_limit'
function isPlanLimit(code: string | undefined, message: string): boolean {
  if (code === '3200' || code === '3100') return false
  return /feature (is )?not (supported|enabled|available)|not (included|available) in your (quickbooks )?(online )?(plan|subscription|version)|does not support this feature|upgrade your (plan|subscription)/i.test(message)
}
const isPlanLimitError = (e: unknown) => isConnectorError(e) && e.code === PLAN_LIMIT

export function createQuickBooksConnector(opts: QuickBooksOptions): Connector & {
  authorizationUrl(state: string): string
  verifyWebhook(req: WebhookRequest, verifierToken: string): WebhookOutcome[]
  /** Mounted by the server at POST /api/webhooks/quickbooks when a verifier token is set. */
  webhook?: { verify(req: WebhookRequest): Promise<void>; interpret(req: WebhookRequest): WebhookOutcome[] }
} {
  const { deps } = opts
  const clock = deps.clock ?? systemClock
  const pageSize = Math.min(1000, Math.max(1, opts.pageSize ?? 500))
  let chartCache: { at: number; map: Map<string, QboAccountInfo> } | undefined
  let itemCache: { at: number; map: Map<string, import('./map.ts').QboItemInfo> } | undefined
  /** Intuit's endpoints for an environment: discovery (cached a day), else the documented constants. */
  async function endpoints(env: 'production' | 'sandbox'): Promise<IntuitEndpoints> {
    const hit = discovered.get(env)
    if (hit && clock.now() - hit.at < DISCOVERY_TTL_MS) return hit.endpoints
    let found = FALLBACK_ENDPOINTS
    try {
      const res = await (deps.fetch ?? fetch)(DISCOVERY_URL[env], { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5_000) })
      if (res.ok) {
        const d = (await res.json()) as Record<string, unknown>
        found = { authorize: intuitUrl(d.authorization_endpoint, AUTHORIZE_URL), token: intuitUrl(d.token_endpoint, TOKEN_URL), revoke: intuitUrl(d.revocation_endpoint, REVOKE_URL) }
      }
    } catch {
      /* the fallback; tried again next time */
    }
    // A failed fetch is remembered only briefly, so a blip doesn't pin the fallback for a day.
    discovered.set(env, { at: found === FALLBACK_ENDPOINTS ? clock.now() - DISCOVERY_TTL_MS + 5 * 60_000 : clock.now(), endpoints: found })
    return found
  }
  const oauthFor = (e: IntuitEndpoints) =>
    new OAuthClient({
      provider: PROVIDER,
      authorizeUrl: e.authorize,
      tokenUrl: e.token,
      clientId: opts.oauth.clientId,
      clientSecret: opts.oauth.clientSecret,
      redirectUri: opts.oauth.redirectUri,
      scopes: SCOPES,
      clientAuth: 'basic',
      requestIdHeader: REQUEST_ID_HEADER,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      clock,
    })
  const oauth = new OAuthClient({
    provider: PROVIDER,
    authorizeUrl: AUTHORIZE_URL,
    tokenUrl: TOKEN_URL,
    clientId: opts.oauth.clientId,
    clientSecret: opts.oauth.clientSecret,
    redirectUri: opts.oauth.redirectUri,
    scopes: SCOPES,
    clientAuth: 'basic',
    requestIdHeader: REQUEST_ID_HEADER,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    clock,
  })

  function client(cfg: QuickBooksConfig, tokens: OAuthTokens): HttpClient {
    return new HttpClient({
      provider: PROVIDER,
      baseUrl: `${API[cfg.environment]}/v3/company/${encodeURIComponent(cfg.realmId)}`,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      clock,
      ...(deps.random ? { random: deps.random } : {}),
      requestIdHeader: REQUEST_ID_HEADER,
      rateLimit: { perSecond: 8, burst: 8 },
      // A throttle asks for a minute: throw it at once so the scheduler retries in a minute, rather than holding a
      // worker asleep through several in-process retries.
      maxRetryAfterMs: 30_000,
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      classifyError: classifyQboError,
    })
  }

  async function freshTokens(conn: ConnectionRef): Promise<{ tokens: OAuthTokens; refreshed: boolean }> {
    const secret = requireSecret(PROVIDER, conn.secret, isSecret)
    const t = secret.tokens
    // Still fresh: no endpoint needed, so no discovery fetch either.
    if (t.expiresAt === undefined || t.expiresAt - clock.now() > 60_000) return oauth.ensureFresh(t)
    try {
      const r = await oauthFor(await endpoints(readConfig(conn).environment)).ensureFresh(t)
      return r.refreshed ? { ...r, tokens: withSignInDeadline(r.tokens, clock.now()) } : r
    } catch (e) {
      // Intuit refused the refresh token while the sign-in still had time left: the app was removed inside QuickBooks
      // (or disconnected elsewhere). Intuit's terms (8.2(f)) want its data deleted then, so it's a revoke, which the
      // server erases like a disconnect here. Past the sign-in's end it's only an expired sign-in: reconnect, keep data.
      const refused = e instanceof ConnectorError && e.kind === 'auth' && e.code === 'invalid_grant'
      const ended = typeof t.extra?.refreshExpiresAt === 'number' && t.extra.refreshExpiresAt <= clock.now()
      if (refused && !ended) throw revoked(e)
      throw e
    }
  }

  const description: ConnectorDescription = {
    key: PROVIDER,
    name: 'QuickBooks',
    group: 'accounting',
    provides: ['invoices', 'bills', 'reports'],
    freshness: 'syncs every few hours, and within minutes when QuickBooks sends a change notice; bank-feed lines are only as current as the bank feed (a few times a day)',
    auth: 'oauth',
    dataVersion: MAPPING_VERSION,
  }

  return {
    describe: () => description,

    authorizationUrl(state) {
      // Synchronous: the production discovery result if one is cached, else the documented URL (they're the same).
      const e = discovered.get('production')?.endpoints
      return (e ? oauthFor(e) : oauth).authorizationUrl({ state })
    },

    async connect(input) {
      const code = str(input.code)
      const realmId = str(input.realmId)
      if (!code || !realmId) throw new ConnectorError('invalid_input', 'QuickBooks sign-in did not return a code and company id', { provider: PROVIDER })
      const environment = input.environment === 'sandbox' ? 'sandbox' : 'production'
      const tokens = withSignInDeadline(await oauthFor(await endpoints(environment)).exchangeCode(code), clock.now())
      const cfg: QuickBooksConfig = { realmId, environment, homeCurrency: 'USD' }
      const http = client(cfg, tokens)
      const [prefs, info] = await Promise.all([
        http.request<QboObject>({ path: '/preferences', query: { minorversion: MINOR_VERSION } }),
        http.request<QboObject>({ path: `/companyinfo/${encodeURIComponent(realmId)}`, query: { minorversion: MINOR_VERSION } }),
      ])
      const p = isRecord(prefs.data.Preferences) ? prefs.data.Preferences : {}
      const currencyPrefs = isRecord(p.CurrencyPrefs) ? p.CurrencyPrefs : {}
      const home = isRecord(currencyPrefs.HomeCurrency) ? str(currencyPrefs.HomeCurrency.value) : undefined
      cfg.homeCurrency = normalizeCurrency(home, 'USD')
      const ci = isRecord(info.data.CompanyInfo) ? info.data.CompanyInfo : {}
      const name = str(ci.CompanyName)
      if (name) cfg.companyName = name
      const secret: QuickBooksSecret = { tokens }
      // The connection shows as "QuickBooks · <company>".
      return { secret, config: { ...cfg, ...(cfg.companyName ? { displayName: `QuickBooks · ${cfg.companyName}` } : {}) } }
    },

    async sync(conn, cursor): Promise<SyncResultWithSecret> {
      const cfg = readConfig(conn)
      const { tokens, refreshed } = await freshTokens(conn)
      // Intuit may rotate the refresh token: keep the new one before any page can fail and strand it.
      if (refreshed) await deps.saveSecret?.(conn.id, { tokens } satisfies QuickBooksSecret)
      const http = client(cfg, tokens)
      const now = clock.now()

      let state = codec.decode(cursor)
      // A new pass starts at the first phase: stamp when it began, so the next pass picks up from here.
      if (!state || state.p >= PHASES.length || (state.p === 0 && state.s === 1)) {
        state = { p: 0, s: 1, since: state?.since ?? null, mark: qboTime(now - OVERLAP_MS), started: new Date(now).toISOString() }
      }
      // CDC can't see deletions older than 30 days; restart as a full pass rather than miss one.
      if (state.p === 0 && state.s === 1 && state.since && now - Date.parse(state.since) > CDC_MAX_DAYS * 86_400_000) {
        state = { ...state, since: null }
      }

      const phase = PHASES[state.p] as (typeof PHASES)[number]
      // Lines need each account's QBO type to land in the right P&L section (one small query per run).
      const accounts = phase === 'Account' || phase === 'pnl' || phase === 'salestax' ? undefined : await chart(http)
      // Items: which lines buy or sell inventory, and at what cost.
      const items = phase === 'Account' || phase === 'pnl' || phase === 'cdc' || phase === 'salestax' ? undefined : await itemList(http, cfg.homeCurrency)
      const ctx: MapContext = { connectionId: conn.id, homeCurrency: cfg.homeCurrency, ...(accounts ? { accounts } : {}), ...(items ? { items } : {}) }
      const events: NormalizedEvent[] = []
      const warnings: string[] = []
      const ending = signInEndingWarning(tokens, now)
      if (ending) warnings.push(ending)
      let next: CursorState
      // One entity (or the report) this plan lacks is skipped with a warning; the rest of the pass goes on.
      const skipped = (what: string): CursorState => {
        warnings.push(planLimitWarning(what))
        return { ...state!, p: state!.p + 1, s: 1, skip: [...new Set([...(state!.skip ?? []), what])] }
      }

      if (phase === 'cdc') {
        if (state.since) {
          const r = await cdc(http, conn, ctx, state.since, now, new Set(state.skip ?? []))
          events.push(...r.events)
          warnings.push(...r.warnings)
        }
        next = { ...state, p: state.p + 1, s: 1 }
      } else if (phase === 'pnl') {
        try {
          events.push(...(await profitAndLoss(http, conn, ctx, cfg, now)))
          next = { ...state, p: state.p + 1, s: 1 }
        } catch (e) {
          if (!isPlanLimitError(e)) throw e
          next = skipped('pnl')
        }
      } else if (phase === 'salestax') {
        try {
          const r = await salesTaxPayments(http, conn, ctx, state.since, now)
          events.push(...r.events)
          if (r.unposted) warnings.push(`QuickBooks listed ${r.unposted} sales tax payment${r.unposted === 1 ? '' : 's'} Aggregate couldn't read, so sales tax owed here may be higher than in QuickBooks.`)
          next = { ...state, p: state.p + 1, s: 1 }
        } catch (e) {
          if (!isPlanLimitError(e)) throw e
          next = skipped('salestax')
        }
      } else {
        // Inactive accounts still carry history: without them their lines would lose their P&L section.
        const filters = [...(phase === 'Account' ? ['Active IN (true,false)'] : []), ...(state.since ? [`MetaData.LastUpdatedTime >= '${state.since}'`] : [])]
        const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : ''
        const query = `SELECT * FROM ${phase}${where} ORDERBY Id STARTPOSITION ${state.s} MAXRESULTS ${pageSize}`
        try {
          const res = await http.request<QboObject>({ path: '/query', query: { query, minorversion: MINOR_VERSION } })
          // QuickBooks keeps the QueryResponse envelope and omits the entity key when a query is empty, so a missing
          // entity key is a real empty page; a missing envelope or a null/non-object body is unreadable and must stop.
          if (!isRecord(res.data) || !isRecord(res.data.QueryResponse)) throw new ConnectorError('transient', 'QuickBooks sent a response Aggregate couldn’t read, so this sync stopped. No totals were changed.', { provider: PROVIDER })
          const qr = res.data.QueryResponse
          const items = Array.isArray(qr[phase]) ? (qr[phase] as unknown[]).filter(isRecord) : []
          for (const o of items) events.push(...(await mapEntity(phase, o, conn, ctx)))
          next = items.length >= pageSize ? { ...state, s: state.s + items.length } : { ...state, p: state.p + 1, s: 1 }
        } catch (e) {
          if (!isPlanLimitError(e) || phase === 'Account') throw e
          next = skipped(phase)
        }
      }

      const done = next.p >= PHASES.length
      // A full pass that listed every entity: the ledger voids what QuickBooks no longer has (deleted while CDC
      // couldn't see it, after 30 days). Not when the plan left an entity out: its documents weren't listed.
      if (done && next.since === null && next.started && !(next.skip ?? []).some((x) => x !== 'pnl' && x !== 'salestax')) {
        events.push({ type: 'listing.complete', externalId: `listing:${next.started}`, connectionId: conn.id, kinds: ['invoice', 'bill', 'payment', 'journal', 'credit_note'], startedAt: next.started })
      }
      const result: SyncResultWithSecret = {
        events,
        cursor: codec.encode(done ? { p: 0, s: 1, since: next.mark, mark: next.mark } : next),
        hasMore: !done,
        ...(warnings.length ? { warnings } : {}),
      }
      if (refreshed) result.updatedSecret = { tokens } satisfies QuickBooksSecret
      return result
    },

    /**
     * Revoke Aggregate's access at Intuit: POST the refresh token to the revoke endpoint (Basic client auth, JSON
     * body), which ends the access token too. No refresh first, so nothing rotates mid-disconnect. Intuit refusing
     * or not answering is reported, never silent: the local secret is wiped either way, and the person can remove
     * the app in QuickBooks themselves.
     */
    async disconnect(conn) {
      const { tokens } = requireSecret(PROVIDER, conn.secret, isSecret)
      const token = tokens.refreshToken ?? tokens.accessToken
      const basic = Buffer.from(`${opts.oauth.clientId}:${opts.oauth.clientSecret}`).toString('base64')
      const send = deps.fetch ?? fetch
      let problem: string | undefined
      try {
        const environment = conn.config.environment === 'sandbox' ? 'sandbox' : 'production'
        const res = await send((await endpoints(environment)).revoke, {
          method: 'POST',
          headers: { authorization: `Basic ${basic}`, accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
        })
        if (!res.ok) problem = `Intuit refused to revoke access (HTTP ${res.status})`
      } catch {
        problem = 'Intuit could not be reached to revoke access'
      }
      // Never a token in the message.
      if (problem) throw new ConnectorError('permanent', `${problem}. Remove Aggregate in QuickBooks under Settings → Apps.`, { provider: PROVIDER, forUser: true })
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        const cfg = readConfig(conn)
        // Never refreshes: Intuit rotates the refresh token, and health has nowhere to keep the new one. An expired
        // access token renews on the next sync.
        const t = requireSecret(PROVIDER, conn.secret, isSecret).tokens
        if (t.expiresAt !== undefined && t.expiresAt <= clock.now() && t.refreshToken) return { status: 'ok', message: 'The access token renews on the next sync.' }
        await client(cfg, t).request({ path: `/companyinfo/${encodeURIComponent(cfg.realmId)}`, query: { minorversion: MINOR_VERSION } })
        return { status: 'ok', lastSuccessAt: new Date(clock.now()).toISOString() }
      } catch (e) {
        return healthFromError(e)
      }
    },

    /**
     * Intuit webhooks: HMAC-SHA256 of the raw body with the app's verifier token, base64 in `intuit-signature`.
     * Returns one "sync this realm" outcome per company in the notice; the data itself always comes from the API.
     */
    verifyWebhook(req, verifierToken) {
      const sig = req.headers['intuit-signature']
      if (!sig || !signatureMatches(hmac('sha256', verifierToken, req.body), sig, 'base64')) return []
      return webhookOutcomes(req.body)
    },
    ...(opts.webhookVerifier
      ? {
          webhook: {
            async verify(req: WebhookRequest) {
              const sig = req.headers['intuit-signature']
              if (!sig || !signatureMatches(hmac('sha256', opts.webhookVerifier!, req.body), sig, 'base64')) throw new ConnectorError('auth', 'bad Intuit webhook signature', { provider: PROVIDER })
            },
            interpret: (req: WebhookRequest) => {
              const out = webhookOutcomes(req.body)
              return out.length ? out : [{ action: 'ignore' as const, dedupeKey: hmac('sha256', 'dedupe', req.body).toString('hex') }]
            },
          },
        }
      : {}),
  }

  /**
   * "Sync this company" once per realm a notice names. Two formats: the legacy { eventNotifications: [{ realmId }] }
   * and CloudEvents 1.0 (an array of envelopes whose `intuitaccountid` is the realm), which Intuit moves every app to
   * in 2026. The data itself always comes from the API, never from the notice.
   */
  function webhookOutcomes(raw: string): WebhookOutcome[] {
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      return []
    }
    const realms = new Set<string>()
    const legacy = isRecord(body) && Array.isArray(body.eventNotifications) ? body.eventNotifications.filter(isRecord) : []
    for (const n of legacy) if (str(n.realmId)) realms.add(str(n.realmId)!)
    const cloud = Array.isArray(body) ? body.filter(isRecord) : isRecord(body) && str(body.specversion) ? [body] : []
    for (const e of cloud) {
      const realm = str(e.intuitaccountid) ?? (isRecord(e.data) ? str(e.data.realmId) : undefined)
      if (realm) realms.add(realm)
    }
    const digest = hmac('sha256', 'dedupe', raw).toString('hex')
    return [...realms].map((realm) => ({ match: { field: 'realmId', value: realm }, action: 'sync' as const, dedupeKey: `${digest}:${realm}` }))
  }

  async function mapEntity(entity: Entity, o: QboObject, conn: ConnectionRef, ctx: MapContext): Promise<NormalizedEvent[]> {
    const id = str(o.Id)
    if (!id) return []
    const rawRef = await deps.raw.put(conn.id, `${PROVIDER}.${entity}`, id, o)
    const c: MapContext = { ...ctx, rawRef }
    const one = <T>(e: T | null): T[] => (e ? [e] : [])
    // Multicurrency companies: the rate QuickBooks booked the document at (ExchangeRate, home per 1 foreign).
    const cur = normalizeCurrency(isRecord(o.CurrencyRef) ? str(o.CurrencyRef.value) : undefined, ctx.homeCurrency)
    return withFx(eventsFor(), cur, providerFx(cur, ctx.homeCurrency, o.ExchangeRate))

    function eventsFor(): NormalizedEvent[] {
      switch (entity) {
        case 'Account':
          return one(mapAccount(o, c))
        case 'Invoice':
          return mapInvoiceEvents(o, c)
        case 'Bill':
          return mapBillEvents(o, c)
        case 'CreditMemo':
          return one(mapCredit(o, c, 'receivable'))
        case 'VendorCredit':
          return one(mapCredit(o, c, 'payable'))
        case 'Payment':
        case 'BillPayment': {
          const m = mapPayment(o, c, entity === 'Payment' ? 'receivable' : 'payable')
          return m ? [m.payment, ...m.creditPortions] : []
        }
        case 'Purchase':
        case 'SalesReceipt':
        case 'RefundReceipt':
        case 'Deposit':
          return mapCashEntity(entity, o, c)
        case 'JournalEntry':
          return one(mapJournalEntry(o, c))
      }
    }
  }

  async function itemList(http: HttpClient, currency: string) {
    if (itemCache && clock.now() - itemCache.at < 10 * 60_000) return itemCache.map
    const out = new Map<string, import('./map.ts').QboItemInfo>()
    itemCache = { at: clock.now(), map: out }
    for (let start = 1; ; start += 1000) {
      const res = await http.request<QboObject>({ path: '/query', query: { query: `SELECT * FROM Item WHERE Active IN (true,false) ORDERBY Id STARTPOSITION ${start} MAXRESULTS 1000`, minorversion: MINOR_VERSION } })
      if (!isRecord(res.data) || !isRecord(res.data.QueryResponse)) throw new ConnectorError('transient', 'QuickBooks sent a response Aggregate couldn’t read, so this sync stopped. No totals were changed.', { provider: PROVIDER })
      const qr = res.data.QueryResponse
      const rows = Array.isArray(qr.Item) ? (qr.Item as unknown[]).filter(isRecord) : []
      for (const [k, v] of itemIndex(rows, currency)) out.set(k, v)
      if (rows.length < 1000) return out
    }
  }

  /** The chart of accounts as a lookup (id → name, classification, AccountType). */
  async function chart(http: HttpClient): Promise<Map<string, QboAccountInfo>> {
    if (chartCache && clock.now() - chartCache.at < 10 * 60_000) return chartCache.map
    const out = new Map<string, QboAccountInfo>()
    chartCache = { at: clock.now(), map: out }
    for (let start = 1; ; start += 1000) {
      const res = await http.request<QboObject>({ path: '/query', query: { query: `SELECT * FROM Account WHERE Active IN (true,false) ORDERBY Id STARTPOSITION ${start} MAXRESULTS 1000`, minorversion: MINOR_VERSION } })
      if (!isRecord(res.data) || !isRecord(res.data.QueryResponse)) throw new ConnectorError('transient', 'QuickBooks sent a response Aggregate couldn’t read, so this sync stopped. No totals were changed.', { provider: PROVIDER })
      const qr = res.data.QueryResponse
      const rows = Array.isArray(qr.Account) ? (qr.Account as unknown[]).filter(isRecord) : []
      for (const [k, v] of accountIndex(rows)) out.set(k, v)
      if (rows.length < 1000) return out
    }
  }

  /**
   * Deletions since `since`, from CDC (it only looks back 30 days; the 29-day guard in sync starts a full pass
   * instead). One call per entity: Intuit caps a response at 1,000 objects and lists deleted ones after the changed
   * ones, so a busy entity can't push another's deletions out, and an entity this plan lacks fails alone. CDC has
   * no end date, so a capped entity can't be split further: it gets a warning rather than a silent gap.
   */
  async function cdc(http: HttpClient, conn: ConnectionRef, ctx: MapContext, since: string, now: number, skip: Set<string>): Promise<{ events: NormalizedEvent[]; warnings: string[] }> {
    const out: NormalizedEvent[] = []
    const warnings: string[] = []
    for (const entity of ENTITIES.filter((e) => e !== 'Account' && !skip.has(e))) {
      let res: { data: QboObject }
      try {
        res = await http.request<QboObject>({ path: '/cdc', query: { entities: entity, changedSince: since, minorversion: MINOR_VERSION } })
      } catch (e) {
        if (isPlanLimitError(e)) continue // already said when its query was skipped
        throw e
      }
      let count = 0
      const responses = Array.isArray(res.data.CDCResponse) ? res.data.CDCResponse.filter(isRecord) : []
      for (const r of responses) {
        const qrs = Array.isArray(r.QueryResponse) ? r.QueryResponse.filter(isRecord) : []
        for (const qr of qrs) {
          for (const [kind, list] of Object.entries(qr)) {
            if (!Array.isArray(list)) continue
            count += list.length
            for (const o of list.filter(isRecord)) {
              if (str(o.status) !== 'Deleted') continue // changes are picked up by the queries
              const id = str(o.Id)
              if (!id) continue
              const meta = isRecord(o.MetaData) ? o.MetaData : {}
              const day = (str(meta.LastUpdatedTime) ?? new Date(now).toISOString()).slice(0, 10)
              const rawRef = await deps.raw.put(conn.id, `${PROVIDER}.${kind}.deleted`, id, o)
              const c = { ...ctx, rawRef }
              if (kind === 'JournalEntry') {
                out.push(deletedJournal(id, c, day))
                continue
              }
              if ((CASH_ENTITIES as readonly string[]).includes(kind)) out.push(...deletedCashEvents(kind as CashEntity, id, c, day))
              const e = deletedEvent(kind, id, c, day)
              if (e) out.push(e)
              if (kind === 'Invoice') out.push(voidCogs(id, c, day))
            }
          }
        }
      }
      if (count >= CDC_CAP) warnings.push(`QuickBooks changed more ${PLAN_NAMES[entity] ?? entity} than it reports at once (1,000), so some deleted in QuickBooks may still count here. They're picked up when they change again.`)
    }
    return { events: out, warnings }
  }

  /**
   * Sales tax payments (see mapSalesTaxPayments). A full pass reads all of history, so the listing that voids what
   * QuickBooks no longer has sees every one; an incremental pass re-reads from 30 days before its start.
   */
  async function salesTaxPayments(http: HttpClient, conn: ConnectionRef, ctx: MapContext, since: string | null, now: number) {
    const from = since ? new Date(Date.parse(since) - CDC_MAX_DAYS * 86_400_000).toISOString().slice(0, 10) : '2000-01-01'
    const to = localDay(now, conn.timeZone)
    const res = await http.request<QboObject>({
      path: '/reports/TransactionList',
      query: { start_date: from, end_date: to, accounting_method: 'Accrual', columns: 'tx_date,txn_type,memo,subt_nat_amount,is_no_post', minorversion: MINOR_VERSION },
    })
    const rawRef = await deps.raw.put(conn.id, `${PROVIDER}.TransactionList`, `${from}:${to}`, res.data)
    return mapSalesTaxPayments(res.data, { ...ctx, rawRef })
  }

  async function profitAndLoss(http: HttpClient, conn: ConnectionRef, ctx: MapContext, cfg: QuickBooksConfig, now: number): Promise<NormalizedEvent[]> {
    // QuickBooks doesn't report the company's time zone (report times are Intuit's server zone), so the workspace's is used.
    const periods = monthPeriods(localDay(now, conn.timeZone), cfg.pnlMonths ?? 3)
    const out: NormalizedEvent[] = []
    for (const p of periods) {
      const res = await http.request<QboObject>({
        path: '/reports/ProfitAndLoss',
        query: { start_date: p.from, end_date: p.to, accounting_method: 'Accrual', minorversion: MINOR_VERSION },
      })
      const rawRef = await deps.raw.put(conn.id, `${PROVIDER}.ProfitAndLoss`, `${p.from}:${p.to}`, res.data)
      out.push(mapProfitAndLoss(res.data, { ...ctx, rawRef }, { ...p, basis: 'accrual' }))
    }
    return out
  }
}

/**
 * When Intuit ends this sign-in, kept in the token extras as epoch ms. Each token response says how long the refresh
 * token has left (x_refresh_token_expires_in, seconds): about 100 days while it's used, less only as Intuit's
 * five-year limit on a sign-in comes near.
 */
function withSignInDeadline(t: OAuthTokens, now: number): OAuthTokens {
  const secs = [t.extra?.x_refresh_token_expires_in, t.extra?.x_refresh_token_hard_expires_in].map(Number).filter((n) => Number.isFinite(n) && n > 0)
  if (!secs.length) return t
  return { ...t, extra: { ...t.extra, refreshExpiresAt: now + Math.min(...secs) * 1000 } }
}

const SIGN_IN_WARN_MS = 30 * 86_400_000

/** "Reconnect before <date>" once the sign-in ends within 30 days, so syncing doesn't just stop one day. */
function signInEndingWarning(t: OAuthTokens, now: number): string | undefined {
  const at = t.extra?.refreshExpiresAt
  if (typeof at !== 'number' || at - now > SIGN_IN_WARN_MS) return undefined
  const day = new Date(at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  return `QuickBooks ends this sign-in on ${day} (Intuit limits a sign-in to five years). Reconnect QuickBooks before then to keep syncing.`
}

