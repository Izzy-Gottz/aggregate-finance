// Demo workspaces (MASTER §4): a self-hosted first run can open a workspace of three fictional companies plus Personal,
// filled by the demo connector, so people can click around and connect their AI before adding real keys.
// A demo workspace is marked in `settings` (key 'demo'); real connectors are refused there and the demo connector is
// refused everywhere else, so real and fake data never mix.

import type { Kysely } from 'kysely'
import { addCompany, createWorkspace } from '@agfn/auth'
import { DEMO_KEY, DEFAULT_SEED, HISTORY_DAYS, PROFILES, PROFILE_KEYS, type ProfileKey } from '@agfn/connector-demo'
import { newId, nowIso, withBypass, withWorkspace, type CoreTables } from '@agfn/db'
import type { KeyRing } from '@agfn/security'
import { createConnection, type SyncEngine } from '@agfn/sync'

export const DEMO_SETTING = 'demo'
export { PROFILE_KEYS, type ProfileKey } from '@agfn/connector-demo'
import { addDemoExtras, type DemoExtrasPorts } from './extras.ts'
export { addDemoExtras, demoCapTable, DEMO_RECEIPT, tidyDemoReview, type DemoExtrasPorts, type DemoReviewPort } from './extras.ts'
export { brokenPoolDemos, deletePoolPeople, DEMO_POOL, DEMO_POOL_EMAIL_DOMAIN, DEMO_POOL_READY, finishHandedOver, isPoolPerson, markPooled, newPoolPerson, poolStatus, POOL_MAX_AGE_MS, POOL_STUCK_MS, retirePoolDemo, stalePoolDemos, takePoolDemo } from './pool.ts'
export { admitDemoFills, DEMO_FILL_STARTED, DEMO_FILL_WAITING, demoFillPlace, queueDemoFill } from './fill-queue.ts'
export { DEMO_AI_SETTING, DEMO_READY_SETTING, demoAiWrite, demoImporting, isDemoReady, nextDemoImport, seedDemoAiWhenReady, stalledDemoImports, type DemoAiWrite, type SeedDemoAi } from './ai.ts'

export interface DemoDeps {
  db: Kysely<CoreTables>
  keys: KeyRing
  /** When given, each demo connection is synced right away (otherwise the worker picks them up). */
  sync?: Pick<SyncEngine, 'sync'>
  /** Buckets + rules (ledger) and the cap table (equity); added before the first sync so rules route as rows post. */
  extras?: DemoExtrasPorts
  now?: () => Date
}

export interface DemoWorkspace {
  workspaceId: string
  created: boolean
  entities: Array<{ id: string; name: string; profile: ProfileKey }>
  connections: string[]
  /** First day of generated history. */
  start: string
}

export async function isDemoWorkspace(db: Kysely<CoreTables>, workspaceId: string): Promise<boolean> {
  const row = await db.selectFrom('settings').select('value_json').where('workspace_id', '=', workspaceId).where('key', '=', DEMO_SETTING).executeTakeFirst()
  return row?.value_json === 'true'
}

/** Throws a message suitable for the UI when a connector would mix real and demo data. */
export async function assertConnectorAllowed(db: Kysely<CoreTables>, workspaceId: string, connectorKey: string): Promise<void> {
  const demo = await isDemoWorkspace(db, workspaceId)
  if (demo && connectorKey !== DEMO_KEY) throw new DemoMixError('This is the demo workspace. Leave the demo to connect your real accounts.')
  if (!demo && connectorKey === DEMO_KEY) throw new DemoMixError('Demo data can only live in the demo workspace.')
}

export class DemoMixError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DemoMixError'
  }
}

/** The person's live demo workspace, if they have one. */
export async function findDemoWorkspace(db: Kysely<CoreTables>, personId: string): Promise<string | undefined> {
  // Looked up by person before any workspace is known, so it spans workspaces (row-level security bypass).
  const row = await withBypass('demo:find', () => db
    .selectFrom('memberships')
    .innerJoin('settings', 'settings.workspace_id', 'memberships.workspace_id')
    .select('memberships.workspace_id as id')
    .where('memberships.person_id', '=', personId)
    .where('memberships.revoked_at', 'is', null)
    .where('settings.key', '=', DEMO_SETTING)
    .where('settings.value_json', '=', 'true')
    .executeTakeFirst())
  return row?.id
}

/** Create (or return) the person's demo workspace and fill it. Idempotent per person. */
/**
 * What to build. `profiles` (default all four) and `start` (YYYY-MM-DD, overriding the history length) exist for runs
 * that must see exactly one company's fixed events, such as the benchmark; `glass` turns on the Glass Ledger (Harbor).
 */
export interface DemoInput {
  personId: string
  seed?: string
  historyDays?: number
  glass?: string
  /** With `glass`: the planted rows say " [planted]" in their bank text (the Glass Ledger's own workspace). */
  glassTag?: boolean
  /** The workspace's name (default "Demo"). */
  workspaceName?: string
  profiles?: ProfileKey[]
  start?: string
}

export async function createDemoWorkspace(deps: DemoDeps, input: DemoInput): Promise<DemoWorkspace> {
  const existing = await findDemoWorkspace(deps.db, input.personId)
  // Everything below reads and writes one workspace: enter it, so row-level security (Postgres) lets the rows in.
  const workspaceId = existing ?? newId()
  return withWorkspace(workspaceId, () => fillDemoWorkspace(deps, input, existing, workspaceId))
}

async function fillDemoWorkspace(deps: DemoDeps, input: DemoInput, existing: string | undefined, workspaceId: string): Promise<DemoWorkspace> {
  const { db } = deps
  if (existing) {
    const conns = await db.selectFrom('connections').select('id').where('workspace_id', '=', existing).where('connector_key', '=', DEMO_KEY).execute()
    const ents = await db.selectFrom('entities').select(['id', 'name']).where('workspace_id', '=', existing).execute()
    const byName = new Map(Object.values(PROFILES).map((p) => [p.entityName, p.key]))
    return {
      workspaceId: existing,
      created: false,
      entities: ents.flatMap((e) => (byName.has(e.name) ? [{ id: e.id, name: e.name, profile: byName.get(e.name) as ProfileKey }] : [])),
      connections: conns.map((c) => c.id),
      start: '',
    }
  }

  const now = deps.now?.() ?? new Date()
  const today = now.toISOString().slice(0, 10)
  // By default twelve whole months before this one (a year's P&L and balance sheet); a shorter demo counts days back.
  const monthsBack = (n: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1)).toISOString().slice(0, 10)
  const start = input.historyDays === undefined ? monthsBack(12) : new Date(Date.parse(today + 'T00:00:00Z') - Math.min(HISTORY_DAYS, Math.max(7, input.historyDays)) * 86_400_000).toISOString().slice(0, 10)
  // A company that asks for more (Harbor Coffee: two years, for this year against last) starts earlier.
  const startOf = (p: ProfileKey) => input.start ?? (input.historyDays === undefined && PROFILES[p].historyMonths ? monthsBack(PROFILES[p].historyMonths!) : start)
  const wanted = input.profiles ?? PROFILE_KEYS
  const companies = PROFILE_KEYS.filter((p) => p !== 'personal' && wanted.includes(p))
  const first = companies[0]
  if (!first) throw new Error('a demo needs at least one company profile')
  const seed = input.seed ?? DEFAULT_SEED

  const ids = await createWorkspace(db, { workspaceId, personId: input.personId, workspaceName: input.workspaceName ?? 'Demo', firstCompanyName: PROFILES[first].entityName, currency: 'USD' })
  await db.insertInto('settings').values({ workspace_id: ids.workspaceId, key: DEMO_SETTING, value_json: 'true', updated_at: nowIso() }).execute()
  const entities: DemoWorkspace['entities'] = [{ id: ids.companyId, name: PROFILES[first].entityName, profile: first }]
  for (const p of companies.slice(1)) entities.push({ id: await addCompany(db, ids.workspaceId, PROFILES[p].entityName, 'USD'), name: PROFILES[p].entityName, profile: p })
  // Personal always exists in a workspace; it gets demo data only when asked for.
  if (wanted.includes('personal')) entities.push({ id: ids.personalId, name: 'Personal', profile: 'personal' })

  const connections: string[] = []
  for (const e of entities) {
    const profile = PROFILES[e.profile]
    const connectionId = await createConnection(db, deps.keys, {
      workspaceId: ids.workspaceId,
      connectorKey: DEMO_KEY,
      displayName: `Demo data · ${e.name}`,
      secret: { demo: true },
      // The Glass Ledger runs on Harbor Coffee only.
      config: { profile: e.profile, start: startOf(e.profile), seed, ...(input.glass && e.profile === 'harbor' ? { glass: input.glass, ...(input.glassTag ? { glassTag: true } : {}) } : {}) },
      createdBy: input.personId,
      entityId: e.id,
    })
    connections.push(connectionId)
    // Pre-create the accounts already assigned to their company, so the demo never asks "which company is this?".
    for (const a of profile.accounts) {
      await db
        .insertInto('accounts')
        .values({
          id: newId(),
          workspace_id: ids.workspaceId,
          entity_id: e.id,
          connection_id: connectionId,
          external_id: a.id,
          name: a.name,
          account_type: a.type,
          currency: 'USD',
          mask: a.mask ?? null,
          institution: a.institution,
          business_hint: profile.kind === 'personal' ? 'personal' : 'business',
          include_in_cash: a.type === 'depository' || a.type === 'cash_on_hand' || a.type === 'processor_balance' ? 1 : 0,
          duplicate_of: null,
          created_at: nowIso(),
          closed_at: null,
        })
        .execute()
    }
  }
  const result: DemoWorkspace = { workspaceId: ids.workspaceId, created: true, entities, connections, start: input.start ?? start }
  if (deps.extras) await addDemoExtras(deps.extras, result, result.start)
  if (deps.sync) for (const id of connections) await deps.sync.sync(id)
  return result
}

/**
 * Leave the demo: the person's membership is revoked, so the demo disappears for them and onboarding starts fresh.
 * The rows stay (nothing in the ledger is ever hard-deleted); they are fake and belong to no one else.
 */
export async function leaveDemoWorkspace(db: Kysely<CoreTables>, personId: string): Promise<boolean> {
  const ws = await findDemoWorkspace(db, personId)
  if (!ws) return false
  return withWorkspace(ws, () => revokeDemo(db, ws, personId))
}

async function revokeDemo(db: Kysely<CoreTables>, ws: string, personId: string): Promise<boolean> {
  await db.updateTable('memberships').set({ revoked_at: nowIso() }).where('workspace_id', '=', ws).where('person_id', '=', personId).where('revoked_at', 'is', null).execute()
  await db.updateTable('connections').set({ status: 'paused' }).where('workspace_id', '=', ws).execute()
  return true
}
