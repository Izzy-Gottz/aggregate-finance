// Shopify Payments connector (per store): Shopify Payments balances, every balance transaction (charges, refunds,
// fees, disputes, adjustments with gross/fee/net and the payout that settled them) and the payouts. Read-only,
// GraphQL Admin API only.
//
// Auth: a custom app's Admin API access token + the shop domain, or the OAuth install flow (shop-specific authorize
// URL, callback HMAC validated, offline token; expiring offline tokens are refreshed and returned as updatedSecret).
//
// A sync cycle: "account" (balance per currency → account.upsert + balance.snapshot), then balanceTransactions pages
// newest first until older than the high-water mark (minus 3 days of overlap), then payouts pages the same way.
// If Shopify denies access to balanceTransactions (a known scope problem on some stores), the cycle degrades to one
// row per payout summary category instead, and connect() records a warning.

import type { ConnectBegin, ConnectBeginContext, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, SyncResult } from '@agfn/contracts'
import {
  ConnectorError,
  OAuthClient,
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
  type OAuthTokens,
} from '@agfn/connector-sdk'
import { SHOPIFY_SCOPES, ShopifyClient, normalizeShop } from './client.ts'
import { mapAccount, mapBalance, mapBalanceTxn, mapPayout, mapPayoutSummary } from './map.ts'
import type { PageInfo, ShopifyBalanceTransaction, ShopifyPaymentsAccountInfo, ShopifyPayout } from './types.ts'
import { shopifyWebhook, verifyShopifyInstall, verifyShopifyOAuthCallback } from './webhook.ts'
import { verifyShopifySessionToken } from './session-token.ts'

export interface ShopifySecret {
  accessToken: string
  /** Only for expiring offline tokens. */
  refreshToken?: string
  /** Epoch ms (expiring offline tokens only). */
  expiresAt?: number
  /**
   * Self-host: the store owner's own Dev Dashboard app (client credentials grant, ~24 h tokens fetched again when
   * they expire). Static admin tokens can't be created for new stores since 2026-01-01.
   */
  appClientId?: string
  appClientSecret?: string
}

export interface ShopifyConfig {
  shop: string
  shopName?: string
  /** False when balanceTransactions was access-denied at connect (sync uses payout summaries). */
  balanceTransactions: boolean
  warnings: string[]
}

export interface ShopifyConnectorOptions {
  /** OAuth app credentials (install flow, token refresh, and the default webhook secret). */
  clientId?: string
  clientSecret?: string
  /** Secret Shopify signs webhooks with; defaults to clientSecret. */
  webhookSecret?: string
  /**
   * Where Shopify sends this app's webhooks (`${BASE_URL}/api/webhooks/shopify`). With the legacy install flow Shopify
   * refuses app-wide subscriptions, so app/uninstalled is subscribed per shop after each OAuth install.
   */
  webhookUrl?: string
  pageSize?: number
  /** Hosted service: a store's own-app token must be read-only (Aggregate's own app asks only for read scopes). */
  hosted?: boolean
}

export interface ShopifyConnector extends Connector {
  begin(ctx: ConnectBeginContext): Promise<ConnectBegin>
  readonly webhook?: ConnectorWebhook
  readonly client: ShopifyClient
  /** Install from Shopify: verify the signed install link and return its shop (throws when forged or stale). */
  verifyInstall?(query: Record<string, string>): string
  /** The shop's OAuth consent URL (installs start from Shopify, so the shop is known). */
  authorizeUrl?(shop: string, redirectUri: string, state: string): string
  /** The app's client id (App Bridge's `shopify-api-key`), for the embedded admin page. */
  readonly apiKey?: string
  /** An embedded admin page's session token (App Bridge idToken): the shop it's for. Throws when it isn't valid. */
  verifySessionToken?(token: string): string
  /**
   * Managed install: exchange a verified session token for the store's expiring offline token (Shopify installed the
   * app with the scopes in shopify.app.toml; there is no OAuth redirect).
   */
  exchangeSessionToken?(shop: string, sessionToken: string): Promise<ShopifySecret>
  /**
   * The email of the Shopify staff member a session token belongs to: an online token exchange returns it as
   * `associated_user`. The token itself is thrown away (only the email is kept). Undefined when Shopify sends none.
   */
  staffEmail?(shop: string, sessionToken: string): Promise<string | undefined>
}

interface ShopifyCursor {
  stage: 'account' | 'txns' | 'payouts'
  shop: string
  curs: string[]
  after: string | null
  /** Rows older than this end the newest-first walk. Null = full history. */
  stop: string | null
  cycle: string | null
  hw: string | null
  /** balanceTransactions denied this cycle: emit payout summaries. */
  summary: boolean
}

const DAY = 86_400_000
// A balance transaction gets its payout link when a payout includes it, and a payout can fail after it's issued:
// both can happen well after the sale (weekly or monthly payouts, held funds), so each cycle re-reads 35 days.
const OVERLAP_MS = 35 * DAY

export const SHOPIFY_DEGRADED_WARNING =
  'Shopify denied access to Shopify Payments balance transactions for this store (the app has the payouts scope; the store or the installing staff account may not allow it). Aggregate uses each payout\'s summary instead: per-payout totals, no per-order detail, and nothing until a payout is issued.'

/** Per-sync warning while degraded to payout summaries. */
/** A store without Shopify Payments (most dev and review stores): connected, nothing to show yet, never "zero". */
export const SHOPIFY_WRITE_REFUSED = (scopes: string[]): string =>
  `This Shopify app can also make changes (${scopes.join(', ')}). Aggregate only accepts read-only access: give the app only the read scopes shown, reinstall it, and try again.`

export const SHOPIFY_NO_PAYMENTS_NOTE = "Shopify Payments isn't turned on for this store yet, so there are no payouts to show. Aggregate will pick them up once it is."

export const SHOPIFY_SUMMARY_SYNC_WARNING =
  'Shopify denied access to balance transactions for this store, so only payout summaries were synced.'

const isCursor = (v: unknown): v is ShopifyCursor =>
  isRecord(v) && ['account', 'txns', 'payouts'].includes(v.stage as string) && typeof v.shop === 'string' && Array.isArray(v.curs) && typeof v.summary === 'boolean'

const isSecret = (v: unknown): v is ShopifySecret => isRecord(v) && typeof v.accessToken === 'string' && v.accessToken !== ''

const MONEY = 'amount currencyCode'

export const ACCOUNT_QUERY = `query AggregateAccount {
  shop { name myshopifyDomain currencyCode }
  shopifyPaymentsAccount { id activated defaultCurrency balance { ${MONEY} } }
}`

export const TXNS_QUERY = `query AggregateBalanceTxns($first: Int!, $after: String) {
  shopifyPaymentsAccount {
    balanceTransactions(first: $first, after: $after, reverse: true) {
      nodes {
        id type test transactionDate sourceType sourceId sourceOrderTransactionId adjustmentReason
        amount { ${MONEY} } fee { ${MONEY} } net { ${MONEY} }
        associatedPayout { id status }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`

export const PAYOUTS_QUERY = `query AggregatePayouts($first: Int!, $after: String) {
  shopifyPaymentsAccount {
    payouts(first: $first, after: $after, reverse: true) {
      nodes {
        id legacyResourceId issuedAt status transactionType net { ${MONEY} }
        summary {
          adjustmentsFee { ${MONEY} } adjustmentsGross { ${MONEY} } advanceFees { ${MONEY} } advanceGross { ${MONEY} }
          chargesFee { ${MONEY} } chargesGross { ${MONEY} } refundsFee { ${MONEY} } refundsFeeGross { ${MONEY} }
          reservedFundsFee { ${MONEY} } reservedFundsGross { ${MONEY} } retriedPayoutsFee { ${MONEY} } retriedPayoutsGross { ${MONEY} }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`

export const SCOPES_QUERY = `query AggregateScopes { currentAppInstallation { accessScopes { handle } } }`

type AccountData = { shop?: { name?: string; myshopifyDomain?: string; currencyCode?: string }; shopifyPaymentsAccount: ShopifyPaymentsAccountInfo | null }
type Conn<T> = { nodes: T[]; pageInfo: PageInfo }
type TxnsData = { shopifyPaymentsAccount: { balanceTransactions: Conn<ShopifyBalanceTransaction> | null } | null }
type PayoutsData = { shopifyPaymentsAccount: { payouts: Conn<ShopifyPayout> | null } | null }

export function createShopifyConnector(opts: ShopifyConnectorOptions, deps: ConnectorDeps): ShopifyConnector {
  const client = new ShopifyClient(deps)
  const clock: Clock = deps.clock ?? systemClock
  const codec = cursorCodec<ShopifyCursor>('shopify', 1, isCursor)
  const pageSize = Math.min(250, Math.max(1, opts.pageSize ?? 100))
  const webhookSecret = opts.webhookSecret ?? opts.clientSecret

  const description: ConnectorDescription = {
    key: 'shopify',
    name: 'Shopify Payments',
    group: 'payments',
    provides: ['balances', 'transactions'],
    // Shopify has no payout webhook topic, and order/dispute topics need scopes we don't ask for: polling only.
    freshness: 'updates every few hours',
    auth: 'oauth',
  }

  const configOf = (conn: ConnectionRef): ShopifyConfig => {
    const c = conn.config
    const shop = normalizeShop(c.shop)
    if (!shop) throw new ConnectorError('invalid_input', 'connection has no valid shop domain', { provider: 'shopify' })
    const shopName = str(c.shopName)
    return {
      shop,
      balanceTransactions: c.balanceTransactions !== false,
      warnings: Array.isArray(c.warnings) ? c.warnings.filter((x): x is string => typeof x === 'string') : [],
      ...(shopName ? { shopName } : {}),
    }
  }

  function oauth(shop: string, redirectUri = '', app = opts.clientId && opts.clientSecret ? { id: opts.clientId, secret: opts.clientSecret } : undefined): OAuthClient {
    if (!app) throw new ConnectorError('invalid_input', 'Shopify OAuth is not configured (clientId/clientSecret)', { provider: 'shopify' })
    return new OAuthClient({
      provider: 'shopify',
      authorizeUrl: `https://${shop}/admin/oauth/authorize`,
      tokenUrl: `https://${shop}/admin/oauth/access_token`,
      clientId: app.id,
      clientSecret: app.secret,
      redirectUri,
      scopes: SHOPIFY_SCOPES,
      scopeSeparator: ',',
      clientAuth: 'body',
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      clock,
    })
  }

  const toSecret = (t: OAuthTokens): ShopifySecret => ({
    accessToken: t.accessToken,
    ...(t.refreshToken ? { refreshToken: t.refreshToken } : {}),
    ...(t.expiresAt !== undefined ? { expiresAt: t.expiresAt } : {}),
  })

  /** The store owner's own app: fetch a fresh ~24 h token with the client credentials grant. */
  async function ownAppToken(shop: string, id: string, secret: string): Promise<ShopifySecret> {
    const t = await oauth(shop, '', { id, secret }).clientCredentials()
    return { ...toSecret(t), appClientId: id, appClientSecret: secret }
  }

  /** Refresh an expiring offline token (or the owner's-app token) shortly before expiry. Others pass through. */
  async function usableSecret(conn: ConnectionRef, shop: string): Promise<{ secret: ShopifySecret; updated?: ShopifySecret }> {
    const s = requireSecret('shopify', conn.secret, isSecret)
    if (s.appClientId && s.appClientSecret) {
      if (s.expiresAt !== undefined && s.expiresAt - 5 * 60_000 > clock.now()) return { secret: s }
      const next = await ownAppToken(shop, s.appClientId, s.appClientSecret)
      return { secret: next, updated: next }
    }
    if (s.expiresAt === undefined || !s.refreshToken) return { secret: s }
    const o = oauth(shop)
    const { tokens, refreshed } = await o.ensureFresh({ accessToken: s.accessToken, refreshToken: s.refreshToken, expiresAt: s.expiresAt }, 5 * 60_000)
    if (!refreshed) return { secret: s }
    const next = toSecret(tokens)
    return { secret: next, updated: next }
  }

  /** The store and its Shopify Payments account; `shopifyPaymentsAccount` is null until Payments is turned on. */
  async function accountInfo(shop: string, token: string): Promise<AccountData & { shopifyPaymentsAccount: ShopifyPaymentsAccountInfo | null }> {
    const d = await client.graphql<AccountData>(shop, token, ACCOUNT_QUERY)
    return { ...d, shopifyPaymentsAccount: d.shopifyPaymentsAccount ?? null }
  }

  const older = (iso: string, stop: string | null) => stop !== null && Date.parse(iso) < Date.parse(stop)

  async function step(conn: ConnectionRef, token: string, s: ShopifyCursor): Promise<SyncResult> {
    const cfg = configOf(conn)
    const shop = cfg.shop
    const events: NormalizedEvent[] = []
    const enc = (st: ShopifyCursor, hasMore = true): SyncResult => ({ events, cursor: codec.encode(st), hasMore })
    const account = async (st: ShopifyCursor, cur: string, rawRef: string) => {
      if (st.curs.includes(cur)) return
      st.curs.push(cur)
      events.push(mapAccount(shop, cur, conn.id, rawRef))
    }

    if (s.stage === 'account') {
      const now = clock.now()
      const at = isoTimestamp(now)
      const d = await accountInfo(shop, token)
      // No Payments account yet: nothing to sync, and nothing is "gone". Stay at this stage; the next sync looks again.
      if (!d.shopifyPaymentsAccount) return { events: [], cursor: codec.encode(s), hasMore: false, warnings: [SHOPIFY_NO_PAYMENTS_NOTE] }
      const pa = d.shopifyPaymentsAccount
      const st: ShopifyCursor = {
        stage: cfg.balanceTransactions ? 'txns' : 'payouts', shop, curs: [], after: null,
        stop: s.hw, cycle: at, hw: s.hw, summary: !cfg.balanceTransactions,
      }
      const rawRef = await deps.raw.put(conn.id, 'shopify.payments_account', `${pa.id}@${at.slice(0, 10)}`, pa)
      const balances = pa.balance.length ? pa.balance : [{ amount: '0', currencyCode: pa.defaultCurrency ?? d.shop?.currencyCode ?? 'USD' }]
      for (const b of balances) {
        await account(st, normalizeCurrency(b.currencyCode), rawRef)
        events.push(mapBalance(shop, b, conn.id, rawRef, at))
      }
      // Known at connect that balanceTransactions is denied: the whole cycle runs on payout summaries.
      return cfg.balanceTransactions ? enc(st) : { ...enc(st), warnings: [SHOPIFY_SUMMARY_SYNC_WARNING] }
    }

    const fallbackCur = s.curs[0] ?? 'USD'

    if (s.stage === 'txns') {
      let d: TxnsData
      try {
        d = await client.graphql<TxnsData>(shop, token, TXNS_QUERY, { first: pageSize, after: s.after })
      } catch (e) {
        if (isConnectorError(e) && e.code === 'ACCESS_DENIED') {
          return { ...enc({ ...s, stage: 'payouts', after: null, summary: true }), warnings: [SHOPIFY_SUMMARY_SYNC_WARNING] }
        }
        throw e
      }
      const conn_ = d.shopifyPaymentsAccount?.balanceTransactions
      const st: ShopifyCursor = { ...s, curs: [...s.curs] }
      let reachedOld = false
      for (const t of conn_?.nodes ?? []) {
        if (older(t.transactionDate, s.stop)) {
          reachedOld = true
          break
        }
        const rawRef = await deps.raw.put(conn.id, 'shopify.balance_transaction', t.id, t)
        const ev = mapBalanceTxn(t, shop, fallbackCur, conn.id, rawRef)
        if (!ev) continue
        await account(st, ev.net.currency, rawRef)
        events.push(ev)
      }
      if (!reachedOld && conn_?.pageInfo.hasNextPage && conn_.pageInfo.endCursor) return enc({ ...st, after: conn_.pageInfo.endCursor })
      return enc({ ...st, stage: 'payouts', after: null })
    }

    // payouts
    // Each payout carries ~15 money objects: 50 a page keeps the query under Shopify's 1,000-point cost limit.
    const d = await client.graphql<PayoutsData>(shop, token, PAYOUTS_QUERY, { first: Math.min(pageSize, 50), after: s.after })
    const conn_ = d.shopifyPaymentsAccount?.payouts
    const st: ShopifyCursor = { ...s, curs: [...s.curs] }
    let reachedOld = false
    for (const p of conn_?.nodes ?? []) {
      if (older(p.issuedAt, s.stop)) {
        reachedOld = true
        break
      }
      const rawRef = await deps.raw.put(conn.id, 'shopify.payout', p.id, p)
      const ev = mapPayout(p, shop, conn.id, rawRef)
      await account(st, ev.net.currency, rawRef)
      events.push(ev)
      if (s.summary) events.push(...mapPayoutSummary(p, shop, conn.id, rawRef))
    }
    if (!reachedOld && conn_?.pageInfo.hasNextPage && conn_.pageInfo.endCursor) return enc({ ...st, after: conn_.pageInfo.endCursor })
    const hw = isoTimestamp(Date.parse(s.cycle ?? isoTimestamp(clock.now())) - OVERLAP_MS)
    return enc({ stage: 'account', shop, curs: [], after: null, stop: null, cycle: null, hw, summary: false }, false)
  }

  /** Probe used at connect: is balanceTransactions readable, and does the token carry write scopes? */
  /**
   * Subscribe this shop's app/uninstalled to our webhook URL. Idempotent: "already taken" (installed before) is fine.
   * Never fails the connect: a missed subscription only means an uninstall shows up at the next sync (401) instead.
   */
  async function subscribeUninstall(shop: string, token: string, callbackUrl: string): Promise<void> {
    try {
      const r = await client.graphql<{ webhookSubscriptionCreate?: { userErrors?: Array<{ message?: string }>; webhookSubscription?: { id?: string } | null } }>(shop, token, UNINSTALL_SUBSCRIBE, { callbackUrl })
      const errs = (r.webhookSubscriptionCreate?.userErrors ?? []).map((e) => e.message ?? '').filter((m) => !/already been taken|already exists/i.test(m))
      if (errs.length) console.warn('[agfn] shopify app/uninstalled subscription refused', { shop, reason: errs.join('; ').slice(0, 200) })
    } catch (e) {
      console.warn('[agfn] shopify app/uninstalled subscription failed', { shop, reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) })
    }
  }

  async function probe(shop: string, token: string): Promise<{ balanceTransactions: boolean; warnings: string[] }> {
    const warnings: string[] = []
    let balanceTransactions = true
    try {
      await client.graphql(shop, token, TXNS_QUERY, { first: 1, after: null })
    } catch (e) {
      if (!(isConnectorError(e) && e.code === 'ACCESS_DENIED')) throw e
      balanceTransactions = false
      warnings.push(SHOPIFY_DEGRADED_WARNING)
    }
    try {
      const writes = await writeScopes(shop, token)
      if (writes.length) warnings.push(`This Shopify token can also write (${writes.join(', ')}). Aggregate only reads; a token with read scopes only is safer.`)
    } catch (e) {
      if (!isConnectorError(e) || e.kind === 'transient' || e.kind === 'rate_limited') throw e
    }
    return { balanceTransactions, warnings }
  }

  async function writeScopes(shop: string, token: string): Promise<string[]> {
    const d = await client.graphql<{ currentAppInstallation?: { accessScopes?: Array<{ handle: string }> } }>(shop, token, SCOPES_QUERY)
    return (d.currentAppInstallation?.accessScopes ?? []).map((x) => x.handle).filter((h) => h.startsWith('write_'))
  }

  const webhook = webhookSecret ? shopifyWebhook(webhookSecret) : undefined

  return {
    client,
    ...(webhook ? { webhook } : {}),
    ...(opts.clientId && opts.clientSecret
      ? {
          verifyInstall: (query: Record<string, string>) => verifyShopifyInstall(query, opts.clientSecret!, clock.now()),
          authorizeUrl: (shop: string, redirectUri: string, state: string) => oauth(shop, redirectUri).authorizationUrl({ state }),
          apiKey: opts.clientId,
          verifySessionToken: (token: string) => verifyShopifySessionToken(token, { clientId: opts.clientId!, secret: opts.clientSecret! }, clock.now()),
          staffEmail: async (shop: string, sessionToken: string) => {
            const t = await oauth(shop).grant('urn:ietf:params:oauth:grant-type:token-exchange', {
              subject_token: sessionToken,
              subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
              requested_token_type: 'urn:shopify:params:oauth:token-type:online-access-token',
            })
            const user = t.extra?.associated_user
            const email = isRecord(user) ? str(user.email) : undefined
            return email && /^[^@\s]+@[^@\s]+$/.test(email) ? email.trim().toLowerCase() : undefined
          },
          exchangeSessionToken: async (shop: string, sessionToken: string) =>
            toSecret(
              await oauth(shop).grant('urn:ietf:params:oauth:grant-type:token-exchange', {
                subject_token: sessionToken,
                subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
                requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
                expiring: '1',
              }),
            ),
        }
      : {}),
    describe: () => description,

    async begin(ctx) {
      // The authorize URL is shop-specific. On re-auth the shop is known from the connection; for a new store the UI
      // first collects the shop domain plus a custom-app token (OAuth installs normally start from the Shopify admin /
      // app listing, which redirects to our callback with ?shop=...).
      const shop = ctx.connection ? normalizeShop(ctx.connection.config.shop) : undefined
      if (shop && opts.clientId && opts.clientSecret) {
        return { kind: 'oauth', url: oauth(shop, ctx.redirectUri).authorizationUrl({ state: ctx.state }) }
      }
      return {
        kind: 'api_key',
        label: 'Your Shopify store and its own app’s client ID and secret',
        helpUrl: 'https://help.shopify.com/en/manual/apps/app-types/custom-apps',
        placeholder: 'example.myshopify.com',
        fields: [
          { name: 'shop', label: 'Shop domain', placeholder: 'example.myshopify.com' },
          { name: 'clientId', label: 'Client ID' },
          { name: 'clientSecret', label: 'Client secret', secret: true },
        ],
        steps: [
          'In your Shopify admin, open Settings → Apps → Develop apps and create an app named "Aggregate" (it opens in the Dev Dashboard).',
          'Give it only the read scopes below, then install it on your store.',
          'Copy the app’s Client ID and Client secret and paste them here with your store’s .myshopify.com domain.',
        ],
        permissions: ['read_shopify_payments_payouts', 'read_shopify_payments_accounts'],
      }
    },

    async connect(input) {
      const q: Record<string, string> = {}
      for (const [k, v] of Object.entries(isRecord(input.query) ? input.query : input)) if (typeof v === 'string') q[k] = v
      const shop = normalizeShop(q.shop)
      if (!shop) throw new ConnectorError('invalid_input', 'shop must be a *.myshopify.com domain', { provider: 'shopify' })
      let secret: ShopifySecret
      if (isSecret(input.adopt)) {
        // A token from the managed install (token exchange), kept until the person picked a workspace.
        secret = input.adopt
      } else if (q.code) {
        if (!opts.clientSecret) throw new ConnectorError('invalid_input', 'Shopify OAuth is not configured', { provider: 'shopify' })
        // OAuth callback: verify Shopify's hmac over the query before trusting `shop` or `code`. The server passes the
        // untouched callback query as `query` (its `state` is part of what Shopify signed).
        const callback = Object.fromEntries(Object.entries(q).filter(([k]) => k !== 'redirectUri'))
        verifyShopifyOAuthCallback(callback, opts.clientSecret)
        const redirectUri = str(input.redirectUri) ?? q.redirectUri ?? ''
        // Expiring offline token (required for new public apps; 1 h access, 90-day rotating refresh).
        secret = toSecret(await oauth(shop, redirectUri).exchangeCode(q.code, { extraParams: { expiring: '1' } }))
        if (opts.webhookUrl) await subscribeUninstall(shop, secret.accessToken, opts.webhookUrl)
      } else if (q.clientId?.trim() && q.clientSecret?.trim()) {
        secret = await ownAppToken(shop, q.clientId.trim(), q.clientSecret.trim())
      } else {
        const token = q.accessToken?.trim()
        if (!token || !/^[A-Za-z0-9_-]{20,}$/.test(token)) throw new ConnectorError('invalid_input', 'accessToken (Admin API access token) or an OAuth code is required', { provider: 'shopify' })
        secret = { accessToken: token }
      }
      // Hosted: a store's own app (client credentials or a pasted token) must be read-only, like Stripe's restricted keys.
      if (opts.hosted && !q.code && !isSecret(input.adopt)) {
        const writes = await writeScopes(shop, secret.accessToken)
        if (writes.length) throw new ConnectorError('invalid_input', SHOPIFY_WRITE_REFUSED(writes), { provider: 'shopify', forUser: true })
      }
      const d = await accountInfo(shop, secret.accessToken)
      // Without Payments the store still connects (review and dev stores rarely have it); payouts come once it's on.
      const p = d.shopifyPaymentsAccount ? await probe(shop, secret.accessToken) : { balanceTransactions: true, warnings: [SHOPIFY_NO_PAYMENTS_NOTE] }
      const config: ShopifyConfig = {
        shop,
        balanceTransactions: p.balanceTransactions,
        warnings: p.warnings,
        ...(d.shop?.name ? { shopName: d.shop.name.slice(0, 80) } : {}),
      }
      // The connection shows as "Shopify · <store>", so several stores tell apart.
      return { secret, config: { ...config, displayName: `Shopify · ${config.shopName ?? shop.replace(/\.myshopify\.com$/, '')}` } }
    },

    async sync(conn, cursor) {
      const shop = configOf(conn).shop
      const state = codec.decode(cursor) ?? { stage: 'account', shop, curs: [], after: null, stop: null, cycle: null, hw: null, summary: false }
      const { secret, updated } = await usableSecret(conn, shop)
      // Refresh tokens rotate: keep the new one before fetching anything, so a failed page can't strand it.
      if (updated) await deps.saveSecret?.(conn.id, updated)
      const page = await step(conn, secret.accessToken, state)
      return updated ? { ...page, updatedSecret: updated } : page
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        // Never refreshes: a refresh rotates the token, and health has nowhere to keep the new one. An expired
        // access token renews on the next sync; only Shopify's 401 means reconnect.
        const shop = configOf(conn).shop
        const secret = requireSecret('shopify', conn.secret, isSecret)
        if (secret.expiresAt !== undefined && secret.expiresAt <= clock.now()) return { status: 'ok', message: 'The access token renews on the next sync.' }
        const d = await accountInfo(shop, secret.accessToken)
        return d.shopifyPaymentsAccount ? { status: 'ok' } : { status: 'ok', message: SHOPIFY_NO_PAYMENTS_NOTE }
      } catch (e) {
        return healthFromError(e)
      }
    },
  }
}

const UNINSTALL_SUBSCRIBE = `mutation subscribeUninstall($callbackUrl: URL!) {
  webhookSubscriptionCreate(topic: APP_UNINSTALLED, webhookSubscription: { callbackUrl: $callbackUrl, format: JSON }) {
    webhookSubscription { id }
    userErrors { field message }
  }
}`

