import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connect, migrateToLatest, newId, nowIso, type CoreTables, type DbHandle } from '@agfn/db'
import type { Actor } from '@agfn/contracts'
import { addCompany, addMember, createPermissions, createWorkspace, revokeMember } from './index.ts'

let h: DbHandle<CoreTables>
async function person(email: string) {
  const id = newId()
  await h.db.insertInto('people').values({ id, auth_user_id: null, name: email, email, created_at: nowIso() }).execute()
  return id
}
beforeEach(async () => {
  h = connect<CoreTables>('sqlite::memory:')
  await migrateToLatest(h.db)
})
afterEach(() => h.close())

describe('permissions', () => {
  it('owner sees all companies and only their own Personal', async () => {
    const owner = await person('owner@x.com')
    const { workspaceId, companyId, personalId } = await createWorkspace(h.db, { personId: owner, workspaceName: 'Y', firstCompanyName: 'Acme' })
    const second = await addCompany(h.db, workspaceId, 'Bluebird')
    const p = createPermissions(h.db)
    const a: Actor = { kind: 'person', personId: owner, workspaceId }
    expect(await p.can(a, 'view', companyId, 'payroll')).toBe(true)
    expect(await p.can(a, 'add', second, 'transactions')).toBe(true)
    expect(await p.can(a, 'view', personalId, 'transactions')).toBe(true)
    expect((await p.entitiesFor(workspaceId, owner)).map((e) => e.name)).toEqual(['Personal', 'Acme', 'Bluebird'])

    // A co-founder with full finance access still cannot see the owner's Personal.
    const cofounder = await addMember(h.db, { workspaceId, email: 'co@x.com', role: 'finance', invitedBy: owner })
    const c: Actor = { kind: 'person', personId: cofounder.personId, workspaceId }
    expect(await p.can(c, 'view', companyId, 'transactions')).toBe(true)
    expect(await p.can(c, 'view', personalId, 'balances')).toBe(false)
    expect(await p.can(c, 'manage', companyId, 'balances')).toBe(false)
  })

  it('accountant is read-only, limited to chosen companies, and expires', async () => {
    const owner = await person('owner@x.com')
    const { workspaceId, companyId } = await createWorkspace(h.db, { personId: owner, workspaceName: 'Y', firstCompanyName: 'Acme' })
    const other = await addCompany(h.db, workspaceId, 'Harbor')
    let clock = new Date('2026-10-01T00:00:00Z')
    const p = createPermissions(h.db, () => clock)
    const acc = await addMember(h.db, { workspaceId, email: 'books@x.com', role: 'accountant', grid: { entities: [companyId] }, expiresAt: '2026-12-31T00:00:00Z', invitedBy: owner })
    const a: Actor = { kind: 'person', personId: acc.personId, workspaceId }
    expect(await p.can(a, 'view', companyId, 'invoices')).toBe(true)
    expect(await p.can(a, 'add', companyId, 'invoices')).toBe(false)
    expect(await p.can(a, 'view', other, 'invoices')).toBe(false)
    clock = new Date('2027-01-02T00:00:00Z')
    expect(await p.can(a, 'view', companyId, 'invoices')).toBe(false)
  })

  it('investor sees summary only; employee can only add documents; revoked sees nothing', async () => {
    const owner = await person('owner@x.com')
    const { workspaceId, companyId } = await createWorkspace(h.db, { personId: owner, workspaceName: 'Y', firstCompanyName: 'Acme' })
    const p = createPermissions(h.db)
    const inv = await addMember(h.db, { workspaceId, email: 'vc@x.com', role: 'investor', invitedBy: owner })
    const i: Actor = { kind: 'person', personId: inv.personId, workspaceId }
    expect(await p.can(i, 'view', companyId, 'balances')).toBe(true)
    expect(await p.can(i, 'view', companyId, 'payroll')).toBe(false)
    const emp = await addMember(h.db, { workspaceId, email: 'e@x.com', role: 'employee', invitedBy: owner })
    const e: Actor = { kind: 'person', personId: emp.personId, workspaceId }
    expect(await p.can(e, 'add', companyId, 'documents')).toBe(true)
    expect(await p.can(e, 'view', companyId, 'transactions')).toBe(false)
    await revokeMember(h.db, workspaceId, inv.membershipId)
    expect(await p.can(i, 'view', companyId, 'balances')).toBe(false)
  })

  it('never crosses workspaces, even with a valid entity id', async () => {
    const a = await person('a@x.com')
    const b = await person('b@x.com')
    const wa = await createWorkspace(h.db, { personId: a, workspaceName: 'A', firstCompanyName: 'A Co' })
    const wb = await createWorkspace(h.db, { personId: b, workspaceName: 'B', firstCompanyName: 'B Co' })
    const p = createPermissions(h.db)
    expect(await p.can({ kind: 'person', personId: a, workspaceId: wa.workspaceId }, 'view', wb.companyId, 'balances')).toBe(false)
    expect(await p.can({ kind: 'person', personId: a, workspaceId: wb.workspaceId }, 'view', wb.companyId, 'balances')).toBe(false)
    expect(await p.can({ kind: 'grant', grantId: 'g', personId: a, workspaceId: wa.workspaceId }, 'view', wb.personalId, 'balances')).toBe(false)
  })
})

describe('a checker for one request', () => {
  it('answers exactly what can answers, for every person, company, action and data type', async () => {
    const owner = await person('owner@x.com')
    const { workspaceId, companyId, personalId } = await createWorkspace(h.db, { personId: owner, workspaceName: 'Y', firstCompanyName: 'Acme' })
    const second = await addCompany(h.db, workspaceId, 'Harbor')
    const archived = await addCompany(h.db, workspaceId, 'Old Co')
    await h.db.updateTable('entities').set({ archived_at: nowIso() }).where('id', '=', archived).execute()
    const stranger = await person('else@x.com')
    const elsewhere = await createWorkspace(h.db, { personId: stranger, workspaceName: 'Z', firstCompanyName: 'Theirs' })
    const people = [
      owner,
      (await addMember(h.db, { workspaceId, email: 'co@x.com', role: 'finance', invitedBy: owner })).personId,
      (await addMember(h.db, { workspaceId, email: 'books@x.com', role: 'accountant', grid: { entities: [companyId] }, invitedBy: owner })).personId,
      (await addMember(h.db, { workspaceId, email: 'vc@x.com', role: 'investor', invitedBy: owner })).personId,
      (await addMember(h.db, { workspaceId, email: 'emp@x.com', role: 'employee', invitedBy: owner })).personId,
      stranger,
    ]
    const p = createPermissions(h.db)
    const actions = ['view', 'add', 'manage'] as const
    const types = ['balances', 'transactions', 'invoices', 'bills', 'payroll', 'personal', 'documents'] as const
    for (const personId of people) {
      const a: Actor = { kind: 'person', personId, workspaceId }
      const once = p.forCall()
      for (const e of [companyId, second, archived, personalId, elsewhere.companyId, 'missing'])
        for (const action of actions) for (const t of types) expect(await once(a, action, e, t as never), `${personId} ${action} ${e} ${t}`).toBe(await p.can(a, action, e, t as never))
    }
  })

  it('reads live when made: a new checker sees a revoke at once', async () => {
    const owner = await person('owner@x.com')
    const { workspaceId, companyId } = await createWorkspace(h.db, { personId: owner, workspaceName: 'Y', firstCompanyName: 'Acme' })
    const p = createPermissions(h.db)
    const m = await addMember(h.db, { workspaceId, email: 'co@x.com', role: 'finance', invitedBy: owner })
    const a: Actor = { kind: 'person', personId: m.personId, workspaceId }
    expect(await p.forCall()(a, 'view', companyId, 'transactions')).toBe(true)
    await revokeMember(h.db, workspaceId, m.membershipId)
    expect(await p.forCall()(a, 'view', companyId, 'transactions')).toBe(false)
  })
})
