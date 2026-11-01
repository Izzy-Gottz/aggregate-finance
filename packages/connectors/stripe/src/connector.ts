// Stripe connector: one connection = one Stripe account (optionally a Connect account read through Stripe-Account).
// Read-only. Emits processor balances, every balance transaction (with payout attribution), invoices and subscriptions.
//
// A sync cycle is a sequence of stages, one Stripe list page per sync() call:
//   balance       GET /v1/balance → account.upsert + balance.snapshot per currency
//   txns          GET /v1/balance_transactions?created[gte]=hw−3d (expand data.source for the customer id)
//   payouts       GET /v1/payouts?status=paid&arrival_date[gte]=hw−3d → queue of automatic payouts
//   payout_txns   GET /v1/balance_transactions?payout=po_... per queued payout → rows re-emitted with payoutExternalId
//   invoices      GET /v1/invoices?created[gte]=hw−3d
//   open_invoices GET /v1/invoices?status=open (re-scan: amount_paid / status changes on older invoices)
//   closed_check  GET /v1/invoices/:id for invoices that were draft/open last cycle and aren't any more (paid/void/...)
//   subs          GET /v1/subscriptions?status=all (full scan every cycle: status changes have no created filter)
// The cycle's high-water marks are committed only when it finishes, so a crash mid-cycle re-reads from the old marks.
// Re-emitted rows are harmless: events are idempotent by externalId.
//
// Bank matching (S1): a payout's processor row has externalId = payoutExternalId = the payout id (po_...), net = −amount.
// The settled charges/refunds/fees carry payoutExternalId = po_... too. A bank connector that exposes the processor
// payout id puts it in the deposit's linkRefs.payout_id (exact match). Otherwise S1 matches fuzzily: bank deposit
// amount = −payout net, same currency, bank date within a few days of the payout's arrival_date, memo like "STRIPE".

import type {
  ConnectBegin,
  ConnectBeginContext,
  Connector,
  ConnectionRef,
  ConnectorDescription,
  ConnectorHealth,
  NormalizedEvent,
  SyncResult,
} from '@agfn/contracts'
import {
  ConnectorError,
  HttpClient,
  cursorCodec,
  healthFromError,
  isConnectorError,
  isRecord,
  isoTimestamp,
  normalizeCurrency,
  requireSecret,
  str,
  systemClock,
  type Clock,
  type ConnectorDeps,
  type ConnectorWebhook,
  type HttpRequest,
} from '@agfn/connector-sdk'
import { StripeClient, StripeError, type StripeCredentials } from './client.ts'
import { balanceAccountId, balanceByCurrency, idOf, mapAccount, mapBalance, mapBalanceTxn, mapInvoice, mapSubscription } from './map.ts'
import { discountCoupon, subscriptionHistory, subscriptionMrr } from './mrr.ts'
import type {
  StripeAccount,
  StripeBalance,
  StripeBalanceTransaction,
  StripeCoupon,
  StripeCustomer,
  StripeDiscount,
  StripeInvoice,
  StripeInvoiceLine,
  StripeList,
  StripePayout,
  StripeSubscription,
  StripeSubscriptionItem,
} from './types.ts'
import { stripeWebhook } from './webhook.ts'

export interface StripeSecret {
  /** A restricted/secret key the owner pasted, or (kind 'oauth') a Stripe Apps access token used the same way. */
  apiKey: string
  kind?: 'oauth'
  /** OAuth: one-year refresh token, replaced on every refresh. */
  refreshToken?: string
  /** OAuth: ISO expiry of `apiKey` (about one hour). */
  expiresAt?: string
  /**
   * OAuth: whether the install is live or test mode, from the token response. Picks which of our keys refreshes it.
   * Secrets saved before this field existed refresh with the live key (`appSecretKey`), as they always did.
   */
  livemode?: boolean
}

export interface StripeConfig {
  accountId: string
  displayName: string
  defaultCurrency?: string
  livemode: boolean
  keyType: 'restricted' | 'secret' | 'oauth'
  /** A restricted key that Stripe let through to refunds or payouts (checked at connect with a request that can't succeed). */
  canWrite?: boolean
  /** Set when a platform key reads a connected account (Stripe-Account header). */
  stripeAccount?: string
  warnings: string[]
}

export interface StripeConnectorOptions {
  /** Webhook endpoint signing secret(s) (whsec_...). Without one, `webhook` is omitted. */
  webhookSecret?: string | string[]
  /** For a direct (non-Connect) webhook endpoint: the account it belongs to (events then carry no `account`). */
  webhookAccountId?: string
  /** Page size for list calls (max 100). */
  pageSize?: number
  /** Days re-read behind each high-water mark (default 3). */
  overlapDays?: number
  /**
   * Stripe Apps OAuth (hosted one-click sign-in): the app's client id (ca_...) and OUR OWN Stripe secret keys, which
   * authenticate the token exchange. Stripe wants the key for the same mode as the install: `appSecretKey` (sk_live_)
   * for live installs, `appTestSecretKey` (sk_test_) for test-mode ones. Without a client id and at least one key,
   * people paste a restricted key.
   */
  appClientId?: string
  appSecretKey?: string
  appTestSecretKey?: string
  /**
   * Install link base, from the app's External test tab (a test-mode or sandbox link) while the app is unpublished:
   * https://marketplace.stripe.com/oauth/v2/<chnlink_…>/authorize. Its query is replaced by ours. Default: the public
   * link, which works only once the app is published.
   */
  appAuthorizeUrl?: string
  /** Hosted service: only read-only access is accepted (a restricted key or the Aggregate app; never sk_). */
  hosted?: boolean
}

/** Shown when a full-access secret key is pasted on the hosted service. */
export const STRIPE_SECRET_KEY_REFUSED =
  'Aggregate only accepts read-only Stripe access. A secret key (sk_…) can also move money, so make a restricted key instead: in Stripe open Developers → API keys → Create restricted key, name it “Aggregate”, set Read on Balance, Balance transaction sources, Payouts, Invoices, Subscriptions, Coupons and Customers (leave everything else at None), then paste the rk_… key here.'
/** On the connection while it uses a full-access key: hosted (switch) and self-hosted (advice). */
export const STRIPE_FULL_ACCESS_HOSTED_WARNING =
  'This Stripe connection uses a full-access secret key (sk_…). Aggregate only reads, but it now accepts only read-only access: reconnect Stripe with a restricted key set to Read.'
export const STRIPE_FULL_ACCESS_WARNING =
  'This is a full-access Stripe secret key (sk_…). Aggregate only reads, but a restricted key set to Read only (rk_…) is safer: reconnect with one.'
export const STRIPE_KEY_CAN_WRITE_WARNING =
  'This restricted Stripe key can also make refunds or payouts. Aggregate only reads: in Stripe (Developers → API keys) set everything except the Read permissions to None.'

export interface StripeConnector extends Connector {
  begin(ctx: ConnectBeginContext): Promise<ConnectBegin>
  readonly client: StripeClient
  /** Present when opts.webhookSecret is set. match.field is 'accountId'. */
  readonly webhook?: ConnectorWebhook
}

type Stage = 'balance' | 'txns' | 'payouts' | 'payout_txns' | 'invoices' | 'open_invoices' | 'closed_check' | 'subs'
const STAGES: readonly Stage[] = ['balance', 'txns', 'payouts', 'payout_txns', 'invoices', 'open_invoices', 'closed_check', 'subs']

/** Unix seconds. 0 = never synced (full backfill). */
interface Marks {
  txn: number
  payout: number
  inv: number
}

interface StripeCursor {
  stage: Stage
  /** starting_after for the current list. */
  after: string | null
  /** High-water marks committed at the end of the last finished cycle. */
  hw: Marks
  /** Max seen so far in this cycle. */
  seen: Marks
  /** Currencies whose account.upsert has been emitted (as account externalIds' currency part). */
  cur: string[]
  /** Payouts list continuation; null once the payouts list is exhausted. */
  pAfter: string | null
  /** Automatic paid payouts whose balance transactions still need attributing. */
  queue: string[]
  /** Invoices that were draft/open at the end of the last cycle. */
  watch: string[]
  /** Invoices seen draft/open in this cycle. */
  nowWatch: string[]
  /** closed_check work list. */
  check: string[]
}

const isMarks = (v: unknown): v is Marks =>
  isRecord(v) && typeof v.txn === 'number' && typeof v.payout === 'number' && typeof v.inv === 'number'
const isStrs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')
const isNullableStr = (v: unknown) => v === null || typeof v === 'string'

const isStripeCursor = (v: unknown): v is StripeCursor =>
  isRecord(v) &&
  STAGES.includes(v.stage as Stage) &&
  isNullableStr(v.after) &&
  isMarks(v.hw) &&
  isMarks(v.seen) &&
  isStrs(v.cur) &&
  isNullableStr(v.pAfter) &&
  isStrs(v.queue) &&
  isStrs(v.watch) &&
  isStrs(v.nowWatch) &&
  isStrs(v.check)

const isStripeSecret = (v: unknown): v is StripeSecret =>
  isRecord(v) && typeof v.apiKey === 'string' && (v.kind === 'oauth' ? v.apiKey !== '' : /^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(v.apiKey))

const STRIPE_AUTHORIZE = 'https://marketplace.stripe.com/oauth/v2/authorize'

/** A configured install link (External test tab), reduced to its path on Stripe's marketplace; anything else is ignored. */
export function authorizeBase(configured: string | undefined): string {
  if (!configured) return STRIPE_AUTHORIZE
  try {
    const u = new URL(configured)
    if (u.protocol !== 'https:' || u.host !== 'marketplace.stripe.com' || !/^\/oauth\/v2\/(?:[A-Za-z0-9_]+\/)?authorize$/.test(u.pathname)) return STRIPE_AUTHORIZE
    return `${u.origin}${u.pathname}`
  } catch {
    return STRIPE_AUTHORIZE
  }
}
/** Refresh this long before the access token expires. */
const REFRESH_EARLY_MS = 5 * 60_000

interface StripeOAuthToken {
  access_token: string
  refresh_token?: string
  stripe_user_id?: string
  livemode?: boolean
  expires_in?: number
}

const KEY_RE = /^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/
const ACCT_RE = /^acct_[A-Za-z0-9_]+$/
/** Cap on tracked draft/open invoices kept in the cursor (older ones are still caught by the open re-scan). */
const WATCH_CAP = 2000
const CLOSED_CHECK_BATCH = 20

const isPermissionMissing = (e: unknown): e is StripeError => e instanceof StripeError && e.code === 'permission_missing'

/** Per-sync warning when a restricted key can't read an optional resource. */
export const skippedWarning = (what: string, e: StripeError): string =>
  `Stripe ${what} were skipped: the restricted key is missing Read access${e.permission ? ` (${e.permission})` : ''}.`
export const STRIPE_COUPONS_WARNING = "Stripe coupons couldn't be read with this restricted key, so MRR leaves out those discounts."
export const STRIPE_TIERS_WARNING = "Stripe tiered prices couldn't be read with this key, so MRR leaves out subscription items on tiered prices."

function fresh(): StripeCursor {
  const zero = { txn: 0, payout: 0, inv: 0 }
  return { stage: 'balance', after: null, hw: zero, seen: zero, cur: [], pAfter: null, queue: [], watch: [], nowWatch: [], check: [] }
}

export function createStripeConnector(opts: StripeConnectorOptions, deps: ConnectorDeps): StripeConnector {
  const client = new StripeClient(deps)
  const clock: Clock = deps.clock ?? systemClock
  const codec = cursorCodec<StripeCursor>('stripe', 1, isStripeCursor)
  const limit = Math.min(100, Math.max(1, opts.pageSize ?? 100))
  const overlap = Math.max(0, opts.overlapDays ?? 3) * 86_400
  const secrets = opts.webhookSecret === undefined ? [] : (Array.isArray(opts.webhookSecret) ? opts.webhookSecret : [opts.webhookSecret]).filter(Boolean)

  const description: ConnectorDescription = {
    key: 'stripe',
    name: 'Stripe',
    group: 'payments',
    provides: ['balances', 'transactions', 'invoices'],
    freshness: secrets.length ? 'updates within minutes via webhooks' : 'updates every few hours',
    auth: opts.appClientId && (opts.appSecretKey || opts.appTestSecretKey) ? 'oauth' : 'api_key',
    // 1: charges and refunds name the customer (not its cus_ id); 2: subscriptions carry their MRR history and rows
    // Stripe's description. Existing connections re-read once.
    dataVersion: 2,
  }

  const oauthReady = !!(opts.appClientId && (opts.appSecretKey || opts.appTestSecretKey))
  const oauthHttp = new HttpClient({
    provider: 'stripe',
    baseUrl: 'https://api.stripe.com',
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    clock,
    classifyError: ({ status, body }) => {
      const b = (isRecord(body) ? body : {}) as { error?: unknown; error_description?: unknown }
      const code = typeof b.error === 'string' ? b.error : undefined
      const msg = typeof b.error_description === 'string' ? b.error_description : `Stripe OAuth HTTP ${status}`
      return new ConnectorError(code === 'invalid_grant' || status === 401 ? 'auth' : status >= 500 ? 'transient' : 'invalid_input', msg, { provider: 'stripe', status, ...(code ? { code } : {}) })
    },
  })
  const notConfigured = () => new ConnectorError('invalid_input', 'Stripe sign-in is not configured on this server', { provider: 'stripe' })
  /** POST /v1/oauth/token, authenticated with one of our own Stripe keys (Stripe Apps). Not retried: codes are single-use. */
  async function oauthToken(form: Record<string, string>, key: string | undefined): Promise<StripeSecret & { accountId?: string }> {
    if (!key) throw notConfigured()
    const res = await oauthHttp.request<StripeOAuthToken>({
      method: 'POST',
      path: '/v1/oauth/token',
      form,
      headers: { authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
      idempotent: false,
    })
    const t = res.data
    if (!t?.access_token) throw new ConnectorError('permanent', 'Stripe token response has no access_token', { provider: 'stripe' })
    return {
      kind: 'oauth',
      apiKey: t.access_token,
      ...(t.refresh_token ? { refreshToken: t.refresh_token } : {}),
      expiresAt: new Date(clock.now() + (t.expires_in ?? 3600) * 1000).toISOString(),
      ...(t.stripe_user_id ? { accountId: t.stripe_user_id } : {}),
      ...(typeof t.livemode === 'boolean' ? { livemode: t.livemode } : {}),
    }
  }
  /**
   * Exchange an install code. We can't tell the install's mode before the exchange, so try the live key first and,
   * if Stripe refuses it and a test key is configured, the test key once. A refused exchange doesn't use up the code.
   */
  async function exchangeCode(code: string): Promise<StripeSecret & { accountId?: string }> {
    const form = { grant_type: 'authorization_code', code }
    const primary = opts.appSecretKey ?? opts.appTestSecretKey
    const usedTest = (key: string | undefined) => key !== undefined && key === opts.appTestSecretKey && key !== opts.appSecretKey
    const withMode = (t: StripeSecret & { accountId?: string }, key: string | undefined) =>
      t.livemode === undefined && usedTest(key) ? { ...t, livemode: false } : t
    try {
      return withMode(await oauthToken(form, primary), primary)
    } catch (e) {
      const refused = isConnectorError(e) && e.status !== undefined && e.status >= 400 && e.status < 500 && e.status !== 429
      if (!refused || !opts.appTestSecretKey || primary === opts.appTestSecretKey) throw e
      return withMode(await oauthToken(form, opts.appTestSecretKey), opts.appTestSecretKey)
    }
  }
  /** Our key for an install's mode. Secrets without `livemode` predate it and were always refreshed with the live key. */
  const appKeyFor = (livemode: boolean | undefined) => (livemode === false ? opts.appTestSecretKey : (opts.appSecretKey ?? opts.appTestSecretKey))
  const tokenExpired = (sec: StripeSecret) => sec.kind === 'oauth' && !!sec.expiresAt && Date.parse(sec.expiresAt) <= clock.now()
  /** A sign-in token close to expiry is refreshed first; the new one (and its rotated refresh token) is saved. */
  async function freshSecret(conn: ConnectionRef): Promise<StripeSecret | undefined> {
    const sec = secretOf(conn)
    if (sec.kind !== 'oauth' || !sec.refreshToken || !sec.expiresAt) return undefined
    if (Date.parse(sec.expiresAt) - clock.now() > REFRESH_EARLY_MS) return undefined
    const { accountId: _a, ...next } = await oauthToken({ grant_type: 'refresh_token', refresh_token: sec.refreshToken }, appKeyFor(sec.livemode))
    const livemode = next.livemode ?? sec.livemode
    return { ...next, ...(next.refreshToken ? {} : { refreshToken: sec.refreshToken }), ...(livemode === undefined ? {} : { livemode }) }
  }

  const secretOf = (conn: ConnectionRef) => requireSecret('stripe', conn.secret, isStripeSecret)
  /** Every finished sync of a connection with more than read access says so on the connection, until it's switched. */
  const withAccessWarning = (conn: ConnectionRef, page: SyncResult): SyncResult => {
    if (page.hasMore) return page
    const w = conn.config.keyType === 'secret' ? (opts.hosted ? STRIPE_FULL_ACCESS_HOSTED_WARNING : STRIPE_FULL_ACCESS_WARNING) : conn.config.canWrite === true ? STRIPE_KEY_CAN_WRITE_WARNING : undefined
    return w ? { ...page, warnings: [...(page.warnings ?? []), w] } : page
  }
  const configOf = (conn: ConnectionRef) => {
    const accountId = str(conn.config.accountId)
    if (!accountId) throw new ConnectorError('permanent', 'connection has no Stripe accountId; reconnect it', { provider: 'stripe' })
    const stripeAccount = str(conn.config.stripeAccount)
    return { accountId, displayName: str(conn.config.displayName) ?? accountId, ...(stripeAccount ? { stripeAccount } : {}) }
  }
  const credsOf = (conn: ConnectionRef): StripeCredentials => {
    const { apiKey } = secretOf(conn)
    const { stripeAccount } = configOf(conn)
    return { apiKey, ...(stripeAccount ? { stripeAccount } : {}) }
  }
  const since = (mark: number) => (mark > 0 ? Math.max(0, mark - overlap) : undefined)
  const page = (after: string | null): HttpRequest['query'] => ({ limit, ...(after ? { starting_after: after } : {}) })

  /** Emit account.upsert for a currency first seen on a transaction (e.g. a currency with no balance today). */
  async function ensureAccount(conn: ConnectionRef, state: StripeCursor, currency: string, events: NormalizedEvent[]) {
    const cur = normalizeCurrency(currency)
    if (state.cur.includes(cur)) return
    const { accountId, displayName } = configOf(conn)
    const rawRef = await deps.raw.put(conn.id, 'stripe.balance_currency', balanceAccountId(accountId, cur), { accountId, currency: cur })
    events.push(mapAccount(accountId, displayName, cur, conn.id, rawRef))
    state.cur = [...state.cur, cur].sort()
  }

  // Customer names for charges and refunds (Customers: Read). Without that permission the payment's own details are used.
  const customerNames = new Map<string, string>()
  let customersBlocked = false
  async function nameCustomers(conn: ConnectionRef, rows: StripeBalanceTransaction[]): Promise<void> {
    if (customersBlocked) return
    const ids = [...new Set(rows.map((t) => (typeof t.source === 'object' && t.source ? idOf(t.source.customer) : undefined)).filter((x): x is string => !!x && !customerNames.has(x)))]
    for (const id of ids.slice(0, 100)) {
      try {
        const c = await client.get<StripeCustomer>(credsOf(conn), `/v1/customers/${encodeURIComponent(id)}`)
        const name = c.deleted ? undefined : (c.name?.trim() || c.email?.trim())
        customerNames.set(id, name ?? '')
      } catch (e) {
        if (isPermissionMissing(e) || (e instanceof StripeError && e.status === 403)) {
          customersBlocked = true
          return
        }
        if (e instanceof StripeError && e.status === 404) customerNames.set(id, '')
        else throw e
      }
    }
  }

  async function emitTxns(conn: ConnectionRef, state: StripeCursor, rows: StripeBalanceTransaction[], settledBy?: string) {
    const { accountId } = configOf(conn)
    const events: NormalizedEvent[] = []
    await nameCustomers(conn, rows)
    for (const t of rows) {
      await ensureAccount(conn, state, t.currency, events)
      const rawRef = await deps.raw.put(conn.id, 'stripe.balance_transaction', t.id, t)
      events.push(mapBalanceTxn(t, accountId, conn.id, rawRef, settledBy, customerNames))
    }
    return events
  }

  const next = (state: StripeCursor, events: NormalizedEvent[], patch: Partial<StripeCursor>): SyncResult => {
    const s: StripeCursor = { ...state, ...patch }
    return { events, cursor: codec.encode(s), hasMore: true }
  }

  async function balanceStage(conn: ConnectionRef, state: StripeCursor): Promise<SyncResult> {
    const creds = credsOf(conn)
    const { accountId, displayName } = configOf(conn)
    const at = isoTimestamp(clock.now())
    const b = await client.get<StripeBalance>(creds, '/v1/balance')
    const events: NormalizedEvent[] = []
    const cur: string[] = []
    for (const row of balanceByCurrency(b)) {
      const acct = balanceAccountId(accountId, row.currency)
      const rawRef = await deps.raw.put(conn.id, 'stripe.balance', acct, b)
      events.push(mapAccount(accountId, displayName, row.currency, conn.id, rawRef))
      events.push(mapBalance(accountId, row, conn.id, rawRef, at))
      cur.push(row.currency)
    }
    return next(state, events, { stage: 'txns', after: null, cur: cur.sort() })
  }

  async function txnsStage(conn: ConnectionRef, state: StripeCursor): Promise<SyncResult> {
    const from = since(state.hw.txn)
    const d = await client.get<StripeList<StripeBalanceTransaction>>(credsOf(conn), '/v1/balance_transactions', {
      ...page(state.after),
      ...(from !== undefined ? { 'created[gte]': from } : {}),
      'expand[]': ['data.source'],
    })
    const s = { ...state }
    const events = await emitTxns(conn, s, d.data)
    const seen = { ...s.seen, txn: Math.max(s.seen.txn, ...d.data.map((t) => t.created)) }
    const last = d.data.at(-1)
    if (d.has_more && last) return next(s, events, { seen, after: last.id })
    return next(s, events, { seen, stage: 'payouts', after: null, pAfter: null, queue: [] })
  }

  async function payoutsStage(conn: ConnectionRef, state: StripeCursor): Promise<SyncResult> {
    const from = since(state.hw.payout)
    const d = await client.get<StripeList<StripePayout>>(credsOf(conn), '/v1/payouts', {
      ...page(state.pAfter),
      status: 'paid',
      ...(from !== undefined ? { 'arrival_date[gte]': from } : {}),
    })
    const queue: string[] = []
    for (const p of d.data) {
      await deps.raw.put(conn.id, 'stripe.payout', p.id, p)
      // Stripe only lists the settled transactions of automatic payouts (?payout= filter).
      if (p.automatic) queue.push(p.id)
    }
    const seen = { ...state.seen, payout: Math.max(state.seen.payout, ...d.data.map((p) => p.arrival_date)) }
    const last = d.data.at(-1)
    const pAfter = d.has_more && last ? last.id : null
    return next(state, [], { seen, pAfter, queue, after: null, stage: queue.length ? 'payout_txns' : pAfter ? 'payouts' : 'invoices' })
  }

  async function payoutTxnsStage(conn: ConnectionRef, state: StripeCursor): Promise<SyncResult> {
    const [payout, ...rest] = state.queue
    if (!payout) return next(state, [], { stage: state.pAfter ? 'payouts' : 'invoices', after: null })
    const d = await client.get<StripeList<StripeBalanceTransaction>>(credsOf(conn), '/v1/balance_transactions', {
      ...page(state.after),
      payout,
      'expand[]': ['data.source'],
    })
    const s = { ...state }
    const events = await emitTxns(conn, s, d.data, payout)
    const last = d.data.at(-1)
    if (d.has_more && last) return next(s, events, { after: last.id })
    const stage: Stage = rest.length ? 'payout_txns' : s.pAfter ? 'payouts' : 'invoices'
    return next(s, events, { queue: rest, after: null, stage })
  }

  async function fullLines(creds: StripeCredentials, inv: StripeInvoice): Promise<StripeInvoiceLine[]> {
    const lines = [...inv.lines.data]
    let more = inv.lines.has_more
    while (more) {
      const last = lines.at(-1)
      const d = await client.get<StripeList<StripeInvoiceLine>>(creds, `/v1/invoices/${encodeURIComponent(inv.id)}/lines`, page(last?.id ?? null))
      lines.push(...d.data)
      more = d.has_more && d.data.length > 0
    }
    return lines
  }

  async function emitInvoices(conn: ConnectionRef, state: StripeCursor, invoices: StripeInvoice[]) {
    const creds = credsOf(conn)
    const events: NormalizedEvent[] = []
    let watch = state.nowWatch
    for (const inv of invoices) {
      const lines = await fullLines(creds, inv)
      const rawRef = await deps.raw.put(conn.id, 'stripe.invoice', inv.id, { ...inv, lines: { ...inv.lines, data: lines, has_more: false } })
      events.push(mapInvoice(inv, lines, conn.id, rawRef))
      if ((inv.status === 'draft' || inv.status === 'open') && !watch.includes(inv.id)) watch = [...watch, inv.id]
    }
    return { events, nowWatch: watch }
  }

  async function invoicesStage(conn: ConnectionRef, state: StripeCursor): Promise<SyncResult> {
    const from = since(state.hw.inv)
    const d = await client.get<StripeList<StripeInvoice>>(credsOf(conn), '/v1/invoices', {
      ...page(state.after),
      ...(from !== undefined ? { 'created[gte]': from } : {}),
      // The payments that paid each invoice, so its charge settles it instead of counting as new revenue.
      'expand[]': ['data.payments'],
    })
    const { events, nowWatch } = await emitInvoices(conn, state, d.data)
    const seen = { ...state.seen, inv: Math.max(state.seen.inv, ...d.data.map((i) => i.created)) }
    const last = d.data.at(-1)
    if (d.has_more && last) return next(state, events, { seen, nowWatch, after: last.id })
    return next(state, events, { seen, nowWatch, stage: 'open_invoices', after: null })
  }

  async function openInvoicesStage(conn: ConnectionRef, state: StripeCursor): Promise<SyncResult> {
    const d = await client.get<StripeList<StripeInvoice>>(credsOf(conn), '/v1/invoices', { ...page(state.after), status: 'open', 'expand[]': ['data.payments'] })
    const { events, nowWatch } = await emitInvoices(conn, state, d.data)
    const last = d.data.at(-1)
    if (d.has_more && last) return next(state, events, { nowWatch, after: last.id })
    const check = state.watch.filter((id) => !nowWatch.includes(id))
    return next(state, events, { nowWatch, check, stage: check.length ? 'closed_check' : 'subs', after: null })
  }

  async function closedCheckStage(conn: ConnectionRef, state: StripeCursor): Promise<SyncResult> {
    const creds = credsOf(conn)
    const batch = state.check.slice(0, CLOSED_CHECK_BATCH)
    const found: StripeInvoice[] = []
    for (const id of batch) {
      try {
        found.push(await client.get<StripeInvoice>(creds, `/v1/invoices/${encodeURIComponent(id)}`, { 'expand[]': ['payments'] }))
      } catch (e) {
        // A deleted draft is gone for good; nothing to emit.
        if (isConnectorError(e) && e.status === 404) continue
        throw e
      }
    }
    const { events, nowWatch } = await emitInvoices(conn, state, found)
    const check = state.check.slice(batch.length)
    return next(state, events, { nowWatch, check, ...(check.length ? {} : { stage: 'subs' as const, after: null }) })
  }

  /** A subscription's MRR per billed period, from up to 300 of its invoices; none when invoices can't be read. */
  async function historyOf(creds: StripeCredentials, sub: StripeSubscription, lookup: (d: StripeDiscount) => StripeCoupon | undefined, nowSec: number) {
    const invoices: StripeInvoice[] = []
    let after: string | null = null
    try {
      for (let i = 0; i < 3; i++) {
        const p: StripeList<StripeInvoice> = await client.get<StripeList<StripeInvoice>>(creds, '/v1/invoices', { ...page(after), subscription: sub.id })
        invoices.push(...p.data)
        const last = p.data.at(-1)
        if (!p.has_more || !last) break
        after = last.id
      }
    } catch (e) {
      if (isPermissionMissing(e)) return []
      throw e
    }
    const excluded = new Set(subscriptionMrr(sub, lookup, nowSec).items.filter((r) => !r.counted).map((r) => r.item.id))
    return subscriptionHistory(sub, invoices, excluded, nowSec).map((h) => ({ at: isoTimestamp(h.at), mrr: h.mrr }))
  }

  async function subsStage(conn: ConnectionRef, state: StripeCursor): Promise<SyncResult> {
    const creds = credsOf(conn)
    const d = await client.get<StripeList<StripeSubscription>>(creds, '/v1/subscriptions', {
      ...page(state.after),
      status: 'all',
      'expand[]': ['data.discounts', 'data.items.data.discounts'],
    })
    const coupons = new Map<string, StripeCoupon | undefined>()
    let couponDenied: StripeError | undefined
    const resolve = async (dsc: StripeDiscount) => {
      const c = discountCoupon(dsc)
      if (typeof c === 'string' && !coupons.has(c)) {
        try {
          coupons.set(c, await client.get<StripeCoupon>(creds, `/v1/coupons/${encodeURIComponent(c)}`))
        } catch (e) {
          // A deleted coupon still applies to existing subscriptions but can't be read; count it as no discount.
          if (isConnectorError(e) && e.status === 404) coupons.set(c, undefined)
          // Restricted key without coupon read: same, but say so (MRR then ignores that discount).
          else if (isPermissionMissing(e)) {
            coupons.set(c, undefined)
            couponDenied = e
          } else throw e
        }
      }
    }
    const lookup = (dsc: StripeDiscount): StripeCoupon | undefined => {
      const c = discountCoupon(dsc)
      return typeof c === 'string' ? coupons.get(c) : c
    }
    const nowSec = Math.floor(clock.now() / 1000)
    const events: NormalizedEvent[] = []
    let tiersDenied: StripeError | undefined
    const itemsOf = async (subId: string, tiers: boolean): Promise<StripeSubscriptionItem[]> => {
      const all: StripeSubscriptionItem[] = []
      let after: string | null = null
      for (;;) {
        const p: StripeList<StripeSubscriptionItem> = await client.get<StripeList<StripeSubscriptionItem>>(creds, '/v1/subscription_items', {
          ...page(after),
          subscription: subId,
          'expand[]': tiers ? ['data.discounts', 'data.price.tiers'] : ['data.discounts'],
        })
        all.push(...p.data)
        const last = p.data.at(-1)
        if (!p.has_more || !last) break
        after = last.id
      }
      return all
    }
    for (const sub of d.data) {
      let items = sub.items
      // A tiered price is valued from its tiers, which only come with expand; the subscription list can't reach them
      // (data.items.data.price.tiers is past Stripe's expand depth), so those subscriptions' items are read again.
      const needTiers = items.data.some((i) => i.price.billing_scheme === 'tiered' && !i.price.tiers)
      if (items.has_more || needTiers) {
        let all: StripeSubscriptionItem[] | undefined
        if (needTiers && !tiersDenied) {
          try {
            all = await itemsOf(sub.id, true)
          } catch (e) {
            // Without the tiers MRR leaves those items out, as before, and says so.
            if (!isPermissionMissing(e)) throw e
            tiersDenied = e
          }
        }
        if (!all && items.has_more) all = await itemsOf(sub.id, false)
        if (all) items = { ...items, data: all, has_more: false }
      }
      const full: StripeSubscription = { ...sub, items }
      const discounts = [
        ...(full.discounts ?? []),
        ...(full.discount ? [full.discount] : []),
        ...full.items.data.flatMap((i) => i.discounts ?? []),
      ].filter((x): x is StripeDiscount => typeof x === 'object' && x !== null)
      for (const dsc of discounts) await resolve(dsc)
      const rawRef = await deps.raw.put(conn.id, 'stripe.subscription', full.id, full)
      const ev = mapSubscription(full, lookup, nowSec, conn.id, rawRef)
      // First full pass only: past MRR from the subscription's invoices, so upgrades and downgrades land in the month
      // they happened. Later syncs leave it out (core then dates a change on the day it's seen).
      const changes = state.hw.inv === 0 ? await historyOf(creds, full, lookup, nowSec) : []
      events.push(changes.length ? { ...ev, changes } : ev)
    }
    const warnings = [...(couponDenied ? [STRIPE_COUPONS_WARNING] : []), ...(tiersDenied ? [STRIPE_TIERS_WARNING] : [])]
    const last = d.data.at(-1)
    const r = d.has_more && last ? next(state, events, { after: last.id }) : finish(state, events)
    return warnings.length ? { ...r, warnings } : r
  }

  /** Cycle done: commit high-water marks (never backwards) and the invoice watch list. */
  function finish(state: StripeCursor, events: NormalizedEvent[]): SyncResult {
    const hw: Marks = {
      txn: Math.max(state.hw.txn, state.seen.txn),
      payout: Math.max(state.hw.payout, state.seen.payout),
      inv: Math.max(state.hw.inv, state.seen.inv),
    }
    const done: StripeCursor = { ...fresh(), hw, seen: hw, cur: state.cur, watch: state.nowWatch.slice(-WATCH_CAP) }
    return { events, cursor: codec.encode(done), hasMore: false }
  }

  type StageFn = (conn: ConnectionRef, s: StripeCursor) => Promise<SyncResult>
  /**
   * Optional resources (payouts, invoices, subscriptions): a restricted key without Read access skips the resource with
   * a warning instead of failing the cycle. Balance and balance transactions stay required (they fail with 'auth').
   */
  const optionalStage = (fn: StageFn, what: string, skip: (s: StripeCursor) => SyncResult): StageFn => async (conn, s) => {
    try {
      return await fn(conn, s)
    } catch (e) {
      if (!isPermissionMissing(e)) throw e
      return { ...skip(s), warnings: [skippedWarning(what, e)] }
    }
  }
  // Payout attribution is skipped; payout rows themselves still come from balance transactions.
  const skipPayouts = (s: StripeCursor) => next(s, [], { queue: [], pAfter: null, after: null, stage: 'invoices' })
  // Keep last cycle's watch list so invoice status changes are caught once the key can read invoices again.
  const skipInvoices = (s: StripeCursor) =>
    next(s, [], { nowWatch: [...new Set([...s.nowWatch, ...s.watch])], check: [], after: null, stage: 'subs' })
  const skipSubs = (s: StripeCursor) => finish(s, [])

  const stages: Record<Stage, StageFn> = {
    balance: balanceStage,
    txns: txnsStage,
    payouts: optionalStage(payoutsStage, 'payouts', skipPayouts),
    payout_txns: payoutTxnsStage,
    invoices: optionalStage(invoicesStage, 'invoices', skipInvoices),
    open_invoices: optionalStage(openInvoicesStage, 'invoices', skipInvoices),
    closed_check: optionalStage(closedCheckStage, 'invoices', skipInvoices),
    subs: optionalStage(subsStage, 'subscriptions', skipSubs),
  }

  const connector: StripeConnector = {
    client,
    describe: () => description,

    async begin(ctx) {
      if (oauthReady) {
        const u = new URL(authorizeBase(opts.appAuthorizeUrl))
        u.searchParams.set('client_id', opts.appClientId as string)
        u.searchParams.set('redirect_uri', ctx.redirectUri)
        u.searchParams.set('state', ctx.state)
        return { kind: 'oauth', url: u.toString() }
      }
      return {
        kind: 'api_key',
        label: 'Stripe restricted API key (read-only)',
        helpUrl: 'https://dashboard.stripe.com/apikeys/create',
        placeholder: 'rk_live_...',
        steps: [
          'Open Stripe → Developers → API keys and choose "Create restricted key".',
          'Name it "Aggregate" and set the permissions below to Read; leave everything else at None.',
          'Create the key, copy it (it starts with rk_live_, or rk_test_ in test mode) and paste it here.',
        ],
        permissions: ['Balance', 'Balance transaction sources', 'Payouts', 'Invoices', 'Subscriptions', 'Coupons', 'Customers (shows who paid, by name)', 'Connect → Accounts (optional, shows your business name)'],
      }
    },

    async connect(input) {
      const code = str(input.code)
      if (code) {
        // Stripe Apps sign-in: exchange the code, then read the account with the new token like a pasted key.
        const { accountId: acct, ...secret } = await exchangeCode(code)
        const lm = secret.livemode
        const creds: StripeCredentials = { apiKey: secret.apiKey }
        const a = await client.get<StripeAccount>(creds, '/v1/account').catch(() => undefined)
        const accountId = a?.id ?? acct
        if (!accountId) throw new ConnectorError('permanent', 'Stripe sign-in returned no account id', { provider: 'stripe' })
        const name = a?.settings?.dashboard?.display_name ?? a?.business_profile?.name ?? accountId
        const livemode = lm ?? !secret.apiKey.includes('_test_')
        const config: StripeConfig = {
          accountId,
          displayName: name.slice(0, 80),
          ...(a?.default_currency ? { defaultCurrency: normalizeCurrency(a.default_currency) } : {}),
          livemode,
          keyType: 'oauth',
          warnings: livemode ? [] : ['Connected in test mode: only Stripe test data will be synced.'],
        }
        return { secret, config: { ...config } }
      }
      const apiKey = str(input.apiKey)?.trim()
      if (apiKey?.startsWith('pk_')) {
        throw new ConnectorError('invalid_input', 'That is a publishable key (pk_...). Use a restricted key (rk_...) with read access.', { provider: 'stripe' })
      }
      if (!apiKey || !KEY_RE.test(apiKey)) {
        throw new ConnectorError('invalid_input', 'apiKey must be a Stripe restricted key (rk_...) or secret key (sk_...)', { provider: 'stripe' })
      }
      const stripeAccount = str(input.stripeAccount)?.trim()
      if (stripeAccount !== undefined && !ACCT_RE.test(stripeAccount)) {
        throw new ConnectorError('invalid_input', 'stripeAccount must look like acct_...', { provider: 'stripe' })
      }
      const creds: StripeCredentials = { apiKey, ...(stripeAccount ? { stripeAccount } : {}) }
      const keyType = apiKey.startsWith('sk_') ? 'secret' : 'restricted'
      const livemode = apiKey.includes('_live_')
      if (keyType === 'secret' && opts.hosted) throw new ConnectorError('invalid_input', STRIPE_SECRET_KEY_REFUSED, { provider: 'stripe', forUser: true })

      const asInput = (e: unknown): unknown =>
        isConnectorError(e) && e.kind === 'permanent' ? new ConnectorError('invalid_input', e.message, { provider: 'stripe', cause: e }) : e

      let accountId: string | undefined
      let displayName: string | undefined
      let defaultCurrency: string | undefined
      try {
        const a = await client.get<StripeAccount>(creds, '/v1/account')
        accountId = a.id
        displayName = a.settings?.dashboard?.display_name ?? a.business_profile?.name ?? undefined
        defaultCurrency = a.default_currency ?? undefined
      } catch (e) {
        if (!(e instanceof StripeError && e.code === 'permission_missing')) throw asInput(e)
        // Restricted key without account read: verify the key with /v1/balance instead.
        const b = await client.get<StripeBalance>(creds, '/v1/balance').catch((x: unknown) => {
          throw asInput(x)
        })
        accountId = stripeAccount ?? e.accountHint ?? str(input.accountId)
        defaultCurrency = b.available[0]?.currency
        if (!accountId || !ACCT_RE.test(accountId)) {
          throw new ConnectorError(
            'invalid_input',
            'Could not read the Stripe account id with this key. Grant Read on "Account" (Connect) or pass accountId (acct_...).',
            { provider: 'stripe' },
          )
        }
      }

      const warnings: string[] = []
      if (keyType === 'secret') warnings.push(STRIPE_FULL_ACCESS_WARNING)
      // A restricted key can still be allowed to write. Stripe can't say which permissions a key has, so ask the
      // two money-moving endpoints in a way that can't succeed, and say so plainly if they'd have let us in.
      let canWrite = false
      if (keyType === 'restricted') {
        for (const path of ['/v1/refunds', '/v1/payouts'] as const) if ((await client.probeWrite(creds, path)) === 'allowed') canWrite = true
        if (canWrite) warnings.push(STRIPE_KEY_CAN_WRITE_WARNING)
      }
      if (!livemode) warnings.push('This is a test-mode key: only Stripe test data will be synced.')
      const config: StripeConfig = {
        accountId,
        displayName: (displayName ?? accountId).slice(0, 80),
        ...(defaultCurrency ? { defaultCurrency: normalizeCurrency(defaultCurrency) } : {}),
        livemode,
        keyType,
        ...(canWrite ? { canWrite } : {}),
        ...(stripeAccount ? { stripeAccount } : {}),
        warnings,
      }
      const secret: StripeSecret = { apiKey }
      return { secret, config: { ...config } }
    },

    async sync(conn, cursor) {
      const state = codec.decode(cursor) ?? fresh()
      const renewed = await freshSecret(conn)
      if (!renewed) return withAccessWarning(conn, await stages[state.stage](conn, state))
      // The refresh token rotated: keep it before fetching anything, so a failed page can't strand it.
      await deps.saveSecret?.(conn.id, renewed)
      const page = await stages[state.stage]({ ...conn, secret: renewed }, state)
      return withAccessWarning(conn, { ...page, updatedSecret: renewed })
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        // Never refresh here: Stripe rotates the refresh token on every refresh, and health has no way to save the
        // new one, so a refresh from health would leave the stored secret dead. An expired access token is normal
        // between syncs; sync() renews it.
        if (tokenExpired(secretOf(conn))) return { status: 'ok', message: 'Stripe sign-in token has expired; it renews on the next sync.' }
        await client.get<StripeBalance>(credsOf(conn), '/v1/balance')
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },
  }
  if (secrets.length) {
    return {
      ...connector,
      webhook: stripeWebhook({ secrets, clock, ...(opts.webhookAccountId ? { accountId: opts.webhookAccountId } : {}) }),
    }
  }
  return connector
}
