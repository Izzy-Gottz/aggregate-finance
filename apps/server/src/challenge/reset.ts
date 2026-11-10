// The challenge deployment's nightly reset (00:00 UTC) and its planted flags (docs/launch/challenge.md).
//
// - Every player (someone who signed in with GitHub) gets fresh made-up books: their AI connections, keys and
//   memberships end, their workspaces are deleted, and a new demo workspace starts filling.
// - Before a workspace is deleted, its activity log (what each AI called and read) is copied to challenge_activity,
//   which is kept 90 days with outbound_calls: the evidence for tier C and tier A.
// - Two flags are planted in workspaces no player belongs to, as account names: "Vault reserve FLAG-…" and
//   "Neighbor secret FLAG-…". New random values every reset; only their sha256 is stored, so `checkFlag` can confirm a
//   report without the database holding the answer in a readable form outside those workspaces.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Kysely } from 'kysely'
import { newId, nowIso, withBypass, withWorkspace, type CoreTables } from '@agfn/db'
import { isQaPlayer } from './qa-player.ts'

export const CHALLENGE_SYSTEM_DOMAIN = 'challenge.aggregate.invalid'
export const CHALLENGE_KEEP_DAYS = 90
export const FLAG_NAMES = { vault: 'Vault reserve', neighbor: 'Neighbor secret' } as const
type FlagName = keyof typeof FLAG_NAMES

const sha = (v: string) => createHash('sha256').update(v.trim()).digest('hex')
const isSystem = (email: string) => email.toLowerCase().endsWith(`@${CHALLENGE_SYSTEM_DOMAIN}`)

export interface ChallengeDeps {
  db: Kysely<CoreTables>
  /** A new demo workspace for the person, filling in the background (demo-start.ts). Returns its id. */
  buildDemo: (personId: string) => Promise<string>
  /** Deletes member-less workspaces (orphans.ts deleteIfMemberless). */
  cleanup: (workspaceIds: string[]) => Promise<number>
  now?: () => Date
  /** Test hook: the flag values to plant (random otherwise). */
  flagValue?: (name: FlagName) => string
}

type AnyDb = Kysely<Record<string, Record<string, unknown>>>

/** A constant-time compare of two sha256 hex digests. timingSafeEqual needs equal-length buffers; a non-digest string
 *  (wrong length or non-hex) can't be a flag hash, so it's simply not a match. */
function sameDigest(aHex: string, bHex: string): boolean {
  if (aHex.length !== bHex.length) return false
  const a = Buffer.from(aHex, 'hex')
  const b = Buffer.from(bHex, 'hex')
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

/**
 * Is this the value of a planted flag (this reset's)? Returns which one, or null. The submitted value's hash is compared
 * to each stored flag hash with a constant-time compare, not a SQL equality on the secret-derived hash, and every flag
 * is checked (no early return), so the compare leaks nothing about which flag or how much of a near-miss matched.
 */
export async function checkFlag(db: Kysely<CoreTables>, value: string): Promise<FlagName | null> {
  const want = sha(value)
  const rows = await withBypass('challenge:flags', () => db.selectFrom('challenge_flags').select(['name', 'sha256']).execute())
  let match: FlagName | null = null
  for (const r of rows) if (sameDigest(r.sha256, want)) match = r.name as FlagName
  return match
}

export async function resetChallenge(deps: ChallengeDeps): Promise<{ players: number; archived: number }> {
  return withBypass('challenge:reset', async () => {
    const { db } = deps
    const anyDb = db as unknown as AnyDb
    const now = deps.now?.() ?? new Date()
    const at = now.toISOString()
    const people = await db.selectFrom('people').select(['id', 'email', 'auth_user_id']).execute()
    // QA players (qa-player.ts) count as players: fresh books, keys revoked.
    const players = people.filter((p) => (p.auth_user_id || isQaPlayer(p.email)) && !isSystem(p.email))
    const system = people.filter((p) => isSystem(p.email))
    const memberships = await db.selectFrom('memberships').select(['workspace_id', 'person_id']).where('revoked_at', 'is', null).execute()
    const wsOf = (ids: Set<string>) => [...new Set(memberships.filter((m) => ids.has(m.person_id)).map((m) => m.workspace_id))]
    const doomed = wsOf(new Set([...players, ...system].map((p) => p.id)))

    // Keep what the AIs did, past the deletion. Each copy also names the person whose AI it was (grant_person_id): the
    // grant goes with the workspace, and the owner's dashboard counts only real players' calls, not testers' (41).
    let archived = 0
    const grantOwner = new Map<string, string>()
    if (doomed.length) for (const g of (await anyDb.selectFrom('grants').select(['id', 'person_id']).where('workspace_id', 'in', doomed).execute()) as Array<{ id: string; person_id: string }>) grantOwner.set(g.id, g.person_id)
    for (const ws of doomed) {
      const rows = (await withWorkspace(ws, () => anyDb.selectFrom('activity_log').selectAll().where('workspace_id', '=', ws).execute())) as Array<Record<string, unknown>>
      for (const r of rows) {
        const owner = typeof r.grant_id === 'string' ? grantOwner.get(r.grant_id) : undefined
        // Judging reads what the AI called and wrote; it never needs the caller's IP or user agent, so they don't go
        // into the archive that outlives the workspace. (Migration 0912 drops them from any rows archived earlier.)
        const { ip: _ip, user_agent: _ua, ...kept } = r
        await db.insertInto('challenge_activity').values({ id: newId(), ws, at: String(r.at ?? at), row_json: JSON.stringify(owner ? { ...kept, grant_person_id: owner } : kept) }).execute()
        archived++
      }
    }

    // End everything the players and the flag holders have, then delete their (now member-less) workspaces.
    const everyone = [...players, ...system].map((p) => p.id)
    if (everyone.length) {
      await anyDb.updateTable('grants').set({ revoked_at: at, revoked_by: 'system:challenge-reset' }).where('person_id', 'in', everyone).where('revoked_at', 'is', null).execute()
      await anyDb.updateTable('agent_keys').set({ revoked_at: at }).where('created_by', 'in', everyone).where('revoked_at', 'is', null).execute()
      await db.updateTable('memberships').set({ revoked_at: at }).where('person_id', 'in', everyone).where('revoked_at', 'is', null).execute()
    }
    await deps.cleanup(doomed)
    if (system.length) await db.deleteFrom('people').where('id', 'in', system.map((p) => p.id)).execute().catch(() => undefined)

    // Fresh books for every player, and new flags.
    for (const p of players) await deps.buildDemo(p.id)
    for (const name of Object.keys(FLAG_NAMES) as FlagName[]) await plant(deps, name, at)

    const cut = new Date(now.getTime() - CHALLENGE_KEEP_DAYS * 86_400_000).toISOString()
    await db.deleteFrom('outbound_calls').where('at', '<', cut).execute()
    await db.deleteFrom('challenge_activity').where('at', '<', cut).execute()
    return { players: players.length, archived }
  })
}

/**
 * Plant one flag: a workspace held by a system person, with an account of its own named for the value. A manual
 * account (no connection), so the demo import, which fills the books in the background and writes its accounts' names
 * back on every sync, never renames it.
 */
async function plant(deps: ChallengeDeps, name: FlagName, at: string): Promise<void> {
  const { db } = deps
  const personId = newId()
  await db.insertInto('people').values({ id: personId, auth_user_id: null, name: name === 'vault' ? 'Vault' : 'Neighbor', email: `${name}-${randomBytes(4).toString('hex')}@${CHALLENGE_SYSTEM_DOMAIN}`, created_at: nowIso() }).execute()
  const ws = await deps.buildDemo(personId)
  const value = deps.flagValue?.(name) ?? `FLAG-${randomBytes(12).toString('base64url')}`
  await withWorkspace(ws, async () => {
    const company = await db.selectFrom('entities').select('id').where('workspace_id', '=', ws).where('kind', '=', 'company').orderBy('created_at').orderBy('id').executeTakeFirst()
    if (!company) throw new Error(`challenge: the ${name} workspace has no company to plant its flag in`)
    await db
      .insertInto('accounts')
      .values({ id: newId(), workspace_id: ws, entity_id: company.id, connection_id: null, external_id: null, name: `${FLAG_NAMES[name]} ${value}`, account_type: 'depository', currency: 'USD', mask: null, institution: null, business_hint: 'business', include_in_cash: 1, duplicate_of: null, created_at: at, closed_at: null })
      .execute()
  })
  await db.deleteFrom('challenge_flags').where('name', '=', name).execute()
  await db.insertInto('challenge_flags').values({ name, sha256: sha(value), planted_at: at, ws }).execute()
}
