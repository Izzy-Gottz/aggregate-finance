import { makeSharePort } from './share.ts'
import type { Kysely } from 'kysely'
import { LedgerEngine, KyselyLedgerStore, KyselyDirectory, DbScope, CachedRateSource, FrankfurterRateSource } from '@agfn/core'
import { createAgfnMcp, DbRateLimiter, peopleFromAuth, ToolError, type AgfnMcpHandle, type LiveBalancePort } from '@agfn/mcp'
import type { FinanceReader, RecordWriter } from '@agfn/contracts'
import { createMcpTokenVerifier } from '@agfn/auth'
import { withBypass, type CoreTables } from '@agfn/db'
import type { BootOptions } from './boot.ts'
import type { Services } from './services.ts'
import { financeFor, warmerFor } from './finance.ts'
import { equityFor } from './equity.ts'
import { clientIp } from './security.ts'
import { isReviewerEmail, reviewerAccess, reviewerBlocked } from './reviewer.ts'
import { seedDemoAiWhenReady, tidyDemoReview, type DemoReviewPort } from '@agfn/demo'
import { passkeysPossible } from './config.ts'

type ConnectorRegistry = { installedConnectors?: (env: NodeJS.ProcessEnv, services?: { fileSource?: unknown }) => import('@agfn/sync').ConnectorFactory[] }

/**
 * Wires in the installed slices: connectors (S2-S5 via @agfn/connector-registry), the ledger (S1, @agfn/core) and the
 * MCP server (S7, @agfn/mcp). Connectors stay optional so a minimal install still boots.
 */
export async function loadInstalledModules(env: NodeJS.ProcessEnv, given?: { registry?: ConnectorRegistry }): Promise<Pick<BootOptions, 'connectors' | 'ledger' | 'mcp'>> {
  const out: Pick<BootOptions, 'connectors' | 'ledger' | 'mcp'> = {}
  // A bundle (the npm package's `agfn demo`) hands the registry in: a bundler can't follow the by-name import.
  const registry = given?.registry ?? (await optionalImport<ConnectorRegistry>('@agfn/connector-registry'))
  if (registry?.installedConnectors) {
    const install = registry.installedConnectors
    out.connectors = ({ fileSource }) => install(env, { fileSource })
  }
  out.ledger = (h) => ledgerFor(h.db)
  // Finance (S1 + S4/S5 + S6) composed once per database; also registers the sync engine's book routing and
  // payroll-detection hooks.
  out.mcp = (s) => mcpFor(s, financeFor(s))
  return out
}

export function ledgerFor(db: Kysely<CoreTables>): LedgerEngine {
  const scope = new DbScope(db as never)
  const store = new KyselyLedgerStore(scope)
  const engine = new LedgerEngine({ store, directory: new KyselyDirectory(scope), rates: new CachedRateSource(store, new FrankfurterRateSource()) })
  // S6 answers get_metric('fully_diluted') from the cap table.
  engine.registerMetricProvider('fully_diluted', equityFor({ db, ledger: engine as never }).fullyDilutedMetric)
  return engine
}

/**
 * Until the S1 finance reader/writer merge: entities come from the database, no data types are "available" (so data
 * tools aren't listed), and anything else answers "unavailable" instead of making numbers up.
 */
function unavailable<T extends object>(what: string, known: Partial<T> = {}): T {
  return new Proxy(known as T, {
    get: (t, prop) =>
      prop in t
        ? (t as Record<string | symbol, unknown>)[prop]
        : prop === 'then'
          ? undefined
          : async () => {
              throw new ToolError('unavailable', `${what} is still being set up on this server.`)
            },
  })
}

/** refresh_balance → the sync engine (its cooldown and daily cap apply; they are shared with the person's button). */
export function liveBalancePort(s: Omit<Services, 'mcp'>): LiveBalancePort {
  const supports = (key: string) => s.registry.has(key) && typeof (s.registry.create(key, { raw: { put: async () => '' } }) as { refreshBalances?: unknown }).refreshBalances === 'function'
  return {
    costNote: process.env.AGFN_LIVE_BALANCE_NOTE ?? 'Each live check is billed by Plaid per bank connection (to your own Plaid account when you host Aggregate yourself).',
    limits: { cooldownMinutes: Math.round((s.syncDeps.liveBalance?.cooldownMs ?? 15 * 60_000) / 60_000), dailyCap: s.syncDeps.liveBalance?.dailyCap ?? 20 },
    async targets(workspaceId, accountIds) {
      if (!accountIds.length) return []
      const rows = await s.db
        .selectFrom('accounts')
        .innerJoin('connections', 'connections.id', 'accounts.connection_id')
        .select(['accounts.id as accountId', 'connections.id as connectionId', 'connections.display_name as name', 'connections.connector_key as key', 'connections.status as status'])
        .where('accounts.workspace_id', '=', workspaceId)
        .where('accounts.id', 'in', accountIds)
        .execute()
      const by = new Map<string, { connectionId: string; name: string; accountIds: string[] }>()
      for (const r of rows) {
        if (r.status === 'disconnected' || !supports(r.key)) continue
        const t = by.get(r.connectionId) ?? { connectionId: r.connectionId, name: r.name, accountIds: [] }
        t.accountIds.push(r.accountId)
        by.set(r.connectionId, t)
      }
      return [...by.values()]
    },
    async refresh(connectionId) {
      const r = await s.sync.refreshBalances(connectionId)
      return r.status === 'ok' ? { status: 'ok', at: r.at } : r
    },
  }
}

/** MCP alerts an operator acts on; the rest stay in the console. */
const OPERATOR_ALERTS = new Set(['audit_append_failed'])

export function mcpFor(s: Omit<Services, 'mcp'>, books?: { reader: FinanceReader; writer: RecordWriter }): AgfnMcpHandle {
  const { db, config } = s
  let handle: AgfnMcpHandle | undefined
  const reviewerPeople = new Map<string, boolean>()
  const verifier = createMcpTokenVerifier({
    db,
    issuer: config.baseUrl,
    getJwks: () => s.auth.api.getJwks() as never,
    getGrant: async (id) => {
      const g = await handle!.control.getGrant(id)
      return g ? { workspaceId: g.workspaceId, personId: g.personId, revokedAt: g.revokedAt, expiresAt: g.expiresAt, clientName: g.clientName } : null
    },
  })
  handle = createAgfnMcp(
    {
      db: db as never,
      reader:
        books?.reader ??
        unavailable<FinanceReader>('Your financial data', {
          entities: async (workspaceId) =>
            (await db.selectFrom('entities').select(['id', 'name', 'kind', 'base_currency']).where('workspace_id', '=', workspaceId).where('archived_at', 'is', null).execute()).map(
              (e) => ({ id: e.id, name: e.name, kind: e.kind, currency: e.base_currency }) as never,
            ),
          dataAvailability: async () => [],
          sources: async () => [],
        }),
      writer: books?.writer ?? unavailable<RecordWriter>('Recording entries'),
      people: peopleFromAuth({ db: db as never, permissions: s.permissions, reauth: s.reauth, passkeysPossible: passkeysPossible(s.config.baseUrl), noRecheck: s.config.challenge === true }),
      verifier,
      liveBalance: liveBalancePort(s),
      // share_answer only when turned on (AGFN_MCP_SHARE=1): the Claude directory review pins the tool set until it closes.
      ...(config.mcpShare ? { share: makeSharePort(s, config.baseUrl) } : {}),
      // More prompts only when turned on (AGFN_MCP_PROMPTS=1): the directory reviews saw the current prompt list.
      ...(config.mcpPrompts ? { promptPacks: true } : {}),
      // get_investments only when turned on (AGFN_TOOL_INVESTMENTS=1): a new tool, so after both directory reviews close.
      ...(config.toolInvestments ? { investments: true } : {}),
      appUrl: config.baseUrl,
      // Postgres means hosted, possibly several instances: share the limits through the database.
      ...(config.databaseUrl.startsWith('postgres') ? { rateLimiter: new DbRateLimiter(db) } : {}),
      hooks: {
        // Revoking a grant also kills the OAuth consent and refresh tokens bound to it, so the AI can't silently renew.
        onGrantRevoked: async (grantId) => {
          await (db as unknown as Kysely<Record<string, { referenceId: string }>>).deleteFrom('oauthRefreshToken').where('referenceId', '=', grantId).execute()
          await (db as unknown as Kysely<Record<string, { referenceId: string }>>).deleteFrom('oauthConsent').where('referenceId', '=', grantId).execute()
        },
        // An operator problem (an activity row not written) goes to the alert webhook, once per kind per workspace per
        // 10 minutes. A workspace's own alerts (a large cash change) are the owner's business: console only, kind and id.
        onAlert: async (a) => {
          const operator = OPERATOR_ALERTS.has(a.kind)
          if (s.alert) s.alert(operator ? 'error' : 'info', `ai alert: ${a.kind}`, { workspaceId: a.workspaceId, kind: a.kind })
          else console.warn('[agfn] alert', a.kind, a.workspaceId)
        },
        // A reviewer's AI keys and tokens work only while their link is live, not until the nightly reseed revokes them.
        personAllowed: async (workspaceId, personId) => {
          let reviewer = reviewerPeople.get(personId)
          if (reviewer === undefined) {
            const p = await withBypass('auth:reviewer', () => db.selectFrom('people').select('email').where('id', '=', personId).executeTakeFirst())
            reviewer = isReviewerEmail(p?.email)
            if (reviewerPeople.size > 10_000) reviewerPeople.clear()
            reviewerPeople.set(personId, reviewer)
          }
          return !reviewer || (await withBypass('auth:reviewer', () => reviewerAccess(db, personId))) === workspaceId
        },
      },
    },
    {
      resourceUrl: `${config.baseUrl}/mcp`,
      allowedOrigins: [new URL(config.baseUrl).origin],
      clientIp: (req) => clientIp(req.headers, config.clientIpHeader),
      authenticatePerson: async (req) => {
        const session = await s.auth.api.getSession({ headers: req.headers })
        if (!session) return null
        const person = await db.selectFrom('people').select(['id', 'email']).where('auth_user_id', '=', session.user.id).executeTakeFirst()
        if (!person) return null
        // Reviewer sessions (reviewer.ts): their demo workspace only, never "the first workspace", and not the pause switch.
        if (isReviewerEmail(person.email)) {
          const demoWs = await reviewerAccess(db, person.id)
          return demoWs && !reviewerBlocked(req.method, new URL(req.url).pathname) ? { workspaceId: demoWs, personId: person.id } : null
        }
        // The same rule as app.ts: the workspace the request names (x-agfn-workspace, or ?workspace=), checked against
        // the person's memberships; otherwise their default (oldest membership). Never another workspace.
        const memberships = await withBypass('auth:memberships', () => s.permissions.workspacesFor(person.id))
        const wanted = req.headers.get('x-agfn-workspace') ?? new URL(req.url).searchParams.get('workspace')
        if (wanted) return memberships.some((w) => w.id === wanted) ? { workspaceId: wanted, personId: person.id } : 'not_found'
        const ws = memberships[0]
        return ws ? { workspaceId: ws.id, personId: person.id } : null
      },
      onError: (err) => console.error('[agfn] mcp error', err),
    },
  )
  // The fill waits this long for the warm before it says it's ready; a slow warm carries on behind it.
  const DEMO_WARM_MAX_MS = 15_000
  // Demo workspaces: once the last demo connection catches up, "Claude (demo)" is shown already connected with one write.
  const seed = handle.service
  const review = s.ledger as Partial<DemoReviewPort>
  // One ledger transaction for the whole tidy (hundreds of small writes; each would otherwise be its own).
  const inOne = (s.ledger as { transaction?: <T>(fn: () => Promise<T>) => Promise<T> }).transaction?.bind(s.ledger)
  const tidy =
    review.reviewItems && review.decideLink && review.setOverride
      ? (ws: string) => (inOne ? inOne(() => tidyDemoReview(s.ledger as unknown as DemoReviewPort, ws)) : tidyDemoReview(s.ledger as unknown as DemoReviewPort, ws))
      : undefined
  // The calling connection is passed so its own still-running job is not counted as busy.
  const seedIfReady = async (ws: string, connectionId: string) => {
    await seedDemoAiWhenReady({ db, seed: (input) => seed.seedDemoAi(input), ...(tidy ? { tidy } : {}), warm: async (w) => warmerFor(s)?.now(w, DEMO_WARM_MAX_MS), log: (m, f) => console.warn(`[agfn] ${m}`, f) }, ws, connectionId)
  }
  ;(s.syncDeps.afterSync ??= []).push(seedIfReady)
  // The last demo import failing still lets the rest of the demo show as ready.
  ;(s.syncDeps.afterFailure ??= []).push(seedIfReady)
  return handle
}

async function optionalImport<T>(name: string): Promise<T | null> {
  try {
    return (await import(name)) as T
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND')) return null
    throw err
  }
}
