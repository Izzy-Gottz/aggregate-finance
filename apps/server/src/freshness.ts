// Per-source freshness for the MCP `sources` block and the "Data as of" line (packages/mcp attaches it to every read).
// Built here, where the connection rows, the connector manifest, and 2a's connections.freshness_json all live. Nothing
// here is a secret: display names, institutions, and timestamps only.

import type { Kysely } from 'kysely'
import type { CoverageView, ProviderFreshness, ReadScope } from '@agfn/contracts'
import { ownerOf, type CoreTables } from '@agfn/db'
import { holdsRecordsOnly } from '@agfn/sync'
import type { FreshnessAspect, SourceEntry, SourcesPort } from '@agfn/mcp'
import type { Services } from './services.ts'

type FreshnessDeps = Pick<Services, 'db' | 'registry'>
/** Just the coverage read, when a ledger is present — used to date file (statement) sources. */
type FreshnessReader = { coverage?: (scope: ReadScope) => Promise<CoverageView[]> }

/** Plaid and SimpleFIN hold a copy we refresh on a schedule; everything else we query live when asked. */
const CACHED = new Set(['plaid', 'simplefin'])

const HOUR = 3_600_000
const DAY = 86_400_000

/**
 * Payroll providers run on different cadences, so the one manifest string ("daily for most, weekly for assisted")
 * can't speak for a specific connection. Where the connection recorded which it is, say so: the Finch connector reads
 * /introspect at connect and stores `assisted` (authentication_methods[].type === 'assisted' / connection_type
 * 'finch'), so assisted → weekly runs, automated → daily API. Unknown → null, and the string's wording decides.
 */
export function payrollWeekly(connectorKey: string, config: Record<string, unknown>): boolean | null {
  if (connectorKey !== 'finch') return null
  return typeof config.assisted === 'boolean' ? config.assisted : null
}

/**
 * How old the basis must be before a source counts as "stale". Keyed on what the number actually means for each kind,
 * not on the first keyword in the manifest string (which flagged nightly Plaid stale after 6h and daily payroll fine
 * after 48h). For cached and file sources the basis is the provider's own data time; for live sources it is OUR last
 * successful sync, so a live source is "stale" only when our sync has stopped.
 */
export function staleAfterMs(kind: SourceEntry['kind'], aspect: FreshnessAspect, freshness: string | null, weekly?: boolean | null): number {
  const f = (freshness ?? '').toLowerCase()
  // Statements arrive monthly; a recent one isn't stale.
  if (kind === 'file') return 45 * DAY
  // Payroll, split by plan where the connection told us: assisted runs weekly, professional is a daily API pull.
  if (weekly === true) return 8 * DAY
  if (weekly === false) return 36 * HOUR
  // Monthly figures (App Store, Google Play): a month-plus between them is normal.
  if (/month/.test(f)) return 45 * DAY
  // Weekly cadence — assisted payroll whose plan we couldn't read, and the like.
  if (/week|assisted/.test(f)) return 8 * DAY
  // Cached bank data (Plaid, SimpleFIN): refreshed on a nightly-ish schedule; investments lag further behind.
  if (kind === 'cached') return aspect === 'investments' ? 48 * HOUR : 36 * HOUR
  // Daily-batch API sources (Deel, Rippling, YouTube…): a missed day is the signal, not a missed hour.
  if (/daily|a day|nightly|overnight|syncs daily/.test(f)) return 36 * HOUR
  // Genuinely live API sources (Stripe, QBO, Xero, Square…): bounded by OUR sync; ~6h with no success means it broke.
  return 6 * HOUR
}

/** The provider timestamp that matches the tool's aspect, with the fallbacks 2a called out (SimpleFIN, Plaid-null). */
function providerTime(fr: ProviderFreshness | undefined, aspect: FreshnessAspect): string | null {
  if (!fr) return null
  const t = fr.transactionsLastSuccessAt ?? null
  const inv = fr.investmentsLastSuccessAt ?? null
  const bal = fr.balancesUpdatedAt ?? null
  switch (aspect) {
    case 'investments':
      return inv ?? bal ?? t
    case 'transactions':
      // SimpleFIN writes no transactions time; its balancesUpdatedAt is when the Bridge last refreshed from the bank.
      return t ?? bal
    case 'balances':
      return bal ?? t
    case 'overview':
      // The stalest of what we have, so overview never claims fresher than its oldest input.
      return [bal, t, inv].filter((x): x is string => !!x).sort()[0] ?? null
  }
}

export function makeSourcesPort(deps: FreshnessDeps, reader?: FreshnessReader): SourcesPort {
  const describeCache = new Map<string, { name: string; freshness: string; auth: string } | null>()
  const describe = (key: string) => {
    if (!describeCache.has(key)) {
      try {
        const d = deps.registry.has(key) ? deps.registry.create(key, { raw: { put: async () => '' } }).describe() : null
        describeCache.set(key, d ? { name: d.name, freshness: d.freshness, auth: d.auth } : null)
      } catch {
        describeCache.set(key, null)
      }
    }
    return describeCache.get(key) ?? null
  }

  return {
    async forEntities({ workspaceId, entityIds, aspect }) {
      const want = new Set(entityIds)
      const spansAll = want.size === 0
      const conns = await deps.db
        .selectFrom('connections')
        .select(['id', 'connector_key', 'entity_id', 'display_name', 'secret_enc', 'last_success_at', 'config_json'])
        .where('workspace_id', '=', workspaceId)
        .where('status', '!=', 'disconnected')
        .execute()
      if (!conns.length) return []
      const accts = await deps.db
        .selectFrom('accounts')
        .select(['id', 'connection_id', 'entity_id', 'institution', 'name'])
        .where('workspace_id', '=', workspaceId)
        .where('connection_id', 'is not', null)
        .where('closed_at', 'is', null)
        .execute()
      const acctsByConn = new Map<string, Array<{ id: string; entity_id: string | null; institution: string | null; name: string | null }>>()
      for (const a of accts) {
        if (!a.connection_id) continue
        ;(acctsByConn.get(a.connection_id) ?? acctsByConn.set(a.connection_id, []).get(a.connection_id)!).push({ id: a.id, entity_id: a.entity_id, institution: a.institution, name: a.name })
      }
      // The entities each connection feeds: its own entity_id, plus any entity its accounts belong to (multi-company logins).
      const entitiesOf = (connId: string, connEntity: string | null) => {
        const ids = new Set<string>()
        if (connEntity) ids.add(connEntity)
        for (const a of acctsByConn.get(connId) ?? []) if (a.entity_id) ids.add(a.entity_id)
        return ids
      }
      const used = conns.filter((c) => {
        if (spansAll) return true
        for (const id of entitiesOf(c.id, c.entity_id)) if (want.has(id)) return true
        return false
      })
      if (!used.length) return []

      // freshness_json (2a's column): guarded, so this works whether or not migration 0915 is deployed.
      const freshById = new Map<string, ProviderFreshness>()
      try {
        const rows = await ownerOf(deps.db).selectFrom('connections').select(['id', 'freshness_json']).where('id', 'in', used.map((c) => c.id)).execute()
        for (const r of rows) if (r.freshness_json) freshById.set(r.id, JSON.parse(r.freshness_json) as ProviderFreshness)
      } catch {
        /* column not present on this deployment yet */
      }

      const kindOf = (c: (typeof used)[number]): SourceEntry['kind'] => {
        if (CACHED.has(c.connector_key)) return 'cached'
        if (holdsRecordsOnly(deps.registry, { connector_key: c.connector_key, secret_enc: c.secret_enc })) return 'manual'
        return describe(c.connector_key)?.auth === 'file' ? 'file' : 'live'
      }

      // File (statement) and manual sources have no provider refresh time; their "as of" is the exact date the ledger
      // reader reports per account as coverage.dataThrough — for a file, the statement date (OFX DTASOF/DTEND, PDF
      // period end, CSV last row); for a manual source, the date of the latest hand-keyed entry or pinned balance. A
      // real day, not a month bucket. Query coverage once, only when such a source is actually in play.
      const datedByCoverage = (c: (typeof used)[number]) => kindOf(c) === 'file' || kindOf(c) === 'manual'
      const closingByAccount = new Map<string, string>()
      if (reader?.coverage && used.some(datedByCoverage)) {
        const scopeEntities = new Set<string>()
        for (const c of used) if (datedByCoverage(c)) for (const id of entitiesOf(c.id, c.entity_id)) scopeEntities.add(id)
        try {
          const coverage = await reader.coverage({ workspaceId, entityIds: [...scopeEntities] })
          for (const cv of coverage) {
            if (cv.dataThrough) closingByAccount.set(cv.accountId, cv.dataThrough)
          }
        } catch {
          /* no ledger for this workspace, or coverage unavailable — leave file sources undated */
        }
      }

      const now = Date.now()
      const entries: SourceEntry[] = used.map((c) => {
        const d = describe(c.connector_key)
        const kind = kindOf(c)
        const institution = (acctsByConn.get(c.id) ?? []).map((a) => a.institution).find((i) => !!i) ?? null
        // data_as_of is a provider's own "current as of" time. Cached sources store one (freshness_json); file sources
        // take the statement closing date from coverage; live sources are read on demand (last_checked carries it).
        const dataAsOf =
          kind === 'cached'
            ? providerTime(freshById.get(c.id), aspect)
            : kind === 'file' || kind === 'manual'
              ? // File = statement date; manual = latest entry/pinned-balance date. When one login spans several accounts
                // with different dates, the login is only fully current through the OLDEST — taking the newest would hide
                // a lagging account and overstate freshness.
                ((acctsByConn.get(c.id) ?? []).map((a) => closingByAccount.get(a.id)).filter((x): x is string => !!x).sort()[0] ?? null)
              : null
        const typical = d?.freshness ?? null
        let config: Record<string, unknown> = {}
        try {
          config = c.config_json ? (JSON.parse(c.config_json) as Record<string, unknown>) : {}
        } catch {
          /* unreadable config → treat as unknown plan */
        }
        const basis = dataAsOf ?? c.last_success_at
        // Manual sources are hand-keyed, not synced, so they're never "stale" on a sync cadence; the line notes
        // separately when the last entry is old. Everything else uses its cadence threshold.
        const stale = kind === 'manual' ? false : basis ? now - Date.parse(basis) > staleAfterMs(kind, aspect, typical, payrollWeekly(c.connector_key, config)) : false
        // A stuck bank: the provider's last refresh failed AFTER its last success (or with no success at all). The data
        // we hold is still good as of the last success; the line says so. The error code is constrained provider text.
        const fr = freshById.get(c.id)
        const failedAt = fr?.transactionsLastFailedAt
        const successAt = fr?.transactionsLastSuccessAt ?? null
        const refreshFailed = kind === 'cached' && !!failedAt && (!successAt || failedAt > successAt)
        const code = refreshFailed && fr?.providerErrorCode && /^[A-Z0-9_]{1,64}$/.test(fr.providerErrorCode) ? fr.providerErrorCode : undefined
        // A manual login that holds exactly one account reads better as that account ("Cash on hand") than as the
        // generic connection name ("Added by hand"); with several accounts the connection name stays clearer.
        const connAccts = acctsByConn.get(c.id) ?? []
        const onlyAcct = connAccts.length === 1 ? connAccts[0] : undefined
        const source = kind === 'manual' && onlyAcct?.name ? onlyAcct.name : c.display_name
        return {
          source, institution, kind, data_as_of: dataAsOf, last_checked: c.last_success_at, typical_refresh: typical, stale,
          ...(refreshFailed ? { refresh_failed_at: failedAt, refresh_last_good: successAt } : {}),
          ...(code ? { error_code: code } : {}),
        }
      })
      // A failed refresh leads, then stalest, then by date — the line surfaces what most needs saying first.
      entries.sort(
        (a, b) =>
          Number(!!b.refresh_failed_at) - Number(!!a.refresh_failed_at) ||
          Number(b.stale) - Number(a.stale) ||
          (a.data_as_of ?? a.last_checked ?? '').localeCompare(b.data_as_of ?? b.last_checked ?? ''),
      )
      return entries
    },
  }
}
