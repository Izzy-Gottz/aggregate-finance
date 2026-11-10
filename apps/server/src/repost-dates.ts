// Operator step (run by hand via `fly ssh console`, like the challenge commands): re-date already-posted records whose
// journal entries or row date were left on the old day by a dating/posting-rule change. The at-instant work shipped
// across commits, so rows booked in between kept a UTC-sliced pay date and journal entries a day off from the ledger
// (43's Deel split runs: ledger on the 10th, payroll_runs and journal on the 11th). This forces a re-post for the
// at-bearing connectors, and #writeSource reverses and re-inserts only what actually differs — idempotent, so a second
// run changes 0. `--dry-run` writes nothing and only prints the counts.
//
//   node src/repost-dates.ts --dry-run                      # count, by connector, across all workspaces
//   node src/repost-dates.ts --connection=01M512ZK...       # heal one connection only (e.g. Deel Test)
//   node src/repost-dates.ts                                 # heal all at-bearing connections

import { fileURLToPath } from 'node:url'
import type { Ledger, NormalizedEvent } from '@agfn/contracts'
import { withBypass, withWorkspace, type CoreTables } from '@agfn/db'
import type { Kysely } from 'kysely'
import { loadConfig } from './config.ts'
import { boot } from './boot.ts'
import { loadInstalledModules } from './modules.ts'

/** The connectors whose mappers gained a real `at` instant (see commit 8d3059b3); only their rows can be date-stale. */
export const AT_BEARING_CONNECTORS = ['mercury', 'wise', 'ramp', 'deel', 'coinbase', 'stripe'] as const
/** The event types that carry `at` / a provider pay date, so their derived date can move under the new rules. */
export const AT_BEARING_EVENT_TYPES: Array<NormalizedEvent['type']> = ['payroll.run', 'txn.upsert', 'invoice.upsert']

export interface RepostDatesOptions {
  dryRun: boolean
  /** Restrict to one connection id (still only acts if it is one of the at-bearing connectors). */
  connectionId?: string
  connectorKeys?: readonly string[]
  eventTypes?: Array<NormalizedEvent['type']>
}

export interface RepostDatesResult {
  dryRun: boolean
  connectionsInScope: number
  workspaces: number
  total: number
  byConnector: Record<string, number>
}

/**
 * The scan-and-repost core, separated from boot so it is testable. The connections read is wrapped in withBypass: this
 * is an operator query with no workspace in context, so under row-level security (staging/live run as agfn_app) an
 * unwrapped SELECT would return nothing and the op would silently report a false 0. If the scan finds no connections in
 * scope it THROWS rather than print "0 re-dated" — a missing scope or unset context must fail loudly, like the other
 * silent-empty guards, so a broken run is never mistaken for a clean one. (The engine side, repostToRules, scopes per
 * workspace like redate, so it is safe under RLS.)
 */
export async function runRepostDates(db: Kysely<CoreTables>, ledger: Pick<Ledger, 'repostToRules'>, opts: RepostDatesOptions): Promise<RepostDatesResult> {
  if (!ledger.repostToRules) throw new Error('the installed ledger has no repostToRules; is the ledger module present?')
  const repostToRules = ledger.repostToRules.bind(ledger)
  const connectorKeys = [...(opts.connectorKeys ?? AT_BEARING_CONNECTORS)]
  const eventTypes = opts.eventTypes ?? AT_BEARING_EVENT_TYPES
  const conns = await withBypass('repost-dates:scan', () => {
    let q = db.selectFrom('connections').select(['id', 'workspace_id', 'connector_key']).where('connector_key', 'in', connectorKeys)
    if (opts.connectionId) q = q.where('id', '=', opts.connectionId)
    return q.execute()
  })
  if (conns.length === 0) {
    const where = opts.connectionId ? `connection ${opts.connectionId} (it must be one of the at-bearing connectors: ${connectorKeys.join(', ')})` : `any of the at-bearing connectors: ${connectorKeys.join(', ')}`
    throw new Error(`repost-dates found no connections for ${where}. Refusing to report 0: this usually means the workspace/RLS context hid them, not that there is nothing to heal. Run it where the operator reads are unrestricted.`)
  }
  const byWorkspace = new Map<string, Array<{ id: string; connectorKey: string }>>()
  for (const c of conns) {
    const list = byWorkspace.get(c.workspace_id) ?? []
    list.push({ id: c.id, connectorKey: c.connector_key })
    byWorkspace.set(c.workspace_id, list)
  }
  const byConnector: Record<string, number> = {}
  let total = 0
  for (const [ws, list] of byWorkspace) {
    // The engine's writes (ledger_versions, entries) need the workspace RLS context, exactly as the sync path sets it
    // (recheck.ts does the same: withBypass for the cross-workspace scan above, withWorkspace for the per-ws work).
    const counts = await withWorkspace(ws, () => repostToRules(ws, { connectionIds: list.map((c) => c.id), eventTypes, dryRun: opts.dryRun }))
    for (const c of list) {
      const n = counts[c.id] ?? 0
      if (!n) continue
      byConnector[c.connectorKey] = (byConnector[c.connectorKey] ?? 0) + n
      total += n
    }
  }
  return { dryRun: opts.dryRun, connectionsInScope: conns.length, workspaces: byWorkspace.size, total, byConnector }
}

export async function repostDates(opts: RepostDatesOptions, env: Record<string, string | undefined> = process.env): Promise<RepostDatesResult> {
  const config = { ...loadConfig(env), runWorker: false, role: 'web' as const }
  const modules = await loadInstalledModules(env)
  const booted = await boot({ config, env, ...modules })
  try {
    return await runRepostDates(booted.handle.db, booted.services.ledger, opts)
  } finally {
    await booted.shutdown()
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const connectionId = argv.find((a) => a.startsWith('--connection='))?.slice('--connection='.length) || undefined
  repostDates({ dryRun, connectionId })
    .then((r) => {
      const scope = connectionId ? `connection ${connectionId}` : `${r.connectionsInScope} at-bearing connections in ${r.workspaces} workspaces`
      const detail = Object.keys(r.byConnector).length ? Object.entries(r.byConnector).map(([k, n]) => `${k}=${n}`).join(' ') : 'none'
      console.log(`[agfn] repost-dates ${r.dryRun ? 'DRY RUN (nothing written)' : 'applied'}: ${scope}; records ${r.dryRun ? 'that would be' : ''} re-dated: ${r.total} (${detail})`)
      process.exit(0)
    })
    .catch((err: unknown) => {
      console.error('[agfn] repost-dates failed:', err instanceof Error ? err.message : err)
      process.exit(1)
    })
}
