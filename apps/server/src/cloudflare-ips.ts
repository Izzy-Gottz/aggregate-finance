// Cloudflare's published edge IP ranges, pinned in the repo so a request's trusted-proxy IP can be checked against
// them offline. Behind Cloudflare's proxy, Fly sets fly-client-ip to Cloudflare's edge address and Cloudflare sets
// cf-connecting-ip to the real client; we only believe cf-connecting-ip when fly-client-ip is one of these ranges, so
// a direct fly.dev request can't forge it (see clientIp in security.ts).
//
// Source (refresh from here; both are plain newline-separated lists):
//   https://www.cloudflare.com/ips-v4/
//   https://www.cloudflare.com/ips-v6/
// Pinned 2026-11-04. Cloudflare changes these rarely; cloudflare-ips.test.ts documents the pinned set, and if the
// published list ever moves, update both arrays and the date here.

export const CLOUDFLARE_IPV4: readonly string[] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
]

export const CLOUDFLARE_IPV6: readonly string[] = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
]

/** A parsed CIDR: the network address as a bigint, the prefix length, and whether it's v4 (32-bit) or v6 (128-bit). */
interface Cidr {
  base: bigint
  prefix: number
  v4: boolean
}

function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0n
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const v = Number(p)
    if (v > 255) return null
    n = (n << 8n) | BigInt(v)
  }
  return n
}

function ipv6ToBigInt(ip: string): bigint | null {
  // Drop a zone id ("fe80::1%eth0") and lower-case; reject anything with stray characters.
  const bare = ip.split('%')[0] as string
  if (!/^[0-9a-fA-F:.]+$/.test(bare)) return null
  const halves = bare.split('::')
  if (halves.length > 2) return null
  const expand = (s: string): string[] => (s === '' ? [] : s.split(':'))
  let head = expand(halves[0] as string)
  let tail = halves.length === 2 ? expand(halves[1] as string) : []
  // A trailing IPv4 (e.g. ::ffff:1.2.3.4) counts as two groups.
  const lastOf = (groups: string[]): string[] => {
    if (groups.length === 0) return groups
    const last = groups[groups.length - 1] as string
    if (!last.includes('.')) return groups
    const n = ipv4ToBigInt(last)
    if (n === null) return groups
    const hi = (n >> 16n) & 0xffffn
    const lo = n & 0xffffn
    return [...groups.slice(0, -1), hi.toString(16), lo.toString(16)]
  }
  head = lastOf(head)
  tail = lastOf(tail)
  const missing = 8 - (head.length + tail.length)
  if (halves.length === 2) {
    if (missing < 0) return null
  } else if (missing !== 0) {
    return null
  }
  const groups = [...head, ...Array(Math.max(missing, 0)).fill('0'), ...tail]
  if (groups.length !== 8) return null
  let n = 0n
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
    n = (n << 16n) | BigInt(parseInt(g, 16))
  }
  return n
}

function parseCidr(cidr: string): Cidr | null {
  const [addr, lenStr] = cidr.split('/')
  if (!addr || lenStr === undefined) return null
  const prefix = Number(lenStr)
  if (!Number.isInteger(prefix) || prefix < 0) return null
  if (addr.includes(':')) {
    const base = ipv6ToBigInt(addr)
    if (base === null || prefix > 128) return null
    return { base, prefix, v4: false }
  }
  const base = ipv4ToBigInt(addr)
  if (base === null || prefix > 32) return null
  return { base, prefix, v4: true }
}

const V4_RANGES = CLOUDFLARE_IPV4.map(parseCidr).filter((c): c is Cidr => c !== null)
const V6_RANGES = CLOUDFLARE_IPV6.map(parseCidr).filter((c): c is Cidr => c !== null)

function inCidr(value: bigint, c: Cidr): boolean {
  const bits = c.v4 ? 32 : 128
  const shift = BigInt(bits - c.prefix)
  return value >> shift === c.base >> shift
}

/** True when `ip` (a bare IPv4 or IPv6 address) falls inside one of Cloudflare's published edge ranges. */
export function isCloudflareIp(ip: string | undefined | null): boolean {
  if (!ip) return false
  const trimmed = ip.trim()
  if (trimmed.includes(':')) {
    // An IPv4-mapped IPv6 address (::ffff:1.2.3.4) is really an IPv4 client.
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(trimmed)
    if (mapped) return isCloudflareIp(mapped[1] as string)
    const n = ipv6ToBigInt(trimmed)
    return n !== null && V6_RANGES.some((c) => inCidr(n, c))
  }
  const n = ipv4ToBigInt(trimmed)
  return n !== null && V4_RANGES.some((c) => inCidr(n, c))
}
