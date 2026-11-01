// The public no-sign-up demo: /demo/mcp (AGFN_PUBLIC_DEMO=1). Paste the URL into any AI app and ask about the demo
// companies' books, with no account, no OAuth and no key.
//
// Narrow by construction:
// - every request runs as one server-chosen principal (AgfnHttp `fixedPrincipal`): the workspace comes from the
//   `public_demo` row, never from the request, so no header, parameter or token can reach another workspace;
// - that workspace is checked each time the row is read: it carries the `public_demo` setting, and its system person
//   (reserved, undeliverable email) has exactly one membership, in it;
// - its one AI connection is read-only (control.createPublicDemoGrant), and @agfn/mcp refuses every write and every
//   tool that reaches outside Aggregate for it whatever the grant says (service.ts, PUBLIC_DEMO_READ_ONLY);
// - visitors are anonymous: no activity rows, only per-tool counts (service.publicDemoCounts); limits are per IP and
//   global, at the door (app.ts);
// - the books are rebuilt every night (UTC): a fresh person and workspace, then the pointer swaps; the old ones are
//   deleted after a grace period, so calls already under way finish on the books they started on.

import { randomBytes } from 'node:crypto'
import type { Kysely } from 'kysely'
import { newId, nowIso, withBypass, withWorkspace, type CoreTables } from '@agfn/db'
import { grantScopes, type Principal } from '@agfn/mcp'
import { INTERNAL_CONNECTORS, type SyncEngine } from '@agfn/sync'

export const PUBLIC_DEMO_EMAIL_DOMAIN = 'demo.aggregate.invalid'
export const PUBLIC_DEMO_SETTING = 'public_demo'
const POINTER = 'current'
/** How long the previous books stay readable after a swap, for calls that started on them. */
export const RETIRE_GRACE_MS = 10 * 60_000
/** How long a built workspace may still be importing before the swap goes ahead anyway. */
const SYNC_WAIT_MS = 5 * 60_000
const PRINCIPAL_TTL_MS = 30_000

export interface PublicDemoDeps {
  db: Kysely<CoreTables>
  /** Builds a filled demo workspace for the person and returns its id (reviewer.ts serverDemoBuilder). */
  buildDemo: (personId: string) => Promise<string>
  /** Creates the read-only connection in that workspace (control.createPublicDemoGrant). */
  createGrant: (workspaceId: string, personId: string, now: Date) => Promise<{ id: string }>
  /** Deletes workspaces left with no member (orphans.ts deleteIfMemberless). */
  cleanup: (workspaceIds: string[]) => Promise<number>
  /** The grant as @agfn/mcp reads it (ControlStore.getGrant). */
  getGrant: (workspaceId: string, grantId: string) => Promise<Principal['grant'] | null>
  /**
   * Queues a real sync of the demo books' connections (boot: SyncEngine.request for each). Run on every hourly tick
   * that doesn't rebuild, so "last synced" is an hour old at most and true: the made-up sources really are re-read.
   */
  resync?: (workspaceId: string) => Promise<number>
  now?: () => Date
  log?: (message: string, fields?: Record<string, unknown>) => void
  /** Test hook: how long to wait between checks for the new books' imports. */
  pollMs?: number
}

type Pointer = CoreTables['public_demo']

/** Queues a sync of each of the workspace's live connections (the public demo's hourly re-read; PublicDemoDeps.resync). */
export async function resyncConnections(db: Kysely<CoreTables>, sync: Pick<SyncEngine, 'request'>, workspaceId: string): Promise<number> {
  const rows = await db.selectFrom('connections').select('id').where('workspace_id', '=', workspaceId).where('status', 'in', ['active', 'error']).where('connector_key', 'not in', [...INTERNAL_CONNECTORS]).execute()
  for (const r of rows) await sync.request(workspaceId, r.id)
  return rows.length
}

const readPointer = (db: Kysely<CoreTables>) => withBypass('demo:pointer', () => db.selectFrom('public_demo').selectAll().where('id', '=', POINTER).executeTakeFirst())

/** True when the workspace is the public demo's and its person belongs to it alone. */
export async function isPublicDemoSafe(db: Kysely<CoreTables>, workspaceId: string, personId: string): Promise<boolean> {
  const members = await withBypass('demo:pointer', () => db.selectFrom('memberships').select('workspace_id').where('person_id', '=', personId).where('revoked_at', 'is', null).execute())
  if (members.length !== 1 || members[0]!.workspace_id !== workspaceId) return false
  const person = await withBypass('demo:pointer', () => db.selectFrom('people').select('email').where('id', '=', personId).executeTakeFirst())
  if (!person?.email?.endsWith(`@${PUBLIC_DEMO_EMAIL_DOMAIN}`)) return false
  const flag = await withWorkspace(workspaceId, () => db.selectFrom('settings').select('value_json').where('workspace_id', '=', workspaceId).where('key', '=', PUBLIC_DEMO_SETTING).executeTakeFirst())
  return flag?.value_json === 'true'
}

export class PublicDemo {
  private cached: { at: number; principal: Principal | null } | null = null
  private building: Promise<void> | null = null

  private readonly deps: PublicDemoDeps

  constructor(deps: PublicDemoDeps) {
    this.deps = deps
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  /** The principal every /demo/mcp request runs as, or null while the books are being (re)built. */
  async principal(): Promise<Principal | null> {
    const t = this.now().getTime()
    if (this.cached && t - this.cached.at < PRINCIPAL_TTL_MS) return this.cached.principal
    const principal = await this.resolve()
    this.cached = { at: t, principal }
    return principal
  }

  private async resolve(): Promise<Principal | null> {
    const row = await readPointer(this.deps.db)
    if (!row || !(await isPublicDemoSafe(this.deps.db, row.current_ws, row.person_id))) return null
    const grant = await withWorkspace(row.current_ws, () => this.deps.getGrant(row.current_ws, row.grant_id))
    if (!grant || grant.write || grant.revokedAt) return null
    return { workspaceId: row.current_ws, personId: row.person_id, grant, via: 'oauth', label: 'Public demo', scopes: grantScopes(false) }
  }

  /** At boot: build the books if there are none (in the background; /demo/mcp says "being rebuilt" meanwhile). */
  ensure(): Promise<void> {
    return this.once(async () => {
      const row = await readPointer(this.deps.db)
      if (!row || !(await this.resolve())) await this.rebuildNow()
    })
  }

  /** The hourly job: rebuild once per UTC day, and delete retired books once their grace period is over. */
  tick(): Promise<void> {
    return this.once(async () => {
      await this.retireDue()
      const row = await readPointer(this.deps.db)
      const today = this.now().toISOString().slice(0, 10)
      // Also rebuilds books that stopped being servable (a revoked connection, a changed membership).
      if (!row || row.built_at.slice(0, 10) !== today || !(await this.resolve())) return this.rebuildNow()
      if (!this.deps.resync) return
      try {
        await withWorkspace(row.current_ws, () => this.deps.resync!(row.current_ws))
      } catch (e) {
        this.deps.log?.('public demo: resync failed', { error: e instanceof Error ? e.message : String(e) })
      }
    })
  }

  /** Force a rebuild now (operators, tests). */
  rebuild(): Promise<void> {
    return this.once(() => this.rebuildNow())
  }

  /** One build at a time per process: a second caller waits for the one under way. */
  private once(fn: () => Promise<void>): Promise<void> {
    if (!this.building) this.building = fn().finally(() => (this.building = null))
    return this.building
  }

  private async rebuildNow(): Promise<void> {
    const { db } = this.deps
    const started = this.now()
    const personId = newId()
    const email = `public-demo-${randomBytes(6).toString('hex')}@${PUBLIC_DEMO_EMAIL_DOMAIN}`
    await withBypass('demo:build', () => db.insertInto('people').values({ id: personId, auth_user_id: null, name: 'Public demo', email, created_at: nowIso() }).execute())
    const workspaceId = await withBypass('demo:build', () => this.deps.buildDemo(personId))
    await withWorkspace(workspaceId, () => db.insertInto('settings').values({ workspace_id: workspaceId, key: PUBLIC_DEMO_SETTING, value_json: 'true', updated_at: nowIso() }).execute())
    await this.waitForImports(workspaceId)
    if (!(await isPublicDemoSafe(db, workspaceId, personId))) throw new Error('public demo: the new books did not end up demo-only')
    const grant = await withWorkspace(workspaceId, () => this.deps.createGrant(workspaceId, personId, this.now()))

    const old = await readPointer(db)
    const retireAfter = new Date(this.now().getTime() + RETIRE_GRACE_MS).toISOString()
    // Books retired earlier and still in their grace period go now: only one set is ever kept for in-flight calls.
    if (old?.retiring_ws && old.retiring_person) await this.retire(old.retiring_ws, old.retiring_person)
    const next: Pointer = {
      id: POINTER,
      current_ws: workspaceId,
      person_id: personId,
      grant_id: grant.id,
      built_at: started.toISOString(),
      retiring_ws: old?.current_ws ?? null,
      retiring_person: old?.person_id ?? null,
      retire_after: old ? retireAfter : null,
    }
    await withBypass('demo:pointer', async () => {
      if (old) await db.updateTable('public_demo').set(next).where('id', '=', POINTER).execute()
      else await db.insertInto('public_demo').values(next).execute()
    })
    this.cached = null
    this.deps.log?.('public demo rebuilt', { seconds: Math.round((this.now().getTime() - started.getTime()) / 1000) })
  }

  /** The demo connections import in the background after the build: wait (bounded) until none is queued or running. */
  private async waitForImports(workspaceId: string): Promise<void> {
    const until = Date.now() + SYNC_WAIT_MS
    for (;;) {
      const busy = await withBypass('demo:build', () =>
        this.deps.db.selectFrom('jobs').select('id').where('workspace_id', '=', workspaceId).where('kind', '=', 'connection.sync').where('status', 'in', ['queued', 'running']).executeTakeFirst(),
      )
      if (!busy) return
      if (Date.now() > until) {
        this.deps.log?.('public demo: imports still running, swapping anyway')
        return
      }
      await new Promise((r) => setTimeout(r, this.deps.pollMs ?? 2000))
    }
  }

  private async retireDue(): Promise<void> {
    const row = await readPointer(this.deps.db)
    if (!row?.retiring_ws || !row.retiring_person || !row.retire_after || row.retire_after > this.now().toISOString()) return
    await this.retire(row.retiring_ws, row.retiring_person)
    await withBypass('demo:pointer', () => this.deps.db.updateTable('public_demo').set({ retiring_ws: null, retiring_person: null, retire_after: null }).where('id', '=', POINTER).execute())
  }

  /** End the old books: revoke the connection, end the membership, delete the member-less workspace, then the person. */
  private async retire(workspaceId: string, personId: string): Promise<void> {
    const { db } = this.deps
    const at = nowIso()
    const anyDb = db as unknown as Kysely<Record<string, Record<string, unknown>>>
    await withWorkspace(workspaceId, async () => {
      await anyDb.updateTable('grants').set({ revoked_at: at, revoked_by: 'system:public-demo' }).where('workspace_id', '=', workspaceId).where('revoked_at', 'is', null).execute()
      await db.updateTable('memberships').set({ revoked_at: at }).where('workspace_id', '=', workspaceId).where('person_id', '=', personId).where('revoked_at', 'is', null).execute()
    })
    await this.deps.cleanup([workspaceId])
    try {
      await withBypass('demo:retire', () => db.deleteFrom('people').where('id', '=', personId).where('email', 'like', `%@${PUBLIC_DEMO_EMAIL_DOMAIN}`).execute())
    } catch (err) {
      // Something still points at the person (kept for the record): harmless, it can't sign in or be reached.
      this.deps.log?.('public demo: retired person kept', { error: err instanceof Error ? err.message.slice(0, 200) : String(err) })
    }
  }
}
