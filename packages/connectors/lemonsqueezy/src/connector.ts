// Lemon Squeezy connector (read-only): stores → USD processor balances, orders → charges and refunds,
// subscriptions → subscription.upsert (MRR from the subscription's price). Payouts are not in Lemon Squeezy's public
// API, so no payout rows are emitted; deposits are matched in the bank feed by amount.
//
// A sync cycle is: stores → orders (newest first, page[number]) → subscriptions (all pages) → done. Orders have no
// updated_at filter, so incremental cycles page back until orders are older than the previous cycle's newest order
// minus a refund window (default 90 days): refunds of older orders are only picked up by a full re-sync.

import type { ConnectBegin, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, SyncResult } from '@agfn/contracts'
import {
  ConnectorError,
  cursorCodec,
  healthFromError,
  isConnectorError,
  isRecord,
  requireSecret,
  str,
  type ConnectorDeps,
  type ConnectorWebhook,
} from '@agfn/connector-sdk'
import { LemonSqueezyClient } from './client.ts'
import { mapAccount, mapOrderCharge, mapOrderRefund, mapSubscription } from './map.ts'
import type { LsList, LsOrder, LsPrice, LsResource, LsStore, LsSubscription } from './types.ts'
import { lemonSqueezyWebhook } from './webhook.ts'


/** Lemon Squeezy API keys can't be limited to reading (self-hosted only). */
export const LS_FULL_ACCESS_WARNING =
  'Lemon Squeezy API keys can’t be limited to reading, so this key could also change your store. Aggregate only reads; keep the key private and delete it in Lemon Squeezy when you disconnect.'
export interface LemonSqueezySecret {
  apiKey: string
}

export interface LemonSqueezyConfig {
  /** Primary store (webhook routing: data.attributes.store_id). */
  storeId: string
  storeIds: string[]
  storeName?: string
  warnings: string[]
}

export interface LemonSqueezyConnectorOptions {
  /** Signing secret of the Lemon Squeezy webhook. Enables `webhook`. */
  webhookSecret?: string
  /** How far back incremental syncs re-read orders to catch refunds. Default 90 days. */
  refundWindowDays?: number
  pageSize?: number
}

interface LsCursor {
  stage: 'stores' | 'orders' | 'subs'
  page: number
  /** Newest order created_at from the previous completed cycle (null = full backfill). */
  since: string | null
  /** Newest order created_at seen this cycle. */
  hwm: string | null
  /** store id → store currency (for subscription prices). */
  cur: Record<string, string>
}

const isLsCursor = (v: unknown): v is LsCursor =>
  isRecord(v) && (v.stage === 'stores' || v.stage === 'orders' || v.stage === 'subs') && typeof v.page === 'number' && isRecord(v.cur)

const isLsSecret = (v: unknown): v is LemonSqueezySecret => isRecord(v) && typeof v.apiKey === 'string' && v.apiKey.length >= 10

export const LS_WARNINGS = [
  'Lemon Squeezy API keys have no read-only scope: this key can also make changes (Aggregate only reads). Store it carefully and revoke it if unused.',
  "Lemon Squeezy's fees are not in its API: charges are recorded with fee 0, so the balance runs ahead of payouts by those fees.",
  'Lemon Squeezy payouts are not in its API; deposits are matched in your bank feed by amount.',
]

/** Per-sync warning (final page of each cycle): fees are unknown, so charges carry fee 0. */
export const LS_FEE_SYNC_WARNING = "Lemon Squeezy fees aren't in its API, so sales are recorded with no fee and the balance runs ahead of payouts."

export interface LemonSqueezyConnector extends Connector {
  begin(): Promise<ConnectBegin>
  readonly webhook?: ConnectorWebhook
}

export function createLemonSqueezyConnector(opts: LemonSqueezyConnectorOptions, deps: ConnectorDeps): LemonSqueezyConnector {
  const codec = cursorCodec<LsCursor>('lemonsqueezy', 1, isLsCursor)
  const windowMs = (opts.refundWindowDays ?? 90) * 86_400_000
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 100))

  const description: ConnectorDescription = {
    key: 'lemonsqueezy',
    name: 'Lemon Squeezy',
    group: 'payments',
    provides: ['transactions', 'balances'],
    freshness: opts.webhookSecret ? 'updates within minutes via webhooks' : 'updates every few hours',
    auth: 'api_key',
  }

  const clientFor = (conn: ConnectionRef) => new LemonSqueezyClient(requireSecret('lemonsqueezy', conn.secret, isLsSecret).apiKey, deps)
  const storeIdsOf = (conn: ConnectionRef): string[] =>
    Array.isArray(conn.config.storeIds) ? conn.config.storeIds.map(String) : str(conn.config.storeId) ? [String(conn.config.storeId)] : []
  const storeFilter = (conn: ConnectionRef) => {
    const ids = storeIdsOf(conn)
    return ids.length === 1 ? { 'filter[store_id]': ids[0] } : {}
  }
  const wanted = (conn: ConnectionRef, storeId: number | string) => {
    const ids = storeIdsOf(conn)
    return ids.length === 0 || ids.includes(String(storeId))
  }

  async function storesPage(conn: ConnectionRef, client: LemonSqueezyClient, s: LsCursor): Promise<SyncResult> {
    const res = await client.get<LsList<LsStore>>('/v1/stores', { 'page[size]': 100 })
    const events: NormalizedEvent[] = []
    const cur: Record<string, string> = {}
    for (const st of res.data) {
      if (!wanted(conn, st.id)) continue
      cur[st.id] = st.attributes.currency || 'USD'
      const rawRef = await deps.raw.put(conn.id, 'lemonsqueezy.store', st.id, st)
      events.push(mapAccount(st.id, st.attributes, conn.id, rawRef))
    }
    return { events, cursor: codec.encode({ ...s, stage: 'orders', page: 1, hwm: s.since, cur }), hasMore: true }
  }

  async function ordersPage(conn: ConnectionRef, client: LemonSqueezyClient, s: LsCursor): Promise<SyncResult> {
    const res = await client.get<LsList<LsOrder>>('/v1/orders', { 'page[number]': s.page, 'page[size]': pageSize, ...storeFilter(conn) })
    const events: NormalizedEvent[] = []
    let hwm = s.hwm
    let oldest: string | undefined
    for (const o of res.data) {
      const a = o.attributes
      if (!hwm || a.created_at > hwm) hwm = a.created_at
      if (!oldest || a.created_at < oldest) oldest = a.created_at
      if (!wanted(conn, a.store_id) || !(String(a.store_id) in s.cur)) continue
      const rawRef = await deps.raw.put(conn.id, 'lemonsqueezy.order', o.id, o)
      const charge = mapOrderCharge(o.id, a, conn.id, rawRef)
      if (charge) events.push(charge)
      const refund = mapOrderRefund(o.id, a, conn.id, rawRef)
      if (refund) events.push(refund)
    }
    const caughtUp = s.since !== null && oldest !== undefined && Date.parse(oldest) < Date.parse(s.since) - windowMs
    const more = Boolean(res.links?.next) && res.data.length > 0 && !caughtUp
    const next: LsCursor = more ? { ...s, page: s.page + 1, hwm } : { ...s, stage: 'subs', page: 1, hwm }
    return { events, cursor: codec.encode(next), hasMore: true }
  }

  async function subsPage(conn: ConnectionRef, client: LemonSqueezyClient, s: LsCursor): Promise<SyncResult> {
    const res = await client.get<LsList<LsSubscription>>('/v1/subscriptions', { 'page[number]': s.page, 'page[size]': pageSize, ...storeFilter(conn) })
    const prices = new Map<number, LsPrice | undefined>()
    const events: NormalizedEvent[] = []
    for (const sub of res.data) {
      const a = sub.attributes
      const storeCur = s.cur[String(a.store_id)]
      if (!wanted(conn, a.store_id) || !storeCur) continue
      const priceId = a.first_subscription_item?.price_id
      let price: LsPrice | undefined
      if (priceId !== undefined) {
        if (!prices.has(priceId)) {
          try {
            const p = await client.get<{ data: LsResource<LsPrice> }>(`/v1/prices/${priceId}`)
            prices.set(priceId, p.data.attributes)
          } catch (e) {
            if (!(isConnectorError(e) && e.status === 404)) throw e
            prices.set(priceId, undefined)
          }
        }
        price = prices.get(priceId)
      }
      const rawRef = await deps.raw.put(conn.id, 'lemonsqueezy.subscription', sub.id, { subscription: sub, price: price ?? null })
      events.push(mapSubscription(sub.id, a, price, storeCur, conn.id, rawRef))
    }
    if (res.links?.next && res.data.length > 0) {
      return { events, cursor: codec.encode({ ...s, page: s.page + 1 }), hasMore: true }
    }
    const done: LsCursor = { stage: 'stores', page: 1, since: s.hwm, hwm: s.hwm, cur: s.cur }
    // Fees are never in the API (charges carry fee 0): say so once per cycle, on the final page.
    const warnings = Object.keys(s.cur).length > 0 ? [LS_FEE_SYNC_WARNING] : []
    return { events, cursor: codec.encode(done), hasMore: false, ...(warnings.length ? { warnings } : {}) }
  }

  const webhook = opts.webhookSecret ? lemonSqueezyWebhook(opts.webhookSecret) : undefined

  return {
    describe: () => description,
    ...(webhook ? { webhook } : {}),

    async begin() {
      return {
        kind: 'api_key',
        label: 'Lemon Squeezy API key',
        steps: [
          'Sign in to Lemon Squeezy and open Settings → API.',
          'Make sure Test mode is off, then create a new API key named “Aggregate” (if asked for an expiry date, pick the latest one).',
          'Copy it now (it’s shown once) and paste it here.',
        ],
        permissions: [
          'Lemon Squeezy keys can’t be limited to reading; Aggregate only reads stores, orders, subscriptions and payouts.',
        ],
        helpUrl: 'https://app.lemonsqueezy.com/settings/api',
        placeholder: 'eyJ0eXAiOiJKV1QiLCJhbGciOi…',
      }
    },

    async connect(input) {
      const apiKey = str(input.apiKey)?.trim()
      if (!apiKey || apiKey.length < 10 || /\s/.test(apiKey)) {
        throw new ConnectorError('invalid_input', 'apiKey is required', { provider: 'lemonsqueezy' })
      }
      const res = await new LemonSqueezyClient(apiKey, deps).get<LsList<LsStore>>('/v1/stores', { 'page[size]': 100 })
      if (res.data.length === 0) throw new ConnectorError('invalid_input', 'this API key has no stores', { provider: 'lemonsqueezy' })
      const asked = input.storeId === undefined || input.storeId === null ? undefined : String(input.storeId)
      const chosen = asked ? res.data.filter((st) => st.id === asked) : res.data
      if (chosen.length === 0) throw new ConnectorError('invalid_input', `store ${asked} is not visible to this API key`, { provider: 'lemonsqueezy' })
      const first = chosen[0]!
      const config: LemonSqueezyConfig = {
        storeId: first.id,
        storeIds: chosen.map((st) => st.id),
        storeName: first.attributes.name.slice(0, 80),
        warnings: [...LS_WARNINGS],
      }
      const secret: LemonSqueezySecret = { apiKey }
      return { secret, config: { ...config } }
    },

    async sync(conn, cursor) {
      const client = clientFor(conn)
      const s = codec.decode(cursor) ?? { stage: 'stores', page: 1, since: null, hwm: null, cur: {} }
      if (s.stage === 'stores') return storesPage(conn, client, s)
      if (s.stage === 'orders') return ordersPage(conn, client, s)
      const page = await subsPage(conn, client, s)
      // Said on the connection after every full sync: the key itself could do more than read.
      return page.hasMore ? page : { ...page, warnings: [...(page.warnings ?? []), LS_FULL_ACCESS_WARNING] }
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        await clientFor(conn).get('/v1/stores', { 'page[size]': 1 })
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },
  }
}
