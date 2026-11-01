// Two machines on one database (c7's multi-machine audit, 2026-10-15): the queue's "one queued and one running twin per
// (kind, unique key)" must hold when both act at once, not only when they take turns. Each case runs on SQLite and on
// Postgres (PGlite), with two JobQueues standing in for two machines.
import { afterEach, describe, expect, it } from 'vitest'
import type { KyselyPlugin, PluginTransformQueryArgs, PluginTransformResultArgs, QueryResult, RootOperationNode, UnknownRow } from 'kysely'
import { connect, connectPglite, migrateToLatest, JobQueue, type CoreTables, type DbHandle } from './index.ts'

/** Holds the result of the next SELECT this machine makes until released: its read goes stale while the other acts. */
class StaleRead implements KyselyPlugin {
  private selects = new Set<unknown>()
  private armed = false
  private release!: () => void
  private gate = Promise.resolve()
  /** Resolves once the held read has come back from the database. */
  read!: Promise<void>
  private readDone!: () => void
  arm(): () => void {
    this.armed = true
    this.gate = new Promise((r) => (this.release = r))
    this.read = new Promise((r) => (this.readDone = r))
    return () => this.release()
  }
  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    if (this.armed && args.node.kind === 'SelectQueryNode') {
      this.selects.add(args.queryId)
      this.armed = false
    }
    return args.node
  }
  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    if (this.selects.delete(args.queryId)) {
      this.readDone()
      await this.gate
    }
    return args.result
  }
}

const engines: Array<[string, () => Promise<DbHandle<CoreTables>>]> = [
  ['SQLite', async () => connect<CoreTables>('sqlite::memory:')],
  ['Postgres', async () => connectPglite<CoreTables>({ empty: true })],
]

let h: DbHandle<CoreTables> | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

describe.each(engines)('job twins across two machines (%s)', (_name, open) => {
  const setup = async () => {
    h = await open()
    await migrateToLatest(h.db)
    const stale = new StaleRead()
    return { a: new JobQueue(h.db.withPlugin(stale)), b: new JobQueue(h.db), stale, db: h.db }
  }
  const count = async (db: DbHandle<CoreTables>['db'], status: 'queued' | 'running') =>
    (await db.selectFrom('jobs').select('id').where('kind', '=', 'digest').where('unique_key', '=', 'ws1').where('status', '=', status).execute()).length

  it('both asking at once queue one job', async () => {
    const { a, b, db } = await setup()
    const ids = await Promise.all([a.enqueue('digest', {}, { uniqueKey: 'ws1' }), b.enqueue('digest', {}, { uniqueKey: 'ws1' })])
    expect(ids.filter(Boolean)).toHaveLength(1)
    expect(await count(db, 'queued')).toBe(1)
  })

  it('a machine whose read went stale never starts a twin of one already running', async () => {
    const { a, b, stale, db } = await setup()
    const t0 = new Date(Date.now() + 1_000)
    const later = new Date(t0.getTime() + 5_000)
    // A run whose lease ran out (its machine stopped mid-run).
    await b.enqueue('digest', { n: 1 }, { uniqueKey: 'ws1' })
    expect(await b.claim('w0', ['digest'], 1_000, t0)).not.toBeNull()
    // Machine A reads it as reclaimable, then stalls; meanwhile a twin is queued and machine B picks up work.
    const release = stale.arm()
    const claimA = a.claim('wA', ['digest'], 60_000, later)
    await stale.read
    // The twin is due first (asked for sooner), so it is the one machine B is offered.
    await b.enqueue('digest', { n: 2 }, { uniqueKey: 'ws1', runAt: new Date(t0.getTime() - 60_000) })
    const gotB = await b.claim('wB', ['digest'], 60_000, later)
    release()
    const gotA = await claimA
    expect([gotA, gotB].filter(Boolean)).toHaveLength(1)
    expect(await count(db, 'running')).toBe(1)
  })

  it('a run that fails while its twin waits finishes instead of queueing beside it', async () => {
    const { b, db } = await setup()
    await b.enqueue('digest', { n: 1 }, { uniqueKey: 'ws1' })
    const run = (await b.claim('w', ['digest'], 60_000))!
    await b.enqueue('digest', { n: 2 }, { uniqueKey: 'ws1' })
    await b.fail(run, new Error('mail provider down'))
    expect(await count(db, 'queued')).toBe(1)
    const row = await db.selectFrom('jobs').select(['status', 'last_error']).where('id', '=', run.id).executeTakeFirstOrThrow()
    expect(row).toEqual({ status: 'done', last_error: 'mail provider down (a queued twin runs instead)' })
  })
})

describe.each(engines)('the migration (%s)', (_name, open) => {
  it('keeps the oldest queued twin and the running twin with the latest lease', async () => {
    h = await open()
    const db = h.db
    const { up } = (await import('../migrations/0521_jobs_unique_twins.ts')) as { up: (d: unknown) => Promise<void> }
    const { down } = (await import('../migrations/0521_jobs_unique_twins.ts')) as { down: (d: unknown) => Promise<void> }
    await migrateToLatest(db)
    await down(db)
    const row = (id: string, status: 'queued' | 'running', created: string, lease: string | null) => ({
      id, workspace_id: null, kind: 'digest', payload_json: '{}', status, run_at: created, attempts: 0, max_attempts: 8,
      lease_until: lease, locked_by: lease ? 'w' : null, last_error: null, unique_key: 'ws1', created_at: created, updated_at: created,
    })
    await db.insertInto('jobs').values([
      row('q2', 'queued', '2026-10-15T09:00:02Z', null),
      row('q1', 'queued', '2026-10-15T09:00:01Z', null),
      row('r1', 'running', '2026-10-15T09:00:00Z', '2026-10-15T09:01:00Z'),
      row('r2', 'running', '2026-10-15T09:00:00Z', '2026-10-15T09:05:00Z'),
    ]).execute()
    await up(db)
    const left = await db.selectFrom('jobs').select(['id', 'status']).orderBy('id').execute()
    expect(left).toEqual([{ id: 'q1', status: 'queued' }, { id: 'r1', status: 'done' }, { id: 'r2', status: 'running' }])
  })
})
