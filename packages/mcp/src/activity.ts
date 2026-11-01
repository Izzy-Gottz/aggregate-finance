// Append-only, hash-chained activity log for every actor (AI, people, system). The UI's Activity list and the
// security log both read it. Each row's hash covers the previous row's hash, so editing or deleting a row breaks
// the chain from that point on (verifyChain finds where).

import { createHash } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { CoreTables } from '@agfn/db'
import { newId } from '@agfn/db'
import type { ActivityLogTable, McpTables } from './store/schema.ts'

export const GENESIS_HASH = '0'.repeat(64)

export interface ActivityInput {
  workspaceId: string
  actorKind: ActivityLogTable['actor_kind']
  personId?: string | null
  grantId?: string | null
  actorLabel: string
  action: string
  targetType?: string | null
  targetId?: string | null
  entityIds?: string[] | null
  /** Raw arguments; amounts are redacted before storage. */
  args?: Record<string, unknown> | null
  status: ActivityLogTable['status']
  rowsReturned?: number | null
  detail?: string | null
  ip?: string | null
  userAgent?: string | null
}

export type ActivityRow = ActivityLogTable

// ---------- Redaction ----------

const MONEY_KEY = /(amount|total|price|balance|minor|cost|salary|wage|gross|net|fee|tax|value|valuation|cap|limit|payment|paid|owed|due_amount|unit_price|shares)$/i

function isMoneyLike(v: unknown): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v) && 'currency' in v && ('amount' in v || 'minor' in v)
}

/** Replace amounts with "[redacted]" and cap long strings, keeping ids, companies, dates and kinds readable. */
export function redactArgs(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[…]'
  if (typeof value === 'string') return value.length > 200 ? value.slice(0, 199) + '…' : value
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactArgs(v, depth + 1))
  if (value && typeof value === 'object') {
    if (isMoneyLike(value)) return { amount: '[redacted]', currency: (value as { currency: unknown }).currency }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (MONEY_KEY.test(k) && (typeof v === 'number' || typeof v === 'string' || isMoneyLike(v))) out[k] = isMoneyLike(v) ? redactArgs(v, depth + 1) : '[redacted]'
      else out[k] = redactArgs(v, depth + 1)
    }
    return out
  }
  return value
}

// ---------- Hashing ----------

/** Deterministic JSON: sorted keys, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  const keys = Object.keys(value).filter((k) => (value as Record<string, unknown>)[k] !== undefined).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k])).join(',') + '}'
}

function rowHash(row: Omit<ActivityRow, 'hash'>): string {
  const { prev_hash, ...rest } = row
  return createHash('sha256').update(prev_hash).update('\n').update(canonicalJson(rest)).digest('hex')
}

// ---------- Append / read / verify ----------

type Db = Kysely<CoreTables & McpTables>

/**
 * Append one row. Concurrent appends race on the (workspace_id, seq) unique constraint; the loser re-reads the
 * head and retries, so the chain stays linear on SQLite and Postgres alike.
 */
export async function appendActivity(db: Db, input: ActivityInput, at: Date): Promise<ActivityRow> {
  const args = input.args ? JSON.stringify(redactArgs(input.args)) : null
  for (let attempt = 0; attempt < 20; attempt++) {
    const head = await db
      .selectFrom('activity_log')
      .select(['seq', 'hash'])
      .where('workspace_id', '=', input.workspaceId)
      .orderBy('seq', 'desc')
      .limit(1)
      .executeTakeFirst()
    const base: Omit<ActivityRow, 'hash'> = {
      id: newId(at.getTime()),
      workspace_id: input.workspaceId,
      seq: (head?.seq ?? 0) + 1,
      at: at.toISOString(),
      actor_kind: input.actorKind,
      person_id: input.personId ?? null,
      grant_id: input.grantId ?? null,
      actor_label: input.actorLabel,
      action: input.action,
      target_type: input.targetType ?? null,
      target_id: input.targetId ?? null,
      entity_ids_json: input.entityIds ? JSON.stringify(input.entityIds) : null,
      args_json: args,
      status: input.status,
      rows_returned: input.rowsReturned ?? null,
      detail: input.detail ? input.detail.slice(0, 1000) : null,
      ip: input.ip ?? null,
      user_agent: input.userAgent ? input.userAgent.slice(0, 300) : null,
      prev_hash: head?.hash ?? GENESIS_HASH,
    }
    const row: ActivityRow = { ...base, hash: rowHash(base) }
    try {
      await db.insertInto('activity_log').values(row).execute()
      return row
    } catch (err) {
      if (!isUniqueViolation(err)) throw err
    }
  }
  throw new Error('activity log: could not append after 20 attempts')
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; errcode?: unknown; message?: unknown }
  return e?.code === '23505' || e?.code === 'ERR_SQLITE_ERROR' && /UNIQUE/i.test(String(e.message)) || /UNIQUE constraint failed|duplicate key value/i.test(String(e?.message ?? ''))
}

export interface ActivityQuery {
  grantId?: string
  personId?: string
  actorKind?: ActivityLogTable['actor_kind']
  beforeSeq?: number
  limit?: number
}

export async function listActivity(db: Db, workspaceId: string, q: ActivityQuery = {}): Promise<ActivityRow[]> {
  let sel = db.selectFrom('activity_log').selectAll().where('workspace_id', '=', workspaceId)
  if (q.grantId) sel = sel.where('grant_id', '=', q.grantId)
  if (q.personId) sel = sel.where('person_id', '=', q.personId)
  if (q.actorKind) sel = sel.where('actor_kind', '=', q.actorKind)
  if (q.beforeSeq) sel = sel.where('seq', '<', q.beforeSeq)
  return sel.orderBy('seq', 'desc').limit(Math.min(Math.max(q.limit ?? 50, 1), 500)).execute()
}

export interface ChainVerdict {
  ok: boolean
  rows: number
  /** First seq whose hash or link doesn't match. */
  brokenAtSeq?: number
}

/** Walk the whole chain in order, in pages. */
export async function verifyChain(db: Db, workspaceId: string): Promise<ChainVerdict> {
  let prev = GENESIS_HASH
  let expectedSeq = 1
  let rows = 0
  for (;;) {
    const page = await db
      .selectFrom('activity_log')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('seq', '>=', expectedSeq)
      .orderBy('seq', 'asc')
      .limit(1000)
      .execute()
    if (page.length === 0) return { ok: true, rows }
    for (const r of page) {
      const { hash, ...rest } = r
      if (r.seq !== expectedSeq || r.prev_hash !== prev || rowHash({ ...rest, rows_returned: rest.rows_returned === null ? null : Number(rest.rows_returned), seq: Number(rest.seq) }) !== hash) {
        return { ok: false, rows, brokenAtSeq: expectedSeq }
      }
      prev = hash
      expectedSeq++
      rows++
    }
  }
}
