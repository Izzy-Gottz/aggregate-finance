// Amazon connector (Selling Partner API, Finances v0, US store): each settlement Amazon has paid, as processor rows on an
// Amazon balance per currency. Per settlement (financial event group) one row per category (`<group>#sales`, `#fees`,
// `#refunds`, `#disputes`, `#tax`, `#adjustments`, `#reserve`, `#loan`, `#carried_in`) and one payout row
// (`<group>#payout`, net = −OriginalTotal) that core matches to the bank deposit. Each settlement nets to zero on the
// balance. The categories and how they're read are in settle.ts.
//
// THE CHECK. A settlement's categories must add up to the OriginalTotal Amazon says it paid, to the cent, before any row
// from it is sent. One that doesn't stops the sync with a message, and nothing from it is recorded; settlements already
// recorded stay as they were (each passed its own check). Not an `#unexplained` row: a gap means this connector read
// Amazon's events wrongly somewhere, so its revenue, fees and refunds would all be suspect, and a balancing line would
// let the payout match the bank and hide that. Better no number than a wrong one.
//
// Only closed settlements whose transfer succeeded are recorded. An open one (the balance so far) sends nothing, not even
// a balance: rows for it don't exist yet, so a balance would stand against an empty ledger and show a gap that isn't
// there. Its money is recorded when it closes. A closed one whose transfer hasn't succeeded waits too, with a warning.
//
// Auth: Amazon's website authorization workflow on Aggregate's registered app (Finance and Accounting role only, no
// restricted data). Consent in Seller Central, then Amazon sends the browser to the log-in URI (the server's
// /api/connectors/amazon/login, which answers with amazonLoginRedirect below), then to the callback with
// spapi_oauth_code, exchanged at Login with Amazon for a refresh token (long-lived, not rotated) and a one-hour access
// token. While the app is Draft, every hop carries version=beta (`draft`).
//
// A run lists settlements that opened in the last 35 days (all of the last 540 on the first run; Amazon keeps a group's
// events for two years), one page per step, then reads each new paid settlement's events a page per step with its totals
// in the cursor. Paid settlements already recorded aren't read again. Stored in raw: per-settlement totals only, no order
// ids, SKUs, buyer or bank details.
//
// Built from Amazon's public docs and published models. It has not been run against a real seller account, and the
// fixtures are hand-built. See README.md for what's unverified.

import type { ConnectBegin, ConnectBeginContext, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, ProcessorBalanceTxn, SyncResult } from '@agfn/contracts'
import { ConnectorError, currencyExponent, cursorCodec, healthFromError, isRecord, isoTimestamp, OAuthClient, requireSecret, str, systemClock, type ConnectorDeps, type FetchLike, type OAuthTokens } from '@agfn/connector-sdk'
import { AMAZON_REGION, AmazonClient, LWA_TOKEN_URL, unreadable } from './client.ts'
import { amountIn, emptyTotals, isTotals, Tally, verify, type Totals } from './settle.ts'
import type { AmazonFinancialEventGroup } from './types.ts'

const PROVIDER = 'amazon'
const DAY = 86_400_000
/** Settlements close and transfer days after they open: each run lists the last 35 days again. */
export const OVERLAP_DAYS = 35
/** The first run. Under Amazon's two years of events per group, with room to spare. */
export const BACKFILL_DAYS = 540
const RENEW_EARLY_MS = 300_000

export const NOT_REVOKED = 'In Seller Central, open Apps and Services → Manage Your Apps and choose Disable authorization for Aggregate.'
export const AMAZON_SIGN_IN_ONLY = 'Amazon connects with Amazon sign-in only. Start from Connections → Add → Amazon.'
export const AMAZON_START_HERE = 'Start from Aggregate: Connections → Add → Amazon.'
export const AMAZON_NO_RENEWAL = 'Amazon didn’t give Aggregate a way to keep this connection up to date. Connect Amazon again.'

export interface AmazonConnectorOptions {
  /** Aggregate's registered SP-API app: its application id (not secret) and its LWA client. */
  app: { appId: string; clientId: string; clientSecret: string; redirectUri: string }
  /** The app is in Draft: consent and callback carry version=beta. Off once the app is published. */
  draft: boolean
}

export interface AmazonSecret {
  tokens: OAuthTokens
}

/** A paid settlement waiting to be read, with only what its rows need. */
interface Group {
  id: string
  currency: string
  total: number
  beginning: number
  transferAt: string
  endAt: string
  traceId?: string
}

interface Reading {
  token: string | null
  totals: Totals
}

interface Cycle {
  at: string
  since: string
  token: string | null
  listed: boolean
  /** Every settlement id in this run's listing, so `done` is kept to the window. */
  seen: string[]
  /** Closed settlements whose transfer hasn't succeeded. */
  held: number
}

interface AmazonCursor {
  /** Next run lists settlements that opened at or after this. Null: the first run. */
  hw: string | null
  cycle: Cycle | null
  queue: Group[]
  reading: Reading | null
  /** Settlements recorded already, within the window. */
  done: string[]
  /** Account ids sent already. */
  accounts: string[]
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')
const isGroup = (v: unknown): v is Group =>
  isRecord(v) && ['id', 'currency', 'transferAt', 'endAt'].every((k) => typeof v[k] === 'string') && Number.isSafeInteger(v.total) && Number.isSafeInteger(v.beginning) && (v.traceId === undefined || typeof v.traceId === 'string')
const isCycle = (v: unknown): v is Cycle =>
  isRecord(v) && typeof v.at === 'string' && typeof v.since === 'string' && (v.token === null || typeof v.token === 'string') && typeof v.listed === 'boolean' && isStrings(v.seen) && typeof v.held === 'number'
const isCursor = (v: unknown): v is AmazonCursor =>
  isRecord(v) &&
  (v.hw === null || typeof v.hw === 'string') &&
  (v.cycle === null || isCycle(v.cycle)) &&
  Array.isArray(v.queue) &&
  v.queue.every(isGroup) &&
  (v.reading === null || (isRecord(v.reading) && (v.reading.token === null || typeof v.reading.token === 'string') && isTotals(v.reading.totals))) &&
  isStrings(v.done) &&
  isStrings(v.accounts)
const isSecret = (v: unknown): v is AmazonSecret => isRecord(v) && isRecord(v.tokens) && typeof v.tokens.accessToken === 'string'

export const accountId = (sellerId: string, currency: string) => `amazon:${sellerId}:${currency}`

const SELLER_RE = /^[A-Za-z0-9]{6,32}$/

const day = (iso: string) => new Date(Date.parse(iso)).toISOString().slice(0, 10)

export const amazonSettlementMismatch = (g: Group, events: number) => {
  const exp = currencyExponent(g.currency)
  const m = (minor: number) => `${minor < 0 ? '−' : ''}${(Math.abs(minor) / 10 ** exp).toFixed(exp)} ${g.currency}`
  return `Amazon’s settlement paid on ${day(g.transferAt)} doesn’t add up: its events come to ${m(events)}, but Amazon says it paid ${m(g.total)}. This sync stopped before recording it, so nothing from that settlement was recorded, and the settlements before it are unchanged.`
}
export const amazonHeld = (n: number) => `${n === 1 ? '1 Amazon settlement is' : `${n} Amazon settlements are`} closed but Amazon’s transfer hasn’t succeeded yet. ${n === 1 ? 'It’s' : 'They’re'} recorded once it has.`

/** A listed settlement: one to read (closed, paid), one to hold (closed, not paid), or one to leave (open). */
function readGroup(g: AmazonFinancialEventGroup): { kind: 'paid'; group: Group } | { kind: 'held' | 'open'; id: string } {
  const id = g.FinancialEventGroupId
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(id)) throw unreadable('a settlement')
  if (g.ProcessingStatus === 'Open') return { kind: 'open', id }
  if (g.ProcessingStatus !== 'Closed') throw unreadable('a settlement status')
  if (g.FundTransferStatus !== 'Succeeded') return { kind: 'held', id }
  const t = g.OriginalTotal
  const currency = isRecord(t) && typeof t.CurrencyCode === 'string' && /^[A-Z]{3}$/.test(t.CurrencyCode) ? t.CurrencyCode : null
  if (!currency || t === undefined) throw unreadable('a settlement total')
  const when = (v: unknown, what: string) => {
    if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw unreadable(what)
    return isoTimestamp(v)
  }
  const transferAt = when(g.FundTransferDate, 'a transfer date')
  const endAt = g.FinancialEventGroupEnd === undefined ? transferAt : when(g.FinancialEventGroupEnd, 'a settlement date')
  const traceId = typeof g.TraceId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(g.TraceId) ? g.TraceId : undefined
  return { kind: 'paid', group: { id, currency, total: amountIn(t, currency), beginning: amountIn(g.BeginningBalance, currency), transferAt, endAt, ...(traceId ? { traceId } : {}) } }
}

/**
 * The log-in URI step of Amazon's authorization: Amazon sent the browser here with amazon_callback_uri and amazon_state;
 * it goes back to Amazon's callback with those, the connect attempt's own `state`, the redirect URI, and version=beta while
 * Draft. Null when the callback isn't Amazon's confirm page on https (never an open redirect) or a value is missing.
 */
export function amazonLoginRedirect(query: Record<string, string | undefined>, ctx: { state: string; redirectUri: string; draft: boolean }): string | null {
  const back = query.amazon_callback_uri
  const amazonState = query.amazon_state
  if (!back || !amazonState || !ctx.state) return null
  let u: URL
  try {
    u = new URL(back)
  } catch {
    return null
  }
  // The docs' callback is https://amazon.com/apps/authorize/confirm/<app id>; Seller Central's own host is let through too.
  if (u.protocol !== 'https:' || !['amazon.com', 'www.amazon.com', 'sellercentral.amazon.com'].includes(u.hostname) || u.port || u.username || !u.pathname.startsWith('/apps/authorize/confirm/')) return null
  u.searchParams.set('amazon_state', amazonState)
  u.searchParams.set('state', ctx.state)
  u.searchParams.set('redirect_uri', ctx.redirectUri)
  if (ctx.draft || query.version === 'beta') u.searchParams.set('version', 'beta')
  return u.toString()
}

export interface AmazonConnector extends Connector {
  begin(ctx: Pick<ConnectBeginContext, 'state'>): Promise<ConnectBegin>
  /** See amazonLoginRedirect. */
  loginRedirect(query: Record<string, string | undefined>, state: string): string | null
}

export function createAmazonConnector(opts: AmazonConnectorOptions, deps: ConnectorDeps): AmazonConnector {
  const clock = deps.clock ?? systemClock
  const codec = cursorCodec<AmazonCursor>(PROVIDER, 1, isCursor)
  const baseFetch: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init))

  // The one POST: Login with Amazon's token endpoint, form-encoded, client id and secret in the body (Amazon's docs).
  const oauth = new OAuthClient({
    provider: PROVIDER,
    authorizeUrl: `${AMAZON_REGION.sellerCentral}/apps/authorize/consent`,
    tokenUrl: LWA_TOKEN_URL,
    clientId: opts.app.clientId,
    clientSecret: opts.app.clientSecret,
    redirectUri: opts.app.redirectUri,
    clientAuth: 'body',
    fetch: baseFetch,
    clock,
  })

  const description: ConnectorDescription = {
    key: PROVIDER,
    name: 'Amazon',
    group: 'payments',
    provides: ['transactions'],
    freshness: 'updates every few hours',
    auth: 'oauth',
  }

  const sellerOf = (conn: ConnectionRef): string => {
    const s = str(conn.config.sellerId)
    if (!s || !SELLER_RE.test(s)) throw new ConnectorError('invalid_input', 'connection has no Amazon seller id', { provider: PROVIDER })
    return s
  }

  /** An access token for this connection, renewing it first (when asked) if it's close to running out. */
  async function tokenFor(conn: ConnectionRef, renew: boolean): Promise<{ token: string; renewed?: AmazonSecret }> {
    const secret = requireSecret(PROVIDER, conn.secret, isSecret)
    if (!renew || !oauth.isExpired(secret.tokens, RENEW_EARLY_MS)) return { token: secret.tokens.accessToken }
    const tokens = await oauth.refresh(secret.tokens)
    const renewed: AmazonSecret = { tokens }
    await deps.saveSecret?.(conn.id, renewed)
    return { token: tokens.accessToken, renewed }
  }

  /** One settlement's rows: every non-zero category, any amount carried in, and the payout. */
  function rows(conn: ConnectionRef, sellerId: string, g: Group, t: Totals, carried: number, rawRef: string): ProcessorBalanceTxn[] {
    const cur = g.currency
    const m = (minor: number) => ({ minor: minor === 0 ? 0 : minor, currency: cur })
    const out: ProcessorBalanceTxn[] = []
    const row = (key: string, kind: ProcessorBalanceTxn['kind'], gross: number, fee: number, extra: Partial<ProcessorBalanceTxn> = {}) => {
      if (gross === 0 && fee === 0) return
      out.push({ type: 'processor.balance_txn', externalId: `${g.id}#${key}`, connectionId: conn.id, rawRef, accountExternalId: accountId(sellerId, cur), at: g.endAt, kind, gross: m(gross), fee: m(fee), net: m(gross - fee), payoutExternalId: g.id, ...extra })
    }
    row('sales', 'charge', t.sales, 0)
    // Fees are signed into the balance (a charge is negative); `fee` is the positive cost.
    row('fees', 'fee', 0, -t.fees)
    row('refunds', 'refund', t.refunds, -t.refundFees)
    row('disputes', 'dispute', t.disputes, -t.disputeFees)
    row('tax', 'adjustment', t.tax, 0, { salesTax: true })
    row('adjustments', 'adjustment', t.adjustments, 0)
    row('reserve', 'adjustment', t.reserve, 0, { balanceRole: 'other_assets' })
    row('loan', 'adjustment', t.loan, 0, { balanceRole: 'other_liabilities' })
    // Carried in from the settlement before (README, Unverified): held back there as a reserve, so an asset again.
    row('carried_in', 'adjustment', carried, 0, { balanceRole: 'other_assets' })
    // The payout: out of the balance, to the bank (a negative total is Amazon charging the seller, so money in). Dated the
    // transfer’s start, and arrivalDate the same day: core then looks up to 10 days ahead for a deposit naming Amazon.
    if (g.total !== 0) {
      out.push({
        type: 'processor.balance_txn',
        externalId: `${g.id}#payout`,
        connectionId: conn.id,
        rawRef,
        accountExternalId: accountId(sellerId, cur),
        at: g.transferAt,
        kind: 'payout',
        gross: m(-g.total),
        fee: m(0),
        net: m(-g.total),
        payoutExternalId: g.id,
        arrivalDate: day(g.transferAt),
        ...(g.traceId ? { linkRefs: { trace_id: g.traceId } } : {}),
      })
    }
    return out
  }

  return {
    describe: () => description,

    async begin(ctx) {
      // Amazon's consent URL takes only the app id and state (and version=beta while Draft); the redirect URI is the one
      // registered with the app, sent back at the log-in step.
      const u = new URL(`${AMAZON_REGION.sellerCentral}/apps/authorize/consent`)
      u.searchParams.set('application_id', opts.app.appId)
      u.searchParams.set('state', ctx.state)
      if (opts.draft) u.searchParams.set('version', 'beta')
      return { kind: 'oauth', url: u.toString() }
    },

    loginRedirect: (query, state) => amazonLoginRedirect(query, { state, redirectUri: opts.app.redirectUri, draft: opts.draft }),

    async connect(input) {
      const code = str(input.spapi_oauth_code)
      if (!code) throw new ConnectorError('invalid_input', AMAZON_SIGN_IN_ONLY, { provider: PROVIDER, forUser: true })
      const sellerId = str(input.selling_partner_id)
      if (!sellerId || !SELLER_RE.test(sellerId)) throw unreadable('a seller id')
      const tokens = await oauth.exchangeCode(code)
      if (!tokens.refreshToken) throw new ConnectorError('permanent', AMAZON_NO_RENEWAL, { provider: PROVIDER, forUser: true })
      // One harmless read: the role reaches the seller's settlements.
      await new AmazonClient(tokens.accessToken, { ...deps, fetch: baseFetch }).groups(new Date(clock.now() - 7 * DAY).toISOString(), null)
      const secret: AmazonSecret = { tokens }
      return { secret, config: { sellerId, marketplaceId: AMAZON_REGION.marketplaceId, displayName: 'Amazon' } }
    },

    async sync(conn, cursor): Promise<SyncResult> {
      const sellerId = sellerOf(conn)
      const { token, renewed } = await tokenFor(conn, true)
      const extra = renewed ? { updatedSecret: renewed } : {}
      const client = new AmazonClient(token, { ...deps, fetch: baseFetch })
      const s: AmazonCursor = codec.decode(cursor) ?? { hw: null, cycle: null, queue: [], reading: null, done: [], accounts: [] }
      const step = (next: AmazonCursor, events: NormalizedEvent[] = []): SyncResult => ({ events, cursor: codec.encode(next), hasMore: true, ...extra })

      const now = clock.now()
      const cycle: Cycle = s.cycle ?? { at: isoTimestamp(now), since: s.hw ?? new Date(now - BACKFILL_DAYS * DAY).toISOString(), token: null, listed: false, seen: [], held: 0 }

      // A paid settlement's events, a page per step.
      const g = s.queue[0]
      if (g) {
        const page = await client.events(g.id, s.reading?.token ?? null)
        const tally = new Tally(g.currency, s.reading?.totals ?? emptyTotals())
        tally.addEvents(page.events)
        if (page.nextToken) return step({ ...s, cycle, reading: { token: page.nextToken, totals: tally.t } })
        const verdict = verify(tally.t, g.total, g.beginning)
        if (!verdict.ok) throw new ConnectorError('permanent', amazonSettlementMismatch(g, verdict.events), { provider: PROVIDER, forUser: true })
        const events: NormalizedEvent[] = []
        const rawRef = await deps.raw.put(conn.id, 'amazon.settlement', g.id, { settlement: { ...g, carriedIn: verdict.beginning }, totals: tally.t })
        const acct = accountId(sellerId, g.currency)
        const accounts = s.accounts.includes(acct) ? s.accounts : [...s.accounts, acct].sort()
        if (accounts !== s.accounts) {
          events.push({ type: 'account.upsert', externalId: acct, connectionId: conn.id, rawRef, name: `Amazon (${g.currency})`, accountType: 'processor_balance', currency: g.currency, institution: 'Amazon', businessHint: 'business' })
        }
        events.push(...rows(conn, sellerId, g, tally.t, verdict.beginning, rawRef))
        return step({ ...s, cycle, queue: s.queue.slice(1), reading: null, done: [...s.done, g.id], accounts }, events)
      }

      // The settlement list, a page per step.
      if (!cycle.listed) {
        const page = await client.groups(cycle.since, cycle.token)
        const queue = [...s.queue]
        const seen = [...cycle.seen]
        let held = cycle.held
        for (const raw of page.groups) {
          const r = readGroup(raw)
          const id = r.kind === 'paid' ? r.group.id : r.id
          if (seen.includes(id)) continue
          seen.push(id)
          if (r.kind === 'held') held++
          if (r.kind === 'paid' && !s.done.includes(id)) queue.push(r.group)
        }
        return step({ ...s, queue, cycle: { ...cycle, token: page.nextToken, listed: page.nextToken === null, seen, held } })
      }

      // Done: the next run lists the last 35 days again, from when this one started.
      const hw = new Date(Date.parse(cycle.at) - OVERLAP_DAYS * DAY).toISOString()
      const next: AmazonCursor = { hw, cycle: null, queue: [], reading: null, done: s.done.filter((id) => cycle.seen.includes(id)), accounts: s.accounts }
      return { events: [], cursor: codec.encode(next), hasMore: false, ...(cycle.held ? { warnings: [amazonHeld(cycle.held)] } : {}), ...extra }
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        const secret = requireSecret(PROVIDER, conn.secret, isSecret)
        // Never renews here: the renewed token would have nowhere to go. It renews on the next sync.
        if (secret.tokens.expiresAt !== undefined && secret.tokens.expiresAt <= clock.now() && secret.tokens.refreshToken) return { status: 'ok', message: 'The access token renews on the next sync.' }
        const { token } = await tokenFor(conn, false)
        await new AmazonClient(token, { ...deps, fetch: baseFetch }).groups(new Date(clock.now() - 7 * DAY).toISOString(), null)
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },

    // Amazon has no call to end an authorization: only the seller can, in Seller Central (Revoke Authorizations).
    async disconnect() {
      return { notRevoked: NOT_REVOKED }
    },
  }
}
