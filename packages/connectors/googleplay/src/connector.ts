// Google Play connector (read-only): monthly earnings reports from the developer's Cloud Storage bucket →
// processor.balance_txn rows on one "Google Play earnings" processor_balance account per merchant currency.
// See report.ts for the money semantics (charge/fee/refund per order, tax as separate adjustment rows).
//
// A sync cycle: list earnings/ objects → download and map one new or changed object per page → done. The cursor keeps
// each processed object's name and generation, so a re-generated report (new generation) is processed again
// (same externalIds: idempotent) and nothing else is re-downloaded.
//
// Payouts are not in the reports bucket: Google pays the month's balance to your bank around the 15th of the next
// month. The deposit (counterparty like "GOOGLE PAYMENT" / "Google Commerce Ltd") is matched by amount; no exact-id
// linkRef is available.

import type { ConnectBegin, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, SyncResult } from '@agfn/contracts'
import { ConnectorError, cursorCodec, healthFromError, isRecord, isoTimestamp, requireSecret, str, systemClock, type Clock, type ConnectorDeps } from '@agfn/connector-sdk'
import { parseServiceAccount, type ServiceAccount } from './auth.ts'
import { GooglePlayClient, type GcsObject } from './client.ts'
import { aggregateEarnings } from './report.ts'
import { readZip } from './zip.ts'

export type GooglePlaySecret = ServiceAccount

export interface GooglePlayConfig {
  bucket: string
  clientEmail: string
  warnings: string[]
}

export interface GooglePlayConnectorOptions {
  /** How many months of earnings to backfill on the first sync. Default 24. */
  backfillMonths?: number
}

interface PlayCursor {
  stage: 'list' | 'files'
  pending: Array<{ name: string; generation: string }>
  /** object name → generation already processed. */
  done: Record<string, string>
  acct: string[]
}

const isCursor = (v: unknown): v is PlayCursor =>
  isRecord(v) && (v.stage === 'list' || v.stage === 'files') && Array.isArray(v.pending) && isRecord(v.done) && Array.isArray(v.acct)

const isSecret = (v: unknown): v is GooglePlaySecret =>
  isRecord(v) && typeof v.clientEmail === 'string' && typeof v.privateKey === 'string' && v.privateKey.includes('PRIVATE KEY')

export const EARNINGS_OBJECT = /^earnings\/earnings_(\d{6})(?:_[^/]*)?\.zip$/

export function normalizeBucket(input: string): string {
  return input.trim().replace(/^gs:\/\//, '').replace(/\/.*$/, '')
}

export const accountId = (bucket: string, currency: string) => `googleplay:${bucket}:${currency}`

export interface GooglePlayConnector extends Connector {
  begin(): Promise<ConnectBegin>
}

export function createGooglePlayConnector(opts: GooglePlayConnectorOptions, deps: ConnectorDeps): GooglePlayConnector {
  const clock: Clock = deps.clock ?? systemClock
  const codec = cursorCodec<PlayCursor>('googleplay', 1, isCursor)
  const backfill = Math.max(1, opts.backfillMonths ?? 24)

  const description: ConnectorDescription = {
    key: 'googleplay',
    name: 'Google Play',
    group: 'payments',
    provides: ['transactions', 'balances'],
    freshness: 'updates monthly, when Google publishes the earnings report (early in the following month)',
    auth: 'api_key',
  }

  const clients = new Map<string, GooglePlayClient>()
  const clientFor = (conn: ConnectionRef) => {
    const sa = requireSecret('googleplay', conn.secret, isSecret)
    const bucket = str(conn.config.bucket)
    if (!bucket) throw new ConnectorError('invalid_input', 'connection has no bucket', { provider: 'googleplay' })
    const key = `${conn.id}\0${bucket}\0${sa.clientEmail}\0${sa.privateKey}`
    let c = clients.get(key)
    if (!c) {
      c = new GooglePlayClient(sa, bucket, deps)
      clients.set(key, c)
    }
    return c
  }

  const firstMonth = () => {
    const now = new Date(clock.now())
    const i = now.getUTCFullYear() * 12 + now.getUTCMonth() - backfill
    return `${Math.floor(i / 12)}${String((i % 12) + 1).padStart(2, '0')}`
  }

  async function listPage(conn: ConnectionRef, client: GooglePlayClient, s: PlayCursor): Promise<SyncResult> {
    const objects: GcsObject[] = await client.list('earnings/')
    const from = firstMonth()
    const pending = objects
      .filter((o) => {
        const m = EARNINGS_OBJECT.exec(o.name)
        return m !== null && m[1]! >= from && s.done[o.name] !== String(o.generation)
      })
      .map((o) => ({ name: o.name, generation: String(o.generation) }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    if (pending.length === 0) return { events: [], cursor: codec.encode({ ...s, stage: 'list', pending: [] }), hasMore: false }
    return { events: [], cursor: codec.encode({ ...s, stage: 'files', pending }), hasMore: true }
  }

  async function filePage(conn: ConnectionRef, client: GooglePlayClient, s: PlayCursor): Promise<SyncResult> {
    const [obj, ...rest] = s.pending
    if (!obj) return { events: [], cursor: codec.encode({ ...s, stage: 'list' }), hasMore: false }
    const month = EARNINGS_OBJECT.exec(obj.name)?.[1] ?? '000000'
    const entries = readZip(await client.download(obj.name, obj.generation)).filter((e) => /\.csv$/i.test(e.name))
    const aggs = entries.flatMap((e) => aggregateEarnings(e.data.toString('utf8'), month))
    const rawRef = await deps.raw.put(conn.id, 'googleplay.earnings', `${obj.name}#${obj.generation}`, { object: obj, rows: aggs })
    const events: NormalizedEvent[] = []
    let acct = s.acct
    const bucket = client.bucket
    for (const cur of [...new Set(aggs.map((a) => a.currency))].sort()) {
      const id = accountId(bucket, cur)
      if (acct.includes(id)) continue
      acct = [...acct, id].sort()
      events.push({
        type: 'account.upsert',
        externalId: id,
        connectionId: conn.id,
        rawRef,
        name: `Google Play earnings (${cur})`,
        accountType: 'processor_balance',
        currency: cur,
        institution: 'Google Play',
        businessHint: 'business',
      })
    }
    for (const a of aggs) {
      const kind = a.group === 'charge' ? 'charge' : a.group === 'refund' ? 'refund' : 'adjustment'
      events.push({
        type: 'processor.balance_txn',
        externalId: a.externalId,
        connectionId: conn.id,
        rawRef,
        accountExternalId: accountId(bucket, a.currency),
        at: isoTimestamp(a.at),
        kind,
        gross: { minor: a.gross, currency: a.currency },
        fee: { minor: a.fee, currency: a.currency },
        net: { minor: a.gross - a.fee, currency: a.currency },
        sourceExternalId: a.order,
        ...(a.group === 'tax' ? { salesTax: true as const } : {}),
      })
    }
    const next: PlayCursor = { stage: rest.length ? 'files' : 'list', pending: rest, done: { ...s.done, [obj.name]: obj.generation }, acct }
    return { events, cursor: codec.encode(next), hasMore: rest.length > 0 }
  }

  return {
    describe: () => description,

    async begin() {
      return {
        kind: 'api_key',
        label: 'Google Play service account',
        steps: [
          'In Google Cloud Console create a service account named “aggregate” and download a JSON key for it.',
          'In Play Console open Users and permissions → Invite new users, paste the service account’s email and, under Account permissions, grant only “View financial data, orders, and cancellation survey responses”.',
          'In Play Console open Download reports → Financial and choose Copy Cloud Storage URI (it starts with pubsite_prod).',
          'Paste the JSON key and the bucket ID into the fields here.',
        ],
        permissions: [
          'View financial data only: earnings and sales reports. No access to apps, reviews or users.',
        ],
        helpUrl: 'https://support.google.com/googleplay/android-developer/answer/6135870',
        placeholder: '{"type":"service_account","client_email":"…","private_key":"…"}',
        fields: [
          { name: 'serviceAccountJson', label: 'Service account key (JSON)', placeholder: '{"type":"service_account",…}', secret: true, multiline: true },
          { name: 'bucket', label: 'Reports bucket', placeholder: 'pubsite_prod_rev_0123456789' },
        ],
      }
    },

    async connect(input) {
      const sa = parseServiceAccount(input.serviceAccountJson)
      const bucket = normalizeBucket(String(input.bucket ?? ''))
      if (!/^pubsite_prod_[a-z0-9_]+$/i.test(bucket)) {
        throw new ConnectorError('invalid_input', 'bucket must be your Play reports bucket (pubsite_prod_rev_…)', { provider: 'googleplay' })
      }
      // One harmless read: list one report object (proves the token works and the bucket is readable).
      await new GooglePlayClient(sa, bucket, deps).list('earnings/', 1)
      const config: GooglePlayConfig = {
        bucket,
        clientEmail: sa.clientEmail,
        warnings: ['Google Play payouts are not in the reports bucket; the monthly Google deposit in your bank is matched to earnings by amount.'],
      }
      const secret: GooglePlaySecret = sa
      return { secret, config: { ...config } }
    },

    async sync(conn, cursor) {
      const client = clientFor(conn)
      const s = codec.decode(cursor) ?? { stage: 'list', pending: [], done: {}, acct: [] }
      return s.stage === 'list' ? listPage(conn, client, s) : filePage(conn, client, s)
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        await clientFor(conn).list('earnings/', 1)
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },
  }
}
