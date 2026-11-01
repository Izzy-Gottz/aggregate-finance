import type { Mailer } from '@agfn/auth'
import type { Kysely } from 'kysely'
import type { Ledger } from '@agfn/contracts'
import type { CoreTables, JobQueue } from '@agfn/db'
import type { KeyRing } from '@agfn/security'
import type { Auth, Permissions, createPendingGrants, createReauth } from '@agfn/auth'
import type { ConnectorRegistry, SyncEngine, SyncEngineDeps } from '@agfn/sync'
import type { Documents } from './documents.ts'
import type { FileStore } from '@agfn/files'
import type { ServerConfig } from './config.ts'
import type { UsageMeter } from './usage.ts'
import type { BackupTarget } from './backup.ts'

import type { AgfnMcpHandle } from '@agfn/mcp'
import type { PublicDemo } from './public-demo.ts'
import type { Alert } from './alerts.ts'
import type { HealthWatch } from './health-watch.ts'

export type McpModule = AgfnMcpHandle

export interface PersonCtx {
  workspaceId: string
  personId: string
  ip?: string
  userAgent?: string
}

export interface Services {
  config: ServerConfig
  db: Kysely<CoreTables>
  keys: KeyRing
  auth: Auth
  permissions: Permissions
  pendingGrants: ReturnType<typeof createPendingGrants>
  reauth: ReturnType<typeof createReauth>
  queue: JobQueue
  registry: ConnectorRegistry
  sync: SyncEngine
  /** Mutable: finance composition (S4/S5) registers route/afterSync hooks here at boot. */
  syncDeps: SyncEngineDeps
  documents: Documents
  /** Where uploads and exports live (local disk or S3/R2). */
  files: FileStore
  /** Usage metering (GET /api/usage, `agfn usage`). */
  usage: UsageMeter
  /** Operator alerts (console, and ALERT_WEBHOOK_URL when set). */
  alert?: Alert
  /** Counts /healthz "busy" answers and alerts on a long streak (health-watch.ts). */
  health?: HealthWatch
  /** Outgoing email (sign-in links come from Better Auth; this is for the app's own, e.g. re-check links). */
  mailer?: Mailer
  /** Off-site backup bucket when BACKUP_S3_* is set (`agfn backup`). */
  backupTarget?: BackupTarget
  /** S1. Until it merges, a ledger that records nothing (metrics answer no_data). */
  ledger: Ledger
  /** S7. Optional until it merges. */
  mcp?: McpModule
  /** The public no-sign-up demo at /demo/mcp (AGFN_PUBLIC_DEMO=1, needs the AI connection installed). */
  publicDemo?: PublicDemo
  /** AGFN_READY_GATE=1: false while boot's prewarm runs (/healthz answers 503, so no traffic reaches a cold machine). */
  readiness?: { ready: boolean }
}
