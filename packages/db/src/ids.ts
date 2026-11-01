import { randomBytes } from 'node:crypto'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

let lastTime = -1
let lastRand = 0n
const RAND_MAX = (1n << 80n) - 1n

/**
 * ULID: 48-bit millisecond timestamp + 80 random bits, Crockford base32, sortable by creation time. Monotonic within a
 * process: a second id in the same millisecond is the previous random part + 1, so ids made in a row always sort in
 * the order they were made. Consumers page with `id > cursor` (the files connector's cursor is the last document id):
 * two statement attachments created in one millisecond used to sort at random and the second was skipped for good.
 */
export function newId(now: number = Date.now()): string {
  let rand: bigint
  if (now === lastTime && lastRand < RAND_MAX) {
    rand = lastRand + 1n
  } else {
    let bits = 0n
    for (const b of randomBytes(10)) bits = (bits << 8n) | BigInt(b)
    // Leave room to count up within the millisecond.
    rand = bits >> 1n
  }
  lastTime = now
  lastRand = rand
  let time = ''
  let t = now
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time
    t = Math.floor(t / 32)
  }
  let r = ''
  let bits = rand
  for (let i = 0; i < 16; i++) {
    r = ALPHABET[Number(bits & 31n)] + r
    bits >>= 5n
  }
  return time + r
}
