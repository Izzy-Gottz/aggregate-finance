// Data access for S7's tables. Thin and typed; business rules live in control.ts and writes.ts.

import type { Kysely } from 'kysely'
import type { CoreTables } from '@agfn/db'
import { grantFromRow, type Grant } from '../grants.ts'
import type { AgentKeysTable, AiSettingsTable, GrantsTable, McpTables, WriteRequestsTable, WriteStatus } from './schema.ts'

export type McpDb = Kysely<CoreTables & McpTables>

export class ControlStore {
  readonly db: McpDb
  constructor(db: McpDb) {
    this.db = db
  }

  // ---------- grants ----------

  async insertGrant(row: GrantsTable): Promise<Grant> {
    await this.db.insertInto('grants').values(row).execute()
    return grantFromRow(row)
  }

  async getGrant(workspaceId: string, id: string): Promise<Grant | null> {
    const r = await this.db.selectFrom('grants').selectAll().where('id', '=', id).where('workspace_id', '=', workspaceId).executeTakeFirst()
    return r ? grantFromRow(r) : null
  }

  /** Lookup without a workspace (token verification gives us the grant id first). */
  async getGrantById(id: string): Promise<Grant | null> {
    const r = await this.db.selectFrom('grants').selectAll().where('id', '=', id).executeTakeFirst()
    return r ? grantFromRow(r) : null
  }

  async listGrants(workspaceId: string, opts: { personId?: string; includeRevoked?: boolean } = {}): Promise<Grant[]> {
    let q = this.db.selectFrom('grants').selectAll().where('workspace_id', '=', workspaceId)
    if (opts.personId) q = q.where('person_id', '=', opts.personId)
    if (!opts.includeRevoked) q = q.where('revoked_at', 'is', null)
    const rows = await q.orderBy('created_at', 'desc').execute()
    return rows.map(grantFromRow)
  }

  async updateGrant(workspaceId: string, id: string, patch: Partial<GrantsTable>): Promise<void> {
    await this.db.updateTable('grants').set(patch).where('id', '=', id).where('workspace_id', '=', workspaceId).execute()
  }

  async touchGrant(id: string, at: string): Promise<void> {
    await this.db.updateTable('grants').set({ last_used_at: at }).where('id', '=', id).execute()
  }

  // ---------- agent keys ----------

  async insertKey(row: AgentKeysTable): Promise<void> {
    await this.db.insertInto('agent_keys').values(row).execute()
  }

  async findKeyByHash(hash: string): Promise<AgentKeysTable | null> {
    return (await this.db.selectFrom('agent_keys').selectAll().where('key_hash', '=', hash).executeTakeFirst()) ?? null
  }

  async listKeys(workspaceId: string, opts: { grantIds?: string[]; includeRevoked?: boolean } = {}): Promise<AgentKeysTable[]> {
    let q = this.db.selectFrom('agent_keys').selectAll().where('workspace_id', '=', workspaceId)
    if (opts.grantIds) {
      if (opts.grantIds.length === 0) return []
      q = q.where('grant_id', 'in', opts.grantIds)
    }
    if (!opts.includeRevoked) q = q.where('revoked_at', 'is', null)
    return q.orderBy('created_at', 'desc').execute()
  }

  async getKey(workspaceId: string, id: string): Promise<AgentKeysTable | null> {
    return (await this.db.selectFrom('agent_keys').selectAll().where('id', '=', id).where('workspace_id', '=', workspaceId).executeTakeFirst()) ?? null
  }

  async renameKeysForGrant(grantId: string, name: string): Promise<void> {
    await this.db.updateTable('agent_keys').set({ name }).where('grant_id', '=', grantId).execute()
  }

  async revokeKeysForGrant(grantId: string, at: string): Promise<void> {
    await this.db.updateTable('agent_keys').set({ revoked_at: at }).where('grant_id', '=', grantId).where('revoked_at', 'is', null).execute()
  }

  async touchKey(id: string, at: string): Promise<void> {
    await this.db.updateTable('agent_keys').set({ last_used_at: at }).where('id', '=', id).execute()
  }

  // ---------- write requests ----------

  async findWrite(workspaceId: string, idemScope: string, key: string): Promise<WriteRequestsTable | null> {
    return (
      (await this.db
        .selectFrom('write_requests')
        .selectAll()
        .where('workspace_id', '=', workspaceId)
        .where('idem_scope', '=', idemScope)
        .where('idempotency_key', '=', key)
        .executeTakeFirst()) ?? null
    )
  }

  async getWrite(workspaceId: string, id: string): Promise<WriteRequestsTable | null> {
    return (await this.db.selectFrom('write_requests').selectAll().where('id', '=', id).where('workspace_id', '=', workspaceId).executeTakeFirst()) ?? null
  }

  /** The write that created a record (most recent applied one). */
  async findWriteByRecord(workspaceId: string, recordId: string): Promise<WriteRequestsTable | null> {
    return (
      (await this.db
        .selectFrom('write_requests')
        .selectAll()
        .where('workspace_id', '=', workspaceId)
        .where('record_id', '=', recordId)
        .where('op', '!=', 'void_record')
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst()) ?? null
    )
  }

  /** Insert; returns false when the idempotency key already exists (lost a race with a retry). */
  /**
   * A rejected write recorded nothing, so its idempotency key may be used again for a corrected write. The old row
   * stays (audit) under a retired key. Only rejected rows are touched.
   */
  async retireRejectedKey(workspaceId: string, id: string): Promise<void> {
    const row = await this.db.selectFrom('write_requests').select(['idempotency_key', 'status']).where('workspace_id', '=', workspaceId).where('id', '=', id).executeTakeFirst()
    if (!row || row.status !== 'rejected') return
    await this.db.updateTable('write_requests').set({ idempotency_key: `${row.idempotency_key.slice(0, 100)}#rejected:${id}` }).where('workspace_id', '=', workspaceId).where('id', '=', id).where('status', '=', 'rejected').execute()
  }

  async insertWrite(row: WriteRequestsTable): Promise<boolean> {
    try {
      await this.db.insertInto('write_requests').values(row).execute()
      return true
    } catch (err) {
      if (/UNIQUE constraint failed|duplicate key value/i.test(String((err as Error)?.message))) return false
      throw err
    }
  }

  async updateWrite(workspaceId: string, id: string, patch: Partial<WriteRequestsTable>): Promise<void> {
    await this.db.updateTable('write_requests').set(patch).where('id', '=', id).where('workspace_id', '=', workspaceId).execute()
  }

  /** Conditional status change, so two reviewers can't both approve. Returns true if this call won. */
  async transitionWrite(workspaceId: string, id: string, from: WriteStatus, patch: Partial<WriteRequestsTable>): Promise<boolean> {
    const res = await this.db
      .updateTable('write_requests')
      .set(patch)
      .where('id', '=', id)
      .where('workspace_id', '=', workspaceId)
      .where('status', '=', from)
      .executeTakeFirst()
    return Number(res.numUpdatedRows) === 1
  }

  /** Writes counted against a grant's daily cap: applied or waiting, not rejected. */
  async countGrantWritesSince(grantId: string, sinceIso: string): Promise<number> {
    const r = await this.db
      .selectFrom('write_requests')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('grant_id', '=', grantId)
      .where('created_at', '>=', sinceIso)
      .where('status', 'in', ['applied', 'pending_review', 'reverted'])
      .executeTakeFirst()
    return Number(r?.n ?? 0)
  }

  async listWrites(workspaceId: string, opts: { status?: WriteStatus; grantId?: string; limit?: number } = {}): Promise<WriteRequestsTable[]> {
    let q = this.db.selectFrom('write_requests').selectAll().where('workspace_id', '=', workspaceId)
    if (opts.status) q = q.where('status', '=', opts.status)
    if (opts.grantId) q = q.where('grant_id', '=', opts.grantId)
    return q.orderBy('created_at', 'desc').limit(Math.min(opts.limit ?? 100, 500)).execute()
  }

  // ---------- AI settings ----------

  async getAiSettings(workspaceId: string): Promise<AiSettingsTable> {
    const r = await this.db.selectFrom('ai_settings').selectAll().where('workspace_id', '=', workspaceId).executeTakeFirst()
    return r ?? { workspace_id: workspaceId, paused_at: null, paused_by: null, review_mode_default: 'instant', updated_at: new Date(0).toISOString() }
  }

  async putAiSettings(row: AiSettingsTable): Promise<void> {
    await this.db
      .insertInto('ai_settings')
      .values(row)
      .onConflict((oc) => oc.column('workspace_id').doUpdateSet({ paused_at: row.paused_at, paused_by: row.paused_by, review_mode_default: row.review_mode_default, updated_at: row.updated_at }))
      .execute()
  }
}
