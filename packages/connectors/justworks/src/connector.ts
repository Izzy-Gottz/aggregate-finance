// Justworks connector, Partner API (MASTER.md §5 "Payroll & people").
//
// NEEDS PARTNER ACCESS: Justworks issues OAuth credentials on request (partner-api@justworks.com). Built to the
// public docs at public-api.justworks.com/v1/docs and tested on doc-shaped fixtures; verify against a real
// sandbox before enabling.
//
// OAuth 2.0 auth code: access tokens last 24 h, refresh tokens 30 days. Read-only scopes: payroll:read, paystub:read
// (per-person lines), company.basic:read (GET /v1/company, used to check the token) and member.basic:read (names).
// Money is integer cents. Lists answer { items, next_cursor }; errors answer { code, error, reason }.
// GET /v1/payrolls needs start_date and end_date, so the sync walks date windows; cursor/limit page inside one. The docs
// don't say whether end_date is inclusive, so we ask for one day more: an overlap is deduplicated, a gap is lost money.
// Limit: 300 requests/minute per app, with Retry-After on 429.
import type { Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, PayrollRun } from '@agfn/contracts'
import {
  type ConnectorDeps,
  ConnectorError,
  cursorCodec,
  healthFromError,
  HttpClient,
  isConnectorError,
  isRecord,
  normalizeCurrency,
  OAuthClient,
  type OAuthTokens,
  requireSecret,
  str,
  type SyncResultWithSecret,
  systemClock,
} from '@agfn/connector-sdk'
import { isWindowState, providerRun, startWindow, stepWindow, type WindowPlan, type WindowState } from '@agfn/connector-payroll-detect'

export const PROVIDER = 'justworks'
const BASE = 'https://public-api.justworks.com'
const AUTHORIZE_URL = 'https://payroll.justworks.com/oauth/authorize'
export const SCOPES = ['payroll:read', 'paystub:read', 'company.basic:read', 'member.basic:read']

type Obj = Record<string, unknown>

export interface JustworksSecret {
  tokens: OAuthTokens
}

export interface JustworksOptions {
  deps: ConnectorDeps
  oauth: { clientId: string; clientSecret: string; redirectUri: string; scopes?: string[] }
  plan?: WindowPlan
}

interface CursorState extends WindowState {
  /** Justworks page cursor inside the current window. */
  page?: string
}

const codec = cursorCodec<CursorState>(PROVIDER, 1, (v): v is CursorState => isWindowState(v))
const isSecret = (s: unknown): s is JustworksSecret => isRecord(s) && isRecord(s.tokens) && typeof s.tokens.accessToken === 'string'

/** Justworks returns `expires_at` (absolute) instead of `expires_in`; turn it into OAuthTokens.expiresAt. */
export function withExpiry(t: OAuthTokens): OAuthTokens {
  if (t.expiresAt !== undefined) return t
  const raw = t.extra?.expires_at
  let at: number | undefined
  if (typeof raw === 'number') at = raw < 1e12 ? raw * 1000 : raw
  else if (typeof raw === 'string') at = /^\d+$/.test(raw) ? Number(raw) * (raw.length <= 10 ? 1000 : 1) : Date.parse(raw)
  return at !== undefined && Number.isFinite(at) ? { ...t, expiresAt: at } : t
}

export function classifyJustworksError({ status, body }: { status: number; body: unknown }): ConnectorError | undefined {
  // Documented: { code, error, reason }. OAuth endpoints answer { error, error_description }.
  const b = isRecord(body) ? body : {}
  const err = isRecord(b.error) ? b.error : b
  const code = str(err.code) ?? (isRecord(b.error) ? undefined : str(b.error))
  const detail = str(err.reason) ?? str(err.message) ?? str(b.error_description) ?? (typeof b.error === 'string' ? b.error : undefined)
  const message = (detail ?? `HTTP ${status}`).slice(0, 300)
  const opts = { provider: PROVIDER, status, ...(code ? { code } : {}) }
  if (status === 403) {
    return new ConnectorError('auth', `Justworks refused access (${message}). Connect again and approve every permission Aggregate asks for (payroll, paystubs, company and member basics).`.slice(0, 400), opts)
  }
  if (status === 401) return new ConnectorError('auth', message, opts)
  if (status === 429) return new ConnectorError('rate_limited', message, opts)
  if (status >= 500) return new ConnectorError('transient', message, opts)
  return new ConnectorError('permanent', message, opts)
}

function list(data: unknown): Obj[] {
  if (Array.isArray(data)) return data.filter(isRecord)
  if (!isRecord(data)) return []
  const v = data.items
  return Array.isArray(v) ? v.filter(isRecord) : []
}

function dayAfter(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
}

function cents(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v
  if (isRecord(v) && typeof v.amount === 'number' && Number.isSafeInteger(v.amount)) return v.amount
  return undefined
}

export function createJustworksConnector(opts: JustworksOptions): Connector & { authorizationUrl(state: string): string } {
  const { deps } = opts
  const clock = deps.clock ?? systemClock
  const oauth = new OAuthClient({
    provider: PROVIDER,
    authorizeUrl: AUTHORIZE_URL,
    tokenUrl: `${BASE}/oauth/token`,
    clientId: opts.oauth.clientId,
    clientSecret: opts.oauth.clientSecret,
    redirectUri: opts.oauth.redirectUri,
    scopes: opts.oauth.scopes ?? SCOPES,
    clientAuth: 'body',
    scopeSeparator: ' ',
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    clock,
  })

  function http(tokens: OAuthTokens): HttpClient {
    return new HttpClient({
      provider: PROVIDER,
      baseUrl: BASE,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      clock,
      ...(deps.random ? { random: deps.random } : {}),
      rateLimit: { perSecond: 4, burst: 8 },
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      classifyError: classifyJustworksError,
    })
  }

  /** Fresh tokens; on a 401 with a refresh token, refresh once and retry (expiry may be unknown). */
  async function authed<T>(conn: ConnectionRef, fn: (c: HttpClient) => Promise<T>): Promise<{ value: T; tokens: OAuthTokens; refreshed: boolean }> {
    const secret = requireSecret(PROVIDER, conn.secret, isSecret)
    let { tokens, refreshed } = await oauth.ensureFresh(withExpiry(secret.tokens))
    tokens = withExpiry(tokens)
    // A refresh may rotate the refresh token: keep it now, before any page can fail and lose it.
    if (refreshed) await deps.saveSecret?.(conn.id, { tokens } satisfies JustworksSecret)
    try {
      return { value: await fn(http(tokens)), tokens, refreshed }
    } catch (e) {
      if (!(isConnectorError(e) && e.kind === 'auth' && e.status === 401 && tokens.refreshToken && !refreshed)) throw e
      tokens = withExpiry(await oauth.refresh(tokens))
      await deps.saveSecret?.(conn.id, { tokens } satisfies JustworksSecret)
      return { value: await fn(http(tokens)), tokens, refreshed: true }
    }
  }

  const description: ConnectorDescription = {
    key: PROVIDER,
    name: 'Justworks',
    group: 'payroll',
    provides: ['payroll'],
    freshness: 'syncs daily (needs Justworks partner access)',
    auth: 'oauth',
  }

  return {
    describe: () => description,

    /**
     * Revoke both tokens at Justworks: its docs don't say that ending one ends the other. Unverified: no sandbox yet,
     * so /v1/oauth/revoke (the docs' path; our token path has no /v1) hasn't been tried. 401 and 404 count as already gone.
     */
    async disconnect(conn) {
      const { tokens } = requireSecret(PROVIDER, conn.secret, isSecret)
      const f = deps.fetch ?? fetch
      const pairs: Array<[string | undefined, 'refresh_token' | 'access_token']> = [[tokens.refreshToken, 'refresh_token'], [tokens.accessToken, 'access_token']]
      let refused = false
      for (const [token, hint] of pairs) {
        if (!token) continue
        try {
          const res = await f(`${BASE}/v1/oauth/revoke`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: opts.oauth.clientId, client_secret: opts.oauth.clientSecret, token, token_type_hint: hint }).toString(),
          })
          if (!res.ok && res.status !== 401 && res.status !== 404) refused = true
        } catch {
          refused = true
        }
      }
      if (refused) return { notRevoked: 'In Justworks, remove Aggregate.' }
    },

    authorizationUrl(state) {
      return oauth.authorizationUrl({ state })
    },

    async connect(input) {
      const code = str(input.code)
      if (!code) throw new ConnectorError('invalid_input', 'Justworks sign-in did not return a code', { provider: PROVIDER })
      const tokens = withExpiry(await oauth.exchangeCode(code))
      const company = await http(tokens).request<Obj>({ path: '/v1/company' })
      const c = isRecord(company.data.data) ? company.data.data : company.data
      const config: Record<string, unknown> = {}
      const name = str(c.display_name) ?? str(c.legal_name)
      if (name) config.companyName = name
      const id = str(c.id)
      if (id) config.companyId = id
      const secret: JustworksSecret = { tokens }
      return { secret, config }
    },

    async sync(conn, cursor): Promise<SyncResultWithSecret> {
      const today = new Date(clock.now()).toISOString().slice(0, 10)
      const prev = codec.decode(cursor)
      const state: CursorState = prev && prev.from <= prev.end ? prev : startWindow(prev, today, opts.plan)
      const w = stepWindow(state, opts.plan)
      const detail = conn.config.individualDetail !== false

      const { value, tokens, refreshed } = await authed(conn, async (c) => {
        const res = await c.request<Obj>({ path: '/v1/payrolls', query: { start_date: w.from, end_date: dayAfter(w.to), limit: 100, ...(state.page ? { cursor: state.page } : {}) } })
        const payrolls = list(res.data)
        const stubs = new Map<string, Obj[]>()
        if (detail) {
          for (const p of payrolls) {
            const id = str(p.id)
            if (!id) continue
            try {
              stubs.set(id, await all(c, `/v1/payrolls/${encodeURIComponent(id)}/paystubs`))
            } catch (e) {
              // Without paystub:read the totals still sync.
              if (!(isConnectorError(e) && e.kind === 'auth' && e.status === 403)) throw e
            }
          }
        }
        const names = stubs.size > 0 ? await memberNames(c) : new Map<string, string>()
        return { payrolls, stubs, names, next: str(isRecord(res.data) ? res.data.next_cursor : undefined) }
      })

      const events: NormalizedEvent[] = []
      for (const p of value.payrolls) {
        const run = await toRun(p, conn, today, value.stubs.get(str(p.id) ?? ''), value.names)
        if (run) events.push(run)
      }
      let next: CursorState | null
      if (value.next) next = { ...state, page: value.next }
      else if (w.next) next = { from: w.next.from, end: w.next.end, mark: w.next.mark }
      else next = null
      const result: SyncResultWithSecret = {
        events,
        cursor: codec.encode(next ?? { from: '9999-12-31', end: state.end, mark: state.mark }),
        hasMore: next !== null,
      }
      if (refreshed) result.updatedSecret = { tokens } satisfies JustworksSecret
      return result
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        // Never refreshes: health may run where a rotated token can't be kept. An expired access token renews on the
        // next sync; a 401 on a current one means reconnect.
        const { tokens } = requireSecret(PROVIDER, conn.secret, isSecret)
        const t = withExpiry(tokens)
        if (t.expiresAt !== undefined && t.expiresAt <= clock.now() && t.refreshToken) return { status: 'ok', message: 'The access token renews on the next sync.' }
        await http(t).request({ path: '/v1/company' })
        return { status: 'ok', lastSuccessAt: new Date(clock.now()).toISOString() }
      } catch (e) {
        return healthFromError(e)
      }
    },
  }

  async function all(c: HttpClient, path: string): Promise<Obj[]> {
    const out: Obj[] = []
    let cur: string | undefined
    for (let i = 0; i < 50; i++) {
      const res = await c.request<Obj>({ path, query: { limit: 100, ...(cur ? { cursor: cur } : {}) } })
      out.push(...list(res.data))
      cur = str(isRecord(res.data) ? res.data.next_cursor : undefined)
      if (!cur) break
    }
    return out
  }

  async function memberNames(c: HttpClient): Promise<Map<string, string>> {
    const names = new Map<string, string>()
    try {
      for (const m of await all(c, '/v1/members')) {
        const id = str(m.id)
        const n = isRecord(m.name) ? m.name : {}
        const name = str(n.full_preferred_name) ?? ([str(n.preferred_name) ?? str(n.given_name), str(n.family_name)].filter(Boolean).join(' ') || undefined)
        if (id && name) names.set(id, name)
      }
    } catch (e) {
      if (!(isConnectorError(e) && e.kind === 'auth' && e.status === 403)) throw e
    }
    return names
  }

  async function toRun(p: Obj, conn: ConnectionRef, today: string, stubs: Obj[] | undefined, names: Map<string, string>): Promise<PayrollRun | null> {
    const id = str(p.id)
    const payDate = str(p.pay_date)
    const gross = cents(p.gross_pay)
    const net = cents(p.net_pay)
    if (!id || !payDate || gross === undefined || net === undefined) return null
    const currency = normalizeCurrency(str(p.currency), 'USD')
    const rawRef = await deps.raw.put(conn.id, `${PROVIDER}.payroll`, id, { payroll: p, paystubs: stubs ?? null })
    const input: Parameters<typeof providerRun>[0] = {
      externalId: id,
      connectionId: conn.id,
      rawRef,
      provider: 'Justworks',
      payDate: payDate.slice(0, 10),
      currency,
      gross,
      net,
      employerTaxes: cents(p.employer_taxes) ?? 0,
      today,
    }
    const ee = cents(p.employee_taxes)
    if (ee !== undefined) input.employeeTaxes = ee
    const debit = cents(p.company_debit)
    if (debit !== undefined) input.companyDebit = debit
    if (stubs && stubs.length) {
      const lines: NonNullable<PayrollRun['lines']> = []
      const people = new Set<string>()
      let ps: string | undefined
      let pe: string | undefined
      for (const s of stubs) {
        const g = cents(s.gross_pay)
        const n = cents(s.net_pay)
        const who = str(s.member_id)
        ps ??= str(s.pay_period_start)
        pe ??= str(s.pay_period_end)
        if (g === undefined || n === undefined || !who) continue
        people.add(who)
        lines.push({ person: names.get(who) ?? who, gross: { minor: g, currency }, net: { minor: n, currency }, kind: 'employee' })
      }
      input.lines = lines
      input.employeeCount = people.size
      if (ps) input.periodStart = ps.slice(0, 10)
      if (pe) input.periodEnd = pe.slice(0, 10)
    }
    return providerRun(input)
  }
}
