// Rippling connector, REST API v2 (rest.ripplingapis.com) (MASTER.md §5 "Payroll & people").
//
// Auth: a customer API token (Tools → Developer → API Tokens), sent as a Bearer token. It inherits the creating
// admin's permissions and is revoked after 30 days unused. (Partner OAuth is for App Shop apps only.)
//
// Coverage caveat: /payroll-runs/ is documented for Rippling Global Payroll; whether US payroll runs appear is not
// confirmed. When this connector returns nothing, Aggregate still sees Rippling payroll through bank detection
// ("RIPPLING" debits) and register uploads.
//
// A run object has no company totals, so they are summed from its worker payroll records (decimal strings), one
// PayrollRun per run and currency (Global Payroll can pay several countries in one run).
// No date filter exists: runs are listed newest first (order_by=check_date desc; the docs' syntax is `field desc`, not
// `-field`) and listing stops once runs are older than the lookback. next_link is followed as given, with order_by and
// limit put back if it lacks them (the official SDK re-applies the original query to it).
import type { Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, PayrollRun, SyncResult } from '@agfn/contracts'
import { type ConnectorDeps, ConnectorError, cursorCodec, healthFromError, HttpClient, isRecord, money, normalizeCurrency, requireSecret, str, systemClock } from '@agfn/connector-sdk'
import { providerRun } from '@agfn/connector-payroll-detect'
import { addDays } from '@agfn/invoices'

export const PROVIDER = 'rippling'
const BASE = 'https://rest.ripplingapis.com'
const API_VERSION = '2024-08-01'
const LOOKBACK_DAYS = 45
const BACKFILL_DAYS = 730
const ORDER = 'check_date desc'
/** run_state values the docs give (as examples). Anything else is skipped with a warning rather than guessed at. */
const KNOWN_STATES = new Set(['DRAFT', 'APPROVED', 'PAID'])

type Obj = Record<string, unknown>

export interface RipplingSecret {
  apiToken: string
}

export interface RipplingOptions {
  deps: ConnectorDeps
  /** Runs per list page (max 100). Default 25: each run costs extra calls for its worker records. */
  pageSize?: number
}

interface CursorState {
  /** Absolute next_link of the runs list, or null to start the pass. */
  next: string | null
  /** Runs with check_date before this end the pass. */
  stopBefore: string
  /** Today at pass start; the next pass stops at mark − lookback. */
  mark: string
}

const codec = cursorCodec<CursorState>(PROVIDER, 1, (v): v is CursorState => isRecord(v) && (v.next === null || typeof v.next === 'string') && typeof v.stopBefore === 'string' && typeof v.mark === 'string')
const isSecret = (s: unknown): s is RipplingSecret => isRecord(s) && typeof s.apiToken === 'string' && s.apiToken.length > 0

export function classifyRipplingError({ status, body }: { status: number; body: unknown }): ConnectorError | undefined {
  const b = isRecord(body) ? body : {}
  const message = (str(b.detail) ?? str(b.message) ?? str(b.error) ?? `HTTP ${status}`).slice(0, 300)
  const opts = { provider: PROVIDER, status }
  if (status === 401) return new ConnectorError('auth', message, opts)
  // 403: the token lacks a payroll scope, its admin lacks payroll access, or the company doesn't have the product. The
  // customer can fix the first two with a new token, so it's a reconnect, with what to fix.
  if (status === 403) {
    return new ConnectorError('auth', `Rippling refused payroll access (${message}). Create a new API token with the payroll scopes ticked, by an admin who can see payroll, and connect again.`.slice(0, 400), { ...opts, code: 'forbidden' })
  }
  if (status === 429) return new ConnectorError('rate_limited', message, opts)
  if (status >= 500) return new ConnectorError('transient', message, opts)
  return new ConnectorError('permanent', message, opts)
}

function results(data: unknown): Obj[] {
  if (Array.isArray(data)) return data.filter(isRecord)
  return isRecord(data) && Array.isArray(data.results) ? data.results.filter(isRecord) : isRecord(data) && Array.isArray(data.data) ? data.data.filter(isRecord) : []
}

function nextLink(data: unknown, keep: Record<string, string> = {}): string | null {
  const link = (isRecord(data) && (str(data.next_link) ?? str(data.next))) || null
  if (!link) return null
  let u: URL
  try {
    u = new URL(link, BASE)
  } catch {
    return link
  }
  for (const [k, v] of Object.entries(keep)) if (!u.searchParams.has(k)) u.searchParams.set(k, v)
  return u.toString()
}

function dec(v: unknown, currency: string): number {
  if (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) return money(v, currency).minor
  if (isRecord(v) && (typeof v.value === 'string' || typeof v.value === 'number')) return money(v.value, normalizeCurrency(str(v.currency), currency)).minor
  return 0
}

export function createRipplingConnector(opts: RipplingOptions): Connector {
  const { deps } = opts
  const clock = deps.clock ?? systemClock
  const limit = Math.min(100, Math.max(1, opts.pageSize ?? 25))

  function http(token: string): HttpClient {
    return new HttpClient({
      provider: PROVIDER,
      baseUrl: BASE,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      clock,
      ...(deps.random ? { random: deps.random } : {}),
      rateLimit: { perSecond: 2, burst: 4 },
      headers: { authorization: `Bearer ${token}`, 'rippling-api-version': API_VERSION },
      classifyError: classifyRipplingError,
    })
  }

  const description: ConnectorDescription = {
    key: PROVIDER,
    name: 'Rippling',
    group: 'payroll',
    provides: ['payroll'],
    freshness: 'syncs daily',
    auth: 'api_key',
  }

  return {
    describe: () => description,

    /** input: { apiToken }. Verified with one call. */
    async connect(input) {
      const apiToken = str(input.apiToken)?.trim()
      if (!apiToken) throw new ConnectorError('invalid_input', 'paste a Rippling API token', { provider: PROVIDER })
      await http(apiToken).request({ path: '/payroll-runs/', query: { limit: 1 } })
      const secret: RipplingSecret = { apiToken }
      return { secret, config: {} }
    },

    async sync(conn, cursor): Promise<SyncResult> {
      const { apiToken } = requireSecret(PROVIDER, conn.secret, isSecret)
      const c = http(apiToken)
      const today = new Date(clock.now()).toISOString().slice(0, 10)
      let state = codec.decode(cursor)
      if (!state || state.next === null) {
        state = { next: null, stopBefore: state ? addDays(state.mark, -LOOKBACK_DAYS) : addDays(today, -BACKFILL_DAYS), mark: today }
      }
      const res = state.next
        ? await c.request<unknown>({ path: state.next })
        : await c.request<unknown>({ path: '/payroll-runs/', query: { limit, order_by: ORDER } })
      const runs = results(res.data)
      const events: NormalizedEvent[] = []
      const unknown = new Set<string>()
      let reachedOld = false
      for (const r of runs) {
        const check = str(r.check_date)?.slice(0, 10)
        if (!check) continue
        if (check < state.stopBefore) {
          reachedOld = true
          break
        }
        const rs = str(r.run_state)
        if (rs && !KNOWN_STATES.has(rs)) unknown.add(rs)
        events.push(...(await toRuns(c, r, conn, today)))
      }
      const link = reachedOld ? null : nextLink(res.data, { order_by: ORDER, limit: String(limit) })
      const done = link === null
      const next: CursorState = done ? { next: null, stopBefore: state.stopBefore, mark: state.mark } : { ...state, next: link }
      const out: SyncResult = { events, cursor: codec.encode(next), hasMore: !done }
      if (unknown.size) out.warnings = [`Rippling returned payroll runs in a state Aggregate doesn't know yet (${[...unknown].sort().join(', ')}); those runs were skipped.`]
      return out
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        const { apiToken } = requireSecret(PROVIDER, conn.secret, isSecret)
        await http(apiToken).request({ path: '/payroll-runs/', query: { limit: 1 } })
        return { status: 'ok', lastSuccessAt: new Date(clock.now()).toISOString() }
      } catch (e) {
        return healthFromError(e)
      }
    },
  }

  async function toRuns(c: HttpClient, r: Obj, conn: ConnectionRef, today: string): Promise<PayrollRun[]> {
    const id = str(r.id)
    const state = str(r.run_state)
    const payDate = str(r.check_date)?.slice(0, 10)
    // Drafts can still change completely; they aren't payroll yet.
    if (!id || !payDate || (state !== 'PAID' && state !== 'APPROVED')) return []
    const records: Obj[] = []
    let link: string | null = null
    for (let i = 0; i < 100; i++) {
      const res: { data: unknown } = link
        ? await c.request<unknown>({ path: link })
        : await c.request<unknown>({ path: `/payroll-runs/${encodeURIComponent(id)}/worker-payroll-records/`, query: { limit: 100 } })
      records.push(...results(res.data))
      link = nextLink(res.data, { limit: '100' })
      if (!link) break
    }
    const rawRef = await deps.raw.put(conn.id, `${PROVIDER}.payroll_run`, id, { run: r, records })
    const period = isRecord(r.pay_period) ? r.pay_period : {}
    const byCur = new Map<string, Obj[]>()
    for (const w of records) {
      const cur = normalizeCurrency(str(w.currency), 'USD')
      const list = byCur.get(cur) ?? []
      list.push(w)
      byCur.set(cur, list)
    }
    const multi = byCur.size > 1
    const out: PayrollRun[] = []
    for (const [currency, ws] of [...byCur.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      let gross = 0
      let net = 0
      let erTax = 0
      let eeTax = 0
      let benefits = 0
      const lines: NonNullable<PayrollRun['lines']> = []
      for (const w of ws) {
        const s = isRecord(w.summary) ? w.summary : {}
        const g = dec(w.gross_pay, currency)
        const n = dec(w.net_pay, currency)
        gross += g
        net += n
        erTax += dec(s.employer_taxes, currency)
        eeTax += dec(s.employee_taxes, currency)
        benefits += dec(s.employer_contributions, currency)
        const who = str(w.worker_id)
        if (who) lines.push({ person: who, gross: { minor: g, currency }, net: { minor: n, currency }, kind: 'employee' })
      }
      const input: Parameters<typeof providerRun>[0] = {
        externalId: multi ? `${id}:${currency}` : id,
        connectionId: conn.id,
        rawRef,
        provider: 'Rippling',
        payDate,
        currency,
        gross,
        net,
        employerTaxes: erTax,
        employeeTaxes: eeTax,
        employerBenefits: benefits,
        lines,
        employeeCount: lines.length,
        today,
      }
      const ps = str(period.start_date)
      const pe = str(period.end_date)
      if (ps) input.periodStart = ps.slice(0, 10)
      if (pe) input.periodEnd = pe.slice(0, 10)
      const run = providerRun(input)
      // APPROVED = locked but not yet paid out.
      if (state === 'APPROVED' && run.status === 'paid') run.status = 'processed'
      out.push(run)
    }
    return out
  }
}
