// Gumroad connector (read-only): the seller's USD balance from sales (charges with Gumroad's fee and the affiliate's
// cut, refunds, chargebacks) and payouts, which bank deposits match like any processor's.
//
// Auth: Gumroad sign-in with Aggregate's OAuth app (scopes view_sales + view_payouts only; Gumroad's tokens don't
// expire), or, self-hosted without an app, a token the seller generates on their own Gumroad application. That token
// carries every scope Gumroad offers (it could edit products and refund sales), so hosted never accepts one.
//
// A sync cycle is: user (the balance account) → sales (newest first, 10 per page_key page) → payouts → done. Sales have
// no updated-since filter, so incremental cycles re-read sales made in the 90 days before the previous cycle's newest
// sale (refunds and chargebacks of older sales are only picked up by a full re-sync), and payouts from 35 days back.

import type { ConnectBegin, ConnectBeginContext, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, SyncResult } from '@agfn/contracts'
import {
  ConnectorError,
  OAuthClient,
  cursorCodec,
  healthFromError,
  isRecord,
  requireSecret,
  str,
  systemClock,
  type ConnectorDeps,
} from '@agfn/connector-sdk'
import { GUMROAD_AUTHORIZE_URL, GUMROAD_SCOPES, GUMROAD_TOKEN_URL, GumroadClient } from './client.ts'
import { mapAccount, mapPayout, mapSaleCharge, mapSaleChargeback, mapSaleRefund, refundedMinor } from './map.ts'
import type { GumroadPayoutsPage, GumroadSalesPage, GumroadUser } from './types.ts'

export interface GumroadSecret {
  kind: 'oauth' | 'token'
  accessToken: string
}

export interface GumroadConfig {
  sellerId: string
  sellerName?: string
  warnings: string[]
}

export interface GumroadConnectorOptions {
  deps: ConnectorDeps
  /** Aggregate's Gumroad OAuth app. Without it, only a pasted token (self-hosted). */
  oauth?: { clientId: string; clientSecret: string; redirectUri: string }
  /** Hosted service: Gumroad sign-in only (read-only scopes). */
  hosted?: boolean
  /** How far back incremental syncs re-read sales to catch refunds. Default 90 days. */
  refundWindowDays?: number
}

export const GUMROAD_TOKEN_WARNING =
  'A token generated on your own Gumroad application has full access (it could also edit products and refund sales). Aggregate only reads; keep it private and delete the application in Gumroad when you disconnect.'
export const GUMROAD_TOKEN_REFUSED =
  'Aggregate connects to Gumroad with Gumroad sign-in only, which gives it read-only access. A generated access token has full access, so it isn’t accepted here.'
export const GUMROAD_NOT_SET_UP = 'Gumroad sign-in isn’t set up on this server yet.'

/** Per-sync warnings (final page of a cycle). */
export const gumroadPartialRefundWarning = (n: number) =>
  `${n} partly refunded ${n === 1 ? 'sale wasn’t' : 'sales weren’t'} in USD, so the refunded amount couldn’t be read; ${n === 1 ? 'it is' : 'they are'} still counted at full price.`
export const gumroadPayoutCurrencyWarning = (n: number) =>
  `${n} Gumroad ${n === 1 ? 'payout was' : 'payouts were'} paid in another currency and ${n === 1 ? 'isn’t' : 'aren’t'} recorded yet; match ${n === 1 ? 'it' : 'them'} in your bank feed.`

interface GrCursor {
  stage: 'user' | 'sales' | 'payouts'
  key: string | null
  /** Newest sale created_at from the previous completed cycle (null = full backfill). */
  since: string | null
  /** Newest sale created_at seen this cycle. */
  hwm: string | null
  seller: string
  /** Partly refunded non-USD sales seen this cycle; non-USD payouts seen this cycle. */
  pr: number
  fx: number
}

const DAY = 86_400_000
const PAYOUT_OVERLAP_DAYS = 35

const isCursor = (v: unknown): v is GrCursor =>
  isRecord(v) && (v.stage === 'user' || v.stage === 'sales' || v.stage === 'payouts') && typeof v.seller === 'string' && typeof v.pr === 'number' && typeof v.fx === 'number'

const isSecret = (v: unknown): v is GumroadSecret =>
  isRecord(v) && typeof v.accessToken === 'string' && v.accessToken.length >= 10 && (v.kind === 'oauth' || v.kind === 'token')

const fresh = (since: string | null): GrCursor => ({ stage: 'user', key: null, since, hwm: since, seller: '', pr: 0, fx: 0 })

/** YYYY-MM-DD `days` before an ISO timestamp. */
const dayBefore = (iso: string, days: number) => new Date(Date.parse(iso) - days * DAY).toISOString().slice(0, 10)

export interface GumroadConnector extends Connector {
  begin(ctx: ConnectBeginContext): Promise<ConnectBegin>
}

export function createGumroadConnector(opts: GumroadConnectorOptions): GumroadConnector {
  const { deps } = opts
  const clock = deps.clock ?? systemClock
  const codec = cursorCodec<GrCursor>('gumroad', 1, isCursor)
  const windowDays = opts.refundWindowDays ?? 90

  const oauth = opts.oauth
    ? new OAuthClient({
        provider: 'gumroad',
        authorizeUrl: GUMROAD_AUTHORIZE_URL,
        tokenUrl: GUMROAD_TOKEN_URL,
        clientId: opts.oauth.clientId,
        clientSecret: opts.oauth.clientSecret,
        redirectUri: opts.oauth.redirectUri,
        scopes: GUMROAD_SCOPES,
        scopeSeparator: ' ',
        clientAuth: 'body',
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        clock,
      })
    : undefined

  const description: ConnectorDescription = {
    key: 'gumroad',
    name: 'Gumroad',
    group: 'payments',
    provides: ['transactions', 'balances'],
    freshness: 'updates every few hours',
    auth: oauth ? 'oauth' : 'api_key',
  }

  const clientFor = (conn: ConnectionRef) => new GumroadClient(requireSecret('gumroad', conn.secret, isSecret).accessToken, deps)

  async function userPage(conn: ConnectionRef, client: GumroadClient, s: GrCursor): Promise<SyncResult> {
    const res = await client.get<{ user?: GumroadUser }>('/v2/user')
    const seller = String(res.user?.user_id ?? res.user?.id ?? conn.config.sellerId ?? '')
    if (!seller) throw new ConnectorError('permanent', 'Gumroad did not return the seller', { provider: 'gumroad' })
    const rawRef = await deps.raw.put(conn.id, 'gumroad.user', seller, { user_id: seller, name: res.user?.name ?? null })
    const event = mapAccount(seller, res.user?.name ?? str(conn.config.sellerName) ?? undefined, conn.id, rawRef)
    return { events: [event], cursor: codec.encode({ ...s, stage: 'sales', key: null, seller }), hasMore: true }
  }

  async function salesPage(conn: ConnectionRef, client: GumroadClient, s: GrCursor): Promise<SyncResult> {
    const res = await client.get<GumroadSalesPage>('/v2/sales', {
      ...(s.key ? { page_key: s.key } : {}),
      ...(s.since ? { after: dayBefore(s.since, windowDays) } : {}),
    })
    // A present object with `sales` omitted/empty is a real empty page; a null/non-object body (an empty body, or the
    // sign-in/error page the shared client rejects as non-JSON) is unreadable and must stop, never read as zero sales.
    if (!isRecord(res)) throw new ConnectorError('transient', 'Gumroad sent a response Aggregate couldn’t read, so this sync stopped. No totals were changed.', { provider: 'gumroad' })
    const events: NormalizedEvent[] = []
    let hwm = s.hwm
    let pr = s.pr
    for (const sale of res.sales ?? []) {
      if (!hwm || sale.created_at > hwm) hwm = sale.created_at
      const rawRef = await deps.raw.put(conn.id, 'gumroad.sale', sale.id, sale)
      const charge = mapSaleCharge(sale, s.seller, conn.id, rawRef)
      if (charge) events.push(charge)
      const refund = mapSaleRefund(sale, s.seller, conn.id, rawRef)
      if (refund) events.push(refund)
      else if (refundedMinor(sale) === undefined) pr++
      const chargeback = mapSaleChargeback(sale, s.seller, conn.id, rawRef)
      if (chargeback) events.push(chargeback)
    }
    const next = res.next_page_key && (res.sales ?? []).length > 0 ? res.next_page_key : null
    const cur: GrCursor = next ? { ...s, key: next, hwm, pr } : { ...s, stage: 'payouts', key: null, hwm, pr }
    return { events, cursor: codec.encode(cur), hasMore: true }
  }

  async function payoutsPage(conn: ConnectionRef, client: GumroadClient, s: GrCursor): Promise<SyncResult> {
    const res = await client.get<GumroadPayoutsPage>('/v2/payouts', {
      include_upcoming: 'false',
      ...(s.key ? { page_key: s.key } : {}),
      ...(s.since ? { after: dayBefore(s.since, PAYOUT_OVERLAP_DAYS) } : {}),
    })
    if (!isRecord(res)) throw new ConnectorError('transient', 'Gumroad sent a response Aggregate couldn’t read, so this sync stopped. No totals were changed.', { provider: 'gumroad' })
    const events: NormalizedEvent[] = []
    let fx = s.fx
    for (const p of res.payouts ?? []) {
      if (!p.id) continue
      const rawRef = await deps.raw.put(conn.id, 'gumroad.payout', p.id, p)
      const ev = mapPayout(p, s.seller, conn.id, rawRef)
      if (ev) events.push(ev)
      else if ((p.currency ?? '').toUpperCase() !== 'USD') fx++
    }
    const next = res.next_page_key && (res.payouts ?? []).length > 0 ? res.next_page_key : null
    if (next) return { events, cursor: codec.encode({ ...s, key: next, fx }), hasMore: true }
    const warnings = [...(s.pr > 0 ? [gumroadPartialRefundWarning(s.pr)] : []), ...(fx > 0 ? [gumroadPayoutCurrencyWarning(fx)] : [])]
    return { events, cursor: codec.encode(fresh(s.hwm)), hasMore: false, ...(warnings.length ? { warnings } : {}) }
  }

  return {
    describe: () => description,

    async begin(ctx) {
      if (oauth) return { kind: 'oauth', url: oauth.authorizationUrl({ state: ctx.state }) }
      if (opts.hosted) throw new ConnectorError('invalid_input', GUMROAD_NOT_SET_UP, { provider: 'gumroad', forUser: true })
      return {
        kind: 'api_key',
        label: 'Gumroad access token',
        steps: [
          'Sign in to Gumroad and open Settings → Advanced.',
          'Under Applications, create an application named “Aggregate” (any redirect URI, e.g. http://localhost).',
          'Open it, click Generate access token, and paste the token here.',
        ],
        permissions: ['Gumroad tokens can’t be limited to reading; Aggregate only reads your sales and payouts.'],
        helpUrl: 'https://app.gumroad.com/settings/advanced',
        placeholder: 'Access token',
      }
    },

    async connect(input) {
      const code = str(input.code)
      const pasted = str(input.accessToken)?.trim() ?? str(input.apiKey)?.trim()
      let secret: GumroadSecret
      const warnings: string[] = []
      if (code) {
        if (!oauth) throw new ConnectorError('invalid_input', GUMROAD_NOT_SET_UP, { provider: 'gumroad', forUser: true })
        const t = await oauth.exchangeCode(code)
        secret = { kind: 'oauth', accessToken: t.accessToken }
      } else if (pasted) {
        if (opts.hosted) throw new ConnectorError('invalid_input', GUMROAD_TOKEN_REFUSED, { provider: 'gumroad', forUser: true })
        if (pasted.length < 10 || /\s/.test(pasted)) throw new ConnectorError('invalid_input', 'that does not look like a Gumroad access token', { provider: 'gumroad' })
        secret = { kind: 'token', accessToken: pasted }
        warnings.push(GUMROAD_TOKEN_WARNING)
      } else {
        throw new ConnectorError('invalid_input', 'code (Gumroad sign-in) or accessToken is required', { provider: 'gumroad' })
      }
      const me = await new GumroadClient(secret.accessToken, deps).get<{ user?: GumroadUser }>('/v2/user')
      const sellerId = String(me.user?.user_id ?? me.user?.id ?? '')
      if (!sellerId) throw new ConnectorError('permanent', 'Gumroad did not return the seller', { provider: 'gumroad' })
      const config: GumroadConfig = { sellerId, warnings, ...(me.user?.name ? { sellerName: me.user.name.slice(0, 80) } : {}) }
      return { secret, config: { ...config } }
    },

    async sync(conn, cursor) {
      const client = clientFor(conn)
      const s = codec.decode(cursor) ?? fresh(null)
      const page = s.stage === 'user' ? await userPage(conn, client, s) : s.stage === 'sales' ? await salesPage(conn, client, s) : await payoutsPage(conn, client, s)
      // A generated token has full access: say so on the connection after every full sync.
      const secret = conn.secret as Partial<GumroadSecret> | null
      return secret?.kind === 'token' && !page.hasMore ? { ...page, warnings: [...(page.warnings ?? []), GUMROAD_TOKEN_WARNING] } : page
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        await clientFor(conn).get('/v2/user')
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },
  }
}
