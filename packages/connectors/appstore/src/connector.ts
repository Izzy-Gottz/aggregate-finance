// App Store Connect connector (read-only): monthly FINANCIAL reports → App Store proceeds.
//
// One processor_balance account "App Store proceeds" per currency, one processor.balance_txn per (fiscal month,
// currency, country, sale/return); see report.ts for the money semantics (fee 0: Apple's commission isn't itemized).
//
// Cursor = last fully processed Apple fiscal month. Apple publishes the previous fiscal month's report by the first
// Friday of the current fiscal month, so a 404 for the most recent month means "not available yet": the sync stops
// and tries again next time. A 404 for an older month means Apple has no report (no sales or refunds that month).
//
// Not emitted, on purpose:
// - Daily Sales and Trends reports (/v1/salesReports): they are estimates of customer purchases, not money movements,
//   and would double-count the finance report's proceeds.
// - Payouts: Apple pays each month's proceeds to your bank about 33 days after the fiscal month ends, converted to the
//   bank's currency, and the API has no payment id. The bank-side deposit (counterparty like "APPLE INC" / "APPLE.COM")
//   is matched to the month's proceeds by amount and date; there is no exact-id linkRef to set.

import type { ConnectBegin, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, SyncResult } from '@agfn/contracts'
import { ConnectorError, cursorCodec, healthFromError, isRecord, isoTimestamp, requireSecret, str, systemClock, type Clock, type ConnectorDeps } from '@agfn/connector-sdk'
import { AppStoreClient } from './client.ts'
import { loadP8, type AppStoreKey } from './jwt.ts'
import { aggregateProceeds, parseFinanceReport } from './report.ts'

export type AppStoreSecret = AppStoreKey

export interface AppStoreConfig {
  vendorNumber: string
  keyId: string
  warnings: string[]
}

export interface AppStoreConnectorOptions {
  /** How many fiscal months to backfill on the first sync. Default 12. */
  backfillMonths?: number
}

interface AppStoreCursor {
  /** Last fully processed fiscal month (YYYY-MM); null = nothing yet. */
  last: string | null
  acct: string[]
}

const isCursor = (v: unknown): v is AppStoreCursor => isRecord(v) && (v.last === null || typeof v.last === 'string') && Array.isArray(v.acct)

const isSecret = (v: unknown): v is AppStoreSecret =>
  isRecord(v) && typeof v.issuerId === 'string' && typeof v.keyId === 'string' && typeof v.privateKey === 'string' && v.privateKey.includes('PRIVATE KEY')

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const i = y * 12 + (m - 1) + n
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`
}

export const accountId = (vendor: string, currency: string) => `appstore:${vendor}:${currency}`

export interface AppStoreConnector extends Connector {
  begin(): Promise<ConnectBegin>
}

export function createAppStoreConnector(opts: AppStoreConnectorOptions, deps: ConnectorDeps): AppStoreConnector {
  const clock: Clock = deps.clock ?? systemClock
  const codec = cursorCodec<AppStoreCursor>('appstore', 1, isCursor)
  const backfill = Math.max(1, opts.backfillMonths ?? 12)

  const description: ConnectorDescription = {
    key: 'appstore',
    name: 'App Store Connect',
    group: 'payments',
    provides: ['transactions', 'balances'],
    freshness: 'updates monthly, when Apple publishes the financial report (early in the following fiscal month)',
    auth: 'api_key',
  }

  const currentMonth = () => isoTimestamp(clock.now()).slice(0, 7)
  const vendorOf = (conn: ConnectionRef) => {
    const v = str(conn.config.vendorNumber)
    if (!v) throw new ConnectorError('invalid_input', 'connection has no vendorNumber', { provider: 'appstore' })
    return v
  }
  // One client per credential, so its bearer token (valid 15 minutes) is reused across pages and syncs.
  const clients = new Map<string, AppStoreClient>()
  const clientFor = (conn: ConnectionRef) => {
    const secret = requireSecret('appstore', conn.secret, isSecret)
    const key = `${conn.id}\0${secret.issuerId}\0${secret.keyId}\0${secret.privateKey}`
    let c = clients.get(key)
    if (!c) {
      c = new AppStoreClient(secret, deps)
      clients.set(key, c)
    }
    return c
  }

  return {
    describe: () => description,

    async begin() {
      return {
        kind: 'api_key',
        label: 'App Store Connect API key',
        steps: [
          'In App Store Connect open Users and Access → Integrations → App Store Connect API → Team Keys.',
          'Generate a key named “Aggregate” with the Finance role.',
          'Download the .p8 file (Apple shows it once) and copy the Issuer ID and the Key ID from the same page.',
          'Find your vendor number under Payments and Financial Reports, then fill in the fields here.',
        ],
        permissions: [
          'Finance role: sales, payments and financial reports only. No access to app settings, users or customer data. Making a team key needs an Admin.',
        ],
        helpUrl: 'https://appstoreconnect.apple.com/access/integrations/api',
        placeholder: '-----BEGIN PRIVATE KEY-----…',
        fields: [
          { name: 'issuerId', label: 'Issuer ID', placeholder: '57246542-96fe-1a63-e053-0824d011072a' },
          { name: 'keyId', label: 'Key ID', placeholder: '2X9R4HXF34' },
          { name: 'privateKey', label: 'Private key (.p8 contents)', placeholder: '-----BEGIN PRIVATE KEY-----…', secret: true, multiline: true },
          { name: 'vendorNumber', label: 'Vendor number', placeholder: '8xxxxxxx' },
        ],
      }
    },

    async connect(input) {
      const issuerId = str(input.issuerId)?.trim()
      const keyId = str(input.keyId)?.trim()
      const privateKey = str(input.privateKey)
      const vendorNumber = String(input.vendorNumber ?? '').trim()
      const bad = (m: string) => new ConnectorError('invalid_input', m, { provider: 'appstore' })
      if (!issuerId || !/^[0-9a-f-]{36}$/i.test(issuerId)) throw bad('issuerId must be the Issuer ID (a UUID) from App Store Connect')
      if (!keyId || !/^[A-Z0-9]{10}$/.test(keyId)) throw bad('keyId must be the 10-character Key ID')
      if (!privateKey) throw bad('privateKey (.p8 contents) is required')
      if (!/^\d{5,11}$/.test(vendorNumber)) throw bad('vendorNumber must be your App Store vendor number')
      const pem = privateKey.includes('\\n') && !privateKey.includes('\n') ? privateKey.replace(/\\n/g, '\n') : privateKey
      loadP8(pem)
      const secret: AppStoreSecret = { issuerId, keyId, privateKey: pem.trim() }
      // One harmless read: an older month's report. 404 (no sales that month) still proves the key and vendor work.
      await new AppStoreClient(secret, deps).financeReport(vendorNumber, addMonths(currentMonth(), -2))
      const config: AppStoreConfig = {
        vendorNumber,
        keyId,
        warnings: [
          "Apple's commission isn't itemized in finance reports: proceeds are recorded net (fee 0).",
          'Apple payouts are not in the API; the monthly Apple deposit in your bank is matched to proceeds by amount.',
        ],
      }
      return { secret, config: { ...config } }
    },

    async sync(conn, cursor): Promise<SyncResult> {
      const vendor = vendorOf(conn)
      const client = clientFor(conn)
      const s = codec.decode(cursor) ?? { last: null, acct: [] }
      const latest = addMonths(currentMonth(), -1)
      const month = s.last ? addMonths(s.last, 1) : addMonths(currentMonth(), -backfill)
      if (month > latest) return { events: [], cursor: codec.encode(s), hasMore: false }

      const text = await client.financeReport(vendor, month)
      if (text === null && month === latest) {
        // Not published yet: wait for the next sync (cursor unchanged).
        return { events: [], cursor: codec.encode(s), hasMore: false, warnings: [`App Store report for ${month} isn't published yet`] }
      }
      const events: NormalizedEvent[] = []
      let acct = s.acct
      if (text !== null) {
        const rows = parseFinanceReport(text)
        const groups = aggregateProceeds(month, rows)
        const rawRef = await deps.raw.put(conn.id, 'appstore.finance_report', `${vendor}:${month}`, { vendor, month, rows })
        for (const cur of [...new Set(groups.map((g) => g.currency))].sort()) {
          const id = accountId(vendor, cur)
          if (acct.includes(id)) continue
          acct = [...acct, id].sort()
          events.push({
            type: 'account.upsert',
            externalId: id,
            connectionId: conn.id,
            rawRef,
            name: `App Store proceeds (${cur})`,
            accountType: 'processor_balance',
            currency: cur,
            institution: 'Apple',
            businessHint: 'business',
          })
        }
        for (const g of groups) {
          const amount = { minor: g.amount, currency: g.currency }
          events.push({
            type: 'processor.balance_txn',
            externalId: g.key,
            connectionId: conn.id,
            rawRef,
            accountExternalId: accountId(vendor, g.currency),
            // endDate is a date-only fiscal-period end; anchor at midday UTC so the engine's workspace-tz conversion
            // keeps it on that day (T00:00:00Z would roll back to the day before in any Americas/Europe workspace).
            at: isoTimestamp(`${g.endDate}T12:00:00Z`),
            kind: g.kind,
            gross: amount,
            fee: { minor: 0, currency: g.currency },
            net: amount,
            sourceExternalId: `${month}:${g.country}`,
          })
        }
      }
      const next: AppStoreCursor = { last: month, acct }
      return { events, cursor: codec.encode(next), hasMore: month < latest }
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        await clientFor(conn).financeReport(vendorOf(conn), addMonths(currentMonth(), -2))
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },
  }
}
