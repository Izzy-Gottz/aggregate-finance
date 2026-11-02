// Polar connector (polar.sh: merchant of record for software and open-source SaaS), read-only.
//
// Auth: one-click sign-in with Aggregate's Polar app (OAuth, read scopes only; POLAR_SCOPES), or an organization access
// token (polar_oat_…) a self-hoster creates with the same read scopes. An OAuth sign-in can cover several organizations:
// each becomes its own connection (one company each), sharing the token. Polar access tokens last about 10 days; they
// renew a day early on sync and the new pair is saved before any read.
//
// A sync cycle: paid orders (created since the last cycle − 30 days, oldest first) → refunds (newest first, until older
// than that window) → disputes (all) → subscriptions (all, for MRR) → done. The 30-day overlap re-reads orders that
// were still in dunning and refunds still pending last time. Payouts and balance transactions aren't in Polar's public
// API: Polar deposits are matched in the bank feed by amount.

import type { ConnectBegin, ConnectBeginContext, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, SyncResult } from '@agfn/contracts'
import {
  ConnectorError,
  cursorCodec,
  healthFromError,
  isConnectorError,
  isRecord,
  OAuthClient,
  requireSecret,
  str,
  systemClock,
  type Clock,
  type ConnectorDeps,
  type OAuthTokens,
} from '@agfn/connector-sdk'
import { createHash } from 'node:crypto'
import { POLAR_API, POLAR_AUTHORIZE, POLAR_SCOPES, PolarClient, type PolarEnv } from './client.ts'
import { mapAccount, mapDispute, mapOrder, mapRefund, mapSubscription } from './map.ts'
import type { PolarDispute, PolarList, PolarOrder, PolarOrganization, PolarRefund, PolarSubscription } from './types.ts'

const PROVIDER = 'polar'
/** Renew this long before the access token runs out. */
const RENEW_EARLY_MS = 86_400_000
const PAGE = 100

/** A pasted organization access token, or the OAuth pair from Aggregate's Polar app. */
export type PolarSecret = { token: string } | { tokens: OAuthTokens }

export interface PolarConnectorOptions {
  /** Aggregate's Polar app: one-click sign-in. Its environment is where the app was created (sandbox.polar.sh or polar.sh). */
  oauth?: { clientId: string; clientSecret: string; redirectUri: string; environment?: PolarEnv }
  /** Hosted: sign-in with the app only, never a pasted token. */
  hosted?: boolean
  /** Re-read window on orders and refunds, in days. Default 30. */
  overlapDays?: number
}

interface PolarCursor {
  stage: 'orders' | 'refunds' | 'disputes' | 'subs'
  page: number
  /** Start of the last finished cycle (null: full backfill). */
  since: string | null
  /** When this cycle started; becomes `since` when it finishes. */
  started: string
  /** Currencies whose balance account was already emitted. */
  acct: string[]
}

const isCursor = (v: unknown): v is PolarCursor =>
  isRecord(v) && ['orders', 'refunds', 'disputes', 'subs'].includes(v.stage as string) && typeof v.page === 'number' && typeof v.started === 'string' && Array.isArray(v.acct)

const isSecret = (s: unknown): s is PolarSecret =>
  isRecord(s) && ((typeof s.token === 'string' && s.token.length >= 10) || (isRecord(s.tokens) && typeof s.tokens.accessToken === 'string'))

export interface PolarConnector extends Connector {
  begin(ctx: Pick<ConnectBeginContext, 'state'>): Promise<ConnectBegin>
}

export function createPolarConnector(opts: PolarConnectorOptions, deps: ConnectorDeps): PolarConnector {
  const clock: Clock = deps.clock ?? systemClock
  const codec = cursorCodec<PolarCursor>(PROVIDER, 1, isCursor)
  const overlapMs = (opts.overlapDays ?? 30) * 86_400_000
  const appEnv: PolarEnv = opts.oauth?.environment === 'sandbox' ? 'sandbox' : 'production'
  const oauth = opts.oauth
    ? new OAuthClient({
        provider: PROVIDER,
        authorizeUrl: POLAR_AUTHORIZE[appEnv],
        tokenUrl: `${POLAR_API[appEnv]}/oauth2/token`,
        clientId: opts.oauth.clientId,
        clientSecret: opts.oauth.clientSecret,
        redirectUri: opts.oauth.redirectUri,
        scopes: POLAR_SCOPES,
        clientAuth: 'body',
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        clock,
      })
    : undefined

  const description: ConnectorDescription = {
    key: PROVIDER,
    name: 'Polar',
    group: 'payments',
    provides: ['transactions', 'balances'],
    freshness: 'updates every few hours',
    auth: oauth ? 'oauth' : 'api_key',
  }

  const envOf = (conn: { config: Record<string, unknown> }): PolarEnv => (conn.config.environment === 'sandbox' ? 'sandbox' : 'production')
  const orgOf = (conn: { config: Record<string, unknown> }): string | undefined => str(conn.config.organizationId)

  /** A client for this connection, renewing OAuth tokens first (when asked) if they're close to running out. */
  async function clientFor(conn: ConnectionRef, renew: boolean): Promise<{ c: PolarClient; renewed?: PolarSecret }> {
    const secret = requireSecret(PROVIDER, conn.secret, isSecret)
    if ('token' in secret) return { c: new PolarClient(secret.token, envOf(conn), deps) }
    if (!oauth) throw new ConnectorError('auth', 'This Polar connection used Aggregate’s Polar app, which isn’t set up here. Connect Polar again.', { provider: PROVIDER, forUser: true })
    if (!renew) return { c: new PolarClient(secret.tokens.accessToken, envOf(conn), deps) }
    const { tokens, refreshed } = await oauth.ensureFresh(secret.tokens, RENEW_EARLY_MS)
    const renewed: PolarSecret = { tokens }
    // Keep the new pair before any read can fail and strand it.
    if (refreshed) await deps.saveSecret?.(conn.id, renewed)
    return { c: new PolarClient(tokens.accessToken, envOf(conn), deps), ...(refreshed ? { renewed } : {}) }
  }

  /** The organizations a token reaches; none when it may not list them (a token without organizations:read). */
  async function organizations(c: PolarClient): Promise<PolarOrganization[]> {
    try {
      const page = await c.get<PolarList<PolarOrganization>>('/organizations/', { limit: PAGE })
      return [...page.items].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    } catch (e) {
      if (isConnectorError(e) && e.status === 403) return []
      throw e
    }
  }

  async function accountsFor(conn: ConnectionRef, currencies: Iterable<string>, s: PolarCursor): Promise<{ events: NormalizedEvent[]; acct: string[] }> {
    const env = envOf(conn)
    const org = orgOf(conn) ?? 'default'
    const fresh = [...new Set(currencies)].filter((c) => !s.acct.includes(c)).sort()
    const events: NormalizedEvent[] = []
    for (const c of fresh) {
      const rawRef = await deps.raw.put(conn.id, 'polar.balance', `${env}:${org}:${c}`, { env, organizationId: org, currency: c })
      events.push(mapAccount(env, org, c, conn.id, rawRef))
    }
    return { events, acct: [...s.acct, ...fresh].sort() }
  }

  const query = (conn: ConnectionRef, page: number, extra: Record<string, string | number | undefined> = {}) => {
    const org = orgOf(conn)
    return { ...(org ? { organization_id: org } : {}), page, limit: PAGE, ...extra }
  }

  async function step(conn: ConnectionRef, c: PolarClient, s: PolarCursor): Promise<{ events: NormalizedEvent[]; next: PolarCursor | null }> {
    const env = envOf(conn)
    const org = orgOf(conn) ?? 'default'
    const windowStart = s.since ? new Date(Date.parse(s.since) - overlapMs).toISOString() : undefined
    const following = (stage: PolarCursor['stage']): PolarCursor => ({ ...s, stage, page: 1 })

    if (s.stage === 'orders') {
      const page = await c.get<PolarList<PolarOrder>>('/orders/', query(conn, s.page, { sorting: 'created_at', ...(windowStart ? { created_after: windowStart } : {}) }))
      const rows: NormalizedEvent[] = []
      for (const o of page.items) {
        const rawRef = await deps.raw.put(conn.id, 'polar.order', o.id, o)
        rows.push(...mapOrder(o, env, org, conn.id, rawRef))
      }
      const more = page.items.length > 0 && s.page < page.pagination.max_page
      return { events: rows, next: more ? { ...s, page: s.page + 1 } : following('refunds') }
    }
    if (s.stage === 'refunds') {
      const page = await c.get<PolarList<PolarRefund>>('/refunds/', query(conn, s.page, { sorting: '-created_at' }))
      const rows: NormalizedEvent[] = []
      let older = false
      for (const r of page.items) {
        if (windowStart && r.created_at < windowStart) {
          older = true
          continue
        }
        const rawRef = await deps.raw.put(conn.id, 'polar.refund', r.id, r)
        const e = mapRefund(r, env, org, conn.id, rawRef)
        if (e) rows.push(e)
      }
      const more = !older && page.items.length > 0 && s.page < page.pagination.max_page
      return { events: rows, next: more ? { ...s, page: s.page + 1 } : following('disputes') }
    }
    if (s.stage === 'disputes') {
      const page = await c.get<PolarList<PolarDispute>>('/disputes/', query(conn, s.page, { sorting: '-created_at' }))
      const rows: NormalizedEvent[] = []
      for (const d of page.items) {
        const rawRef = await deps.raw.put(conn.id, 'polar.dispute', d.id, d)
        rows.push(...mapDispute(d, env, org, conn.id, rawRef))
      }
      const more = page.items.length > 0 && s.page < page.pagination.max_page
      return { events: rows, next: more ? { ...s, page: s.page + 1 } : following('subs') }
    }
    const page = await c.get<PolarList<PolarSubscription>>('/subscriptions/', query(conn, s.page))
    const now = clock.now()
    const rows: NormalizedEvent[] = []
    for (const sub of page.items) {
      const rawRef = await deps.raw.put(conn.id, 'polar.subscription', sub.id, sub)
      rows.push(mapSubscription(sub, now, conn.id, rawRef))
    }
    const more = page.items.length > 0 && s.page < page.pagination.max_page
    return { events: rows, next: more ? { ...s, page: s.page + 1 } : null }
  }

  /** Checks the token reads orders; the cheapest call every Polar grant here needs. */
  async function probe(c: PolarClient, org?: string): Promise<void> {
    await c.get('/orders/', { ...(org ? { organization_id: org } : {}), limit: 1 })
  }

  return {
    describe: () => description,

    /**
     * Sign-in: revoke both tokens at Polar (its docs don't say that ending one ends the other), once the last
     * organization of the sign-in goes. A pasted token is the person's to delete.
     */
    async disconnect(conn) {
      const secret = requireSecret(PROVIDER, conn.secret, isSecret)
      if ('token' in secret) return { notRevoked: 'In Polar, go to your organization’s settings → Delete the token.' }
      if (conn.config.sharedSecretKey && conn.config.lastOfGrant !== true) return
      const failed = { notRevoked: 'In Polar, go to Settings → Remove Aggregate.' }
      if (!opts.oauth) return failed
      const f = deps.fetch ?? fetch
      const { refreshToken, accessToken } = secret.tokens
      const pairs: Array<[string | undefined, 'refresh_token' | 'access_token']> = [[refreshToken, 'refresh_token'], [accessToken, 'access_token']]
      let refused = false
      for (const [token, hint] of pairs) {
        if (!token) continue
        try {
          const res = await f(`${POLAR_API[envOf(conn)]}/oauth2/revoke`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token, token_type_hint: hint, client_id: opts.oauth.clientId, client_secret: opts.oauth.clientSecret }).toString(),
          })
          if (!res.ok) refused = true
        } catch {
          refused = true
        }
      }
      if (refused) return failed
    },

    async begin(ctx) {
      if (oauth) return { kind: 'oauth', url: oauth.authorizationUrl({ state: ctx.state }) }
      return {
        kind: 'api_key',
        label: 'Polar organization access token',
        helpUrl: 'https://polar.sh/docs/integrate/authentication',
        placeholder: 'polar_oat_…',
        fields: [
          { name: 'token', label: 'Organization access token', secret: true },
          { name: 'environment', label: 'Environment', options: ['production', 'sandbox'] },
        ],
        steps: [
          'In Polar, open your organization’s Settings and find Organization Access Tokens.',
          'Create a token named “Aggregate”, with no expiry or the longest one offered.',
          'Tick only the read scopes listed below.',
          'Copy the token (polar_oat_…) and paste it here.',
        ],
        permissions: [...POLAR_SCOPES],
      }
    },

    /** input: { code } back from Polar sign-in, or { token, environment? } pasted. Verified with one read. */
    async connect(input) {
      const code = str(input.code)
      if (code && oauth) {
        const tokens = await oauth.exchangeCode(code)
        const granted = tokens.scope?.split(/\s+/)
        const missing = granted ? POLAR_SCOPES.filter((s) => !granted.includes(s)) : []
        if (missing.length) {
          throw new ConnectorError('invalid_input', `Polar access was granted without ${missing.join(', ')}. Connect again and allow it.`, { provider: PROVIDER, forUser: true })
        }
        const c = new PolarClient(tokens.accessToken, appEnv, deps)
        const orgs = await organizations(c)
        if (!orgs.length) throw new ConnectorError('invalid_input', 'This Polar sign-in doesn’t reach any organization. Connect again and choose one.', { provider: PROVIDER, forUser: true })
        await probe(c, orgs[0]!.id)
        const secret: PolarSecret = { tokens }
        const sharedSecretKey = `polar:${createHash('sha256').update(tokens.refreshToken ?? tokens.accessToken).digest('hex').slice(0, 16)}`
        const sandbox = appEnv === 'sandbox' ? { warnings: ['This is Polar’s sandbox: test data, not real sales.'] } : {}
        const [first, ...rest] = orgs.map((o) => ({
          secret,
          config: { environment: appEnv, organizationId: o.id, displayName: `Polar · ${o.name}`, ...(orgs.length > 1 ? { sharedSecretKey } : {}), ...sandbox },
        }))
        return { ...first!, ...(rest.length ? { additional: rest } : {}) }
      }
      if (opts.hosted) throw new ConnectorError('invalid_input', 'Connect Polar with “Sign in with Polar”.', { provider: PROVIDER, forUser: true })
      const token = str(input.token)?.trim() ?? str(input.apiKey)?.trim()
      if (!token || token.length < 10 || /\s/.test(token)) throw new ConnectorError('invalid_input', 'paste a Polar organization access token', { provider: PROVIDER })
      const environment: PolarEnv = input.environment === 'sandbox' ? 'sandbox' : 'production'
      const c = new PolarClient(token, environment, deps)
      await probe(c)
      // An organization token reaches exactly one organization; its name is shown when the token may read it.
      const [org] = await organizations(c)
      const secret: PolarSecret = { token }
      return {
        secret,
        config: { environment, ...(org ? { organizationId: org.id, displayName: `Polar · ${org.name}` } : {}), ...(environment === 'sandbox' ? { warnings: ['This is Polar’s sandbox: test data, not real sales.'] } : {}) },
      }
    },

    async sync(conn, cursor): Promise<SyncResult> {
      const { c, renewed } = await clientFor(conn, true)
      const nowIso = new Date(clock.now()).toISOString()
      const prev = codec.decode(cursor) ?? { stage: 'orders', page: 1, since: null, started: nowIso, acct: [] }
      // A cycle's first page stamps when it started.
      const s: PolarCursor = prev.stage === 'orders' && prev.page === 1 ? { ...prev, started: nowIso } : prev
      const { events: rows, next } = await step(conn, c, s)
      const currencies = rows.flatMap((e) => (e.type === 'processor.balance_txn' ? [e.net.currency] : []))
      const acc = await accountsFor(conn, currencies, s)
      const events = [...acc.events, ...rows]
      const extra = renewed ? { updatedSecret: renewed } : {}
      if (next) return { events, cursor: codec.encode({ ...next, acct: acc.acct }), hasMore: true, ...extra }
      // Cycle done: the next one starts from this one's start (minus the overlap).
      const done: PolarCursor = { stage: 'orders', page: 1, since: s.started, started: s.started, acct: acc.acct }
      return { events, cursor: codec.encode(done), hasMore: false, ...extra }
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        const secret = requireSecret(PROVIDER, conn.secret, isSecret)
        // Never renews here (a rotated refresh token would have nowhere to go); it renews on the next sync.
        if ('tokens' in secret && secret.tokens.expiresAt !== undefined && secret.tokens.expiresAt <= clock.now() && secret.tokens.refreshToken) {
          return { status: 'ok', message: 'The access token renews on the next sync.' }
        }
        const { c } = await clientFor(conn, false)
        await probe(c, orgOf(conn))
        return { status: 'ok', lastSuccessAt: new Date(clock.now()).toISOString() }
      } catch (e) {
        return healthFromError(e)
      }
    },
  }
}
