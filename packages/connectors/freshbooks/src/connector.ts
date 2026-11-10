// FreshBooks connector (read-only): invoices, payments, bills, bill payments, expenses, adjustment journals and the
// monthly P&L shown as "Books". Built from FreshBooks' API documentation alone; never run on a real account.
//
// OAuth 2.0. Scopes aren't sent on the sign-in link: they're set on the app in FreshBooks' developer page. Refresh
// tokens are single-use and a new sign-in by the same person invalidates older ones, so every business from one
// sign-in shares one token (config.sharedSecretKey).
//
// Each list is paged by page/per_page (FreshBooks caps per_page at 100). Invoices, payments and expenses filter on
// search[updated_min], a day back because it takes a date; a second read of each with search[vis_state]=1 picks up
// deletions, which lists otherwise leave out. Bills, bill payments and journals have no documented updated filter, so
// they're read whole every pass and a scoped listing.complete takes out what's gone.
//
// FreshBooks publishes no rate limit numbers ("too many calls within a short period"; no daily cap). We pace at 2/s.
import type { Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent } from '@agfn/contracts'
import {
  type ConnectorDeps,
  ConnectorError,
  cursorCodec,
  healthFromError,
  HttpClient,
  isRecord,
  localDay,
  monthPeriods,
  normalizeCurrency,
  OAuthClient,
  type OAuthTokens,
  requireSecret,
  str,
  type SyncResultWithSecret,
  systemClock,
} from '@agfn/connector-sdk'
import { accountRoles, customerName, idOf, mapBill, mapBillPayment, mapExpense, mapInvoice, mapJournal, mapPayment, mapProfitAndLoss, vendorName, type FbObject, type MapContext } from './map.ts'

export const PROVIDER = 'freshbooks'
const AUTHORIZE_URL = 'https://auth.freshbooks.com/oauth/authorize/'
const API = 'https://api.freshbooks.com'
const TOKEN_URL = `${API}/auth/oauth/token`
const REVOKE_URL = `${API}/auth/oauth/revoke`
const ME_PATH = '/auth/api/v1/users/me'
const JOURNAL_API_VERSION = '2023-09-25'
const NOT_REVOKED = 'In FreshBooks, go to your account’s connected apps → Remove Aggregate.'

/**
 * What the sync reads, for the app's scope list in FreshBooks' developer page. The token carries what's ticked there;
 * the sign-in link doesn't name them. The chart of accounts page states no scope, so reports:read is our reading of it.
 */
export const DEFAULT_SCOPES = ['user:profile:read', 'user:invoices:read', 'user:payments:read', 'user:bills:read', 'user:bill_payments:read', 'user:bill_vendors:read', 'user:expenses:read', 'user:journal_entries:read', 'user:reports:read']

const OVERLAP_DAYS = 1
/** A Retry-After longer than this stops the sync instead of sleeping; the scheduler comes back. */
const MAX_WAIT_MS = 2 * 60_000

const INCREMENTAL = {
  invoices: { path: 'invoices/invoices', key: 'invoices', include: 'lines' },
  payments: { path: 'payments/payments', key: 'payments' },
  expenses: { path: 'expenses/expenses', key: 'expenses', include: 'category' },
} as const
type Incremental = keyof typeof INCREMENTAL
const PHASES = ['invoices', 'payments', 'expenses', 'invoices:deleted', 'payments:deleted', 'expenses:deleted', 'bills', 'bill_payments', 'chart', 'journals', 'pnl'] as const

export interface FreshBooksSecret {
  tokens: OAuthTokens
}

export interface FreshBooksConfig {
  /** In /accounting/account/<accountId>/… paths. */
  accountId: string
  /** In /accounting/businesses/<uuid>/… paths: the P&L, chart of accounts and journals. */
  businessUuid?: string
  businessName?: string
  baseCurrency: string
  pnlMonths?: number
}

export interface FreshBooksOptions {
  deps: ConnectorDeps
  oauth: { clientId: string; clientSecret: string; redirectUri: string }
  /** Rows per page; FreshBooks caps it at 100. */
  pageSize?: number
}

interface CursorState {
  p: number
  page: number
  /** updated_min for this pass (YYYY-MM-DD); null on the first. */
  since: string | null
  /** The next pass's updated_min. */
  mark: string
  /** When this pass began: the listings name it. */
  started: string
  /** Account uuid → role, for journals in later pages. */
  roles?: Record<string, string>
  currency?: string
}

const isState = (v: unknown): v is CursorState => isRecord(v) && typeof v.p === 'number' && typeof v.page === 'number' && (v.since === null || typeof v.since === 'string') && typeof v.mark === 'string' && typeof v.started === 'string'
/** Mapping version: bump when the mapping changes, so existing connections re-read everything once. */
export const MAPPING_VERSION = 1
const codec = cursorCodec<CursorState>(PROVIDER, MAPPING_VERSION, isState)
const isSecret = (s: unknown): s is FreshBooksSecret => isRecord(s) && isRecord(s.tokens) && typeof s.tokens.accessToken === 'string'

function readConfig(conn: ConnectionRef): FreshBooksConfig {
  const accountId = str(conn.config.accountId)
  if (!accountId) throw new ConnectorError('invalid_input', 'connection has no FreshBooks account', { provider: PROVIDER })
  const cfg: FreshBooksConfig = { accountId, baseCurrency: normalizeCurrency(str(conn.config.baseCurrency), 'USD') }
  const uuid = str(conn.config.businessUuid)
  if (uuid) cfg.businessUuid = uuid
  if (typeof conn.config.pnlMonths === 'number') cfg.pnlMonths = Math.max(0, Math.min(24, Math.floor(conn.config.pnlMonths)))
  return cfg
}

function errorDetail(body: unknown, status: number): string {
  const b = isRecord(body) ? body : {}
  const response = isRecord(b.response) ? b.response : {}
  const first = Array.isArray(response.errors) && isRecord(response.errors[0]) ? response.errors[0] : {}
  return (str(first.message) ?? str(b.message) ?? str(b.error_description) ?? `HTTP ${status}`).slice(0, 300)
}

export function classifyFreshBooksError({ status, headers, body }: { status: number; headers: Headers; body: unknown }): ConnectorError | undefined {
  const opts = { provider: PROVIDER, status }
  const detail = errorDetail(body, status)
  if (status === 401 || status === 403) return new ConnectorError('auth', detail, opts)
  if (status === 429) {
    const ra = Number(headers.get('retry-after') ?? '')
    const retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 60_000
    if (retryAfterMs > MAX_WAIT_MS) return new ConnectorError('rate_limited', `FreshBooks rate limit; retry in ${Math.ceil(retryAfterMs / 60_000)} min`, { ...opts, code: 'limit' })
    return new ConnectorError('rate_limited', 'FreshBooks rate limit', { ...opts, retryAfterMs })
  }
  if (status >= 500) return new ConnectorError('transient', detail, opts)
  return new ConnectorError('permanent', detail, opts)
}

/** FreshBooks' docs show no token response; they say to check the expiry in the token. Prefer expires_in, else the JWT's. */
function withExpiry(tokens: OAuthTokens): OAuthTokens {
  if (tokens.expiresAt !== undefined) return tokens
  try {
    const exp = (JSON.parse(Buffer.from(tokens.accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>).exp
    return typeof exp === 'number' ? { ...tokens, expiresAt: exp * 1000 } : tokens
  } catch {
    return tokens
  }
}

/** Accounting lists wrap their rows in response.result; the newer endpoints answer bare. */
function result(data: unknown): FbObject {
  // A present object is read as-is (an empty list key is a real empty page); a null/non-object body (an empty body, or
  // the sign-in/error page the shared client rejects as non-JSON) is unreadable and must stop, never read as zero.
  if (!isRecord(data)) throw new ConnectorError('transient', 'FreshBooks sent a response Aggregate couldn’t read, so this sync stopped. No totals were changed.', { provider: PROVIDER })
  const response = isRecord(data.response) ? data.response : data
  return isRecord(response.result) ? response.result : response
}
const rows = (r: FbObject, key: string): FbObject[] => (Array.isArray(r[key]) ? r[key].filter(isRecord) : [])
const forbidden = (e: unknown): boolean => e instanceof ConnectorError && e.status === 403

export function createFreshBooksConnector(opts: FreshBooksOptions): Connector & { authorizationUrl(state: string): string } {
  const { deps } = opts
  const clock = deps.clock ?? systemClock
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 100))
  const oauth = new OAuthClient({
    provider: PROVIDER,
    authorizeUrl: AUTHORIZE_URL,
    tokenUrl: TOKEN_URL,
    clientId: opts.oauth.clientId,
    clientSecret: opts.oauth.clientSecret,
    redirectUri: opts.oauth.redirectUri,
    clientAuth: 'body',
    tokenBody: 'json',
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    clock,
  })

  async function fresh(tokens: OAuthTokens): Promise<{ tokens: OAuthTokens; refreshed: boolean }> {
    if (!oauth.isExpired(tokens)) return { tokens, refreshed: false }
    return { tokens: withExpiry(await oauth.refresh(tokens, { redirect_uri: opts.oauth.redirectUri })), refreshed: true }
  }

  function client(tokens: OAuthTokens): HttpClient {
    return new HttpClient({
      provider: PROVIDER,
      baseUrl: API,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      clock,
      ...(deps.random ? { random: deps.random } : {}),
      rateLimit: { perSecond: 2, burst: 5 },
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      classifyError: classifyFreshBooksError,
    })
  }

  const me = (http: HttpClient) => http.request<unknown>({ path: ME_PATH, headers: { 'api-version': 'alpha' } })

  const description: ConnectorDescription = {
    key: PROVIDER,
    name: 'FreshBooks',
    group: 'accounting',
    provides: ['invoices', 'bills', 'reports'],
    freshness: 'syncs every few hours',
    auth: 'oauth',
    dataVersion: MAPPING_VERSION,
  }

  return {
    describe: () => description,

    authorizationUrl(state) {
      return oauth.authorizationUrl({ state })
    },

    /** One connection per business the person can reach; they share the token. */
    async connect(input) {
      const code = str(input.code)
      if (!code) throw new ConnectorError('invalid_input', 'FreshBooks sign-in did not return a code', { provider: PROVIDER })
      const tokens = withExpiry(await oauth.exchangeCode(code))
      const res = await me(client(tokens))
      const d = isRecord(res.data) && isRecord(res.data.response) ? res.data.response : {}
      const memberships = Array.isArray(d.business_memberships) ? d.business_memberships.filter(isRecord) : []
      const businesses = memberships.map((m) => (isRecord(m.business) ? m.business : {})).filter((b) => str(b.account_id))
      if (!businesses.length) throw new ConnectorError('invalid_input', 'This FreshBooks sign-in has no business to read', { provider: PROVIDER, forUser: true })
      const secret: FreshBooksSecret = { tokens }
      const identity = idOf(d.id)
      const shared = businesses.length > 1 ? { sharedSecretKey: `freshbooks:${identity ?? str(businesses[0]!.account_id)}` } : {}
      const results = businesses.map((b) => {
        const name = str(b.name)
        const uuid = str(b.business_uuid)
        const config = { accountId: str(b.account_id), baseCurrency: 'USD', ...(uuid ? { businessUuid: uuid } : {}), ...(name ? { businessName: name, displayName: `FreshBooks · ${name}` } : {}), ...shared }
        return { secret, config }
      })
      const [first, ...rest] = results
      return { ...first!, ...(rest.length ? { additional: rest } : {}) }
    },

    /** Ends the grant at FreshBooks. Another business on the same sign-in keeps using the token, so only the last revokes. */
    async disconnect(conn) {
      const { tokens } = requireSecret(PROVIDER, conn.secret, isSecret)
      if (conn.config.sharedSecretKey && conn.config.lastOfGrant !== true) return
      const send = deps.fetch ?? fetch
      try {
        const res = await send(REVOKE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ client_id: opts.oauth.clientId, client_secret: opts.oauth.clientSecret, token: tokens.refreshToken ?? tokens.accessToken }),
        })
        if (!res.ok) return { notRevoked: NOT_REVOKED }
      } catch {
        return { notRevoked: NOT_REVOKED }
      }
      return undefined
    },

    async sync(conn, cursor): Promise<SyncResultWithSecret> {
      const cfg = readConfig(conn)
      const secret = requireSecret(PROVIDER, conn.secret, isSecret)
      const { tokens, refreshed } = await fresh(secret.tokens)
      // Single-use: keep the new one before any page can fail and strand it.
      if (refreshed) await deps.saveSecret?.(conn.id, { tokens } satisfies FreshBooksSecret)
      const http = client(tokens)
      const now = clock.now()

      let state = codec.decode(cursor)
      if (!state || state.p >= PHASES.length || (state.p === 0 && state.page === 1)) {
        const mark = new Date(now - OVERLAP_DAYS * 86_400_000).toISOString().slice(0, 10)
        state = { p: 0, page: 1, since: state?.since ?? null, mark, started: new Date(now).toISOString() }
      }
      const ctx: MapContext = { connectionId: conn.id, baseCurrency: normalizeCurrency(state.currency, cfg.baseCurrency), ...(state.roles ? { roles: state.roles } : {}) }
      const account = `/accounting/account/${encodeURIComponent(cfg.accountId)}`
      const business = cfg.businessUuid ? `/accounting/businesses/${encodeURIComponent(cfg.businessUuid)}` : undefined
      const phase = PHASES[state.p] as (typeof PHASES)[number]
      const events: NormalizedEvent[] = []
      const warnings: string[] = []
      let next: CursorState = { ...state, p: state.p + 1, page: 1 }

      /** One page of an accounting list; moves the cursor on to the next page while there is one. */
      const page = async (path: string, key: string, query: Record<string, string | number>): Promise<FbObject[]> => {
        const res = await http.request<unknown>({ path: `${account}/${path}`, query: { page: state.page, per_page: pageSize, ...query } })
        const r = result(res.data)
        if (typeof r.pages === 'number' && state.page < r.pages) next = { ...state, page: state.page + 1 }
        return rows(r, key)
      }
      const listing = (kind: 'bill' | 'payment' | 'journal', scope: string): NormalizedEvent => ({ type: 'listing.complete', externalId: `listing:${scope}${state.started}`, connectionId: conn.id, kinds: [kind], startedAt: state.started, scope })

      /** A section this plan or sign-in can't read: skip it, say so, and leave its records alone (no listing). */
      const unlessRefused = async (what: string, read: () => Promise<void>): Promise<void> => {
        try {
          await read()
        } catch (e) {
          if (!forbidden(e)) throw e
          events.length = 0
          next = { ...state, p: state.p + 1, page: 1 }
          warnings.push(`FreshBooks refused ${what} for this sign-in, so they were skipped.`)
        }
      }

      if (phase === 'bills') await unlessRefused('bills', async () => {
        const list = await page('bills/bills', 'bills', { 'include[]': 'vendor' })
        for (const o of list) {
          const id = idOf(o.id)
          if (!id) continue
          const e = mapBill(o, { ...ctx, rawRef: await deps.raw.put(conn.id, `${PROVIDER}.bill`, id, o) })
          if (e) events.push(e)
        }
        if (next.p !== state.p) events.push(listing('bill', 'bill:'))
      })
      else if (phase === 'bill_payments') await unlessRefused('bill payments', async () => {
        const list = await page('bill_payments/bill_payments', 'bill_payments', {})
        const vendors = await names(`${account}/bills/bills`, 'bills', 'search[ids][]', list.map((o) => idOf(o.billid)), { 'include[]': 'vendor' }, vendorName, (b) => idOf(b.id))
        for (const o of list) {
          const id = idOf(o.id)
          if (!id) continue
          const e = mapBillPayment(o, { ...ctx, rawRef: await deps.raw.put(conn.id, `${PROVIDER}.bill_payment`, id, o) }, vendors.get(idOf(o.billid) ?? ''))
          if (e) events.push(e)
        }
        if (next.p !== state.p) events.push(listing('payment', 'bp:'))
      })
      else if (phase === 'chart') {
        // Without the chart nothing can be shown not to touch a bank, so no journal is read.
        delete next.roles
        if (!business) warnings.push('FreshBooks did not give this business an id for journal entries, so they were skipped.')
        else {
          try {
            const res = await http.request<unknown>({ path: `${business}/reports/chart_of_accounts`, query: { use_ledger_entries: true } })
            next.roles = accountRoles(rows(result(res.data), 'journal_entry_accounts'))
          } catch (e) {
            if (!forbidden(e)) throw e
            warnings.push('FreshBooks refused the chart of accounts, so journal entries were skipped.')
          }
        }
      } else if (phase === 'journals') {
        if (business && state.roles) await unlessRefused('journal entries', async () => {
          const res = await http.request<unknown>({ path: `${business}/journal_entries`, query: { page_number: state.page, page_size: pageSize }, headers: { 'x-api-version': JOURNAL_API_VERSION } })
          const r = result(res.data)
          const pages = isRecord(r.page) && typeof r.page.pages === 'number' ? r.page.pages : 1
          if (state.page < pages) next = { ...state, page: state.page + 1 }
          for (const o of rows(r, 'manualJournalEntries')) {
            const id = idOf(o.id)
            if (!id) continue
            const e = mapJournal(o, { ...ctx, rawRef: await deps.raw.put(conn.id, `${PROVIDER}.journal`, id, o) })
            if (e) events.push(e)
          }
          if (next.p !== state.p) events.push(listing('journal', 'je:'))
        })
      } else if (phase === 'pnl') {
        if (business) {
          try {
            for (const p of monthPeriods(localDay(now, conn.timeZone), cfg.pnlMonths ?? 3)) {
              const res = await http.request<unknown>({ path: `${business}/reports/profit_and_loss`, query: { start_date: p.from, end_date: p.to, cash_based: false, use_ledger_entries: true } })
              const report = result(res.data)
              const body = isRecord(report.profit_and_loss) ? report.profit_and_loss : report
              const e = mapProfitAndLoss(body, { ...ctx, rawRef: await deps.raw.put(conn.id, `${PROVIDER}.profit_and_loss`, `${p.from}:${p.to}`, body) }, p)
              if (e) events.push(e)
            }
          } catch (e) {
            if (!forbidden(e)) throw e
            warnings.push('FreshBooks refused the profit and loss report for this sign-in, so it wasn’t checked. The business owner can connect instead.')
          }
        } else warnings.push('FreshBooks did not give this business an id for its profit and loss report, so it wasn’t checked.')
      } else {
        const removed = phase.endsWith(':deleted')
        const name = phase.replace(':deleted', '') as Incremental
        const l = INCREMENTAL[name]
        const include: Record<string, string> = 'include' in l ? { 'include[]': l.include } : {}
        const list = await page(l.path, l.key, { ...include, ...(state.since ? { 'search[updated_min]': state.since } : {}), ...(removed ? { 'search[vis_state]': 1 } : {}) })
        const customers = name === 'payments' && !removed ? await names(`${account}/invoices/invoices`, 'invoices', 'search[invoiceids][]', list.map((o) => idOf(o.invoiceid)), {}, customerName, (i) => idOf(i.invoiceid) ?? idOf(i.id)) : new Map<string, string>()
        for (const o of list) {
          const id = idOf(o.id) ?? idOf(o.invoiceid) ?? idOf(o.expenseid)
          if (!id) continue
          const c = { ...ctx, rawRef: await deps.raw.put(conn.id, `${PROVIDER}.${name}`, id, o) }
          if (name === 'invoices') {
            const e = mapInvoice(o, c)
            if (e) events.push(e)
          } else if (name === 'payments') {
            const e = mapPayment(o, c, customers.get(idOf(o.invoiceid) ?? ''))
            if (e) events.push(e)
          } else events.push(...mapExpense(o, c))
        }
      }

      /** Names for the ids on this page, one request: payments carry an id, and incremental pages don't include the document. */
      async function names(path: string, key: string, filter: string, ids: Array<string | undefined>, extra: Record<string, string>, name: (o: FbObject) => string | undefined, id: (o: FbObject) => string | undefined): Promise<Map<string, string>> {
        const wanted = [...new Set(ids.filter((x): x is string => !!x))]
        const out = new Map<string, string>()
        if (!wanted.length) return out
        const res = await http.request<unknown>({ path, query: { per_page: 100, [filter]: wanted, ...extra } })
        for (const o of rows(result(res.data), key)) {
          const k = id(o)
          const v = name(o)
          if (k && v) out.set(k, v)
        }
        return out
      }

      const done = next.p >= PHASES.length
      const out: SyncResultWithSecret = {
        events,
        cursor: codec.encode(done ? { p: 0, page: 1, since: next.mark, mark: next.mark, started: next.started } : next),
        hasMore: !done,
        ...(warnings.length ? { warnings } : {}),
      }
      if (refreshed) out.updatedSecret = { tokens } satisfies FreshBooksSecret
      return out
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        const secret = requireSecret(PROVIDER, conn.secret, isSecret)
        // Never refreshes: health has nowhere to keep a single-use token. An expired one renews on the next sync.
        const t = secret.tokens
        if (t.expiresAt !== undefined && t.expiresAt <= clock.now() && t.refreshToken) return { status: 'ok', message: 'The access token renews on the next sync.' }
        await me(client(t))
        return { status: 'ok', lastSuccessAt: new Date(clock.now()).toISOString() }
      } catch (e) {
        return healthFromError(e)
      }
    },
  }
}
