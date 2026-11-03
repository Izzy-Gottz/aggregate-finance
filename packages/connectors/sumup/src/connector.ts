// SumUp connector (card payments): monthly gross sales, refunds, chargebacks, payouts, fees and deductions per currency, as
// report.snapshot. What SumUp reports, not booked revenue.
//
// Not emitted, on purpose: no transaction.upsert, no account.upsert with money, nothing that posts. SumUp's money arrives in
// the bank and the same sales often sit in the books, so posting these would double revenue. report.snapshot never reaches
// the ledger, and core's provider_report check skips this connector (checks.ts).
//
// Auth: SumUp sign-in with Aggregate's OAuth app, offered when SUMUP_CLIENT_ID is set; or, self-hosted, an API key and
// merchant code. Hosted never takes a pasted key. Scopes are always sent, and a sign-in granted more than was asked for is
// refused. Each merchant is its own connection. Access tokens last about an hour and renew on sync; the new pair is saved
// before any read.
//
// Personal data: a history row carries `user` (an email), and payers can show up in other fields. Nothing but the fields in
// types.ts is read, each row is reduced to a month's totals on the spot, and raw holds only those totals. The customers,
// receipts, persons and single-transaction endpoints are never called.
//
// A sync takes one month of payouts per step, then one page of history per step. The cursor holds the running totals, so a
// stop anywhere resumes where it was, and the snapshots come at the end. The first sync reports 24 months; later ones
// recompute RECOMPUTE_MONTHS, because a refund or a status change lands on an old sale.
//
// Shapes are checked row by row: an unknown type or status, a missing amount or a date outside what was asked for stops the
// sync. Two things the docs leave open are guarded here too. The sign of a deduction, fee or refund isn't documented, so
// sizes are kept, and a field that shows both signs stops the sync. And a sale's refunded_amount must be covered by REFUND
// rows, or refunds are going missing.
//
// Built from SumUp's API docs and OpenAPI file. It has not been run against a real account, and the fixtures are hand-built.
// See README.md for what's unverified.

import type { ConnectBegin, ConnectBeginContext, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, ReportSnapshot, SyncResult } from '@agfn/contracts'
import { ConnectorError, cursorCodec, healthFromError, isConnectorError, isRecord, OAuthClient, requireSecret, str, systemClock, type ConnectorDeps, type OAuthTokens } from '@agfn/connector-sdk'
import { createHash } from 'node:crypto'
import { MERCHANT_CODE, PAYOUTS_LIMIT, SUMUP_AUTHORIZE_URL, SUMUP_ROLE_MESSAGE, SUMUP_SCOPES, SUMUP_TOKEN_URL, SumUpClient, unreadable } from './client.ts'
import { addMonths, emptyTotals, exact, isMonthTotals, lastDay, minor, monthRows, splitDays, type MonthTotals } from './month.ts'
import type { SumUpMerchant, SumUpPayout, SumUpTransaction } from './types.ts'

const PROVIDER = 'sumup'
export const BACKFILL_MONTHS = 24
export const RECOMPUTE_MONTHS = 6
const PER_PAGE = 100
/** SumUp's example token lasts 3599 seconds. */
const RENEW_EARLY_MS = 300_000

const DEDUCTIONS: Record<string, keyof MonthTotals> = {
  REFUND_DEDUCTION: 'refundDeductions',
  CHARGE_BACK_DEDUCTION: 'chargebackDeductions',
  DD_RETURN_DEDUCTION: 'otherDeductions',
  BALANCE_DEDUCTION: 'otherDeductions',
}
const PAYOUT_STATUSES = new Set(['SUCCESSFUL', 'FAILED'])
const TRANSACTION_TYPES = new Set(['PAYMENT', 'REFUND', 'CHARGE_BACK'])
/** The sale or refund happened. */
const WENT_THROUGH = new Set(['SUCCESSFUL', 'REFUNDED', 'CHARGE_BACK'])
const DID_NOT = new Set(['PENDING', 'FAILED', 'CANCELLED'])

export type SumUpSecret = { kind: 'oauth'; tokens: OAuthTokens } | { kind: 'key'; apiKey: string }

export interface SumUpConnectorOptions {
  /** Aggregate's SumUp OAuth app. Without it, only a pasted key (self-hosted). */
  oauth?: { clientId: string; clientSecret: string; redirectUri: string }
  /** Hosted service: SumUp sign-in only. */
  hosted?: boolean
}

export const SUMUP_NOT_SET_UP = 'SumUp sign-in isn’t set up on this server yet.'
export const SUMUP_KEY_REFUSED = 'Aggregate connects to SumUp with SumUp sign-in only. A pasted key isn’t accepted here.'
export const SUMUP_KEY_WARNING = 'A SumUp API key has the full permissions of your merchant account, and it can’t be limited. Aggregate only reads. Keep it private, and revoke it in SumUp when you disconnect.'
export const SUMUP_TOO_MUCH_ACCESS = 'SumUp granted more access than Aggregate asked for, so this connection was stopped. Nothing was read.'
export const NOT_REVOKED_OAUTH = 'SumUp documents no way for Aggregate to end this sign-in. Ask SumUp to remove Aggregate’s access.'
export const NOT_REVOKED_KEY = 'In SumUp, go to Settings → For Developers → Toolkit → API Keys and revoke the key.'

interface SumUpCursor {
  /** First month reported this run; null between syncs. */
  first: string | null
  /** Last month of this run. */
  until: string | null
  /** Next month of payouts to read; null once they're all read, and history is walked. */
  month: string | null
  /** Query for the next history page; null on the first. */
  next: Record<string, string> | null
  /** Running totals, keyed "2026-09:USD". */
  totals: Record<string, MonthTotals>
  /** Per currency: what sales say was refunded, against what REFUND rows show. */
  refunds: Record<string, { onSales: number; rows: number }>
  /** The sign each field has shown this run. */
  signs: Record<string, 1 | -1>
  /** Every currency seen, so a recompute can zero one that has left a month. */
  currencies: string[]
  backfilled: boolean
}

const isCursor = (v: unknown): v is SumUpCursor =>
  isRecord(v) &&
  (v.first === null || typeof v.first === 'string') &&
  (v.until === null || typeof v.until === 'string') &&
  (v.month === null || typeof v.month === 'string') &&
  (v.next === null || isRecord(v.next)) &&
  isRecord(v.totals) &&
  Object.values(v.totals).every(isMonthTotals) &&
  isRecord(v.refunds) &&
  isRecord(v.signs) &&
  Array.isArray(v.currencies) &&
  typeof v.backfilled === 'boolean'

const isSecret = (v: unknown): v is SumUpSecret =>
  isRecord(v) && ((v.kind === 'key' && typeof v.apiKey === 'string') || (v.kind === 'oauth' && isRecord(v.tokens) && typeof v.tokens.accessToken === 'string'))

const money = (code: unknown): string => {
  const c = typeof code === 'string' ? code.trim().toUpperCase() : ''
  // A wrong guess here would add one currency's sales to another's.
  if (!/^[A-Z]{3}$/.test(c)) throw unreadable('a record with no currency')
  return c
}

const merchantOf = (conn: ConnectionRef): string => {
  const code = str(conn.config.merchantCode)
  if (!code) throw new ConnectorError('permanent', 'This connection has no SumUp merchant. Connect SumUp again.', { provider: PROVIDER, forUser: true })
  return code
}

/** The size of an amount whose sign SumUp doesn't document. Both signs on one field mean the sizes can't be added up. */
function size(field: string, value: number, signs: SumUpCursor['signs']): number {
  if (value === 0) return 0
  const sign = value > 0 ? 1 : -1
  if ((signs[field] ??= sign) !== sign) throw unreadable('amounts with mixed signs')
  return Math.abs(value)
}

function addPayout(p: SumUpPayout, start: string, end: string, s: SumUpCursor, seen: Set<string>) {
  if (typeof p.status !== 'string' || !PAYOUT_STATUSES.has(p.status)) throw unreadable('a payout status')
  if (typeof p.type !== 'string' || (p.type !== 'PAYOUT' && !(p.type in DEDUCTIONS))) throw unreadable('a payout type')
  if (typeof p.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) throw unreadable('a payout date')
  // Kept, it would count again in the month it belongs to.
  if (p.date < start || p.date > end) throw unreadable('a payout outside the dates asked for')
  const currency = money(p.currency)
  if (p.status === 'FAILED') return
  const t = (s.totals[`${p.date.slice(0, 7)}:${currency}`] ??= emptyTotals())
  seen.add(currency)
  const amount = minor(p.amount, currency)
  if (p.type === 'PAYOUT') {
    if (amount < 0) throw unreadable('a payout below zero')
    t.paidOut = exact(t.paidOut + amount)
    t.fees = exact(t.fees + size('fee', minor(p.fee, currency), s.signs))
    return
  }
  const row = DEDUCTIONS[p.type]!
  t[row] = exact(t[row] + size(p.type, amount, s.signs))
}

function addTransaction(tx: SumUpTransaction, s: SumUpCursor, seen: Set<string>) {
  const { type, status } = tx
  if (typeof type !== 'string' || !TRANSACTION_TYPES.has(type)) throw unreadable('a transaction type')
  if (typeof status !== 'string' || (!WENT_THROUGH.has(status) && !DID_NOT.has(status))) throw unreadable('a transaction status')
  if (DID_NOT.has(status)) return
  const ms = typeof tx.timestamp === 'string' ? Date.parse(tx.timestamp) : NaN
  if (!Number.isFinite(ms)) throw unreadable('a transaction time')
  const month = new Date(ms).toISOString().slice(0, 7)
  if (month < (s.first as string)) throw unreadable('a transaction outside the dates asked for')
  // Made after this run began, in a month it doesn't report. The next run has it.
  if (month > (s.until as string)) return
  const currency = money(tx.currency)
  const cash = tx.payment_type === 'CASH'
  const t = (s.totals[`${month}:${currency}`] ??= emptyTotals())
  seen.add(currency)
  const amount = minor(tx.amount, currency)
  const check = (s.refunds[currency] ??= { onSales: 0, rows: 0 })
  if (type === 'PAYMENT') {
    if (typeof tx.payment_type !== 'string') throw unreadable('a transaction with no payment type')
    if (amount < 0) throw unreadable('a sale below zero')
    if (cash) t.cashSales = exact(t.cashSales + amount)
    else {
      t.sales = exact(t.sales + amount)
      const refunded = tx.refunded_amount === undefined || tx.refunded_amount === null ? 0 : minor(tx.refunded_amount, currency)
      check.onSales = exact(check.onSales + size('refunded_amount', refunded, s.signs))
    }
  } else if (type === 'CHARGE_BACK') {
    t.chargebacks = exact(t.chargebacks + size('CHARGE_BACK', amount, s.signs))
  } else if (!cash) {
    // A cash refund never went through SumUp, the same as a cash sale.
    const refund = size('REFUND', amount, s.signs)
    t.refunds = exact(t.refunds + refund)
    check.rows = exact(check.rows + refund)
  }
}

export interface SumUpConnector extends Connector {
  begin(ctx: Pick<ConnectBeginContext, 'state'>): Promise<ConnectBegin>
}

export function createSumUpConnector(opts: SumUpConnectorOptions, deps: ConnectorDeps): SumUpConnector {
  const clock = deps.clock ?? systemClock
  const codec = cursorCodec<SumUpCursor>(PROVIDER, 1, isCursor)
  const tokenFetch = deps.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init))
  const today = () => new Date(clock.now()).toISOString().slice(0, 10)

  const oauth = opts.oauth
    ? new OAuthClient({
        provider: PROVIDER,
        authorizeUrl: SUMUP_AUTHORIZE_URL,
        tokenUrl: SUMUP_TOKEN_URL,
        clientId: opts.oauth.clientId,
        clientSecret: opts.oauth.clientSecret,
        redirectUri: opts.oauth.redirectUri,
        clientAuth: 'body',
        scopes: [...SUMUP_SCOPES],
        scopeSeparator: ' ',
        fetch: tokenFetch,
        clock,
      })
    : undefined

  const description: ConnectorDescription = {
    key: PROVIDER,
    name: 'SumUp',
    group: 'payments',
    provides: ['reports'],
    freshness: 'updates every few hours',
    auth: oauth ? 'oauth' : 'api_key',
  }

  /** An access token for this connection, renewing a sign-in's first (when asked) if it's close to running out. */
  async function tokenFor(conn: ConnectionRef, renew: boolean): Promise<{ token: string; renewed?: SumUpSecret }> {
    const secret = requireSecret(PROVIDER, conn.secret, isSecret)
    if (secret.kind === 'key') return { token: secret.apiKey }
    if (!oauth) throw new ConnectorError('auth', 'This SumUp connection used Aggregate’s SumUp app, which isn’t set up here. Connect SumUp again.', { provider: PROVIDER, forUser: true })
    if (!renew) return { token: secret.tokens.accessToken }
    const { tokens, refreshed } = await oauth.ensureFresh(secret.tokens, RENEW_EARLY_MS)
    if (!refreshed) return { token: tokens.accessToken }
    const renewed: SumUpSecret = { kind: 'oauth', tokens }
    // Keep the new pair before any read can fail and strand it.
    await deps.saveSecret?.(conn.id, renewed)
    return { token: tokens.accessToken, renewed }
  }

  /** One small read of each endpoint a sync needs. */
  async function probe(client: SumUpClient, merchantCode: string) {
    await client.payouts(merchantCode, today(), today(), 1)
    await client.history(merchantCode, { limit: 1 })
  }

  /** Payouts has no pages. A full answer may be cut short, so the range is halved until each part fits. */
  async function readPayouts(client: SumUpClient, merchantCode: string, start: string, end: string, s: SumUpCursor, seen: Set<string>): Promise<void> {
    const rows = await client.payouts(merchantCode, start, end)
    if (rows.length >= PAYOUTS_LIMIT) {
      if (start === end) throw new ConnectorError('permanent', 'SumUp has more payout records for one day than Aggregate can read, so this sync stopped. No totals were changed.', { provider: PROVIDER, forUser: true })
      for (const [a, b] of splitDays(start, end)) await readPayouts(client, merchantCode, a, b, s, seen)
      return
    }
    for (const p of rows) addPayout(p, start, end, s, seen)
  }

  async function snapshots(conn: ConnectionRef, s: SumUpCursor, currencies: string[]): Promise<ReportSnapshot[]> {
    const out: ReportSnapshot[] = []
    for (let month = s.first as string; month <= (s.until as string); month = addMonths(month, 1)) {
      const end = lastDay(month)
      for (const currency of currencies) {
        const totals = s.totals[`${month}:${currency}`] ?? emptyTotals()
        const externalId = `sumup:${month}:${currency}`
        const rawRef = await deps.raw.put(conn.id, 'sumup.month', externalId, { month, currency, totals })
        out.push({
          type: 'report.snapshot',
          externalId,
          connectionId: conn.id,
          rawRef,
          kind: 'profit_and_loss',
          from: `${month}-01`,
          to: end < today() ? end : today(),
          basis: 'accrual',
          currency,
          rows: monthRows(totals, currency),
        })
      }
    }
    return out
  }

  return {
    describe: () => description,

    async begin(ctx) {
      if (oauth) return { kind: 'oauth', url: oauth.authorizationUrl({ state: ctx.state }) }
      if (opts.hosted) throw new ConnectorError('invalid_input', SUMUP_NOT_SET_UP, { provider: PROVIDER, forUser: true })
      return {
        kind: 'api_key',
        label: 'SumUp API key',
        steps: [
          'Log in to me.sumup.com and open Settings.',
          'Go to For Developers → Toolkit → API Keys.',
          'Create a secret key named “Aggregate” and copy it.',
          'Copy your merchant code too.',
        ],
        permissions: ['SumUp API keys can’t be limited to reading; Aggregate only reads payout and sales totals, and keeps no customer or card details.'],
        helpUrl: 'https://developer.sumup.com/tools/authorization/api-keys/',
        placeholder: '',
        fields: [
          { name: 'merchantCode', label: 'Merchant code', placeholder: 'MH4H92C7' },
          { name: 'apiKey', label: 'Secret API key', secret: true },
        ],
      }
    },

    async connect(input) {
      const code = str(input.code)
      if (code) {
        if (!oauth) throw new ConnectorError('invalid_input', SUMUP_NOT_SET_UP, { provider: PROVIDER, forUser: true })
        const tokens = await oauth.exchangeCode(code)
        if (tokens.scope?.split(/\s+/).some((g) => g && !(SUMUP_SCOPES as readonly string[]).includes(g))) throw new ConnectorError('permanent', SUMUP_TOO_MUCH_ACCESS, { provider: PROVIDER, forUser: true })
        const client = new SumUpClient(tokens.accessToken, deps)
        const merchants = (await client.merchants()).sort((a, b) => a.merchantCode.localeCompare(b.merchantCode))
        if (!merchants.length) throw new ConnectorError('invalid_input', 'This SumUp sign-in doesn’t reach a live merchant account.', { provider: PROVIDER, forUser: true })
        const reachable: SumUpMerchant[] = []
        for (const m of merchants) {
          try {
            await probe(client, m.merchantCode)
            reachable.push(m)
          } catch (e) {
            if (!isConnectorError(e) || e.status !== 403) throw e
          }
        }
        if (!reachable.length) throw new ConnectorError('auth', SUMUP_ROLE_MESSAGE, { provider: PROVIDER, status: 403, forUser: true })
        const secret: SumUpSecret = { kind: 'oauth', tokens }
        const sharedSecretKey = `sumup:${createHash('sha256').update(tokens.refreshToken ?? tokens.accessToken).digest('hex').slice(0, 16)}`
        const [first, ...rest] = reachable.map((m) => ({
          secret,
          config: { merchantCode: m.merchantCode, displayName: `SumUp · ${m.name.slice(0, 80)}`, ...(reachable.length > 1 ? { sharedSecretKey } : {}) },
        }))
        return { ...first!, ...(rest.length ? { additional: rest } : {}) }
      }
      if (opts.hosted) throw new ConnectorError('invalid_input', SUMUP_KEY_REFUSED, { provider: PROVIDER, forUser: true })
      const apiKey = str(input.apiKey)?.trim() ?? ''
      const merchantCode = str(input.merchantCode)?.trim().toUpperCase() ?? ''
      if (apiKey.length < 20 || /\s/.test(apiKey)) throw new ConnectorError('invalid_input', 'That doesn’t look like a SumUp secret API key.', { provider: PROVIDER, forUser: true })
      if (!MERCHANT_CODE.test(merchantCode)) throw new ConnectorError('invalid_input', 'That doesn’t look like a SumUp merchant code, which looks like MH4H92C7.', { provider: PROVIDER, forUser: true })
      await probe(new SumUpClient(apiKey, deps), merchantCode)
      const secret: SumUpSecret = { kind: 'key', apiKey }
      return { secret, config: { merchantCode, warnings: [SUMUP_KEY_WARNING] } }
    },

    async sync(conn, cursor): Promise<SyncResult> {
      const { token, renewed } = await tokenFor(conn, true)
      const client = new SumUpClient(token, deps)
      const merchantCode = merchantOf(conn)
      const extra = renewed ? { updatedSecret: renewed } : {}
      const decoded = codec.decode(cursor)
      const thisMonth = new Date(clock.now()).toISOString().slice(0, 7)
      let s: SumUpCursor
      if (decoded?.first) s = decoded
      else {
        const first = addMonths(thisMonth, 1 - (decoded?.backfilled ? RECOMPUTE_MONTHS : BACKFILL_MONTHS))
        s = { first, until: thisMonth, month: first, next: null, totals: {}, refunds: {}, signs: {}, currencies: decoded?.currencies ?? [], backfilled: decoded?.backfilled ?? false }
      }
      const seen = new Set(s.currencies)

      if (s.month) {
        const month: string = s.month
        await readPayouts(client, merchantCode, `${month}-01`, lastDay(month), s, seen)
        const after = addMonths(month, 1)
        const state: SumUpCursor = { ...s, month: after <= (s.until as string) ? after : null, currencies: [...seen].sort() }
        return { events: [], cursor: codec.encode(state), hasMore: true, ...extra }
      }

      const query = s.next ?? { oldest_time: `${s.first}-01T00:00:00Z`, order: 'ascending', limit: PER_PAGE }
      const page = await client.history(merchantCode, query)
      for (const tx of page.rows) addTransaction(tx, s, seen)
      const currencies = [...seen].sort()
      if (page.next) {
        // The same query again would never end, and would add the same page each time.
        if (JSON.stringify(page.next) === JSON.stringify(s.next)) throw unreadable('a transaction page')
        return { events: [], cursor: codec.encode({ ...s, next: page.next, currencies }), hasMore: true, ...extra }
      }

      for (const [currency, c] of Object.entries(s.refunds)) {
        if (c.rows < c.onSales) throw new ConnectorError('permanent', `SumUp shows refunds on ${currency} sales with no matching refund records, so this sync stopped. No totals were changed.`, { provider: PROVIDER, forUser: true })
      }
      const events: NormalizedEvent[] = await snapshots(conn, s, currencies)
      const idle: SumUpCursor = { first: null, until: null, month: null, next: null, totals: {}, refunds: {}, signs: {}, currencies, backfilled: true }
      return { events, cursor: codec.encode(idle), hasMore: false, ...extra }
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        const secret = requireSecret(PROVIDER, conn.secret, isSecret)
        // Never renews here (a rotated refresh token would have nowhere to go); it renews on the next sync.
        if (secret.kind === 'oauth' && secret.tokens.expiresAt !== undefined && secret.tokens.expiresAt <= clock.now() && secret.tokens.refreshToken) {
          return { status: 'ok', message: 'The access token renews on the next sync.' }
        }
        const { token } = await tokenFor(conn, false)
        await probe(new SumUpClient(token, deps), merchantOf(conn))
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },

    // SumUp documents no call to end a token, so this always says what the person can do.
    async disconnect(conn) {
      const secret = requireSecret(PROVIDER, conn.secret, isSecret)
      return { notRevoked: secret.kind === 'key' ? NOT_REVOKED_KEY : NOT_REVOKED_OAUTH }
    },
  }
}
