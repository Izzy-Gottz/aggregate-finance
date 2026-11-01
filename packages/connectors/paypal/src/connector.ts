// PayPal connector: processor balances (per currency), every balance-affecting movement from Transaction Search,
// and invoices sent. Read-only.
//
// A sync cycle: one "balances" page (/v1/reporting/balances → account.upsert + balance.snapshot per currency), then
// /v1/reporting/transactions in windows of at most 31 days (PayPal's limit), page by page, from the high-water mark
// (3 years back on the first sync) up to the moment the cycle started. A window PayPal finds too big
// (RESULTSET_TOO_LARGE, ~10k rows) is halved and retried from the same start, then grows back after it succeeds; then /v2/invoicing/invoices pages. The next
// cycle re-reads the last 3 days, because PayPal's reporting lags up to ~3 hours and rows can change status.

import type { ConnectBegin, ConnectBeginContext, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, SyncResult } from '@agfn/contracts'
import {
  ConnectorError,
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
} from '@agfn/connector-sdk'
import { PayPalClient, RESULTSET_TOO_LARGE, type PayPalCredentials, type PayPalEnv } from './client.ts'
import { mapAccount, mapBalance, mapInvoice, mapTxn } from './map.ts'
import type { PayPalBalancesResponse, PayPalInvoicesResponse, PayPalSearchResponse } from './types.ts'
import { payPalWebhook } from './webhook.ts'

/** The company's own REST app, or (partner mode) only the seller's payer id: the token is always Aggregate's. */
export type PayPalSecret = PayPalAppSecret | PayPalPartnerSecret

export interface PayPalAppSecret {
  clientId: string
  clientSecret: string
}

export interface PayPalPartnerSecret {
  kind: 'partner'
  payerId: string
}

export interface PayPalConfig {
  env: PayPalEnv
  /** PayPal account id (payer id) from /v1/reporting/balances. */
  accountId: string
  currencies: string[]
  /** False when the app has no Invoicing permission (probed at connect). */
  invoices: boolean
  webhookId?: string
  warnings: string[]
}

export interface PayPalConnectorOptions {
  /** Transaction Search page size (max 500). */
  pageSize?: number
  /** Days of history on the first sync (Transaction Search keeps 3 years). */
  lookbackDays?: number
  /** Webhook id + the REST app that owns it; enables `webhook`. */
  webhookId?: string
  webhookApp?: PayPalCredentials
  /**
   * Partner mode (hosted one-click): Aggregate's approved partner REST app, its own merchant (payer) id, and the
   * environment. Sellers grant Transaction Search through PayPal's onboarding; no seller secrets are stored.
   */
  partner?: { clientId: string; clientSecret: string; merchantId: string; env: PayPalEnv; bnCode?: string }
}

/** Third-party features asked for in partner onboarding (read-only reporting + account details). */
export const PAYPAL_PARTNER_FEATURES = ['ADVANCED_TRANSACTIONS_SEARCH', 'ACCESS_MERCHANT_INFORMATION']
const SEARCH_SCOPE = 'https://uri.paypal.com/services/reporting/search/read'

export interface PayPalConnector extends Connector {
  begin(ctx?: ConnectBeginContext): Promise<ConnectBegin>
  readonly webhook?: ConnectorWebhook
  readonly client: PayPalClient
}

interface PayPalCursor {
  stage: 'balances' | 'txns' | 'invoices'
  acct: string
  /** Currencies whose account.upsert was emitted this cycle. */
  curs: string[]
  /** Start of the current Transaction Search window (ISO, seconds precision). */
  from: string | null
  page: number
  /** End of this cycle (when its balances page ran). */
  until: string | null
  /** Where the next cycle's transaction windows start. */
  hw: string | null
  inv: number
  /** Current Transaction Search window in days (1–31). Missing in cursors written before windows could shrink. */
  win?: number
}

const DAY = 86_400_000
const MAX_WINDOW_DAYS = 31
const OVERLAP_MS = 3 * DAY

const isCursor = (v: unknown): v is PayPalCursor =>
  isRecord(v) &&
  (v.stage === 'balances' || v.stage === 'txns' || v.stage === 'invoices') &&
  typeof v.acct === 'string' &&
  Array.isArray(v.curs) &&
  typeof v.page === 'number' &&
  typeof v.inv === 'number' &&
  (v.win === undefined || typeof v.win === 'number')

const isSecret = (v: unknown): v is PayPalSecret =>
  isRecord(v) &&
  ((v.kind === 'partner' && typeof v.payerId === 'string' && v.payerId !== '') ||
    (typeof v.clientId === 'string' && v.clientId !== '' && typeof v.clientSecret === 'string' && v.clientSecret !== ''))

/** RFC 3339 with whole seconds (PayPal requires seconds; we drop milliseconds). */
const rfc = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** Per-sync warning: invoices skipped because the app lacks the Invoicing permission. */
export const PAYPAL_NO_INVOICES_WARNING = "Invoices were skipped: this PayPal app doesn't have the Invoicing permission."

/**
 * Partner-mode seller whose grant doesn't cover /v1/reporting/balances. Which partner-referral feature grants
 * reporting/balances/read is unconfirmed (PayPal's docs only tie ADVANCED_TRANSACTIONS_SEARCH to Transaction Search),
 * so we treat a 403 there as expected and keep syncing transactions.
 */
export const PAYPAL_NO_BALANCES_WARNING = "Balances need PayPal's balance permission; transactions still sync"

export const PAYPAL_WRITE_WARNING =
  'PayPal REST app credentials can also send payments and payouts. Aggregate only calls read endpoints; for least privilege, use a dedicated app with only Transaction Search (and Invoicing) enabled.'

export function createPayPalConnector(opts: PayPalConnectorOptions, deps: ConnectorDeps): PayPalConnector {
  const client = new PayPalClient(deps)
  const clock: Clock = deps.clock ?? systemClock
  const codec = cursorCodec<PayPalCursor>('paypal', 1, isCursor)
  const pageSize = Math.min(500, Math.max(1, opts.pageSize ?? 500))
  const lookbackMs = Math.min(3 * 365, Math.max(1, opts.lookbackDays ?? 3 * 365)) * DAY

  const description: ConnectorDescription = {
    key: 'paypal',
    name: 'PayPal',
    group: 'payments',
    provides: ['balances', 'transactions', 'invoices'],
    freshness: 'updates every few hours; PayPal balances and transactions lag up to ~3 hours behind live activity',
    auth: opts.partner ? 'oauth' : 'api_key',
  }

  const configOf = (conn: ConnectionRef): PayPalConfig => {
    const c = conn.config
    const env: PayPalEnv = c.env === 'sandbox' ? 'sandbox' : 'live'
    const webhookId = str(c.webhookId)
    return {
      env,
      accountId: str(c.accountId) ?? '',
      currencies: Array.isArray(c.currencies) ? c.currencies.filter((x): x is string => typeof x === 'string') : [],
      invoices: c.invoices !== false,
      warnings: Array.isArray(c.warnings) ? c.warnings.filter((x): x is string => typeof x === 'string') : [],
      ...(webhookId ? { webhookId } : {}),
    }
  }
  const partner = opts.partner
  const partnerCreds = (payerId: string): PayPalCredentials => {
    if (!partner) throw new ConnectorError('auth', 'PayPal partner sign-in is not configured on this server; reconnect with your own PayPal app', { provider: 'paypal', forUser: true })
    return { clientId: partner.clientId, clientSecret: partner.clientSecret, env: partner.env, payerId, ...(partner.bnCode ? { bnCode: partner.bnCode } : {}) }
  }
  /** Partner-level calls (referrals, onboarding status) are made as ourselves: our token, no assertion. */
  const partnerSelf = (): PayPalCredentials => {
    const { payerId: _p, ...self } = partnerCreds('')
    return self
  }
  const isForbidden = (e: unknown) => isConnectorError(e) && e.kind === 'auth' && e.status === 403
  const credsOf = (conn: ConnectionRef): PayPalCredentials => {
    const s = requireSecret('paypal', conn.secret, isSecret)
    if ('kind' in s) return partnerCreds(s.payerId)
    return { clientId: s.clientId, clientSecret: s.clientSecret, env: configOf(conn).env }
  }

  async function balancesPage(conn: ConnectionRef, state: PayPalCursor): Promise<SyncResult> {
    const creds = credsOf(conn)
    const cfg = configOf(conn)
    const now = clock.now()
    const from = state.hw ?? rfc(now - lookbackMs)
    const txns = (acct: string, curs: string[]): PayPalCursor => ({ ...state, stage: 'txns', acct, curs, from, page: 1, until: rfc(now), inv: 1 })
    let res: PayPalBalancesResponse
    try {
      res = await client.get<PayPalBalancesResponse>(creds, '/v1/reporting/balances')
    } catch (e) {
      // Partner seller without the balance permission: transactions still sync; their accounts come from the rows.
      if (creds.payerId && isForbidden(e)) {
        return { events: [], cursor: codec.encode(txns(cfg.accountId || state.acct || creds.payerId, [])), hasMore: true, warnings: [PAYPAL_NO_BALANCES_WARNING] }
      }
      throw e
    }
    const acct = res.account_id || cfg.accountId || state.acct || 'paypal'
    const at = isoTimestamp(res.as_of_time ?? now)
    const day = isoTimestamp(now).slice(0, 10)
    const events: NormalizedEvent[] = []
    const curs: string[] = []
    for (const b of res.balances ?? []) {
      const cur = normalizeCurrency(b.currency)
      const rawRef = await deps.raw.put(conn.id, 'paypal.balance', `${acct}:${cur}@${day}`, b)
      if (!curs.includes(cur)) {
        events.push(mapAccount(acct, cur, conn.id, rawRef))
        curs.push(cur)
      }
      events.push(mapBalance(acct, b, conn.id, rawRef, at, day))
    }
    return { events, cursor: codec.encode(txns(acct, curs)), hasMore: true }
  }

  async function txnsPage(conn: ConnectionRef, state: PayPalCursor): Promise<SyncResult> {
    const creds = credsOf(conn)
    const until = Date.parse(state.until ?? rfc(clock.now()))
    const from = Date.parse(state.from ?? rfc(until - lookbackMs))
    const win = Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.floor(state.win ?? MAX_WINDOW_DAYS)))
    const end = Math.min(from + win * DAY - 1000, until)
    let res: PayPalSearchResponse
    try {
      res = await client.get<PayPalSearchResponse>(creds, '/v1/reporting/transactions', {
        start_date: rfc(from),
        end_date: rfc(end),
        fields: 'all',
        balance_affecting_records_only: 'Y',
        page_size: pageSize,
        page: state.page,
      })
    } catch (e) {
      if (!(isConnectorError(e) && e.code === RESULTSET_TOO_LARGE)) throw e
      // Without this, a busy seller's backfill hits the same oversized window forever. Halve it and retry from the
      // same start; a single day that is still too big can't be split further.
      if (win <= 1) {
        throw new ConnectorError('permanent', `PayPal has too many transactions on ${rfc(from).slice(0, 10)} to list (Transaction Search returns about 10,000 per request), so this sync can't continue past that day.`, {
          provider: 'paypal',
          forUser: true,
          status: e.status ?? 400,
          code: RESULTSET_TOO_LARGE,
          cause: e,
        })
      }
      return { events: [], cursor: codec.encode({ ...state, page: 1, win: Math.max(1, Math.floor(win / 2)) }), hasMore: true }
    }
    const events: NormalizedEvent[] = []
    const curs = [...state.curs]
    for (const d of res.transaction_details ?? []) {
      const id = d.transaction_info?.transaction_id
      if (!id) continue
      const rawRef = await deps.raw.put(conn.id, 'paypal.transaction', id, d)
      const ev = mapTxn(d, state.acct, conn.id, rawRef)
      if (!ev) continue
      const cur = ev.net.currency
      if (!curs.includes(cur)) {
        // A currency with no balance row (e.g. converted away to zero): it still needs an account.
        events.push(mapAccount(state.acct, cur, conn.id, rawRef))
        curs.push(cur)
      }
      events.push(ev)
    }
    const totalPages = res.total_pages ?? 1
    if (state.page < totalPages) {
      return { events, cursor: codec.encode({ ...state, curs, page: state.page + 1 }), hasMore: true }
    }
    if (end < until) {
      // A shrunken window worked: grow back toward 31 days, since busy stretches are usually short.
      const grown = Math.min(MAX_WINDOW_DAYS, win * 2)
      const { win: _w, ...rest } = state
      return { events, cursor: codec.encode({ ...rest, curs, from: rfc(end + 1000), page: 1, ...(grown < MAX_WINDOW_DAYS ? { win: grown } : {}) }), hasMore: true }
    }
    const hw = rfc(until - OVERLAP_MS)
    if (configOf(conn).invoices) {
      return { events, cursor: codec.encode({ ...state, curs, stage: 'invoices', hw, inv: 1 }), hasMore: true }
    }
    return { events, cursor: codec.encode(doneState({ ...state, hw })), hasMore: false, warnings: [PAYPAL_NO_INVOICES_WARNING] }
  }

  async function invoicesPage(conn: ConnectionRef, state: PayPalCursor): Promise<SyncResult> {
    const creds = credsOf(conn)
    let res: PayPalInvoicesResponse
    try {
      res = await client.get<PayPalInvoicesResponse>(creds, '/v2/invoicing/invoices', { page: state.inv, page_size: 100, total_required: true })
    } catch (e) {
      // Invoicing permission removed from the app since connect: balances and transactions still sync.
      if (isConnectorError(e) && e.kind === 'auth' && e.status === 403) {
        return { events: [], cursor: codec.encode(doneState(state)), hasMore: false, warnings: [PAYPAL_NO_INVOICES_WARNING] }
      }
      throw e
    }
    const events: NormalizedEvent[] = []
    const fallback = (state.until ?? rfc(clock.now())).slice(0, 10)
    for (const inv of res.items ?? []) {
      const rawRef = await deps.raw.put(conn.id, 'paypal.invoice', inv.id, inv)
      events.push(mapInvoice(inv, conn.id, rawRef, fallback))
    }
    // PayPal caps page at 1000 (100k invoices).
    if (state.inv < (res.total_pages ?? 1) && state.inv < 1000) {
      return { events, cursor: codec.encode({ ...state, inv: state.inv + 1 }), hasMore: true }
    }
    return { events, cursor: codec.encode(doneState(state)), hasMore: false }
  }

  const doneState = (s: PayPalCursor): PayPalCursor => ({ stage: 'balances', acct: s.acct, curs: [], from: null, page: 1, until: null, hw: s.hw, inv: 1 })

  const webhook = opts.webhookId && opts.webhookApp ? payPalWebhook(client, { webhookId: opts.webhookId, app: opts.webhookApp }) : undefined

  /** Currencies on the first page of the last 31 days of transactions; empty when there are none or it fails. */
  async function recentCurrencies(creds: PayPalCredentials): Promise<string[]> {
    const now = clock.now()
    try {
      const res = await client.get<PayPalSearchResponse>(creds, '/v1/reporting/transactions', {
        start_date: rfc(now - MAX_WINDOW_DAYS * DAY + 1000),
        end_date: rfc(now),
        fields: 'transaction_info',
        page_size: pageSize,
        page: 1,
      })
      const curs = (res.transaction_details ?? []).map((d) => d.transaction_info?.transaction_amount?.currency_code).filter((c): c is string => !!c)
      return [...new Set(curs.map((c) => normalizeCurrency(c)))]
    } catch {
      // Currencies are a display hint; sync finds them from the rows anyway.
      return []
    }
  }

  /**
   * Finish partner onboarding: PayPal says which seller came back; we confirm with PayPal that this seller onboarded
   * through THIS attempt (tracking_id = our state) and granted Transaction Search, then read balances as them.
   */
  async function connectPartner(seller: string, state: string | undefined, permissionsGranted: string | undefined): Promise<import('@agfn/contracts').ConnectResult> {
    if (!partner) throw new ConnectorError('invalid_input', 'PayPal partner sign-in is not configured on this server', { provider: 'paypal' })
    if (permissionsGranted === 'false') throw new ConnectorError('invalid_input', 'PayPal access wasn’t granted. Start again and allow Aggregate to read your transactions.', { provider: 'paypal' })
    if (!/^[A-Z0-9]{8,20}$/.test(seller)) throw new ConnectorError('invalid_input', 'PayPal returned an unexpected merchant id', { provider: 'paypal' })
    const status = await client.get<{ tracking_id?: string; oauth_integrations?: Array<{ oauth_third_party?: Array<{ partner_client_id?: string; scopes?: string[] }> }> }>(
      partnerSelf(),
      `/v1/customer/partners/${encodeURIComponent(partner.merchantId)}/merchant-integrations/${encodeURIComponent(seller)}`,
    )
    if (!state || status.tracking_id !== state) throw new ConnectorError('auth', 'That PayPal sign-in doesn’t match this connection attempt. Start again.', { provider: 'paypal' })
    const scopes = (status.oauth_integrations ?? []).flatMap((o) => o.oauth_third_party ?? []).flatMap((t) => t.scopes ?? [])
    if (!scopes.includes(SEARCH_SCOPE)) throw new ConnectorError('invalid_input', 'PayPal didn’t grant transaction history access. Start again and allow it.', { provider: 'paypal' })
    const creds = partnerCreds(seller)
    const warnings: string[] = []
    let accountId = seller
    let currencies: string[]
    try {
      const bal = await client.get<PayPalBalancesResponse>(creds, '/v1/reporting/balances')
      accountId = bal.account_id ?? seller
      currencies = [...new Set((bal.balances ?? []).map((b) => normalizeCurrency(b.currency)))]
    } catch (e) {
      if (!isForbidden(e)) throw e
      // No balance permission (see PAYPAL_NO_BALANCES_WARNING): take currencies from recent transactions instead.
      warnings.push(PAYPAL_NO_BALANCES_WARNING)
      currencies = await recentCurrencies(creds)
    }
    const secret: PayPalPartnerSecret = { kind: 'partner', payerId: seller }
    // Partner onboarding asks for reporting only: no invoice access, and nothing that can move money.
    const config: PayPalConfig = { env: partner.env, accountId, currencies, invoices: false, warnings }
    return { secret, config: { ...config } }
  }

  return {
    client,
    ...(webhook ? { webhook } : {}),
    describe: () => description,

    async begin(ctx) {
      if (partner && ctx) {
        // tracking_id = our single-use state; return_url carries it back so the callback finds this attempt.
        const ret = new URL(ctx.redirectUri)
        ret.searchParams.set('state', ctx.state)
        const res = await client.request<{ links?: Array<{ rel?: string; href?: string }> }>(partnerSelf(), {
          method: 'POST',
          path: '/v2/customer/partner-referrals',
          json: {
            tracking_id: ctx.state,
            operations: [
              {
                operation: 'API_INTEGRATION',
                api_integration_preference: { rest_api_integration: { integration_method: 'PAYPAL', integration_type: 'THIRD_PARTY', third_party_details: { features: PAYPAL_PARTNER_FEATURES } } },
              },
            ],
            legal_consents: [{ type: 'SHARE_DATA_CONSENT', granted: true }],
            partner_config_override: { return_url: ret.toString() },
          },
          idempotent: false,
        })
        const url = (res.links ?? []).find((l) => l.rel === 'action_url')?.href
        if (!url) throw new ConnectorError('permanent', 'PayPal did not return an onboarding link', { provider: 'paypal' })
        return { kind: 'oauth', url }
      }
      return {
        kind: 'api_key',
        label: 'PayPal REST app',
        steps: [
          'Sign in to developer.paypal.com with your business PayPal login and open Apps & Credentials → Live.',
          'Create an app named “Aggregate” (type Merchant).',
          'In the app’s features, turn on Transaction search and save. PayPal can take a few hours to start answering.',
          'Copy the Client ID and Secret into the fields here.',
        ],
        permissions: [
          'Aggregate only reads transaction history and balances. REST app credentials can’t be limited further, so keep them private.',
        ],
        helpUrl: 'https://developer.paypal.com/dashboard/applications/live',
        placeholder: 'Client ID, then secret',
        fields: [
          { name: 'clientId', label: 'Client ID', placeholder: 'A…' },
          { name: 'clientSecret', label: 'Secret', secret: true },
          { name: 'env', label: 'Environment', options: ['live', 'sandbox'] },
        ],
      }
    },

    async connect(input) {
      // Partner onboarding return: PayPal appends merchantIdInPayPal (and merchantId = our tracking id) to return_url.
      const seller = str(input.merchantIdInPayPal)?.trim()
      if (seller) return connectPartner(seller, str(input.state) ?? (isRecord(input.query) ? str(input.query.state) : undefined), str(input.permissionsGranted))
      const clientId = str(input.clientId)?.trim()
      const clientSecret = str(input.clientSecret)?.trim()
      const envIn = input.env ?? 'live'
      if (!clientId || !clientSecret) throw new ConnectorError('invalid_input', 'clientId and clientSecret are required', { provider: 'paypal' })
      if (envIn !== 'live' && envIn !== 'sandbox') throw new ConnectorError('invalid_input', "env must be 'live' or 'sandbox'", { provider: 'paypal' })
      if (!/^[A-Za-z0-9_-]{20,128}$/.test(clientId)) throw new ConnectorError('invalid_input', 'that does not look like a PayPal client ID', { provider: 'paypal' })
      const env: PayPalEnv = envIn
      const creds: PayPalCredentials = { clientId, clientSecret, env }
      // One harmless read: proves the credentials and that Transaction Search reporting is enabled.
      const bal = await client.get<PayPalBalancesResponse>(creds, '/v1/reporting/balances')
      const warnings = [PAYPAL_WRITE_WARNING]
      let invoices = true
      try {
        await client.get(creds, '/v2/invoicing/invoices', { page: 1, page_size: 1 })
      } catch (e) {
        if (!(isConnectorError(e) && e.kind === 'auth' && e.status === 403)) throw e
        invoices = false
        warnings.push('Invoicing is not enabled on this PayPal app, so invoices will not sync.')
      }
      const currencies = [...new Set((bal.balances ?? []).map((b) => normalizeCurrency(b.currency)))]
      const secret: PayPalSecret = { clientId, clientSecret }
      const config: PayPalConfig = {
        env,
        accountId: bal.account_id ?? '',
        currencies,
        invoices,
        warnings,
        ...(opts.webhookId && opts.webhookApp?.clientId === clientId ? { webhookId: opts.webhookId } : {}),
      }
      return { secret, config: { ...config } }
    },

    async sync(conn, cursor) {
      const state = codec.decode(cursor) ?? { stage: 'balances', acct: '', curs: [], from: null, page: 1, until: null, hw: null, inv: 1 }
      if (state.stage === 'balances') return balancesPage(conn, state)
      if (state.stage === 'txns') return txnsPage(conn, state)
      return invoicesPage(conn, state)
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        const creds = credsOf(conn)
        try {
          await client.get(creds, '/v1/reporting/balances')
        } catch (e) {
          if (!(creds.payerId && isForbidden(e))) throw e
          // Partner seller without the balance permission: the connection is healthy if Transaction Search answers.
          const now = clock.now()
          await client.get(creds, '/v1/reporting/transactions', { start_date: rfc(now - DAY), end_date: rfc(now), fields: 'transaction_info', page_size: 1, page: 1 })
          return { status: 'ok', message: PAYPAL_NO_BALANCES_WARNING }
        }
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },
  }
}
