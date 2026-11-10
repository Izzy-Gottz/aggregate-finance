import type { Kysely } from 'kysely'
import { forgetAttribution } from './creator-links.ts'
import { ownerOf, unlessDenied, withBypass, withWorkspace, type CoreTables } from '@agfn/db'
import type { FileStore } from '@agfn/files'
import type { SyncEngine } from '@agfn/sync'
import { isDemoWorkspace } from '@agfn/demo'
import { deleteWorkspace } from './delete-workspace.ts'

/**
 * A person leaves Aggregate entirely (data-retention policy §7). Refused while they are the only owner of a workspace
 * other people still belong to. A workspace they are the only member of is deleted first, the same way as
 * DELETE /api/workspace (provider access revoked, files, rows), so a failure there leaves the account as it was.
 * Then, everywhere else:
 *  - AI access they created is revoked (grants, agent keys, OAuth tokens and consent);
 *  - their Personal spaces' own bank connections are disconnected (provider access revoked, secrets wiped) and
 *    Personal documents deleted. Personal ledger rows stay, visible to nobody, because company entries can point at
 *    them (an owner paying a company bill). That trade-off is written down in the policy;
 *  - memberships are removed, and sign-in records (sessions, passkeys, linked Google/Apple, the login itself) deleted;
 *  - the person row is kept but emptied (name and email replaced) so history and the activity log still resolve.
 * Safe to run again if it stops halfway.
 */
export class SoleOwnerError extends Error {
  readonly workspaces: string[]
  constructor(workspaces: string[]) {
    super('Make someone else an owner or delete the workspace first.')
    this.workspaces = workspaces
  }
}

export interface DeleteAccountDeps {
  db: Kysely<CoreTables>
  files: FileStore
  sync: SyncEngine
  /** Revokes one grant the way the app does (keys, OAuth tokens, consent). Optional when MCP isn't installed. */
  revokeGrant?: (workspaceId: string, personId: string, grantId: string) => Promise<void>
  log?: (m: string, f?: Record<string, unknown>) => void
}

/**
 * Every workspace the person has rows in (memberships, AI grants, Personal spaces): the one cross-workspace step,
 * under a narrow named bypass (docs/security/rls.md). Everything else runs inside each workspace.
 */
async function workspacesWithRowsOf(db: Kysely<CoreTables>, personId: string): Promise<string[]> {
  const anyDb = db as unknown as Kysely<Record<string, Record<string, unknown>>>
  return withBypass('account:workspaces', async () => {
    const ids = new Set<string>()
    for (const r of await db.selectFrom('memberships').select('workspace_id').where('person_id', '=', personId).execute()) ids.add(r.workspace_id)
    for (const r of (await anyDb.selectFrom('grants').select('workspace_id').where('person_id', '=', personId).execute().catch(unlessDenied([]))) as Array<{ workspace_id: string }>) ids.add(r.workspace_id)
    for (const r of await db.selectFrom('entities').select('workspace_id').where('owner_person_id', '=', personId).execute()) ids.add(r.workspace_id)
    return [...ids]
  })
}

/**
 * The workspaces this person owns alone, split by who else is in them: `shared` (other members, no other owner) block
 * leaving; `solo` (nobody else) are deleted with the account. Demo workspaces are in neither: they always go with the
 * account (orphans.ts).
 */
export async function ownedAlone(db: Kysely<CoreTables>, personId: string): Promise<{ shared: string[]; solo: string[] }> {
  const owned = await withBypass('account:owned', () => db.selectFrom('memberships').select('workspace_id').where('person_id', '=', personId).where('role', '=', 'owner').where('revoked_at', 'is', null).execute())
  const shared: string[] = []
  const solo: string[] = []
  for (const { workspace_id } of owned) {
    const kind = await withWorkspace(workspace_id, async () => {
      if (await isDemoWorkspace(db, workspace_id)) return null
      // Pending invitees (never signed in) don't count: nobody would be stranded.
      const others = await db.selectFrom('memberships').innerJoin('people', 'people.id', 'memberships.person_id').select('memberships.role as role').where('memberships.workspace_id', '=', workspace_id).where('memberships.revoked_at', 'is', null).where('memberships.person_id', '!=', personId).where('people.auth_user_id', 'is not', null).execute()
      if (others.some((o) => o.role === 'owner')) return null
      return others.length ? 'shared' : 'solo'
    })
    if (kind === 'shared') shared.push(workspace_id)
    else if (kind === 'solo') solo.push(workspace_id)
  }
  return { shared, solo }
}

export async function soleOwnerWorkspaces(db: Kysely<CoreTables>, personId: string): Promise<string[]> {
  return (await ownedAlone(db, personId)).shared
}

export async function deleteAccount(deps: DeleteAccountDeps, personId: string): Promise<{ workspaces: number; workspacesDeleted: number; grantsRevoked: number; connectionsRevoked: number; notRevoked: string[]; documents: number }> {
  const { db, files, sync } = deps
  const anyDb = db as unknown as Kysely<Record<string, Record<string, unknown>>>
  const { shared, solo } = await ownedAlone(db, personId)
  if (shared.length) throw new SoleOwnerError(shared)

  const person = await withBypass('account:person', () => db.selectFrom('people').select(['id', 'auth_user_id']).where('id', '=', personId).executeTakeFirst())
  if (!person) return { workspaces: 0, workspacesDeleted: 0, grantsRevoked: 0, connectionsRevoked: 0, notRevoked: [], documents: 0 }
  const memberOf = await withBypass('account:memberships', () => db.selectFrom('memberships').select('workspace_id').where('person_id', '=', personId).execute())

  // 0. Workspaces only they belong to go first, whole (provider access revoked inside).
  const notRevoked: string[] = []
  for (const ws of solo) notRevoked.push(...(await withWorkspace(ws, () => deleteWorkspace(deps, ws))).notRevoked)

  let grantsRevoked = 0
  let connectionsRevoked = 0
  let documents = 0
  for (const ws of await workspacesWithRowsOf(db, personId)) {
    await withWorkspace(ws, async () => {
      // 1. AI access.
      const grants = (await anyDb.selectFrom('grants').select(['id', 'workspace_id']).where('person_id', '=', personId).where('revoked_at', 'is', null).execute().catch(unlessDenied([]))) as Array<{ id: string; workspace_id: string }>
      for (const g of grants) {
        if (deps.revokeGrant) await deps.revokeGrant(g.workspace_id, personId, g.id)
        else await anyDb.updateTable('grants').set({ revoked_at: new Date().toISOString(), revoked_by: personId }).where('id', '=', g.id).execute()
        grantsRevoked++
      }
      await anyDb.updateTable('agent_keys').set({ revoked_at: new Date().toISOString() }).where('created_by', '=', personId).where('revoked_at', 'is', null).execute().catch(unlessDenied(undefined))

      // 2. Personal spaces: their own connections and documents.
      const personal = (await db.selectFrom('entities').select('id').where('owner_person_id', '=', personId).where('kind', '=', 'personal').execute()).map((e) => e.id)
      if (personal.length) {
        const conns = await db.selectFrom('connections').select('id').where('entity_id', 'in', personal).where('status', '!=', 'disconnected').execute()
        for (const c of conns) {
          const out = await sync.disconnect(c.id)
          if (out.revoked) connectionsRevoked++
          else if (out.warning) notRevoked.push(out.warning)
        }
        const docs = await db.selectFrom('documents').select(['id', 'storage_key']).where('entity_id', 'in', personal).execute()
        for (const d of docs) {
          await files.delete(d.storage_key).catch((err: unknown) => deps.log?.('file delete failed', { error: err instanceof Error ? err.message : 'unknown' }))
          await db.deleteFrom('documents').where('id', '=', d.id).execute()
          documents++
        }
      }

      // 3. The membership itself.
      await db.deleteFrom('memberships').where('person_id', '=', personId).execute()
    })
  }

  // 4. Keep the row (history points at it) but nothing that identifies them — FIRST, so a later failure (a stubborn
  //    sign-in record) can't leave a real name and email behind. This MUST run under a bypass: the memberships are gone
  //    by now, so with AGFN_PEOPLE_RLS on the agfn_people policy hides the row from the app role and the update would
  //    silently touch 0 rows, leaving the real name and email. Assert exactly one row changed so that can't pass quietly.
  const anon = await withBypass('account:anonymize', () =>
    db.updateTable('people').set({ name: 'Former member', email: deletedTombstone(personId), auth_user_id: null }).where('id', '=', personId).executeTakeFirst(),
  )
  if (Number(anon.numUpdatedRows ?? 0) !== 1) throw new Error(`account delete did not anonymize person ${personId} (updated ${anon.numUpdatedRows ?? 0} rows)`)

  // 5. Person-level records (no workspace, so no row-level security): re-check history, then sign-in records.
  await ownerOf(anyDb).deleteFrom('reauth_events').where('person_id', '=', personId).execute().catch(unlessDenied(undefined))
  // The person row stays (anonymized), so its creator-link attribution is removed here rather than by cascade.
  await forgetAttribution(anyDb, personId).catch(unlessDenied(undefined))
  // Same for "Invite someone": the hashes of the addresses they invited, their code, and who invited whom.
  const owner = ownerOf(anyDb)
  await owner.deleteFrom('friend_signups').where((eb) => eb.or([eb('person_id', '=', personId), eb('inviter_id', '=', personId)])).execute().catch(unlessDenied(undefined))
  await owner.deleteFrom('friend_invites').where('inviter_id', '=', personId).execute().catch(unlessDenied(undefined))
  await owner.deleteFrom('friend_codes').where('person_id', '=', personId).execute().catch(unlessDenied(undefined))
  if (person.auth_user_id) {
    const uid = person.auth_user_id
    for (const t of ['auth_session', 'auth_account', 'passkey', 'oauthAccessToken', 'oauthRefreshToken', 'oauthConsent']) {
      await ownerOf(anyDb).deleteFrom(t).where('userId', '=', uid).execute().catch(unlessDenied(undefined))
    }
    await ownerOf(anyDb).deleteFrom('auth_user').where('id', '=', uid).execute()
  }

  return { workspaces: memberOf.length, workspacesDeleted: solo.length, grantsRevoked, connectionsRevoked, notRevoked, documents }
}

/**
 * The non-routable tombstone email a deleted account's person row carries. The `@invalid` form is kept (not
 * `@deleted.invalid`) because prelaunch-wipe.ts and inbound.ts key on the `@invalid` suffix; the TLD `invalid` is
 * reserved and never deliverable either way.
 */
export const deletedTombstone = (personId: string): string => `deleted-${personId}@invalid`

export interface BackfillResult {
  /** People rows that look like a deleted account whose real email was never cleared. */
  found: number
  /** How many this run tombstoned (0 on a dry run). */
  anonymized: number
  /** Up to `limit` samples for a human to sanity-check before applying — id and email DOMAIN only, never the local part. */
  samples: Array<{ id: string; emailDomain: string; createdAt: string }>
}

/**
 * Backfill for accounts deleted before anonymization was reliable: people rows that carry a real email but belong to no
 * one reachable — not a current member of any workspace, owner of no company, holder of no live AI grant, and with no
 * usable sign-in (auth_user_id null, OR pointing at an auth_user that no longer exists — the exact shape a delete that
 * removed the login but then failed to anonymize leaves). Those are orphaned former accounts (or stale pending invites
 * whose workspace is gone); either way nobody can use the address, so we replace it with the tombstone. System and demo
 * rows (reviewer, glass, demo, demo pool, challenge) use `*.aggregate.invalid`; already-tombstoned rows use
 * `…@invalid` or `…@deleted.invalid` — both suffixes (`%@invalid` and `%.invalid`) are skipped, so this is idempotent.
 * Dry run by default: pass `{ apply: true }` to write. Safe to run repeatedly.
 */
export async function anonymizeOrphanedDeletedPeople(db: Kysely<CoreTables>, opts: { apply?: boolean; limit?: number } = {}): Promise<BackfillResult> {
  const anyDb = db as unknown as Kysely<Record<string, Record<string, unknown>>>
  const sampleLimit = opts.limit ?? 20
  // Already a tombstone (never re-touch): system/demo rows end `.invalid`, deleted-account rows end `@invalid`.
  const isTombstone = (email: string) => /\.invalid$/i.test(email) || /@invalid$/i.test(email)
  return withBypass('backfill:anonymize-orphans', async () => {
    const candidates = await db
      .selectFrom('people')
      .select(['id', 'email', 'created_at', 'auth_user_id'])
      .where('email', 'not like', '%.invalid')
      .where('email', 'not like', '%@invalid')
      // Not a current member of any workspace (excludes active people and pending invitees, who keep a live membership).
      .where((eb) => eb.not(eb.exists(eb.selectFrom('memberships').select('memberships.id').whereRef('memberships.person_id', '=', 'people.id').where('memberships.revoked_at', 'is', null))))
      // Owns no company (a live owner's row is never orphaned).
      .where((eb) => eb.not(eb.exists(eb.selectFrom('entities').select('entities.id').whereRef('entities.owner_person_id', '=', 'people.id'))))
      .execute()
    // Which of these can still sign in: auth_user_id set AND that auth_user still exists. A dangling auth_user_id (login
    // already deleted) is NOT reachable, so it stays a candidate — that's the real leak shape.
    const liveUids = new Set(
      ((await ownerOf(anyDb).selectFrom('auth_user').select('id').execute().catch(unlessDenied([]))) as Array<{ id: string }>).map((u) => u.id),
    )
    // A live AI grant would mean the person is still active somewhere; the grants table lives in @agfn/mcp's schema.
    const withLiveGrant = new Set(
      ((await anyDb.selectFrom('grants').select('person_id').where('revoked_at', 'is', null).execute().catch(unlessDenied([]))) as Array<{ person_id: string }>).map((g) => g.person_id),
    )
    const orphans = candidates.filter((p) => {
      if (withLiveGrant.has(p.id)) return false
      if (p.auth_user_id && liveUids.has(p.auth_user_id)) return false // can still sign in → active, not orphaned
      return true
    })
    const samples = orphans.slice(0, sampleLimit).map((p) => ({ id: p.id, emailDomain: p.email.includes('@') ? p.email.slice(p.email.lastIndexOf('@') + 1) : '(none)', createdAt: p.created_at }))
    let anonymized = 0
    if (opts.apply) {
      for (const p of orphans) {
        if (isTombstone(p.email)) continue // belt-and-suspenders; the query already excludes these
        await db.updateTable('people').set({ name: 'Former member', email: deletedTombstone(p.id), auth_user_id: null }).where('id', '=', p.id).execute()
        anonymized++
      }
    }
    return { found: orphans.length, anonymized, samples }
  })
}
