// Wise connector: one depository account per STANDARD currency balance of the chosen profile, balance snapshots,
// and transactions from balance statements (statement.json, COMPACT). Read-only, personal API token.
//
// A sync cycle: one "balances" page, then one statement window per balance (windows ≤ 365 days; Wise allows 469).
// The final cursor remembers when the cycle ran; the next cycle starts `overlapDays` earlier.
//
// SCA: statements can answer 403 + x-2fa-approval (one-time token). With an RSA private key (secret.scaPrivateKey
// or opts.scaPrivateKey) we sign the token (SHA256withRSA) and retry with x-2fa-approval + X-Signature. Without a
// key, or if Wise still refuses (EU/UK personal tokens cannot read statements under PSD2), the cycle keeps the accounts
// and balances, skips statements and returns a warning saying what's needed. The high-water mark does not advance, so
// once statements become readable the next cycle backfills the skipped range. health() stays 'ok' with that message.

import type { KeyObject } from 'node:crypto'
import type { ConnectBegin, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, SyncResult } from '@agfn/contracts'
import {
  ConnectorError,
  cursorCodec,
  healthFromError,
  isRecord,
  isoTimestamp,
  requireSecret,
  str,
  systemClock,
  type Clock,
  type ConnectorDeps,
  type ConnectorWebhook,
} from '@agfn/connector-sdk'
import { WiseClient, type WiseEnv } from './client.ts'
import { balanceAccountId, isBusiness, mapBalanceAccount, mapBalanceSnapshot, mapStatementTxn, profileName, statementTxnId } from './map.ts'
import { isScaRequired, loadPrivateKey, scaHeaders } from './sca.ts'
import type { WiseBalance, WiseProfile, WiseStatement } from './types.ts'
import { wiseWebhook } from './webhook.ts'

export interface WiseSecret {
  token: string
  /** RSA private key (PEM) whose public key is uploaded in Wise; signs SCA one-time tokens. */
  scaPrivateKey?: string
}

export interface WiseConfig {
  profileId: string
  profileType: 'business' | 'personal'
  name: string
  warnings?: string[]
}

export interface WiseConnectorOptions {
  env?: WiseEnv
  baseUrl?: string
  /** Deployment-wide SCA key (PEM), used when the connection secret has none. */
  scaPrivateKey?: string
  /** Wise's webhook signing public key (PEM) for this environment. Omit to disable webhooks. */
  webhookPublicKey?: string
  /** History pulled on the first sync. Default 365 days. */
  backfillDays?: number
  overlapDays?: number
}

interface WiseCursor {
  stage: 'balances' | 'statements'
  /** [balanceId, currency] */
  bals: Array<[number, string]>
  idx: number
  /** Start of the current statement window (ISO timestamp). */
  from: string
  /** Start of the cycle's statement range and its end (cycle time). */
  start: string
  end: string
  /** Cycle time of the previous complete cycle. */
  last: string | null
}

const isCursor = (v: unknown): v is WiseCursor =>
  isRecord(v) && (v.stage === 'balances' || v.stage === 'statements') && Array.isArray(v.bals) && typeof v.idx === 'number'
const isSecret = (v: unknown): v is WiseSecret =>
  isRecord(v) && typeof v.token === 'string' && v.token.trim() !== '' && (v.scaPrivateKey === undefined || typeof v.scaPrivateKey === 'string')

const DAY = 86_400_000
const WINDOW_DAYS = 365

export interface WiseConnector extends Connector {
  begin(): Promise<ConnectBegin>
  readonly webhook?: ConnectorWebhook
}

export const SCA_NO_KEY_MESSAGE =
  'Wise requires Strong Customer Authentication to read balance statements for this profile. Add an RSA key pair: upload the public key in Wise (Settings → API tokens → Manage public keys) and give Aggregate the private key (PEM) when connecting.'
export const SCA_REFUSED_MESSAGE =
  'Wise refused the signed SCA request for balance statements. Wise lets personal API tokens read statements only for accounts based in the US, Canada, Australia, New Zealand, Singapore or Malaysia. Check the uploaded public key matches the private key, or connect a supported account.'

/** Sync warnings / health messages when statements are blocked by SCA (balances still sync). */
export const SCA_NO_KEY_WARNING =
  "Wise transactions weren't synced: balance statements need Strong Customer Authentication. Upload a public key in Wise and give Aggregate the matching SCA private key."
export const SCA_REFUSED_WARNING =
  "Wise transactions weren't synced: Wise refused the signed statement request. EU/UK personal tokens can't read balance statements; otherwise check the uploaded public key."

/** The SCA failure behind a statement read, as a warning, or undefined for any other error. */
const scaWarning = (e: unknown): string | undefined =>
  e instanceof ConnectorError ? (e.code === 'SCA_KEY_MISSING' ? SCA_NO_KEY_WARNING : e.code === 'SCA_REFUSED' ? SCA_REFUSED_WARNING : undefined) : undefined

export function createWiseConnector(opts: WiseConnectorOptions, deps: ConnectorDeps): WiseConnector {
  const clock: Clock = deps.clock ?? systemClock
  const codec = cursorCodec<WiseCursor>('wise', 1, isCursor)
  const overlap = Math.max(0, opts.overlapDays ?? 3)
  const backfill = Math.max(1, opts.backfillDays ?? 365)
  const client = (token: string) => new WiseClient(token, deps, { ...(opts.env ? { env: opts.env } : {}), ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}) })
  const secretOf = (conn: ConnectionRef) => requireSecret('wise', conn.secret, isSecret)
  const webhook = opts.webhookPublicKey ? wiseWebhook(opts.webhookPublicKey) : undefined
  const keys = new Map<string, KeyObject>()
  const keyFor = (pem: string | undefined): KeyObject | undefined => {
    if (!pem) return undefined
    let k = keys.get(pem)
    if (!k) {
      k = loadPrivateKey(pem)
      keys.set(pem, k)
    }
    return k
  }

  const description: ConnectorDescription = {
    key: 'wise',
    name: 'Wise',
    group: 'banks',
    provides: ['balances', 'transactions'],
    freshness: webhook ? 'updates within minutes via webhooks' : 'updates every few hours',
    auth: 'api_key',
    // 1: transactions carry a real `at` instant so the ledger dates them by the workspace's business day. Existing
    // connections re-import once to re-date rows booked before the fix.
    dataVersion: 1,
  }

  const profileIdOf = (conn: ConnectionRef): string => {
    const id = conn.config.profileId
    const s = typeof id === 'number' ? String(id) : str(id)
    if (!s) throw new ConnectorError('permanent', 'connection has no Wise profileId; reconnect', { provider: 'wise' })
    return s
  }

  /** GET with the SCA dance: on a signed-token challenge, sign and retry once. */
  async function getWithSca<T>(c: WiseClient, path: string, query: Record<string, string>, pem: string | undefined): Promise<T> {
    try {
      return await c.get<T>(path, query)
    } catch (e) {
      if (!isScaRequired(e)) throw e
      const key = keyFor(pem)
      if (!key) throw new ConnectorError('auth', SCA_NO_KEY_MESSAGE, { provider: 'wise', forUser: true, status: 403, code: 'SCA_KEY_MISSING' })
      try {
        return await c.get<T>(path, query, scaHeaders(e.oneTimeToken, key))
      } catch (e2) {
        if (e2 instanceof ConnectorError && e2.status === 403) {
          throw new ConnectorError('auth', SCA_REFUSED_MESSAGE, { provider: 'wise', forUser: true, status: 403, code: 'SCA_REFUSED' })
        }
        throw e2
      }
    }
  }

  async function balancesPage(conn: ConnectionRef, prev: WiseCursor | null): Promise<SyncResult> {
    const { token } = secretOf(conn)
    const pid = profileIdOf(conn)
    const at = isoTimestamp(clock.now())
    const bals = await client(token).get<WiseBalance[]>(`/v4/profiles/${encodeURIComponent(pid)}/balances`, { types: 'STANDARD' })
    const profile = { id: pid, name: str(conn.config.name) ?? 'Wise', business: conn.config.profileType !== 'personal' }
    const events: NormalizedEvent[] = []
    for (const b of bals) {
      const rawRef = await deps.raw.put(conn.id, 'wise.balance', String(b.id), b)
      events.push(mapBalanceAccount(b, profile, conn.id, rawRef), mapBalanceSnapshot(b, pid, conn.id, rawRef, at))
    }
    const last = prev?.last ?? null
    const start = last ? new Date(Date.parse(last) - overlap * DAY).toISOString() : new Date(clock.now() - backfill * DAY).toISOString()
    const next: WiseCursor = { stage: 'statements', bals: bals.map((b) => [b.id, b.currency]), idx: 0, from: start, start, end: at, last }
    return { events, cursor: codec.encode(next), hasMore: true }
  }

  async function statementPage(conn: ConnectionRef, s: WiseCursor): Promise<SyncResult> {
    const bal = s.bals[s.idx]
    const done = (events: NormalizedEvent[]): SyncResult => ({
      events,
      cursor: codec.encode({ stage: 'balances', bals: [], idx: 0, from: s.end, start: s.end, end: s.end, last: s.end }),
      hasMore: false,
    })
    if (!bal) return done([])
    const [balanceId, currency] = bal
    const { token, scaPrivateKey } = secretOf(conn)
    const pid = profileIdOf(conn)
    const to = new Date(Math.min(Date.parse(s.from) + WINDOW_DAYS * DAY, Date.parse(s.end))).toISOString()
    let st: WiseStatement
    try {
      st = await getWithSca<WiseStatement>(
        client(token),
        `/v1/profiles/${encodeURIComponent(pid)}/balance-statements/${balanceId}/statement.json`,
        { currency, intervalStart: s.from, intervalEnd: to, type: 'COMPACT' },
        scaPrivateKey ?? opts.scaPrivateKey,
      )
    } catch (e) {
      const warning = scaWarning(e)
      if (!warning) throw e
      // SCA blocks every statement of the profile: end the cycle (accounts and balances are already out). `last` stays
      // where it was so the skipped range is read once statements work.
      const skipped: WiseCursor = { stage: 'balances', bals: [], idx: 0, from: s.end, start: s.end, end: s.end, last: s.last }
      return { events: [], cursor: codec.encode(skipped), hasMore: false, warnings: [warning] }
    }
    const accountId = balanceAccountId(pid, currency)
    const events: NormalizedEvent[] = []
    for (const t of st.transactions) {
      const id = statementTxnId(t)
      const rawRef = await deps.raw.put(conn.id, 'wise.statement_txn', id, t)
      events.push(mapStatementTxn(t, accountId, conn.id, rawRef))
    }
    if (to < s.end) return { events, cursor: codec.encode({ ...s, from: to }), hasMore: true }
    if (s.idx + 1 < s.bals.length) return { events, cursor: codec.encode({ ...s, idx: s.idx + 1, from: s.start }), hasMore: true }
    return done(events)
  }

  return {
    describe: () => description,
    ...(webhook ? { webhook } : {}),

    async begin() {
      return {
        kind: 'api_key',
        label: 'Wise personal API token',
        steps: [
          'Sign in to your Wise business account on the web and open Your account → Integrations and tools → API tokens.',
          'Choose Add new token (pick Read only if Wise offers it) and confirm with 2-step verification.',
          'Copy the token and paste it here.',
        ],
        permissions: [
          'Read only: balances and statements. Aggregate can’t send or convert money.',
          'Wise lets a personal token read statements only for accounts based in the US, Canada, Australia, New Zealand, Singapore or Malaysia. Elsewhere, balances still sync.',
        ],
        helpUrl: 'https://wise.com/your-account/integrations-and-tools/api-tokens',
        placeholder: '00000000-0000-0000-0000-000000000000',
      }
    },

    async connect(input) {
      const token = (str(input.apiKey) ?? str(input.token))?.trim()
      if (!token) throw new ConnectorError('invalid_input', 'a Wise personal API token is required', { provider: 'wise' })
      if (/\s/.test(token)) throw new ConnectorError('invalid_input', 'the Wise token must not contain spaces', { provider: 'wise' })
      const pem = str(input.scaPrivateKey)
      if (pem) loadPrivateKey(pem)
      const wanted = input.profileId === undefined ? undefined : String(input.profileId)
      const profiles = await client(token).get<WiseProfile[]>('/v2/profiles')
      const list = Array.isArray(profiles) ? profiles : []
      const profile = wanted ? list.find((p) => String(p.id) === wanted) : (list.find(isBusiness) ?? list[0])
      if (!profile) {
        throw new ConnectorError('invalid_input', wanted ? `Wise profile ${wanted} is not visible to this token` : 'this Wise token has no profiles', { provider: 'wise' })
      }
      const warnings: string[] = []
      if (!wanted && list.length > 1) warnings.push(`Using the ${isBusiness(profile) ? 'business' : 'personal'} profile "${profileName(profile)}"; connect again with profileId to use another.`)
      if (!pem && !opts.scaPrivateKey) {
        warnings.push('No SCA key given: if Wise asks for Strong Customer Authentication, balance statements (transactions) will not sync.')
      }
      const config: WiseConfig = {
        profileId: String(profile.id),
        profileType: isBusiness(profile) ? 'business' : 'personal',
        name: profileName(profile),
        ...(warnings.length ? { warnings } : {}),
      }
      const secret: WiseSecret = { token, ...(pem ? { scaPrivateKey: pem } : {}) }
      return { secret, config: { ...config } }
    },

    async sync(conn, cursor) {
      const s = codec.decode(cursor)
      return !s || s.stage === 'balances' ? balancesPage(conn, s) : statementPage(conn, s)
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        const { token, scaPrivateKey } = secretOf(conn)
        const pid = profileIdOf(conn)
        const c = client(token)
        const bals = await c.get<WiseBalance[]>(`/v4/profiles/${encodeURIComponent(pid)}/balances`, { types: 'STANDARD' })
        const b = Array.isArray(bals) ? bals[0] : undefined
        if (!b) return { status: 'ok' }
        // Balances work; probe one day of statements so an SCA block shows up as a message, not a failure.
        const end = isoTimestamp(clock.now())
        const start = new Date(clock.now() - DAY).toISOString()
        try {
          await getWithSca(c, `/v1/profiles/${encodeURIComponent(pid)}/balance-statements/${b.id}/statement.json`, { currency: b.currency, intervalStart: start, intervalEnd: end, type: 'COMPACT' }, scaPrivateKey ?? opts.scaPrivateKey)
        } catch (e) {
          const warning = scaWarning(e)
          if (warning) return { status: 'ok', message: warning }
          throw e
        }
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },
  }
}
