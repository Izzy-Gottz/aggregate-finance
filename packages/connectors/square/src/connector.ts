// Square connector: processor balance movements from payouts and their payout entries (charges, refunds, fees,
// disputes, adjustments, each with gross/fee/net), the payouts themselves, and invoices sent. Read-only.
//
// Auth: OAuth (authorize → code → JSON /oauth2/token; 30-day access tokens refreshed with the non-expiring refresh
// token, returned as updatedSecret), or the owner's personal access token (no refresh).
//
// A sync cycle: "locations" (one account per currency), then per location: /v2/payouts pages (from the high-water
// mark, 3 days of overlap; 3 years on the first sync) and, for each payout, /v2/payouts/{id}/payout-entries pages;
// then /v2/invoices pages per location.
//
// Then, per location, completed payments (/v2/payments) and refunds (/v2/refunds) from the same window: each sale is a
// charge into the Square balance the moment it happens. Its payout entry later carries the same id (pay:<payment>,
// ref:<refund>), so it settles that record instead of adding a second one. Cash and "other" tenders never touch the
// Square balance: they go to a per-location "Square cash drawer" (cash on hand), which a later bank deposit settles.
// Square has no balance endpoint, so no balance.snapshot.

import type { ConnectBegin, ConnectBeginContext, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, SyncResult } from '@agfn/contracts'
import {
  ConnectorError,
  OAuthClient,
  cursorCodec,
  healthFromError,
  isConnectorError,
  isRecord,
  isoTimestamp,
  normalizeCurrency,
  requireSecret,
  str,
  systemClock,
  type Clock,
  type ConnectorDeps,
  type ConnectorWebhook,
} from '@agfn/connector-sdk'
import { SQUARE_HOSTS, SQUARE_SCOPES, SquareClient, type SquareEnv } from './client.ts'
import { mapAccount, mapCashAccount, mapCashPayment, mapCashRefund, mapEntry, mapInvoice, mapPayment, mapPayout, mapRefund } from './map.ts'
import type { SquareInvoice, SquareLocation, SquareMerchant, SquarePayment, SquarePayout, SquarePayoutEntry, SquareRefund, SquareTokenResponse } from './types.ts'
import { squareWebhook } from './webhook.ts'

export interface SquareSecret {
  accessToken: string
  /** OAuth only. Code-flow refresh tokens don't expire. */
  refreshToken?: string
  /** ISO timestamp of access token expiry (OAuth only). */
  expiresAt?: string
  kind: 'oauth' | 'personal'
}

export interface SquareConfig {
  env: SquareEnv
  merchantId: string
  businessName?: string
  warnings: string[]
}

export interface SquareConnectorOptions {
  env?: SquareEnv
  /** OAuth application id/secret (only needed for the OAuth flow and token refresh). */
  clientId?: string
  clientSecret?: string
  /** Webhook subscription signature key + its exact notification URL; enables `webhook`. */
  webhookSignatureKey?: string
  webhookUrl?: string
  pageSize?: number
  lookbackDays?: number
  /** Hosted service: Square sign-in only (read-only scopes); personal access tokens have full access. */
  hosted?: boolean
}

export const SQUARE_PERSONAL_TOKEN_REFUSED =
  'Aggregate connects to Square with Square sign-in only, which gives it read-only access. A personal access token has full access, so it isn’t accepted here.'
export const SQUARE_PERSONAL_TOKEN_HOSTED_WARNING =
  'This Square connection uses a personal access token, which has full access. Aggregate only reads, but it now uses Square sign-in (read-only): reconnect Square to switch.'

export interface SquareConnector extends Connector {
  begin(ctx: ConnectBeginContext): Promise<ConnectBegin>
  readonly webhook?: ConnectorWebhook
  readonly client: SquareClient
}

interface SquareCursor {
  stage: 'locations' | 'payouts' | 'entries' | 'payments' | 'refunds' | 'invoices'
  merchant: string
  locs: Array<{ id: string; cur: string; name?: string; tz?: string }>
  li: number
  /** Payouts page cursor for the current location (next page to read). */
  pc: string | null
  /** Whether payouts has more pages after the queued ones. */
  pmore: boolean
  /** Payout ids whose entries still need reading. */
  queue: string[]
  ec: string | null
  ic: string | null
  /** Payments / refunds page cursor for the current location. */
  yc?: string | null
  /** Currencies with an account.upsert this cycle. */
  curs: string[]
  since: string | null
  cycle: string | null
  hw: string | null
}

const DAY = 86_400_000
// A PAID payout can turn FAILED when the bank's answer comes late (after weekends, more than 3 days): re-read 35.
const OVERLAP_MS = 35 * DAY
/** Square says to renew tokens every 7 days or less: a 30-day token is refreshed once it has 23 days left. */
const REFRESH_WITHIN_MS = 23 * DAY

const isCursor = (v: unknown): v is SquareCursor =>
  isRecord(v) &&
  ['locations', 'payouts', 'entries', 'payments', 'refunds', 'invoices'].includes(v.stage as string) &&
  typeof v.merchant === 'string' &&
  Array.isArray(v.locs) &&
  typeof v.li === 'number' &&
  Array.isArray(v.queue) &&
  Array.isArray(v.curs)

const isSecret = (v: unknown): v is SquareSecret =>
  isRecord(v) && typeof v.accessToken === 'string' && v.accessToken !== '' && (v.kind === 'oauth' || v.kind === 'personal')

export const SQUARE_PERSONAL_TOKEN_WARNING =
  'A Square personal access token has full read and write access to the account. Aggregate only calls read endpoints; connecting with OAuth (read-only scopes) is safer.'

/** Per-sync warning: payments skipped because the token lacks PAYMENTS_READ (sales still arrive with payouts). */
export const SQUARE_NO_PAYMENTS_WARNING = "Sales show up when Square pays them out: reconnect Square to see each sale as it happens."

/** Per-sync warning: invoices skipped because the token lacks INVOICES_READ. */
export const SQUARE_NO_INVOICES_WARNING = "Invoices were skipped: this Square connection doesn't have the INVOICES_READ permission."

const fresh = (since: string | null, cycle: string | null, hw: string | null): SquareCursor => ({
  stage: 'locations', merchant: '', locs: [], li: 0, pc: null, pmore: false, queue: [], ec: null, ic: null, curs: [], since, cycle, hw,
})

export function createSquareConnector(opts: SquareConnectorOptions, deps: ConnectorDeps): SquareConnector {
  const client = new SquareClient(deps)
  const clock: Clock = deps.clock ?? systemClock
  const codec = cursorCodec<SquareCursor>('square', 1, isCursor)
  const defaultEnv: SquareEnv = opts.env ?? 'production'
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 100))
  const lookbackMs = Math.max(1, opts.lookbackDays ?? 3 * 365) * DAY

  const description: ConnectorDescription = {
    key: 'square',
    name: 'Square',
    group: 'payments',
    provides: ['transactions', 'invoices'],
    freshness:
      // Square only sends events for granted scopes: payout and invoice changes, not payments or disputes.
      (opts.webhookSignatureKey ? 'syncs on Square payout and invoice webhooks; ' : 'syncs every few hours; ') +
      'sales appear on the next sync, settled when Square pays them out',
    auth: 'oauth',
    // 1: sales name the cardholder, buyer email or note when Square has one; existing rows are re-read once.
    dataVersion: 1,
  }

  const configOf = (conn: ConnectionRef): SquareConfig => {
    const c = conn.config
    const businessName = str(c.businessName)
    return {
      env: c.env === 'sandbox' ? 'sandbox' : c.env === 'production' ? 'production' : defaultEnv,
      merchantId: str(c.merchantId) ?? '',
      warnings: Array.isArray(c.warnings) ? c.warnings.filter((x): x is string => typeof x === 'string') : [],
      ...(businessName ? { businessName } : {}),
    }
  }

  function tokenSecret(t: SquareTokenResponse, prev?: SquareSecret): SquareSecret {
    const refreshToken = t.refresh_token ?? prev?.refreshToken
    return {
      kind: 'oauth',
      accessToken: t.access_token ?? '',
      ...(refreshToken ? { refreshToken } : {}),
      ...(t.expires_at ? { expiresAt: t.expires_at } : {}),
    }
  }

  /** Refreshes an OAuth token once it is 7 days old (23 of its 30 days left). Returns the secret to use and whether it changed. */
  async function usableSecret(conn: ConnectionRef): Promise<{ secret: SquareSecret; updated?: SquareSecret }> {
    const s = requireSecret('square', conn.secret, isSecret)
    if (s.kind !== 'oauth' || !s.expiresAt) return { secret: s }
    const left = Date.parse(s.expiresAt) - clock.now()
    if (!(left < REFRESH_WITHIN_MS)) return { secret: s }
    if (!s.refreshToken || !opts.clientId || !opts.clientSecret) {
      if (left > 0) return { secret: s }
      throw new ConnectorError('auth', 'Square access token expired and cannot be refreshed; reconnect Square', { provider: 'square' })
    }
    const t = await client.token(configOf(conn).env, {
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: s.refreshToken,
    })
    const next = tokenSecret(t, s)
    return { secret: next, updated: next }
  }

  const accountOnce = async (conn: ConnectionRef, state: SquareCursor, cur: string, events: NormalizedEvent[], rawRef: string) => {
    if (state.curs.includes(cur)) return
    state.curs = [...state.curs, cur]
    events.push(mapAccount(state.merchant, cur, conn.id, rawRef, configOf(conn).businessName))
  }

  async function step(conn: ConnectionRef, token: string, s: SquareCursor): Promise<SyncResult> {
    const env = configOf(conn).env
    const events: NormalizedEvent[] = []
    const enc = (st: SquareCursor, hasMore = true): SyncResult => ({ events, cursor: codec.encode(st), hasMore })

    if (s.stage === 'locations') {
      const now = clock.now()
      const res = await client.get<{ locations?: SquareLocation[] }>(env, token, '/v2/locations')
      const locs = (res.locations ?? []).map((l) => ({ id: l.id, cur: normalizeCurrency(l.currency), ...(l.name ? { name: l.name.slice(0, 80) } : {}), ...(l.timezone ? { tz: l.timezone } : {}) }))
      const merchant = configOf(conn).merchantId || res.locations?.find((l) => l.merchant_id)?.merchant_id || 'square'
      const next: SquareCursor = { ...fresh(s.hw ?? isoTimestamp(now - lookbackMs), isoTimestamp(now), s.hw), stage: 'payouts', merchant, locs }
      for (const l of res.locations ?? []) {
        const rawRef = await deps.raw.put(conn.id, 'square.location', l.id, l)
        await accountOnce(conn, next, normalizeCurrency(l.currency), events, rawRef)
      }
      return enc(next)
    }

    if (s.stage === 'payouts') {
      const loc = s.locs[s.li]
      if (!loc) return enc({ ...s, stage: 'payments', li: 0, yc: null })
      const res = await client.get<{ payouts?: SquarePayout[]; cursor?: string }>(env, token, '/v2/payouts', {
        location_id: loc.id,
        begin_time: s.since ?? undefined,
        sort_order: 'ASC',
        limit: pageSize,
        cursor: s.pc ?? undefined,
      })
      const st: SquareCursor = { ...s }
      const queue: string[] = []
      for (const p of res.payouts ?? []) {
        const rawRef = await deps.raw.put(conn.id, 'square.payout', p.id, p)
        const ev = mapPayout(p, s.merchant, loc.cur, conn.id, rawRef)
        await accountOnce(conn, st, ev.net.currency, events, rawRef)
        events.push(ev)
        queue.push(p.id)
      }
      const more = !!res.cursor
      if (queue.length) return enc({ ...st, stage: 'entries', queue, ec: null, pc: res.cursor || null, pmore: more })
      if (more) return enc({ ...st, pc: res.cursor ?? null })
      return enc({ ...st, li: s.li + 1, pc: null, pmore: false })
    }

    if (s.stage === 'entries') {
      const payoutId = s.queue[0]
      const loc = s.locs[s.li]
      if (!payoutId || !loc) return enc({ ...s, stage: 'payouts', queue: [] })
      const res = await client.get<{ payout_entries?: SquarePayoutEntry[]; cursor?: string }>(
        env,
        token,
        `/v2/payouts/${encodeURIComponent(payoutId)}/payout-entries`,
        { sort_order: 'ASC', limit: pageSize, cursor: s.ec ?? undefined },
      )
      const st: SquareCursor = { ...s }
      for (const e of res.payout_entries ?? []) {
        const rawRef = await deps.raw.put(conn.id, 'square.payout_entry', e.id, e)
        const ev = mapEntry(e, s.merchant, loc.cur, conn.id, rawRef, s.cycle ?? isoTimestamp(clock.now()))
        await accountOnce(conn, st, ev.net.currency, events, rawRef)
        events.push(ev)
      }
      if (res.cursor) return enc({ ...st, ec: res.cursor })
      const queue = s.queue.slice(1)
      if (queue.length) return enc({ ...st, queue, ec: null })
      if (s.pmore) return enc({ ...st, stage: 'payouts', queue: [], ec: null })
      return enc({ ...st, stage: 'payouts', queue: [], ec: null, li: s.li + 1, pc: null, pmore: false })
    }

    if (s.stage === 'payments' || s.stage === 'refunds') {
      const loc = s.locs[s.li]
      const isPay = s.stage === 'payments'
      if (!loc) return enc(isPay ? { ...s, stage: 'refunds', li: 0, yc: null } : { ...s, stage: 'invoices', li: 0, ic: null })
      let res: { payments?: SquarePayment[]; refunds?: SquareRefund[]; cursor?: string }
      try {
        res = await client.get(env, token, isPay ? '/v2/payments' : '/v2/refunds', {
          location_id: loc.id,
          begin_time: s.since ?? undefined,
          sort_order: 'ASC',
          limit: pageSize,
          cursor: s.yc ?? undefined,
        })
      } catch (e) {
        // An older grant without PAYMENTS_READ: sales still arrive with their payouts.
        if (isConnectorError(e) && (e.code === 'INSUFFICIENT_SCOPES' || e.code === 'FORBIDDEN')) {
          const out = enc({ ...s, stage: 'invoices', li: 0, ic: null })
          return { ...out, warnings: [SQUARE_NO_PAYMENTS_WARNING] }
        }
        throw e
      }
      const st: SquareCursor = { ...s }
      for (const x of (isPay ? res.payments : res.refunds) ?? []) {
        const rawRef = await deps.raw.put(conn.id, isPay ? 'square.payment' : 'square.refund', x.id, x)
        const cash = isPay ? mapCashPayment(x as SquarePayment, s.merchant, loc, conn.id, rawRef) : mapCashRefund(x as SquareRefund, s.merchant, loc, conn.id, rawRef)
        if (cash) {
          // The location's drawer, once per cycle (only for locations that take cash or other tenders).
          const key = `cash:${loc.id}`
          if (!st.curs.includes(key)) {
            st.curs = [...st.curs, key]
            events.push(mapCashAccount(s.merchant, loc, conn.id, rawRef))
          }
          events.push(cash)
          continue
        }
        const ev = isPay ? mapPayment(x as SquarePayment, s.merchant, loc.cur, conn.id, rawRef) : mapRefund(x as SquareRefund, s.merchant, loc.cur, conn.id, rawRef)
        if (!ev) continue
        await accountOnce(conn, st, ev.net.currency, events, rawRef)
        events.push(ev)
      }
      if (res.cursor) return enc({ ...st, yc: res.cursor })
      return enc({ ...st, li: s.li + 1, yc: null })
    }

    // invoices
    const loc = s.locs[s.li]
    const done = () => enc(fresh(null, null, isoTimestamp(Date.parse(s.cycle ?? isoTimestamp(clock.now())) - OVERLAP_MS)), false)
    if (!loc) return done()
    let res: { invoices?: SquareInvoice[]; cursor?: string }
    try {
      res = await client.get(env, token, '/v2/invoices', { location_id: loc.id, limit: 100, cursor: s.ic ?? undefined })
    } catch (e) {
      // A personal token or an older OAuth grant without INVOICES_READ: payouts still sync.
      // Square documents both INSUFFICIENT_SCOPES and FORBIDDEN for a missing permission.
      if (isConnectorError(e) && (e.code === 'INSUFFICIENT_SCOPES' || e.code === 'FORBIDDEN')) return { ...done(), warnings: [SQUARE_NO_INVOICES_WARNING] }
      throw e
    }
    for (const inv of res.invoices ?? []) {
      const rawRef = await deps.raw.put(conn.id, 'square.invoice', inv.id, inv)
      events.push(mapInvoice(inv, loc.cur, conn.id, rawRef))
    }
    if (res.cursor) return enc({ ...s, ic: res.cursor })
    if (s.li + 1 < s.locs.length) return enc({ ...s, li: s.li + 1, ic: null })
    return done()
  }

  function oauthClient(redirectUri: string, env: SquareEnv): OAuthClient {
    if (!opts.clientId) throw new ConnectorError('invalid_input', 'Square OAuth is not configured (clientId missing)', { provider: 'square' })
    return new OAuthClient({
      provider: 'square',
      authorizeUrl: `${SQUARE_HOSTS[env]}/oauth2/authorize`,
      tokenUrl: `${SQUARE_HOSTS[env]}/oauth2/token`,
      clientId: opts.clientId,
      ...(opts.clientSecret ? { clientSecret: opts.clientSecret } : {}),
      redirectUri,
      scopes: SQUARE_SCOPES,
      scopeSeparator: ' ',
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      clock,
    })
  }

  const webhook =
    opts.webhookSignatureKey && opts.webhookUrl
      ? squareWebhook({ signatureKey: opts.webhookSignatureKey, notificationUrl: opts.webhookUrl }, clock)
      : undefined

  return {
    client,
    ...(webhook ? { webhook } : {}),
    describe: () => description,

    /** Revoke our access at Square (OAuth only; a personal token is the owner's to delete). Safe to call twice. */
    async disconnect(conn) {
      const secret = conn.secret as Partial<SquareSecret> | null
      if (secret?.kind !== 'oauth') return { notRevoked: 'In the Square Developer Console, go to your application → Replace the token.' }
      if (!secret.accessToken || !opts.clientId || !opts.clientSecret) return
      try {
        await client.revoke(configOf(conn).env, opts.clientId, opts.clientSecret, secret.accessToken)
      } catch (e) {
        // Already revoked or expired: nothing left to revoke.
        if (isConnectorError(e) && (e.kind === 'auth' || e.status === 404)) return
        throw e
      }
    },

    async begin(ctx) {
      const env = ctx.connection ? configOf(ctx.connection).env : defaultEnv
      if (!opts.clientId) {
        if (opts.hosted) throw new ConnectorError('invalid_input', 'Square sign-in isn’t set up on this server yet.', { provider: 'square', forUser: true })
        // No OAuth app configured (self-hosted single business): use the owner's personal access token.
        return {
          kind: 'api_key',
          label: 'Square personal access token',
          helpUrl: 'https://developer.squareup.com/apps',
          placeholder: 'EAAA…',
          steps: [
            'Open the Square Developer Console and sign in with your Square account.',
            'Create an application (any name, e.g. "Aggregate"), open it and switch to Production.',
            'Copy the Production Access token from the Credentials page and paste it here.',
          ],
          permissions: ['Square personal tokens can’t be limited; Aggregate only reads payments, refunds, payouts, locations and invoices.'],
        }
      }
      // session=false: always show the Square login, so the person picks the right seller account.
      return { kind: 'oauth', url: oauthClient(ctx.redirectUri, env).authorizationUrl({ state: ctx.state, extraParams: { session: 'false' } }) }
    },

    async connect(input) {
      const envIn = input.env ?? defaultEnv
      if (envIn !== 'production' && envIn !== 'sandbox') throw new ConnectorError('invalid_input', "env must be 'production' or 'sandbox'", { provider: 'square' })
      let env: SquareEnv = envIn
      const code = str(input.code)
      const personal = str(input.accessToken)?.trim()
      let secret: SquareSecret
      const warnings: string[] = []
      if (code) {
        if (!opts.clientId || !opts.clientSecret) throw new ConnectorError('invalid_input', 'Square OAuth is not configured', { provider: 'square' })
        const t = await client.token(env, {
          client_id: opts.clientId,
          client_secret: opts.clientSecret,
          code,
          grant_type: 'authorization_code',
          ...(str(input.redirectUri) ? { redirect_uri: str(input.redirectUri) as string } : {}),
        })
        secret = tokenSecret(t)
      } else if (personal) {
        if (opts.hosted) throw new ConnectorError('invalid_input', SQUARE_PERSONAL_TOKEN_REFUSED, { provider: 'square', forUser: true })
        if (!/^[A-Za-z0-9_-]{20,}$/.test(personal)) throw new ConnectorError('invalid_input', 'that does not look like a Square access token', { provider: 'square' })
        secret = { kind: 'personal', accessToken: personal }
        warnings.push(SQUARE_PERSONAL_TOKEN_WARNING)
      } else {
        throw new ConnectorError('invalid_input', 'code (OAuth) or accessToken (personal access token) is required', { provider: 'square' })
      }
      // One harmless read proves the token and tells us which seller this is. A pasted token works only in the
      // environment that issued it: when none was chosen and this one refuses it, the other is tried (a sandbox token
      // pasted on a server that defaults to production just works).
      const whoAmI = (e: SquareEnv) => client.get<{ merchant?: SquareMerchant }>(e, secret.accessToken, '/v2/merchants/me')
      let me: { merchant?: SquareMerchant }
      try {
        me = await whoAmI(env)
      } catch (e) {
        if (!(personal && input.env === undefined && e instanceof ConnectorError && e.kind === 'auth')) throw e
        const other: SquareEnv = env === 'production' ? 'sandbox' : 'production'
        me = await whoAmI(other).catch(() => {
          throw e
        })
        env = other
      }
      if (!me.merchant?.id) throw new ConnectorError('permanent', 'Square did not return the merchant', { provider: 'square' })
      const config: SquareConfig = {
        env,
        merchantId: me.merchant.id,
        warnings,
        ...(me.merchant.business_name ? { businessName: me.merchant.business_name.slice(0, 80) } : {}),
      }
      return { secret, config: { ...config } }
    },

    async sync(conn, cursor) {
      const state = codec.decode(cursor) ?? fresh(null, null, null)
      const { secret, updated } = await usableSecret(conn)
      if (updated) await deps.saveSecret?.(conn.id, updated)
      const page = await step(conn, secret.accessToken, state)
      // A personal token has full access: say so on the connection at the end of every sync until it's switched.
      const full = secret.kind === 'personal' && !page.hasMore ? (opts.hosted ? SQUARE_PERSONAL_TOKEN_HOSTED_WARNING : SQUARE_PERSONAL_TOKEN_WARNING) : undefined
      const out = full ? { ...page, warnings: [...(page.warnings ?? []), full] } : page
      return updated ? { ...out, updatedSecret: updated } : out
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        const { secret } = await usableSecret(conn)
        await client.get(configOf(conn).env, secret.accessToken, '/v2/merchants/me')
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },
  }
}
