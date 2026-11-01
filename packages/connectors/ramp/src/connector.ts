// Ramp connector: the business card (one credit_card account per Ramp business, since Ramp reports the card
// balance at business level; per-card detail stays in linkRefs.card_id), card transactions, reimbursements (a
// separate "Ramp Reimbursements" account, owed to employees) and bills (payable invoices). Read-only.
//
// Auth: OAuth 2.0 client credentials from the customer's own Ramp developer app (client id + secret stored as the
// connection secret). Tokens are cached in memory per connector instance until shortly before expiry.
//
// A sync cycle: business + balance page, then transactions (from_date), reimbursements (updated_after), bills,
// each following Ramp's `page.next` URL. Incremental windows start `overlapDays` before the previous cycle and
// never after the oldest still-pending card transaction. Transactions ask for every state, since Ramp leaves out
// DECLINED by default and a pending one that's later declined would otherwise stay pending. Bills have no
// updated-since filter: the first cycle reads all bills; later cycles read every OPEN bill, bills paid since the
// window start, and archived bills (left out by default) so a stored bill that was archived or deleted turns void.

import type { ConnectBegin, ConnectBeginContext, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, SyncResult } from '@agfn/contracts'
import {
  ConnectorError,
  cursorCodec,
  healthFromError,
  isConnectorError,
  isRecord,
  isoDate,
  isoTimestamp,
  requireSecret,
  str,
  systemClock,
  type Clock,
  type ConnectorDeps,
  type ConnectorWebhook,
  type HttpRequest,
} from '@agfn/connector-sdk'
import { RAMP_AUTHORIZE, RAMP_SCOPES, RampClient, exchangeRampCode, revokeRampToken, type RampCredentials, type RampEnv } from './client.ts'
import { mapBill, mapCardAccount, mapCardBalance, mapCardTxn, mapReimbursement, mapReimbursementAccount } from './map.ts'
import type { RampBill, RampBusiness, RampBusinessBalance, RampPage, RampReimbursement, RampTransaction } from './types.ts'
import { rampWebhook } from './webhook.ts'

/** A customer's own developer app (client credentials), or one-click sign-in through Aggregate's partner app. */
export type RampSecret = RampCredentials | RampOAuthSecret

export interface RampOAuthSecret {
  kind: 'oauth'
  refreshToken: string
  /** ISO time the refresh token dies, when the Ramp app has a refresh lifetime. Refreshing doesn't extend it. */
  refreshExpiresAt?: string
}

export interface RampConfig {
  businessId: string
  businessName?: string
  warnings?: string[]
}

export interface RampConnectorOptions {
  env?: RampEnv
  baseUrl?: string
  /** Override the requested scopes (default: transactions, business, bills, reimbursements :read). */
  scopes?: string[]
  /** Webhook subscription secret. Omit to disable webhooks. */
  webhookSecret?: string
  /** Read bills (needs bills:read). Default true. */
  bills?: boolean
  overlapDays?: number
  /** Ramp page_size (2–100). Default 100. */
  pageSize?: number
  /**
   * Aggregate's Ramp partner app (one-click sign-in): its client id and secret. The app needs the Authorization Code
   * and Refresh Token grants and our callback URL registered. Without both, people paste their own app's credentials.
   */
  oauthClientId?: string
  oauthClientSecret?: string
}

type Stage = 'business' | 'txns' | 'reimb' | 'bills_all' | 'bills_open' | 'bills_paid' | 'bills_archived'

interface RampCursor {
  stage: Stage
  biz: string
  /** Ramp `page.next` URL for the current stage, or null for its first page. */
  next: string | null
  /** Window start (YYYY-MM-DD) for this cycle, null = full history. */
  since: string | null
  cycle: string
  last: string | null
  pend: string | null
  prevPend: string | null
}

const STAGES: Stage[] = ['business', 'txns', 'reimb', 'bills_all', 'bills_open', 'bills_paid', 'bills_archived']
const isCursor = (v: unknown): v is RampCursor => isRecord(v) && STAGES.includes(v.stage as Stage) && typeof v.biz === 'string'
const isSecret = (v: unknown): v is RampSecret =>
  isRecord(v) &&
  ((v.kind === 'oauth' && typeof v.refreshToken === 'string' && v.refreshToken !== '') ||
    (typeof v.clientId === 'string' && v.clientId !== '' && typeof v.clientSecret === 'string' && v.clientSecret !== ''))
const isOAuth = (s: RampSecret): s is RampOAuthSecret => 'kind' in s && s.kind === 'oauth'

/** Per-sync warnings when an optional scope wasn't granted to the developer app. */
export const RAMP_NO_BILLS_WARNING = "Bills were skipped: this Ramp app doesn't have the bills:read scope."
export const RAMP_NO_REIMBURSEMENTS_WARNING = "Reimbursements were skipped: this Ramp app doesn't have the reimbursements:read scope."

/** Warn this long before a sign-in's refresh token dies. */
const REFRESH_WARN_MS = 7 * 86_400_000
export const rampAccessEndsMessage = (iso: string) => `Ramp access ends on ${iso.slice(0, 10)}; reconnect Ramp before then`
export const rampAccessEndedMessage = (iso: string) => `Ramp access ended on ${iso.slice(0, 10)}; reconnect Ramp`

export interface RampConnector extends Connector {
  begin(ctx?: ConnectBeginContext): Promise<ConnectBegin>
  readonly webhook?: ConnectorWebhook
  /** The cached client for a secret (exposed for diagnostics and tests). */
  clientFor(secret: RampSecret): RampClient
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
}

const minDate = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a < b ? a : b)

/** Accept {clientId, clientSecret} or a single "client_id:client_secret" string (apiKey). */
export function parseRampInput(input: Record<string, unknown>): RampSecret {
  let clientId = str(input.clientId)?.trim()
  let clientSecret = str(input.clientSecret)?.trim()
  const key = str(input.apiKey)?.trim()
  if ((!clientId || !clientSecret) && key) {
    const i = key.indexOf(':')
    if (i > 0) {
      clientId = key.slice(0, i).trim()
      clientSecret = key.slice(i + 1).trim()
    }
  }
  if (!clientId || !clientSecret || /\s/.test(clientId + clientSecret)) {
    throw new ConnectorError('invalid_input', 'Ramp needs the developer app client ID and client secret (client_id:client_secret)', { provider: 'ramp' })
  }
  return { clientId, clientSecret }
}

export function createRampConnector(opts: RampConnectorOptions, deps: ConnectorDeps): RampConnector {
  const clock: Clock = deps.clock ?? systemClock
  const codec = cursorCodec<RampCursor>('ramp', 1, isCursor)
  const pageSize = Math.min(100, Math.max(2, opts.pageSize ?? 100))
  const overlap = Math.max(0, opts.overlapDays ?? 3)
  const wantBills = opts.bills ?? true
  const webhook = opts.webhookSecret ? rampWebhook(opts.webhookSecret) : undefined
  const clients = new Map<string, RampClient>()

  const oauthApp = opts.oauthClientId && opts.oauthClientSecret ? { clientId: opts.oauthClientId, clientSecret: opts.oauthClientSecret } : undefined
  const hostOpts = { ...(opts.env ? { env: opts.env } : {}), ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}) }
  const credsOf = (s: RampSecret): RampCredentials => {
    if (!isOAuth(s)) return s
    if (!oauthApp) throw new ConnectorError('auth', 'Ramp sign-in is not configured on this server; reconnect with your own Ramp app', { provider: 'ramp', forUser: true })
    // Past the refresh lifetime Ramp would only answer invalid_grant; say when it ended instead.
    if (s.refreshExpiresAt && Date.parse(s.refreshExpiresAt) <= clock.now()) {
      throw new ConnectorError('auth', rampAccessEndedMessage(s.refreshExpiresAt), { provider: 'ramp', forUser: true })
    }
    return { ...oauthApp, refreshToken: s.refreshToken }
  }
  const clientFor = (s: RampSecret): RampClient => {
    const creds = credsOf(s)
    const key = `${creds.clientId}\0${creds.clientSecret}\0${creds.refreshToken ?? ''}`
    let c = clients.get(key)
    if (!c) {
      c = new RampClient(creds, deps, { ...(opts.env ? { env: opts.env } : {}), ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}), ...(opts.scopes ? { scopes: opts.scopes } : {}) })
      clients.set(key, c)
    }
    return c
  }
  const clientOf = (conn: ConnectionRef) => clientFor(requireSecret('ramp', conn.secret, isSecret))

  /** Once per cycle: a sign-in whose refresh token dies within a week gets a reconnect warning. */
  function expiryWarnings(conn: ConnectionRef): string[] {
    const s = requireSecret('ramp', conn.secret, isSecret)
    if (!isOAuth(s) || !s.refreshExpiresAt) return []
    return Date.parse(s.refreshExpiresAt) - clock.now() <= REFRESH_WARN_MS ? [rampAccessEndsMessage(s.refreshExpiresAt)] : []
  }

  const description: ConnectorDescription = {
    key: 'ramp',
    name: 'Ramp',
    group: 'spend',
    provides: wantBills ? ['balances', 'transactions', 'bills'] : ['balances', 'transactions'],
    freshness: webhook ? 'updates within minutes via webhooks' : 'updates every few hours',
    auth: oauthApp ? 'oauth' : 'api_key',
  }

  /** Optional resources: 403 (scope not granted) skips them; `denied` lets the page say so in a warning. */
  async function optionalPage<T>(fn: () => Promise<RampPage<T>>): Promise<RampPage<T> & { denied?: true }> {
    try {
      return await fn()
    } catch (e) {
      if (isConnectorError(e) && e.status === 403) return { data: [], page: { next: null }, denied: true }
      throw e
    }
  }

  const page = <T>(c: RampClient, path: string, s: RampCursor, query: HttpRequest['query']) =>
    c.get<RampPage<T>>(s.next ?? path, s.next ? undefined : { page_size: pageSize, ...query })

  async function businessPage(conn: ConnectionRef, prev: RampCursor | null): Promise<SyncResult> {
    const c = clientOf(conn)
    const at = isoTimestamp(clock.now())
    const biz = await c.get<RampBusiness>('/developer/v1/business')
    const bal = await c.get<RampBusinessBalance>('/developer/v1/business/balance')
    const rawBiz = await deps.raw.put(conn.id, 'ramp.business', biz.id, biz)
    const rawBal = await deps.raw.put(conn.id, 'ramp.business_balance', `${biz.id}@${at.slice(0, 10)}`, bal)
    const events: NormalizedEvent[] = [
      mapCardAccount(biz.id, biz.business_name_on_card ?? undefined, conn.id, rawBiz),
      mapReimbursementAccount(biz.id, conn.id, rawBiz),
    ]
    const snap = mapCardBalance(biz.id, bal, conn.id, rawBal, at)
    if (snap) events.push(snap)
    const last = prev?.last ?? null
    const prevPend = prev?.pend ?? null
    const next: RampCursor = {
      stage: 'txns',
      biz: biz.id,
      next: null,
      since: last ? minDate(addDays(last, -overlap), prevPend) : null,
      cycle: at.slice(0, 10),
      last,
      pend: null,
      prevPend,
    }
    const warnings = expiryWarnings(conn)
    return { events, cursor: codec.encode(next), hasMore: true, ...(warnings.length ? { warnings } : {}) }
  }

  function advance(s: RampCursor, next: string | null, nextStage: Stage | 'done', pend: string | null): SyncResult & { cursor: string } {
    if (next) return { events: [], cursor: codec.encode({ ...s, next, pend }), hasMore: true }
    if (nextStage === 'done') {
      return { events: [], cursor: codec.encode({ ...s, stage: 'business', next: null, since: null, last: s.cycle, pend, prevPend: null }), hasMore: false }
    }
    return { events: [], cursor: codec.encode({ ...s, stage: nextStage, next: null, pend }), hasMore: true }
  }

  const afterReimb = (s: RampCursor): Stage | 'done' => (!wantBills ? 'done' : s.last === null ? 'bills_all' : 'bills_open')

  async function stagePage(conn: ConnectionRef, s: RampCursor): Promise<SyncResult> {
    const c = clientOf(conn)
    const events: NormalizedEvent[] = []
    const since = s.since ? `${s.since}T00:00:00Z` : undefined
    switch (s.stage) {
      case 'txns': {
        const p = await page<RampTransaction>(c, '/developer/v1/transactions', s, { from_date: since, order_by_date_asc: true, state: 'ALL' })
        let pend = s.pend
        for (const t of p.data) {
          const rawRef = await deps.raw.put(conn.id, 'ramp.transaction', t.id, t)
          const e = mapCardTxn(t, s.biz, conn.id, rawRef)
          if (e.status === 'pending') pend = minDate(pend, isoDate(t.user_transaction_time))
          events.push(e)
        }
        return { ...advance(s, p.page.next, 'reimb', pend), events }
      }
      case 'reimb': {
        const p = await optionalPage(() => page<RampReimbursement>(c, '/developer/v1/reimbursements', s, { updated_after: since }))
        for (const r of p.data) {
          const rawRef = await deps.raw.put(conn.id, 'ramp.reimbursement', r.id, r)
          events.push(mapReimbursement(r, s.biz, conn.id, rawRef))
        }
        return { ...advance(s, p.page.next, afterReimb(s), s.pend), events, ...(p.denied ? { warnings: [RAMP_NO_REIMBURSEMENTS_WARNING] } : {}) }
      }
      case 'bills_all':
      case 'bills_open':
      case 'bills_paid':
      case 'bills_archived': {
        const query: HttpRequest['query'] =
          s.stage === 'bills_open' ? { payment_status: 'OPEN' }
          : s.stage === 'bills_paid' ? { payment_status: 'PAID', from_paid_at: since }
          : s.stage === 'bills_archived' ? { is_archived: true }
          : {}
        const p = await optionalPage(() => page<RampBill>(c, '/developer/v1/bills', s, query))
        for (const b of p.data) {
          const rawRef = await deps.raw.put(conn.id, 'ramp.bill', b.id, b)
          events.push(mapBill(b, conn.id, rawRef))
        }
        // Denied: the later bill passes would be denied too, so the cycle ends here. A fresh connection skips the
        // archived pass: it has no stored bills to void.
        const nextStage = p.denied ? 'done' : s.stage === 'bills_open' ? 'bills_paid' : s.stage === 'bills_paid' ? 'bills_archived' : 'done'
        return { ...advance(s, p.page.next, nextStage, s.pend), events, ...(p.denied ? { warnings: [RAMP_NO_BILLS_WARNING] } : {}) }
      }
      default:
        throw new ConnectorError('cursor_invalid', 'unexpected stage', { provider: 'ramp' })
    }
  }

  return {
    describe: () => description,
    clientFor,
    ...(webhook ? { webhook } : {}),

    async begin(ctx) {
      if (oauthApp && ctx) {
        const u = new URL(RAMP_AUTHORIZE[opts.env ?? 'production'])
        u.searchParams.set('response_type', 'code')
        u.searchParams.set('client_id', oauthApp.clientId)
        u.searchParams.set('redirect_uri', ctx.redirectUri)
        u.searchParams.set('scope', (opts.scopes ?? RAMP_SCOPES).join(' '))
        u.searchParams.set('state', ctx.state)
        return { kind: 'oauth', url: u.toString() }
      }
      // Customer-made developer app (client credentials): asked for like an API key.
      return {
        kind: 'api_key',
        label: 'Ramp developer app',
        steps: [
          'Sign in to Ramp as an admin and open Company → Developer.',
          'Create a new app named “Aggregate” and turn on the Client Credentials grant.',
          'Under Scopes, choose Configure allowed scopes and pick only transactions:read, business:read, bills:read and reimbursements:read.',
          'Copy the Client ID and Client secret into the two fields here.',
        ],
        permissions: [
          'Read only: transactions, bills and reimbursements.',
        ],
        helpUrl: 'https://docs.ramp.com/developer-api/v1/authorization',
        placeholder: 'ramp_id_...:ramp_sec_...',
        fields: [
          { name: 'clientId', label: 'Client ID', placeholder: 'ramp_id_…' },
          { name: 'clientSecret', label: 'Client secret', placeholder: 'ramp_sec_…', secret: true },
        ],
      }
    },

    async connect(input) {
      const code = str(input.code)
      let secret: RampSecret
      if (code) {
        if (!oauthApp) throw new ConnectorError('invalid_input', 'Ramp sign-in is not configured on this server', { provider: 'ramp' })
        const redirectUri = str(input.redirectUri)
        if (!redirectUri) throw new ConnectorError('invalid_input', 'redirectUri is required to finish Ramp sign-in', { provider: 'ramp' })
        const t = await exchangeRampCode(oauthApp, code, redirectUri, deps, hostOpts)
        if (!t.refreshToken) throw new ConnectorError('permanent', 'Ramp did not return a refresh token; enable the Refresh Token grant on the Aggregate app in Ramp', { provider: 'ramp' })
        secret = { kind: 'oauth', refreshToken: t.refreshToken, ...(t.refreshExpiresAt ? { refreshExpiresAt: isoTimestamp(t.refreshExpiresAt) } : {}) }
      } else secret = parseRampInput(input)
      const c = clientFor(secret)
      const biz = await c.get<RampBusiness>('/developer/v1/business')
      const name = biz.business_name_legal ?? biz.business_name_on_card ?? undefined
      const config: RampConfig = { businessId: biz.id, ...(name ? { businessName: name.slice(0, 120) } : {}) }
      return { secret, config: { ...config } }
    },

    async sync(conn, cursor) {
      const s = codec.decode(cursor)
      return !s || s.stage === 'business' ? businessPage(conn, s) : stagePage(conn, s)
    },

    /** Sign-in connections: revoke the refresh token so Ramp drops the grant. A customer's own app is theirs to delete. */
    async disconnect(conn) {
      const s = requireSecret('ramp', conn.secret, isSecret)
      if (!isOAuth(s) || !oauthApp) return
      try {
        await revokeRampToken(oauthApp, s.refreshToken, deps, hostOpts)
      } catch (e) {
        // Already revoked or expired: nothing left to revoke.
        if (isConnectorError(e) && (e.kind === 'auth' || e.kind === 'invalid_input')) return
        throw e
      }
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        await clientOf(conn).get('/developer/v1/business')
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },
  }
}
