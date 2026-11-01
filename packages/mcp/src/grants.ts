// Grants: the "control sentence" behind every connected AI.
// companies × data types × read/add × review mode × expiry × daily cap. A grant never exceeds its person:
// every check here is ANDed with the person's own can() (see scope.ts).

import type { Action, DataType, EntityId, GrantId, GrantShape, IsoTimestamp, PersonId, WorkspaceId } from '@agfn/contracts'
import type { EntityInfo } from './ports.ts'
import type { GrantsTable } from './store/schema.ts'

/** The client id of the public no-sign-up demo's one connection (apps/server/src/public-demo.ts). */
export const PUBLIC_DEMO_CLIENT = 'public-demo'

export interface Grant extends GrantShape {
  id: GrantId
  workspaceId: WorkspaceId
  personId: PersonId
  kind: 'oauth' | 'key'
  clientId: string
  clientName: string
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
  revokedAt: IsoTimestamp | null
  lastUsedAt: IsoTimestamp | null
  pausedAt: IsoTimestamp | null
}

export const ALL_DATA_TYPES: readonly DataType[] = [
  'balances',
  'transactions',
  'invoices',
  'bills',
  'buckets',
  'payroll',
  'equity',
  'documents',
  'reports',
  'personal',
]

/** Default when a person connects an AI without changing anything: read-only, everything but payroll and Personal, 90 days. */
export const DEFAULT_GRANT_DAYS = 90
export const DEFAULT_DAILY_WRITE_CAP = 200
export const MAX_DAILY_WRITE_CAP = 5_000

export function defaultGrantShape(now: Date): GrantShape {
  return {
    entityIds: 'all',
    dataTypes: ['balances', 'transactions', 'invoices', 'bills', 'buckets', 'equity', 'documents', 'reports'],
    write: false,
    reviewMode: 'instant',
    dailyWriteCap: DEFAULT_DAILY_WRITE_CAP,
    expiresAt: new Date(now.getTime() + DEFAULT_GRANT_DAYS * 86_400_000).toISOString(),
  }
}

/**
 * The public demo's one connection (control.createPublicDemoGrant): every kind of data, payroll and Personal included,
 * because the books are made up and a P&L without payroll is wrong. Still read-only; @agfn/mcp refuses demo writes anyway.
 */
export function publicDemoGrantShape(now: Date): GrantShape {
  return { ...defaultGrantShape(now), dataTypes: [...ALL_DATA_TYPES] }
}

export class GrantShapeError extends Error {
  override name = 'GrantShapeError'
}

/** Validate and normalize a shape coming from the consent screen, the AI drawer or REST. */
export function normalizeShape(shape: GrantShape, now: Date): GrantShape {
  const dataTypes = [...new Set(shape.dataTypes)]
  for (const d of dataTypes) if (!ALL_DATA_TYPES.includes(d)) throw new GrantShapeError(`unknown data type "${d}"`)
  if (dataTypes.length === 0) throw new GrantShapeError('choose at least one kind of data')
  let entityIds: GrantShape['entityIds'] = shape.entityIds
  if (entityIds !== 'all') {
    entityIds = [...new Set(entityIds)]
    if (entityIds.length === 0) throw new GrantShapeError('choose at least one company')
  }
  if (shape.reviewMode !== 'instant' && shape.reviewMode !== 'review_all') throw new GrantShapeError('review mode must be instant or review_all')
  const cap = shape.dailyWriteCap ?? DEFAULT_DAILY_WRITE_CAP
  if (!Number.isInteger(cap) || cap < 1 || cap > MAX_DAILY_WRITE_CAP) throw new GrantShapeError(`daily cap must be 1–${MAX_DAILY_WRITE_CAP}`)
  let expiresAt = shape.expiresAt
  if (expiresAt !== null) {
    const t = Date.parse(expiresAt)
    if (Number.isNaN(t)) throw new GrantShapeError('expiresAt must be an ISO timestamp or null')
    if (t <= now.getTime()) throw new GrantShapeError('expiresAt must be in the future')
    expiresAt = new Date(t).toISOString()
  }
  return { entityIds, dataTypes, write: Boolean(shape.write), reviewMode: shape.reviewMode, dailyWriteCap: cap, expiresAt }
}

/**
 * True when `next` gives more access than `prev` (more companies, more data, write, longer/no expiry, higher cap,
 * or review switched off). Widening needs the passkey re-check (MASTER §9).
 */
export function isWidening(prev: GrantShape, next: GrantShape): boolean {
  if (prev.entityIds !== 'all' && (next.entityIds === 'all' || next.entityIds.some((e) => !(prev.entityIds as EntityId[]).includes(e)))) return true
  if (next.dataTypes.some((d) => !prev.dataTypes.includes(d))) return true
  if (next.write && !prev.write) return true
  if (prev.reviewMode === 'review_all' && next.reviewMode === 'instant') return true
  if ((next.dailyWriteCap ?? DEFAULT_DAILY_WRITE_CAP) > (prev.dailyWriteCap ?? DEFAULT_DAILY_WRITE_CAP)) return true
  if (prev.expiresAt !== null && (next.expiresAt === null || Date.parse(next.expiresAt) > Date.parse(prev.expiresAt))) return true
  return false
}

export type GrantState = 'active' | 'revoked' | 'expired'

export function grantState(g: Grant, now: Date): GrantState {
  if (g.revokedAt) return 'revoked'
  if (g.expiresAt !== null && Date.parse(g.expiresAt) <= now.getTime()) return 'expired'
  return 'active'
}

/**
 * The grant half of the permission check (the person half is can()). Personal spaces need the 'personal'
 * data type on top of the data type asked for: an AI never sees Personal unless the owner ticked it.
 */
export function grantCovers(g: Grant, entity: Pick<EntityInfo, 'id' | 'kind'>, action: Action, dataType: DataType, now: Date): boolean {
  if (grantState(g, now) !== 'active') return false
  if (action === 'manage') return false // grants never manage: no keys, grants, connections, payees, people
  if ((action === 'add' || action === 'edit') && !g.write) return false
  if (g.entityIds !== 'all' && !g.entityIds.includes(entity.id)) return false
  if (entity.kind === 'personal' && !g.dataTypes.includes('personal')) return false
  if (dataType === 'personal') return entity.kind === 'personal' && g.dataTypes.includes('personal')
  return g.dataTypes.includes(dataType)
}

// ---------- Rows ----------

export function grantFromRow(r: GrantsTable): Grant {
  const entityIds = JSON.parse(r.entity_ids_json) as unknown
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    personId: r.person_id,
    kind: r.kind,
    clientId: r.client_id,
    clientName: r.client_name,
    entityIds: entityIds === 'all' ? 'all' : (entityIds as EntityId[]),
    dataTypes: JSON.parse(r.data_types_json) as DataType[],
    write: r.can_write === 1,
    reviewMode: r.review_mode,
    dailyWriteCap: r.daily_write_cap ?? DEFAULT_DAILY_WRITE_CAP,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    revokedAt: r.revoked_at,
    lastUsedAt: r.last_used_at,
    pausedAt: r.paused_at ?? null,
  }
}

export function shapeToColumns(s: GrantShape): Pick<GrantsTable, 'entity_ids_json' | 'data_types_json' | 'can_write' | 'review_mode' | 'daily_write_cap' | 'expires_at'> {
  return {
    entity_ids_json: JSON.stringify(s.entityIds),
    data_types_json: JSON.stringify(s.dataTypes),
    can_write: s.write ? 1 : 0,
    review_mode: s.reviewMode,
    daily_write_cap: s.dailyWriteCap ?? DEFAULT_DAILY_WRITE_CAP,
    expires_at: s.expiresAt,
  }
}

// ---------- The control sentence (AI drawer, consent screen) ----------

/** One clickable piece of the sentence. `field` tells the UI which part of the grant a click edits. */
export interface SentencePart {
  text: string
  field?: 'entities' | 'dataTypes' | 'write' | 'reviewMode' | 'dailyWriteCap' | 'expiresAt'
}

export interface ControlSentence {
  text: string
  parts: SentencePart[]
  /** The permanent line under every AI. */
  never: string
  state: GrantState
}

export const NEVER_LINE = 'Can’t ever: move money, pay bills, send invoices or emails.'

const DATA_LABEL: Record<DataType, string> = {
  balances: 'balances',
  transactions: 'transactions',
  invoices: 'invoices',
  bills: 'bills',
  buckets: 'buckets',
  payroll: 'payroll',
  equity: 'the cap table',
  documents: 'documents',
  reports: 'reports',
  personal: 'Personal',
}

/** How a data type is named to people and AIs. With get_investments on (AGFN_TOOL_INVESTMENTS), equity covers the portfolio too. */
export function dataLabel(d: DataType, opts: { investments?: boolean } = {}): string {
  return d === 'equity' && opts.investments ? 'the cap table and investments' : DATA_LABEL[d]
}

export function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join('')
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/**
 * "Claude can see Acme and Northwind: balances, transactions, invoices. Can add records. Changes apply immediately.
 * Expires in 90 days." `entities` is the person's visible entity list (names for the ids in the grant).
 */
export function controlSentence(g: Grant, entities: Array<Pick<EntityInfo, 'id' | 'name' | 'kind'>>, now: Date, opts: { investments?: boolean } = {}): ControlSentence {
  const state = grantState(g, now)
  const parts: SentencePart[] = []
  const companies = entities.filter((e) => e.kind === 'company')
  const includesPersonal = g.dataTypes.includes('personal')
  let where: string
  if (g.entityIds === 'all') {
    // A Personal-only account (no companies yet) reads as what it is, not "all your companies".
    if (!companies.length) where = includesPersonal ? 'your own money (Personal)' : 'no companies yet'
    else {
      where = companies.length === 1 ? (companies[0]?.name ?? 'your company') : 'all your companies'
      if (includesPersonal) where += ' and Personal'
    }
  } else {
    const ids = g.entityIds
    const names = entities.filter((e) => ids.includes(e.id) && (e.kind === 'company' || includesPersonal)).map((e) => (e.kind === 'personal' ? 'Personal' : e.name))
    const missing = ids.filter((id) => !entities.some((e) => e.id === id)).length
    where = names.length ? joinAnd(names) : 'no companies'
    if (missing) where += ` (and ${missing} you can no longer see)`
  }
  const data = g.dataTypes.filter((d) => d !== 'personal').map((d) => dataLabel(d, opts))

  parts.push({ text: `${g.clientName} can see ` })
  parts.push({ text: where, field: 'entities' })
  parts.push({ text: ': ' })
  parts.push({ text: data.length ? data.join(', ') : 'nothing', field: 'dataTypes' })
  parts.push({ text: '. ' })
  parts.push({ text: g.write ? 'Can add records' : "Can't add or change anything", field: 'write' })
  parts.push({ text: '. ' })
  if (g.write) {
    parts.push({ text: g.reviewMode === 'instant' ? 'Changes apply immediately' : 'Changes wait for your review', field: 'reviewMode' })
    parts.push({ text: '. ' })
    parts.push({ text: `Up to ${g.dailyWriteCap ?? DEFAULT_DAILY_WRITE_CAP} changes a day`, field: 'dailyWriteCap' })
    parts.push({ text: '. ' })
  }
  parts.push({ text: expiryText(g, now, state), field: 'expiresAt' })
  parts.push({ text: '.' })
  if (g.pausedAt && state === 'active') parts.push({ text: ' Paused.' })
  return { text: parts.map((p) => p.text).join(''), parts, never: NEVER_LINE, state }
}

function expiryText(g: Grant, now: Date, state: GrantState): string {
  if (state === 'revoked') return 'Access was revoked'
  if (g.expiresAt === null) return 'Never expires'
  const ms = Date.parse(g.expiresAt) - now.getTime()
  if (ms <= 0) return 'Expired'
  const days = Math.ceil(ms / 86_400_000)
  if (days <= 1) {
    const hours = Math.max(1, Math.ceil(ms / 3_600_000))
    return `Expires in ${hours} hour${hours === 1 ? '' : 's'}`
  }
  return `Expires in ${days} days`
}
