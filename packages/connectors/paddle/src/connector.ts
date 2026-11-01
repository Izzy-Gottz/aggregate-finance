// Paddle Billing connector (read-only): completed transactions → charges, approved adjustments → refunds/disputes,
// subscriptions → subscription.upsert (MRR). Payouts are NOT available through Paddle's public API (only as an
// asynchronous CSV report), so payout rows aren't emitted; Paddle deposits are matched on the bank side by amount.
//
// A sync cycle is: transactions (updated_at ≥ last high-water − 2 days, ascending, cursor pages via
// meta.pagination.next) → adjustments (id ascending after the last settled id) → all subscriptions → done.

import type { ConnectBegin, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, SyncResult } from '@agfn/contracts'
import {
  ConnectorError,
  cursorCodec,
  healthFromError,
  isConnectorError,
  isRecord,
  requireSecret,
  str,
  systemClock,
  type Clock,
  type ConnectorDeps,
  type ConnectorWebhook,
} from '@agfn/connector-sdk'
import { PaddleClient, envFromKey, type PaddleEnv } from './client.ts'
import { mapAccount, mapAdjustment, mapSubscription, mapTransaction } from './map.ts'
import type { PaddleAdjustment, PaddleDiscount, PaddleList, PaddleSubscription, PaddleTransaction } from './types.ts'
import { paddleWebhook, paddleWebhookRef } from './webhook.ts'

export interface PaddleSecret {
  apiKey: string
}

export interface PaddleConfig {
  env: PaddleEnv
  /** Routes verified webhooks to this connection (hash of the app's webhook secret). */
  webhookRef?: string
  warnings?: string[]
}

export interface PaddleConnectorOptions {
  /** Endpoint secret key of the Paddle notification destination (pdl_ntfset_…). Enables `webhook`. */
  webhookSecret?: string
  /** Webhook timestamp tolerance; Paddle's own default is 5 seconds. */
  webhookToleranceSeconds?: number
  /** Re-read window on the transactions updated_at high-water mark. Default 2 days. */
  overlapDays?: number
}

interface PaddleCursor {
  stage: 'txns' | 'adjustments' | 'subs'
  /** Next-page URL inside the current stage (null = first page). */
  next: string | null
  /** Transactions updated_at lower bound for this cycle (null = full backfill). */
  since: string | null
  /** Highest transaction updated_at seen so far in this cycle. */
  hwm: string | null
  /** Last adjustment id before the first non-final one: the next cycle starts after it. */
  adjAfter: string | null
  /** In-cycle: candidate adjAfter, and whether a pending adjustment froze it. */
  adjNew: string | null
  adjFrozen: boolean
  /** Balance currencies whose account.upsert was already emitted (emitted once, the first time a currency appears). */
  acct: string[]
}

const isPaddleCursor = (v: unknown): v is PaddleCursor =>
  isRecord(v) && (v.stage === 'txns' || v.stage === 'adjustments' || v.stage === 'subs') && typeof v.adjFrozen === 'boolean' && Array.isArray(v.acct)

const isPaddleSecret = (v: unknown): v is PaddleSecret => isRecord(v) && typeof v.apiKey === 'string' && v.apiKey.length >= 10

export interface PaddleConnector extends Connector {
  begin(): Promise<ConnectBegin>
  readonly webhook?: ConnectorWebhook
}

const START: PaddleCursor = { stage: 'txns', next: null, since: null, hwm: null, adjAfter: null, adjNew: null, adjFrozen: false, acct: [] }

export function createPaddleConnector(opts: PaddleConnectorOptions, deps: ConnectorDeps): PaddleConnector {
  const clock: Clock = deps.clock ?? systemClock
  const codec = cursorCodec<PaddleCursor>('paddle', 1, isPaddleCursor)
  const overlapMs = (opts.overlapDays ?? 2) * 86_400_000

  const description: ConnectorDescription = {
    key: 'paddle',
    name: 'Paddle',
    group: 'payments',
    provides: ['transactions', 'balances'],
    freshness: opts.webhookSecret ? 'updates within minutes via webhooks' : 'updates every few hours',
    auth: 'api_key',
  }

  const envOf = (conn: ConnectionRef): PaddleEnv => (conn.config.env === 'sandbox' ? 'sandbox' : 'live')
  const clientFor = (conn: ConnectionRef) => new PaddleClient(requireSecret('paddle', conn.secret, isPaddleSecret).apiKey, envOf(conn), deps)

  async function accountsFor(conn: ConnectionRef, env: PaddleEnv, currencies: Set<string>, s: PaddleCursor): Promise<{ events: NormalizedEvent[]; acct: string[] }> {
    const out: NormalizedEvent[] = []
    const fresh = [...currencies].filter((c) => !s.acct.includes(c)).sort()
    for (const c of fresh) {
      const rawRef = await deps.raw.put(conn.id, 'paddle.balance', `${env}:${c}`, { env, currency: c })
      out.push(mapAccount(env, c, conn.id, rawRef))
    }
    return { events: out, acct: [...s.acct, ...fresh].sort() }
  }

  async function txnsPage(conn: ConnectionRef, client: PaddleClient, s: PaddleCursor): Promise<SyncResult> {
    const env = envOf(conn)
    const since = s.since ? new Date(Date.parse(s.since) - overlapMs).toISOString() : undefined
    const page = s.next
      ? await client.get<PaddleList<PaddleTransaction>>(s.next)
      : await client.get<PaddleList<PaddleTransaction>>('/transactions', {
          status: 'paid,completed',
          order_by: 'updated_at[ASC]',
          per_page: 30,
          ...(since ? { 'updated_at[GTE]': since } : {}),
        })
    const rows: NormalizedEvent[] = []
    const currencies = new Set<string>()
    let hwm = s.hwm
    for (const t of page.data) {
      if (!hwm || t.updated_at > hwm) hwm = t.updated_at
      const rawRef = await deps.raw.put(conn.id, 'paddle.transaction', t.id, t)
      const e = mapTransaction(t, env, conn.id, rawRef)
      if (e) {
        currencies.add(e.net.currency)
        rows.push(e)
      }
    }
    const acc = await accountsFor(conn, env, currencies, s)
    const events = [...acc.events, ...rows]
    const next: PaddleCursor = page.meta.pagination.has_more
      ? { ...s, acct: acc.acct, next: page.meta.pagination.next, hwm }
      : { ...s, acct: acc.acct, stage: 'adjustments', next: null, hwm, adjNew: s.adjAfter, adjFrozen: false }
    return { events, cursor: codec.encode(next), hasMore: true }
  }

  async function adjustmentsPage(conn: ConnectionRef, client: PaddleClient, s: PaddleCursor): Promise<SyncResult> {
    const env = envOf(conn)
    const page = s.next
      ? await client.get<PaddleList<PaddleAdjustment>>(s.next)
      : await client.get<PaddleList<PaddleAdjustment>>('/adjustments', {
          order_by: 'id[ASC]',
          per_page: 50,
          ...(s.adjAfter ? { after: s.adjAfter } : {}),
        })
    const rows: NormalizedEvent[] = []
    const currencies = new Set<string>()
    let adjNew = s.adjNew
    let frozen = s.adjFrozen
    for (const a of page.data) {
      // pending_approval may still become approved: next cycle must look at it again.
      if (a.status === 'pending_approval') frozen = true
      if (!frozen) adjNew = a.id
      const rawRef = await deps.raw.put(conn.id, 'paddle.adjustment', a.id, a)
      const e = mapAdjustment(a, env, conn.id, rawRef)
      if (e) {
        currencies.add(e.net.currency)
        rows.push(e)
      }
    }
    const acc = await accountsFor(conn, env, currencies, s)
    const events = [...acc.events, ...rows]
    const next: PaddleCursor = page.meta.pagination.has_more
      ? { ...s, acct: acc.acct, next: page.meta.pagination.next, adjNew, adjFrozen: frozen }
      : { ...s, acct: acc.acct, stage: 'subs', next: null, adjAfter: adjNew, adjNew: null, adjFrozen: false }
    return { events, cursor: codec.encode(next), hasMore: true }
  }

  async function subsPage(conn: ConnectionRef, client: PaddleClient, s: PaddleCursor): Promise<SyncResult> {
    const page = s.next
      ? await client.get<PaddleList<PaddleSubscription>>(s.next)
      : await client.get<PaddleList<PaddleSubscription>>('/subscriptions', { order_by: 'id[ASC]', per_page: 200 })
    const now = clock.now()
    const discounts = new Map<string, PaddleDiscount | undefined>()
    const events: NormalizedEvent[] = []
    for (const sub of page.data) {
      let discount: PaddleDiscount | undefined
      if (sub.discount?.id) {
        if (!discounts.has(sub.discount.id)) {
          try {
            const d = await client.get<{ data: PaddleDiscount }>(`/discounts/${encodeURIComponent(sub.discount.id)}`)
            discounts.set(sub.discount.id, d.data)
          } catch (e) {
            // A deleted/unknown discount doesn't stop MRR; anything else (auth, outage) does.
            if (!(isConnectorError(e) && e.status === 404)) throw e
            discounts.set(sub.discount.id, undefined)
          }
        }
        discount = discounts.get(sub.discount.id)
      }
      const rawRef = await deps.raw.put(conn.id, 'paddle.subscription', sub.id, { subscription: sub, discount: discount ?? null })
      events.push(mapSubscription(sub, discount, now, conn.id, rawRef))
    }
    if (page.meta.pagination.has_more) {
      return { events, cursor: codec.encode({ ...s, next: page.meta.pagination.next }), hasMore: true }
    }
    const done: PaddleCursor = { ...START, since: s.hwm ?? s.since, hwm: s.hwm ?? s.since, adjAfter: s.adjAfter, acct: s.acct }
    return { events, cursor: codec.encode(done), hasMore: false }
  }

  const webhook = opts.webhookSecret
    ? paddleWebhook({
        secret: opts.webhookSecret,
        ...(opts.webhookToleranceSeconds !== undefined ? { toleranceSeconds: opts.webhookToleranceSeconds } : {}),
        clock,
      })
    : undefined

  return {
    describe: () => description,
    ...(webhook ? { webhook } : {}),

    async begin() {
      return {
        kind: 'api_key',
        label: 'Paddle API key',
        steps: [
          'Sign in to Paddle and open My account → Settings → Authentication, then the API keys tab.',
          'Create a new API key named “Aggregate”.',
          'Give it Read for transactions, adjustments, subscriptions and discounts only, and set the expiry to the latest date allowed (Paddle’s limit is one year).',
          'Copy the key (pdl_live_apikey_…) and paste it here.',
        ],
        permissions: [
          'Read only: transactions, adjustments, subscriptions and discounts.',
        ],
        helpUrl: 'https://vendors.paddle.com/authentication-v2',
        placeholder: 'pdl_live_apikey_…',
      }
    },

    async connect(input) {
      const apiKey = str(input.apiKey)?.trim()
      if (!apiKey || apiKey.length < 10 || /\s/.test(apiKey)) {
        throw new ConnectorError('invalid_input', 'apiKey is required', { provider: 'paddle' })
      }
      const fromKey = envFromKey(apiKey)
      const asked = input.env === 'sandbox' || input.env === 'live' ? input.env : undefined
      if (fromKey && asked && fromKey !== asked) {
        throw new ConnectorError('invalid_input', `this is a ${fromKey} key but env is ${asked}`, { provider: 'paddle' })
      }
      const env: PaddleEnv = fromKey ?? asked ?? 'live'
      // One harmless read proves the key works and can read transactions.
      await new PaddleClient(apiKey, env, deps).get('/transactions', { per_page: 1 })
      const config: PaddleConfig = {
        env,
        ...(opts.webhookSecret ? { webhookRef: paddleWebhookRef(opts.webhookSecret) } : {}),
        warnings: [
          'Paddle payouts are not available through the API; Paddle deposits are matched in your bank feed by amount.',
        ],
      }
      const secret: PaddleSecret = { apiKey }
      return { secret, config: { ...config } }
    },

    async sync(conn, cursor) {
      const client = clientFor(conn)
      const s = codec.decode(cursor) ?? START
      if (s.stage === 'txns') return txnsPage(conn, client, s)
      if (s.stage === 'adjustments') return adjustmentsPage(conn, client, s)
      return subsPage(conn, client, s)
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        await clientFor(conn).get('/transactions', { per_page: 1 })
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },
  }
}
