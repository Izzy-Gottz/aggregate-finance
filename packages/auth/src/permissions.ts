import type { Kysely } from 'kysely'
import type { Action, Actor, Can, DataType, EntityId, PersonId, WorkspaceId } from '@agfn/contracts'
import type { CoreTables, RolePreset } from '@agfn/db'

/**
 * The one permission check (MASTER.md §9). People get access through memberships (a role preset, optionally
 * overridden by a grid). For a grant actor this answers for the grant's PERSON; S7 intersects with the grant itself,
 * so an AI can never exceed the person who connected it. Personal entities are visible only to their owner.
 */

export interface PermissionGrid {
  entities: EntityId[] | 'all'
  view: DataType[]
  add: DataType[]
  manage: boolean
}

const BUSINESS_DATA: DataType[] = ['balances', 'transactions', 'invoices', 'bills', 'buckets', 'payroll', 'equity', 'documents', 'reports']
const SUMMARY: DataType[] = ['balances', 'reports']

export const ROLE_PRESETS: Record<Exclude<RolePreset, 'custom'>, PermissionGrid> = {
  owner: { entities: 'all', view: BUSINESS_DATA, add: BUSINESS_DATA, manage: true },
  admin: { entities: 'all', view: SUMMARY, add: [], manage: true },
  finance: { entities: 'all', view: BUSINESS_DATA, add: BUSINESS_DATA, manage: false },
  accountant: { entities: 'all', view: BUSINESS_DATA, add: [], manage: false },
  investor: { entities: 'all', view: SUMMARY, add: [], manage: false },
  employee: { entities: 'all', view: [], add: ['documents'], manage: false },
}

export function parseGrid(json: string | null): Partial<PermissionGrid> | null {
  if (!json) return null
  try {
    const g = JSON.parse(json) as Partial<PermissionGrid>
    return g && typeof g === 'object' ? g : null
  } catch {
    return null
  }
}

/** Preset, then grid fields override it. A custom role with no grid grants nothing. */
export function effectiveGrid(role: RolePreset, gridJson: string | null): PermissionGrid {
  const base: PermissionGrid = role === 'custom' ? { entities: [], view: [], add: [], manage: false } : ROLE_PRESETS[role]
  const g = parseGrid(gridJson)
  if (!g) return base
  return {
    entities: g.entities ?? base.entities,
    view: Array.isArray(g.view) ? g.view : base.view,
    add: Array.isArray(g.add) ? g.add : base.add,
    manage: typeof g.manage === 'boolean' ? g.manage : base.manage,
  }
}

export function gridAllows(grid: PermissionGrid, action: Action, entityId: EntityId, dataType: DataType): boolean {
  if (grid.entities !== 'all' && !grid.entities.includes(entityId)) return false
  if (action === 'manage') return grid.manage
  if (action === 'view') return grid.view.includes(dataType)
  return grid.add.includes(dataType)
}

interface MembershipRow {
  role: RolePreset
  grid_json: string | null
  expires_at: string | null
  revoked_at: string | null
}

export function createPermissions(db: Kysely<CoreTables>, now: () => Date = () => new Date()) {
  async function membership(workspaceId: WorkspaceId, personId: PersonId): Promise<MembershipRow | undefined> {
    const rows = await db
      .selectFrom('memberships')
      .select(['role', 'grid_json', 'expires_at', 'revoked_at'])
      .where('workspace_id', '=', workspaceId)
      .where('person_id', '=', personId)
      .where('revoked_at', 'is', null)
      .execute()
    const t = now().toISOString()
    return rows.find((r) => !r.expires_at || r.expires_at > t)
  }

  type EntityRow = { workspace_id: string; kind: string; owner_person_id: string | null; archived_at: string | null }
  /** One rule for every checker; only where the rows come from differs. */
  const decide = async (
    actor: Actor,
    action: Action,
    entityId: EntityId,
    dataType: DataType,
    entityOf: (ws: WorkspaceId, id: EntityId) => Promise<EntityRow | undefined>,
    membershipOf: (ws: WorkspaceId, person: PersonId) => Promise<MembershipRow | undefined>,
  ): Promise<boolean> => {
    if (actor.kind === 'system') return true
    const entity = await entityOf(actor.workspaceId, entityId)
    if (!entity || entity.workspace_id !== actor.workspaceId) return false
    // Personal money: only its owner, for every data type and action.
    if (entity.kind === 'personal') return entity.owner_person_id === actor.personId
    if (dataType === 'personal') return false
    const m = await membershipOf(actor.workspaceId, actor.personId)
    if (!m) return false
    if (entity.archived_at && action !== 'view') return false
    return gridAllows(effectiveGrid(m.role, m.grid_json), action, entityId, dataType)
  }
  const entityRow = (_ws: WorkspaceId, id: EntityId) => db.selectFrom('entities').select(['workspace_id', 'kind', 'owner_person_id', 'archived_at']).where('id', '=', id).executeTakeFirst()

  const can: Can = (actor, action, entityId, dataType) => decide(actor, action, entityId, dataType, entityRow, membership)

  /**
   * A checker for one request (an AI tool call checks every company for several data types): the same rule as `can`,
   * read live when the request starts, with the workspace's entities and the membership read once instead of per check
   * (get_overview: 35 statements down to 2). Make a new one per request; never keep one.
   */
  function forCall(): Can {
    const entities = new Map<WorkspaceId, Promise<Map<EntityId, EntityRow>>>()
    const memberships = new Map<string, Promise<MembershipRow | undefined>>()
    // Read in the actor's workspace: an entity of another workspace is simply not there (refused, as `can` refuses it).
    const entityOf = async (ws: WorkspaceId, id: EntityId) => {
      let all = entities.get(ws)
      if (!all) {
        all = db
          .selectFrom('entities')
          .select(['id', 'workspace_id', 'kind', 'owner_person_id', 'archived_at'])
          .where('workspace_id', '=', ws)
          .execute()
          .then((rows) => new Map(rows.map((r) => [r.id as EntityId, r])))
        entities.set(ws, all)
      }
      return (await all).get(id)
    }
    const membershipOf = (ws: WorkspaceId, person: PersonId) => {
      const key = `${ws}|${person}`
      let m = memberships.get(key)
      if (!m) {
        m = membership(ws, person)
        memberships.set(key, m)
      }
      return m
    }
    return (actor, action, entityId, dataType) => decide(actor, action, entityId, dataType, entityOf, membershipOf)
  }

  /** Entities this person can see at all (any data type), for switchers and grant scoping. */
  async function entitiesFor(workspaceId: WorkspaceId, personId: PersonId): Promise<Array<{ id: EntityId; name: string; kind: 'company' | 'personal' }>> {
    const m = await membership(workspaceId, personId)
    const rows = await db
      .selectFrom('entities')
      .select(['id', 'name', 'kind', 'owner_person_id'])
      .where('workspace_id', '=', workspaceId)
      .where('archived_at', 'is', null)
      .orderBy('created_at')
      .execute()
    const grid = m ? effectiveGrid(m.role, m.grid_json) : null
    return rows
      .filter((e) =>
        e.kind === 'personal'
          ? e.owner_person_id === personId
          : !!grid && (grid.entities === 'all' || grid.entities.includes(e.id)) && (grid.view.length > 0 || grid.add.length > 0 || grid.manage),
      )
      .map((e) => ({ id: e.id, name: e.name, kind: e.kind }))
  }

  async function canManageWorkspace(workspaceId: WorkspaceId, personId: PersonId): Promise<boolean> {
    const m = await membership(workspaceId, personId)
    return !!m && effectiveGrid(m.role, m.grid_json).manage
  }

  async function workspacesFor(personId: PersonId): Promise<Array<{ id: WorkspaceId; name: string; role: RolePreset }>> {
    const t = now().toISOString()
    const rows = await db
      .selectFrom('memberships')
      .innerJoin('workspaces', 'workspaces.id', 'memberships.workspace_id')
      .select(['workspaces.id as id', 'workspaces.name as name', 'memberships.role as role', 'memberships.expires_at as expires_at'])
      .where('memberships.person_id', '=', personId)
      .where('memberships.revoked_at', 'is', null)
      .orderBy('memberships.created_at')
      .execute()
    return rows.filter((r) => !r.expires_at || r.expires_at > t).map(({ id, name, role }) => ({ id, name, role }))
  }

  return { can, forCall, entitiesFor, canManageWorkspace, workspacesFor }
}

export type Permissions = ReturnType<typeof createPermissions>
