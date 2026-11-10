import { describe, expect, it } from 'vitest'
import { isCloudflareIp, CLOUDFLARE_IPV4, CLOUDFLARE_IPV6 } from './cloudflare-ips.ts'
import { clientIp } from './security.ts'

describe('isCloudflareIp', () => {
  it('recognises addresses inside the published IPv4 ranges', () => {
    expect(isCloudflareIp('173.245.48.1')).toBe(true) // 173.245.48.0/20
    expect(isCloudflareIp('104.16.0.1')).toBe(true) // 104.16.0.0/13
    expect(isCloudflareIp('104.24.5.5')).toBe(true) // 104.24.0.0/14
    expect(isCloudflareIp('172.64.0.1')).toBe(true) // 172.64.0.0/13
    expect(isCloudflareIp('131.0.72.1')).toBe(true) // 131.0.72.0/22
  })

  it('rejects addresses outside the ranges', () => {
    expect(isCloudflareIp('8.8.8.8')).toBe(false)
    expect(isCloudflareIp('1.1.1.1')).toBe(false) // a Cloudflare DNS resolver, not an edge proxy range
    expect(isCloudflareIp('203.0.113.7')).toBe(false)
    expect(isCloudflareIp('104.15.255.255')).toBe(false) // just below 104.16.0.0/13
    expect(isCloudflareIp('192.168.1.1')).toBe(false)
  })

  it('recognises IPv6 ranges, including a /29 boundary', () => {
    expect(isCloudflareIp('2400:cb00::1')).toBe(true) // 2400:cb00::/32
    expect(isCloudflareIp('2606:4700:4700::1111')).toBe(true) // 2606:4700::/32
    expect(isCloudflareIp('2a06:98c0::1')).toBe(true) // 2a06:98c0::/29
    expect(isCloudflareIp('2a06:98c7:ffff::1')).toBe(true) // still inside the /29
    expect(isCloudflareIp('2a06:98c8::1')).toBe(false) // just outside the /29
    expect(isCloudflareIp('2001:4860:4860::8888')).toBe(false) // Google DNS
  })

  it('handles IPv4-mapped IPv6 and zone ids and junk safely', () => {
    expect(isCloudflareIp('::ffff:104.16.0.1')).toBe(true)
    expect(isCloudflareIp('::ffff:8.8.8.8')).toBe(false)
    expect(isCloudflareIp('fe80::1%eth0')).toBe(false)
    expect(isCloudflareIp('')).toBe(false)
    expect(isCloudflareIp(undefined)).toBe(false)
    expect(isCloudflareIp('not-an-ip')).toBe(false)
    expect(isCloudflareIp('999.999.999.999')).toBe(false)
  })

  it('pins the published ranges so a silent upstream change is noticed', () => {
    expect(CLOUDFLARE_IPV4).toContain('173.245.48.0/20')
    expect(CLOUDFLARE_IPV4).toHaveLength(15)
    expect(CLOUDFLARE_IPV6).toContain('2400:cb00::/32')
    expect(CLOUDFLARE_IPV6).toHaveLength(7)
  })
})

describe('clientIp behind a Cloudflare → Fly proxy chain', () => {
  const H = (o: Record<string, string>) => new Headers(o)

  it('ignores a forged cf-connecting-ip when the trusted header is not a Cloudflare IP', () => {
    // A direct hit on fly.dev: fly-client-ip is the real (non-CF) client, cf-connecting-ip is attacker-supplied.
    const headers = H({ 'fly-client-ip': '203.0.113.9', 'cf-connecting-ip': '8.8.8.8' })
    expect(clientIp(headers, 'fly-client-ip')).toBe('203.0.113.9')
  })

  it('honours cf-connecting-ip when the trusted header is a real Cloudflare range', () => {
    const headers = H({ 'fly-client-ip': '172.69.12.34', 'cf-connecting-ip': '198.51.100.23' })
    expect(clientIp(headers, 'fly-client-ip')).toBe('198.51.100.23')
  })

  it('works for an IPv6 Cloudflare edge', () => {
    const headers = H({ 'fly-client-ip': '2606:4700:4700::1111', 'cf-connecting-ip': '2001:db8::42' })
    expect(clientIp(headers, 'fly-client-ip')).toBe('2001:db8::42')
  })

  it('falls back to the trusted header when behind Cloudflare but cf-connecting-ip is absent', () => {
    const headers = H({ 'fly-client-ip': '172.69.12.34' })
    expect(clientIp(headers, 'fly-client-ip')).toBe('172.69.12.34')
  })

  it('returns undefined when no trusted header is configured, whatever the client sends', () => {
    const headers = H({ 'fly-client-ip': '172.69.12.34', 'cf-connecting-ip': '198.51.100.23' })
    expect(clientIp(headers, undefined)).toBeUndefined()
  })
})
