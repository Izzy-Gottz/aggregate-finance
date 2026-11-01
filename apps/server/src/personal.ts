// Personal is private: on the overview it shows "private" instead of an amount. Its own owner sees their numbers
// (the person the Personal space belongs to; for an older Personal with no recorded owner, the workspace's owner).
import type { Kysely } from 'kysely'
import type { CoreTables } from '@agfn/db'

/** Is this entity's amount hidden from `personId`? Companies never are. */
export async function personalHidden(db: Kysely<CoreTables>, ws: string, entity: { id: string; kind: string }, personId: string): Promise<boolean> {
  if (entity.kind !== 'personal') return false
  const row = await db.selectFrom('entities').select('owner_person_id').where('id', '=', entity.id).where('workspace_id', '=', ws).executeTakeFirst()
  if (row?.owner_person_id) return row.owner_person_id !== personId
  const owner = await db.selectFrom('memberships').select('person_id').where('workspace_id', '=', ws).where('person_id', '=', personId).where('role', '=', 'owner').where('revoked_at', 'is', null).executeTakeFirst()
  return !owner
}
