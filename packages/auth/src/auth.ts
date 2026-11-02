import { AsyncLocalStorage } from 'node:async_hooks'
import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import { getMigrations } from 'better-auth/db/migration'
import { magicLink } from 'better-auth/plugins/magic-link'
import { jwt } from 'better-auth/plugins/jwt'
import { passkey } from '@better-auth/passkey'
import { currentOauthRequest, withOauthRequest } from './mcp-auth.ts'
import { oauthProvider, type ClientMetadataResourceFetch } from '@better-auth/oauth-provider'
import { cimd } from '@better-auth/cimd'
import { fetchClientMetadataResource } from '@better-auth/cimd/node'
import type { Kysely } from 'kysely'
import { ownerOf, newId, nowIso, withBypass, type CoreTables, type DbKind } from '@agfn/db'
import { inviteEmail, signInEmail } from './email.ts'
import { codeHash, newCode } from './email-codes.ts'

/** Sends sign-in links. S9 provides SMTP/Resend; tests and dev use an in-memory outbox. */
export interface Mailer {
  /** `html` is optional: transports that can't send it (the console) use `text`, which is always complete. */
  send(msg: { to: string; subject: string; text: string; html?: string }): Promise<void>
}

export interface AuthConfig {
  db: Kysely<CoreTables>
  /** Where Better Auth keeps sessions and tokens: the owner's side of RLS, because requests have no rights on them. */
  authDb?: Kysely<CoreTables>
  dbKind: DbKind
  /** Public origin, e.g. https://you.example (no trailing slash). */
  baseUrl: string
  /** 32+ random bytes; signs sessions and cookies. */
  secret: string
  mailer: Mailer
  appName?: string
  google?: { clientId: string; clientSecret: string }
  /** GitHub sign-in (the challenge deployment: players sign in with GitHub). */
  github?: { clientId: string; clientSecret: string }
  apple?: { clientId: string; clientSecret: string; appBundleIdentifier?: string }
  /** MCP resource URL(s) access tokens are issued for, e.g. https://you.example/mcp. */
  mcpResources: string[]
  /**
   * The grant the person chose for this OAuth client on our control-sentence step (per session AND client).
   * It is bound to the OAuth consent (reference id) and put into access tokens. `consume` is set when consent is accepted.
   */
  pendingGrant: (sessionId: string, clientId: string, opts?: { consume?: boolean }) => Promise<string | undefined>
  /** Path of the "control sentence" step in the web app. */
  consentPath?: string
  loginPath?: string
  /**
   * The one header your proxy sets to the real client IP and that clients can't forge, e.g. `fly-client-ip` (Fly.io)
   * or `cf-connecting-ip` (behind Cloudflare). Unset: IPs aren't trusted and rate limits share one bucket per path.
   * Never x-forwarded-for: its first hop is whatever the client sent.
   */
  clientIpHeader?: string
  /**
   * Client ID Metadata Documents (AGFN_OAUTH_CIMD=1): an AI client may use an https URL as its client_id instead of
   * registering. The document there is fetched (DNS resolved once, address pinned, private hosts and redirects refused),
   * validated, cached for an hour, and its redirect_uris must match exactly. Dynamic registration is unchanged. `fetch`
   * replaces the transport in tests only.
   */
  cimd?: { fetch?: ClientMetadataResourceFetch }
  /**
   * After a login identity first maps to a person (a new person, or an invited one signing in for the first time), with
   * the sign-up request's headers. The server records creator-link attributions here. Errors are logged, never thrown.
   */
  onPersonCreated?: (personId: string, headers: Headers | undefined) => Promise<void>
}

/**
 * Invite wording only when the link's callbackURL names a server-side invite record for this exact email
 * (written by POST /api/people). Anyone can request a magic link with any callbackURL, so nothing in the URL itself
 * is trusted: names come from the record.
 */
export async function inviteForLink(db: Kysely<CoreTables>, url: string, email: string): Promise<{ inviterName: string; workspaceName: string } | null> {
  let id: string | null = null
  try {
    const cb = new URL(url).searchParams.get('callbackURL')
    if (cb) id = new URL(cb, 'http://x').searchParams.get('invite')
  } catch {
    return null
  }
  if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) return null
  // Found by its id before any workspace is known (row-level security: a narrow named bypass).
  const row = await withBypass('auth:invite', () => db.selectFrom('settings').select('value_json').where('key', '=', `invite:${id}`).executeTakeFirst())
  if (!row) return null
  const v = JSON.parse(row.value_json) as { email: string; inviterName: string; workspaceName: string; expiresAt: string }
  if (v.email.toLowerCase() !== email.toLowerCase() || Date.parse(v.expiresAt) <= Date.now()) return null
  return { inviterName: v.inviterName, workspaceName: v.workspaceName }
}

export const AUTH_MODEL_NAMES = {
  user: 'auth_user',
  session: 'auth_session',
  account: 'auth_account',
  verification: 'auth_verification',
} as const

// Two false alarms from Better Auth's schema check: Postgres int8 for numbers, and SQLite TEXT for string[] (arrays
// are stored as JSON text, which is how Better Auth's own adapter writes them).
const INT8_FALSE_ALARM = /^Field \w+ in table \w+ has a different type in the database\. Expected (number but got int8|string\[\] but got (TEXT|text))\.$/

/** Better Auth's log output, as its default logger writes it, minus the int8 false alarm (see `logger` below). */
export function logAuth(level: 'debug' | 'info' | 'warn' | 'error', message: string, ...args: unknown[]): void {
  if (level === 'warn' && INT8_FALSE_ALARM.test(message)) return
  const line = `[Better Auth]: ${message}`
  if (level === 'error') console.error(line, ...args)
  else if (level === 'warn') console.warn(line, ...args)
  else console.log(line, ...args)
}

export function authOptions(cfg: AuthConfig) {
  const consentPage = cfg.consentPath ?? '/#/connect-ai/consent'
  const loginPage = cfg.loginPath ?? '/#/sign-in'
  const socialProviders: NonNullable<BetterAuthOptions['socialProviders']> = {}
  if (cfg.google) socialProviders.google = { clientId: cfg.google.clientId, clientSecret: cfg.google.clientSecret }
  if (cfg.github) socialProviders.github = { clientId: cfg.github.clientId, clientSecret: cfg.github.clientSecret }
  if (cfg.apple) {
    socialProviders.apple = {
      clientId: cfg.apple.clientId,
      clientSecret: cfg.apple.clientSecret,
      ...(cfg.apple.appBundleIdentifier ? { appBundleIdentifier: cfg.apple.appBundleIdentifier } : {}),
    }
  }
  const rpID = new URL(cfg.baseUrl).hostname

  const options = {
    appName: cfg.appName ?? 'Aggregate',
    baseURL: cfg.baseUrl,
    basePath: '/api/auth',
    secret: cfg.secret,
    database: { db: cfg.authDb ?? cfg.db, type: cfg.dbKind === 'postgres' ? 'postgres' : 'sqlite' },
    user: { modelName: AUTH_MODEL_NAMES.user },
    session: {
      modelName: AUTH_MODEL_NAMES.session,
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    account: { modelName: AUTH_MODEL_NAMES.account, accountLinking: { enabled: true, trustedProviders: ['google', 'apple'] } },
    verification: { modelName: AUTH_MODEL_NAMES.verification },
    emailAndPassword: { enabled: false },
    socialProviders,
    trustedOrigins: [cfg.baseUrl],
    advanced: {
      useSecureCookies: cfg.baseUrl.startsWith('https://'),
      database: { generateId: () => newId() },
      ipAddress: cfg.clientIpHeader ? { ipAddressHeaders: [cfg.clientIpHeader.toLowerCase()] } : { disableIpTracking: true },
    },
    rateLimit: { enabled: true, window: 60, max: 60, storage: 'database' },
    telemetry: { enabled: false },
    // Better Auth's migration check compares column types by name, and its postgres list for "number" has "bigint" but
    // not "int8", which is what introspection reports for a bigint column (rateLimit.lastRequest). So every boot after
    // the first logs "Field lastRequest in table rateLimit has a different type": a false alarm. The column is right
    // (ms timestamps need 64 bits). Drop exactly that message; everything else is logged as before.
    logger: { log: logAuth },
    hooks: {
      // Every fresh sign-in counts as a re-check; passkey ones satisfy requireRecentPasskey.
      after: createAuthMiddleware(async (ctx) => {
        // Adding your first passkey right after signing in counts as a passkey check, so "add a passkey" flows straight
        // into connecting a bank. Later passkeys don't: a stolen session must not be able to mint its own re-check.
        if (ctx.path.startsWith('/passkey/verify-registration')) {
          const uid = ctx.context.session?.user.id
          if (!uid) return
          const person = await cfg.db.selectFrom('people').select('id').where('auth_user_id', '=', uid).executeTakeFirst()
          if (!person) return
          const anyDb = cfg.db as unknown as Kysely<Record<string, Record<string, unknown>>>
          const count = (await ownerOf(anyDb).selectFrom('passkey').select((eb) => eb.fn.countAll().as('n')).where('userId', '=', uid).executeTakeFirst()) as { n: number | string } | undefined
          const recent = await ownerOf(cfg.db).selectFrom('reauth_events').select('id').where('person_id', '=', person.id).where('at', '>=', new Date(Date.now() - 10 * 60_000).toISOString()).executeTakeFirst()
          if (Number(count?.n ?? 0) === 1 && recent) await ownerOf(cfg.db).insertInto('reauth_events').values({ id: newId(), person_id: person.id, method: 'passkey', at: nowIso() }).execute()
          return
        }
        const method = ctx.path.startsWith('/passkey/verify-authentication')
          ? 'passkey'
          : ctx.path.startsWith('/magic-link/verify')
            ? 'magic_link'
            : ctx.path.startsWith('/callback/')
              ? 'social'
              : null
        const userId = ctx.context.newSession?.user.id
        if (!method || !userId) return
        const person = await cfg.db.selectFrom('people').select('id').where('auth_user_id', '=', userId).executeTakeFirst()
        if (person) await ownerOf(cfg.db).insertInto('reauth_events').values({ id: newId(), person_id: person.id, method, at: nowIso() }).execute()
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // Every login identity maps to exactly one person (people.auth_user_id).
          after: async (user, ctx) => {
            const headers = (ctx as { headers?: Headers; request?: Request } | undefined)?.headers ?? (ctx as { request?: Request } | undefined)?.request?.headers
            const created = async (personId: string) => {
              await cfg.onPersonCreated?.(personId, headers).catch((err: unknown) => console.warn('[agfn] after sign-up hook failed', { error: err instanceof Error ? err.message : String(err) }))
            }
            const existing = await cfg.db.selectFrom('people').select('id').where('email', '=', user.email.toLowerCase()).executeTakeFirst()
            if (existing) {
              const linked = await cfg.db.updateTable('people').set({ auth_user_id: user.id }).where('id', '=', existing.id).where('auth_user_id', 'is', null).executeTakeFirst()
              if (Number(linked.numUpdatedRows ?? 0) > 0) await created(existing.id)
              return
            }
            const id = newId()
            await cfg.db
              .insertInto('people')
              .values({ id, auth_user_id: user.id, name: user.name || user.email.split('@')[0] || 'You', email: user.email.toLowerCase(), created_at: nowIso() })
              .execute()
            await created(id)
          },
        },
      },
    },
    plugins: [
      passkey({ rpID, rpName: cfg.appName ?? 'Aggregate', origin: cfg.baseUrl }),
      magicLink({
        expiresIn: 60 * 10,
        // Better Auth's own default is 5 a minute per IP (asking for a link and opening it), which turns away the 6th
        // person behind one shared IP (office NAT, carrier CGNAT, conference Wi-Fi). app.ts keeps the real limits
        // (per address 5 / 15 min, per IP AGFN_SIGNIN_IP_LIMIT / 15 min), which also guard the email quota.
        rateLimit: { window: 60, max: 20 },
        disableSignUp: false,
        sendMagicLink: async ({ email, url }) => {
          // A reviewer access link signs in through this same flow, but the link is handed back, never emailed.
          const capture = magicLinkCapture.getStore()
          if (capture && email.toLowerCase().endsWith(`@${REVIEWER_EMAIL_DOMAIN}`)) {
            capture.url = url
            return
          }
          const app = cfg.appName ?? 'Aggregate'
          const invite = await inviteForLink(cfg.db, url, email)
          if (invite) {
            await cfg.mailer.send({ to: email, ...inviteEmail({ url, inviterName: invite.inviterName, workspaceName: invite.workspaceName, baseUrl: cfg.baseUrl, app }) })
            return
          }
          // Asked for from a sign-in page (app.ts sets signInPending): the same email carries a code for that page.
          const pending = signInPending.getStore()
          const token = new URL(url).searchParams.get('token')
          if (pending && token) {
            const id = newId()
            const code = newCode()
            const now = Date.now()
            await (ownerOf(cfg.db)
              .insertInto('signin_codes')
              .values({ id, email: email.toLowerCase(), code_hash: codeHash(id, code), nonce_hash: pending.nonceHash, link_token: token, attempts: 0, created_at: new Date(now).toISOString(), expires_at: new Date(now + 10 * 60_000).toISOString(), used_at: null })
              .execute())
            await cfg.mailer.send({ to: email, ...signInEmail({ url, code, app }) })
            return
          }
          await cfg.mailer.send({ to: email, ...signInEmail({ url, app }) })
        },
      }),
      jwt({ jwt: { issuer: cfg.baseUrl, expirationTime: '1h' } }),
      oauthProvider({
        loginPage,
        consentPage,
        scopes: ['openid', 'profile', 'email', 'offline_access', 'finance:read', 'records:write'],
        resources: cfg.mcpResources,
        enforcePerClientResources: false,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationRequirePKCE: true,
        clientRegistrationDefaultScopes: ['openid', 'offline_access', 'finance:read'],
        clientRegistrationAllowedScopes: ['openid', 'profile', 'email', 'offline_access', 'finance:read', 'records:write'],
        // How long the signed authorization query lasts from sign-in to Allow (and the single-use, PKCE-bound code
        // after it). Better Auth's default is 10 minutes, which failed anyone who read the consent screen slowly,
        // directory reviewers included; the library has one setting for both.
        codeExpiresIn: 30 * 60,
        accessTokenExpiresIn: 60 * 60,
        refreshTokenExpiresIn: 60 * 60 * 24 * 30,
        storeTokens: 'hashed',
        storeClientSecret: 'hashed',
        // After sign-in, the person must choose what this AI may see (the control sentence) before consent completes.
        postLogin: {
          page: consentPage,
          // Only a grant chosen for THIS client counts; without a known client, always ask (fail closed).
          shouldRedirect: async ({ session }) => {
            const clientId = currentOauthRequest()?.clientId
            return !clientId || (await cfg.pendingGrant(session.id, clientId)) === undefined
          },
          consentReferenceId: async ({ session }) => {
            const req = currentOauthRequest()
            if (!req?.clientId) throw new Error('No grant chosen for this AI connection')
            const grantId = await cfg.pendingGrant(session.id, req.clientId)
            if (!grantId) throw new Error('No grant chosen for this AI connection')
            // Consumed once the accepted consent request finishes (the hook runs more than once per request), so it
            // can't be reused by a later authorization.
            if (req.step === 'consent' && req.accept) req.after.push(() => cfg.pendingGrant(session.id, req.clientId!, { consume: true }).then(() => undefined))
            return grantId
          },
        },
        customAccessTokenClaims: ({ referenceId }) => (referenceId ? { grant_id: referenceId } : {}),
      }),
      ...(cfg.cimd
        ? [
            cimd({
              fetchClientMetadataResource: cfg.cimd.fetch ?? fetchClientMetadataResource,
              // The MCP profile: client_name and redirect_uris are required.
              metadataProfile: 'mcp-2026-07-28',
              metadataRevalidationInterval: '60m',
              // A client_id is any URL anyone can send us, so fetches are budgeted well below the defaults.
              metadataFetchPolicy: { minimumFetchInterval: 10, maximumConcurrentFetches: 8, maximumConcurrentFetchesPerOrigin: 2, maximumFetchesPerMinute: 60, maximumFetchesPerOriginPerMinute: 10 },
              maxCacheEntries: 500,
            }),
          ]
        : []),
    ],
  } satisfies BetterAuthOptions
  return options
}

/** A redirect URI only a native app uses: http on a loopback host, or a custom scheme (com.example.app:/cb). */
export function isNativeRedirect(uri: string): boolean {
  try {
    const u = new URL(uri)
    if (u.protocol === 'https:') return false
    if (u.protocol === 'http:') return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
    return /^[a-z][a-z0-9+.-]*:$/i.test(u.protocol) && !['javascript:', 'data:', 'file:', 'vbscript:'].includes(u.protocol)
  } catch {
    return false
  }
}

/**
 * Dynamic client registration without application_type defaults to "web", which refuses loopback redirects with a
 * misleading error. When every redirect URI is native-only, default to "native" (an explicit value is never changed).
 */
export async function defaultNativeRegistration(req: Request): Promise<Request> {
  if (req.method !== 'POST' || !new URL(req.url).pathname.endsWith('/oauth2/register')) return req
  let body: Record<string, unknown>
  try {
    body = (await req.clone().json()) as Record<string, unknown>
  } catch {
    return req
  }
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : []
  if (body.application_type !== undefined || !uris.length || !uris.every(isNativeRedirect)) return req
  return new Request(req, { body: JSON.stringify({ ...body, application_type: 'native' }) })
}

/** Reserved domain for reviewer accounts: never deliverable, never invitable, never a real person. */
export const REVIEWER_EMAIL_DOMAIN = 'reviewers.aggregate.invalid'
const magicLinkCapture = new AsyncLocalStorage<{ url?: string }>()

/** Set around a sign-in request from a browser: the hashed nonce its cookie carries, so the emailed code works only there. */
export const signInPending = new AsyncLocalStorage<{ nonceHash: string }>()

/** Run fn, returning the magic link Better Auth would have emailed to a reviewer address (reviewer access only). */
export async function captureReviewerMagicLink(fn: () => Promise<unknown>): Promise<string | undefined> {
  const box: { url?: string } = {}
  await magicLinkCapture.run(box, fn)
  return box.url
}

export function createAuth(cfg: AuthConfig) {
  const auth = betterAuth(authOptions(cfg))
  const handler = auth.handler
  // Every request carries its OAuth client (see currentOauthRequest), so pending grants are matched per client.
  return Object.assign(auth, {
    handler: async (raw: Request) => {
      const req = await defaultNativeRegistration(raw)
      return withOauthRequest(req, () => handler(req))
    },
  })
}

export type Auth = ReturnType<typeof createAuth>

/** Creates/updates Better Auth's own tables (auth_*, passkey, jwks, oauth*). Run after migrateToLatest. */
export async function migrateAuth(cfg: AuthConfig): Promise<void> {
  const { runMigrations } = await getMigrations(authOptions(cfg))
  await runMigrations()
}

export { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from '@better-auth/oauth-provider'
