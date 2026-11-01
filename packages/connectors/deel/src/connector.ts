// Deel connector, REST API v2 (MASTER.md §5 "Payroll & people").
//
// Auth: either an organization token from Deel's Developer Center (scope accounting:read), sent as a Bearer token, or
// one-click OAuth with Aggregate's Deel app (accounting:read only). OAuth calls send the access token AND the app's
// x-client-id header. Deel access tokens last 30 days and refresh tokens 90; a refresh token works once (the new pair is
// saved before any read), so tokens are renewed 5 days early. Self-serve, no partner review. Money values are decimal strings.
//
// What a company pays Deel is a payment receipt covering many worker invoices (contractors, EOR employees) plus
// Deel's own fees. Each paid receipt becomes one PayrollRun:
//   gross        = what the workers' lines cost (work, bonus, expenses...; Deel fee lines excluded)
//   net          = gross (Deel bills the employer's total; EOR employee withholding happens inside Deel)
//   companyDebit = the receipt total (includes fees), so the bank debit links exactly
// The token is checked with GET /payments (accounting:read), not /contracts, which needs contracts:read.
// Deel fees (lines without a contract, or processing_fee) are a software/processor expense, not payroll cost.
// Limit: 5 requests/second per organization, no rate-limit headers.
import type { Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, PayrollRun, SyncResult } from '@agfn/contracts'
import { type ConnectorDeps, ConnectorError, cursorCodec, healthFromError, HttpClient, isRecord, money, normalizeCurrency, OAuthClient, type OAuthTokens, requireSecret, str, systemClock } from '@agfn/connector-sdk'
import { isWindowState, providerRun, startWindow, stepWindow, type WindowPlan, type WindowState } from '@agfn/connector-payroll-detect'

export const PROVIDER = 'deel'
const API = { production: 'https://api.letsdeel.com/rest/v2', sandbox: 'https://api-staging.letsdeel.com/rest/v2' } as const
/** Where people sign in to approve the app, and where codes become tokens (oauth2/authorize, oauth2/tokens). */
export const AUTH_HOST = { production: 'https://app.deel.com', sandbox: 'https://app.demo.deel.com' } as const
export const SCOPES = ['accounting:read']
/** Renew this long before the 30-day access token runs out. */
const RENEW_EARLY_MS = 5 * 86_400_000

type Obj = Record<string, unknown>

/** A pasted organization token, or the OAuth pair from Aggregate's Deel app. */
export type DeelSecret = { token: string } | { tokens: OAuthTokens }

export interface DeelOptions {
  deps: ConnectorDeps
  plan?: WindowPlan
  /** Aggregate's Deel app: one-click sign-in. Its environment is where the app lives (sandbox apps sign in at app.demo.deel.com). */
  oauth?: { clientId: string; clientSecret: string; redirectUri: string; environment?: 'production' | 'sandbox' }
}

interface CursorState extends WindowState {
  page?: string
}

const codec = cursorCodec<CursorState>(PROVIDER, 1, (v): v is CursorState => isWindowState(v))
const isSecret = (s: unknown): s is DeelSecret =>
  isRecord(s) && ((typeof s.token === 'string' && s.token.length > 0) || (isRecord(s.tokens) && typeof s.tokens.accessToken === 'string'))

export function classifyDeelError({ status, body }: { status: number; body: unknown }): ConnectorError | undefined {
  const b = isRecord(body) ? body : {}
  const errs = Array.isArray(b.errors) ? b.errors.filter(isRecord) : []
  const message = (str(errs[0]?.message) ?? str(b.message) ?? `HTTP ${status}`).slice(0, 300)
  const opts = { provider: PROVIDER, status }
  // Deel uses 401 for a bad, expired or revoked token and for missing scopes, and 403 for missing scopes too.
  if (status === 401) return new ConnectorError('auth', `${message} (check the token is current and has accounting:read)`, opts)
  if (status === 403) return new ConnectorError('auth', `${message} (the token needs accounting:read)`, { ...opts, code: 'scope' })
  // No Retry-After from Deel: wait out the 1-second window.
  if (status === 429) return new ConnectorError('rate_limited', message, { ...opts, retryAfterMs: 1_500 })
  if (status >= 500) return new ConnectorError('transient', message, opts)
  return new ConnectorError('permanent', message, opts)
}

/** Deel lists come as {data: [...]} or {data: {rows: [...], next_cursor}}; support both. */
function rows(data: unknown): { items: Obj[]; next?: string } {
  if (!isRecord(data)) return { items: [] }
  const d = data.data
  if (Array.isArray(d)) {
    const page = isRecord(data.page) ? data.page : {}
    const next = str(page.cursor) ?? str(data.next_cursor)
    return next ? { items: d.filter(isRecord), next } : { items: d.filter(isRecord) }
  }
  if (isRecord(d) && Array.isArray(d.rows)) {
    // Deel's example sends has_more as the string "true"; its schema says boolean. Accept both.
    const next = d.has_more === true || d.has_more === 'true' ? str(d.next_cursor) : undefined
    return next ? { items: d.rows.filter(isRecord), next } : { items: d.rows.filter(isRecord) }
  }
  return { items: [] }
}

function amount(v: unknown, currency: string): number {
  if (typeof v === 'string' && v.trim() !== '') return money(v, currency).minor
  if (typeof v === 'number') return money(v, currency).minor
  if (isRecord(v)) return amount(v.amount, normalizeCurrency(str(v.currency), currency))
  return 0
}

const FEE_TYPES = /fee|deel_percentage|management/i

const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

/** Checks the token with what sync needs (accounting:read): one day of payment receipts. /contracts needs another scope. */
async function probe(c: HttpClient, now: number): Promise<void> {
  const today = new Date(now).toISOString().slice(0, 10)
  await c.request({ path: '/payments', query: { date_from: today, date_to: nextDay(today) } })
}

export function createDeelConnector(opts: DeelOptions): Connector & { authorizationUrl?(state: string): string } {
  const { deps } = opts
  const clock = deps.clock ?? systemClock
  const appEnv = opts.oauth?.environment === 'sandbox' ? 'sandbox' : 'production'
  const oauth = opts.oauth
    ? new OAuthClient({
        provider: PROVIDER,
        authorizeUrl: `${AUTH_HOST[appEnv]}/oauth2/authorize`,
        tokenUrl: `${AUTH_HOST[appEnv]}/oauth2/tokens`,
        clientId: opts.oauth.clientId,
        clientSecret: opts.oauth.clientSecret,
        redirectUri: opts.oauth.redirectUri,
        scopes: SCOPES,
        clientAuth: 'basic',
        // Deel compares the Basic header literally: a URL-encoded '==' at the end of its secrets is refused.
        basicEncoding: 'raw',
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        clock,
      })
    : undefined

  /** OAuth tokens also need the app's client id on every call (x-client-id); pasted tokens don't. */
  function http(token: string, environment: 'production' | 'sandbox', viaApp = false): HttpClient {
    return new HttpClient({
      provider: PROVIDER,
      baseUrl: API[environment],
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      clock,
      ...(deps.random ? { random: deps.random } : {}),
      rateLimit: { perSecond: 4, burst: 4 },
      headers: { authorization: `Bearer ${token}`, ...(viaApp && opts.oauth ? { 'x-client-id': opts.oauth.clientId } : {}) },
      classifyError: classifyDeelError,
    })
  }
  /** A client for this connection's secret, renewing OAuth tokens first when they're close to running out. */
  async function clientFor(conn: ConnectionRef, renew: boolean): Promise<{ c: HttpClient; renewed?: DeelSecret }> {
    const secret = requireSecret(PROVIDER, conn.secret, isSecret)
    if ('token' in secret) return { c: http(secret.token, envOf(conn)) }
    if (!oauth) throw new ConnectorError('auth', 'This Deel connection used Aggregate’s Deel app, which isn’t set up here. Connect Deel again.', { provider: PROVIDER, forUser: true })
    if (!renew) return { c: http(secret.tokens.accessToken, envOf(conn), true) }
    const { tokens, refreshed } = await oauth.ensureFresh(secret.tokens, RENEW_EARLY_MS)
    const renewed: DeelSecret = { tokens }
    // The old refresh token stops working now: keep the new pair before any read can fail and strand it.
    if (refreshed) await deps.saveSecret?.(conn.id, renewed)
    return { c: http(tokens.accessToken, envOf(conn), true), ...(refreshed ? { renewed } : {}) }
  }
  const envOf = (conn: { config: Record<string, unknown> }): 'production' | 'sandbox' => (conn.config.environment === 'sandbox' ? 'sandbox' : 'production')

  const description: ConnectorDescription = {
    key: PROVIDER,
    name: 'Deel',
    group: 'payroll',
    provides: ['payroll'],
    freshness: 'syncs daily',
    auth: oauth ? 'oauth' : 'api_key',
  }

  return {
    describe: () => description,

    ...(oauth ? { authorizationUrl: (state: string) => oauth.authorizationUrl({ state }) } : {}),

    /** input: { code } back from Deel sign-in, or { token, environment? } pasted. Verified with one call. */
    async connect(input) {
      const code = str(input.code)
      if (code && oauth) {
        const tokens = await oauth.exchangeCode(code)
        if (tokens.scope && !tokens.scope.split(/\s+/).includes('accounting:read')) {
          throw new ConnectorError('invalid_input', 'Deel access was granted without accounting read access. Connect again and allow it.', { provider: PROVIDER, forUser: true })
        }
        await probe(http(tokens.accessToken, appEnv, true), clock.now())
        const secret: DeelSecret = { tokens }
        return { secret, config: { environment: appEnv, ...(appEnv === 'sandbox' ? { warnings: ['This is Deel’s sandbox: test data, not real payroll.'] } : {}) } }
      }
      const token = str(input.token)?.trim()
      if (!token) throw new ConnectorError('invalid_input', 'paste a Deel organization token', { provider: PROVIDER })
      const environment = input.environment === 'sandbox' ? 'sandbox' : 'production'
      await probe(http(token, environment), clock.now())
      const secret: DeelSecret = { token }
      return { secret, config: { environment } }
    },

    async sync(conn, cursor): Promise<SyncResult> {
      const { c, renewed } = await clientFor(conn, true)
      const today = new Date(clock.now()).toISOString().slice(0, 10)
      const prev = codec.decode(cursor)
      const state: CursorState = prev && prev.from <= prev.end ? prev : startWindow(prev, today, opts.plan)
      const w = stepWindow(state, opts.plan)
      // date_to is exclusive ("created before"): ask for the day after the window's last day.
      const res = await c.request<unknown>({ path: '/payments', query: { date_from: w.from, date_to: nextDay(w.to), ...(state.page ? { cursor: state.page } : {}) } })
      const { items, next: page } = rows(res.data)
      const events: NormalizedEvent[] = []
      for (const p of items) {
        const run = await toRun(c, p, conn, today)
        if (run) events.push(run)
      }
      let next: CursorState | null
      if (page) next = { ...state, page }
      else if (w.next) next = { from: w.next.from, end: w.next.end, mark: w.next.mark }
      else next = null
      return { events, cursor: codec.encode(next ?? { from: '9999-12-31', end: state.end, mark: state.mark }), hasMore: next !== null, ...(renewed ? { updatedSecret: renewed } : {}) }
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        const secret = requireSecret(PROVIDER, conn.secret, isSecret)
        // Never renews here: the single-use refresh token would have nowhere to go. It renews on the next sync.
        if ('tokens' in secret && secret.tokens.expiresAt !== undefined && secret.tokens.expiresAt <= clock.now() && secret.tokens.refreshToken) {
          return { status: 'ok', message: 'The access token renews on the next sync.' }
        }
        const { c } = await clientFor(conn, false)
        await probe(c, clock.now())
        return { status: 'ok', lastSuccessAt: new Date(clock.now()).toISOString() }
      } catch (e) {
        return healthFromError(e)
      }
    },
  }

  async function toRun(c: HttpClient, p: Obj, conn: ConnectionRef, today: string): Promise<PayrollRun | null> {
    const id = str(p.id)
    const paidAt = str(p.paid_at)
    const status = str(p.status)?.toLowerCase()
    // Only money that left: processing receipts appear again once paid.
    if (!id || !paidAt || (status && status !== 'paid')) return null
    const currency = normalizeCurrency(str(p.payment_currency) ?? str(p.currency), 'USD')
    const res = await c.request<unknown>({ path: `/payments/${encodeURIComponent(id)}/breakdown` })
    const lines = rows(res.data).items
    const rawRef = await deps.raw.put(conn.id, `${PROVIDER}.payment`, id, { payment: p, breakdown: lines })

    let gross = 0
    const people: NonNullable<PayrollRun['lines']> = []
    for (const l of lines) {
      const isFee = !str(l.contract_id) || FEE_TYPES.test(str(l.contract_type) ?? '')
      if (isFee) continue
      const lineCur = normalizeCurrency(str(l.payment_currency), currency)
      if (lineCur !== currency) continue
      const total = amount(l.total_payment_currency ?? l.total, currency) - amount(l.processing_fee, currency)
      gross += total
      const kind = /eor|employee|global_payroll|gp/i.test(str(l.contract_type) ?? '') ? 'employee' : 'contractor'
      people.push({ person: str(l.contractor_employee_name) ?? str(l.contractor_unique_identifier) ?? 'Worker', gross: { minor: total, currency }, net: { minor: total, currency }, kind })
    }
    const companyDebit = amount(p.total, currency)
    // A receipt that moved no money and paid no one isn't a pay run (Deel's sandbox issues one a day).
    if (companyDebit === 0 && gross === 0) return null
    const input: Parameters<typeof providerRun>[0] = {
      externalId: id,
      connectionId: conn.id,
      rawRef,
      provider: 'Deel',
      payDate: paidAt.slice(0, 10),
      currency,
      gross,
      net: gross,
      employerTaxes: 0,
      companyDebit,
      lines: people,
      employeeCount: people.filter((l) => l.kind === 'employee').length,
      today,
    }
    return providerRun(input)
  }
}
