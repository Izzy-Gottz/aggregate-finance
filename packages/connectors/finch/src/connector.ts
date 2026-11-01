// Finch connector (MASTER.md §2 "Payroll … + optional Finch"): one integration for 200+ payroll systems
// (Gusto, ADP, Paychex, Rippling, Justworks, TriNet...). The user connects through Finch Connect; we exchange the
// code for a long-lived access token. Read-only: payments (company-level payroll runs) and, when the provider
// supports it, pay statements for per-person lines.
//
// Money from Finch is {amount: integer cents, currency: "usd"} and either may be null.
// Finch answers 202 data_sync_in_progress while a new connection's first pull runs; we stop and come back later.
import type { ConnectBegin, ConnectBeginContext, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, PayrollRun, SyncResult } from '@agfn/contracts'
import { type ConnectorDeps, ConnectorError, cursorCodec, healthFromError, HttpClient, isConnectorError, isRecord, normalizeCurrency, requireSecret, str, systemClock } from '@agfn/connector-sdk'
import { isWindowState, providerRun, startWindow, stepWindow, type WindowPlan, type WindowState } from '@agfn/connector-payroll-detect'

export const PROVIDER = 'finch'
const API = 'https://api.tryfinch.com'
const API_VERSION = '2020-09-17'

export interface FinchSecret {
  accessToken: string
}

export interface FinchOptions {
  deps: ConnectorDeps
  /** Needed for begin() and connect(). */
  oauth?: { clientId: string; clientSecret: string; redirectUri?: string }
  /** Sandbox apps only: Finch's own test payroll systems ('finch') or a provider's sandbox ('provider'). */
  sandbox?: 'finch' | 'provider'
  /** Shown in Finch's dashboard next to each connection (default: the workspace id). */
  customerName?: (workspaceId: string) => string
  plan?: WindowPlan
}

/** What Finch Connect asks the employer to share: company, people, pay runs and pay statements. */
export const FINCH_PRODUCTS = ['company', 'directory', 'payment', 'pay_statement'] as const

type Obj = Record<string, unknown>
/**
 * Mapping version: bump when the mapping changes, so existing connections re-read their history once.
 * 2: employer taxes from pay statements.
 */
export const MAPPING_VERSION = 2
const codec = cursorCodec<WindowState>(PROVIDER, MAPPING_VERSION, isWindowState)
const isSecret = (s: unknown): s is FinchSecret => isRecord(s) && typeof s.accessToken === 'string'

export function classifyFinchError({ status, body }: { status: number; body: unknown }): ConnectorError | undefined {
  const b = isRecord(body) ? body : {}
  const code = str(b.finch_code) ?? str(b.name) ?? str(b.code)
  const message = (str(b.message) ?? `HTTP ${status}`).slice(0, 300)
  const opts = { provider: PROVIDER, status, ...(code ? { code } : {}) }
  if (status === 401 || code === 'reauthenticate_user' || code === 'account_setup_required') return new ConnectorError('auth', message, opts)
  if (status === 429) return new ConnectorError('rate_limited', message, opts)
  if (status === 501) return new ConnectorError('permanent', message, { ...opts, code: 'not_implemented' })
  if (status === 402) return new ConnectorError('permanent', 'Finch plan does not include this data', { ...opts, code: 'payment_required' })
  if (status >= 500) return new ConnectorError('transient', message, opts)
  return new ConnectorError('permanent', message, opts)
}

function cents(v: unknown, fallbackCurrency: string): { minor: number; currency: string } | null {
  if (!isRecord(v) || typeof v.amount !== 'number' || !Number.isSafeInteger(v.amount)) return null
  return { minor: v.amount, currency: normalizeCurrency(str(v.currency), fallbackCurrency) }
}

export function createFinchConnector(opts: FinchOptions): Connector {
  const { deps } = opts
  const clock = deps.clock ?? systemClock

  function http(token?: string): HttpClient {
    return new HttpClient({
      provider: PROVIDER,
      baseUrl: API,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      clock,
      ...(deps.random ? { random: deps.random } : {}),
      rateLimit: { perSecond: 2, burst: 4 },
      headers: { 'finch-api-version': API_VERSION, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      classifyError: classifyFinchError,
    })
  }

  /** Throws a non-sleeping rate_limited error on 202 (data still syncing at Finch). */
  async function get<T>(c: HttpClient, path: string, query?: Record<string, string | number>): Promise<T> {
    const res = await c.request<T>({ path, ...(query ? { query } : {}) })
    if (res.status === 202) {
      throw new ConnectorError('rate_limited', 'Finch is still pulling data from the payroll system', { provider: PROVIDER, code: 'data_sync_in_progress', retryAfterMs: 15 * 60_000 })
    }
    return res.data
  }

  const description: ConnectorDescription = {
    key: PROVIDER,
    name: 'Payroll via Finch',
    group: 'payroll',
    provides: ['payroll'],
    freshness: 'updates daily for most payroll systems, weekly for assisted ones',
    auth: 'oauth',
    dataVersion: MAPPING_VERSION,
  }

  /**
   * Finch Connect sessions: the server creates a session (Basic auth with the app's id and secret) and sends the
   * browser to its connect_url. `state` rides on that URL and comes back unchanged with the code on our redirect_uri.
   */
  async function begin(ctx: ConnectBeginContext): Promise<ConnectBegin> {
    if (!opts.oauth) throw new ConnectorError('invalid_input', 'Finch is not set up on this server', { provider: PROVIDER })
    const basic = Buffer.from(`${opts.oauth.clientId}:${opts.oauth.clientSecret}`).toString('base64')
    const c = new HttpClient({
      provider: PROVIDER,
      baseUrl: API,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      clock,
      ...(deps.random ? { random: deps.random } : {}),
      headers: { 'finch-api-version': API_VERSION, authorization: `Basic ${basic}` },
      classifyError: classifyFinchError,
    })
    const res = await c.request<Obj>({
      method: 'POST',
      path: '/connect/sessions',
      json: {
        // One customer per connect attempt: Finch refuses a second session for a customer that already connected,
        // and one workspace can connect payroll for several companies.
        customer_id: `${ctx.workspaceId}-${ctx.state.slice(0, 12)}`,
        customer_name: (opts.customerName?.(ctx.workspaceId) ?? ctx.workspaceId).slice(0, 255),
        products: [...FINCH_PRODUCTS],
        redirect_uri: opts.oauth.redirectUri ?? ctx.redirectUri,
        minutes_to_expire: 60,
        ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
      },
    })
    const url = str(res.data.connect_url)
    if (!url) throw new ConnectorError('permanent', 'Finch did not return a Connect link', { provider: PROVIDER })
    const u = new URL(url)
    u.searchParams.set('state', ctx.state)
    return { kind: 'oauth', url: u.toString() }
  }

  return {
    describe: () => description,
    begin,

    async connect(input) {
      const code = str(input.code)
      if (!code || !opts.oauth) throw new ConnectorError('invalid_input', 'Finch Connect did not return a code', { provider: PROVIDER })
      const body: Record<string, string> = { client_id: opts.oauth.clientId, client_secret: opts.oauth.clientSecret, code }
      if (opts.oauth.redirectUri) body.redirect_uri = opts.oauth.redirectUri
      const res = await http().request<Obj>({ method: 'POST', path: '/auth/token', json: body })
      const accessToken = str(res.data.access_token)
      if (!accessToken) throw new ConnectorError('auth', 'Finch did not return an access token', { provider: PROVIDER })
      const config: Record<string, unknown> = {}
      for (const k of ['connection_id', 'company_id', 'provider_id', 'connection_type', 'client_type'] as const) {
        const v = str(res.data[k])
        if (v) config[k.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase())] = v
      }
      const secret: FinchSecret = { accessToken }
      return { secret, config }
    },

    async sync(conn, cursor): Promise<SyncResult> {
      const secret = requireSecret(PROVIDER, conn.secret, isSecret)
      const c = http(secret.accessToken)
      const today = new Date(clock.now()).toISOString().slice(0, 10)
      const prev = codec.decode(cursor)
      // A cursor whose window is finished (from > end) starts a new incremental pass.
      const state = prev && prev.from <= prev.end ? prev : startWindow(prev, today, opts.plan)
      const w = stepWindow(state, opts.plan)
      const providerName = str(conn.config.providerId) ?? 'Finch'

      const payments = await get<unknown>(c, '/employer/payment', { start_date: w.from, end_date: w.to })
      const list = (Array.isArray(payments) ? payments : []).filter(isRecord)
      const events: NormalizedEvent[] = []
      const detail = list.length > 0 && conn.config.individualDetail !== false ? await statements(c, list.map((p) => str(p.id)).filter((x): x is string => !!x)) : new Map()
      const names = detail.size > 0 ? await directory(c) : new Map<string, string>()
      for (const p of list) {
        const run = await toRun(p, conn, providerName, today, detail.get(str(p.id) ?? ''), names)
        if (run) events.push(run)
      }
      const done = w.next === null
      const next: WindowState = done ? { from: '9999-12-31', end: state.end, mark: state.mark } : w.next as WindowState
      return { events, cursor: codec.encode(next), hasMore: !done }
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        const secret = requireSecret(PROVIDER, conn.secret, isSecret)
        await get(http(secret.accessToken), '/employer/company')
        return { status: 'ok', lastSuccessAt: new Date(clock.now()).toISOString() }
      } catch (e) {
        return healthFromError(e)
      }
    },
  }

  async function toRun(p: Obj, conn: ConnectionRef, providerName: string, today: string, stmts: Obj[] | undefined, names: Map<string, string>): Promise<PayrollRun | null> {
    const id = str(p.id)
    const payDate = str(p.pay_date)
    if (!id || !payDate) return null
    const gross = cents(p.gross_pay, 'USD')
    const net = cents(p.net_pay, gross?.currency ?? 'USD')
    if (!gross || !net) return null // Finch couldn't read totals for this run; detail-free runs would mislead
    const currency = gross.currency
    const same = (v: unknown): number | undefined => {
      const m = cents(v, currency)
      return m && m.currency === currency ? m.minor : undefined
    }
    const rawRef = await deps.raw.put(conn.id, `${PROVIDER}.payment`, id, { payment: p, statements: stmts ?? null })
    const period = isRecord(p.pay_period) ? p.pay_period : {}
    let benefits: number | undefined
    // Some providers leave the payment's employer_taxes null and report them per statement (taxes[].employer).
    let stmtEmployerTaxes: number | undefined
    let lines: PayrollRun['lines']
    if (stmts && stmts.length) {
      benefits = 0
      lines = []
      for (const s of stmts) {
        for (const t of Array.isArray(s.taxes) ? s.taxes.filter(isRecord) : []) {
          if (t.employer !== true) continue
          // Statement taxes carry amount as integer cents with their own currency field ({amount, currency} too).
          const m = typeof t.amount === 'number' ? (Number.isSafeInteger(t.amount) ? { minor: t.amount, currency: normalizeCurrency(str(t.currency), currency) } : null) : cents(t.amount, currency)
          if (m && m.currency === currency) stmtEmployerTaxes = (stmtEmployerTaxes ?? 0) + m.minor
        }
        const contribs = Array.isArray(s.employer_contributions) ? s.employer_contributions.filter(isRecord) : []
        for (const ct of contribs) benefits += typeof ct.amount === 'number' && Number.isSafeInteger(ct.amount) ? ct.amount : 0
        const g = cents(s.gross_pay, currency)
        const n = cents(s.net_pay, currency)
        const who = str(s.individual_id)
        if (!g || !n || !who) continue
        lines.push({ person: names.get(who) ?? who, gross: g, net: n, kind: /contract/i.test(str(s.type) ?? '') ? 'contractor' : 'employee' })
      }
    }
    const ids = Array.isArray(p.individual_ids) ? p.individual_ids : undefined
    const input: Parameters<typeof providerRun>[0] = {
      externalId: id,
      connectionId: conn.id,
      rawRef,
      provider: providerName,
      payDate,
      currency,
      gross: gross.minor,
      net: net.minor,
      // The payment's own figure unless it's missing or zero while the statements show employer taxes (Gusto via
      // Finch reports 0 at payment level).
      employerTaxes: (same(p.employer_taxes) ?? 0) > 0 ? (same(p.employer_taxes) as number) : (stmtEmployerTaxes ?? same(p.employer_taxes) ?? 0),
      today,
    }
    const eeTax = same(p.employee_taxes)
    if (eeTax !== undefined) input.employeeTaxes = eeTax
    const debit = same(p.company_debit)
    if (debit !== undefined) input.companyDebit = debit
    if (benefits !== undefined) input.employerBenefits = benefits
    const ps = str(period.start_date)
    const pe = str(period.end_date)
    if (ps) input.periodStart = ps
    if (pe) input.periodEnd = pe
    if (lines) input.lines = lines
    if (ids) input.employeeCount = ids.length
    return providerRun(input)
  }

  /** Pay statements, 10 payments per request (Finch's batch limit). Unsupported providers return no detail. */
  async function statements(c: HttpClient, paymentIds: string[]): Promise<Map<string, Obj[]>> {
    const out = new Map<string, Obj[]>()
    for (let i = 0; i < paymentIds.length; i += 10) {
      const batch = paymentIds.slice(i, i + 10)
      try {
        const res = await c.request<Obj>({ method: 'POST', path: '/employer/pay-statement', json: { requests: batch.map((payment_id) => ({ payment_id, limit: 5000, offset: 0 })) }, idempotent: true })
        const responses = Array.isArray(res.data.responses) ? res.data.responses.filter(isRecord) : []
        for (const r of responses) {
          const pid = str(r.payment_id)
          const body = isRecord(r.body) ? r.body : {}
          if (pid && r.code === 200 && Array.isArray(body.pay_statements)) out.set(pid, body.pay_statements.filter(isRecord))
        }
      } catch (e) {
        if (isConnectorError(e) && (e.code === 'not_implemented' || e.code === 'payment_required')) return out
        throw e
      }
    }
    return out
  }

  async function directory(c: HttpClient): Promise<Map<string, string>> {
    const names = new Map<string, string>()
    try {
      const d = await get<Obj>(c, '/employer/directory', { limit: 10_000, offset: 0 })
      for (const p of Array.isArray(d.individuals) ? d.individuals.filter(isRecord) : []) {
        const id = str(p.id)
        const name = [str(p.first_name), str(p.last_name)].filter(Boolean).join(' ')
        if (id && name) names.set(id, name)
      }
    } catch (e) {
      if (!(isConnectorError(e) && e.code === 'not_implemented')) throw e
    }
    return names
  }
}
