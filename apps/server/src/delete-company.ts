// Deleting a company: one nobody uses any more (a test company, a typo, or one whose providers were removed with their
// data). Refused while anything in it still connects or counts: a live connection, an open account, a ledger record
// or journal entry that still counts, an invoice/bill or payroll run not voided, or a file (other than the uploaded statements of a disconnected connection). What disconnecting with
// "delete its data" leaves behind (closed accounts, excluded records, reversed entries, voided documents) doesn't
// count. "Deleted" sets archived_at, which every list, metric and permission already leaves out; the row stays so
// old activity-log lines and AI grants that named it still resolve.

import type { Kysely } from 'kysely'
import { nowIso, type CoreTables } from '@agfn/db'

export interface DeleteBlock {
  error: 'live_connection' | 'has_data' | 'has_files'
  reason: string
  connections?: Array<{ id: string; name: string }>
}

const names = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)

/** Why a company can't be deleted yet, or null when nothing in it connects or counts. */
export async function companyDeleteBlock(db: Kysely<CoreTables>, ws: string, entityId: string): Promise<DeleteBlock | null> {
  const q = db as unknown as Kysely<Record<string, Record<string, unknown>>>
  // A server without the ledger or books module has no such tables: nothing recorded there.
  const missing = (err: unknown) => (/no such table|does not exist/i.test(String(err)) ? [] : Promise.reject(err))
  const base = (t: string) => q.selectFrom(t).where('workspace_id', '=', ws).where('entity_id', '=', entityId)

  const live = await db.selectFrom('connections').select(['id', 'display_name']).where('workspace_id', '=', ws).where('entity_id', '=', entityId).where('status', '!=', 'disconnected').orderBy('created_at').execute()
  if (live.length) return { error: 'live_connection', reason: `Disconnect ${names([...new Set(live.map((c) => c.display_name))])} first.`, connections: live.map((c) => ({ id: c.id, name: c.display_name })) }

  // What still counts, and which (disconnected) connections it came from, so the reason can name them.
  const from = new Set<string>()
  let counts = false
  const note = (rows: Array<Record<string, unknown>>) => {
    for (const r of rows) {
      counts = true
      if (typeof r.connection_id === 'string') from.add(r.connection_id)
    }
  }
  note(await base('accounts').select(['id', 'connection_id']).where('closed_at', 'is', null).limit(50).execute().catch(missing))
  note(await base('ledger_records').select(['id', 'connection_id']).where('status', 'not in', ['excluded', 'void']).where('event_type', '!=', 'account.upsert').limit(50).execute().catch(missing))
  note(await base('journal_entries').select('id').where('reverses_id', 'is', null).where('reversed_by_id', 'is', null).limit(1).execute().catch(missing))
  note(await base('books_documents').select(['id', 'connection_id']).where('voided_at', 'is', null).limit(50).execute().catch(missing))
  note(await base('payroll_runs').select(['id', 'connection_id']).where('voided_at', 'is', null).limit(50).execute().catch(missing))
  if (counts) {
    const conns = from.size ? await db.selectFrom('connections').select('display_name').where('workspace_id', '=', ws).where('id', 'in', [...from]).execute() : []
    const which = [...new Set(conns.map((c) => c.display_name))]
    return { error: 'has_data', reason: which.length ? `Its books still count data from ${names(which)}. Remove ${which.length === 1 ? 'it' : 'them'} with “Delete its data”, then delete the company.` : 'It has records in its books people added.' }
  }
  // Files a since-disconnected connection brought (its uploaded statements) don't block: what they imported no longer
  // counts, or the check above said so.
  const gone = db.selectFrom('connections').select('id').where('workspace_id', '=', ws).where('status', '=', 'disconnected')
  const files = await db.selectFrom('documents').select('id').where('workspace_id', '=', ws).where('entity_id', '=', entityId)
    .where((eb) => eb.or([eb('record_type', 'is', null), eb('record_type', '!=', 'connection'), eb('record_id', 'is', null), eb('record_id', 'not in', gone)]))
    .limit(1).execute()
  if (files.length) return { error: 'has_files', reason: 'It has files. Delete them first.' }
  return null
}

/** Deleting a company is for owners only (admins do everything else). */
export async function isWorkspaceOwner(db: Kysely<CoreTables>, ws: string, personId: string): Promise<boolean> {
  const t = nowIso()
  const ms = await db.selectFrom('memberships').select(['role', 'expires_at']).where('workspace_id', '=', ws).where('person_id', '=', personId).where('revoked_at', 'is', null).execute()
  return ms.some((m) => m.role === 'owner' && (!m.expires_at || m.expires_at > t))
}

/** The reason alone (the company drawer's deleteBlocked), or null. */
export async function companyNotEmpty(db: Kysely<CoreTables>, ws: string, entityId: string): Promise<string | null> {
  return (await companyDeleteBlock(db, ws, entityId))?.reason ?? null
}

/** Deletes (archives) a company nothing counts in. Throws with the plain reason when something still does. */
export async function deleteEmptyCompany(db: Kysely<CoreTables>, ws: string, entityId: string): Promise<{ name: string }> {
  const e = await db.selectFrom('entities').select(['name', 'kind', 'archived_at']).where('workspace_id', '=', ws).where('id', '=', entityId).executeTakeFirst()
  if (!e || e.archived_at) throw new CompanyDeleteError(404, 'That company no longer exists.')
  if (e.kind !== 'company') throw new CompanyDeleteError(409, 'Personal can’t be deleted.')
  const block = await companyDeleteBlock(db, ws, entityId)
  if (block) throw new CompanyDeleteError(409, `${e.name} can’t be deleted: ${block.reason}`, block)
  await db.updateTable('entities').set({ archived_at: nowIso() }).where('workspace_id', '=', ws).where('id', '=', entityId).where('archived_at', 'is', null).execute()
  return { name: e.name }
}

export class CompanyDeleteError extends Error {
  readonly status: 404 | 409
  readonly block: DeleteBlock | undefined
  constructor(status: 404 | 409, message: string, block?: DeleteBlock) {
    super(message)
    this.status = status
    this.block = block
  }
}
