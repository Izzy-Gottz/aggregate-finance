// BILL (Bill.com) connector, Connect API v3 (MASTER.md §5 "Accounting & invoices").
//
// Auth: a developer key (made by an org admin in Settings → Sync & Integrations) plus a BILL user login for that
// organisation. POST /v3/login returns a session id (35 minutes idle); every call sends `devKey` + `sessionId`.
// Sessions are cached per connection in memory and re-created once when BILL says the session ended.
// Read-only: bills, payments made, vendor credits, invoices (AR), payments received. Nothing is ever paid.
//
// Limits: 20,000 calls/hour per dev key (BDC_1144: wait for the next hour), 200 logins/hour, 3 concurrent calls per
// organisation (we run 1 at a time). The login response has no organisation name (sessionId, organizationId, userId,
// trusted); the name comes from GET /v3/login/session when BILL returns it.
import type { Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, SyncResult } from '@agfn/contracts'
import {
  type ConnectorDeps,
  ConnectorError,
  cursorCodec,
  healthFromError,
  HttpClient,
  isConnectorError,
  isRecord,
  normalizeCurrency,
  requireSecret,
  str,
  systemClock,
} from '@agfn/connector-sdk'
import { mapBill, mapInvoice, mapPaymentMade, mapPaymentReceived, mapVendorCredit, type BillObject, type MapContext } from './map.ts'

export const PROVIDER = 'billcom'
const API = { production: 'https://gateway.prod.bill.com/connect', sandbox: 'https://gateway.stage.bill.com/connect' } as const
const SESSION_TTL_MS = 30 * 60_000
const OVERLAP_MS = 5 * 60_000
/** Name maps live in the cursor; past this size we fall back to ids (names still come from bills' vendorName). */
const MAX_NAMES = 5_000

const PHASES = [
  { phase: 'customers', path: '/v3/customers', filter: true },
  { phase: 'vendors', path: '/v3/vendors', filter: true },
  { phase: 'bills', path: '/v3/bills', filter: true },
  { phase: 'vendorCredits', path: '/v3/vendor-credits', filter: true },
  { phase: 'payments', path: '/v3/payments', filter: true },
  { phase: 'invoices', path: '/v3/invoices', filter: true },
  { phase: 'receivablePayments', path: '/v3/receivable-payments', filter: true },
] as const
type Phase = (typeof PHASES)[number]['phase']

export interface BillSecret {
  /** The company's own developer key. Absent when the server's app-partner key signs in (sync-token connect). */
  devKey?: string
  username: string
  password: string
  organizationId: string
  /** From a trusted-device login, so MFA isn't asked on every sync. */
  rememberMeId?: string
  device?: string
}

export interface BillConfig {
  environment: 'production' | 'sandbox'
  currency: string
  organizationName?: string
}

interface CursorState {
  p: number
  page: string | null
  since: string | null
  mark: string
  customers: Record<string, string>
  vendors: Record<string, string>
}

const isState = (v: unknown): v is CursorState =>
  isRecord(v) && typeof v.p === 'number' && (v.page === null || typeof v.page === 'string') && (v.since === null || typeof v.since === 'string') && typeof v.mark === 'string' && isRecord(v.customers) && isRecord(v.vendors)
const codec = cursorCodec<CursorState>(PROVIDER, 1, isState)
const isSecret = (s: unknown): s is BillSecret =>
  isRecord(s) && (s.devKey === undefined || typeof s.devKey === 'string') && typeof s.username === 'string' && typeof s.password === 'string' && typeof s.organizationId === 'string'

/** Milliseconds until the start of the next hour (UTC), plus a minute so we don't arrive right at the edge. */
const untilNextHour = (now: number) => 3_600_000 - (now % 3_600_000) + 60_000

/**
 * BILL errors come back as an array: [{ timestamp, code: "BDC_1109", message, severity, category }]. The code is what
 * counts; BILL doesn't document which HTTP status goes with which code. Codes from developer.bill.com "Common API
 * error codes" and "API rate limits".
 */
export function classifyBillError({ status, body }: { status: number; body: unknown }, now: number = Date.now()): ConnectorError | undefined {
  const first = Array.isArray(body) && isRecord(body[0]) ? body[0] : isRecord(body) ? body : {}
  const code = str(first.code)
  const message = (str(first.message) ?? `HTTP ${status}`).slice(0, 300)
  const opts = { provider: PROVIDER, status, ...(code ? { code } : {}) }
  // Session ended (35 minutes idle): log in again once. BDC_1112 isn't documented; kept as a session error.
  if (code === 'BDC_1109' || code === 'BDC_1112') return new ConnectorError('auth', message, { ...opts, code: 'session_expired' })
  // Hand-written for people (forUser): the sign-in is a user login or, with the partner key, an AP/AR sync token
  // (which stops working when it's archived in BILL).
  if (code === 'BDC_1101')
    return new ConnectorError('auth', "BILL didn't accept the sign-in: the user login or sync token is wrong, or the sync token was archived. Reconnect BILL with current details.", { ...opts, forUser: true })
  if (code === 'BDC_1102') return new ConnectorError('auth', 'BILL says the developer key is invalid. Reconnect BILL with a current key.', { ...opts, forUser: true })
  if (code === 'BDC_1361') return new ConnectorError('auth', 'BILL needs this sign-in confirmed (two-step verification). Reconnect BILL and trust this device.', { ...opts, forUser: true })
  // Permissions for this user or organisation: signing in again won't help, the BILL admin has to change them.
  if (code === 'BDC_1145') return new ConnectorError('auth', `${message} (the BILL user needs permission to read bills and invoices)`, { ...opts, code: 'permission' })
  // 20,000 calls per hour per developer key: wait for the next hour. 3 concurrent calls per organisation: a moment.
  if (code === 'BDC_1144') return new ConnectorError('rate_limited', message, { ...opts, retryAfterMs: untilNextHour(now) })
  if (code === 'BDC_1322' || status === 429) return new ConnectorError('rate_limited', message, { ...opts, retryAfterMs: 2_000 })
  if (status === 401 || status === 403) return new ConnectorError('auth', message, opts)
  if (status >= 500) return new ConnectorError('transient', message, opts)
  return new ConnectorError('permanent', message, opts)
}

export interface BillOptions {
  deps: ConnectorDeps
  pageSize?: number
  /**
   * Aggregate's BILL app-partner developer keys, per environment (BILL_DEV_KEY, BILL_SANDBOX_DEV_KEY). With one, a
   * customer connects with an AP/AR sync token (name as `username`, token as `password`) and their organization id;
   * the partner key is read from here at each sign-in, never stored with the connection.
   */
  partnerDevKeys?: Partial<Record<BillConfig['environment'], string>>
}

export function createBillConnector(opts: BillOptions): Connector {
  const { deps } = opts
  const clock = deps.clock ?? systemClock
  const max = Math.min(100, Math.max(1, opts.pageSize ?? 100))
  const sessions = new Map<string, { id: string; at: number }>()

  function env(conn: { config: Record<string, unknown> }): BillConfig {
    return { environment: conn.config.environment === 'sandbox' ? 'sandbox' : 'production', currency: normalizeCurrency(str(conn.config.currency), 'USD') }
  }

  function http(environment: BillConfig['environment'], headers: Record<string, string>): HttpClient {
    return new HttpClient({
      provider: PROVIDER,
      baseUrl: API[environment],
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      clock,
      ...(deps.random ? { random: deps.random } : {}),
      rateLimit: { perSecond: 4, burst: 1 },
      headers,
      classifyError: (info) => classifyBillError(info, clock.now()),
    })
  }

  /** The company's own key when it gave one, else the partner key for that environment. */
  function devKeyFor(secret: BillSecret, environment: BillConfig['environment']): string {
    const key = secret.devKey || opts.partnerDevKeys?.[environment]
    if (!key) throw new ConnectorError('auth', `This server has no BILL developer key for ${environment}. Connect again with your own developer key.`, { provider: PROVIDER, code: 'no_dev_key' })
    return key
  }

  async function login(secret: BillSecret, environment: BillConfig['environment']): Promise<{ sessionId: string; organizationName?: string }> {
    const body: Record<string, string> = { devKey: devKeyFor(secret, environment), username: secret.username, password: secret.password, organizationId: secret.organizationId }
    if (secret.rememberMeId) body.rememberMeId = secret.rememberMeId
    if (secret.device) body.device = secret.device
    const res = await http(environment, {}).request<BillObject>({ method: 'POST', path: '/v3/login', json: body, idempotent: true })
    const sessionId = str(res.data.sessionId)
    if (!sessionId) throw new ConnectorError('auth', 'BILL did not return a session', { provider: PROVIDER })
    const name = str(res.data.organizationName)
    return name ? { sessionId, organizationName: name } : { sessionId }
  }

  /** Run `fn` with a live session, logging in again once if BILL says the session ended. */
  async function withSession<T>(conn: ConnectionRef, fn: (c: HttpClient) => Promise<T>): Promise<T> {
    const secret = requireSecret(PROVIDER, conn.secret, isSecret)
    const { environment } = env(conn)
    for (let attempt = 0; ; attempt++) {
      let s = sessions.get(conn.id)
      if (!s || clock.now() - s.at > SESSION_TTL_MS) {
        s = { id: (await login(secret, environment)).sessionId, at: clock.now() }
        sessions.set(conn.id, s)
      }
      try {
        const out = await fn(http(environment, { devKey: devKeyFor(secret, environment), sessionId: s.id }))
        s.at = clock.now()
        return out
      } catch (e) {
        if (attempt === 0 && isConnectorError(e) && e.code === 'session_expired') {
          sessions.delete(conn.id)
          continue
        }
        throw e
      }
    }
  }

  const description: ConnectorDescription = {
    key: PROVIDER,
    name: 'BILL',
    group: 'accounting',
    provides: ['bills', 'invoices'],
    freshness: 'syncs every few hours',
    auth: 'api_key',
  }

  return {
    describe: () => description,

    /**
     * input: { devKey?, username, password, organizationId, environment?, currency? }. Verified by logging in. Without
     * `devKey`, the partner key signs in and `username`/`password` are the sync token's name and value.
     */
    async connect(input) {
      const cfg: BillConfig = env({ config: input })
      const own = str(input.devKey)
      const secret: BillSecret = {
        ...(own ? { devKey: own } : {}),
        username: str(input.username) ?? '',
        password: str(input.password) ?? '',
        organizationId: str(input.organizationId) ?? '',
      }
      if (!secret.username || !secret.password || !secret.organizationId || (!own && !opts.partnerDevKeys?.[cfg.environment])) {
        throw new ConnectorError('invalid_input', own || !opts.partnerDevKeys ? 'BILL needs a developer key, the organisation id and a user login' : 'BILL needs the sync token name, the sync token and the organisation id', { provider: PROVIDER })
      }
      const rememberMeId = str(input.rememberMeId)
      if (rememberMeId) secret.rememberMeId = rememberMeId
      const device = str(input.device)
      if (device) secret.device = device
      const res = await login(secret, cfg.environment)
      // The login response has no organisation name; the session endpoint may (its shape isn't documented: best effort).
      const name =
        res.organizationName ??
        (await http(cfg.environment, { devKey: devKeyFor(secret, cfg.environment), sessionId: res.sessionId })
          .request<BillObject>({ path: '/v3/login/session' })
          .then((r) => str(r.data.organizationName) ?? (isRecord(r.data.organization) ? str(r.data.organization.name) : undefined))
          .catch(() => undefined))
      if (name) cfg.organizationName = name
      return { secret, config: { ...cfg } }
    },

    async sync(conn, cursor): Promise<SyncResult> {
      const cfg = env(conn)
      const now = clock.now()
      let state = codec.decode(cursor)
      if (!state || state.p >= PHASES.length || (state.p === 0 && state.page === null)) {
        state = { p: 0, page: null, since: state?.since ?? null, mark: new Date(now - OVERLAP_MS).toISOString(), customers: {}, vendors: {} }
      }
      const spec = PHASES[state.p] as (typeof PHASES)[number]
      const st = state
      const res = await withSession(conn, (c) =>
        c.request<BillObject>({
          path: spec.path,
          // A page token already carries the filters and sort; BILL rejects them alongside it.
          query: st.page ? { page: st.page, max } : { max, ...(st.since && spec.filter ? { filters: `updatedTime:gte:"${st.since}"` } : {}), sort: 'updatedTime:asc' },
        }),
      )
      const items = Array.isArray(res.data.results) ? res.data.results.filter(isRecord) : []
      const ctx: MapContext = { connectionId: conn.id, currency: cfg.currency, customers: st.customers, vendors: st.vendors }
      const events: NormalizedEvent[] = []
      const next: CursorState = { ...st, customers: { ...st.customers }, vendors: { ...st.vendors } }
      for (const o of items) {
        const id = str(o.id)
        if (!id) continue
        if (spec.phase === 'customers' || spec.phase === 'vendors') {
          const names = spec.phase === 'customers' ? next.customers : next.vendors
          const name = str(o.name) ?? str(o.shortName)
          if (name && Object.keys(names).length < MAX_NAMES) names[id] = name
          continue
        }
        const rawRef = await deps.raw.put(conn.id, `${PROVIDER}.${spec.phase}`, id, o)
        const e = mapItem(spec.phase, o, { ...ctx, rawRef })
        if (e) events.push(e)
      }
      const nextPage = str(res.data.nextPage)
      if (nextPage && items.length > 0) next.page = nextPage
      else {
        next.p++
        next.page = null
      }
      const done = next.p >= PHASES.length
      return { events, cursor: codec.encode(done ? { p: 0, page: null, since: next.mark, mark: next.mark, customers: {}, vendors: {} } : next), hasMore: !done }
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        await withSession(conn, (c) => c.request({ path: '/v3/bills', query: { max: 1 } }))
        return { status: 'ok', lastSuccessAt: new Date(clock.now()).toISOString() }
      } catch (e) {
        return healthFromError(e)
      }
    },
  }

  function mapItem(phase: Exclude<Phase, 'customers' | 'vendors'>, o: BillObject, ctx: MapContext): NormalizedEvent | null {
    switch (phase) {
      case 'bills':
        return mapBill(o, ctx)
      case 'vendorCredits':
        return mapVendorCredit(o, ctx)
      case 'payments':
        return mapPaymentMade(o, ctx)
      case 'invoices':
        return mapInvoice(o, ctx)
      case 'receivablePayments':
        return mapPaymentReceived(o, ctx)
    }
  }
}
