import { monitorEventLoopDelay } from 'node:perf_hooks'
import { getHeapStatistics } from 'node:v8'
import { digestWithRecurring } from './digest.ts'
import { attributeSignup, refFromCookie } from './creator-links.ts'
import { financeFor } from './finance.ts'
import { pruneExpiredExports } from './exports.ts'
import { mkdirSync } from 'node:fs'
import type { Ledger, MetricAnswer } from '@agfn/contracts'
import { connect, ensureAppRole, migrateToLatest, newId, JobQueue, bootRls, perfEnabled, rlsEnabled, withBypass, withWorkspace, Worker, type CoreTables, type DbHandle, type JobHandler } from '@agfn/db'
import { loadKeyRing, type KeyRing } from '@agfn/security'
import { createAuth, createPendingGrants, createPermissions, createReauth, migrateAuth, type AuthConfig, type Mailer } from '@agfn/auth'
import { ConnectorRegistry, SyncEngine, SYNC_JOB, applyPendingReassignments, type ConnectorFactory } from '@agfn/sync'
import { eraseRevoked } from './retire.ts'
import { hostedConfigProblems, type ServerConfig } from './config.ts'
import type { McpModule, Services } from './services.ts'
import { consoleMailer, mailFromProblem, smtpMailer, withTestAddressesLogged } from './mailer.ts'
import { UsageMeter } from './usage.ts'
import { nextDemoImport, stalledDemoImports } from '@agfn/demo'
import { reseedReviewerDemos, serverDemoBuilder } from './reviewer.ts'
import { challengeConfigProblems } from './challenge/guard.ts'
import { startOutboundLog } from './challenge/outbound.ts'
import { resetChallenge } from './challenge/reset.ts'
import { admitDemoFillsNow, startDemoWorkspace, topUpDemoPool } from './demo-start.ts'
import { PublicDemo, resyncConnections } from './public-demo.ts'
import { publicDemoGrantShape } from '@agfn/mcp'
import { purgeRawPayloads, revokeUnboundOauthGrants, sendInactivityNotices } from './retention.ts'
import { createBackup, type BackupTarget } from './backup.ts'
import { createDocuments, type Documents } from './documents.ts'
import { createAlerter } from './alerts.ts'
import { createNotifier, type DigestSource } from './notify.ts'
import { deleteIfMemberless, deleteMemberlessWorkspaces, hasMembers, WORKSPACE_DELETE_JOB, type OrphanDeps } from './orphans.ts'
import { LocalFileStore, S3FileStore, s3ConfigFromEnv, type FileStore } from '@agfn/files'
import { join } from 'node:path'
import { createHealthWatch } from './health-watch.ts'

/** Until S1 merges: records nothing and answers every metric with no_data. */
export const emptyLedger: Ledger = {
  post: async (_ws, e) => ({ journalEntryId: null, status: e.type === 'account.upsert' ? 'recorded' : 'recorded' }),
  link: async () => ({ linkId: '', status: 'proposed' }),
  suggestLinks: async () => [],
  metric: async (name): Promise<MetricAnswer> => ({
    name,
    value: null,
    state: 'no_data',
    basis: 'cash',
    asOf: new Date().toISOString(),
    includedAccounts: [],
    excludedAccounts: [],
    staleSources: [],
    pendingReviewCount: 0,
    agentEntriesIncluded: 0,
    rowIds: [],
    formula: 'no ledger installed',
  }),
}

export interface BootOptions {
  config: ServerConfig
  env?: NodeJS.ProcessEnv
  keys?: KeyRing
  mailer?: Mailer
  /** Connector factories, or a function that builds them once platform services (the upload queue) exist. */
  connectors?: ConnectorFactory[] | ((ctx: { fileSource: Documents['fileSource'] }) => ConnectorFactory[])
  ledger?: (db: DbHandle<CoreTables>, config: Pick<ServerConfig, 'setAsides'>) => Ledger
  mcp?: (s: Omit<Services, 'mcp'>) => McpModule
  fileStore?: FileStore
  /** Where nightly backups go (tests). Default: BACKUP_S3_* when set, otherwise no backups. */
  backupTarget?: BackupTarget
  /** An already-open database (tests: PGlite). Default: connect(config.databaseUrl). */
  db?: DbHandle<CoreTables>
}

/** The longest boot's prewarm may hold a machine out of traffic (AGFN_READY_GATE): Fly's check grace is 30 s. */
export const READY_GATE_MAX_MS = 45_000
/** The nightly backup's time: 07:00 UTC (3 am Eastern, midnight Pacific), the quietest hour for US traffic. */
export const BACKUP_AT_UTC_MINUTES = 7 * 60

/** This process's release for the job queue's release guard (jobs.ts): AGFN_RELEASE, else Fly's FLY_IMAGE_REF. */
export const releaseOf = (env: Record<string, string | undefined>): string | undefined => env.AGFN_RELEASE || env.FLY_IMAGE_REF || undefined

/**
 * AGFN_READY_GATE=1, for a process about to serve (main.ts only: the release step boots and shuts down at once, and a
 * prewarm still querying would hold its pool open): load what other machines already computed (ledger_derived) before
 * taking traffic, holding /healthz at 503 until done or READY_GATE_MAX_MS. A machine that starts at the peak otherwise
 * recomputes every workspace at once and stalls everything for a minute (load runbook, run K).
 */
export function startReadyGate(booted: Booted): void {
  const s = booted.services
  if (!s.config.readyGate) return
  const readiness = { ready: false }
  s.readiness = readiness
  const done = () => {
    readiness.ready = true
  }
  setTimeout(done, READY_GATE_MAX_MS).unref()
  const ledger = s.ledger as { prewarm?: (sinceMs?: number) => Promise<number> }
  if (!ledger.prewarm) return done()
  const t = Date.now()
  void withBypass('prewarm', () => ledger.prewarm!())
    .then((n) => console.info(`[agfn] ready: prewarm loaded ${n} stored results in ${Date.now() - t} ms`))
    .catch((err: unknown) => console.warn('[agfn] prewarm failed; serving cold', { error: err instanceof Error ? err.message : String(err) }))
    .then(() => warmPublicDemo(s))
    .finally(done)
}

/**
 * The public demo's reads, run once before traffic (run P: a cold standby's first demo calls queued 7-11 s behind the
 * demo's whole-ledger search). Same principal and arguments as the load test and the docs' first questions, so the
 * 60 s demo cache and the shared ledger copy are warm. Best effort: a demo still building is skipped.
 */
export const DEMO_WARM_CALLS: Array<[string, Record<string, unknown>]> = [
  ['get_overview', {}],
  ['query_transactions', { group_by: ['month'] }],
]
async function warmPublicDemo(s: Services): Promise<void> {
  if (!s.publicDemo || !s.mcp) return
  const t = Date.now()
  try {
    const pr = await withBypass('demo:warm', () => s.publicDemo!.principal())
    if (!pr) return
    for (const [name, args] of DEMO_WARM_CALLS) await withWorkspace(pr.workspaceId, () => s.mcp!.service.callTool(pr, name, args))
    console.info(`[agfn] ready: public demo warmed in ${Date.now() - t} ms`)
  } catch (err) {
    console.warn('[agfn] public demo warm-up failed; serving cold', { error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * AGFN_PERF_LOG=1: how long the event loop was blocked, once a minute (p50/p99/max). A request that waits here never
 * shows in a tool's perf line, which only starts timing once the tool runs (run P: tools 0.1 s, callers 7-11 s).
 */
export function startLoopLagLog(): void {
  if (!perfEnabled()) return
  const h = monitorEventLoopDelay({ resolution: 20 })
  h.enable()
  const ms = (ns: number) => Math.round(ns / 1e6)
  setInterval(() => {
    // Memory with it: a heap creeping toward its limit (V8 aborts at heap_size_limit, exit 134) shows here first.
    const m = process.memoryUsage()
    const mb = (b: number) => Math.round(b / 1048576)
    const limit = mb(getHeapStatistics().heap_size_limit)
    if (h.count) console.info(`[agfn] perf loop lag: p50 ${ms(h.percentile(50))} ms, p99 ${ms(h.percentile(99))} ms, max ${ms(h.max)} ms; heap ${mb(m.heapUsed)}/${limit} MB, rss ${mb(m.rss)} MB`)
    h.reset()
  }, 30_000).unref()
}

export interface Booted {
  services: Services
  handle: DbHandle<CoreTables>
  worker?: Worker
  shutdown(): Promise<void>
}

/**
 * Row-level security for worker jobs (docs/security/rls.md). A job that belongs to one workspace (connection.sync)
 * runs inside it; jobs that span workspaces (sync.all, notify.tick, usage.rollup, retention…) run under a bypass
 * named by job kind. A workspace job that somehow has no workspace is refused rather than given a bypass.
 */
const WORKSPACE_JOBS = new Set([SYNC_JOB])
export function scoped(handlers: Record<string, JobHandler>): Record<string, JobHandler> {
  return Object.fromEntries(
    Object.entries(handlers).map(([kind, h]) => [
      kind,
      (job, signal) => {
        if (!WORKSPACE_JOBS.has(kind)) return withBypass(`worker:${kind}`, () => h(job, signal))
        if (!job.workspace_id) throw new Error(`${kind} job without a workspace`)
        return withWorkspace(job.workspace_id, () => h(job, signal))
      },
    ]),
  )
}

export async function boot(opts: BootOptions): Promise<Booted> {
  const { config } = opts
  // The challenge deployment never holds a key that can reach real money or data (challenge/guard.ts).
  if (config.challenge) {
    const problems = challengeConfigProblems(opts.env ?? process.env)
    if (problems.length) throw new Error(`Challenge deployment misconfigured. Refusing to start:\n- ${problems.join('\n- ')}`)
  }
  // Hosted (AGFN_HOSTED=1 or a Neon database) never runs with a setting missing that protects its users.
  const hostedProblems = hostedConfigProblems(opts.env ?? process.env, config)
  if (hostedProblems.length) throw new Error(`Hosted Aggregate is missing configuration (is this machine missing its fly.toml [env] block?). Refusing to start:\n- ${hostedProblems.join('\n- ')}`)
  if (config.databaseUrl.startsWith('sqlite:') && !config.databaseUrl.includes(':memory:')) mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
  const keys = opts.keys ?? loadKeyRing(opts.env ?? process.env, config.dataDir)
  const handle = opts.db ?? connect<CoreTables>(config.databaseUrl)
  await withBypass('migrate', () => migrateToLatest(handle.db))
  // The challenge: every outbound HTTP call is recorded (tier A evidence), never bodies or headers.
  const stopOutbound = config.challenge
    ? startOutboundLog((call) => {
        void withBypass('challenge:outbound', () => handle.db.insertInto('outbound_calls').values({ id: newId(), ...call }).execute()).catch(() => undefined)
        console.warn('[agfn] outbound', call.method, call.host, call.path, call.status ?? 'error', call.ws ?? '')
      })
    : undefined
  // Fails closed (rls.ts bootRls): missing or contradictory config refuses to start instead of turning isolation off.
  if (handle.kind === 'postgres') await withBypass('rls', () => bootRls(handle.db, opts.env ?? process.env, config.databaseUrl))
  // Requests switch to this role (no BYPASSRLS) so the policies actually apply; a login with BYPASSRLS (Neon's default
  // roles have it) would otherwise skip them. Created and granted here so new tables are covered at every boot.
  const rlsRole = (opts.env ?? process.env).AGFN_PG_RLS_ROLE
  if (handle.kind === 'postgres' && rlsRole && rlsEnabled(opts.env ?? process.env)) await withBypass('rls', () => ensureAppRole(handle.db, rlsRole))
  if (handle.kind === 'postgres' && rlsEnabled(opts.env ?? process.env) && !(opts.env ?? process.env).AGFN_PG_APP_URL)
    console.warn('[agfn] row-level security phase 1: requests use SET ROLE on the main login. Set AGFN_PG_APP_URL (a login for the app role) to finish phase 2 (docs/security/rls.md).')

  const pendingGrants = createPendingGrants(handle.db)
  const usage = new UsageMeter(handle.db, handle.kind)
  const mailProblem = opts.mailer ? null : mailFromProblem(opts.env ?? process.env, config.baseUrl)
  if (mailProblem) console.warn(`[agfn] ${mailProblem}`)
  const realMailer = opts.mailer ?? (config.smtpUrl ? smtpMailer(config.smtpUrl, config.mailFrom) : consoleMailer())
  const baseMailer = (opts.env ?? process.env).AGFN_LOG_TEST_LINKS === '1' ? withTestAddressesLogged(realMailer) : realMailer
  // Count every email sent (for the cost model); the count never blocks or fails the send.
  // .invalid can never receive mail (RFC 2606): the reviewer and public demo accounts live there. Sending would only bounce
  // and hurt the sending domain's reputation, so those are dropped here, for every kind of email.
  const mailer: Mailer = {
    send: async (m) => {
      if (/\.invalid$/i.test(m.to.trim().replace(/>$/, ''))) return
      await baseMailer.send(m)
      void usage.sample(null, 'email')
    },
  }
  // Production refuses to start without email: otherwise nobody receives a sign-in link and every link (a live token)
  // goes to the server log instead.
  if (!config.smtpUrl && !opts.mailer && (opts.env ?? process.env).AGFN_REQUIRE_SMTP === '1') throw new Error('SMTP_URL is required (AGFN_REQUIRE_SMTP=1): set it before starting, or sign-in links would only reach the server log')
  if (!config.smtpUrl && !config.selfHosted && !opts.mailer) console.warn('[agfn] SMTP_URL is not set: sign-in links will be printed to this console.')
  const authCfg: AuthConfig = {
    db: handle.db,
    dbKind: handle.kind,
    baseUrl: config.baseUrl,
    secret: config.authSecret,
    mailer,
    mcpResources: [`${config.baseUrl}/mcp`],
    pendingGrant: (sid, clientId, o) => pendingGrants.get(sid, clientId, o),
    ...(config.google ? { google: config.google } : {}),
    ...(config.github ? { github: config.github } : {}),
    ...(config.apple ? { apple: config.apple } : {}),
    ...(config.clientIpHeader ? { clientIpHeader: config.clientIpHeader } : {}),
    ...(config.oauthCimd ? { cimd: {} } : {}),
    // Signed up through a creator's link (/r/<code> cookie): record the attribution, once, within the link's cap.
    // Recorded just after the sign-up rather than inside it: Better Auth may still hold the sign-up's connection, and on
    // a one-connection database (SQLite, PGlite) a transaction started here would wait on it forever.
    onPersonCreated: async (personId, headers) => {
      const code = refFromCookie(headers?.get('cookie'))
      if (!code) return
      setImmediate(() => {
        void withBypass('auth:creator-link', () => attributeSignup(handle.db, handle.kind, personId, code)).catch((err: unknown) =>
          console.warn('[agfn] creator link attribution failed', { error: err instanceof Error ? err.message : String(err) }),
        )
      })
    },
  }
  if (!config.clientIpHeader && !config.selfHosted)
    console.warn('[agfn] WARNING: CLIENT_IP_HEADER is not set. Sign-in emails are still limited per address and in total, but not per client. Set it to the header your proxy adds with the real client IP (fly-client-ip on Fly.io, cf-connecting-ip behind Cloudflare, X-Real-IP if your nginx/Caddy sets it).')
  await withBypass('migrate:auth', () => migrateAuth(authCfg))
  const auth = createAuth(authCfg)
  // Better Auth's oauth-provider seeds its tables in the background; wait so short-lived processes don't close the DB under it.
  await withBypass('auth:seed', () => auth.$context)

  const registry = new ConnectorRegistry()
  const ledger = opts.ledger ? opts.ledger(handle, config) : emptyLedger
  // Accounts given a company by a migration (0301) are re-posted once, the same way as /api/accounts/assign.
  await withBypass('migrate:reassign', () => applyPendingReassignments(handle.db, ledger))
  const queue = new JobQueue(handle.db)
  const alert = createAlerter({ ...(config.alertWebhookUrl ? { webhookUrl: config.alertWebhookUrl } : {}), ...(config.alertTelegram ? { telegram: config.alertTelegram } : {}), label: new URL(config.baseUrl).host })
  // A bank asking the person to sign in again is normal; anything else from sync is worth an operator's look.
  const syncLog = (m: string, f: Record<string, unknown> = {}) => alert(f.status === 'needs_reauth' || f.level === 'info' ? 'info' : 'error', m, f)
  // Live balance checks are billed per call by Plaid: a daily per-workspace cap (AGFN_LIVE_BALANCE_DAILY_CAP, default 20),
  // and each real call is metered.
  const liveCap = Number((opts.env ?? process.env).AGFN_LIVE_BALANCE_DAILY_CAP)
  const syncDeps = {
    db: handle.db,
    keys,
    registry,
    ledger,
    queue,
    log: syncLog,
    afterSync: [] as NonNullable<import('@agfn/sync').SyncEngineDeps['afterSync']>,
    afterFailure: [] as NonNullable<import('@agfn/sync').SyncEngineDeps['afterFailure']>,
    liveBalance: { ...(Number.isInteger(liveCap) && liveCap >= 0 ? { dailyCap: liveCap } : {}), onCall: (ws: string) => usage.sample(ws, 'live_balance') },
  }
  const sync = new SyncEngine(syncDeps)
  // Demo connections import one after another: when one catches up, the next starts. Registered first, so the demo's
  // "ready" check (a later hook) already sees the next import queued.
  syncDeps.afterSync.push(async (ws, connectionId) => {
    const next = await nextDemoImport(handle.db, ws, connectionId, new Date().toISOString().slice(0, 10))
    if (next) await sync.request(ws, next)
  })
  // A failed demo import doesn't stop the others.
  syncDeps.afterFailure.push(async (ws, connectionId) => {
    const next = await nextDemoImport(handle.db, ws, connectionId, new Date().toISOString().slice(0, 10), { failed: true })
    if (next) await sync.request(ws, next)
  })
  // Hosted sets FILES_S3_BUCKET (S3/R2); self-host keeps files on the data volume.
  const s3 = s3ConfigFromEnv(opts.env ?? process.env)
  // Nightly encrypted off-site backup when BACKUP_S3_* is set (R2 or any S3 API).
  const backupS3 = s3ConfigFromEnv(opts.env ?? process.env, 'BACKUP_S3_')
  const backupTarget: BackupTarget | undefined = opts.backupTarget ?? (backupS3 ? new S3FileStore(backupS3) : undefined)
  const fileStore: FileStore = opts.fileStore ?? (s3 ? new S3FileStore(s3) : new LocalFileStore(join(config.dataDir, 'files')))
  const documents = createDocuments({ db: handle.db, store: fileStore, keys, sync })
  const factories = typeof opts.connectors === 'function' ? opts.connectors({ fileSource: documents.fileSource }) : (opts.connectors ?? [])
  for (const f of factories) registry.register(f, { raw: { put: async () => '' } })

  const base = {
    config,
    db: handle.db,
    keys,
    auth,
    permissions: createPermissions(handle.db),
    pendingGrants,
    reauth: createReauth(handle.db),
    queue,
    registry,
    sync,
    syncDeps,
    ledger,
    documents,
    files: fileStore,
    usage,
    mailer,
    alert,
    health: createHealthWatch(alert),
    ...(backupTarget ? { backupTarget } : {}),
  }
  const services: Services = { ...base, ...(opts.mcp ? { mcp: opts.mcp(base) } : {}) }
  // A provider that requires its data deleted on revoke (ERASE_ON_DISCONNECT) said the person revoked Aggregate there:
  // remove the connection and delete its data now, as a disconnect here would.
  syncDeps.afterFailure.push(async (ws, connectionId, error) => {
    const e = error as { kind?: unknown; code?: unknown } | null
    if (e && e.kind === 'auth' && e.code === 'revoked') await withWorkspace(ws, () => eraseRevoked(services, ws, connectionId))
  })
  // After every other hook (the demo's ready check is registered by the module above): a finished fill frees its slot,
  // so the next demo in line starts now rather than at the watchdog's next minute.
  if (config.demoFillConcurrency) {
    const admitNext = async () => void (await admitDemoFillsNow(services))
    syncDeps.afterSync.push(admitNext)
    syncDeps.afterFailure.push(admitNext)
  }
  const orphanDeps: OrphanDeps = { db: handle.db, files: fileStore, sync, log: (m, f) => console.warn('[agfn]', m, f ?? '') }
  if (config.publicDemo && services.mcp) {
    const mcp = services.mcp
    services.publicDemo = new PublicDemo({
      db: handle.db,
      buildDemo: serverDemoBuilder(services),
      createGrant: (workspaceId, personId, now) => mcp.control.createPublicDemoGrant({ workspaceId, personId }, { shape: publicDemoGrantShape(now) }),
      cleanup: (ids) => deleteIfMemberless(orphanDeps, ids),
      getGrant: (workspaceId, grantId) => mcp.service.store.getGrant(workspaceId, grantId),
      resync: (workspaceId) => resyncConnections(handle.db, sync, workspaceId),
      log: (m, f) => console.warn('[agfn]', m, f ?? ''),
    })
  }

  // Monday note: uses the ledger's weeklyDigest (S1) when installed.
  // Monday note: the ledger's digest, with recurring charges due this week added to the bills line.
  const digest: DigestSource | undefined = digestWithRecurring(ledger as never, handle.db, () => financeFor(services).reader)
  const notifier = createNotifier({ db: handle.db, mailer, baseUrl: config.baseUrl, ...(digest ? { digest } : {}) })

  // The demo fill's watchdog: restarts an import chain lost to a restart or a failed hook (stalledDemoImports). One
  // demo stuck three ticks running is alerted: restarting it isn't working.
  const demoStalls = new Map<string, number>()
  const demoWatchdog = async () => {
    // The fill line moves on even if a finished fill's hook was lost; the pool of ready demos is topped up.
    await admitDemoFillsNow({ db: handle.db, sync, config })
    await topUpDemoPool(services, (ids) => deleteIfMemberless(orphanDeps, ids))
    const stalled = await stalledDemoImports(handle.db)
    for (const ws of [...demoStalls.keys()]) if (!stalled.some((s) => s.workspaceId === ws)) demoStalls.delete(ws)
    for (const s of stalled) {
      const n = (demoStalls.get(s.workspaceId) ?? 0) + 1
      demoStalls.set(s.workspaceId, n)
      console.warn('[agfn] demo fill restarted', { workspaceId: s.workspaceId, connectionId: s.connectionId, times: n })
      if (n === 3) alert('error', 'demo fill keeps stalling', { workspaceId: s.workspaceId, connectionId: s.connectionId })
      await sync.request(s.workspaceId, s.connectionId)
    }
  }

  // The challenge: once per UTC day (and at the first boot), fresh player books and new flags (challenge/reset.ts).
  const challengeTick = async () => {
    const last = await handle.db.selectFrom('challenge_flags').select('planted_at').orderBy('planted_at', 'desc').executeTakeFirst()
    if (last?.planted_at.slice(0, 10) === new Date().toISOString().slice(0, 10)) return
    const r = await resetChallenge({ db: handle.db, buildDemo: async (personId) => (await startDemoWorkspace(services, personId)).workspaceId, cleanup: (ids) => deleteIfMemberless(orphanDeps, ids) })
    console.warn('[agfn] challenge reset', r)
  }
  let worker: Worker | undefined
  if (config.runWorker) {
    // Once at start: workspaces left with no member before deletion cleaned them up (counts only in the log).
    void withBypass('orphans:boot', () => deleteMemberlessWorkspaces(orphanDeps)).catch((err: unknown) => console.warn('[agfn] orphan cleanup failed', { error: err instanceof Error ? err.message : String(err) }))
    worker = new Worker(queue, {
      workerId: `${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      // The release guard (jobs.ts): during a deploy's overlap only the newest release claims jobs. Fly sets
      // FLY_IMAGE_REF per image; AGFN_RELEASE overrides it (a fresh value per deploy also makes a rollback count as new).
      // Unset (local, self-hosted single process): no guard. Only job claims wait; HTTP and /healthz never do.
      ...(releaseOf(opts.env ?? process.env)
        ? {
            release: releaseOf(opts.env ?? process.env)!,
            // Announced once the ready gate opens (startReadyGate sets services.readiness later; no gate: ready).
            releaseReady: () => services.readiness?.ready ?? true,
            onCordon: (r: string) => console.warn('[agfn] a newer release is up; this worker stops claiming jobs and finishes what it holds', { release: r }),
          }
        : {}),
      // Sync jobs run inside their workspace; jobs that span workspaces bypass row-level security by name.
      handlers: scoped({
        [SYNC_JOB]: async (job) => {
          const { connectionId } = job.payload as { connectionId: string }
          // Nobody belongs to this workspace any more: don't sync (or warm) it; the retention pass deletes it.
          if (job.workspace_id && !(await hasMembers(handle.db, job.workspace_id))) return
          const started = Date.now()
          try {
            await sync.sync(connectionId)
            await usage.sample(job.workspace_id, 'sync_ms', Date.now() - started)
          } catch (err) {
            await usage.sample(job.workspace_id, 'sync_failed')
            throw err
          }
        },
        'usage.rollup': async () => {
          await usage.rollup()
        },
        ...(backupTarget
          ? {
              'backup.nightly': async () => {
                const r = await createBackup({ db: handle.db, kind: handle.kind, keys, target: backupTarget, files: fileStore })
                console.warn('[agfn] backup uploaded', { key: r.key, bytes: r.bytes, files: r.files, pruned: r.pruned })
              },
            }
          : {}),
        // A workspace its last member just left (DELETE /api/demo): deleted here, not in the request.
        [WORKSPACE_DELETE_JOB]: async (job) => {
          const { workspaceId } = job.payload as { workspaceId: string }
          const n = await deleteIfMemberless(orphanDeps, [workspaceId])
          if (n) console.warn('[agfn] workspace deleted (queued)', { workspaceId })
        },
        'retention.purge': async () => {
          const r = await purgeRawPayloads(handle.db)
          if (r.rows) console.warn('[agfn] retention: raw payloads purged', r)
          const orphans = await revokeUnboundOauthGrants(handle.db)
          if (orphans) console.warn('[agfn] retention: never-connected AI grants revoked', { count: orphans })
          await deleteMemberlessWorkspaces(orphanDeps)
          const idle = await sendInactivityNotices({ db: handle.db, mailer, baseUrl: config.baseUrl })
          if (idle.notified) console.warn('[agfn] retention: 90-day inactivity notices sent', { workspaces: idle.notified })
        },
        ...(config.reviewerLinks
          ? {
              // Reviewer accounts get fresh demo books every night (reviewer.ts).
              'reviewer.reseed': async () => {
                const n = await reseedReviewerDemos({ db: handle.db, buildDemo: serverDemoBuilder(services), cleanup: (ids) => deleteIfMemberless(orphanDeps, ids) })
                if (n) console.warn('[agfn] reviewer demos rebuilt', { accounts: n })
              },
            }
          : {}),
        ...(config.challenge
          ? {
              // Fresh player books and new flags once per UTC day (challenge/reset.ts).
              'challenge.tick': challengeTick,
            }
          : {}),
        ...(services.publicDemo
          ? {
              // The public demo's books: rebuilt once per UTC day, retired books deleted after their grace (public-demo.ts).
              'publicdemo.tick': async () => {
                await services.publicDemo!.tick()
              },
            }
          : {}),
        'demo.watchdog': demoWatchdog,
        'sync.all': async () => {
          // Start times spread over most of the interval; demo connections once a day (docs/launch/load-runbook.md).
          await sync.requestAll({ spreadMs: config.syncEveryMs * 0.8, demoEveryMs: 23 * 3600_000 })
        },
        'notify.tick': async () => {
          await notifier.connectionAlerts()
          await notifier.weekly()
          await notifier.blockedAsks()
        },
        'jobs.prune': async () => {
          await queue.prune(new Date(Date.now() - 7 * 86400_000))
        },
        // Export files are whole-workspace copies: gone once their one-hour link expires.
        'exports.prune': async () => {
          await pruneExpiredExports(handle.db, fileStore)
        },
      }),
      every: { 'demo.watchdog': 60_000, 'sync.all': config.syncEveryMs, 'jobs.prune': 86400_000, 'exports.prune': 3600_000, 'notify.tick': 3600_000, 'usage.rollup': 86400_000, 'retention.purge': 86400_000, ...(config.reviewerLinks ? { 'reviewer.reseed': 86400_000 } : {}), ...(config.challenge ? { 'challenge.tick': 3600_000 } : {}), ...(services.publicDemo ? { 'publicdemo.tick': 3600_000 } : {}) },
      // The nightly backup at a quiet hour for the US (07:00Z is 3 am Eastern), from the clock, not the last run.
      ...(backupTarget ? { dailyAtUtc: { 'backup.nightly': BACKUP_AT_UTC_MINUTES } } : {}),
      onError: (job, err) => alert('error', 'job failed', { job: job.kind, error: err instanceof Error ? err.message : String(err) }),
    })
    // The queue itself spans workspaces (recurring jobs have no workspace; claim/complete/fail touch any job), so the
    // worker loop runs in bypass. The context follows its timers; each handler still enters its own bypass scope.
    const w = worker
    await withBypass('worker:queue', () => w.start())
    // Nothing runs straight from boot: start() re-queues every recurring job due now (recurring:<kind> pulled to now),
    // so the public demo's books (publicdemo.tick builds them when there are none), the demo watchdog (fills a restart
    // cut off, the pool) and the challenge reset run at once, through the queue. A machine still up during a deploy
    // may be running the same job; the queue never runs twins at once, so two machines never fill the same pool slot
    // or build the books twice.
  }

  return {
    services,
    handle,
    ...(worker ? { worker } : {}),
    async shutdown() {
      stopOutbound?.()
      await worker?.stop()
      await handle.close()
    },
  }
}
