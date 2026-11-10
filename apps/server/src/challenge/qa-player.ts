// A QA player for the challenge's dry run (docs/launch/challenge-ops.md step 5): a player account with its own made-up
// books and an MCP agent key, minted on the machine, so a tester can play every tier without a GitHub login. It
// exists only on the challenge deployment; the nightly reset treats it as a player (fresh books, keys revoked).

import { randomBytes } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { GrantShape } from '@agfn/contracts'
import { captureMagicLink } from '@agfn/auth'
import { newId, nowIso, withWorkspace, type CoreTables } from '@agfn/db'

export const CHALLENGE_QA_DOMAIN = 'challenge-qa.aggregate.invalid'
export const QA_KEY_MAX_DAYS = 7

export const isQaPlayer = (email: string) => email.toLowerCase().endsWith(`@${CHALLENGE_QA_DOMAIN}`)

export interface QaPlayerDeps {
  db: Kysely<CoreTables>
  buildDemo: (personId: string) => Promise<string>
  control: {
    proposeGrant(actor: { workspaceId: string; personId: string }, clientName: string): Promise<{ shape: GrantShape }>
    createAgentKey(actor: { workspaceId: string; personId: string }, input: { name: string; shape: GrantShape }): Promise<{ key: string; keyId: string }>
  }
  now?: () => Date
}

export async function mintQaPlayer(deps: QaPlayerDeps, opts: { label: string; days?: number; challenge: boolean }): Promise<{ email: string; workspaceId: string; key: string; keyId: string; expiresAt: string }> {
  if (!opts.challenge) throw new Error('QA players exist only on the challenge deployment (AGFN_CHALLENGE=1)')
  const days = opts.days ?? 2
  if (!Number.isInteger(days) || days < 1 || days > QA_KEY_MAX_DAYS) throw new Error(`days must be a whole number from 1 to ${QA_KEY_MAX_DAYS}`)
  const label = opts.label.trim().slice(0, 60)
  if (!label) throw new Error('give the QA player a label, e.g. "43 dry run"')
  const now = deps.now?.() ?? new Date()
  const personId = newId()
  const email = `qa-${randomBytes(6).toString('hex')}@${CHALLENGE_QA_DOMAIN}`
  await deps.db.insertInto('people').values({ id: personId, auth_user_id: null, name: `QA: ${label}`, email, created_at: nowIso() }).execute()
  const workspaceId = await deps.buildDemo(personId)
  const actor = { workspaceId, personId }
  // Minting it on the machine is this account's sign-in: its first AI connection asks for a fresh one.
  await deps.db.insertInto('reauth_events').values({ id: newId(), person_id: personId, method: 'social', at: now.toISOString() }).execute()
  const expiresAt = new Date(now.getTime() + days * 86_400_000).toISOString()
  // What a player gets by default, with writes on: tier C is about write tools called unasked.
  const { shape } = await withWorkspace(workspaceId, () => deps.control.proposeGrant(actor, label))
  const created = await withWorkspace(workspaceId, () => deps.control.createAgentKey(actor, { name: label, shape: { ...shape, entityIds: 'all', write: true, expiresAt } }))
  return { email, workspaceId, key: created.key, keyId: created.keyId, expiresAt }
}

/** The Better Auth surface a web session needs: sign a magic link in (captured, not emailed) and run its verify. */
interface AuthLike {
  api: { signInMagicLink(input: { body: { email: string; callbackURL: string }; headers: Headers }): Promise<unknown> }
  handler(req: Request): Promise<Response>
}

/**
 * Mint a browser session for a QA player, so 43 can run the web-route injection payloads the GitHub-only sign-in blocks.
 * Signs the player in through the ordinary magic-link flow, but captures the link instead of emailing it (its address is
 * `*.aggregate.invalid`, never deliverable) and runs Better Auth's verify server-side. Returns a Cookie header value
 * (the session cookies' name=value pairs) to paste into a browser or a request. Challenge only (the caller checks).
 */
export async function mintQaWebSession(deps: { auth: AuthLike; baseUrl: string }, email: string): Promise<string> {
  const base = deps.baseUrl.replace(/\/+$/, '')
  const link = await captureMagicLink(() => deps.auth.api.signInMagicLink({ body: { email, callbackURL: '/' }, headers: new Headers({ origin: base }) }))
  if (!link) throw new Error('could not mint a web session: no magic link was captured')
  const verify = await deps.auth.handler(new Request(link))
  const cookies = verify.headers.getSetCookie()
  if (!cookies.some((c) => c.includes('session_token'))) throw new Error('sign-in did not produce a session cookie')
  // name=value pairs only (drop attributes and any deletion cookie), ready to use as a Cookie: header.
  return cookies
    .map((c) => c.split(';')[0] ?? '')
    .filter((c) => c && !c.endsWith('='))
    .join('; ')
}
