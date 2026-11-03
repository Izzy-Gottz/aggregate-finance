// Lightspeed Retail X-Series connector: monthly sales reported by the store, as report.snapshot. Sales reported by the
// store, not booked revenue.
//
// Not emitted, on purpose: no invoice.upsert, no processor.balance_txn, no account.upsert with money, nothing that posts.
// The store's card money arrives through its processor or bank, which Aggregate already books, so posting these would
// double revenue. Decided by the ledger owner; see docs/partners/connector-factory.md. report.snapshot never reaches the
// ledger, and core's provider_report check skips this connector (checks.ts).
//
// Terms: the Lightspeed API License Agreement needs written approval for "transaction data identifying individual items
// purchased", and caps retention at 60 days unless the merchant permits longer. So this keeps monthly totals and nothing
// else. Lightspeed has no sales total endpoint, so totals are added up here from sale records. Each response still carries
// line_items, because no parameter drops them; they're never typed, read or passed to raw, and the page is gone once summed.
//
// Auth: Lightspeed sign-in with Aggregate's app and read scopes, offered when LIGHTSPEED_CLIENT_ID is set. Self-hosted, a
// personal token and the store's domain prefix. Hosted never takes a pasted token. Every token call goes to the store's own
// host, from the domain_prefix on the callback. Refresh tokens rotate, and the old one dies, so the new pair is saved
// before any read.
//
// A sync walks months oldest first, one page per step. The cursor holds the month, the offset and the running totals, so a
// stop anywhere resumes on the next page. The first sync reads 24 months. Later ones recompute the last RECOMPUTE_MONTHS,
// because a sale voided now changes the month it was rung up in. /search is used and not /sales because /sales pages by
// version number with no date filter, and only a full re-read could see a voided sale leave its month.
//
// Built from the Lightspeed X-Series 2026-10 reference. It has not been run against a real store. The docs don't print a
// sale from /search, so the shape is taken from the sale endpoints, and a sale that doesn't match it stops the sync instead
// of counting as zero. Fixtures are hand-built. R-Series is a different API and isn't covered: other host, other auth, other
// resources and no currency on a sale.

import type { ConnectBegin, ConnectBeginContext, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, ReportSnapshot, SyncResult } from '@agfn/contracts'
import { ConnectorError, cursorCodec, healthFromError, isRecord, OAuthClient, requireSecret, str, systemClock, type ConnectorDeps, type OAuthTokens } from '@agfn/connector-sdk'
import { LIGHTSPEED_AUTHORIZE_URL, LIGHTSPEED_REQUIRED_SCOPES, LIGHTSPEED_SCOPES, LightspeedClient, parseDomainPrefix, tokenUrl } from './client.ts'
import { addMonths, addSale, dateIn, emptyTotals, isMonthTotals, lastDay, monthRows, monthStartMs, type MonthTotals } from './month.ts'
import type { LightspeedSale } from './types.ts'

const PROVIDER = 'lightspeed'
export const BACKFILL_MONTHS = 24
export const RECOMPUTE_MONTHS = 6
const PAGE_SIZE = 200
const RENEW_EARLY_MS = 3_600_000

export type LightspeedSecret = { kind: 'oauth'; domainPrefix: string; tokens: OAuthTokens } | { kind: 'token'; domainPrefix: string; accessToken: string }

export interface LightspeedConnectorOptions {
  /** Aggregate's Lightspeed app. Without it, only a pasted token (self-hosted). */
  oauth?: { clientId: string; clientSecret: string; redirectUri: string }
  /** Hosted service: Lightspeed sign-in only. */
  hosted?: boolean
}

export const LIGHTSPEED_NOT_SET_UP = 'Lightspeed sign-in isn’t set up on this server yet.'
export const LIGHTSPEED_TOKEN_REFUSED = 'Aggregate connects to Lightspeed with Lightspeed sign-in only. A pasted token isn’t accepted here.'
export const LIGHTSPEED_TOKEN_WARNING = 'Aggregate can’t see what a pasted Lightspeed token may do. Aggregate only reads. Give it sales:read and retailer:read only, and delete it in Lightspeed when you disconnect.'
export const NOT_REVOKED_OAUTH = 'In Lightspeed Retail, open your connected apps and remove Aggregate.'
export const NOT_REVOKED_TOKEN = 'In Lightspeed Retail, delete the personal token you made for Aggregate.'

interface LightspeedCursor {
  /** Month being read; null between syncs. */
  month: string | null
  /** Last month of this run. */
  until: string | null
  offset: number
  /** Running totals for `month`. */
  totals: MonthTotals
  /** Sale ids on the last page: a row pushed onto this page doesn't count twice. */
  prev: string[]
  currency: string | null
  timeZone: string | null
  backfilled: boolean
}

const isCursor = (v: unknown): v is LightspeedCursor =>
  isRecord(v) &&
  (v.month === null || typeof v.month === 'string') &&
  (v.until === null || typeof v.until === 'string') &&
  typeof v.offset === 'number' &&
  isMonthTotals(v.totals) &&
  Array.isArray(v.prev) &&
  (v.currency === null || typeof v.currency === 'string') &&
  (v.timeZone === null || typeof v.timeZone === 'string') &&
  typeof v.backfilled === 'boolean'

const isSecret = (v: unknown): v is LightspeedSecret =>
  isRecord(v) && typeof v.domainPrefix === 'string' && ((v.kind === 'token' && typeof v.accessToken === 'string') || (v.kind === 'oauth' && isRecord(v.tokens) && typeof v.tokens.accessToken === 'string'))

/** A whole second, in the form Lightspeed's docs show. */
const utc = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

function storeSettings(r: { currency?: { code?: string }; timezone?: string }) {
  const code = String(r.currency?.code ?? '').trim().toUpperCase()
  // Sales carry no currency, so this is the only source, and a guess would mislabel every total.
  if (!/^[A-Z]{3}$/.test(code)) throw new ConnectorError('permanent', 'Lightspeed didn’t say which currency this store uses.', { provider: PROVIDER, forUser: true })
  return { currency: code, timeZone: r.timezone || 'UTC' }
}

export interface LightspeedConnector extends Connector {
  begin(ctx: Pick<ConnectBeginContext, 'state'>): Promise<ConnectBegin>
}

export function createLightspeedConnector(opts: LightspeedConnectorOptions, deps: ConnectorDeps): LightspeedConnector {
  const clock = deps.clock ?? systemClock
  const codec = cursorCodec<LightspeedCursor>(PROVIDER, 1, isCursor)

  /** Token calls go to each store's own host. `begin` uses `secure`, and never makes a token call. */
  const appFor = (domainPrefix: string) => {
    const app = opts.oauth
    if (!app) throw new ConnectorError('invalid_input', LIGHTSPEED_NOT_SET_UP, { provider: PROVIDER, forUser: true })
    return new OAuthClient({
      provider: PROVIDER,
      authorizeUrl: LIGHTSPEED_AUTHORIZE_URL,
      tokenUrl: tokenUrl(domainPrefix),
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      redirectUri: app.redirectUri,
      scopes: LIGHTSPEED_SCOPES,
      clientAuth: 'body',
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      clock,
    })
  }

  const description: ConnectorDescription = {
    key: PROVIDER,
    name: 'Lightspeed',
    group: 'payments',
    provides: ['reports'],
    freshness: 'updates every few hours',
    auth: opts.oauth ? 'oauth' : 'api_key',
  }

  /** A client for this connection, renewing a sign-in's token first (when asked) if it's close to running out. */
  async function clientFor(conn: ConnectionRef, renew: boolean): Promise<{ client: LightspeedClient; renewed?: LightspeedSecret }> {
    const secret = requireSecret(PROVIDER, conn.secret, isSecret)
    if (secret.kind === 'token') return { client: new LightspeedClient(secret.domainPrefix, secret.accessToken, deps) }
    if (!opts.oauth) throw new ConnectorError('auth', 'This Lightspeed connection used Aggregate’s Lightspeed app, which isn’t set up here. Connect Lightspeed again.', { provider: PROVIDER, forUser: true })
    if (!renew) return { client: new LightspeedClient(secret.domainPrefix, secret.tokens.accessToken, deps) }
    const { tokens, refreshed } = await appFor(secret.domainPrefix).ensureFresh(secret.tokens, RENEW_EARLY_MS)
    const client = new LightspeedClient(secret.domainPrefix, tokens.accessToken, deps)
    if (!refreshed) return { client }
    const renewed: LightspeedSecret = { ...secret, tokens }
    // The old refresh token is dead now: keep the new pair before any read can fail and strand it.
    await deps.saveSecret?.(conn.id, renewed)
    return { client, renewed }
  }

  async function monthSnapshot(conn: ConnectionRef, s: LightspeedCursor, month: string, totals: MonthTotals): Promise<ReportSnapshot> {
    const today = dateIn(clock.now(), s.timeZone as string)
    const end = lastDay(month)
    const currency = s.currency as string
    const externalId = `lightspeed:${month}:${currency}`
    const rawRef = await deps.raw.put(conn.id, 'lightspeed.month', externalId, { month, currency, totals })
    return { type: 'report.snapshot', externalId, connectionId: conn.id, rawRef, kind: 'profit_and_loss', from: `${month}-01`, to: end < today ? end : today, basis: 'accrual', currency, rows: monthRows(totals, currency) }
  }

  return {
    describe: () => description,

    async begin(ctx) {
      if (opts.oauth) return { kind: 'oauth', url: appFor('secure').authorizationUrl({ state: ctx.state }) }
      if (opts.hosted) throw new ConnectorError('invalid_input', LIGHTSPEED_NOT_SET_UP, { provider: PROVIDER, forUser: true })
      return {
        kind: 'api_key',
        label: 'Lightspeed Retail personal token',
        steps: [
          'In Lightspeed Retail (X-Series), make a personal token, or a private app’s token, for Aggregate.',
          'Give it sales:read and retailer:read if you’re asked to choose.',
          'Type the first part of your store’s address: yourstore in yourstore.retail.lightspeed.app.',
        ],
        permissions: ['Aggregate reads sale totals, and keeps monthly totals only: no items, no customers. Sales reported by the store, not booked revenue.'],
        helpUrl: 'https://x-series-api.lightspeedhq.com/docs/authorization',
        placeholder: '',
        fields: [
          { name: 'domainPrefix', label: 'Store name', placeholder: 'yourstore' },
          { name: 'accessToken', label: 'Personal token', secret: true },
        ],
      }
    },

    async connect(input) {
      const code = str(input.code)
      if (code) {
        const domainPrefix = parseDomainPrefix(input.domain_prefix)
        const tokens = await appFor(domainPrefix).exchangeCode(code)
        const named = tokens.extra?.domain_prefix
        if (typeof named === 'string' && named.toLowerCase() !== domainPrefix) throw new ConnectorError('permanent', 'Lightspeed’s sign-in named a different store. Connect again.', { provider: PROVIDER, forUser: true })
        const granted = tokens.scope?.split(/\s+/) ?? []
        const missing = tokens.scope === undefined ? [] : LIGHTSPEED_REQUIRED_SCOPES.filter((x) => !granted.includes(x))
        if (missing.length) throw new ConnectorError('invalid_input', `Lightspeed access was granted without ${missing.join(', ')}. Connect again and allow it.`, { provider: PROVIDER, forUser: true })
        if (granted.some((x) => !x.endsWith(':read'))) throw new ConnectorError('invalid_input', 'Lightspeed granted more than read access. Aggregate only connects with read access.', { provider: PROVIDER, forUser: true })
        const { currency } = storeSettings(await new LightspeedClient(domainPrefix, tokens.accessToken, deps).retailer())
        const secret: LightspeedSecret = { kind: 'oauth', domainPrefix, tokens }
        return { secret, config: { domainPrefix, currency, displayName: `Lightspeed · ${domainPrefix}` } }
      }
      if (opts.hosted) throw new ConnectorError('invalid_input', LIGHTSPEED_TOKEN_REFUSED, { provider: PROVIDER, forUser: true })
      const domainPrefix = parseDomainPrefix(input.domainPrefix)
      const accessToken = str(input.accessToken)?.trim() ?? ''
      if (accessToken.length < 20 || /\s/.test(accessToken)) throw new ConnectorError('invalid_input', 'That doesn’t look like a Lightspeed token.', { provider: PROVIDER, forUser: true })
      const { currency } = storeSettings(await new LightspeedClient(domainPrefix, accessToken, deps).retailer())
      const secret: LightspeedSecret = { kind: 'token', domainPrefix, accessToken }
      return { secret, config: { domainPrefix, currency, displayName: `Lightspeed · ${domainPrefix}`, warnings: [LIGHTSPEED_TOKEN_WARNING] } }
    },

    async sync(conn, cursor): Promise<SyncResult> {
      const { client, renewed } = await clientFor(conn, true)
      const extra = renewed ? { updatedSecret: renewed } : {}
      const decoded = codec.decode(cursor)
      let s: LightspeedCursor
      if (decoded?.month) s = decoded
      else {
        const { currency, timeZone } = storeSettings(await client.retailer())
        const thisMonth = dateIn(clock.now(), timeZone).slice(0, 7)
        const backfilled = decoded?.backfilled ?? false
        s = { month: addMonths(thisMonth, 1 - (backfilled ? RECOMPUTE_MONTHS : BACKFILL_MONTHS)), until: thisMonth, offset: 0, totals: emptyTotals(), prev: [], currency, timeZone, backfilled }
      }
      const month = s.month as string
      const start = monthStartMs(month, s.timeZone as string)
      const end = monthStartMs(addMonths(month, 1), s.timeZone as string)
      const page = await client.searchSales({ state: 'closed', date_from: utc(start), date_to: utc(end), order_by: 'date', order_direction: 'asc', page_size: PAGE_SIZE, offset: s.offset })

      const totals = s.totals
      const repeated = new Set(s.prev)
      const ids: string[] = []
      for (const row of page.data) {
        if (!isRecord(row)) throw new ConnectorError('transient', 'Lightspeed sent sale ids where sales were expected', { provider: PROVIDER })
        const sale = row as unknown as LightspeedSale
        const at = Date.parse(sale.date)
        if (!Number.isFinite(at)) throw new ConnectorError('permanent', 'Lightspeed sent a sale Aggregate can’t read.', { provider: PROVIDER, forUser: true })
        ids.push(sale.id)
        if (repeated.has(sale.id) || sale.state !== 'closed' || sale.deleted_at || at < start || at >= end) continue
        addSale(totals, sale.totals, s.currency as string)
      }
      const offset = s.offset + page.data.length
      const more = page.data.length > 0 && (page.page_info?.has_next_page ?? offset < (page.total_count ?? 0))
      if (more) return { events: [], cursor: codec.encode({ ...s, offset, totals, prev: ids }), hasMore: true, ...extra }

      const events: NormalizedEvent[] = [await monthSnapshot(conn, s, month, totals)]
      if (month !== s.until) return { events, cursor: codec.encode({ ...s, month: addMonths(month, 1), offset: 0, totals: emptyTotals(), prev: [] }), hasMore: true, ...extra }
      const idle: LightspeedCursor = { month: null, until: null, offset: 0, totals: emptyTotals(), prev: [], currency: null, timeZone: null, backfilled: true }
      return { events, cursor: codec.encode(idle), hasMore: false, ...extra }
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        const secret = requireSecret(PROVIDER, conn.secret, isSecret)
        // Never renews here (a rotated refresh token would have nowhere to go); it renews on the next sync.
        if (secret.kind === 'oauth' && secret.tokens.expiresAt !== undefined && secret.tokens.expiresAt <= clock.now() && secret.tokens.refreshToken) {
          return { status: 'ok', message: 'The access token renews on the next sync.' }
        }
        const { client } = await clientFor(conn, false)
        await client.retailer()
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },

    // Lightspeed documents no call to end a token here, so this always says where the person ends it.
    async disconnect(conn) {
      const secret = requireSecret(PROVIDER, conn.secret, isSecret)
      return { notRevoked: secret.kind === 'token' ? NOT_REVOKED_TOKEN : NOT_REVOKED_OAUTH }
    },
  }
}
