// Inviting someone to their own Aggregate account: a fixed email and a link with the inviter's code. Nothing of the
// inviter's is shared, and there's no message field, so this can't carry anyone's words to a stranger. The address is
// kept only as a keyed hash, to refuse a repeat for 30 days; the invite gives no perk (see migration 0908). Anyone who
// doesn't want these goes on a list of hashes (0909), and later invites to them look sent and send nothing.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { isIPv6 } from 'node:net'
import type { Kysely } from 'kysely'

export const FRIEND_COOKIE = 'agfn_friend'
const CODE = /^[a-f0-9]{16}$/
export const PER_DAY = 10
/** An account less than a day old: signing up is free, so this keeps throwaway accounts from using the total. */
export const NEW_ACCOUNT_PER_DAY = 3
/** Every invite shares the sending quota with sign-in links, which must keep working. AGFN_FRIEND_INVITES_PER_DAY. */
export const ALL_PER_DAY = 30
/** Attempts from one network, across accounts: accounts are free, networks less so. */
export const PER_NETWORK_PER_DAY = 20
export const REPEAT_DAYS = 30
const DAY = 86_400_000

interface FriendTables {
  friend_codes: { person_id: string; code: string; created_at: string }
  friend_invites: { id: string; inviter_id: string; email_hash: string; sent: number; ip_hash: string | null; created_at: string }
  friend_signups: { person_id: string; inviter_id: string; created_at: string }
  friend_invite_optouts: { email_hash: string; created_at: string }
  people: { id: string; email: string; name: string; created_at: string }
}
const t = (db: Kysely<any>) => db as unknown as Kysely<FriendTables>

export const validFriendCode = (code: string): boolean => CODE.test(code)
export const friendLink = (baseUrl: string, code: string): string => `${baseUrl.replace(/\/+$/, '')}/?start=1&from=${code}`

/** This person's code, made the first time it's needed. */
export async function friendCode(db: Kysely<any>, personId: string, now = new Date()): Promise<string> {
  const found = await t(db).selectFrom('friend_codes').select('code').where('person_id', '=', personId).executeTakeFirst()
  if (found) return found.code
  const code = randomBytes(8).toString('hex')
  await t(db).insertInto('friend_codes').values({ person_id: personId, code, created_at: now.toISOString() }).onConflict((o) => o.column('person_id').doNothing()).execute()
  return (await t(db).selectFrom('friend_codes').select('code').where('person_id', '=', personId).executeTakeFirstOrThrow()).code
}

/** The inviter's name in a subject line: first name only, letters only, so an account name can't become a message. */
export function firstName(name: string | null | undefined): string {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? ''
  return /^[\p{L}][\p{L}'’]*(-[\p{L}][\p{L}'’]*)?$/u.test(first) && first.length <= 20 ? first : 'A friend'
}

export function friendEmail(inviter: string, link: string, stop: string): { subject: string; text: string; html: string } {
  const subject = `${inviter} invited you to try Aggregate`
  const line = 'Ask your AI about your finances. It can’t move money. Free during beta.'
  const fine = `${inviter} entered your address. You won’t get another email about this invite, and you’re not on any list.`
  return {
    subject,
    text: `${subject}\n\n${line}\n\nSign up: ${link}\n\n${fine}\n\nDon’t send me invites: ${stop}\n`,
    html: `<p>${subject}</p><p>${line}</p><p><a href="${link}">Sign up</a></p><p style="color:#74736E;font-size:13px">${fine} <a href="${stop}" style="color:#74736E">Don’t send me invites</a></p>`,
  }
}

/** One mailbox, one form: a+1@ and a@ are the same person, and Gmail ignores dots. */
export function canonicalEmail(email: string): string {
  const [local = '', domain = ''] = email.trim().toLowerCase().split('@')
  const gmail = domain === 'gmail.com' || domain === 'googlemail.com'
  const base = local.split('+')[0]!
  return `${gmail ? base.replace(/\./g, '') : base}@${gmail ? 'gmail.com' : domain}`
}

const hashOf = (secret: string, email: string) => createHmac('sha256', secret).update(`friend-invite:${canonicalEmail(email)}`).digest('hex')
const since = (now: Date, days: number) => new Date(now.getTime() - days * DAY).toISOString()

// The stop link carries the hash, never the address, and a signature so nobody can opt out an address they only guess.
const stopSig = (secret: string, hash: string) => createHmac('sha256', secret).update(`friend-invite-stop:${hash}`).digest('hex')
export const friendStopLink = (baseUrl: string, secret: string, hash: string): string => `${baseUrl.replace(/\/+$/, '')}/invites/stop?h=${hash}&s=${stopSig(secret, hash)}`
export function validStop(secret: string, hash: string, sig: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(hash) || !/^[a-f0-9]{64}$/.test(sig)) return false
  return timingSafeEqual(Buffer.from(sig), Buffer.from(stopSig(secret, hash)))
}

export async function stopInvites(db: Kysely<any>, hash: string, now = new Date()): Promise<void> {
  await t(db).insertInto('friend_invite_optouts').values({ email_hash: hash, created_at: now.toISOString() }).onConflict((o) => o.column('email_hash').doNothing()).execute()
}

export async function allowInvites(db: Kysely<any>, hash: string): Promise<void> {
  await t(db).deleteFrom('friend_invite_optouts').where('email_hash', '=', hash).execute()
}

/** Hashes exist only for the 30-day repeat check, so the daily retention job deletes them after that. */
export async function pruneFriendInvites(db: Kysely<any>, now = new Date()): Promise<number> {
  await t(db).updateTable('friend_invites').set({ ip_hash: null }).where('created_at', '<=', since(now, 1)).where('ip_hash', 'is not', null).execute()
  const r = await t(db).deleteFrom('friend_invites').where('created_at', '<=', since(now, REPEAT_DAYS)).executeTakeFirst()
  return Number(r.numDeletedRows ?? 0)
}

/** What counts as one network: an IPv4 address, or an IPv6 /64, which one customer usually holds whole. */
export function networkOf(ip: string): string {
  const a = ip.trim().toLowerCase()
  if (!isIPv6(a)) return a
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a)
  if (mapped) return mapped[1]!
  const [head = '', tail] = a.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups = [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')
}

type Mail = { to: string; subject: string; text: string; html: string }

/**
 * An email to send, or nothing, and the person asking can't tell which: every address gets the same answer, so this can't
 * be used to learn who has an account, or who was invited. So the order matters. The attempt is written and the limits
 * checked before anything about the address is looked up, and every attempt counts, repeats included: past the limit,
 * asking tells you nothing and costs nothing to anyone. Limits count rows after adding this one, so two requests at once
 * can't both take the last place. The caller sends after answering, so timing can't tell them apart either.
 */
export async function inviteFriend(
  db: Kysely<any>,
  o: { personId: string; email: string; ip?: string | undefined; secret: string; baseUrl: string; dailyCap: number; now?: Date },
): Promise<{ id: string; mail: Mail } | null> {
  const now = o.now ?? new Date()
  const email = o.email.trim().toLowerCase()
  const me = await t(db).selectFrom('people').select(['email', 'name', 'created_at']).where('id', '=', o.personId).executeTakeFirstOrThrow()
  const hash = hashOf(o.secret, email)
  const code = await friendCode(db, o.personId, now)
  const id = randomUUID()
  const ipHash = o.ip ? createHmac('sha256', o.secret).update(`friend-invite-ip:${networkOf(o.ip)}`).digest('hex') : null
  await t(db).insertInto('friend_invites').values({ id, inviter_id: o.personId, email_hash: hash, sent: 0, ip_hash: ipHash, created_at: now.toISOString() }).execute()
  const today = () => t(db).selectFrom('friend_invites').select((eb) => eb.fn.countAll<number>().as('n')).where('created_at', '>', since(now, 1))
  const mine = Number((await today().where('inviter_id', '=', o.personId).executeTakeFirstOrThrow()).n)
  const drop = () => t(db).deleteFrom('friend_invites').where('id', '=', id).execute()
  if (mine > (me.created_at > since(now, 1) ? NEW_ACCOUNT_PER_DAY : PER_DAY)) return drop().then(() => null)
  if (ipHash && Number((await today().where('ip_hash', '=', ipHash).executeTakeFirstOrThrow()).n) > PER_NETWORK_PER_DAY) return drop().then(() => null)
  if (Number((await today().where('sent', '=', 1).executeTakeFirstOrThrow()).n) >= o.dailyCap) return drop().then(() => null)
  const recent = await t(db).selectFrom('friend_invites').select(['inviter_id', 'sent']).where('email_hash', '=', hash).where('id', '!=', id).where('created_at', '>', since(now, REPEAT_DAYS)).execute()
  if (recent.some((r) => r.inviter_id === o.personId || r.sent === 1)) return null
  if (await t(db).selectFrom('friend_invite_optouts').select('email_hash').where('email_hash', '=', hash).executeTakeFirst()) return null
  if (canonicalEmail(me.email) === canonicalEmail(email)) return null
  if (await t(db).selectFrom('people').select('id').where('email', '=', email).executeTakeFirst()) return null
  await t(db).updateTable('friend_invites').set({ sent: 1 }).where('id', '=', id).execute()
  return { id, mail: { to: email, ...friendEmail(firstName(me.name), friendLink(o.baseUrl, code), friendStopLink(o.baseUrl, o.secret, hash)) } }
}

/** The send failed after we'd answered: it shouldn't hold a place, or stop someone else inviting them. */
export const forgetInvite = (db: Kysely<any>, id: string) => t(db).deleteFrom('friend_invites').where('id', '=', id).execute()

/** The code from a Cookie header, if any. */
export function friendFromCookie(header: string | null | undefined): string | null {
  const m = new RegExp(`(?:^|;\\s*)${FRIEND_COOKIE}=([a-f0-9]+)`).exec(header ?? '')
  return m && validFriendCode(m[1]!) ? m[1]! : null
}

/** Who invited this new person, once. An unknown code, or your own, records nothing. */
export async function recordFriendSignup(db: Kysely<any>, personId: string, code: string, now = new Date()): Promise<void> {
  const inviter = await t(db).selectFrom('friend_codes').select('person_id').where('code', '=', code).executeTakeFirst()
  if (!inviter || inviter.person_id === personId) return
  await t(db).insertInto('friend_signups').values({ person_id: personId, inviter_id: inviter.person_id, created_at: now.toISOString() }).onConflict((o) => o.column('person_id').doNothing()).execute()
}
