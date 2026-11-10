// Chargebee connector (read-only key): subscriptions → subscription.upsert, for MRR, churn and movements. Invoices and
// payments are not read; the money arrives through the payment gateway's connection or the bank (see map.ts).
//
// A sync pages GET /subscriptions sorted by updated_at (deleted ones included, so a deletion takes the subscription
// out of MRR). The first sync reads everything; later ones read what changed since the newest updated_at seen.
// Coupons are fetched once per page and cached for the page.

import type { ConnectBegin, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, SyncResult } from '@agfn/contracts'
import { ConnectorError, cursorCodec, healthFromError, isConnectorError, isRecord, requireSecret, str, systemClock, type ConnectorDeps } from '@agfn/connector-sdk'
import { ChargebeeClient, SITE_RE } from './client.ts'
import { mapSubscription, type CbCoupon } from './map.ts'
import type { CbList, CbSubscription } from './types.ts'

export interface ChargebeeSecret {
  site: string
  apiKey: string
}

export interface ChargebeeConnectorOptions {
  pageSize?: number
}

// Re-read this many seconds before the newest updated_at seen, so a subscription whose change becomes visible just
// after the cursor passed its second (replication lag, clock skew) isn't missed at the boundary. Upserts are idempotent.
const OVERLAP_SECONDS = 300

interface CbCursor {
  /** Chargebee's next_offset for the page being read (null = first page). */
  offset: string | null
  /** updated_at (seconds) the previous complete sync reached; null = read everything. */
  since: number | null
  /** Newest updated_at seen in this sync. */
  hwm: number | null
  /** Subscriptions whose MRR fell back to Chargebee's own figure this sync. */
  fallbacks: number
}

const isCursor = (v: unknown): v is CbCursor =>
  isRecord(v) && (v.offset === null || typeof v.offset === 'string') && (v.since === null || typeof v.since === 'number') && (v.hwm === null || typeof v.hwm === 'number') && typeof v.fallbacks === 'number'
const isSecret = (v: unknown): v is ChargebeeSecret => isRecord(v) && typeof v.site === 'string' && typeof v.apiKey === 'string' && v.apiKey.length >= 10

export const CB_FALLBACK_WARNING = (n: number) =>
  `${n} Chargebee subscription${n === 1 ? '' : 's'} use${n === 1 ? 's' : ''} a discount Aggregate can't work out exactly, so ${n === 1 ? 'its' : 'their'} MRR is Chargebee's own figure.`

/** "acme", "acme.chargebee.com" or "https://acme-test.chargebee.com/..." → "acme" / "acme-test". */
export function siteFrom(input: string): string | undefined {
  const s = input.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0]!.replace(/\.chargebee\.com$/, '')
  return SITE_RE.test(s) ? s : undefined
}

export function createChargebeeConnector(opts: ChargebeeConnectorOptions, deps: ConnectorDeps): Connector & { begin(): Promise<ConnectBegin> } {
  const codec = cursorCodec<CbCursor>('chargebee', 1, isCursor)
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 100))
  const clock = deps.clock ?? systemClock

  const description: ConnectorDescription = {
    key: 'chargebee',
    name: 'Chargebee',
    group: 'payments',
    provides: ['reports'],
    freshness: 'updates every few hours',
    auth: 'api_key',
  }

  const clientFor = (conn: ConnectionRef) => {
    const s = requireSecret('chargebee', conn.secret, isSecret)
    return new ChargebeeClient(s.site, s.apiKey, deps)
  }

  async function couponsFor(client: ChargebeeClient, subs: CbSubscription[]): Promise<Map<string, CbCoupon | undefined>> {
    const out = new Map<string, CbCoupon | undefined>()
    for (const id of new Set(subs.flatMap((s) => (s.coupons ?? []).map((c) => c.coupon_id)))) {
      try {
        const r = await client.get<{ coupon: CbCoupon }>(`/coupons/${encodeURIComponent(id)}`)
        out.set(id, r.coupon)
      } catch (e) {
        if (!(isConnectorError(e) && e.status === 404)) throw e
        out.set(id, undefined)
      }
    }
    return out
  }

  return {
    describe: () => description,

    async begin() {
      return {
        kind: 'api_key',
        label: 'Chargebee read-only API key',
        steps: [
          'In Chargebee, open Settings → Configure Chargebee → API Keys and Webhooks → API Keys.',
          'Choose Add API Key → Read-Only Key → All, and name it “Aggregate”.',
          'Copy the key, and type your site name: the part before .chargebee.com.',
        ],
        permissions: ['Read-only key (All). Aggregate reads subscriptions and coupons to work out MRR.'],
        helpUrl: 'https://www.chargebee.com/docs/billing/2.0/site-configuration/api_keys',
        placeholder: '',
        fields: [
          { name: 'site', label: 'Site name', placeholder: 'acme' },
          { name: 'apiKey', label: 'Read-only API key', placeholder: 'live_…', secret: true },
        ],
      }
    },

    async connect(input) {
      const site = siteFrom(str(input.site) ?? '')
      if (!site) throw new ConnectorError('invalid_input', 'Type your Chargebee site name: the part before .chargebee.com.', { provider: 'chargebee' })
      const apiKey = str(input.apiKey)?.trim()
      if (!apiKey || apiKey.length < 10 || /\s/.test(apiKey)) throw new ConnectorError('invalid_input', 'Paste the read-only API key from Chargebee.', { provider: 'chargebee' })
      await new ChargebeeClient(site, apiKey, deps).get('/subscriptions', { limit: 1 })
      const secret: ChargebeeSecret = { site, apiKey }
      return { secret, config: { site, ...(site.endsWith('-test') ? { warnings: ['This is a Chargebee test site, so its numbers are test data.'] } : {}) } }
    },

    async sync(conn, cursor): Promise<SyncResult> {
      const client = clientFor(conn)
      const s = codec.decode(cursor) ?? { offset: null, since: null, hwm: null, fallbacks: 0 }
      const res = await client.get<CbList<{ subscription: CbSubscription }>>('/subscriptions', {
        limit: pageSize,
        include_deleted: 'true',
        'sort_by[asc]': 'updated_at',
        ...(s.since !== null ? { 'updated_at[after]': s.since - OVERLAP_SECONDS } : {}),
        ...(s.offset ? { offset: s.offset } : {}),
      })
      const subs = res.list.map((e) => e.subscription).filter((x): x is CbSubscription => isRecord(x) && typeof x.id === 'string')
      const coupons = await couponsFor(client, subs)
      const nowSec = Math.floor(clock.now() / 1000)
      const events: NormalizedEvent[] = []
      let hwm = s.hwm
      let fallbacks = s.fallbacks
      for (const sub of subs) {
        if (hwm === null || sub.updated_at > hwm) hwm = sub.updated_at
        const rawRef = await deps.raw.put(conn.id, 'chargebee.subscription', sub.id, { subscription: sub, coupons: (sub.coupons ?? []).map((c) => coupons.get(c.coupon_id) ?? null) })
        const m = mapSubscription(sub, coupons, nowSec, conn.id, rawRef)
        if (!m) continue
        events.push(m.event)
        if (m.fallback && (m.event.status === 'active' || m.event.status === 'past_due')) fallbacks++
      }
      if (res.next_offset && subs.length > 0) {
        return { events, cursor: codec.encode({ ...s, offset: res.next_offset, hwm, fallbacks }), hasMore: true }
      }
      const done: CbCursor = { offset: null, since: hwm ?? s.since, hwm: null, fallbacks: 0 }
      return { events, cursor: codec.encode(done), hasMore: false, ...(fallbacks ? { warnings: [CB_FALLBACK_WARNING(fallbacks)] } : {}) }
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        await clientFor(conn).get('/subscriptions', { limit: 1 })
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },
  }
}
