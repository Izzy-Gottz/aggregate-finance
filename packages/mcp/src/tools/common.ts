// Shared pieces for tool definitions: the context, input schemas, money/label formatting.

import * as z from 'zod/v4'
import type { DataType, EntityId, Money, MoneyWire } from '@agfn/contracts'
import { MoneyError, parseMoney, parsePrice, wire } from '../money.ts'
import type { AddedBy, Clock, EntityInfo, FinanceReader, LiveBalancePort, SharePort } from '../ports.ts'
import { ToolError, type Access, type Principal } from '../scope.ts'
import type { ControlStore } from '../store/store.ts'
import type { WritePipeline } from '../writes.ts'
import { safeLabel } from '../untrusted.ts'

export interface ToolContext {
  principal: Principal
  access: Access
  reader: FinanceReader
  pipeline: WritePipeline
  store: ControlStore
  clock: Clock
  liveBalance?: LiveBalancePort
  share?: SharePort
  /** get_investments is on (AGFN_TOOL_INVESTMENTS). */
  investments?: boolean
  /** Set-asides in the bucket tools and available_cash (AGFN_SET_ASIDES). */
  setAsides?: boolean
  /** The app's address (e.g. https://app.aggregate.finance), for links a person opens. */
  appUrl?: string
}

export interface ToolOutput {
  data: Record<string, unknown>
  /** One or two plain sentences for the text channel. */
  summary: string
  rows?: number
  entityIds?: EntityId[]
}

export type ListWhen = 'always' | 'grant' | 'grant_and_data'

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string
  title: string
  description: string
  input: S
  /** JSON shape of structuredContent, advertised as outputSchema. */
  output?: z.ZodObject
  kind: 'read' | 'write'
  /** Changes or removes an existing record (MCP destructiveHint). Adding a new record is not destructive. */
  destructive?: boolean
  /** Hints that differ from the kind's defaults (e.g. a read that costs money and calls the bank). */
  hints?: { readOnlyHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
  /** Offered only when the deployment provides this capability. */
  requires?: 'liveBalance' | 'coverage' | 'liabilities' | 'holdings' | 'mrrMovements' | 'share' | 'investments'
  /** The tool is useful when the grant has ANY of these data types. */
  dataTypes: DataType[]
  listWhen: ListWhen
  rest: { method: 'GET' | 'POST'; path: string }
  run(ctx: ToolContext, args: z.infer<S>): Promise<ToolOutput>
}

export function defineTool<S extends z.ZodObject>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef
}

// ---------- Input schemas ----------

export const company = z
  .string()
  .min(1)
  .max(120)
  .describe('Company name or id, "Personal", or "all". Omit for every company this connection can see.')
  .optional()

export const companyRequired = z.string().min(1).max(120).describe('Company name or id (or "Personal"). Required; never inferred.')

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD')

export const moneyInput = z
  .object({
    amount: z.string().regex(/^-?\d{1,15}(\.\d{1,4})?$/, 'decimal string like "1234.56" (at most 4 decimals)').describe('Decimal string, e.g. "1234.56". Never a float.'),
    currency: z.string().regex(/^[A-Za-z]{3}$/, '3-letter ISO code').describe('ISO 4217 code, e.g. "USD".'),
  })
  .describe('Money as {amount: "1234.56", currency: "USD"}.')

export const positiveMoney = moneyInput.refine((m) => !m.amount.startsWith('-') && Number(m.amount) !== 0, 'amount must be positive; the kind says which way money moved')

export const idempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:\-]+$/)
  .describe('Unique per intended record (e.g. a UUID). Reuse only to retry the same write; a retry then returns the original record instead of a second one.')

export const reason = z.string().max(1000).describe('What the user said that led to this write, in a sentence. Stored as provenance.').optional()

export const limit = z.number().int().min(1).max(200).default(50).describe('Rows per page (default 50, max 200).')
export const cursor = z.string().max(500).describe('From next_cursor of the previous page.').optional()
export const responseFormat = z.enum(['concise', 'detailed']).default('concise').describe('concise (default) drops ids of links and audit detail; detailed returns everything.')

// ---------- Helpers ----------

export function toMinor(m: MoneyWire): Money {
  try {
    return parseMoney(m)
  } catch (err) {
    if (err instanceof MoneyError) throw new ToolError('invalid', err.message)
    throw err
  }
}

export function toPrice(m: MoneyWire): Money {
  try {
    return parsePrice(m)
  } catch (err) {
    if (err instanceof MoneyError) throw new ToolError('invalid', err.message)
    throw err
  }
}

export const w = (m: Money | null | undefined): MoneyWire | null => (m ? wire(m) : null)

export function names(entities: EntityInfo[]): Map<EntityId, string> {
  return new Map(entities.map((e) => [e.id, e.kind === 'personal' ? 'Personal' : e.name]))
}

export function addedByLabel(a: AddedBy): string {
  switch (a.kind) {
    case 'sync':
      return `synced from ${safeLabel(a.name) ?? 'a connection'}`
    case 'agent':
      return `added by ${safeLabel(a.name) ?? 'an AI'}`
    case 'person':
      return `added by ${safeLabel(a.name) ?? 'a person'}`
    case 'rule':
      return `by rule ${safeLabel(a.name) ?? ''}`.trim()
    case 'import':
      return 'imported from a file'
    case 'email':
      return 'emailed in'
  }
}

export function entityIdsOf(list: EntityInfo[]): EntityId[] {
  return list.map((e) => e.id)
}

/** Keep only rows whose entity is in scope (second line of defense behind the reader). */
export function inScope<T extends { entityId: EntityId }>(rows: T[], allowed: Set<EntityId>): T[] {
  return rows.filter((r) => allowed.has(r.entityId))
}

export function freshness(sources: Array<{ name: string; lastSyncAt: string | null; stale: boolean; health: string }>, now: Date): Record<string, string> {
  const out: Record<string, string> = {}
  for (const s of sources) {
    const label = safeLabel(s.name) ?? 'source'
    if (!s.lastSyncAt) out[label] = 'never synced'
    else {
      const mins = Math.max(0, Math.round((now.getTime() - Date.parse(s.lastSyncAt)) / 60_000))
      const ago = mins < 60 ? `${mins}m` : mins < 2880 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`
      out[label] = ago + (s.stale ? ' (stale)' : '') + (s.health !== 'ok' ? ` (${s.health})` : '')
    }
  }
  return out
}

export function sumWire(list: Money[]): MoneyWire[] {
  return list.map((m) => wire(m))
}

/** A workspace without a time zone is US Eastern, as in the ledger (core's DEFAULT_TIME_ZONE). */
const DEFAULT_TIME_ZONE = 'America/New_York'
const dayFormats = new Map<string, Intl.DateTimeFormat>()

/**
 * Today in the workspace's own time zone (workspaces.time_zone), the same day the metrics and the app use, so a
 * default window ("last 3 months", "as of today") names the same days near midnight. UTC would be a day ahead in the
 * Americas every evening.
 */
export async function workspaceToday(ctx: Pick<ToolContext, 'principal' | 'store' | 'clock'>): Promise<string> {
  const db = ctx.store.db as unknown as import('kysely').Kysely<{ workspaces: { id: string; time_zone: string | null } }>
  const row = await db.selectFrom('workspaces').select('time_zone').where('id', '=', ctx.principal.workspaceId).executeTakeFirst().catch(() => undefined)
  const zone = row?.time_zone || DEFAULT_TIME_ZONE
  let f = dayFormats.get(zone)
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    } catch {
      f = new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    }
    dayFormats.set(zone, f)
  }
  const parts = Object.fromEntries(f.formatToParts(ctx.clock.now()).map((x) => [x.type, x.value]))
  return `${parts['year']}-${parts['month']}-${parts['day']}`
}
