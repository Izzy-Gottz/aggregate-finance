// The one line a WooCommerce connection shows in its drawer: this month's "Net sales reported by the store", read from
// the connector's report snapshots. Sales reported by the store, not booked revenue, so it's for the app only: no MCP
// tool reads it, and nothing here reaches the ledger.

import type { Money, ReportSnapshot } from '@agfn/contracts'
import type { Kysely } from 'kysely'
import { REPORT_ROW_NET_SALES } from '@agfn/connector-woocommerce'

type Db = Kysely<{ ledger_records: { workspace_id: string; connection_id: string; entity_id: string | null; event_type: string; external_id: string; status: string; event_json: string } }>

/**
 * One amount per currency for the calendar month of `now` (UTC, the month the connector files it under). `canSee` is the
 * caller's access check for a company. Nothing yet, or none the person may see: an empty list. A currency with nothing
 * this month is left out (a recompute keeps sending zeros for one a store once used), unless the whole store is quiet,
 * when its own currency shows zero.
 */
export async function storeSalesThisMonth(db: Db, ws: string, connectionId: string, storeCurrency: unknown, now: Date, canSee: (entityId: string) => Promise<boolean>): Promise<Money[]> {
  const rows = await db
    .selectFrom('ledger_records')
    .select(['entity_id', 'event_json'])
    .where('workspace_id', '=', ws)
    .where('connection_id', '=', connectionId)
    .where('event_type', '=', 'report.snapshot')
    .where('status', '=', 'recorded')
    .where('external_id', 'like', `woocommerce:${now.toISOString().slice(0, 7)}:%`)
    .execute()
  const seen = new Map<string, boolean>()
  const out: Money[] = []
  for (const r of rows) {
    if (!r.entity_id) continue
    if (!seen.has(r.entity_id)) seen.set(r.entity_id, await canSee(r.entity_id))
    if (!seen.get(r.entity_id)) continue
    const net = (JSON.parse(r.event_json) as ReportSnapshot).rows.find((x) => x.account === REPORT_ROW_NET_SALES)
    if (net) out.push(net.amount)
  }
  out.sort((a, b) => a.currency.localeCompare(b.currency))
  const moved = out.filter((m) => m.minor !== 0)
  if (moved.length) return moved
  const own = out.find((m) => m.currency === storeCurrency) ?? out[0]
  return own ? [own] : []
}
