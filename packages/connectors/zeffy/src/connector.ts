// Zeffy connector (the organization owner's API key, pasted): monthly online payments, refunds and their net per currency,
// as report.snapshot. What Zeffy reports, not booked revenue.
//
// Not emitted, on purpose: no transaction.upsert, nothing that posts. Zeffy pays the money out to the organization's bank,
// which may be connected already, so posting would double it. report.snapshot never reaches the ledger, and core's
// provider_report check skips this connector (checks.ts).
//
// Auth: an API key from Settings → Integrations. A key can also record and delete payments and Zeffy documents no
// read-only key, so the client sends GET only instead (client.ts), and connect says so.
//
// Months are the organization's own, on the time zone the person picks at connect: Zeffy's API gives none, and guessing
// UTC would move a payment near a month's edge into the wrong month. Currencies are never added together.
//
// A run reads every payment created since a year before the first reported month, one page per step with the totals in
// the cursor, and only then sends the months: a half-read month must never show. The extra year is for refunds, which
// Zeffy only lists on their payment. Stored: monthly totals only. No buyer name, email or address, in events or raw.
//
// Built from Zeffy's public API reference. It has not been run against a real organization, and the fixtures are
// hand-built. See README.md for what's unverified.

import type { ConnectBegin, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, ReportSnapshot, SyncResult } from '@agfn/contracts'
import { ConnectorError, cursorCodec, healthFromError, isRecord, requireSecret, str, systemClock, type ConnectorDeps } from '@agfn/connector-sdk'
import { ZeffyClient } from './client.ts'
import { addMonths, dayIn, emptyTotals, exact, isMonthTotals, lastDay, monthIn, monthRows, paymentLine, type MonthTotals } from './report.ts'

const PROVIDER = 'zeffy'
export const REPORT_MONTHS = 12
/** Months before the first reported one whose payments are read for their refunds only. */
export const REFUND_LOOKBACK_MONTHS = 12

export const NOT_REVOKED = 'In Zeffy, open Settings → Integrations and regenerate or remove the API key you gave Aggregate.'
export const ZEFFY_KEY_CAN_WRITE = 'A Zeffy API key can also record and delete payments, and Zeffy has no read-only key. Aggregate only reads: it never sends Zeffy anything but a read request.'

/** The choices at connect, Zeffy being for organizations in Canada and the US. Each label names one IANA zone. */
export const TIME_ZONES: ReadonlyArray<readonly [label: string, zone: string]> = [
  ['Eastern (Toronto, New York)', 'America/Toronto'],
  ['Central (Winnipeg, Chicago)', 'America/Winnipeg'],
  ['Mountain (Edmonton, Denver)', 'America/Edmonton'],
  ['Pacific (Vancouver, Los Angeles)', 'America/Vancouver'],
  ['Atlantic (Halifax)', 'America/Halifax'],
  ['Newfoundland (St. John’s)', 'America/St_Johns'],
  ['Saskatchewan (Regina)', 'America/Regina'],
  ['Arizona (Phoenix)', 'America/Phoenix'],
  ['Alaska (Anchorage)', 'America/Anchorage'],
  ['Hawaii (Honolulu)', 'Pacific/Honolulu'],
]

/** A label from the list, or an IANA zone typed through the API. */
export function parseZone(input: string): string | null {
  const s = input.trim()
  const listed = TIME_ZONES.find(([label, zone]) => label === s || zone === s)
  if (listed) return listed[1]
  if (!/^[A-Za-z_]+\/[A-Za-z_/+-]+$/.test(s)) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s })
    return s
  } catch {
    return null
  }
}

export interface ZeffySecret {
  apiKey: string
  zone: string
}

interface Run {
  first: string
  until: string
  today: string
  /** Unix seconds: two days before the lookback's first month, so every time zone's first day is in. */
  since: number
  zone: string
  /** Zeffy's cursor: the id to start after. Null on the first page. */
  after: string | null
  /** month → currency → totals. */
  totals: Record<string, Record<string, MonthTotals>>
}

interface ZeffyCursor {
  /** Between runs, null. */
  run: Run | null
  /** Every currency reported, so its months keep being sent (as zeros) once it's quiet. */
  currencies: string[]
}

const isRun = (v: unknown): v is Run =>
  isRecord(v) &&
  ['first', 'until', 'today', 'zone'].every((k) => typeof v[k] === 'string') &&
  typeof v.since === 'number' &&
  (v.after === null || typeof v.after === 'string') &&
  isRecord(v.totals) &&
  Object.values(v.totals).every((byCurrency) => isRecord(byCurrency) && Object.values(byCurrency).every(isMonthTotals))
const isCursor = (v: unknown): v is ZeffyCursor => isRecord(v) && Array.isArray(v.currencies) && v.currencies.every((c) => typeof c === 'string') && (v.run === null || isRun(v.run))
const isSecret = (v: unknown): v is ZeffySecret => isRecord(v) && typeof v.apiKey === 'string' && typeof v.zone === 'string'

/** Zeffy doesn't document its key format; anything long, with no spaces, is tried. */
const KEY_RE = /^\S{16,512}$/

export interface ZeffyConnector extends Connector {
  begin(): Promise<ConnectBegin>
}

export function createZeffyConnector(deps: ConnectorDeps): ZeffyConnector {
  const clock = deps.clock ?? systemClock
  const codec = cursorCodec<ZeffyCursor>(PROVIDER, 1, isCursor)

  const description: ConnectorDescription = {
    key: PROVIDER,
    name: 'Zeffy',
    group: 'payments',
    provides: ['reports'],
    freshness: 'updates every few hours',
    auth: 'api_key',
  }

  const secretOf = (conn: ConnectionRef) => requireSecret(PROVIDER, conn.secret, isSecret)
  const totalsFor = (run: Run, month: string, currency: string): MonthTotals => ((run.totals[month] ??= {})[currency] ??= emptyTotals())
  const inRun = (run: Run, month: string) => month >= run.first && month <= run.until

  async function snapshots(conn: ConnectionRef, run: Run, currencies: string[]): Promise<ReportSnapshot[]> {
    const events: ReportSnapshot[] = []
    for (let month = run.first; month <= run.until; month = addMonths(month, 1)) {
      const end = lastDay(month)
      for (const currency of currencies) {
        const t = run.totals[month]?.[currency] ?? emptyTotals()
        const externalId = `zeffy:${month}:${currency}`
        const rawRef = await deps.raw.put(conn.id, 'zeffy.month', externalId, { month, currency, totals: t })
        events.push({ type: 'report.snapshot', externalId, connectionId: conn.id, rawRef, kind: 'profit_and_loss', from: `${month}-01`, to: end < run.today ? end : run.today, basis: 'accrual', currency, rows: monthRows(t, currency) })
      }
    }
    return events
  }

  return {
    describe: () => description,

    async begin() {
      return {
        kind: 'api_key',
        label: 'Zeffy API key',
        steps: [
          'In Zeffy, sign in as the organization’s owner and open Settings → Integrations.',
          'Complete the quick setup to make an API key, and copy it.',
          'Paste the key here and pick the time zone your organization works in.',
        ],
        permissions: ['Aggregate reads payment and refund totals only, with no donor names, emails or addresses, and keeps monthly amounts received online, not booked revenue.'],
        helpUrl: 'https://www.zeffy.com/api/docs',
        placeholder: '',
        fields: [
          { name: 'apiKey', label: 'API key', placeholder: '', secret: true },
          { name: 'zone', label: 'Organization’s time zone', options: TIME_ZONES.map(([label]) => label) },
        ],
      }
    },

    async connect(input) {
      const apiKey = str(input.apiKey)?.trim() ?? ''
      const zone = parseZone(str(input.zone) ?? '')
      if (!KEY_RE.test(apiKey)) throw new ConnectorError('invalid_input', 'Paste the API key from Zeffy’s Settings → Integrations.', { provider: PROVIDER })
      if (!zone) throw new ConnectorError('invalid_input', 'Pick the time zone your organization works in.', { provider: PROVIDER })
      await new ZeffyClient(apiKey, deps).payments(0, null, 1)
      const secret: ZeffySecret = { apiKey, zone }
      // Zeffy has no read-only key (see the note at the top), so the person is told instead.
      return { secret, config: { zone, warnings: [ZEFFY_KEY_CAN_WRITE] } }
    },

    async sync(conn, cursor): Promise<SyncResult> {
      const secret = secretOf(conn)
      const client = new ZeffyClient(secret.apiKey, deps)
      const decoded = codec.decode(cursor)
      const reported = decoded?.currencies ?? []

      let run = decoded?.run ?? null
      if (!run) {
        const now = clock.now()
        const until = monthIn(secret.zone, now)
        const first = addMonths(until, 1 - REPORT_MONTHS)
        const since = Math.floor((Date.parse(`${addMonths(first, -REFUND_LOOKBACK_MONTHS)}-01T00:00:00Z`) - 2 * 86_400_000) / 1000)
        // On the organization's clock too, or a month that has begun there but not in UTC would end before it starts.
        run = { first, until, today: dayIn(secret.zone, now), since, zone: secret.zone, after: null, totals: {} }
      }

      const page = await client.payments(run.since, run.after)
      const next: Run = { ...run, after: page.next, totals: structuredClone(run.totals) }
      for (const p of page.rows) {
        const line = paymentLine(p, run.zone)
        // Sold before the lookback: its sale and refunds are out, like a payment Zeffy no longer lists.
        if (!line.counted || line.month < addMonths(run.first, -REFUND_LOOKBACK_MONTHS) || line.month > run.until) continue
        if (inRun(run, line.month)) {
          const t = totalsFor(next, line.month, line.currency)
          t.received = exact(t.received + line.amount)
        }
        for (const r of line.refunds) {
          if (!inRun(run, r.month)) continue
          const t = totalsFor(next, r.month, line.currency)
          t.refunds = exact(t.refunds + r.amount)
        }
      }
      if (page.next) return { events: [], cursor: codec.encode({ run: next, currencies: reported }), hasMore: true }

      const currencies = [...new Set([...reported, ...Object.values(next.totals).flatMap((byCurrency) => Object.keys(byCurrency))])].sort()
      return { events: await snapshots(conn, next, currencies), cursor: codec.encode({ run: null, currencies }), hasMore: false }
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        await new ZeffyClient(secretOf(conn).apiKey, deps).payments(0, null, 1)
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },

    // A pasted key can't be revoked from here.
    async disconnect() {
      return { notRevoked: NOT_REVOKED }
    },
  }
}
