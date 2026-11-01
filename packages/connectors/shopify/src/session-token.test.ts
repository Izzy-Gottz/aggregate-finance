import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyShopifySessionToken } from './session-token.ts'

const APP = { clientId: 'client-test', secret: 'shpss_test' }
const NOW = Date.parse('2026-10-11T12:00:00Z')
const s = Math.floor(NOW / 1000)
function token(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' }, secret = APP.secret): string {
  const enc = (x: object) => Buffer.from(JSON.stringify(x)).toString('base64url')
  const body = `${enc(header)}.${enc(claims)}`
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}
const good = { iss: 'https://shop-a.myshopify.com/admin', dest: 'https://shop-a.myshopify.com', aud: 'client-test', sub: '1', exp: s + 60, nbf: s - 5, iat: s - 5 }

describe('Shopify session tokens', () => {
  it('a token Shopify signed for this app names its shop', () => {
    expect(verifyShopifySessionToken(token(good), APP, NOW)).toBe('shop-a.myshopify.com')
  })
  it.each([
    ['wrong secret', token(good, undefined, 'other')],
    ['alg none', token(good, { alg: 'none' })],
    ['another app', token({ ...good, aud: 'nope' })],
    ['expired', token({ ...good, exp: s - 60 })],
    ['not yet valid', token({ ...good, nbf: s + 60 })],
    ['issuer is another shop', token({ ...good, iss: 'https://shop-b.myshopify.com/admin' })],
    ['dest not a shop', token({ ...good, dest: 'https://evil.example.com', iss: 'https://evil.example.com/admin' })],
    ['malformed', 'a.b'],
  ])('refuses: %s', (_why, t) => {
    expect(() => verifyShopifySessionToken(t, APP, NOW)).toThrow(/Shopify session token/)
  })
})
