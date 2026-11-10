export { newId } from './ids.ts'
export { connect, failFastCheckout, isPooled, PoolBusyError, type DbHandle, type DbKind } from './connect.ts'
export { migrateToLatest, MIGRATIONS_DIR } from './migrate.ts'
export { nodeSqliteDialect, openSqlite } from './sqlite-dialect.ts'
export * from './schema.ts'

/** Current time as ISO 8601 UTC, the format every *_at column uses. */
export function nowIso(): string {
  return new Date().toISOString()
}
export { JobQueue, RELEASE_LIVE_MS, Worker, nextDailyUtc, type Job, type JobHandler, type EnqueueOptions, type WorkerOptions } from './jobs.ts'
export { connectPglite, exclusivePool } from './pglite.ts'
export { advisoryLock, ADVISORY_KEYS } from './advisory.ts'
export { holdingConnection, outsideHeldConnection, noteCheckout, heldCheckPool, NestedCheckoutError } from './held.ts'
export { withPerf, withPerfDetached, perfCount, perfLine, perfEnabled, perfPool, type PerfCounts } from './perf.ts'
export { withWorkspace, withBypass, currentRlsContext, rlsEnabled, rlsPool, ownerPool, ownerOf, unlessDenied, enableRls, disableRls, rlsStatus, ensureAppRole, RLS_PROTOTYPE_TABLES, workspaceTables, tablesMissingRls, syncRlsPolicies, bootRls, isHostedDb, isPoolerUrl, looksLikePgbouncer, rlsSetting, RlsBootError, type RlsContext } from './rls.ts'
