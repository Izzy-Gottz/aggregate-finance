// Harvest connector (time tracking and invoicing): monthly invoiced and paid amounts per currency, as report.snapshot.
// What was billed in Harvest, not booked revenue.
//
// Not emitted, on purpose: no invoice.upsert, no payment.applied, no account.upsert with money, nothing that posts. Harvest
// invoices are often also in QuickBooks or Xero, their money arrives in the bank, and invoices aren't linked across
// connections, so posting these would double revenue. Decided by the ledger owner; see docs/partners/connector-factory.md.
// report.snapshot never reaches the ledger, and core's provider_report check skips this connector (checks.ts).
//
// Auth: Harvest sign-in with Aggregate's OAuth app, offered when HARVEST_CLIENT_ID is set; or, self-hosted, a personal
// access token and account id. Hosted never takes a pasted token. Harvest has no read-only scope, so read-only rests on
// client.ts, where anything but a GET throws. Each Harvest account is its own connection. Access tokens last 14 days and
// renew a day early on sync, and the new pair is saved before any read.
//
// Harvest's invoice list always carries the client, line items, subject and notes, and its payments carry who recorded
// them. None of that is read into a type or passed to raw: only the month's totals are kept.
//
// A sync walks invoices newest first, one page per step, and reads the payments of each invoice on the page as it goes. The
// cursor holds the running totals for every month in the run, so a stop anywhere resumes on the next page and the
// snapshots come at the end. The first sync reports 24 months. Later ones recompute the last RECOMPUTE_MONTHS, because a
// payment recorded now can land on an old invoice. Payments are only listed per invoice, so the walk reaches back
// LOOKBACK_MONTHS before the first reported month to catch late payments on older invoices. A payment on an invoice older
// than that isn't seen.
//
// Built from the Harvest API v2 docs. It has not been run against a real account, and the fixtures are hand-built.

import type { ConnectBegin, ConnectBeginContext, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, ReportSnapshot, SyncResult } from '@agfn/contracts'
import { ConnectorError, cursorCodec, healthFromError, isConnectorError, isRecord, OAuthClient, requireSecret, str, systemClock, type ConnectorDeps, type FetchLike, type OAuthTokens } from '@agfn/connector-sdk'
import { createHash } from 'node:crypto'
import { HARVEST_AUTHORIZE_URL, HARVEST_ROLE_MESSAGE, HARVEST_TOKEN_URL, HarvestClient, harvestAccounts, withUserAgent } from './client.ts'
import { addMonths, emptyTotals, exact, isMonthTotals, lastDay, minor, monthRows, type MonthTotals } from './month.ts'
import type { HarvestAccount, HarvestInvoice, HarvestPayment } from './types.ts'

const PROVIDER = 'harvest'
export const BACKFILL_MONTHS = 24
export const RECOMPUTE_MONTHS = 6
export const LOOKBACK_MONTHS = 12
/** Payments are read per invoice, so a small page keeps one step's calls in bounds. */
const PER_PAGE = 100
const RENEW_EARLY_MS = 86_400_000
/** Invoices that went out. */
const COUNTED_STATES = new Set(['open', 'paid', 'closed'])

export type HarvestSecret = { kind: 'oauth'; tokens: OAuthTokens } | { kind: 'token'; accessToken: string }

export interface HarvestConnectorOptions {
  /** Aggregate's Harvest OAuth app. Without it, only a pasted token (self-hosted). */
  oauth?: { clientId: string; clientSecret: string; redirectUri: string }
  /** Hosted service: Harvest sign-in only. */
  hosted?: boolean
}

export const HARVEST_NOT_SET_UP = 'Harvest sign-in isn’t set up on this server yet.'
export const HARVEST_TOKEN_REFUSED = 'Aggregate connects to Harvest with Harvest sign-in only. A pasted token isn’t accepted here.'
export const HARVEST_TOKEN_WARNING = 'A Harvest personal access token has the same access you do, and it can’t be limited. Aggregate only reads. Keep it private, and revoke it in Harvest ID when you disconnect.'
export const NOT_REVOKED_OAUTH = 'In Harvest ID, open Security and sign out Aggregate.'
export const NOT_REVOKED_TOKEN = 'In Harvest ID, open Developers and revoke the personal access token.'

interface HarvestCursor {
  /** First month reported this run; null between syncs. */
  first: string | null
  /** Last month of this run. */
  until: string | null
  /** Query for the next page; null on a run's first page. */
  next: Record<string, string> | null
  /** Running totals, keyed "2026-09:USD". */
  totals: Record<string, MonthTotals>
  /** Invoice ids on the last page: a row pushed onto this page by a new invoice doesn't count twice. */
  prev: number[]
  /** Every currency seen, so a recompute can zero one that has left a month. */
  currencies: string[]
  backfilled: boolean
}

const isCursor = (v: unknown): v is HarvestCursor =>
  isRecord(v) &&
  (v.first === null || typeof v.first === 'string') &&
  (v.until === null || typeof v.until === 'string') &&
  (v.next === null || isRecord(v.next)) &&
  isRecord(v.totals) &&
  Object.values(v.totals).every(isMonthTotals) &&
  Array.isArray(v.prev) &&
  Array.isArray(v.currencies) &&
  typeof v.backfilled === 'boolean'

const isSecret = (v: unknown): v is HarvestSecret =>
  isRecord(v) && ((v.kind === 'token' && typeof v.accessToken === 'string') || (v.kind === 'oauth' && isRecord(v.tokens) && typeof v.tokens.accessToken === 'string'))

const money = (code: unknown): string => {
  const c = typeof code === 'string' ? code.trim().toUpperCase() : ''
  // A wrong guess here would add one currency's invoices to another's.
  if (!/^[A-Z]{3}$/.test(c)) throw new ConnectorError('permanent', 'Harvest sent an invoice with no currency.', { provider: PROVIDER, forUser: true })
  return c
}

const accountOf = (conn: ConnectionRef): string => {
  const id = str(conn.config.accountId)
  if (!id) throw new ConnectorError('permanent', 'This connection has no Harvest account. Connect Harvest again.', { provider: PROVIDER, forUser: true })
  return id
}

export interface HarvestConnector extends Connector {
  begin(ctx: Pick<ConnectBeginContext, 'state'>): Promise<ConnectBegin>
}

export function createHarvestConnector(opts: HarvestConnectorOptions, deps: ConnectorDeps): HarvestConnector {
  const clock = deps.clock ?? systemClock
  const codec = cursorCodec<HarvestCursor>(PROVIDER, 1, isCursor)
  const tokenFetch: FetchLike = withUserAgent(deps.fetch ?? ((input, init) => fetch(input, init)))

  const oauth = opts.oauth
    ? new OAuthClient({
        provider: PROVIDER,
        authorizeUrl: HARVEST_AUTHORIZE_URL,
        tokenUrl: HARVEST_TOKEN_URL,
        clientId: opts.oauth.clientId,
        clientSecret: opts.oauth.clientSecret,
        redirectUri: opts.oauth.redirectUri,
        clientAuth: 'body',
        fetch: tokenFetch,
        clock,
      })
    : undefined

  const description: ConnectorDescription = {
    key: PROVIDER,
    name: 'Harvest',
    group: 'accounting',
    provides: ['reports'],
    freshness: 'updates every few hours',
    auth: oauth ? 'oauth' : 'api_key',
  }

  /** An access token for this connection, renewing a sign-in's first (when asked) if it's close to running out. */
  async function tokenFor(conn: ConnectionRef, renew: boolean): Promise<{ token: string; renewed?: HarvestSecret }> {
    const secret = requireSecret(PROVIDER, conn.secret, isSecret)
    if (secret.kind === 'token') return { token: secret.accessToken }
    if (!oauth) throw new ConnectorError('auth', 'This Harvest connection used Aggregate’s Harvest app, which isn’t set up here. Connect Harvest again.', { provider: PROVIDER, forUser: true })
    if (!renew) return { token: secret.tokens.accessToken }
    const { tokens, refreshed } = await oauth.ensureFresh(secret.tokens, RENEW_EARLY_MS)
    if (!refreshed) return { token: tokens.accessToken }
    const renewed: HarvestSecret = { kind: 'oauth', tokens }
    // Keep the new pair before any read can fail and strand it.
    await deps.saveSecret?.(conn.id, renewed)
    return { token: tokens.accessToken, renewed }
  }

  const probe = (client: HarvestClient) => client.page('/invoices', 'invoices', { per_page: 1 })

  /** Could this invoice have a payment inside the run? Each yes costs at least one call. */
  function hasPaymentsToRead(i: HarvestInvoice, firstDay: string): boolean {
    if (!COUNTED_STATES.has(i.state)) return false
    const currency = money(i.currency)
    if (minor(i.amount, currency) === minor(i.due_amount, currency)) return false
    return !(i.state === 'paid' && i.paid_date && i.paid_date < firstDay)
  }

  async function addPayments(client: HarvestClient, invoice: HarvestInvoice, currency: string, add: (month: string) => MonthTotals | undefined) {
    let query: Record<string, string | number> = { per_page: 2000 }
    for (;;) {
      const page = await client.page<HarvestPayment>(`/invoices/${invoice.id}/payments`, 'invoice_payments', query)
      for (const p of page.rows) {
        const month = (p.paid_date ?? p.paid_at ?? '').slice(0, 7)
        const t = add(month)
        if (t) t.paid = exact(t.paid + minor(p.amount, currency))
      }
      if (!page.next) return
      query = page.next
    }
  }

  async function snapshots(conn: ConnectionRef, s: HarvestCursor, currencies: string[]): Promise<ReportSnapshot[]> {
    const today = new Date(clock.now()).toISOString().slice(0, 10)
    const out: ReportSnapshot[] = []
    for (let month = s.first as string; month <= (s.until as string); month = addMonths(month, 1)) {
      const end = lastDay(month)
      for (const currency of currencies) {
        const totals = s.totals[`${month}:${currency}`] ?? emptyTotals()
        const externalId = `harvest:${month}:${currency}`
        const rawRef = await deps.raw.put(conn.id, 'harvest.month', externalId, { month, currency, totals })
        out.push({
          type: 'report.snapshot',
          externalId,
          connectionId: conn.id,
          rawRef,
          kind: 'profit_and_loss',
          from: `${month}-01`,
          to: end < today ? end : today,
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
      // Harvest takes no scope here: it comes from the app's own setting.
      if (oauth) return { kind: 'oauth', url: oauth.authorizationUrl({ state: ctx.state }) }
      if (opts.hosted) throw new ConnectorError('invalid_input', HARVEST_NOT_SET_UP, { provider: PROVIDER, forUser: true })
      return {
        kind: 'api_key',
        label: 'Harvest personal access token',
        steps: [
          'Sign in to Harvest ID and open Developers.',
          'Create a personal access token named “Aggregate”.',
          'Copy the token and the account ID shown with it.',
        ],
        permissions: ['Harvest tokens can’t be limited to reading; Aggregate only reads invoice and payment totals, and keeps no client names or line items.'],
        helpUrl: 'https://help.getharvest.com/api-v2/authentication-api/authentication/authentication/',
        placeholder: '',
        fields: [
          { name: 'accountId', label: 'Account ID', placeholder: '123456' },
          { name: 'accessToken', label: 'Personal access token', secret: true },
        ],
      }
    },

    async connect(input) {
      const code = str(input.code)
      if (code) {
        if (!oauth) throw new ConnectorError('invalid_input', HARVEST_NOT_SET_UP, { provider: PROVIDER, forUser: true })
        const tokens = await oauth.exchangeCode(code)
        const reachable: HarvestAccount[] = []
        const accounts = (await harvestAccounts(tokens.accessToken, deps)).sort((a, b) => a.id - b.id)
        if (!accounts.length) throw new ConnectorError('invalid_input', 'This Harvest sign-in doesn’t reach a Harvest account.', { provider: PROVIDER, forUser: true })
        for (const a of accounts) {
          try {
            await probe(new HarvestClient(tokens.accessToken, String(a.id), deps))
            reachable.push(a)
          } catch (e) {
            if (!isConnectorError(e) || e.status !== 403) throw e
          }
        }
        if (!reachable.length) throw new ConnectorError('auth', HARVEST_ROLE_MESSAGE, { provider: PROVIDER, status: 403, forUser: true })
        const secret: HarvestSecret = { kind: 'oauth', tokens }
        const sharedSecretKey = `harvest:${createHash('sha256').update(tokens.refreshToken ?? tokens.accessToken).digest('hex').slice(0, 16)}`
        const [first, ...rest] = reachable.map((a) => ({
          secret,
          config: { accountId: String(a.id), displayName: `Harvest · ${String(a.name).slice(0, 80)}`, ...(reachable.length > 1 ? { sharedSecretKey } : {}) },
        }))
        return { ...first!, ...(rest.length ? { additional: rest } : {}) }
      }
      if (opts.hosted) throw new ConnectorError('invalid_input', HARVEST_TOKEN_REFUSED, { provider: PROVIDER, forUser: true })
      const accessToken = str(input.accessToken)?.trim() ?? ''
      const accountId = str(input.accountId)?.trim() ?? ''
      if (accessToken.length < 20 || /\s/.test(accessToken)) throw new ConnectorError('invalid_input', 'That doesn’t look like a Harvest personal access token.', { provider: PROVIDER, forUser: true })
      if (!/^\d+$/.test(accountId)) throw new ConnectorError('invalid_input', 'The Harvest account ID is a number, shown with your token.', { provider: PROVIDER, forUser: true })
      await probe(new HarvestClient(accessToken, accountId, deps))
      const secret: HarvestSecret = { kind: 'token', accessToken }
      return { secret, config: { accountId, warnings: [HARVEST_TOKEN_WARNING] } }
    },

    async sync(conn, cursor): Promise<SyncResult> {
      const { token, renewed } = await tokenFor(conn, true)
      const client = new HarvestClient(token, accountOf(conn), deps)
      const extra = renewed ? { updatedSecret: renewed } : {}
      const decoded = codec.decode(cursor)
      const thisMonth = new Date(clock.now()).toISOString().slice(0, 7)
      const s: HarvestCursor = decoded?.first
        ? decoded
        : { first: addMonths(thisMonth, 1 - (decoded?.backfilled ? RECOMPUTE_MONTHS : BACKFILL_MONTHS)), until: thisMonth, next: null, totals: {}, prev: [], currencies: decoded?.currencies ?? [], backfilled: decoded?.backfilled ?? false }
      const first = s.first as string
      const until = s.until as string
      const firstDay = `${first}-01`

      const query = s.next ?? { from: `${addMonths(first, -LOOKBACK_MONTHS)}-01`, per_page: PER_PAGE }
      const page = await client.page<HarvestInvoice>('/invoices', 'invoices', query)
      const totals: Record<string, MonthTotals> = s.totals
      const seen = new Set(s.currencies)
      const repeated = new Set(s.prev)
      for (const i of page.rows) {
        if (repeated.has(i.id) || !COUNTED_STATES.has(i.state)) continue
        const currency = money(i.currency)
        const inRun = (month: string) => {
          if (month < first || month > until) return undefined
          seen.add(currency)
          return (totals[`${month}:${currency}`] ??= emptyTotals())
        }
        const t = inRun((i.issue_date ?? '').slice(0, 7))
        if (t) {
          t.invoiced = exact(t.invoiced + minor(i.amount, currency))
          t.tax = exact(t.tax + minor(i.tax_amount, currency) + minor(i.tax2_amount, currency))
        }
        if (hasPaymentsToRead(i, firstDay)) await addPayments(client, i, currency, inRun)
      }
      const currencies = [...seen].sort()

      if (page.next) return { events: [], cursor: codec.encode({ ...s, next: page.next, totals, prev: page.rows.map((i) => i.id), currencies }), hasMore: true, ...extra }

      const events: NormalizedEvent[] = await snapshots(conn, { ...s, totals }, currencies)
      const idle: HarvestCursor = { first: null, until: null, next: null, totals: {}, prev: [], currencies, backfilled: true }
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
        await probe(new HarvestClient(token, accountOf(conn), deps))
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },

    // Harvest documents no call to end a token, so this always says where the person ends it.
    async disconnect(conn) {
      const secret = requireSecret(PROVIDER, conn.secret, isSecret)
      return { notRevoked: secret.kind === 'token' ? NOT_REVOKED_TOKEN : NOT_REVOKED_OAUTH }
    },
  }
}
