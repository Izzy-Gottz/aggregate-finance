// Test and demo wiring: SQLite in memory + migrations, demo books, fake people, a fake OAuth verifier.

import type { GrantShape, PersonId } from '@agfn/contracts'
import { connect, migrateToLatest, type CoreTables, type DbHandle } from '@agfn/db'
import { createAgfnMcp, type AgfnMcpHandle } from '../index.ts'
import type { Grant } from '../grants.ts'
import type { Clock, ControlHooks, McpTokenVerifier, VerifiedAccessToken } from '../ports.ts'
import type { Principal } from '../scope.ts'
import type { McpTables } from '../store/schema.ts'
import { DEMO, DemoBooks } from './demo-books.ts'
import { FakePeople, fakeOwner, type FakePerson } from './people.ts'

export const WS = 'ws_demo'
export const RESOURCE = 'https://agfn.test/mcp'

export class FakeVerifier implements McpTokenVerifier {
  readonly issuer = 'https://agfn.test'
  tokens = new Map<string, VerifiedAccessToken & { resource: string }>()
  async verifyAccessToken(token: string, resource: string): Promise<VerifiedAccessToken | null> {
    const t = this.tokens.get(token)
    if (!t || t.resource !== resource || t.expiresAt * 1000 < Date.now()) return null
    return t
  }
}

export class TestClock implements Clock {
  t: number
  constructor(iso = '2026-10-09T14:00:00Z') {
    this.t = Date.parse(iso)
  }
  now(): Date {
    return new Date(this.t)
  }
  advance(ms: number): void {
    this.t += ms
  }
}

export interface Harness {
  h: DbHandle<CoreTables & McpTables>
  agfn: AgfnMcpHandle
  books: DemoBooks
  people: FakePeople
  verifier: FakeVerifier
  clock: TestClock
  alerts: Array<{ kind: string; text: string }>
  revoked: string[]
  owner: { workspaceId: string; personId: PersonId }
  accountant: { workspaceId: string; personId: PersonId }
  /** Create a grant as `personId` and return a principal for it (via an agent key, the real auth path). */
  connectAi(shape: Partial<GrantShape>, opts?: { personId?: PersonId; name?: string }): Promise<{ principal: Principal; key: string; grant: Grant }>
  close(): Promise<void>
}

export const READ_ALL: GrantShape = {
  entityIds: 'all',
  dataTypes: ['balances', 'transactions', 'invoices', 'bills', 'buckets', 'payroll', 'equity', 'documents', 'reports'],
  write: false,
  reviewMode: 'instant',
  dailyWriteCap: 200,
  expiresAt: '2027-01-07T14:00:00.000Z',
}

export async function makeHarness(opts: { people?: FakePerson[]; rateLimits?: { readsPerMinute?: number; readsPerHour?: number; writesPerHour?: number }; liveBalance?: import('../ports.ts').LiveBalancePort; share?: import('../ports.ts').SharePort; promptPacks?: boolean; investments?: boolean } = {}): Promise<Harness> {
  const h = connect<CoreTables & McpTables>('sqlite::memory:')
  await migrateToLatest(h.db)
  const clock = new TestClock()
  const at = clock.now().toISOString()
  await h.db.insertInto('workspaces').values({ id: WS, name: 'Demo', base_currency: 'USD', created_at: at }).execute()
  const accountant: FakePerson = { id: DEMO.accountant, name: 'Avi', entities: [DEMO.acme], view: ['balances', 'transactions', 'invoices', 'bills', 'reports'], add: ['transactions'], manage: false }
  const persons = opts.people ?? [fakeOwner(DEMO.owner), accountant]
  for (const p of persons) await h.db.insertInto('people').values({ id: p.id, auth_user_id: null, name: p.name, email: `${p.id}@example.test`, created_at: at }).execute()
  const books = new DemoBooks(WS, () => clock.now())
  const people = new FakePeople(WS, () => books.entities(), persons)
  const verifier = new FakeVerifier()
  const alerts: Harness['alerts'] = []
  const revoked: string[] = []
  const hooks: ControlHooks = {
    onAlert: async (a) => void alerts.push({ kind: a.kind, text: a.text }),
    onGrantRevoked: async (id) => void revoked.push(id),
  }
  const agfn = createAgfnMcp({ db: h.db, reader: books, writer: books, people, verifier, hooks, clock, rateLimits: opts.rateLimits, ...(opts.liveBalance ? { liveBalance: opts.liveBalance } : {}), ...(opts.share ? { share: opts.share } : {}), ...(opts.promptPacks ? { promptPacks: true } : {}), ...(opts.investments ? { investments: true } : {}) }, { resourceUrl: RESOURCE, authenticatePerson: async (req) => {
    const pid = req.headers.get('x-test-person')
    return pid ? { workspaceId: WS, personId: pid } : null
  } })
  const owner = { workspaceId: WS, personId: DEMO.owner as PersonId }
  const harness: Harness = {
    h,
    agfn,
    books,
    people,
    verifier,
    clock,
    alerts,
    revoked,
    owner,
    accountant: { workspaceId: WS, personId: DEMO.accountant },
    async connectAi(shape, o = {}) {
      const actor = { workspaceId: WS, personId: o.personId ?? DEMO.owner }
      const created = await agfn.control.createAgentKey(actor, { name: o.name ?? 'Claude', shape: { ...READ_ALL, ...shape } })
      const auth = await agfn.service.authenticate(created.key, { resource: RESOURCE })
      if (!auth.ok) throw new Error(auth.description)
      return { principal: auth.principal, key: created.key, grant: created.grant }
    },
    close: () => h.close(),
  }
  return harness
}
