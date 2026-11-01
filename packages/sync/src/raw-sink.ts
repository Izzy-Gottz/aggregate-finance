import { createHash } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { RawSink } from '@agfn/contracts'
import { nowIso, type CoreTables } from '@agfn/db'
import { rawId } from '@agfn/connector-sdk'

type RawRow = { id: string; workspace_id: string; connection_id: string; kind: string; external_id: string; payload_json: string; sha256: string; received_at: string }

/**
 * Stores exactly what a provider sent, once per distinct payload (deterministic id from the SDK). With `batch`, rows
 * are held until `flush()` (the sync engine flushes before posting each page) or 200 are waiting; else written at once.
 */
export class DbRawSink implements RawSink {
  private db: Kysely<CoreTables>
  private workspaceId: string
  private held: RawRow[] = []
  private batch: boolean
  constructor(db: Kysely<CoreTables>, workspaceId: string, opts: { batch?: boolean } = {}) {
    this.db = db
    this.workspaceId = workspaceId
    this.batch = opts.batch ?? false
  }

  async put(connectionId: string, kind: string, externalId: string, payload: unknown): Promise<string> {
    const id = rawId(connectionId, kind, externalId, payload)
    const json = JSON.stringify(payload ?? null)
    this.held.push({ id, workspace_id: this.workspaceId, connection_id: connectionId, kind, external_id: externalId, payload_json: json, sha256: createHash('sha256').update(json).digest('hex'), received_at: nowIso() })
    if (!this.batch || this.held.length >= 200) await this.flush()
    return id
  }

  async flush(): Promise<void> {
    while (this.held.length > 0) {
      // Same payload twice in one batch: one row (the conflict clause can't see rows in the same statement on Postgres).
      const batch = [...new Map(this.held.splice(0, 200).map((r) => [r.id, r])).values()]
      await this.db.insertInto('raw_records').values(batch).onConflict((oc) => oc.doNothing()).execute()
    }
  }
}
