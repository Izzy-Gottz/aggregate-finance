// The "silent empty result" class (SimpleFIN, 2026-11-04): a 2xx response that isn't the data we asked for must fail
// visibly in the shared client, never reach a connector as something it can read as "no rows". These pin the four
// shapes at the HttpClient chokepoint, so every connector inherits the first two guarantees for free.
import { describe, expect, it } from 'vitest'
import { ConnectorError, HttpClient } from './index.ts'

const client = (fetchFn: (input: string, init?: RequestInit) => Promise<Response>) =>
  new HttpClient({ provider: 'test', baseUrl: 'https://api.example.com', fetch: fetchFn, retry: { maxAttempts: 1 } })

const respond = (body: BodyInit | null, init: ResponseInit = {}) => async () => new Response(body, { status: 200, ...init })

describe('HttpClient: unreadable 2xx responses fail, never parse as empty', () => {
  it('a 200 with an HTML body throws (a sign-in or error page, not data)', async () => {
    const c = client(respond('<!doctype html><title>Sign in</title>', { headers: { 'content-type': 'text/html' } }))
    const err = await c.request({ path: '/accounts' }).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(ConnectorError)
    expect((err as ConnectorError).message).toMatch(/non-JSON/i)
    expect((err as ConnectorError).message).not.toContain('Sign in') // the body is never echoed
  })

  it('a 200 reached by a followed redirect to an HTML page throws', async () => {
    // fetch follows 3xx by default, so a connector sees the final 200 + HTML; same failure as above.
    const c = client(async () => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    await expect(c.request({ path: '/transactions' })).rejects.toBeInstanceOf(ConnectorError)
  })

  it('a 200 with a plain-text (non-JSON) body throws', async () => {
    const c = client(respond('Service Unavailable', { headers: { 'content-type': 'text/plain' } }))
    await expect(c.request({ path: '/accounts' })).rejects.toBeInstanceOf(ConnectorError)
  })

  it('an empty 200 body is null, so a connector must treat it as unreadable, not as rows', async () => {
    const c = client(respond(''))
    const res = await c.request({ path: '/accounts' })
    expect(res.data).toBeNull()
  })

  it('a 200 with valid JSON but the wrong shape is returned as-is, for the connector to reject', async () => {
    const c = client(respond(JSON.stringify({}), { headers: { 'content-type': 'application/json' } }))
    const res = await c.request<Record<string, unknown>>({ path: '/accounts' })
    expect(res.data).toEqual({}) // no list key; the connector's own check must throw on this
  })
})
