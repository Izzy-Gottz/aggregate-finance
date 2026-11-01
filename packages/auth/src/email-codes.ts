// The 6-digit code next to every sign-in and re-check link. Email links often open somewhere else (a phone's mail app,
// another default browser), which signs in that browser and leaves the one that asked waiting. The code lets the
// waiting page finish instead. It is the same secret as the link, in a second form: it expires with it (10 minutes),
// works once (using either uses both), allows 5 tries, and is rate-limited per address and per IP. A sign-in code works
// only in the browser that asked for it (an httpOnly nonce cookie set with the request). No "approve the other browser"
// polling: that invites phishing. Hashes only are stored; a code is compared in constant time.

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

export const CODE_TRIES = 5
/** The cookie that ties a sign-in code to the browser that asked (set on POST /api/auth/sign-in/magic-link). */
export const SIGNIN_NONCE_COOKIE = 'agfn_signin_nonce'

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** Six digits, uniformly random (leading zeros kept). */
export function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

export const newNonce = () => randomBytes(32).toString('base64url')

/** "123 456" → "123456"; anything that isn't exactly six digits → null. */
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const digits = input.replace(/[\s-]/g, '')
  return /^\d{6}$/.test(digits) ? digits : null
}

export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex')
  const y = Buffer.from(b, 'hex')
  return x.length === y.length && timingSafeEqual(x, y)
}

/** A code hash is salted with its row, so equal codes in two rows don't hash the same. */
export const codeHash = (rowId: string, code: string) => sha256(`${rowId}:${code}`)
