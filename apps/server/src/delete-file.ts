// Deleting one uploaded file that no connection brought: a receipt, a paper bill, or a statement still waiting for
// "which account?" (or for a column answer). A statement that was imported belongs to its connection and goes with
// that connection's "Delete its data". What goes: the stored bytes, the documents row, and any AI write still waiting
// in review that names it as its source (rejected, so nothing is recorded from a file that's gone). A bill or receipt
// already recorded keeps its row, without the file.

import type { Kysely } from 'kysely'
import type { CoreTables } from '@agfn/db'
import type { FileStore } from '@agfn/files'

export class FileDeleteError extends Error {
  readonly status: 404 | 409
  constructor(status: 404 | 409, message: string) {
    super(message)
    this.status = status
  }
}

export async function deleteUploadedFile(deps: { db: Kysely<CoreTables>; files: FileStore; log?: (msg: string, f?: Record<string, unknown>) => void }, ws: string, documentId: string, personId: string): Promise<{ name: string; reviewsRejected: number }> {
  const { db, files } = deps
  const d = await db.selectFrom('documents').select(['id', 'storage_key', 'original_name', 'record_type', 'record_id']).where('workspace_id', '=', ws).where('id', '=', documentId).executeTakeFirst()
  if (!d) throw new FileDeleteError(404, 'That file no longer exists.')
  if (d.record_type === 'connection' && d.record_id) throw new FileDeleteError(409, 'This statement was imported. Remove it with its connection’s “Delete its data”.')
  const anyDb = db as unknown as Kysely<Record<string, Record<string, unknown>>>
  const missing = (err: unknown) => (/no such table|does not exist/i.test(String(err)) ? { numUpdatedRows: 0n } : Promise.reject(err))
  const rejected = await anyDb
    .updateTable('write_requests')
    .set({ status: 'rejected', decided_at: new Date().toISOString(), decided_by: personId, error: 'Its file was deleted.' })
    .where('workspace_id', '=', ws)
    .where('source_document_id', '=', d.id)
    .where('status', '=', 'pending_review')
    .executeTakeFirst()
    .catch(missing)
  await anyDb.updateTable('books_documents').set({ document_id: null }).where('workspace_id', '=', ws).where('document_id', '=', d.id).execute().catch(missing)
  await files.delete(d.storage_key).catch((err: unknown) => deps.log?.('file delete failed', { error: err instanceof Error ? err.message : 'unknown' }))
  await db.deleteFrom('documents').where('workspace_id', '=', ws).where('id', '=', d.id).execute()
  return { name: d.original_name ?? 'file', reviewsRejected: Number(rejected?.numUpdatedRows ?? 0n) }
}
