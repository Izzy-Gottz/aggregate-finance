import { AsyncLocalStorage } from 'node:async_hooks'
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose'
import type { Kysely } from 'kysely'
import { ownerOf, newId, nowIso, type CoreTables, withBypass } from '@agfn/db'

/** What S7 (packages/mcp) needs to authenticate an OAuth bearer token. Agent keys are verified by S7 itself. */
export interface VerifiedAccessToken {
  grantId: string
  personId: string
  workspaceId: string
  clientId: string
  clientName: string
  scopes: string[]
  expiresAt: number
}

export interface McpTokenVerifier {
  issuer: string
  verifyAccessToken(token: string, resource: string): Promise<VerifiedAccessToken | null>
}

/** Grant lookup provided by S7, so the verifier can resolve workspace and reject revoked/expired grants. */
export type GrantLookup = (grantId: string) => Promise<{ workspaceId: string; personId: string; revokedAt: string | null; expiresAt: string | null; clientName?: string } | null>

export interface McpVerifierDeps {
  db: Kysely<CoreTables>
  issuer: string
  /** Returns the current JWKS (auth.api.getJwks()). Cached for jwksTtlMs. */
  getJwks: () => Promise<JSONWebKeySet>
  getGrant: GrantLookup
  jwksTtlMs?: number
}

export function createMcpTokenVerifier(deps: McpVerifierDeps): McpTokenVerifier {
  let cached: { set: ReturnType<typeof createLocalJWKSet>; at: number } | undefined
  const ttl = deps.jwksTtlMs ?? 5 * 60_000

  async function keySet(force = false) {
    if (!cached || force || Date.now() - cached.at > ttl) cached = { set: createLocalJWKSet(await deps.getJwks()), at: Date.now() }
    return cached.set
  }

  async function verify(token: string, resource: string, retry: boolean): Promise<VerifiedAccessToken | null> {
    try {
      const { payload } = await jwtVerify(token, await keySet(retry), { issuer: deps.issuer, audience: resource, clockTolerance: 5 })
      const grantId = typeof payload.grant_id === 'string' ? payload.grant_id : null
      const sub = typeof payload.sub === 'string' ? payload.sub : null
      if (!grantId || !sub || typeof payload.exp !== 'number') return null
      // Before the workspace is known: the grant row (tenant table) is found by id, across workspaces.
      const grant = await withBypass('mcp:verify-token', () => deps.getGrant(grantId))
      if (!grant || grant.revokedAt || (grant.expiresAt && grant.expiresAt <= nowIso())) return null
      // The token's user must still be the grant's person.
      const person = await withBypass('mcp:verify-person', () => deps.db.selectFrom('people').select('id').where('auth_user_id', '=', sub).executeTakeFirst())
      if (!person || person.id !== grant.personId) return null
      const clientId = String(payload.client_id ?? payload.azp ?? '')
      return {
        grantId,
        personId: grant.personId,
        workspaceId: grant.workspaceId,
        clientId,
        clientName: grant.clientName ?? clientId,
        scopes: String(payload.scope ?? '').split(' ').filter(Boolean),
        expiresAt: payload.exp,
      }
    } catch (err) {
      // Key rotation: refresh the JWKS once on an unknown key id.
      if (!retry && err instanceof Error && /no applicable key|JWKSNoMatchingKey/i.test(err.name + err.message)) return verify(token, resource, true)
      return null
    }
  }

  return { issuer: deps.issuer, verifyAccessToken: (token, resource) => verify(token, resource, false) }
}

/**
 * The OAuth request being handled: which client, and which step. Better Auth's postLogin hooks don't receive the
 * client, so createAuth captures it per request (authorize: the client_id query; continue and consent: the signed
 * oauth_query, which Better Auth verifies itself before using the same client_id).
 */
export interface OauthRequestContext {
  clientId: string | null
  step: 'authorize' | 'continue' | 'consent' | 'other'
  accept: boolean
  /** Run after the request completes successfully (e.g. consuming the pending grant). */
  after: Array<() => Promise<void>>
}
const oauthRequest = new AsyncLocalStorage<OauthRequestContext>()

export function currentOauthRequest(): OauthRequestContext | undefined {
  return oauthRequest.getStore()
}

export async function oauthContextFromRequest(req: Request): Promise<OauthRequestContext> {
  const url = new URL(req.url)
  const path = url.pathname
  if (path.endsWith('/oauth2/authorize')) return { clientId: url.searchParams.get('client_id'), step: 'authorize', accept: false, after: [] }
  const step = path.endsWith('/oauth2/continue') ? 'continue' : path.endsWith('/oauth2/consent') ? 'consent' : 'other'
  if (step === 'other' || req.method !== 'POST') return { clientId: null, step, accept: false, after: [] }
  let body: { oauth_query?: unknown; accept?: unknown } = {}
  try {
    body = (await req.clone().json()) as typeof body
  } catch {
    /* not JSON: Better Auth will reject it */
  }
  const q = typeof body.oauth_query === 'string' ? new URLSearchParams(body.oauth_query) : null
  return { clientId: q?.get('client_id') ?? null, step, accept: body.accept === true, after: [] }
}

export async function withOauthRequest<T>(req: Request, fn: () => Promise<T>): Promise<T> {
  const ctx = await oauthContextFromRequest(req)
  const out = await oauthRequest.run(ctx, fn)
  const ok = !(out instanceof Response) || out.status < 400
  if (ok) for (const f of ctx.after) await f()
  return out
}

/**
 * The grant a person chose on the control-sentence step, per (session, OAuth client). Better Auth binds it as the
 * consent reference id. It is consumed when consent is accepted, and only ever returned for the client it was made
 * for, which is checked again against the grant's own client_id.
 */
export function createPendingGrants(db: Kysely<CoreTables>) {
  const anyDb = db as unknown as Kysely<Record<string, Record<string, unknown>>>
  const grantClient = async (grantId: string) => ((await anyDb.selectFrom('grants').select('client_id').where('id', '=', grantId).executeTakeFirst().catch(() => undefined)) as { client_id?: string } | undefined)?.client_id
  return {
    async set(sessionId: string, clientId: string, personId: string, grantId: string, ttlMs = 15 * 60_000): Promise<void> {
      const row = { session_id: sessionId, client_id: clientId, grant_id: grantId, person_id: personId, expires_at: new Date(Date.now() + ttlMs).toISOString(), created_at: nowIso() }
      await ownerOf(db).insertInto('oauth_pending_grants').values(row).onConflict((oc) => oc.columns(['session_id', 'client_id']).doUpdateSet({ grant_id: grantId, person_id: personId, expires_at: row.expires_at })).execute()
    },
    /** The grant for this session and client, or undefined. `consume` deletes it in the same statement. */
    async get(sessionId: string, clientId: string, opts: { consume?: boolean } = {}): Promise<string | undefined> {
      const now = nowIso()
      const r = opts.consume
        ? await ownerOf(db).deleteFrom('oauth_pending_grants').where('session_id', '=', sessionId).where('client_id', '=', clientId).where('expires_at', '>', now).returning(['grant_id']).executeTakeFirst()
        : await ownerOf(db).selectFrom('oauth_pending_grants').select(['grant_id']).where('session_id', '=', sessionId).where('client_id', '=', clientId).where('expires_at', '>', now).executeTakeFirst()
      const grantId = (r as { grant_id?: string } | undefined)?.grant_id
      if (!grantId) return undefined
      // Belt and braces: the grant itself must have been made for this client (MCP grants table, when installed).
      const owner = await grantClient(grantId)
      if (owner !== undefined && owner !== clientId) return undefined
      return grantId
    },
    async clear(sessionId: string, clientId?: string): Promise<void> {
      let q = ownerOf(db).deleteFrom('oauth_pending_grants').where('session_id', '=', sessionId)
      if (clientId) q = q.where('client_id', '=', clientId)
      await q.execute()
    },
  }
}

/** Passkey re-check tracking (MASTER.md §9: re-check within 10 minutes before adding a bank or AI access). */
export function createReauth(db: Kysely<CoreTables>) {
  return {
    async record(personId: string, method: 'passkey' | 'magic_link' | 'social' | 'email_link'): Promise<void> {
      await ownerOf(db).insertInto('reauth_events').values({ id: newId(), person_id: personId, method, at: nowIso() }).execute()
    },
    async requireRecentPasskey(personId: string, withinMs: number): Promise<boolean> {
      const since = new Date(Date.now() - withinMs).toISOString()
      // The one-time email link (apps/server/src/recheck.ts) is the fallback for a passkey that isn't on this device.
      const r = await ownerOf(db).selectFrom('reauth_events').select('id').where('person_id', '=', personId).where('method', 'in', ['passkey', 'email_link']).where('at', '>=', since).executeTakeFirst()
      return !!r
    },
    /** People without any passkey yet fall back to a fresh sign-in of any kind. */
    async requireRecentAuth(personId: string, withinMs: number): Promise<boolean> {
      const since = new Date(Date.now() - withinMs).toISOString()
      const r = await ownerOf(db).selectFrom('reauth_events').select('id').where('person_id', '=', personId).where('at', '>=', since).executeTakeFirst()
      return !!r
    },
  }
}
