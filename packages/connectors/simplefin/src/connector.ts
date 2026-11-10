// SimpleFIN Bridge connector: bank and card accounts the person linked at SimpleFIN Bridge (they pay SimpleFIN
// directly, no Plaid). They paste a one-time Setup Token; Aggregate claims it once and keeps the Access URL as the
// secret. Read-only by design: the protocol has no write endpoints.
//
// A sync cycle reads GET /accounts in windows of at most 44 days (the Bridge recommends 45 and warns past it), from the backfill start (first
// sync) or from the last cycle's end minus `overlapDays` (re-reads late postings), to now. Pending rows aren't
// requested: their ids may change when they post, which would double-count. The Bridge allows about 24 requests a
// day per token and refreshes once a day, so a cycle that starts within `minIntervalMs` of the last one is skipped.

import type { ConnectBegin, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, ProviderFreshness, SyncResult } from '@agfn/contracts'
import { ConnectorError, cursorCodec, healthFromError, isRecord, isoTimestamp, oldestIso, requireSecret, str, systemClock, type Clock, type ConnectorDeps } from '@agfn/connector-sdk'
import { SimplefinClient, claimAccessUrl, claimUrlOf, parseAccessUrl } from './client.ts'
import { accountKey, errorWarnings, mapAccount, mapBalance, mapTxn, needsBridgeFix } from './map.ts'
import type { SfAccountSet } from './types.ts'

export interface SimplefinSecret {
  accessUrl: string
}

export interface SimplefinConfig {
  accountIds: string[]
  institutions: string[]
  displayName?: string
  warnings?: string[]
}

export interface SimplefinConnectorOptions {
  /** History asked for on the first sync. Default 365 days (banks often give less). */
  backfillDays?: number
  /** Days re-read on each later cycle. Default 5 (the Bridge's advice). */
  overlapDays?: number
  /** Skip a cycle that starts sooner than this after the last one. Default 4 hours. */
  minIntervalMs?: number
  /** Self-hosted only: accept Setup Tokens from any https SimpleFIN server, not just SimpleFIN Bridge. */
  allowAnyHost?: boolean
}

interface SimplefinCursor {
  stage: 'idle' | 'window'
  /** Unix seconds. */
  start: number
  end: number
  /** End of the last complete cycle (unix seconds). */
  last: number | null
  /** When the last cycle finished (ms). */
  ranAt: number | null
  /** The Bridge warned about too many requests: no request before this (ms). */
  slowUntil?: number
}

const isCursor = (v: unknown): v is SimplefinCursor =>
  isRecord(v) && (v.stage === 'idle' || v.stage === 'window') && typeof v.start === 'number' && typeof v.end === 'number'

const isSecret = (v: unknown): v is SimplefinSecret => isRecord(v) && typeof v.accessUrl === 'string' && v.accessUrl !== ''

const DAY = 86_400
// The Bridge warns "Requested date range exceeds recommended range of 45 days" and may cap it later: ask for less.
const WINDOW = 44 * DAY
/** After a request-quota warning, wait this long: the Bridge disables tokens that keep going past its warnings. */
const QUOTA_PAUSE_MS = 12 * 3_600_000
// The Bridge's request-quota warning. Not "Requested date range…", which is about the window, not the quota.
const QUOTA_WORDS = /too many requests|request (quota|limit)|daily (request )?limit|rate limit|quota/i
const MAX_ACCOUNTS = 500
const MAX_ROWS = 100_000

export interface SimplefinConnector extends Connector {
  begin(): Promise<ConnectBegin>
}

export function createSimplefinConnector(opts: SimplefinConnectorOptions, deps: ConnectorDeps): SimplefinConnector {
  const clock: Clock = deps.clock ?? systemClock
  const codec = cursorCodec<SimplefinCursor>('simplefin', 1, isCursor)
  const backfill = Math.max(1, opts.backfillDays ?? 365) * DAY
  const overlap = Math.max(0, opts.overlapDays ?? 5) * DAY
  const minInterval = Math.max(0, opts.minIntervalMs ?? 4 * 3_600_000)
  const anyHost = opts.allowAnyHost === true
  const clientOf = (conn: ConnectionRef) => new SimplefinClient(parseAccessUrl(requireSecret('simplefin', conn.secret, isSecret).accessUrl, anyHost), deps)

  const description: ConnectorDescription = {
    key: 'simplefin',
    name: 'SimpleFIN Bridge',
    group: 'banks',
    provides: ['balances', 'transactions'],
    freshness: 'updates once a day',
    auth: 'api_key',
    dataVersion: 2,
  }

  const institutionsOf = (set: SfAccountSet): Map<string, string> => new Map((set.connections ?? []).filter((c) => c.name).map((c) => [c.conn_id, c.name as string]))

  async function windowPage(conn: ConnectionRef, s: SimplefinCursor): Promise<SyncResult> {
    const we = Math.min(s.start + WINDOW, s.end)
    const set = await clientOf(conn).accounts<SfAccountSet>({ 'start-date': s.start, 'end-date': we })
    // A response far beyond any real person's banks is refused, not stored.
    const rows = (set.accounts ?? []).reduce((t, a) => t + (a.transactions?.length ?? 0), 0)
    if ((set.accounts ?? []).length > MAX_ACCOUNTS || rows > MAX_ROWS) {
      throw new ConnectorError('permanent', `SimpleFIN sent ${set.accounts?.length ?? 0} accounts and ${rows} transactions for one window, more than Aggregate accepts`, { provider: 'simplefin' })
    }
    const inst = institutionsOf(set)
    const events: NormalizedEvent[] = []
    for (const a of set.accounts ?? []) {
      const institution = (a.conn_id ? inst.get(a.conn_id) : undefined) ?? a.org?.name
      const { transactions, ...acct } = a
      const rawRef = await deps.raw.put(conn.id, 'simplefin.account', accountKey(a), acct)
      events.push(mapAccount(a, institution, conn.id, rawRef), mapBalance(a, conn.id, rawRef))
      for (const t of transactions ?? []) {
        if (t.pending) continue
        const tRef = await deps.raw.put(conn.id, 'simplefin.transaction', `${accountKey(a)}:${t.id}`, t)
        events.push(mapTxn(t, a, conn.id, tRef))
      }
    }
    const warnings = errorWarnings(set.errlist, set.errors)
    if (needsBridgeFix(set.errlist)) warnings.push('A bank needs to be reconnected inside SimpleFIN Bridge (sign in there and fix the connection); Aggregate will pick it up on the next sync.')
    // SimpleFIN's balance-date per account: the Bridge's own word on how current each balance is.
    const byAccount: Record<string, string> = {}
    for (const a of set.accounts ?? []) if (Number.isFinite(a['balance-date'])) byAccount[accountKey(a)] = new Date(a['balance-date'] * 1000).toISOString()
    const freshness: ProviderFreshness | undefined = Object.keys(byAccount).length
      ? { checkedAt: isoTimestamp(clock.now()), balancesUpdatedAtByAccount: byAccount, balancesUpdatedAt: oldestIso(Object.values(byAccount))! }
      : undefined
    const fresh = freshness ? { freshness } : {}
    const done = we >= s.end
    const base: SimplefinCursor = done ? { stage: 'idle', start: s.start, end: s.end, last: s.end, ranAt: clock.now() } : { ...s, start: we }
    // The Bridge says we're near its daily limit (in errors[]): stop here, and don't ask again for a while.
    if ((set.errors ?? []).some((e) => QUOTA_WORDS.test(e))) {
      warnings.push('SimpleFIN asked Aggregate to slow down; the next sync is in about 12 hours.')
      return { events, cursor: codec.encode({ ...base, slowUntil: clock.now() + QUOTA_PAUSE_MS }), hasMore: false, warnings, ...fresh }
    }
    const { slowUntil: _drop, ...next } = base
    return { events, cursor: codec.encode(next), hasMore: !done, ...(warnings.length ? { warnings } : {}), ...fresh }
  }

  return {
    describe: () => description,

    async begin() {
      return {
        kind: 'api_key',
        label: 'SimpleFIN Setup Token',
        steps: [
          'Connect banks through SimpleFIN, about $15/year, paid to them: open SimpleFIN Bridge (beta-bridge.simplefin.org), sign up and link your banks there.',
          'In SimpleFIN Bridge choose Apps → New app connection, name it “Aggregate” and create a Setup Token.',
          'Copy the token and paste it here. It works once: Aggregate exchanges it for read access right away.',
        ],
        permissions: [
          'Read only: account names, balances and posted transactions. SimpleFIN has no way to move money.',
          'You can switch Aggregate’s access off at any time in SimpleFIN Bridge.',
        ],
        helpUrl: 'https://beta-bridge.simplefin.org/',
        placeholder: 'aHR0cHM6Ly9iZXRhLWJyaWRnZS5zaW1wbGVmaW4ub3JnL3NpbXBsZWZpbi9jbGFpbS8…',
      }
    },

    async connect(input) {
      const token = (str(input.apiKey) ?? str(input.token) ?? str(input.setupToken))?.trim()
      if (!token) throw new ConnectorError('invalid_input', 'a SimpleFIN Setup Token is required', { provider: 'simplefin' })
      const accessUrl = await claimAccessUrl(claimUrlOf(token, anyHost), deps)
      const access = parseAccessUrl(accessUrl, anyHost)
      const set = await new SimplefinClient(access, deps).accounts<SfAccountSet>({ 'balances-only': 1 })
      const inst = [...new Set([...institutionsOf(set).values(), ...(set.accounts ?? []).map((a) => a.org?.name).filter((n): n is string => !!n)])]
      const config: SimplefinConfig = {
        accountIds: (set.accounts ?? []).map(accountKey),
        institutions: inst.slice(0, 20),
        ...(inst.length === 1 ? { displayName: `SimpleFIN · ${inst[0]}`.slice(0, 120) } : {}),
      }
      const warnings = errorWarnings(set.errlist, set.errors)
      if (warnings.length) config.warnings = warnings
      const secret: SimplefinSecret = { accessUrl }
      return { secret, config: { ...config } }
    },

    async sync(conn, cursor) {
      const s = codec.decode(cursor)
      if (s?.slowUntil != null && clock.now() < s.slowUntil) return { events: [], cursor: codec.encode(s), hasMore: false }
      if (s?.stage === 'window') return windowPage(conn, s)
      const now = Math.floor(clock.now() / 1000)
      if (s?.ranAt != null && clock.now() - s.ranAt < minInterval) return { events: [], cursor: codec.encode(s), hasMore: false }
      const start = s?.last != null ? s.last - overlap : now - backfill
      return windowPage(conn, { stage: 'window', start, end: now, last: s?.last ?? null, ranAt: s?.ranAt ?? null })
    },

    // No request: the Bridge allows about 24 a day per token, so health is the secret's shape and the last sync's errors.
    async health(conn): Promise<ConnectorHealth> {
      try {
        parseAccessUrl(requireSecret('simplefin', conn.secret, isSecret).accessUrl, anyHost)
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },

  }
}
