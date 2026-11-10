// Patreon connector (read-only): members → subscription.upsert, for MRR, churn and movements.
//
// Not emitted, on purpose:
// - Earnings, payouts, fees. Patreon's API has no earnings endpoint, and payouts reach the bank as deposits already, so
//   nothing is posted to the ledger and revenue is never derived from members.
// - Names, emails, addresses (see client.ts): no such scope or field is requested.
// - Per-creation campaigns (is_monthly false): they charge per post, so they have no MRR. Skipped with a warning.
//
// Auth: Patreon sign-in with Aggregate's client (identity, campaigns, campaigns.members), or, self-hosted, a Creator's
// Access Token. Patreon's tokens are "single use" pairs with an expires_in: they renew a day early on sync and the new
// pair is saved before any read. A pasted token can't renew (that takes the client's secret), so it ends in a reconnect.
//
// A sync cycle: campaigns → each campaign's members, one page at a time. Patreon has no updated-since filter, so every
// cycle walks everyone. A cancellation arrives as patron_status former_patron. A member Patreon stops listing altogether
// isn't seen by anything: the ledger keeps a subscription's last state (listing.complete has no subscription kind).

import type { ConnectBegin, ConnectBeginContext, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, SyncResult } from '@agfn/contracts'
import { ConnectorError, OAuthClient, cursorCodec, healthFromError, isRecord, normalizeCurrency, requireSecret, str, systemClock, type ConnectorDeps, type OAuthTokens } from '@agfn/connector-sdk'
import { PATREON_AUTHORIZE_URL, PATREON_CAMPAIGN_FIELDS, PATREON_MEMBER_FIELDS, PATREON_SCOPES, PATREON_TOKEN_URL, PatreonClient } from './client.ts'
import { mapMember, rawMember, type PatreonCampaignRef } from './map.ts'
import type { PatreonCampaign, PatreonList, PatreonMember } from './types.ts'

const PROVIDER = 'patreon'
/** Renew this long before the access token runs out. */
const RENEW_EARLY_MS = 86_400_000
/** The docs: 1000 a page "for most endpoints", and it "might lower depending on the relationships and data". */
const PAGE = 500

/** A pasted Creator's Access Token, or the OAuth pair from Aggregate's Patreon client. */
export type PatreonSecret = { token: string } | { tokens: OAuthTokens }

export interface PatreonConnectorOptions {
  /** Aggregate's Patreon client. Without it, only a pasted Creator's Access Token (self-hosted). */
  oauth?: { clientId: string; clientSecret: string; redirectUri: string }
  /** Hosted service: Patreon sign-in only. */
  hosted?: boolean
}

export const PATREON_NOT_SET_UP = 'Patreon sign-in isn’t set up on this server yet.'
export const PATREON_HOSTED_TOKEN_REFUSED = 'Connect Patreon with “Sign in with Patreon”.'
export const PATREON_TOKEN_NOT_REVOKED = 'In Patreon, go to the Clients & API Keys page → Delete the client.'
export const PATREON_APP_NOT_REVOKED = 'In Patreon, go to Settings → More → Connected Apps → Remove Aggregate.'
export const PATREON_TOKEN_WARNING = 'A Creator’s Access Token expires and can’t renew from here. When Patreon stops accepting it, refresh it on your client’s page and connect again.'

/** Per-sync warnings (final page of a cycle). */
export const patreonPerCreationWarning = (n: number) =>
  `${n} Patreon ${n === 1 ? 'campaign charges' : 'campaigns charge'} per post rather than per month, so ${n === 1 ? 'it has' : 'they have'} no MRR and ${n === 1 ? 'isn’t' : 'aren’t'} counted.`
export const patreonNoCurrencyWarning = (n: number) => `Patreon didn’t give a currency for ${n} ${n === 1 ? 'campaign' : 'campaigns'}, so ${n === 1 ? 'it isn’t' : 'they aren’t'} counted.`
export const patreonNonMonthlyWarning = (n: number) =>
  `${n} Patreon ${n === 1 ? 'pledge is' : 'pledges are'} billed annually or less often than monthly. ${n === 1 ? 'Its' : 'Their'} amount is taken as per charge and divided down to a month, which Patreon’s API docs don’t state outright; check against your Patreon dashboard.`
export const patreonCadenceUnknownWarning = (n: number) => `${n} Patreon ${n === 1 ? 'pledge has' : 'pledges have'} no billing cadence, so ${n === 1 ? 'it is' : 'they are'} counted as monthly.`

interface PtCursor {
  stage: 'campaigns' | 'members'
  /** The campaigns this cycle reads, and the one being read. */
  campaigns: PatreonCampaignRef[]
  at: number
  /** Patreon's next cursor within that campaign (null = first page). */
  page: string | null
  perCreation: number
  noCurrency: number
  nonMonthly: number
  noCadence: number
}

const FRESH: PtCursor = { stage: 'campaigns', campaigns: [], at: 0, page: null, perCreation: 0, noCurrency: 0, nonMonthly: 0, noCadence: 0 }

const isCursor = (v: unknown): v is PtCursor =>
  isRecord(v) && (v.stage === 'campaigns' || v.stage === 'members') && Array.isArray(v.campaigns) && typeof v.at === 'number' && (v.page === null || typeof v.page === 'string') && typeof v.perCreation === 'number' && typeof v.noCurrency === 'number' && typeof v.nonMonthly === 'number' && typeof v.noCadence === 'number'

const isSecret = (s: unknown): s is PatreonSecret =>
  isRecord(s) && ((typeof s.token === 'string' && s.token.length >= 10) || (isRecord(s.tokens) && typeof s.tokens.accessToken === 'string'))

const campaignQuery = (extra: Record<string, string | number | undefined> = {}) => ({ 'fields[campaign]': PATREON_CAMPAIGN_FIELDS.join(','), 'json-api-use-default-includes': 'false', ...extra })

const finalWarnings = (s: PtCursor): string[] => [
  ...(s.perCreation ? [patreonPerCreationWarning(s.perCreation)] : []),
  ...(s.noCurrency ? [patreonNoCurrencyWarning(s.noCurrency)] : []),
  ...(s.nonMonthly ? [patreonNonMonthlyWarning(s.nonMonthly)] : []),
  ...(s.noCadence ? [patreonCadenceUnknownWarning(s.noCadence)] : []),
]

export interface PatreonConnector extends Connector {
  begin(ctx: Pick<ConnectBeginContext, 'state'>): Promise<ConnectBegin>
}

export function createPatreonConnector(opts: PatreonConnectorOptions, deps: ConnectorDeps): PatreonConnector {
  const clock = deps.clock ?? systemClock
  const codec = cursorCodec<PtCursor>(PROVIDER, 1, isCursor)
  const oauth = opts.oauth
    ? new OAuthClient({
        provider: PROVIDER,
        authorizeUrl: PATREON_AUTHORIZE_URL,
        tokenUrl: PATREON_TOKEN_URL,
        clientId: opts.oauth.clientId,
        clientSecret: opts.oauth.clientSecret,
        redirectUri: opts.oauth.redirectUri,
        scopes: PATREON_SCOPES,
        clientAuth: 'body',
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        clock,
      })
    : undefined

  const description: ConnectorDescription = {
    key: PROVIDER,
    name: 'Patreon',
    group: 'payments',
    provides: ['reports'],
    freshness: 'updates every few hours',
    auth: oauth ? 'oauth' : 'api_key',
  }

  /** A client for this connection, renewing OAuth tokens first (when asked) if they're close to running out. */
  async function clientFor(conn: ConnectionRef, renew: boolean): Promise<{ c: PatreonClient; renewed?: PatreonSecret }> {
    const secret = requireSecret(PROVIDER, conn.secret, isSecret)
    if ('token' in secret) return { c: new PatreonClient(secret.token, deps) }
    if (!renew) return { c: new PatreonClient(secret.tokens.accessToken, deps) }
    if (!oauth) throw new ConnectorError('auth', 'This Patreon connection used Aggregate’s Patreon sign-in, which isn’t set up here. Connect Patreon again.', { provider: PROVIDER, forUser: true })
    const { tokens, refreshed } = await oauth.ensureFresh(secret.tokens, RENEW_EARLY_MS)
    const renewed: PatreonSecret = { tokens }
    // Keep the new pair before any read can fail and strand it.
    if (refreshed) await deps.saveSecret?.(conn.id, renewed)
    return { c: new PatreonClient(tokens.accessToken, deps), ...(refreshed ? { renewed } : {}) }
  }

  async function campaignsPage(c: PatreonClient, s: PtCursor): Promise<PtCursor> {
    const out: PatreonCampaignRef[] = []
    let { perCreation, noCurrency } = s
    let page: string | null = null
    do {
      const res: PatreonList<PatreonCampaign> = await c.get('/campaigns', campaignQuery({ 'page[count]': PAGE, ...(page ? { 'page[cursor]': page } : {}) }))
      // A present JSON:API object with `data` omitted/empty is a real empty page; a null/non-object body (an empty
      // body, or the sign-in/error page the shared client rejects as non-JSON) is unreadable and must stop the sync.
      if (!isRecord(res as unknown)) throw new ConnectorError('transient', 'Patreon sent a response Aggregate couldn’t read, so this sync stopped. No totals were changed.', { provider: PROVIDER })
      const rows = res.data ?? []
      for (const row of rows) {
        const currency = row.attributes?.currency
        if (row.attributes?.is_monthly === false) perCreation++
        else if (!currency) noCurrency++
        else out.push({ id: row.id, currency: normalizeCurrency(currency) })
      }
      page = rows.length > 0 ? (res.meta?.pagination?.cursors?.next ?? null) : null
    } while (page)
    return { ...s, stage: 'members', campaigns: out, at: 0, page: null, perCreation, noCurrency }
  }

  async function membersPage(conn: ConnectionRef, c: PatreonClient, s: PtCursor, campaign: PatreonCampaignRef): Promise<{ events: NormalizedEvent[]; next: PtCursor }> {
    const res = await c.get<PatreonList<PatreonMember>>(`/campaigns/${encodeURIComponent(campaign.id)}/members`, {
      'fields[member]': PATREON_MEMBER_FIELDS.join(','),
      'json-api-use-default-includes': 'false',
      'page[count]': PAGE,
      ...(s.page ? { 'page[cursor]': s.page } : {}),
    })
    if (!isRecord(res as unknown)) throw new ConnectorError('transient', 'Patreon sent a response Aggregate couldn’t read, so this sync stopped. No totals were changed.', { provider: PROVIDER })
    const rows = res.data ?? []
    const nowIso = new Date(clock.now()).toISOString()
    const events: NormalizedEvent[] = []
    let { nonMonthly, noCadence } = s
    for (const m of rows) {
      const rawRef = await deps.raw.put(conn.id, 'patreon.member', m.id, rawMember(m, campaign.id))
      const mapped = mapMember(m, campaign, nowIso, conn.id, rawRef)
      if (!mapped) continue
      events.push(mapped.event)
      if (mapped.nonMonthly) nonMonthly++
      if (mapped.cadenceUnknown) noCadence++
    }
    const more = rows.length > 0 ? (res.meta?.pagination?.cursors?.next ?? null) : null
    return { events, next: more ? { ...s, page: more, nonMonthly, noCadence } : { ...s, at: s.at + 1, page: null, nonMonthly, noCadence } }
  }

  const probe = (c: PatreonClient) => c.get<PatreonList<PatreonCampaign>>('/campaigns', campaignQuery({ 'page[count]': 1 }))

  return {
    describe: () => description,

    /** Patreon's docs have no revoke call: access ends at Patreon. */
    async disconnect(conn) {
      return { notRevoked: isRecord(conn.secret) && 'token' in conn.secret ? PATREON_TOKEN_NOT_REVOKED : PATREON_APP_NOT_REVOKED }
    },

    async begin(ctx) {
      if (oauth) return { kind: 'oauth', url: oauth.authorizationUrl({ state: ctx.state }) }
      if (opts.hosted) throw new ConnectorError('invalid_input', PATREON_NOT_SET_UP, { provider: PROVIDER, forUser: true })
      return {
        kind: 'api_key',
        label: 'Patreon Creator’s Access Token',
        steps: [
          'Sign in to Patreon and open the Clients & API Keys page.',
          'Create a client named “Aggregate”, with API version 2.',
          'Copy its Creator’s Access Token and paste it here.',
        ],
        permissions: ['Aggregate only reads your campaigns and each member’s pledge amount and status, never names or emails.'],
        helpUrl: 'https://www.patreon.com/portal/registration/register-clients',
        placeholder: 'Creator’s Access Token',
      }
    },

    async connect(input) {
      const code = str(input.code)
      const pasted = str(input.token)?.trim() ?? str(input.accessToken)?.trim() ?? str(input.apiKey)?.trim()
      let secret: PatreonSecret
      let accessToken: string
      const warnings: string[] = []
      if (code) {
        if (!oauth) throw new ConnectorError('invalid_input', PATREON_NOT_SET_UP, { provider: PROVIDER, forUser: true })
        const tokens = await oauth.exchangeCode(code)
        const granted = tokens.scope?.split(/\s+/)
        const missing = granted ? PATREON_SCOPES.filter((s) => !granted.includes(s)) : []
        if (missing.length) throw new ConnectorError('invalid_input', `Patreon access was granted without ${missing.join(', ')}. Connect again and allow it.`, { provider: PROVIDER, forUser: true })
        secret = { tokens }
        accessToken = tokens.accessToken
      } else if (pasted) {
        if (opts.hosted) throw new ConnectorError('invalid_input', PATREON_HOSTED_TOKEN_REFUSED, { provider: PROVIDER, forUser: true })
        if (pasted.length < 10 || /\s/.test(pasted)) throw new ConnectorError('invalid_input', 'that does not look like a Patreon access token', { provider: PROVIDER })
        secret = { token: pasted }
        accessToken = pasted
        warnings.push(PATREON_TOKEN_WARNING)
      } else {
        throw new ConnectorError('invalid_input', 'code (Patreon sign-in) or token is required', { provider: PROVIDER })
      }
      const c = new PatreonClient(accessToken, deps)
      // No fields asked for: the id comes back and nothing else.
      const me = await c.get<{ data?: { id?: string } }>('/identity')
      const accountId = me.data?.id
      if (!accountId) throw new ConnectorError('permanent', 'Patreon did not return the account', { provider: PROVIDER })
      if (!(await probe(c)).data?.length) throw new ConnectorError('invalid_input', 'This Patreon account has no campaign to read.', { provider: PROVIDER, forUser: true })
      return { secret, config: { accountId, ...(warnings.length ? { warnings } : {}) } }
    },

    async sync(conn, cursor): Promise<SyncResult> {
      const { c, renewed } = await clientFor(conn, true)
      const extra = renewed ? { updatedSecret: renewed } : {}
      const s = codec.decode(cursor) ?? FRESH
      const finish = (last: PtCursor, events: NormalizedEvent[]): SyncResult => {
        const warnings = finalWarnings(last)
        return { events, cursor: codec.encode(FRESH), hasMore: false, ...(warnings.length ? { warnings } : {}), ...extra }
      }
      if (s.stage === 'campaigns') {
        const next = await campaignsPage(c, s)
        return next.campaigns.length ? { events: [], cursor: codec.encode(next), hasMore: true, ...extra } : finish(next, [])
      }
      const campaign = s.campaigns[s.at]
      if (!campaign) return finish(s, [])
      const { events, next } = await membersPage(conn, c, s, campaign)
      return next.at < next.campaigns.length ? { events, cursor: codec.encode(next), hasMore: true, ...extra } : finish(next, events)
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        const secret = requireSecret(PROVIDER, conn.secret, isSecret)
        // Never renews here (a single-use refresh token would have nowhere to go); it renews on the next sync.
        if ('tokens' in secret && secret.tokens.expiresAt !== undefined && secret.tokens.expiresAt <= clock.now() && secret.tokens.refreshToken) {
          return { status: 'ok', message: 'The access token renews on the next sync.' }
        }
        await probe((await clientFor(conn, false)).c)
        return { status: 'ok', lastSuccessAt: new Date(clock.now()).toISOString() }
      } catch (e) {
        return healthFromError(e)
      }
    },
  }
}
