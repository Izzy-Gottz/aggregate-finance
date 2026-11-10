import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { BIGCOMMERCE_TOKEN_URL, BIGCOMMERCE_WRITE_SCOPE, exchangeInstallCode, readOnlyScopes, storeHashOf, verifySignedPayload } from './app.ts'

const APP = { clientId: 'client-abc', clientSecret: 'secret-xyz', authCallback: 'https://app.example/api/connectors/bigcommerce/auth' }
const READ = 'store_v2_orders_read_only store_v2_information_read_only users_basic_information'

function jwt(claims: Record<string, unknown>, secret = APP.clientSecret, alg = 'HS256'): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const h = enc({ typ: 'JWT', alg })
  const p = enc(claims)
  return `${h}.${p}.${createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`
}
const NOW = Date.parse('2026-11-05T12:00:00Z')
const t = Math.floor(NOW / 1000)
const claims = (over: Record<string, unknown> = {}) => ({ aud: APP.clientId, iss: 'bc', iat: t, nbf: t, exp: t + 86_400, jti: 'x', sub: 'stores/abc123', user: { id: 1, email: 'Owner@Store.test' }, owner: { id: 1, email: 'owner@store.test' }, ...over })

describe('BigCommerce app: install', () => {
  it('reads the store hash only from stores/{hash}', () => {
    expect(storeHashOf('stores/abc123')).toBe('abc123')
    for (const bad of ['stores/', 'abc123', 'stores/ABC', 'stores/abc/extra', undefined]) expect(storeHashOf(bad)).toBeNull()
  })

  it('treats only read scopes as read-only, and an empty grant as not', () => {
    expect(readOnlyScopes(READ.split(' '))).toBe(true)
    expect(readOnlyScopes(['store_v2_orders'])).toBe(false)
    expect(readOnlyScopes(['store_v2_orders_read_only', 'store_v2_products'])).toBe(false)
    expect(readOnlyScopes([])).toBe(false)
  })

  it('trades the code for the token with the registered callback, and keeps the installer email', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) })
      return new Response(JSON.stringify({ access_token: 'tok1234567890abcdefgh', scope: READ, context: 'stores/abc123', user: { id: 9, email: 'Owner@Store.test' } }), { status: 200 })
    }
    const out = await exchangeInstallCode(APP, { code: 'c0de', scope: READ, context: 'stores/abc123' }, fetch)
    expect(out).toEqual({ secret: { storeHash: 'abc123', accessToken: 'tok1234567890abcdefgh' }, scopes: READ.split(' '), userEmail: 'owner@store.test' })
    expect(calls[0]!.url).toBe(BIGCOMMERCE_TOKEN_URL)
    expect(calls[0]!.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ client_id: 'client-abc', client_secret: 'secret-xyz', code: 'c0de', context: 'stores/abc123', scope: READ, grant_type: 'authorization_code', redirect_uri: APP.authCallback })
  })

  it('refuses a grant that could write, before or after the exchange, without keeping the token', async () => {
    let called = 0
    const ok = (scope: string) => async () => (called++, new Response(JSON.stringify({ access_token: 'tok1234567890abcdefgh', scope, context: 'stores/abc123' }), { status: 200 }))
    await expect(exchangeInstallCode(APP, { code: 'c', scope: 'store_v2_orders', context: 'stores/abc123' }, ok(READ))).rejects.toThrow(BIGCOMMERCE_WRITE_SCOPE)
    expect(called).toBe(0)
    await expect(exchangeInstallCode(APP, { code: 'c', scope: READ, context: 'stores/abc123' }, ok(`${READ} store_v2_products`))).rejects.toThrow(BIGCOMMERCE_WRITE_SCOPE)
  })

  it('refuses a token for a different store, a missing token, and a failed exchange (without quoting the body)', async () => {
    const reply = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status })
    const q = { code: 'c', scope: READ, context: 'stores/abc123' }
    await expect(exchangeInstallCode(APP, q, reply({ access_token: 'tok', scope: READ, context: 'stores/other1' }))).rejects.toThrow(/different store/)
    await expect(exchangeInstallCode(APP, q, reply({ scope: READ, context: 'stores/abc123' }))).rejects.toThrow(/no access token/)
    await expect(exchangeInstallCode(APP, q, reply({ error: 'code c leaked' }, 400))).rejects.toThrow(/^BigCommerce token exchange HTTP 400$/)
    await expect(exchangeInstallCode(APP, { scope: READ, context: 'stores/abc123' }, reply({}))).rejects.toThrow(/missing/)
  })
})

describe('BigCommerce app: signed payload', () => {
  it('accepts a payload signed with the client secret and reads store and emails', () => {
    expect(verifySignedPayload(APP, jwt(claims()), NOW)).toEqual({ storeHash: 'abc123', userEmail: 'owner@store.test', ownerEmail: 'owner@store.test' })
  })

  it('refuses a bad signature, another app, another issuer, expiry, a future nbf, no store, or another algorithm', () => {
    expect(() => verifySignedPayload(APP, jwt(claims(), 'wrong'), NOW)).toThrow(/bad signature/)
    expect(() => verifySignedPayload(APP, jwt(claims({ aud: 'other' })), NOW)).toThrow(/another app/)
    expect(() => verifySignedPayload(APP, jwt(claims({ iss: 'evil' })), NOW)).toThrow(/not from BigCommerce/)
    expect(() => verifySignedPayload(APP, jwt(claims({ exp: t - 120 })), NOW)).toThrow(/expired/)
    expect(() => verifySignedPayload(APP, jwt(claims({ nbf: t + 600 })), NOW)).toThrow(/valid yet/)
    expect(() => verifySignedPayload(APP, jwt(claims({ sub: 'nope' })), NOW)).toThrow(/no store/)
    expect(() => verifySignedPayload(APP, jwt(claims(), APP.clientSecret, 'none'), NOW)).toThrow(/expected way/)
    expect(() => verifySignedPayload(APP, 'not.a-jwt', NOW)).toThrow()
  })
})
