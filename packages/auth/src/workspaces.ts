import type { Kysely } from 'kysely'
import { newId, nowIso, type CoreTables, type RolePreset } from '@agfn/db'
import type { PermissionGrid } from './permissions.ts'

/** An IANA time zone this runtime knows ("America/New_York", "Europe/Berlin", "UTC"). */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length > 64) return false
  if (tz === 'UTC') return true
  return Intl.supportedValuesOf('timeZone').includes(tz)
}

interface NewWorkspace {
  personId: string
  workspaceName: string
  currency?: string
  /** The browser's zone (IANA); which calendar day balances and "today" fall on. Unset = America/New_York. */
  timeZone?: string
  /** Chosen by the caller, e.g. to enter it for row-level security first. */ workspaceId?: string
}

/**
 * Onboarding: a workspace, the owner's membership, their private Personal entity, and the first company. Without a
 * company name it's Personal only ("No company? Just my own money"); companies can be added later (addCompany).
 */
export async function createWorkspace(db: Kysely<CoreTables>, input: NewWorkspace & { firstCompanyName: string }): Promise<{ workspaceId: string; companyId: string; personalId: string }>
export async function createWorkspace(db: Kysely<CoreTables>, input: NewWorkspace & { firstCompanyName?: string | null }): Promise<{ workspaceId: string; companyId: string | null; personalId: string }>
export async function createWorkspace(db: Kysely<CoreTables>, input: NewWorkspace & { firstCompanyName?: string | null }): Promise<{ workspaceId: string; companyId: string | null; personalId: string }> {
  const currency = (input.currency ?? 'USD').toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Currency must be a 3-letter code like USD')
  if (input.timeZone !== undefined && !isTimeZone(input.timeZone)) throw new Error('Time zone must be an IANA name like America/New_York')
  const personalOnly = input.firstCompanyName === undefined || input.firstCompanyName === null
  const name = personalOnly ? '' : input.firstCompanyName!.trim()
  if (!personalOnly && !name) throw new Error('Give your company a name')
  const ids = { workspaceId: input.workspaceId ?? newId(), companyId: personalOnly ? null : newId(), personalId: newId() }
  const at = nowIso()
  await db.transaction().execute(async (tx) => {
    await tx.insertInto('workspaces').values({ id: ids.workspaceId, name: input.workspaceName.trim() || name || 'Personal', base_currency: currency, time_zone: input.timeZone ?? null, created_at: at }).execute()
    await tx
      .insertInto('memberships')
      .values({ id: newId(), workspace_id: ids.workspaceId, person_id: input.personId, role: 'owner', grid_json: null, expires_at: null, invited_by: null, created_at: at, revoked_at: null })
      .execute()
    await tx
      .insertInto('entities')
      .values([
        { id: ids.personalId, workspace_id: ids.workspaceId, kind: 'personal', name: 'Personal', base_currency: currency, owner_person_id: input.personId, parent_entity_id: null, fiscal_year_start_month: 1, created_at: at, archived_at: null },
        ...(ids.companyId ? [{ id: ids.companyId, workspace_id: ids.workspaceId, kind: 'company' as const, name, base_currency: currency, owner_person_id: null, parent_entity_id: null, fiscal_year_start_month: 1, created_at: at, archived_at: null }] : []),
      ])
      .execute()
  })
  return ids
}

export async function addCompany(db: Kysely<CoreTables>, workspaceId: string, name: string, currency?: string): Promise<string> {
  const ws = await db.selectFrom('workspaces').select('base_currency').where('id', '=', workspaceId).executeTakeFirstOrThrow()
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Give your company a name')
  const id = newId()
  await db
    .insertInto('entities')
    .values({ id, workspace_id: workspaceId, kind: 'company', name: trimmed, base_currency: (currency ?? ws.base_currency).toUpperCase(), owner_person_id: null, parent_entity_id: null, fiscal_year_start_month: 1, created_at: nowIso(), archived_at: null })
    .execute()
  return id
}

/** Adds a person to a workspace with a preset (and optional grid). Creates the person if new; they sign in by email. */
export async function addMember(
  db: Kysely<CoreTables>,
  input: { workspaceId: string; email: string; name?: string; role: RolePreset; grid?: Partial<PermissionGrid>; expiresAt?: string | null; invitedBy: string },
): Promise<{ personId: string; membershipId: string }> {
  const email = input.email.trim().toLowerCase()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('That email address doesn’t look right')
  let person = await db.selectFrom('people').select('id').where('email', '=', email).executeTakeFirst()
  if (!person) {
    person = { id: newId() }
    await db.insertInto('people').values({ id: person.id, auth_user_id: null, name: input.name?.trim() || email.split('@')[0] || email, email, created_at: nowIso() }).execute()
  }
  const membershipId = newId()
  await db
    .insertInto('memberships')
    .values({
      id: membershipId,
      workspace_id: input.workspaceId,
      person_id: person.id,
      role: input.role,
      grid_json: input.grid ? JSON.stringify(input.grid) : null,
      expires_at: input.expiresAt ?? null,
      invited_by: input.invitedBy,
      created_at: nowIso(),
      revoked_at: null,
    })
    .execute()
  return { personId: person.id, membershipId }
}

export async function revokeMember(db: Kysely<CoreTables>, workspaceId: string, membershipId: string): Promise<void> {
  await db.updateTable('memberships').set({ revoked_at: nowIso() }).where('id', '=', membershipId).where('workspace_id', '=', workspaceId).execute()
}
