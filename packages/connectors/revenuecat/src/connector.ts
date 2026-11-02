// RevenueCat connector (read-only secret key, REST API v2): subscriptions → subscription.upsert, for MRR and churn on
// in-app subscriptions.
//
// Not emitted, on purpose:
// - Money. No processor.balance_txn, no account.upsert, nothing posted to the ledger, and total_revenue_in_usd is never
//   used as an amount. The App Store and Google Play connectors book proceeds from Apple's and Google's own reports and
//   emit no subscription events, so RevenueCat adds MRR and churn without counting a sale twice.
// - Stripe and Paddle subscriptions (`stripe`, `paddle`): those connectors emit subscription.upsert themselves, so MRR
//   would double. A warning says how many were left out, in case that connection isn't there.
// - `promotional` (granted, no money), `test_store` and sandbox subscriptions (test data).
// - `external`: RevenueCat's docs don't say who bills these, and it could be a provider Aggregate reads directly.
//   Stores RevenueCat adds later are treated the same. Counted is an allow-list, so an unknown store can't double MRR.
//   Both are left out with a warning.
// - Anything not `ownership: purchased`: a family_shared subscription is a second view of one the purchaser pays for,
//   and `assigned` isn't documented.
//
// Counted, and why that's safe:
// - `rc_billing` (RevenueCat Web Billing): Stripe is only its payment gateway. RevenueCat runs the recurring billing
//   "instead of Stripe Billing", so there's no Stripe subscription for the Stripe connector to emit, and the payments
//   arrive through that connector as usual. Not counted here, this MRR would be missing.
// - `paypal`: the PayPal connector reads payments and emits no subscription events.
// - `app_store`, `mac_app_store`, `play_store`, `amazon`, `galaxy`, `roku`.
//
// RevenueCat has no updated-since filter and no way to list subscriptions across a project, so every sync walks all
// customers, one page of them per sync() call, and each customer's subscriptions. The cursor is where the walk has got
// to; a finished pass starts the next from the top. Products are read once per page.

import type { ConnectBegin, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, SyncResult } from '@agfn/contracts'
import { ConnectorError, cursorCodec, healthFromError, isConnectorError, isRecord, requireSecret, str, type ConnectorDeps } from '@agfn/connector-sdk'
import { RevenueCatClient } from './client.ts'
import { mapStatus, mapSubscription, opaqueCustomer } from './map.ts'
import type { RcCustomer, RcList, RcProduct, RcSubscription, RcTransaction } from './types.ts'

export interface RevenueCatSecret {
  projectId: string
  apiKey: string
}

export interface RevenueCatConnectorOptions {
  pageSize?: number
}

interface RcCursor {
  /** Last customer id of the previous page (null = from the top). */
  after: string | null
  /** Live subscriptions this pass, for the warnings at its end. */
  list: number
  unpriced: number
  direct: number
  other: number
}

const COUNTED_STORES = new Set(['app_store', 'mac_app_store', 'play_store', 'amazon', 'galaxy', 'roku', 'rc_billing', 'paypal'])
const DIRECT_STORES = new Set(['stripe', 'paddle'])
const SILENT_STORES = new Set(['promotional', 'test_store'])
/** The stores the Subscription Transactions endpoint is documented for. */
const TRANSACTION_STORES = new Set(['app_store', 'play_store'])
/** Newest first; a weekly subscription fits two years. Older rows only date the start. */
const TRANSACTION_LIMIT = 100

export const READ_PERMISSIONS = ['customer_information:customers:read', 'customer_information:subscriptions:read', 'project_configuration:products:read'] as const

const isCursor = (v: unknown): v is RcCursor =>
  isRecord(v) && (v.after === null || typeof v.after === 'string') && typeof v.list === 'number' && typeof v.unpriced === 'number' && typeof v.direct === 'number' && typeof v.other === 'number'
const isSecret = (v: unknown): v is RevenueCatSecret => isRecord(v) && typeof v.projectId === 'string' && typeof v.apiKey === 'string' && v.apiKey.startsWith('sk_')

const plural = (n: number, one: string, many: string) => `${n} RevenueCat subscription${n === 1 ? ` ${one}` : `s ${many}`}`

export const RC_LIST_PRICE_WARNING = (n: number) => `${plural(n, 'uses a list price', 'use list prices')} for MRR: RevenueCat only gives what customers actually paid for the App Store and Google Play. These are US dollar prices, whatever the customer pays.`
export const RC_UNPRICED_WARNING = (n: number) => `${plural(n, 'has no price', 'have no price')} in RevenueCat, so ${n === 1 ? 'it counts' : 'they count'} as 0 in MRR.`
export const RC_DIRECT_WARNING = (n: number) => `${plural(n, 'sold through Stripe or Paddle is', 'sold through Stripe or Paddle are')} left out so MRR isn't counted twice. Connect Stripe or Paddle to include ${n === 1 ? 'it' : 'them'}.`
export const RC_OTHER_STORE_WARNING = (n: number) => `${plural(n, 'from a store Aggregate can’t identify is', 'from stores Aggregate can’t identify are')} left out of MRR.`

const fresh = (): RcCursor => ({ after: null, list: 0, unpriced: 0, direct: 0, other: 0 })

/** `next_page` is a path with `starting_after`; the last id on the page is the same thing, if it's ever missing. */
function nextAfter(page: RcList<{ id: string }>): string | null {
  if (!page.next_page) return null
  const from = new URL(page.next_page, 'https://api.revenuecat.com').searchParams.get('starting_after')
  return from ?? page.items[page.items.length - 1]?.id ?? null
}

export function createRevenueCatConnector(opts: RevenueCatConnectorOptions, deps: ConnectorDeps): Connector & { begin(): Promise<ConnectBegin> } {
  const codec = cursorCodec<RcCursor>('revenuecat', 1, isCursor)
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 100))

  const description: ConnectorDescription = {
    key: 'revenuecat',
    name: 'RevenueCat',
    group: 'payments',
    provides: ['reports'],
    freshness: 'updates every few hours',
    auth: 'api_key',
  }

  const secretOf = (conn: ConnectionRef) => requireSecret('revenuecat', conn.secret, isSecret)
  const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`

  async function products(client: RevenueCatClient, projectId: string): Promise<Map<string, RcProduct>> {
    const out = new Map<string, RcProduct>()
    let after: string | null = null
    do {
      const page: RcList<RcProduct> = await client.getConfig(`${base(projectId)}/products`, { limit: 100, expand: 'items.indicative_price', ...(after ? { starting_after: after } : {}) })
      for (const p of page.items) out.set(p.id, p)
      after = nextAfter(page)
    } while (after)
    return out
  }

  async function subscriptionsOf(client: RevenueCatClient, projectId: string, customerId: string): Promise<RcSubscription[]> {
    const out: RcSubscription[] = []
    let after: string | null = null
    do {
      const page: RcList<RcSubscription> = await client.get(`${base(projectId)}/customers/${encodeURIComponent(customerId)}/subscriptions`, { limit: 100, ...(after ? { starting_after: after } : {}) })
      out.push(...page.items)
      after = nextAfter(page)
    } while (after)
    return out
  }

  async function transactionsOf(client: RevenueCatClient, projectId: string, subscriptionId: string): Promise<RcTransaction[]> {
    try {
      const page = await client.get<RcList<RcTransaction>>(`${base(projectId)}/subscriptions/${encodeURIComponent(subscriptionId)}/transactions`, { limit: TRANSACTION_LIMIT, sort: 'purchased_at', direction: 'desc' })
      return page.items
    } catch (e) {
      // No transactions for this one: the list price stands in, with its warning. Auth and rate limits still surface.
      if (isConnectorError(e) && (e.status === 404 || e.status === 400)) return []
      throw e
    }
  }

  return {
    describe: () => description,

    async begin() {
      return {
        kind: 'api_key',
        label: 'RevenueCat read-only secret key',
        steps: [
          'In RevenueCat, open your project’s settings → API keys, and choose + New secret API key.',
          'Name it “Aggregate”, choose version V2, and give it read-only access to customers, subscriptions and products. Nothing else, and no write access.',
          'Generate the key and copy it. Your Project ID is in Project Settings → General.',
        ],
        permissions: [`Read-only: ${READ_PERMISSIONS.join(', ')}. Aggregate reads subscriptions, their transactions and product prices to work out MRR.`],
        helpUrl: 'https://www.revenuecat.com/docs/projects/authentication',
        placeholder: '',
        fields: [
          { name: 'projectId', label: 'Project ID', placeholder: 'proj1ab2c3d4' },
          { name: 'apiKey', label: 'Secret API key (V2)', placeholder: 'sk_…', secret: true },
        ],
      }
    },

    async connect(input) {
      const projectId = str(input.projectId)?.trim()
      if (!projectId || !/^[A-Za-z0-9_-]{1,255}$/.test(projectId)) throw new ConnectorError('invalid_input', 'Paste your RevenueCat Project ID from Project Settings → General.', { provider: 'revenuecat', forUser: true })
      const apiKey = str(input.apiKey)?.trim()
      if (!apiKey || !/^sk_\S{6,}$/.test(apiKey)) throw new ConnectorError('invalid_input', 'Paste a V2 secret API key: it starts with sk_. App (public) keys won’t work.', { provider: 'revenuecat', forUser: true })
      const client = new RevenueCatClient(apiKey, deps)
      // RevenueCat has no call that shows a key's permissions, so a key that can also write can't be told apart here
      // without trying a write, which Aggregate never does. Each read it needs is checked instead.
      const needs = async <T>(permission: string, read: () => Promise<T>): Promise<T> => {
        try {
          return await read()
        } catch (e) {
          if (isConnectorError(e) && e.status === 403) throw new ConnectorError('auth', `This key can’t read what Aggregate needs. Give it ${permission}.`, { provider: 'revenuecat', status: 403, forUser: true })
          throw e
        }
      }
      const first = await needs(READ_PERMISSIONS[0], () => client.get<RcList<RcCustomer>>(`${base(projectId)}/customers`, { limit: 1 }))
      await needs(READ_PERMISSIONS[2], () => client.getConfig(`${base(projectId)}/products`, { limit: 1, expand: 'items.indicative_price' }))
      const customer = first.items[0]
      if (customer) await needs(READ_PERMISSIONS[1], () => client.get(`${base(projectId)}/customers/${encodeURIComponent(customer.id)}/subscriptions`, { limit: 1 }))
      const secret: RevenueCatSecret = { projectId, apiKey }
      return { secret, config: { projectId } }
    },

    async sync(conn, cursor): Promise<SyncResult> {
      const { projectId, apiKey } = secretOf(conn)
      const client = new RevenueCatClient(apiKey, deps)
      const s = codec.decode(cursor) ?? fresh()
      const page = await client.get<RcList<RcCustomer>>(`${base(projectId)}/customers`, { limit: pageSize, ...(s.after ? { starting_after: s.after } : {}) })
      const catalog = await products(client, projectId)
      const next = { ...s }
      const events: NormalizedEvent[] = []
      for (const customer of page.items) {
        for (const sub of await subscriptionsOf(client, projectId, customer.id)) {
          const status = mapStatus(sub.status)
          const live = status === 'active' || status === 'past_due'
          if (sub.environment !== 'production' || sub.ownership !== 'purchased' || SILENT_STORES.has(sub.store)) continue
          if (DIRECT_STORES.has(sub.store)) {
            if (live) next.direct++
            continue
          }
          if (!COUNTED_STORES.has(sub.store)) {
            if (live) next.other++
            continue
          }
          const txns = (live || sub.status === 'expired') && TRANSACTION_STORES.has(sub.store) ? await transactionsOf(client, projectId, sub.id) : []
          const product = sub.product_id ? catalog.get(sub.product_id) : undefined
          const rawRef = await deps.raw.put(conn.id, 'revenuecat.subscription', sub.id, {
            id: sub.id,
            customer: opaqueCustomer(projectId, sub.customer_id),
            product_id: sub.product_id,
            starts_at: sub.starts_at,
            current_period_starts_at: sub.current_period_starts_at,
            current_period_ends_at: sub.current_period_ends_at,
            ends_at: sub.ends_at,
            status: sub.status,
            auto_renewal_status: sub.auto_renewal_status,
            store: sub.store,
            ownership: sub.ownership,
            environment: sub.environment,
            indicative_price: product?.indicative_price ?? null,
            duration: product?.subscription?.duration ?? null,
            transactions: txns.map((t) => ({ purchased_at: t.purchased_at, expiration_date: t.expiration_date ?? null, revenue_in_local_currency: t.revenue_in_local_currency ?? null })),
          })
          const m = mapSubscription(sub, product, txns, projectId, conn.id, rawRef)
          events.push(m.event)
          if (live && m.source === 'list') next.list++
          if (live && m.source === 'none') next.unpriced++
        }
      }
      const after = nextAfter(page)
      if (after && page.items.length > 0) return { events, cursor: codec.encode({ ...next, after }), hasMore: true }
      const warnings = [
        ...(next.list ? [RC_LIST_PRICE_WARNING(next.list)] : []),
        ...(next.unpriced ? [RC_UNPRICED_WARNING(next.unpriced)] : []),
        ...(next.direct ? [RC_DIRECT_WARNING(next.direct)] : []),
        ...(next.other ? [RC_OTHER_STORE_WARNING(next.other)] : []),
      ]
      return { events, cursor: codec.encode(fresh()), hasMore: false, ...(warnings.length ? { warnings } : {}) }
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        const { projectId, apiKey } = secretOf(conn)
        await new RevenueCatClient(apiKey, deps).get(`${base(projectId)}/customers`, { limit: 1 })
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },
  }
}
