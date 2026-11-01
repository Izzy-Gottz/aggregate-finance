// Agent keys for bots that can't do OAuth (scripts, personal agents, n8n): prefixed, hashed, shown once, expiring.
// Format: agfn_live_<43 base62 chars> (256 bits). Only sha256(key) is stored; the plaintext exists once, in the
// response to the person who created it. The prefix makes leaked keys greppable by secret scanners.

import { createHash, randomBytes } from 'node:crypto'

export const KEY_PREFIX = 'agfn_live_'
const BODY_LEN = 43
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const KEY_RE = new RegExp(`^${KEY_PREFIX}[0-9A-Za-z]{${BODY_LEN}}$`)

/** Unbiased base62 via rejection sampling. */
function randomBase62(len: number): string {
  let out = ''
  while (out.length < len) {
    for (const b of randomBytes(len * 2)) {
      if (b < 248) out += ALPHABET[b % 62]
      if (out.length === len) break
    }
  }
  return out
}

export interface NewKey {
  /** The full key. Show once, never store. */
  plaintext: string
  hash: string
  displayPrefix: string
  last4: string
}

export function generateKey(): NewKey {
  const plaintext = KEY_PREFIX + randomBase62(BODY_LEN)
  return { plaintext, hash: hashKey(plaintext), displayPrefix: plaintext.slice(0, KEY_PREFIX.length + 4), last4: plaintext.slice(-4) }
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

/** Cheap shape check before touching the database (also tells an agent key apart from an OAuth access token). */
export function looksLikeAgentKey(token: string): boolean {
  return KEY_RE.test(token)
}
