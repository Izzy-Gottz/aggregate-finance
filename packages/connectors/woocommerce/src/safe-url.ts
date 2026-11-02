// The customer types an address and our server fetches it: on hosted, that is a server-side request forgery path. Every
// request here goes through three checks, none of which a store can switch off:
//
//   parseStoreUrl   https on port 443, a public-looking name; no IP literals, credentials, query or local names.
//   guardedFetch    resolves the name and refuses if any answer is private, on every request (a store that moved to a
//                   private address after connecting is caught); never follows a redirect; caps the response size.
//   safeLookup      the same address check again inside the socket's own DNS lookup, so the address that is checked is
//                   the address that is dialled. That closes DNS rebinding between the check and the connection.
//
// Errors never carry a response body, a Location header or a resolver's message.

import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { Readable } from 'node:stream'
import { ConnectorError, type FetchLike } from '@agfn/connector-sdk'

const PROVIDER = 'woocommerce'

export interface ResolvedAddress {
  address: string
  family: number
}
export type Resolver = (host: string) => Promise<ResolvedAddress[]>

export const systemResolver: Resolver = (host) => dnsLookup(host, { all: true })

/** Largest response read. A page of 100 orders with the narrow field list is far smaller. */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024

/** Names that only mean something inside a network, whatever a resolver says today. */
const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'intranet', 'lan', 'home', 'corp', 'private', 'flycast', 'onion', 'arpa', 'test', 'invalid']

const blocked = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including the 169.254.169.254 metadata service
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved and broadcast
] as const) blocked.addSubnet(net, bits, 'ipv4')
for (const [net, bits] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64, which can wrap a private IPv4 address
  ['100::', 64], // discard
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4, which can wrap a private IPv4 address
  ['fc00::', 7], // unique local, including fdaa::/8 (Fly 6PN)
  ['fe80::', 10], // link-local
  ['fec0::', 10], // old site-local
  ['ff00::', 8], // multicast
] as const) blocked.addSubnet(net, bits, 'ipv6')

/** True for anything that isn't a public address, and for anything unreadable. IPv4-mapped IPv6 is judged as its IPv4. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 0) return true
  return blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6')
}

const refuse = (message: string) => new ConnectorError('invalid_input', message, { provider: PROVIDER, forUser: true })
const blockedHost = () => new ConnectorError('permanent', 'That store address points at a private network, so Aggregate won’t connect to it.', { provider: PROVIDER, forUser: true })

/** The customer's input as a clean base URL ("https://shop.example.com/store"), or invalid_input. */
export function parseStoreUrl(input: string): string {
  const typed = input.trim()
  if (!typed) throw refuse('Type your store address, starting with https://.')
  let u: URL
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(typed) && !/^[^/]+:\d+(\/|$)/.test(typed) ? typed : `https://${typed}`)
  } catch {
    throw refuse('That isn’t a store address. Type it like https://shop.example.com.')
  }
  if (u.protocol !== 'https:') throw refuse('The store address must start with https://. WooCommerce keys can’t be sent over plain http.')
  if (u.username || u.password) throw refuse('Type the store address without a name or password in it.')
  if (u.search || u.hash) throw refuse('Type just the store address, with nothing after a ? or #.')
  if (u.port) throw refuse('The store address must use the standard https port.')
  const host = u.hostname.replace(/\.+$/, '').toLowerCase()
  const bare = host.replace(/^\[|\]$/g, '')
  if (isIP(bare) !== 0) throw refuse('Type the store’s domain name, not an IP address.')
  if (!host.includes('.') || LOCAL_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) throw refuse('Type the public address of your store.')
  return `https://${host}${u.pathname.replace(/\/+$/, '')}`
}

async function publicAddresses(host: string, resolve: Resolver): Promise<ResolvedAddress[]> {
  let addresses: ResolvedAddress[]
  try {
    addresses = await resolve(host)
  } catch {
    throw new ConnectorError('transient', 'store address did not resolve', { provider: PROVIDER })
  }
  if (addresses.length === 0) throw new ConnectorError('transient', 'store address did not resolve', { provider: PROVIDER })
  if (addresses.some((a) => isBlockedAddress(a.address))) throw blockedHost()
  return addresses
}

type LookupCallback = (err: Error | null, address?: unknown, family?: number) => void

/** A `lookup` for node's sockets: resolves and checks in the same step, so a rebinding answer never reaches connect(). */
export function safeLookup(resolve: Resolver) {
  return (host: string, opts: { all?: boolean }, cb: LookupCallback): void => {
    publicAddresses(host, resolve).then(
      (addresses) => (opts.all ? cb(null, addresses) : cb(null, addresses[0]!.address, addresses[0]!.family)),
      (e: Error) => cb(e),
    )
  }
}

const NO_BODY = new Set([101, 204, 205, 304])

/** The real transport: node:https, which follows no redirects and ignores proxy settings, dialling only safeLookup's answer. */
export function httpsFetch(resolve: Resolver): FetchLike {
  return (input, init) =>
    new Promise((resolved, rejected) => {
      const req = httpsRequest(
        input,
        {
          method: init?.method ?? 'GET',
          headers: { 'accept-encoding': 'identity', ...(init?.headers as Record<string, string> | undefined) },
          lookup: safeLookup(resolve) as never,
          agent: false,
          ...(init?.signal ? { signal: init.signal } : {}),
        },
        (res) => {
          const headers = new Headers()
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v)
          const status = res.statusCode ?? 502
          resolved(new Response(NO_BODY.has(status) ? null : (Readable.toWeb(res) as unknown as BodyInit), { status, headers }))
        },
      )
      req.on('error', rejected)
      if (typeof init?.body === 'string') req.write(init.body)
      req.end()
    })
}

const tooBig = () => new ConnectorError('permanent', 'Your store sent more than Aggregate will read in one response.', { provider: PROVIDER, forUser: true })

async function capped(res: Response, maxBytes: number, signal: AbortSignal | null | undefined): Promise<Response> {
  if (Number(res.headers.get('content-length') ?? 0) > maxBytes) {
    await res.body?.cancel().catch(() => undefined)
    throw tooBig()
  }
  if (!res.body) return res
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  const aborted = new Promise<never>((_, reject) => {
    if (signal?.aborted) reject(new DOMException('aborted', 'AbortError'))
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
  })
  aborted.catch(() => undefined)
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted])
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw tooBig()
      chunks.push(value)
    }
  } catch (e) {
    await reader.cancel().catch(() => undefined)
    throw e
  }
  return new Response(Buffer.concat(chunks), { status: res.status, headers: res.headers })
}

export interface GuardOptions {
  resolve: Resolver
  fetch: FetchLike
  maxBytes?: number
}

/** Wraps a fetch so every request passes the checks at the top of this file. */
export function guardedFetch(opts: GuardOptions): FetchLike {
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES
  return async (input, init) => {
    let host: string
    try {
      const u = new URL(input)
      host = new URL(parseStoreUrl(`${u.protocol}//${u.host}`)).hostname
    } catch {
      throw blockedHost()
    }
    await publicAddresses(host, opts.resolve)
    const res = await opts.fetch(input, { ...init, redirect: 'manual' })
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined)
      throw new ConnectorError('permanent', 'That address redirects somewhere else. Type the exact address your store ends up on, with or without www.', { provider: PROVIDER, forUser: true })
    }
    return capped(res, maxBytes, init?.signal)
  }
}
