// Plaid connector: banks and credit cards (transactions/sync), balances, liabilities, investments, relink.
// Ported from moshe-site/money.mjs (syncItem, link token, exchange, item remove) onto the Connector contract.
//
// A sync cycle is: one "accounts" page (/accounts/get + optional liabilities and holdings), then one page holding the
// whole /transactions/sync loop (read until has_more is false, then saved with its cursor), then investment
// transactions. The cursor keeps Plaid's transactions cursor, so the next cycle is incremental.

import type {
  ConnectBegin,
  ConnectBeginContext,
  BalanceSnapshot,
  Connector,
  ConnectionRef,
  ConnectorDescription,
  ConnectorHealth,
  LiabilityDetails,
  NormalizedEvent,
  ProviderFreshness,
  SyncResult,
} from '@agfn/contracts'
import {
  ConnectorError,
  cursorCodec,
  healthFromError,
  isConnectorError,
  isRecord,
  isoTimestamp,
  oldestIso,
  requireSecret,
  str,
  systemClock,
  type Clock,
  type ConnectorDeps,
  type ConnectorWebhook,
} from '@agfn/connector-sdk'
import { PRODUCT_UNAVAILABLE_CODES, PlaidClient, type PlaidAppCredentials } from './client.ts'
import {
  accountCurrency,
  creditDetails,
  loanDetails,
  mapAccount,
  mapBalance,
  mapHoldings,
  mapInvestmentTxn,
  mapRemoved,
  mapTxn,
  mortgageDetails,
  studentDetails,
} from './map.ts'
import { PlaidWebhookVerifier, interpretPlaidWebhook } from './webhook.ts'
import type {
  PlaidAccountsGetResponse,
  PlaidHoldingsResponse,
  PlaidInvestmentTxnsResponse,
  PlaidItem,
  PlaidItemStatus,
  PlaidLiabilitiesResponse,
  PlaidTransactionsSyncResponse,
} from './types.ts'

/** Extra read products a Plaid Item may have consented to. Never money-moving products. */
export type PlaidExtraProduct = 'liabilities' | 'investments'

export interface PlaidSecret {
  accessToken: string
  itemId: string
}

export interface PlaidConfig {
  itemId: string
  institutionId?: string
  institution?: string
  /** Extra products this Item consented to, from /item/get at connect time. */
  products: PlaidExtraProduct[]
  /** The Item has no Transactions (a brokerage-only link without it): sync reads balances and investments only. */
  noTransactions?: boolean
  /** Link session that created the Item: what Plaid support asks for. */
  linkSessionId?: string
}

export interface PlaidConnectorOptions extends PlaidAppCredentials {
  /** Name shown in Plaid Link. */
  clientName?: string
  /**
   * Extra products consented in Link (additional_consented_products): no coverage cut, billed only from the first
   * call. Each is read on every sync where the Item supports it.
   */
  consentedProducts?: PlaidExtraProduct[]
  /** URL Plaid posts webhooks to (SYNC_UPDATES_AVAILABLE, ITEM errors). */
  webhookUrl?: string
  countryCodes?: string[]
  /** Days of history requested at first link (max 730). */
  daysRequested?: number
  /** transactions/sync page size (max 500). */
  pageSize?: number
  /** Page that re-opens Link after an OAuth bank (Chase, BofA...) redirect; must be registered with Plaid. */
  linkRedirectUri?: string
}

interface PlaidCursor {
  stage: 'accounts' | 'txns' | 'inv'
  /** Plaid transactions cursor after the last fully stored page. Null = initial backfill. */
  tx: string | null
  /**
   * Plaid cursor at the start of the current has_more loop. On TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION Plaid
   * requires restarting from here (re-emitted rows are harmless: events are idempotent by externalId).
   */
  loop: string | null
  /** account_id → currency, for removed rows (Plaid sends only ids). */
  cur: Record<string, string>
  /** Investments: date window start for this cycle and the offset within it; `invDone` = last fully read end date. */
  inv?: { from: string; to: string; offset: number }
  invDone?: string
  /** The last /accounts/get had an investment account: only then are investment transactions read (billing). */
  invAccounts?: boolean
  /** Follow-up syncs asked for while Plaid's history wasn't complete yet (bounded, see HISTORY_FOLLOW_UPS_MS). */
  waits?: number
}

const isPlaidCursor = (v: unknown): v is PlaidCursor =>
  isRecord(v) && (v.stage === 'accounts' || v.stage === 'txns' || v.stage === 'inv') && isRecord(v.cur)

const isPlaidSecret = (v: unknown): v is PlaidSecret =>
  isRecord(v) && typeof v.accessToken === 'string' && v.accessToken !== '' && typeof v.itemId === 'string'

function addDays(date: string, days: number): string {
  const t = Date.parse(date + 'T00:00:00Z') + days * 86_400_000
  return new Date(t).toISOString().slice(0, 10)
}

const EXTRA: readonly PlaidExtraProduct[] = ['liabilities', 'investments']
const CAPITAL_ONE = 'ins_128026'
/**
 * Right after linking, /transactions/sync often has nothing yet (transactions_update_status NOT_READY, then
 * INITIAL_UPDATE_COMPLETE ~30 days, then HISTORICAL_UPDATE_COMPLETE). Without a webhook URL nothing would look again
 * for an hour, so ask for follow-up syncs at these delays until history is complete, then stop.
 */
const HISTORY_FOLLOW_UPS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000]

/** What Link's onSuccess says was just linked, and what a workspace already has, for the duplicate-Item check. */
export interface PlaidLinkedSummary {
  institutionId?: string
  institutionName?: string
  /** Account masks (last 2-4 digits) with their subtype when known. */
  accounts: Array<{ mask?: string | null; subtype?: string | null }>
}

/**
 * Plaid never dedupes Items, and a second Item for the same login is billed and counted twice. Before exchanging a
 * public token, compare it with live connections in the workspace: same institution and at least one same account
 * (mask + subtype) means it's already connected. Same bank with different accounts is a separate login, allowed. Returns the matching connection's id.
 */
export function findDuplicatePlaidItem(linked: PlaidLinkedSummary, existing: Array<PlaidLinkedSummary & { connectionId: string }>): string | undefined {
  if (!linked.institutionId) return undefined
  const key = (a: { mask?: string | null; subtype?: string | null }) => (a.mask ? `${a.mask}|${a.subtype ?? ''}` : '')
  const mine = new Set(linked.accounts.map(key).filter(Boolean))
  for (const e of existing) {
    if (e.institutionId !== linked.institutionId) continue
    // Same bank alone isn't enough: founders often have one login per company at the same bank.
    if (e.accounts.some((a) => mine.has(key(a)))) return e.connectionId
  }
  return undefined
}

export interface LinkTokenRequest {
  /** Stable, non-identifying id for the end user (e.g. hash of person id). Required by Plaid. */
  clientUserId: string
  /** Set for update mode (relink after ITEM_LOGIN_REQUIRED, or to add accounts). */
  accessToken?: string
  /** In update mode, also let the user pick newly opened accounts. */
  accountSelection?: boolean
  /** OAuth banks (Chase, BofA...) redirect back here; must be registered in the Plaid dashboard. */
  redirectUri?: string
  /**
   * A new link for a login with only investment accounts (a Fidelity or Vanguard brokerage, no cash account): Plaid
   * requires at least one compatible account per required product, so Transactions-required ends in NO_ACCOUNTS there.
   */
  investmentsFirst?: boolean
  language?: string
}

export interface PlaidConnector extends Connector {
  /** Start Plaid Link (new connection or update mode). */
  begin(ctx: ConnectBeginContext): Promise<ConnectBegin>
  createLinkToken(req: LinkTokenRequest): Promise<{ linkToken: string; expiration: string }>
  /** Revoke the Item at Plaid (disconnect). Safe to call twice. */
  removeItem(conn: ConnectionRef): Promise<void>
  disconnect(conn: ConnectionRef): Promise<void>
  /** Live balances from the bank (/accounts/balance/get): billed per call, 3-11 s, ~30 calls per Item per hour. */
  refreshBalances(conn: ConnectionRef): Promise<NormalizedEvent[]>
  /** Sandbox only: make a public token without the Link UI (for smoke tests against Plaid Sandbox). */
  sandboxPublicToken(institutionId?: string, products?: string[], opts?: { username?: string }): Promise<string>
  /** Verified webhooks (JWT signed by Plaid); match.field is 'itemId'. */
  readonly webhook: ConnectorWebhook
  readonly client: PlaidClient
}

export function createPlaidConnector(opts: PlaidConnectorOptions, deps: ConnectorDeps): PlaidConnector {
  const client = new PlaidClient(opts, deps)
  const clock: Clock = deps.clock ?? systemClock
  const codec = cursorCodec<PlaidCursor>('plaid', 1, isPlaidCursor)
  const pageSize = Math.min(500, Math.max(1, opts.pageSize ?? 500))

  const description: ConnectorDescription = {
    key: 'plaid',
    name: 'Bank or card (Plaid)',
    group: 'banks',
    provides: ['balances', 'transactions'],
    // The webhook only tells us when Plaid has new data; it doesn't make the bank post faster. State the real cadence.
    freshness: 'bank data updates a few times a day; investments about once a night',
    auth: 'link_widget',
    // Bump when the mapping changes what stored rows should say: each existing connection re-reads its history once
    // (/transactions/sync from the start; no extra Plaid cost). 1: payment-app rows name the person, rows without a
    // merchant keep Plaid's own name, CD/HSA aren't cash, retirement accounts are personal.
    // 3: interest the bank names on money in ("INTRST PYMNT") when Plaid's own guess is weak.
    // 4: category v2 renames read as v1 (a paycheck is INCOME_WAGES again); crypto amounts are 'XXX', never USD.
    dataVersion: 4,
  }

  const secretOf = (conn: ConnectionRef) => requireSecret('plaid', conn.secret, isPlaidSecret)
  const configOf = (conn: ConnectionRef): PlaidConfig => {
    const c = conn.config
    const products = Array.isArray(c.products) ? c.products.filter((p): p is PlaidExtraProduct => EXTRA.includes(p as PlaidExtraProduct)) : []
    const institution = str(c.institution)
    const institutionId = str(c.institutionId)
    return {
      itemId: str(c.itemId) ?? '',
      products,
      ...(c.noTransactions === true ? { noTransactions: true } : {}),
      ...(institution ? { institution } : {}),
      ...(institutionId ? { institutionId } : {}),
    }
  }

  /** Optional products: a product-not-available error skips it; auth and transient errors still fail the sync. */
  async function optional<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn()
    } catch (e) {
      if (isConnectorError(e) && e.code && PRODUCT_UNAVAILABLE_CODES.has(e.code)) return undefined
      throw e
    }
  }

  async function accountsPage(conn: ConnectionRef, state: PlaidCursor): Promise<SyncResult> {
    const { accessToken } = secretOf(conn)
    const cfg = configOf(conn)
    const at = isoTimestamp(clock.now())
    const res = await client.call<PlaidAccountsGetResponse>('/accounts/get', { access_token: accessToken })
    // The first Liabilities or Investments call starts that product's monthly per-Item subscription, so each is read
    // only for an Item with an account it covers: a card or loan for Liabilities, an investment account for Investments.
    const hasDebt = res.accounts.some((a) => a.type === 'credit' || a.type === 'loan')
    const invAccounts = res.accounts.some((a) => a.type === 'investment' || a.type === 'brokerage')

    const liabilities = new Map<string, LiabilityDetails>()
    if (hasDebt && cfg.products.includes('liabilities')) {
      const l = await optional(() => client.call<PlaidLiabilitiesResponse>('/liabilities/get', { access_token: accessToken }))
      if (l) {
        const curOf = new Map(l.accounts.map((a) => [a.account_id, accountCurrency(a)]))
        const add = (id: string | null, d: (cur: string) => LiabilityDetails) => {
          if (id) liabilities.set(id, d(curOf.get(id) ?? 'USD'))
        }
        for (const x of l.liabilities.credit ?? []) add(x.account_id, (c) => creditDetails(x, c))
        for (const x of l.liabilities.mortgage ?? []) add(x.account_id, (c) => mortgageDetails(x, c))
        for (const x of l.liabilities.student ?? []) add(x.account_id, (c) => studentDetails(x, c))
        for (const x of l.liabilities.loan ?? []) add(x.account_id, (c) => loanDetails(x, c))
        await deps.raw.put(conn.id, 'plaid.liabilities', cfg.itemId || 'item', l.liabilities)
      }
    }

    let holdings = new Map<string, NonNullable<BalanceSnapshot['holdings']>>()
    if (invAccounts && cfg.products.includes('investments')) {
      const h = await optional(() => client.call<PlaidHoldingsResponse>('/investments/holdings/get', { access_token: accessToken }))
      if (h) {
        holdings = mapHoldings(h.holdings, h.securities, new Map(h.accounts.map((a) => [a.account_id, accountCurrency(a)])))
        await deps.raw.put(conn.id, 'plaid.holdings', cfg.itemId || 'item', { holdings: h.holdings, securities: h.securities })
      }
    }

    const events: NormalizedEvent[] = []
    const cur: Record<string, string> = {}
    for (const a of res.accounts) {
      cur[a.account_id] = accountCurrency(a)
      const rawRef = await deps.raw.put(conn.id, 'plaid.account', a.account_id, a)
      events.push(mapAccount(a, conn.id, rawRef, cfg.institution ?? res.item.institution_name ?? undefined, liabilities.get(a.account_id)))
      const bal = mapBalance(a, conn.id, rawRef, at, holdings.get(a.account_id))
      if (bal) events.push(bal)
    }
    const freshness = await itemFreshness(accessToken, res.accounts, at)
    const next: PlaidCursor = {
      stage: 'txns',
      tx: state.tx,
      loop: state.tx,
      cur,
      ...(state.invDone ? { invDone: state.invDone } : {}),
      ...(invAccounts ? { invAccounts: true } : {}),
      ...(state.waits ? { waits: state.waits } : {}),
    }
    return { events, cursor: codec.encode(next), hasMore: true, freshness }
  }

  /**
   * How current Plaid says this Item's data is: /item/get's status (free; never Plaid's billed on-demand refresh) and
   * each balance's last_updated_datetime where the institution gives one. Best effort: a failed /item/get leaves the
   * product times out, never the sync.
   */
  async function itemFreshness(accessToken: string, accounts: PlaidAccountsGetResponse['accounts'], at: string): Promise<ProviderFreshness> {
    const out: ProviderFreshness = { checkedAt: at }
    const byAccount: Record<string, string> = {}
    for (const a of accounts) {
      const t = a.balances.last_updated_datetime
      if (t && Number.isFinite(Date.parse(t))) byAccount[a.account_id] = t
    }
    if (Object.keys(byAccount).length) {
      out.balancesUpdatedAtByAccount = byAccount
      const oldest = oldestIso(Object.values(byAccount))
      if (oldest) out.balancesUpdatedAt = oldest
    }
    const got = await client.call<{ item?: PlaidItem; status?: PlaidItemStatus | null }>('/item/get', { access_token: accessToken }).catch(() => undefined)
    const s = got?.status ?? undefined
    // The code only, never Plaid's message: a silently stuck Item then reads as "Plaid's last refresh failed".
    const code = got?.item?.error?.error_code
    if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)) out.providerErrorCode = code
    const put = (k: 'transactionsLastSuccessAt' | 'transactionsLastFailedAt' | 'investmentsLastSuccessAt', v: string | null | undefined) => {
      if (v && Number.isFinite(Date.parse(v))) out[k] = v
    }
    put('transactionsLastSuccessAt', s?.transactions?.last_successful_update)
    put('transactionsLastFailedAt', s?.transactions?.last_failed_update)
    put('investmentsLastSuccessAt', s?.investments?.last_successful_update)
    return out
  }

  /**
   * /transactions/sync, read to the end before anything is saved: Plaid's cursor is only safe to persist once has_more
   * is false. On TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION the whole loop restarts from the cursor it began with.
   */
  async function txnsPage(conn: ConnectionRef, state: PlaidCursor): Promise<SyncResult> {
    const { accessToken } = secretOf(conn)
    const cfg = configOf(conn)
    const today = isoTimestamp(clock.now()).slice(0, 10)
    /** Transactions done (or none on this Item): investment transactions next when consented, else the cycle ends. */
    const next = (events: NormalizedEvent[], cursor: string | null, status?: string): SyncResult => {
      // The next sync() starts with fresh balances, then picks up new transactions from here.
      const after: PlaidCursor = { ...state, tx: cursor, loop: cursor }
      delete after.inv
      // History not complete yet: schedule a bounded follow-up. Unknown status (older API versions) = complete.
      const waiting = status === 'NOT_READY' || status === 'INITIAL_UPDATE_COMPLETE'
      const waits = state.waits ?? 0
      const again = waiting ? HISTORY_FOLLOW_UPS_MS[waits] : undefined
      if (again !== undefined) after.waits = waits + 1
      else if (!waiting) delete after.waits
      const follow = again !== undefined ? { syncAgainInMs: again } : {}
      if (state.invAccounts && cfg.products.includes('investments')) {
        const back = after.invDone ? addDays(after.invDone, -7) : addDays(today, -730)
        return { events, cursor: codec.encode({ ...after, stage: 'inv', inv: { from: back, to: today, offset: 0 } }), hasMore: true, ...follow }
      }
      return { events, cursor: codec.encode({ ...after, stage: 'accounts' }), hasMore: false, ...follow }
    }
    // A brokerage-only Item: no Transactions to read, only holdings and investment transactions.
    if (cfg.noTransactions) return next([], state.tx)
    let restarts = 0
    for (;;) {
      try {
        const events: NormalizedEvent[] = []
        let cursor = state.tx
        let status: string | undefined
        for (;;) {
          const d = await client.call<PlaidTransactionsSyncResponse>('/transactions/sync', {
            access_token: accessToken,
            ...(cursor ? { cursor } : {}),
            count: pageSize,
            // Pinned so the taxonomy can't change under us; categoryHint maps v2's renamed codes back to v1.
            options: { include_original_description: true, personal_finance_category_version: 'v2' },
          })
          for (const t of [...d.added, ...d.modified]) {
            const rawRef = await deps.raw.put(conn.id, 'plaid.transaction', t.transaction_id, t)
            events.push(mapTxn(t, conn.id, rawRef, state.cur[t.account_id] ?? 'USD'))
          }
          for (const r of d.removed) {
            const rawRef = await deps.raw.put(conn.id, 'plaid.transaction.removed', r.transaction_id, r)
            events.push(mapRemoved(r, conn.id, rawRef, (r.account_id && state.cur[r.account_id]) || 'USD', today))
          }
          cursor = d.next_cursor
          status = d.transactions_update_status
          if (!d.has_more) break
        }
        return next(events, cursor, status)
      } catch (e) {
        if (isConnectorError(e) && e.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && restarts++ < 3) continue
        // An investments Item whose accounts Transactions doesn't cover (brokerage only, Transactions consented): its
        // holdings and investment transactions still sync. A bank Item still fails here, as before.
        if (isConnectorError(e) && e.code && cfg.products.includes('investments') && (PRODUCT_UNAVAILABLE_CODES.has(e.code) || e.code === 'NO_ACCOUNTS')) return next([], state.tx)
        throw e
      }
    }
  }

  const verifier = new PlaidWebhookVerifier(client, clock)

  /**
   * Investment transactions, offset-paginated over a date window. Only cash flows that change the account's total value
   * are emitted (cash in/out, dividends, interest, fees, transfers); buys and sells just move value between cash and
   * securities inside the account, so they're stored raw but not emitted.
   */
  async function invPage(conn: ConnectionRef, state: PlaidCursor): Promise<SyncResult> {
    const win = state.inv
    if (!win) return { events: [], cursor: codec.encode({ ...state, stage: 'accounts' }), hasMore: false }
    const { accessToken } = secretOf(conn)
    const d = await optional(() =>
      client.call<PlaidInvestmentTxnsResponse>('/investments/transactions/get', {
        access_token: accessToken,
        start_date: win.from,
        end_date: win.to,
        options: { count: pageSize, offset: win.offset },
      }),
    )
    const finish = (): SyncResult => {
      const done: PlaidCursor = { ...state, stage: 'accounts', invDone: win.to }
      delete done.inv
      return { events: [], cursor: codec.encode(done), hasMore: false }
    }
    if (!d) return finish()
    const sec = new Map(d.securities.map((s) => [s.security_id, s]))
    const events: NormalizedEvent[] = []
    for (const t of d.investment_transactions) {
      const rawRef = await deps.raw.put(conn.id, 'plaid.investment_transaction', t.investment_transaction_id, t)
      const e = mapInvestmentTxn(t, sec.get(t.security_id ?? ''), conn.id, rawRef, state.cur[t.account_id] ?? 'USD')
      if (e) events.push(e)
    }
    const offset = win.offset + d.investment_transactions.length
    if (d.investment_transactions.length > 0 && offset < d.total_investment_transactions) {
      return { events, cursor: codec.encode({ ...state, inv: { ...win, offset } }), hasMore: true }
    }
    const r = finish()
    return { ...r, events }
  }

  return {
    client,
    webhook: { verify: (req) => verifier.verify(req), interpret: interpretPlaidWebhook },
    describe: () => description,

    async connect(input) {
      const publicToken = str(input.publicToken)
      if (!publicToken) throw new ConnectorError('invalid_input', 'publicToken is required', { provider: 'plaid' })
      const ex = await client.call<{ access_token: string; item_id: string }>(
        '/item/public_token/exchange',
        { public_token: publicToken },
        false,
      )
      const info = await client.call<{ item: PlaidItem }>('/item/get', { access_token: ex.access_token }).catch(() => undefined)
      const granted = new Set([...(info?.item.products ?? []), ...(info?.item.consented_products ?? [])])
      const products = EXTRA.filter((p) => granted.has(p))
      // Only a brokerage-first link can lack Transactions; without /item/get, assume it's there (the sync skips it if not).
      const noTransactions = info !== undefined && !granted.has('transactions')
      const inst = isRecord(input.institution) ? input.institution : {}
      const institution = str(inst.name) ?? info?.item.institution_name ?? undefined
      const institutionId = str(inst.institution_id) ?? info?.item.institution_id ?? undefined
      const secret: PlaidSecret = { accessToken: ex.access_token, itemId: ex.item_id }
      const linkSessionId = str(input.linkSessionId)
      const config: PlaidConfig = {
        itemId: ex.item_id,
        products,
        ...(noTransactions ? { noTransactions: true } : {}),
        ...(linkSessionId ? { linkSessionId } : {}),
        ...(institution ? { institution: institution.slice(0, 80) } : {}),
        ...(institutionId ? { institutionId } : {}),
      }
      return { secret, config: { ...config } }
    },

    async sync(conn, cursor) {
      const state = codec.decode(cursor) ?? { stage: 'accounts', tx: null, loop: null, cur: {} }
      if (state.stage === 'accounts') return accountsPage(conn, state)
      return state.stage === 'txns' ? txnsPage(conn, state) : invPage(conn, state)
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        const { item } = await client.call<{ item: PlaidItem }>('/item/get', { access_token: secretOf(conn).accessToken })
        if (item.error) {
          const err = new ConnectorError('permanent', item.error.display_message || item.error.error_message || item.error.error_code, {
            provider: 'plaid',
            code: item.error.error_code,
          })
          return item.error.error_type === 'ITEM_ERROR' ? { status: 'needs_reauth', message: err.message } : healthFromError(err)
        }
        if (item.consent_expiration_time) {
          const left = Date.parse(item.consent_expiration_time) - clock.now()
          if (left < 7 * 86_400_000) return { status: 'ok', message: 'Bank consent expires soon; reconnect to renew.' }
        }
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },

    async begin(ctx) {
      // Re-auth (update mode) when an existing connection is given: same Item, fresh login.
      const accessToken = ctx.connection ? secretOf(ctx.connection).accessToken : undefined
      // The OAuth redirect URI goes on every token, update mode included, or reconnecting at OAuth banks breaks.
      const { linkToken } = await this.createLinkToken({
        clientUserId: ctx.userRef,
        ...(accessToken ? { accessToken, ...(ctx.accountSelection ? { accountSelection: true } : {}) } : ctx.investmentsFirst ? { investmentsFirst: true } : {}),
        ...(opts.linkRedirectUri ? { redirectUri: opts.linkRedirectUri } : {}),
      })
      return { kind: 'link_widget', provider: 'plaid', token: linkToken }
    },

    async createLinkToken(req) {
      if (!req.clientUserId) throw new ConnectorError('invalid_input', 'clientUserId is required', { provider: 'plaid' })
      // Update mode (same Item, never a new one): the existing access_token and an empty products list. A new link:
      // Transactions required, Investments/Liabilities consented now and billed on first use. investmentsFirst (a
      // brokerage-only login): Investments required instead, Transactions consented for any cash account there.
      const consented = req.investmentsFirst
        ? (['transactions', ...(opts.consentedProducts ?? []).filter((p) => p !== 'investments')] as string[])
        : (opts.consentedProducts ?? [])
      const update = req.accessToken
        ? { access_token: req.accessToken, products: [], ...(req.accountSelection ? { update: { account_selection_enabled: true } } : {}) }
        : {
            products: [req.investmentsFirst ? 'investments' : 'transactions'],
            ...(consented.length ? { additional_consented_products: consented } : {}),
            transactions: { days_requested: Math.min(730, Math.max(1, opts.daysRequested ?? 730)) },
          }
      const d = await client.call<{ link_token: string; expiration: string }>(
        '/link/token/create',
        {
          client_name: opts.clientName ?? 'Aggregate',
          language: req.language ?? 'en',
          country_codes: opts.countryCodes ?? ['US'],
          user: { client_user_id: req.clientUserId },
          ...(opts.webhookUrl ? { webhook: opts.webhookUrl } : {}),
          ...(req.redirectUri ? { redirect_uri: req.redirectUri } : {}),
          ...update,
        },
        false,
      )
      return { linkToken: d.link_token, expiration: d.expiration }
    },

    async disconnect(conn) {
      await this.removeItem(conn)
    },

    async refreshBalances(conn) {
      const { accessToken } = secretOf(conn)
      const cfg = configOf(conn)
      const now = clock.now()
      // Capital One requires a freshness floor for non-depository accounts; older data comes back as an error, and then
      // the cached balances are the best there is.
      const capitalOne = cfg.institutionId === CAPITAL_ONE
      let res: PlaidAccountsGetResponse
      try {
        res = await client.call<PlaidAccountsGetResponse>('/accounts/balance/get', {
          access_token: accessToken,
          ...(capitalOne ? { options: { min_last_updated_datetime: new Date(now - 86_400_000).toISOString() } } : {}),
        })
      } catch (e) {
        if (!(isConnectorError(e) && e.code === 'LAST_UPDATED_DATETIME_OUT_OF_RANGE')) throw e
        res = await client.call<PlaidAccountsGetResponse>('/accounts/get', { access_token: accessToken })
      }
      const at = isoTimestamp(now)
      const events: NormalizedEvent[] = []
      for (const a of res.accounts) {
        const rawRef = await deps.raw.put(conn.id, 'plaid.balance', `${a.account_id}@${at}`, a)
        const bal = mapBalance(a, conn.id, rawRef, at)
        if (bal) events.push(bal)
      }
      return events
    },

    async removeItem(conn) {
      try {
        await client.call('/item/remove', { access_token: secretOf(conn).accessToken }, false)
      } catch (e) {
        // Already removed or token revoked: the Item is gone either way.
        if (isConnectorError(e) && (e.kind === 'auth' || e.code === 'ITEM_NOT_FOUND')) return
        throw e
      }
    },

    async sandboxPublicToken(institutionId = 'ins_109508', products = ['transactions'], o = {}) {
      if (client.env !== 'sandbox') throw new ConnectorError('permanent', 'sandbox only', { provider: 'plaid' })
      const d = await client.call<{ public_token: string }>(
        '/sandbox/public_token/create',
        {
          institution_id: institutionId,
          initial_products: products,
          // Sandbox test persona (user_good by default; e.g. user_transactions_dynamic for changing data).
          ...(o.username ? { options: { override_username: o.username, override_password: 'pass_good' } } : {}),
        },
        false,
      )
      return d.public_token
    },
  }
}
