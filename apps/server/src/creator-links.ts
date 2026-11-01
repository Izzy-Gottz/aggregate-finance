// Creator links: /r/<code> remembers the code in a first-party cookie, and the person's first sign-up records one
// attribution row (person → code), the only thing stored. Yisrael's terms (2026-10-12): 3 months free once pricing
// starts, the first 100 sign-ups per link, links valid through 2026-12-31. Made and counted with `agfn creator-link`.
import { randomBytes } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { DbKind } from '@agfn/db'

export const REF_COOKIE = 'agfn_ref'
export const DEFAULT_CAP = 100
export const DEFAULT_EXPIRES = '2026-12-31T23:59:59.000Z'
/** What a creator-link sign-up gets once pricing starts. */
export const PERK_MONTHS = 3
const CODE = /^[a-z0-9][a-z0-9-]{2,39}$/

interface CreatorTables {
  creator_links: { code: string; label: string; cap: number; expires_at: string; created_at: string }
  creator_attributions: { person_id: string; code: string; created_at: string }
  memberships: { workspace_id: string; person_id: string; role: string; revoked_at: string | null }
}
const t = (db: Kysely<any>) => db as unknown as Kysely<CreatorTables>

export const validCode = (code: string): boolean => CODE.test(code)

export async function createCreatorLink(db: Kysely<any>, o: { label: string; code?: string; cap?: number; expiresAt?: string; now?: Date }): Promise<{ code: string; cap: number; expiresAt: string }> {
  const label = o.label.trim()
  if (!label) throw new Error('a creator link needs a --label (who it is for)')
  const code = (o.code ?? `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'creator'}-${randomBytes(3).toString('hex')}`).toLowerCase()
  if (!validCode(code)) throw new Error('codes are 3–40 characters: lowercase letters, digits and dashes')
  const cap = o.cap ?? DEFAULT_CAP
  if (!Number.isInteger(cap) || cap < 1 || cap > 100_000) throw new Error('--cap must be a whole number from 1')
  const expiresAt = o.expiresAt ?? DEFAULT_EXPIRES
  if (Number.isNaN(Date.parse(expiresAt))) throw new Error('--expires must be a date, e.g. 2026-12-31')
  const exists = await t(db).selectFrom('creator_links').select('code').where('code', '=', code).executeTakeFirst()
  if (exists) throw new Error(`creator link ${code} already exists`)
  await t(db).insertInto('creator_links').values({ code, label, cap, expires_at: new Date(expiresAt).toISOString(), created_at: (o.now ?? new Date()).toISOString() }).execute()
  return { code, cap, expiresAt: new Date(expiresAt).toISOString() }
}

export async function listCreatorLinks(db: Kysely<any>): Promise<Array<{ code: string; label: string; cap: number; used: number; expiresAt: string }>> {
  const rows = await t(db)
    .selectFrom('creator_links as l')
    .leftJoin('creator_attributions as a', 'a.code', 'l.code')
    .select(['l.code', 'l.label', 'l.cap', 'l.expires_at', (eb) => eb.fn.count<number>('a.person_id').as('used')])
    .groupBy(['l.code', 'l.label', 'l.cap', 'l.expires_at', 'l.created_at'])
    .orderBy('l.created_at')
    .execute()
  return rows.map((r) => ({ code: r.code, label: r.label, cap: r.cap, used: Number(r.used), expiresAt: r.expires_at }))
}

/** A code that exists, hasn't expired and has places left (sign-up checks the cap again, under a lock). */
export async function liveCode(db: Kysely<any>, code: string, now = new Date()): Promise<boolean> {
  if (!validCode(code)) return false
  const l = await t(db).selectFrom('creator_links').select(['expires_at', 'cap']).where('code', '=', code).executeTakeFirst()
  if (!l || l.expires_at <= now.toISOString()) return false
  const used = await t(db).selectFrom('creator_attributions').select((eb) => eb.fn.countAll<number>().as('n')).where('code', '=', code).executeTakeFirst()
  return Number(used?.n ?? 0) < l.cap
}

/**
 * Record that this person signed up through `code`: once per person, only while the link is live and under its cap.
 * The cap check and insert run in one transaction that locks the link's row (Postgres `for update`; SQLite serializes
 * writers), so two sign-ups at the same moment can't both take the last place.
 */
export async function attributeSignup(db: Kysely<any>, kind: DbKind, personId: string, code: string, now = new Date()): Promise<'recorded' | 'already' | 'full' | 'unknown'> {
  if (!validCode(code)) return 'unknown'
  return t(db).transaction().execute(async (tx) => {
    const lock = tx.selectFrom('creator_links').select(['cap', 'expires_at']).where('code', '=', code)
    const link = await (kind === 'postgres' ? lock.forUpdate() : lock).executeTakeFirst()
    if (!link || link.expires_at <= now.toISOString()) return 'unknown'
    if (await tx.selectFrom('creator_attributions').select('person_id').where('person_id', '=', personId).executeTakeFirst()) return 'already'
    const res = await sql<{ n: number }>`
      insert into creator_attributions (person_id, code, created_at)
      select ${personId}, ${code}, ${now.toISOString()}
      where (select count(*) from creator_attributions where code = ${code}) < ${link.cap}`.execute(tx)
    return Number(res.numAffectedRows ?? 0) > 0 ? 'recorded' : 'full'
  })
}

/**
 * The workspace's creator perk: 3 months free once pricing starts, when one of its owners signed up through a creator
 * link (the earliest such sign-up). Read from the attribution, not stored again, so it follows the owner and is gone
 * with the attribution (account deletion). Null when no owner came through a link.
 */
export async function creatorPerk(db: Kysely<any>, workspaceId: string): Promise<{ code: string; label: string; months: number; since: string } | null> {
  const row = await t(db)
    .selectFrom('memberships as m')
    .innerJoin('creator_attributions as a', 'a.person_id', 'm.person_id')
    .innerJoin('creator_links as l', 'l.code', 'a.code')
    .select(['a.code', 'l.label', 'a.created_at'])
    .where('m.workspace_id', '=', workspaceId)
    .where('m.role', '=', 'owner')
    .where('m.revoked_at', 'is', null)
    .orderBy('a.created_at')
    .orderBy('a.code')
    .executeTakeFirst()
  return row ? { code: row.code, label: row.label, months: PERK_MONTHS, since: row.created_at } : null
}

export const forgetAttribution = (db: Kysely<any>, personId: string) => t(db).deleteFrom('creator_attributions').where('person_id', '=', personId).execute()

/** The code from a Cookie header, if any. */
export function refFromCookie(header: string | null | undefined): string | null {
  const m = new RegExp(`(?:^|;\\s*)${REF_COOKIE}=([^;]+)`).exec(header ?? '')
  let code: string | null = null
  try {
    code = m ? decodeURIComponent(m[1]!).toLowerCase() : null
  } catch {
    return null // a malformed cookie never breaks sign-up
  }
  return code && validCode(code) ? code : null
}
