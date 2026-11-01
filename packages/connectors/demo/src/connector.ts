// Demo connector: fake but internally consistent money for one demo entity. Never touches the network.
// The first page is small: the accounts and today's balances only (computed by generating the year in memory), so the
// demo shows cash within seconds. Then whole calendar months of history per page, stopping at the month past ~1,600
// events, so a year imports in 2–4 pages: each page is a ledger transaction with fixed costs (its context, lock,
// version, settle marks), and a fill's time on a hosted database is mostly round trips (2026-10-13: 4,403 statements a
// fill at 400 a page, 2,465 at 1,600); the events are the same however they're paged. The cursor carries running
// balances so every balance snapshot equals opening + the transactions emitted (the ledger's balance checks pass on
// demo data).

import type { BalanceSnapshot, ConnectBegin, Connector, ConnectorDescription, NormalizedEvent, SyncResult } from '@agfn/contracts'
import { ConnectorError, cursorCodec, isRecord, isoTimestamp, requireSecret, str, systemClock, type ConnectorDeps } from '@agfn/connector-sdk'
import { addDays, eachDay, isMonthEnd, lastDayOfMonth } from './dates.ts'
import { PROFILES, PROFILE_KEYS, type DayContext, type Draft, type ProfileKey } from './profiles.ts'

export const DEMO_KEY = 'demo'
export const DEFAULT_SEED = 'aggregate-demo-v1'
export const HISTORY_DAYS = 365
/** Months generated per sync page at most, and the event count after which a page stops at the next month boundary. */
export const MONTHS_PER_PAGE = 12
export const EVENTS_PER_PAGE = 1600

export interface DemoConfig {
  profile: ProfileKey
  /** First day of generated history (YYYY-MM-DD), fixed at connect so re-syncs extend rather than shift. */
  start: string
  seed: string
  /** Harbor Coffee only: the Glass Ledger's start (glass.ts). */
  glass?: string
  /** Mark the Glass Ledger's planted rows " [planted]" (the public log's workspace; never the benchmark). */
  glassTag?: boolean
}

interface DemoCursor {
  /** Next day to generate. */
  next: string
  /** Running balance per account (minor units, money-in positive). */
  bal: Record<string, number>
  /** The quick first page (accounts + today's balances) was sent; history starts at `next`. */
  head?: boolean
}

const isCursor = (v: unknown): v is DemoCursor => isRecord(v) && typeof v.next === 'string' && isRecord(v.bal)
const isProfile = (v: unknown): v is ProfileKey => typeof v === 'string' && (PROFILE_KEYS as readonly string[]).includes(v)

export function demoConfigOf(config: Record<string, unknown>): DemoConfig {
  const profile = config.profile
  const start = str(config.start)
  if (!isProfile(profile) || !start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    throw new ConnectorError('invalid_input', 'demo connection is missing its profile or start date', { provider: DEMO_KEY })
  }
  const glass = str(config.glass)
  const withGlass = glass && /^\d{4}-\d{2}-\d{2}$/.test(glass)
  return { profile, start, seed: str(config.seed) ?? DEFAULT_SEED, ...(withGlass ? { glass } : {}), ...(withGlass && config.glassTag === true ? { glassTag: true } : {}) }
}

/** True once a demo connection's history reaches `today` (the connector has nothing left to backfill). */
export function demoCaughtUp(cursor: string | null, today: string): boolean {
  try {
    const state = cursorCodec<DemoCursor>(DEMO_KEY, 1, isCursor).decode(cursor)
    return state !== null && state.next > today
  } catch {
    return false
  }
}

export interface DemoConnector extends Connector {
  begin(): Promise<ConnectBegin>
}

export function createDemoConnector(deps: ConnectorDeps): DemoConnector {
  const clock = deps.clock ?? systemClock
  const codec = cursorCodec<DemoCursor>(DEMO_KEY, 1, isCursor)
  const description: ConnectorDescription = {
    key: DEMO_KEY,
    name: 'Demo data',
    group: 'other',
    provides: ['balances', 'transactions', 'invoices', 'payroll'],
    freshness: 'updates daily with sample data',
    auth: 'none',
  }

  return {
    describe: () => description,

    async begin() {
      // Demo connections are created by the demo workspace setup, never through the normal connect flow.
      throw new ConnectorError('invalid_input', 'demo data is added with "Try with demo data", not connected', { provider: DEMO_KEY })
    },

    async connect(input) {
      const profile = input.profile
      if (!isProfile(profile)) throw new ConnectorError('invalid_input', `profile must be one of ${PROFILE_KEYS.join(', ')}`, { provider: DEMO_KEY })
      const today = isoTimestamp(clock.now()).slice(0, 10)
      const start = str(input.start) ?? addDays(today, -HISTORY_DAYS)
      const config: DemoConfig = { profile, start, seed: str(input.seed) ?? DEFAULT_SEED }
      return { secret: { demo: true }, config: { ...config } }
    },

    async health() {
      return { status: 'ok', message: 'Sample data' }
    },

    async sync(conn, cursor): Promise<SyncResult> {
      requireSecret(DEMO_KEY, conn.secret, (s): s is { demo: true } => isRecord(s) && s.demo === true)
      const cfg = demoConfigOf(conn.config)
      const profile = PROFILES[cfg.profile]
      const ctx: DayContext = { seed: cfg.seed, start: cfg.start, ...(cfg.glass ? { glass: cfg.glass } : {}), ...(cfg.glassTag ? { glassTag: true } : {}) }
      const now = clock.now()
      const today = isoTimestamp(now).slice(0, 10)
      const opening = () => Object.fromEntries(profile.accounts.map((a) => [a.id, a.opening]))
      const decoded = codec.decode(cursor)

      const accountDrafts = (): Draft[] =>
        profile.accounts.map((a) => ({
          type: 'account.upsert',
          externalId: a.id,
          name: a.name,
          accountType: a.type,
          currency: 'USD',
          institution: a.institution,
          ...(a.mask ? { mask: a.mask } : {}),
          businessHint: profile.kind === 'personal' ? 'personal' : 'business',
          ...(a.liability ? { liability: a.liability(today, ctx) } : {}),
        }))

      if (!decoded) {
        // Quick first page: run the year in memory for today's balances (the same numbers the last page will report).
        const end: Record<string, number> = opening()
        for (const date of cfg.start <= today ? eachDay(cfg.start, today) : []) {
          for (const e of profile.day(date, ctx)) {
            if (e.type === 'txn.upsert' && e.status !== 'void') end[e.accountExternalId] = (end[e.accountExternalId] ?? 0) + e.amount.minor
            if (e.type === 'processor.balance_txn') end[e.accountExternalId] = (end[e.accountExternalId] ?? 0) + e.net.minor
          }
        }
        // Today's balance counts today's rows, so it's stamped after the last of them (19:00Z), like month ends.
        const at = `${today}T21:00:00.000Z`
        const head: Draft[] = [
          ...accountDrafts(),
          ...profile.accounts.map((a) => ({ type: 'balance.snapshot' as const, externalId: `${a.id}@${today}`, accountExternalId: a.id, at, current: { minor: end[a.id] ?? 0, currency: 'USD' }, ...(a.holdings ? { holdings: a.holdings } : {}) })),
        ]
        const events: NormalizedEvent[] = []
        for (const d of head) {
          const rawRef = await deps.raw.put(conn.id, `demo.${d.type}`, d.externalId, d)
          events.push({ ...d, connectionId: conn.id, rawRef } as NormalizedEvent)
        }
        return { events, cursor: codec.encode({ next: cfg.start, bal: opening(), head: true }), hasMore: true }
      }
      const state = decoded

      const drafts: Draft[] = []
      // Cursors from before the quick first page start history without having sent the accounts.
      if (state.next === cfg.start && !state.head) drafts.push(...accountDrafts())

      const bal = { ...state.bal }
      const snapshot = (date: string, at: string) => {
        for (const a of profile.accounts) {
          const s: Omit<BalanceSnapshot, 'connectionId' | 'rawRef'> = {
            type: 'balance.snapshot',
            externalId: `${a.id}@${date}`,
            accountExternalId: a.id,
            at,
            current: { minor: bal[a.id] ?? 0, currency: 'USD' },
            ...(a.holdings ? { holdings: a.holdings } : {}),
          }
          drafts.push(s)
        }
      }

      // Whole months only, so a page never ends mid-month: the same events and month-end snapshots as one month a page.
      let from = state.next
      let to = today
      for (let months = 0; from <= today && months < MONTHS_PER_PAGE && (months === 0 || drafts.length < EVENTS_PER_PAGE); months++) {
        to = lastDayOfMonth(from) < today ? lastDayOfMonth(from) : today
        for (const date of eachDay(from, to)) {
          for (const e of profile.day(date, ctx)) {
            drafts.push(e)
            if (e.type === 'txn.upsert' && e.status !== 'void') bal[e.accountExternalId] = (bal[e.accountExternalId] ?? 0) + e.amount.minor
            if (e.type === 'processor.balance_txn') bal[e.accountExternalId] = (bal[e.accountExternalId] ?? 0) + e.net.minor
          }
          // Every timestamp sits mid-day UTC (payouts 13:00, charges 14:00–19:00, month-end balances 21:00), so rows and
          // balances fall on the same local day from Hawaii to central Europe (the ledger dates them by the workspace's
          // time zone).
          if (isMonthEnd(date) && date < today) snapshot(date, `${date}T21:00:00.000Z`)
        }
        from = addDays(to, 1)
      }

      const done = to >= today
      if (done) {
        drafts.push(...profile.final(today, ctx))
        snapshot(today, `${today}T21:00:00.000Z`)
      }

      const events: NormalizedEvent[] = []
      for (const d of drafts) {
        const rawRef = await deps.raw.put(conn.id, `demo.${d.type}`, d.externalId, d)
        events.push({ ...d, connectionId: conn.id, rawRef } as NormalizedEvent)
      }
      const next: DemoCursor = { next: state.next > today ? state.next : addDays(to, 1), bal, ...(state.head ? { head: true } : {}) }
      return { events, cursor: codec.encode(next), hasMore: !done }
    },
  }
}
