// A PeopleDirectory fake with the same rules as @agfn/auth's createPermissions: Personal is owner-only,
// roles map to view/add data types per company.

import type { Action, Actor, DataType, EntityId, PersonId, WorkspaceId } from '@agfn/contracts'
import type { EntityInfo, PeopleDirectory } from '../ports.ts'

export interface FakePerson {
  id: PersonId
  name: string
  entities: EntityId[] | 'all'
  view: DataType[]
  add: DataType[]
  manage: boolean
}

const BUSINESS: DataType[] = ['balances', 'transactions', 'invoices', 'bills', 'buckets', 'payroll', 'equity', 'documents', 'reports']

export function fakeOwner(id: PersonId, name = 'Yisrael'): FakePerson {
  return { id, name, entities: 'all', view: BUSINESS, add: BUSINESS, manage: true }
}

export class FakePeople implements PeopleDirectory {
  people = new Map<PersonId, FakePerson>()
  recentPasskey = new Set<PersonId>()
  readonly workspaceId: WorkspaceId
  readonly entities: () => Promise<EntityInfo[]>
  constructor(workspaceId: WorkspaceId, entities: () => Promise<EntityInfo[]>, people: FakePerson[]) {
    this.workspaceId = workspaceId
    this.entities = entities
    for (const p of people) {
      this.people.set(p.id, p)
      this.recentPasskey.add(p.id)
    }
  }

  can = async (actor: Actor, action: Action, entityId: EntityId, dataType: DataType): Promise<boolean> => {
    if (actor.kind === 'system') return true
    if (actor.workspaceId !== this.workspaceId) return false
    const e = (await this.entities()).find((x) => x.id === entityId)
    if (!e) return false
    if (e.kind === 'personal') return e.ownerPersonId === actor.personId
    if (dataType === 'personal') return false
    const p = this.people.get(actor.personId)
    if (!p) return false
    if (p.entities !== 'all' && !p.entities.includes(entityId)) return false
    if (action === 'manage') return p.manage
    return action === 'view' ? p.view.includes(dataType) : p.add.includes(dataType)
  }

  async entitiesFor(workspaceId: WorkspaceId, personId: PersonId) {
    if (workspaceId !== this.workspaceId) return []
    const p = this.people.get(personId)
    return (await this.entities())
      .filter((e) => (e.kind === 'personal' ? e.ownerPersonId === personId : !!p && (p.entities === 'all' || p.entities.includes(e.id))))
      .map((e) => ({ id: e.id, name: e.name, kind: e.kind }))
  }

  async displayName(personId: PersonId): Promise<string> {
    return this.people.get(personId)?.name ?? 'someone'
  }

  async canManageWorkspace(workspaceId: WorkspaceId, personId: PersonId): Promise<boolean> {
    return workspaceId === this.workspaceId && !!this.people.get(personId)?.manage
  }

  /** Every re-check asked for, with its window and purpose. */
  rechecks: Array<{ personId: PersonId; withinMs: number; purpose?: string }> = []
  async requireRecentPasskey(personId: PersonId, withinMs: number, purpose?: 'create_grant' | 'first_grant'): Promise<boolean> {
    this.rechecks.push({ personId, withinMs, ...(purpose ? { purpose } : {}) })
    return this.recentPasskey.has(personId)
  }
}
