// Reviewer access links (docs/compliance/mcp-directory.md, Launch packet §3), approved 2026-10-11.
//
// Directory reviewers (Anthropic, OpenAI) must sign in with no email, SMS or MFA step. An operator mints a link with
// `agfn reviewer-link create` (only when AGFN_REVIEWER_LINKS=1). Opening it signs the visitor in as a dedicated
// reviewer person whose only membership is a demo workspace.
//
// Narrow by construction:
// - the token is 32 random bytes, stored only as its sha256, expiring and revocable; every use is logged;
// - the reviewer's email is on a reserved, undeliverable domain, so nobody can invite it or sign in as it by email;
// - a reviewer session works only while the person has exactly one membership and it is a demo workspace (checked on
//   every request in app.ts), so it can never reach real data, even if a membership were added by mistake;
// - reviewers have no passkey and can't register one. The fresh sign-in from opening the link counts as the re-check
//   for 10 minutes ONLY for creating an AI connection (control.createGrant, incl. OAuth consent; @agfn/mcp host.ts);
//   every other re-check refuses them, and the routes that matter are blocked as well (`reviewerBlocked`);
// - the demo workspace is rebuilt every night, so reviewers always see the same populated books.
//
// Sign-in reuses Better Auth's magic-link flow: the link Better Auth would email is captured and the browser is sent
// straight to it, so the session cookie, its lifetime and the sign-in record are exactly a normal sign-in's.

import { createHash, randomBytes } from 'node:crypto'
import type { Kysely } from 'kysely'
import { ownerOf, newId, nowIso, withBypass, withWorkspace, type CoreTables } from '@agfn/db'
import { captureMagicLink, REVIEWER_EMAIL_DOMAIN } from '@agfn/auth'
import type { LedgerEngine } from '@agfn/core'
import { createDemoWorkspace, isDemoWorkspace, leaveDemoWorkspace, type DemoExtrasPorts } from '@agfn/demo'
import { equityFor } from './equity.ts'
import type { Services } from './services.ts'

export { REVIEWER_EMAIL_DOMAIN }
export const REVIEWER_DEFAULT_DAYS = 30
export const REVIEWER_MAX_DAYS = 90
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

export const isReviewerEmail = (email: string | null | undefined): boolean => Boolean(email && email.toLowerCase().endsWith(`@${REVIEWER_EMAIL_DOMAIN}`))
const hashOf = (token: string) => createHash('sha256').update(token).digest('hex')

export interface ReviewerDeps {
  db: Kysely<CoreTables>
  /** Builds (or rebuilds) the person's demo workspace and returns its id. */
  buildDemo: (personId: string) => Promise<string>
  /** Deletes workspaces left with no member (orphans.ts), so yesterday's demo doesn't pile up. */
  cleanup?: (workspaceIds: string[]) => Promise<number>
  now?: () => Date
}

/**
 * The reviewer's one workspace, or null when the account isn't safe to use: no membership, more than one, or one that
 * isn't a demo workspace. Checked at redeem time and on every request of a reviewer session.
 */
export async function reviewerWorkspace(db: Kysely<CoreTables>, personId: string): Promise<string | null> {
  const rows = await withBypass('auth:reviewer', () => db.selectFrom('memberships').select('workspace_id').where('person_id', '=', personId).where('revoked_at', 'is', null).execute())
  if (rows.length !== 1) return null
  const ws = rows[0]!.workspace_id
  // Runs before any workspace is chosen: enter this one for the settings read (row-level security).
  return (await withWorkspace(ws, () => isDemoWorkspace(db, ws))) ? ws : null
}

/**
 * The reviewer's demo workspace while its link is live (not revoked, not expired), else null. Every reviewer session
 * request goes through this (app.ts, and the /v1/control person auth in modules.ts), so a session can't outlive the
 * link it came from, nor fall back to "the first workspace" when the account isn't demo-only.
 */
export async function reviewerAccess(db: Kysely<CoreTables>, personId: string, now: Date = new Date()): Promise<string | null> {
  const live = await ownerOf(db).selectFrom('reviewer_links').select('id').where('person_id', '=', personId).where('revoked_at', 'is', null).where('expires_at', '>', now.toISOString()).executeTakeFirst()
  return live ? reviewerWorkspace(db, personId) : null
}

export async function mintReviewerLink(deps: ReviewerDeps, opts: { label: string; days?: number; baseUrl: string }): Promise<{ id: string; url: string; expiresAt: string; workspaceId: string; email: string }> {
  const days = opts.days ?? REVIEWER_DEFAULT_DAYS
  if (!Number.isInteger(days) || days < 1 || days > REVIEWER_MAX_DAYS) throw new Error(`days must be a whole number from 1 to ${REVIEWER_MAX_DAYS}`)
  const label = opts.label.trim().slice(0, 80)
  if (!label) throw new Error('give the link a label, e.g. "Anthropic directory review"')
  const now = deps.now?.() ?? new Date()
  const personId = newId()
  const email = `reviewer-${randomBytes(6).toString('hex')}@${REVIEWER_EMAIL_DOMAIN}`
  await deps.db.insertInto('people').values({ id: personId, auth_user_id: null, name: 'App reviewer', email, created_at: nowIso() }).execute()
  const workspaceId = await deps.buildDemo(personId)
  if ((await reviewerWorkspace(deps.db, personId)) !== workspaceId) throw new Error('the reviewer account did not end up with exactly one demo workspace')
  const token = randomBytes(32).toString('base64url')
  const id = newId()
  const expiresAt = new Date(now.getTime() + days * 86_400_000).toISOString()
  await ownerOf(deps.db).insertInto('reviewer_links').values({ id, person_id: personId, token_hash: hashOf(token), label, created_at: now.toISOString(), expires_at: expiresAt, revoked_at: null, last_used_at: null, uses: 0 }).execute()
  return { id, url: `${opts.baseUrl.replace(/\/+$/, '')}/review-access/${token}`, expiresAt, workspaceId, email }
}

export async function listReviewerLinks(db: Kysely<CoreTables>): Promise<Array<{ id: string; label: string; createdAt: string; expiresAt: string; revoked: boolean; uses: number; lastUsedAt: string | null }>> {
  const rows = await ownerOf(db).selectFrom('reviewer_links').selectAll().orderBy('created_at', 'desc').execute()
  return rows.map((r) => ({ id: r.id, label: r.label, createdAt: r.created_at, expiresAt: r.expires_at, revoked: Boolean(r.revoked_at), uses: Number(r.uses), lastUsedAt: r.last_used_at }))
}

/** Revoke a link and end every session of its reviewer account. */
export async function revokeReviewerLink(db: Kysely<CoreTables>, id: string, now: Date = new Date()): Promise<boolean> {
  const row = await ownerOf(db).selectFrom('reviewer_links').select(['person_id', 'revoked_at']).where('id', '=', id).executeTakeFirst()
  if (!row) return false
  if (!row.revoked_at) await ownerOf(db).updateTable('reviewer_links').set({ revoked_at: now.toISOString() }).where('id', '=', id).execute()
  await endReviewerAccess(db, row.person_id, now)
  return true
}

/**
 * End everything a reviewer account holds: its sessions, and every AI connection it made (grants, their agent keys,
 * OAuth refresh tokens and consents), in any workspace. A reviewer's agent key can last up to a year, so revoking or
 * expiring the link must reach it too.
 */
async function endReviewerAccess(db: Kysely<CoreTables>, personId: string, now: Date): Promise<void> {
  const at = now.toISOString()
  const anyDb = db as unknown as Kysely<Record<string, Record<string, unknown>>>
  const person = await withBypass('reviewer:end-person', () => db.selectFrom('people').select('auth_user_id').where('id', '=', personId).executeTakeFirst())
  // Grants and agent keys are core tables: any failure there is thrown, never swallowed. Only the auth tables may be
  // missing (a minimal install without OAuth); anything else they throw is thrown too.
  if (person?.auth_user_id) await optionalTable(ownerOf(anyDb).deleteFrom('auth_session').where('userId', '=', person.auth_user_id).execute())
  const grants = ((await anyDb.selectFrom('grants').select('id').where('person_id', '=', personId).execute()) as Array<{ id: string }>).map((g) => g.id)
  await anyDb.updateTable('grants').set({ revoked_at: at, revoked_by: 'system:reviewer-revoke' }).where('person_id', '=', personId).where('revoked_at', 'is', null).execute()
  await anyDb.updateTable('agent_keys').set({ revoked_at: at }).where('created_by', '=', personId).where('revoked_at', 'is', null).execute()
  if (grants.length) {
    await anyDb.updateTable('agent_keys').set({ revoked_at: at }).where('grant_id', 'in', grants).where('revoked_at', 'is', null).execute()
    await optionalTable(ownerOf(anyDb).deleteFrom('oauthRefreshToken').where('referenceId', 'in', grants).execute())
    await optionalTable(ownerOf(anyDb).deleteFrom('oauthConsent').where('referenceId', 'in', grants).execute())
  }
}

/** Run a statement on a table a minimal install may not have: "no such table" is fine, any other error is not. */
async function optionalTable(run: Promise<unknown>): Promise<void> {
  try {
    await run
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if ((err as { code?: string }).code === '42P01' || /no such table|does not exist/i.test(msg)) return
    throw err
  }
}

export type RedeemResult = { ok: true; redirect: string; personId: string; workspaceId: string } | { ok: false; reason: 'unknown' | 'expired' | 'revoked' | 'unsafe' }

/**
 * Check a token and start a normal sign-in for its reviewer. `signIn` asks Better Auth for a magic link for the
 * reviewer's email (captured, never sent).
 */
export async function redeemReviewerLink(
  deps: Pick<ReviewerDeps, 'db' | 'now'> & { signIn: (email: string) => Promise<unknown>; log?: (detail: string, f: Record<string, unknown>) => Promise<void> | void },
  token: string,
  /** When signing in with email + password (the access code), the email typed must be this link's account. */
  email?: string,
): Promise<RedeemResult> {
  const now = deps.now?.() ?? new Date()
  if (!TOKEN_RE.test(token)) return { ok: false, reason: 'unknown' }
  const row = await ownerOf(deps.db).selectFrom('reviewer_links').selectAll().where('token_hash', '=', hashOf(token)).executeTakeFirst()
  if (!row) return { ok: false, reason: 'unknown' }
  if (row.revoked_at) return { ok: false, reason: 'revoked' }
  if (row.expires_at <= now.toISOString()) return { ok: false, reason: 'expired' }
  // Redeeming the link signs the reviewer in: no workspace context yet, so a named bypass reads the link's person.
  const person = await withBypass('reviewer:redeem-person', () => deps.db.selectFrom('people').select(['id', 'email']).where('id', '=', row.person_id).executeTakeFirst())
  if (email !== undefined && person?.email.toLowerCase() !== email.trim().toLowerCase()) return { ok: false, reason: 'unknown' }
  const ws = person && isReviewerEmail(person.email) ? await reviewerWorkspace(deps.db, person.id) : null
  if (!person || !ws) {
    await deps.log?.('reviewer link refused: the account is not demo-only', { linkId: row.id })
    return { ok: false, reason: 'unsafe' }
  }
  const url = await captureMagicLink(() => deps.signIn(person.email))
  if (!url) throw new Error('reviewer sign-in: no link was produced')
  await ownerOf(deps.db).updateTable('reviewer_links').set({ last_used_at: now.toISOString(), uses: Number(row.uses) + 1 }).where('id', '=', row.id).execute()
  await deps.log?.(`reviewer link used (${row.label})`, { linkId: row.id, workspaceId: ws })
  return { ok: true, redirect: url, personId: person.id, workspaceId: ws }
}

/**
 * Nightly: every live reviewer account gets a fresh demo workspace. The old one is deleted (after its AI connections
 * are revoked), so yesterday's test writes never pile up; expired or revoked links lose their demo too.
 */
export async function reseedReviewerDemos(deps: ReviewerDeps): Promise<number> {
  const now = (deps.now?.() ?? new Date()).toISOString()
  const live = await ownerOf(deps.db).selectFrom('reviewer_links').select('person_id').where('revoked_at', 'is', null).where('expires_at', '>', now).execute()
  const anyDb = deps.db as unknown as Kysely<Record<string, Record<string, unknown>>>
  // Links that ran out since: their accounts' sessions and AI connections end too (revocation does this at once).
  const liveIds = new Set(live.map((r) => r.person_id))
  const dead = await ownerOf(deps.db).selectFrom('reviewer_links').select('person_id').where((eb) => eb.or([eb('revoked_at', 'is not', null), eb('expires_at', '<=', now)])).execute()
  for (const personId of new Set(dead.map((r) => r.person_id).filter((id) => !liveIds.has(id)))) {
    await endReviewerAccess(deps.db, personId, new Date(now))
    // The account can't be used again, so its demo books go too.
    const ws = await reviewerWorkspace(deps.db, personId)
    if (ws && (await leaveDemoWorkspace(deps.db, personId))) await deps.cleanup?.([ws])
  }
  let n = 0
  for (const personId of [...new Set(live.map((r) => r.person_id))]) {
    const old = await reviewerWorkspace(deps.db, personId)
    if (old) {
      await anyDb.updateTable('grants').set({ revoked_at: now, revoked_by: 'system:reviewer-reseed' }).where('person_id', '=', personId).where('workspace_id', '=', old).where('revoked_at', 'is', null).execute()
      await anyDb.updateTable('agent_keys').set({ revoked_at: now }).where('created_by', '=', personId).where('revoked_at', 'is', null).execute()
      await leaveDemoWorkspace(deps.db, personId)
      await deps.cleanup?.([old])
    }
    await deps.buildDemo(personId)
    n++
  }
  return n
}

/** Requests a reviewer session may not make: anything that creates, joins, deletes, invites or connects real providers. */
export function reviewerBlocked(method: string, path: string): boolean {
  let end = path.length
  while (end > 0 && path[end - 1] === '/') end--
  const p = path.slice(0, end)
  // Sign-in methods: blocked whatever the method (some of Better Auth's passkey routes are GETs).
  if (/^\/api\/auth\/(passkey\/|link-social|change-email|delete-user|update-user|unlink-account|list-accounts)/.test(p)) return true
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false
  return [
    /^\/api\/workspaces$/, // a new (real) workspace
    /^\/api\/workspace(\/leave)?$/, // delete or leave the workspace
    /^\/api\/me$/, // delete the account
    /^\/api\/demo$/, // leave or recreate the demo
    /^\/api\/people(\/|$)/, // invite or change people
    /^\/api\/connectors\//, // connect any provider
    /^\/api\/connections\/[^/]+\/(disconnect|reconnect)/,
    /^\/api\/inbound\//, // email-in addresses and senders
    /^\/api\/ai\/pause-all$/,
    /^\/api\/recheck\//, // email re-check: the reviewer address can't receive mail, and reviewers get no passkey-grade check
    /^\/v1\/control\/(pause|resume)$/, // the same switch on the MCP host's control surface
  ].some((re) => re.test(p))
}

/** Build a filled demo workspace for a reviewer, the way `agfn demo` does (synced in this process). */
export function serverDemoBuilder(s: Services): (personId: string) => Promise<string> {
  return async (personId) => {
    const ledger = s.ledger as Partial<Pick<LedgerEngine, 'createBucket' | 'createRule'>>
    const demo = await createDemoWorkspace(
      { db: s.db, keys: s.keys, sync: s.sync, extras: { ...(ledger.createBucket && ledger.createRule ? { buckets: s.ledger as unknown as Pick<LedgerEngine, 'createBucket' | 'createRule'> } : {}), equity: equityFor(s), documents: demoDocuments(s) } },
      { personId },
    )
    return demo.workspaceId
  }
}

/** The demo's documents port: uploads run in the demo workspace's context (row-level security). */
export function demoDocuments(s: Pick<Services, 'documents'>): NonNullable<DemoExtrasPorts['documents']> {
  return { upload: (input) => withWorkspace(input.workspaceId, () => s.documents.upload(input)) }
}
