// "Don't see your app? Request it +" at the foot of Add a connection: a fixed list of apps we could add next, and one
// row per workspace that asked for one. Names only (no logos, no free text, no promises). A row holds the workspace and
// the app key and when, nothing about the person who clicked or where from. The operator reads the totals with
// `agfn connection-requests` (app → how many workspaces). Not an MCP tool: the AI's tools/list doesn't change.

import type { Kysely } from 'kysely'

export interface ConnectionRequestsTable {
  workspace_id: string
  app_key: string
  created_at: string
}
export interface ConnectionRequestTables {
  connection_requests: ConnectionRequestsTable
}

/**
 * Hospitable, plus every "Self-host" and "In development" name in docs/connectors.md (connection-requests.test.ts keeps
 * the two in step). Keys match the connector packages, so a name the drawer already offers here is left out.
 */
export const REQUESTABLE: ReadonlyArray<{ key: string; name: string }> = [
  { key: 'hospitable', name: 'Hospitable' },
  { key: 'paypal', name: 'PayPal' },
  { key: 'lemonsqueezy', name: 'Lemon Squeezy' },
  { key: 'chargebee', name: 'Chargebee' },
  { key: 'patreon', name: 'Patreon' },
  { key: 'woocommerce', name: 'WooCommerce' },
  { key: 'bigcommerce', name: 'BigCommerce' },
  { key: 'amazon', name: 'Amazon' },
  { key: 'lightspeed', name: 'Lightspeed Retail' },
  { key: 'mollie', name: 'Mollie' },
  { key: 'whop', name: 'Whop' },
  { key: 'ownerrez', name: 'OwnerRez' },
  { key: 'squarespace', name: 'Squarespace' },
  { key: 'youtube', name: 'YouTube' },
  { key: 'pinterest', name: 'Pinterest Ads' },
  { key: 'wix', name: 'Wix' },
  { key: 'adsense', name: 'Google AdSense' },
  { key: 'sumup', name: 'SumUp' },
  { key: 'revenuecat', name: 'RevenueCat' },
  { key: 'expensify', name: 'Expensify' },
  { key: 'harvest', name: 'Harvest' },
  { key: 'justworks', name: 'Justworks' },
  { key: 'rippling', name: 'Rippling' },
  { key: 'carta', name: 'Carta' },
  { key: 'coinbase', name: 'Coinbase' },
]

export const isRequestable = (key: string): boolean => REQUESTABLE.some((a) => a.key === key)

type Db = Kysely<ConnectionRequestTables>
const t = (db: unknown): Db => db as Db

/** The list for this workspace: each name, and whether it has asked already. `offered` keys are left out. */
export async function requestList(db: unknown, workspaceId: string, offered: ReadonlySet<string> = new Set()): Promise<Array<{ key: string; name: string; requested: boolean }>> {
  const rows = await t(db).selectFrom('connection_requests').select('app_key').where('workspace_id', '=', workspaceId).execute()
  const asked = new Set(rows.map((r) => r.app_key))
  return REQUESTABLE.filter((a) => !offered.has(a.key)).map((a) => ({ ...a, requested: asked.has(a.key) }))
}

/** Once per workspace per app: asking again changes nothing. Returns whether this call added the row. */
export async function requestConnection(db: unknown, workspaceId: string, appKey: string, now: Date = new Date()): Promise<boolean> {
  const r = await t(db)
    .insertInto('connection_requests')
    .values({ workspace_id: workspaceId, app_key: appKey, created_at: now.toISOString() })
    .onConflict((o) => o.columns(['workspace_id', 'app_key']).doNothing())
    .executeTakeFirst()
  return Number(r.numInsertedOrUpdatedRows ?? 0) > 0
}

/** Operator totals across workspaces (callers run it under a named bypass): app → workspaces that asked, most first. */
export async function requestCounts(db: unknown): Promise<Array<{ key: string; name: string; workspaces: number }>> {
  const rows = await t(db)
    .selectFrom('connection_requests')
    .select(['app_key', (eb) => eb.fn.countAll<number | string | bigint>().as('n')])
    .groupBy('app_key')
    .execute()
  return rows
    .map((r) => ({ key: r.app_key, name: REQUESTABLE.find((a) => a.key === r.app_key)?.name ?? r.app_key, workspaces: Number(r.n) }))
    .sort((a, b) => b.workspaces - a.workspaces || a.name.localeCompare(b.name))
}
