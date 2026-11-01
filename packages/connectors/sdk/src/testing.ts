// Contract-test helpers. Every connector's tests replay redacted recorded fixtures through fixtureFetch and run
// runConnectorContract, which checks the event contract (sign rule inputs, integer money, ids, references),
// idempotency (same input → same events), and cursor resumption (page-by-page == one go).
// Framework-agnostic: failures throw AssertionError, so vitest/node:test both report them.

import { AssertionError } from 'node:assert'
import type { Connector, ConnectionRef, NormalizedEvent } from '@agfn/contracts'
import type { Clock, FetchLike } from './http.ts'
import { runSync } from './sync.ts'

function fail(message: string): never {
  throw new AssertionError({ message })
}

// ---------- Fixture fetch ----------

export interface FixtureResponse {
  status?: number
  json?: unknown
  text?: string
  headers?: Record<string, string>
}

export interface FixtureRoute {
  method?: string
  /** Substring of the URL (path + query), a RegExp, or a predicate. */
  match: string | RegExp | ((url: URL, init: RequestInit | undefined, body: unknown) => boolean)
  /** One response, a list served in order (last one repeats), or a function of the request. */
  respond: FixtureResponse | FixtureResponse[] | ((url: URL, body: unknown) => FixtureResponse)
}

export interface RecordedCall {
  method: string
  url: string
  body: unknown
  headers: Record<string, string>
}

export interface FixtureFetch {
  fetch: FetchLike
  calls: RecordedCall[]
}

/** A fetch that serves fixtures and fails loudly on any request it doesn't know (no live network in tests). */
export function fixtureFetch(routes: FixtureRoute[]): FixtureFetch {
  const calls: RecordedCall[] = []
  const served = new Map<FixtureRoute, number>()
  const fetchFn: FetchLike = async (input, init) => {
    const url = new URL(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const raw = typeof init?.body === 'string' ? init.body : undefined
    let body: unknown = raw
    if (raw !== undefined) {
      try {
        body = JSON.parse(raw)
      } catch {
        body = Object.fromEntries(new URLSearchParams(raw))
      }
    }
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    calls.push({ method, url: url.toString(), body, headers })
    const route = routes.find((r) => {
      if (r.method && r.method.toUpperCase() !== method) return false
      if (typeof r.match === 'string') return (url.pathname + url.search).includes(r.match)
      if (r.match instanceof RegExp) return r.match.test(url.pathname + url.search)
      return r.match(url, init, body)
    })
    if (!route) fail(`fixtureFetch: no fixture for ${method} ${url.pathname}${url.search}`)
    let resp: FixtureResponse
    if (typeof route.respond === 'function') resp = route.respond(url, body)
    else if (Array.isArray(route.respond)) {
      const i = served.get(route) ?? 0
      served.set(route, i + 1)
      const r = route.respond[Math.min(i, route.respond.length - 1)]
      if (!r) fail('fixtureFetch: empty response list')
      resp = r
    } else resp = route.respond
    const text = resp.text ?? (resp.json === undefined ? '' : JSON.stringify(resp.json))
    return new Response(text, {
      status: resp.status ?? 200,
      headers: { 'content-type': resp.json === undefined ? 'text/plain' : 'application/json', ...resp.headers },
    })
  }
  return { fetch: fetchFn, calls }
}

/** A clock that never really sleeps (retries/backoff run instantly) and records the waits. */
export function fakeClock(start = Date.parse('2026-10-09T12:00:00Z')): Clock & { sleeps: number[]; t: number } {
  const c = {
    t: start,
    sleeps: [] as number[],
    now: () => c.t,
    sleep: async (ms: number) => {
      c.sleeps.push(ms)
      c.t += ms
    },
  }
  return c
}

// ---------- Event contract ----------

const DATE = /^\d{4}-\d{2}-\d{2}$/
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

export interface EventCheckOptions {
  connectionId: string
  /** Require rawRef on every event (default true). */
  requireRawRef?: boolean
  /** Accounts known from an earlier sync (so balances/txns may reference them without an upsert in this batch). */
  knownAccounts?: string[]
}

export function assertValidEvents(events: NormalizedEvent[], opts: EventCheckOptions): void {
  const seen = new Set<string>()
  const accounts = new Set(opts.knownAccounts ?? [])
  for (const e of events) if (e.type === 'account.upsert') accounts.add(e.externalId)

  const money = (where: string, m: { minor: number; currency: string } | undefined) => {
    if (!m) fail(`${where}: missing money`)
    if (!Number.isSafeInteger(m.minor)) fail(`${where}: minor ${m.minor} is not a safe integer`)
    if (!/^[A-Z]{3}$/.test(m.currency)) fail(`${where}: bad currency ${JSON.stringify(m.currency)}`)
  }

  for (const e of events) {
    const where = `${e.type} ${e.externalId}`
    if (!e.externalId || typeof e.externalId !== 'string') fail(`${e.type}: empty externalId`)
    if (e.connectionId !== opts.connectionId) fail(`${where}: wrong connectionId ${e.connectionId}`)
    // A completed listing is a marker, not a record: it has no payload of its own.
    if ((opts.requireRawRef ?? true) && !e.rawRef && e.type !== 'listing.complete') fail(`${where}: missing rawRef`)
    const fx = (e as { fx?: { rate: unknown; home: unknown } }).fx
    if (fx !== undefined) {
      if (typeof fx.rate !== 'string' || !/^\d+(\.\d+)?$/.test(fx.rate) || !(Number(fx.rate) > 0)) fail(`${where}: fx.rate ${JSON.stringify(fx.rate)} is not a positive decimal string`)
      if (typeof fx.home !== 'string' || !/^[A-Z]{3}$/.test(fx.home)) fail(`${where}: bad fx.home ${JSON.stringify(fx.home)}`)
    }
    const key = e.type + '\0' + e.externalId
    if (seen.has(key)) fail(`${where}: duplicate (type, externalId) in one sync`)
    seen.add(key)

    switch (e.type) {
      case 'listing.complete':
        if (e.kinds.length === 0 || e.kinds.some((k) => !['invoice', 'bill', 'journal', 'payment', 'txn', 'credit_note', 'investment'].includes(k))) fail(`${where}: bad kinds ${JSON.stringify(e.kinds)}`)
        if (Number.isNaN(Date.parse(e.startedAt))) fail(`${where}: bad startedAt ${JSON.stringify(e.startedAt)}`)
        break
      case 'account.upsert':
        if (!e.name) fail(`${where}: empty name`)
        if (!/^[A-Z]{3}$/.test(e.currency)) fail(`${where}: bad currency`)
        break
      case 'balance.snapshot':
        if (!accounts.has(e.accountExternalId)) fail(`${where}: unknown account ${e.accountExternalId}`)
        if (!TS.test(e.at)) fail(`${where}: bad timestamp ${e.at}`)
        money(where + ' current', e.current)
        if (e.available) money(where + ' available', e.available)
        break
      case 'txn.upsert':
        if (!accounts.has(e.accountExternalId)) fail(`${where}: unknown account ${e.accountExternalId}`)
        if (!DATE.test(e.date)) fail(`${where}: bad date ${e.date}`)
        money(where, e.amount)
        break
      case 'processor.balance_txn':
        if (!accounts.has(e.accountExternalId)) fail(`${where}: unknown account ${e.accountExternalId}`)
        if (!TS.test(e.at)) fail(`${where}: bad timestamp ${e.at}`)
        money(where + ' gross', e.gross)
        money(where + ' fee', e.fee)
        money(where + ' net', e.net)
        if (e.gross.currency !== e.net.currency || e.fee.currency !== e.net.currency) fail(`${where}: mixed currencies`)
        if (e.gross.minor - e.fee.minor !== e.net.minor) fail(`${where}: gross - fee != net`)
        break
      case 'invoice.upsert':
        if (!DATE.test(e.issueDate)) fail(`${where}: bad issueDate`)
        if (e.dueDate && !DATE.test(e.dueDate)) fail(`${where}: bad dueDate`)
        money(where + ' total', e.total)
        money(where + ' paid', e.amountPaid)
        if (e.total.currency !== e.amountPaid.currency) fail(`${where}: mixed currencies`)
        break
      case 'payroll.run':
        if (!DATE.test(e.payDate)) fail(`${where}: bad payDate`)
        money(where + ' gross', e.gross)
        money(where + ' taxes', e.employerTaxes)
        money(where + ' net', e.net)
        break
      case 'equity.event':
        if (!DATE.test(e.date)) fail(`${where}: bad date`)
        if (e.amount) money(where, e.amount)
        break
      case 'payment.applied': {
        if (!DATE.test(e.date)) fail(`${where}: bad date`)
        money(where, e.amount)
        let applied = 0
        for (const a of e.applications) {
          money(where + ' application', a.amount)
          applied += a.amount.minor
        }
        if (e.unapplied) money(where + ' unapplied', e.unapplied)
        if (applied + (e.unapplied?.minor ?? 0) !== e.amount.minor) fail(`${where}: applications + unapplied != amount`)
        break
      }
      case 'credit_note.upsert':
        if (!DATE.test(e.date)) fail(`${where}: bad date`)
        money(where, e.amount)
        break
      case 'subscription.upsert':
        money(where + ' mrr', e.mrr)
        if (e.mrr.minor < 0) fail(`${where}: mrr must be >= 0`)
        if (e.status !== 'active' && e.status !== 'past_due' && e.mrr.minor !== 0) fail(`${where}: mrr must be 0 when ${e.status}`)
        if (!TS.test(e.startedAt)) fail(`${where}: bad startedAt`)
        if (!(Number.isInteger(e.intervalCount) && e.intervalCount > 0)) fail(`${where}: bad intervalCount`)
        break
      case 'report.snapshot':
        if (!DATE.test(e.from) || !DATE.test(e.to)) fail(`${where}: bad period`)
        for (const r of e.rows) money(where + ' ' + r.account, r.amount)
        break
    }
  }
}

/** Expected sign (+ in, − out) for specific transactions, checked against what the connector emitted. */
export function assertSigns(events: NormalizedEvent[], expected: Record<string, '+' | '-'>): void {
  for (const [id, sign] of Object.entries(expected)) {
    const e = events.find((x) => x.externalId === id && (x.type === 'txn.upsert' || x.type === 'processor.balance_txn'))
    if (!e) fail(`assertSigns: no txn ${id}`)
    const minor = e.type === 'txn.upsert' ? e.amount.minor : e.type === 'processor.balance_txn' ? e.net.minor : 0
    if (sign === '+' ? !(minor > 0) : !(minor < 0)) fail(`assertSigns: ${id} expected ${sign} got ${minor}`)
  }
}

// ---------- Full contract ----------

export interface ContractOptions {
  /** Fresh connector + connection per run (fixtures restart from the beginning each time). */
  make: () => { connector: Connector; conn: ConnectionRef }
  signs?: Record<string, '+' | '-'>
  minEvents?: number
  requireRawRef?: boolean
}

export interface ContractReport {
  events: NormalizedEvent[]
  pages: number
  cursor: string | null
}

/**
 * 1. describe() is well-formed. 2. A full sync from null completes and emits valid events.
 * 3. Running it again yields the same events (deterministic ids, values and rawRefs).
 * 4. Stopping after each page and resuming from the saved cursor yields the same final state.
 */
export async function runConnectorContract(opts: ContractOptions): Promise<ContractReport> {
  const first = opts.make()
  const d = first.connector.describe()
  if (!/^[a-z0-9_-]+$/.test(d.key)) fail(`describe: bad key ${d.key}`)
  if (!d.name || !d.freshness || !d.provides.length) fail('describe: name, freshness and provides are required')

  const full = await runSync(first.connector, first.conn, null)
  if (!full.complete) fail('full sync did not complete')
  const finalState = lastWins(full.events)
  assertValidEvents([...finalState.values()], {
    connectionId: first.conn.id,
    requireRawRef: opts.requireRawRef ?? true,
  })
  if (opts.minEvents !== undefined && finalState.size < opts.minEvents) {
    fail(`expected at least ${opts.minEvents} events, got ${finalState.size}`)
  }
  if (opts.signs) assertSigns([...finalState.values()], opts.signs)

  const again = opts.make()
  const second = await runSync(again.connector, again.conn, null)
  if (JSON.stringify(second.events) !== JSON.stringify(full.events)) fail('second full sync differs (not deterministic)')

  const resumed = opts.make()
  const stepEvents: NormalizedEvent[] = []
  let cursor: string | null = null
  for (let i = 0; i < 10_000; i++) {
    const step = await runSync(resumed.connector, resumed.conn, cursor, { maxPages: 1 })
    stepEvents.push(...step.events)
    cursor = step.cursor
    if (step.complete) break
  }
  const resumedState = lastWins(stepEvents)
  if (JSON.stringify([...resumedState.entries()].sort()) !== JSON.stringify([...finalState.entries()].sort())) {
    fail('page-by-page resume differs from a single full sync')
  }
  return { events: [...finalState.values()], pages: full.pages, cursor: full.cursor }
}

function lastWins(events: NormalizedEvent[]): Map<string, NormalizedEvent> {
  const m = new Map<string, NormalizedEvent>()
  for (const e of events) m.set(e.type + '\0' + e.externalId, e)
  return m
}

// ---------- Fixture redaction ----------

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['stripe live key', /\b(sk|rk|pk)_live_[A-Za-z0-9]{8,}/],
  ['plaid production token', /\b(access|public)-production-[a-f0-9-]{8,}/],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._-]{20,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['long account number', /(?<![\d.])\d{12,19}(?![\d.])/],
  ['ssn', /\b\d{3}-\d{2}-\d{4}\b/],
  ['email (non-example domain)', /\b[A-Za-z0-9._%+-]+@(?!example\.(com|org|net)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
]

/** Throws if a fixture looks like it contains a real secret or personal identifier. */
export function assertRedacted(fixture: unknown, allow: RegExp[] = []): void {
  const text = typeof fixture === 'string' ? fixture : JSON.stringify(fixture)
  for (const [name, re] of SECRET_PATTERNS) {
    const m = re.exec(text)
    if (m && !allow.some((a) => a.test(m[0]))) fail(`fixture is not redacted: looks like a ${name}: ${m[0].slice(0, 12)}…`)
  }
}

/** Replace values of sensitive keys (deep) with a fixed placeholder; for preparing recorded fixtures. */
export function redact<T>(value: T, keys: string[] = DEFAULT_REDACT_KEYS): T {
  const set = new Set(keys.map((k) => k.toLowerCase()))
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, set.has(k.toLowerCase()) && x != null ? 'REDACTED' : walk(x)]),
      )
    }
    return v
  }
  return walk(value) as T
}

export const DEFAULT_REDACT_KEYS = [
  'access_token', 'refresh_token', 'secret', 'client_secret', 'api_key', 'password', 'account_number', 'routing_number',
  'ssn', 'tax_id', 'email', 'phone', 'phone_number', 'address', 'street', 'owners', 'iban', 'bic',
]
