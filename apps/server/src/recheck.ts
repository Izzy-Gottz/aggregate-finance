// "It's you" by email: the fallback re-check for sensitive actions (connecting an account, giving an AI access,
// deleting data) when a passkey isn't on this device, or the person never added one.
//
// POST /api/recheck/email sends a one-time link to the account's own address. Opening it (on any device) records a
// re-check of kind email_link, which passkey checks accept for 10 minutes; the person goes back and tries again. The
// trade-off is written down in docs/security/recheck.md: the email inbox is a recovery factor, as it already is for
// signing in. Links are hashed, expire in 10 minutes, work once, are rate-limited, and every use is in the activity log.

import { createHash, randomBytes } from 'node:crypto'
import type { Kysely } from 'kysely'
import { ownerOf, newId, withBypass, withWorkspace, type CoreTables } from '@agfn/db'
import { recheckEmail, type Mailer } from '@agfn/auth'
import { appendActivity } from '@agfn/mcp'
import { CODE_TRIES, codeHash, newCode, normalizeCode, sameHash } from '@agfn/auth'

export const RECHECK_LINK_MINUTES = 10
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const hashOf = (token: string) => createHash('sha256').update(token).digest('hex')

/** Only a path inside this app: never another site (an open redirect behind a sign-in-grade link). */
export function safeReturnTo(returnTo: unknown): string {
  return typeof returnTo === 'string' && /^\/(?!\/)[^\s\\]*$/.test(returnTo) ? returnTo : '/#/'
}

export async function sendRecheckLink(deps: { db: Kysely<CoreTables>; mailer: Mailer; baseUrl: string; appName?: string; now?: Date }, person: { id: string; email: string }, returnTo: string): Promise<void> {
  const now = deps.now ?? new Date()
  const token = randomBytes(32).toString('base64url')
  const id = newId()
  // The same email carries a 6-digit code for when the link opens on another device or browser (email-codes.ts).
  const code = newCode()
  // recheck_links, reauth_events and people are person-level (no workspace_id): no row-level security, no bypass.
  await ownerOf(deps.db)
    .insertInto('recheck_links')
    .values({ id, person_id: person.id, token_hash: hashOf(token), created_at: now.toISOString(), expires_at: new Date(now.getTime() + RECHECK_LINK_MINUTES * 60_000).toISOString(), used_at: null, code_hash: codeHash(id, code), attempts: 0 })
    .execute()
  const url = `${deps.baseUrl.replace(/\/+$/, '')}/recheck/${token}?r=${encodeURIComponent(safeReturnTo(returnTo))}`
  const mail = recheckEmail({ url, code, minutes: RECHECK_LINK_MINUTES, ...(deps.appName ? { app: deps.appName } : {}) })
  await deps.mailer.send({ to: person.email, subject: mail.subject, text: mail.text, html: mail.html })
}

export type RecheckResult = { ok: true; personId: string } | { ok: false; reason: 'unknown' | 'used' | 'expired' }

/** Use a link: one time, within 10 minutes. Records the re-check and logs it in each of the person's workspaces. */
export async function confirmRecheckLink(db: Kysely<CoreTables>, token: string, now: Date = new Date()): Promise<RecheckResult> {
  if (!TOKEN_RE.test(token)) return { ok: false, reason: 'unknown' }
  const row = await ownerOf(db).selectFrom('recheck_links').selectAll().where('token_hash', '=', hashOf(token)).executeTakeFirst()
  if (!row) return { ok: false as const, reason: 'unknown' as const }
  if (row.used_at) return { ok: false as const, reason: 'used' as const }
  if (row.expires_at <= now.toISOString()) return { ok: false as const, reason: 'expired' as const }
  // Claim it: a second click racing this one finds used_at set and is refused.
  const claimed = await ownerOf(db).updateTable('recheck_links').set({ used_at: now.toISOString() }).where('id', '=', row.id).where('used_at', 'is', null).executeTakeFirst()
  if (Number(claimed.numUpdatedRows ?? 0) !== 1) return { ok: false as const, reason: 'used' as const }
  return recordRecheck(db, row.person_id, now)
}

export type RecheckCodeResult = { ok: true } | { ok: false; reason: 'none' | 'wrong' | 'too_many'; triesLeft?: number }

/**
 * The code from the newest re-check email, entered by the signed-in person who asked for it (so it's tied to them):
 * 5 tries, then that email is spent. Same effect as opening the link.
 */
export async function confirmRecheckCode(db: Kysely<CoreTables>, personId: string, input: unknown, now: Date = new Date()): Promise<RecheckCodeResult> {
  const row = await ownerOf(db)
    .selectFrom('recheck_links')
    .select(['id', 'code_hash', 'attempts'])
    .where('person_id', '=', personId)
    .where('used_at', 'is', null)
    .where('expires_at', '>', now.toISOString())
    .where('code_hash', 'is not', null)
    .orderBy('created_at', 'desc')
    .executeTakeFirst()
  if (!row) return { ok: false as const, reason: 'none' as const }
  const code = normalizeCode(input)
  const attempts = row.attempts + 1
  if (!code || !sameHash(codeHash(row.id, code), row.code_hash!)) {
    const spent = attempts >= CODE_TRIES
    await ownerOf(db).updateTable('recheck_links').set({ attempts, ...(spent ? { used_at: now.toISOString() } : {}) }).where('id', '=', row.id).execute()
    return spent ? { ok: false as const, reason: 'too_many' as const } : { ok: false as const, reason: 'wrong' as const, triesLeft: CODE_TRIES - attempts }
  }
  const claimed = await ownerOf(db).updateTable('recheck_links').set({ used_at: now.toISOString(), attempts }).where('id', '=', row.id).where('used_at', 'is', null).executeTakeFirst()
  if (Number(claimed.numUpdatedRows ?? 0) !== 1) return { ok: false as const, reason: 'none' as const }
  await recordRecheck(db, personId, now)
  return { ok: true as const }
}

/** Record the re-check (it satisfies passkey checks for 10 minutes) and log it in each of the person's workspaces. */
async function recordRecheck(db: Kysely<CoreTables>, personId: string, now: Date): Promise<RecheckResult> {
  await ownerOf(db).insertInto('reauth_events').values({ id: newId(), person_id: personId, method: 'email_link', at: now.toISOString() }).execute()
  const person = await withBypass('recheck:person', () => db.selectFrom('people').select('name').where('id', '=', personId).executeTakeFirst())
  // The one cross-workspace step: which workspaces to log it in (a narrow named bypass); each log entry is written inside its workspace.
  const workspaces = await withBypass('recheck:memberships', () => db.selectFrom('memberships').select('workspace_id').where('person_id', '=', personId).where('revoked_at', 'is', null).execute())
  for (const { workspace_id } of workspaces) {
    await withWorkspace(workspace_id, () =>
      appendActivity(db as never, { workspaceId: workspace_id, actorKind: 'person', personId, actorLabel: person?.name || 'someone', action: 'recheck.email_link', status: 'ok', detail: 'Confirmed it’s them with an email link instead of a passkey' }, now),
    ).catch(() => undefined)
  }
  return { ok: true as const, personId }
}
