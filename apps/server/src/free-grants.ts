// Free time on a workspace: the YC Deal (a year of hosted free), by-hand grants, and the creator-link perk, in one place
// billing reads when paid plans start. Granted by ops with `agfn grant free`; the creator perk is read from its
// attribution (creator-links.ts), not stored twice.
import type { Kysely } from 'kysely'
import { newId, withWorkspace } from '@agfn/db'
import { creatorPerk } from './creator-links.ts'

export type GrantKind = 'creator' | 'yc' | 'manual'

export interface FreeGrant {
  id: string
  kind: GrantKind
  /** Months free, counted from when the workspace's billing starts (null when `until` is set). */
  months: number | null
  /** A fixed last free day, YYYY-MM-DD (null when `months` is set). */
  until: string | null
  reason: string
  grantedBy: string
  at: string
}

interface GrantTables {
  workspace_grants: { id: string; workspace_id: string; kind: string; months: number | null; until: string | null; reason: string; granted_by: string; created_at: string; revoked_at: string | null }
  workspaces: { id: string; name: string }
  people: { id: string; email: string }
  memberships: { workspace_id: string; person_id: string; role: string; revoked_at: string | null }
  settings: { workspace_id: string; key: string; value_json: string }
}
const t = (db: Kysely<any>) => db as unknown as Kysely<GrantTables>

/** A workspace id, or the email of its owner (who must own exactly one workspace that isn't a demo). */
export async function resolveWorkspace(db: Kysely<any>, ref: string): Promise<{ id: string; name: string }> {
  const ws = await t(db).selectFrom('workspaces').select(['id', 'name']).where('id', '=', ref).executeTakeFirst()
  if (ws) return ws
  if (!ref.includes('@')) throw new Error(`no workspace ${ref}`)
  const owned = await t(db)
    .selectFrom('memberships as m')
    .innerJoin('people as p', 'p.id', 'm.person_id')
    .innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
    .leftJoin('settings as s', (j) => j.onRef('s.workspace_id', '=', 'w.id').on('s.key', '=', 'demo'))
    .select(['w.id', 'w.name'])
    .where('p.email', '=', ref.trim().toLowerCase())
    .where('m.role', '=', 'owner')
    .where('m.revoked_at', 'is', null)
    .where('s.key', 'is', null)
    .execute()
  if (owned.length === 1) return owned[0]!
  if (!owned.length) throw new Error(`${ref} owns no workspace (other than a demo)`)
  throw new Error(`${ref} owns ${owned.length} workspaces; pass one id: ${owned.map((w) => `${w.id} (${w.name})`).join(', ')}`)
}

export async function grantFree(
  db: Kysely<any>,
  o: { workspaceId: string; kind: GrantKind; months?: number; until?: string; reason: string; grantedBy: string; now?: Date },
): Promise<FreeGrant> {
  if ((o.months === undefined) === (o.until === undefined)) throw new Error('give --months or --until (one of them)')
  if (o.months !== undefined && (!Number.isInteger(o.months) || o.months < 1 || o.months > 120)) throw new Error('--months must be a whole number from 1 to 120')
  if (o.until !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(o.until) || Number.isNaN(Date.parse(o.until)))) throw new Error('--until must be a date, e.g. 2027-10-31')
  const reason = o.reason.trim()
  if (!reason) throw new Error('a grant needs a --reason')
  const row = {
    id: newId(),
    workspace_id: o.workspaceId,
    kind: o.kind,
    months: o.months ?? null,
    until: o.until ?? null,
    reason,
    granted_by: o.grantedBy,
    created_at: (o.now ?? new Date()).toISOString(),
    revoked_at: null,
  }
  await withWorkspace(o.workspaceId, () => t(db).insertInto('workspace_grants').values(row).execute())
  return toGrant(row)
}

/** The workspace's live free grants, the creator perk included, oldest first. */
export async function freeGrants(db: Kysely<any>, workspaceId: string): Promise<FreeGrant[]> {
  const rows = await withWorkspace(workspaceId, () => t(db).selectFrom('workspace_grants').selectAll().where('workspace_id', '=', workspaceId).where('revoked_at', 'is', null).orderBy('created_at').orderBy('id').execute())
  const out = rows.map(toGrant)
  const perk = await creatorPerk(db, workspaceId)
  if (perk) out.push({ id: `creator:${perk.code}`, kind: 'creator', months: perk.months, until: null, reason: `creator link: ${perk.label}`, grantedBy: 'creator link', at: perk.since })
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
}

/** One line for Preferences, e.g. "12 months free (YC Deal)"; null without a grant. */
export function freeLabel(grants: FreeGrant[]): string | null {
  if (!grants.length) return null
  const g = grants.find((x) => x.kind === 'yc') ?? grants[0]!
  const what = g.months !== null ? `${g.months} month${g.months === 1 ? '' : 's'} free` : `Free through ${g.until}`
  const why = g.kind === 'yc' ? 'YC Deal' : g.kind === 'creator' ? 'creator link' : null
  return why ? `${what} (${why})` : what
}

export async function revokeFree(db: Kysely<any>, workspaceId: string, id: string, now = new Date()): Promise<boolean> {
  const r = await withWorkspace(workspaceId, () => t(db).updateTable('workspace_grants').set({ revoked_at: now.toISOString() }).where('workspace_id', '=', workspaceId).where('id', '=', id).where('revoked_at', 'is', null).executeTakeFirst())
  return Number(r.numUpdatedRows) > 0
}

function toGrant(r: GrantTables['workspace_grants']): FreeGrant {
  return { id: r.id, kind: r.kind as GrantKind, months: r.months === null ? null : Number(r.months), until: r.until, reason: r.reason, grantedBy: r.granted_by, at: r.created_at }
}
