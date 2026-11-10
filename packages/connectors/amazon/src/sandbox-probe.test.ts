import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runSandboxProbe, SANDBOX_CALLS, SANDBOX_ENDPOINT } from './sandbox-probe.ts'

const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/amazon-sandbox.json', import.meta.url), 'utf8')) as { groups: unknown; events: unknown }
const env = { FLY_APP_NAME: 'aggregate-stg', AMAZON_SPAPI_SANDBOX_CLIENT_ID: 'id-sample', AMAZON_SPAPI_SANDBOX_CLIENT_SECRET: 'secret-sample', AMAZON_SPAPI_SANDBOX_REFRESH_TOKEN: 'Atzr|refresh-sample' }

function sandbox(calls: Array<{ url: string; method: string }>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET' })
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
    if (url === 'https://api.amazon.com/auth/o2/token') return json({ access_token: 'Atza|access-sample', expires_in: 3600 })
    if (url === SANDBOX_ENDPOINT + SANDBOX_CALLS.groups) return json(fx.groups)
    if (url === SANDBOX_ENDPOINT + SANDBOX_CALLS.events) return json(fx.events)
    return json({ errors: [{ code: 'InvalidInput' }] }, 400)
  }) as typeof fetch
}

describe('Amazon sandbox probe', () => {
  it('reads the static sandbox end to end, GET only past the token, and prints no token', async () => {
    const calls: Array<{ url: string; method: string }> = []
    const lines = await runSandboxProbe(env, sandbox(calls))
    expect(lines.every((l) => l.ok)).toBe(true)
    expect(lines.map((l) => l.step)).toEqual(['lwa token', 'settlement list', 'settlement events', 'reader'])
    expect(calls.filter((c) => c.method !== 'GET').map((c) => c.url)).toEqual(['https://api.amazon.com/auth/o2/token'])
    expect(JSON.stringify(lines)).not.toMatch(/Atz[ar]\||secret-sample/)
  })

  it('refuses to run anywhere but staging', async () => {
    const calls: Array<{ url: string; method: string }> = []
    const lines = await runSandboxProbe({ ...env, FLY_APP_NAME: 'aggregate-finance' }, sandbox(calls))
    expect(lines).toEqual([{ step: 'staging', ok: false, detail: 'refused: this probe runs on staging only' }])
    expect(calls).toEqual([])
  })

  it('runs on staging off Fly too (by its address), and still refuses live there', async () => {
    const offFly = { ...env, FLY_APP_NAME: undefined }
    const calls: Array<{ url: string; method: string }> = []
    expect(await runSandboxProbe({ ...offFly, BASE_URL: 'https://app.aggregate.finance' }, sandbox(calls))).toEqual([{ step: 'staging', ok: false, detail: 'refused: this probe runs on staging only' }])
    expect(await runSandboxProbe(offFly, sandbox(calls))).toEqual([{ step: 'staging', ok: false, detail: 'refused: this probe runs on staging only' }])
    expect(calls).toEqual([])
    const lines = await runSandboxProbe({ ...offFly, BASE_URL: 'https://staging.aggregate.finance' }, sandbox(calls))
    expect(lines[0]?.step).not.toBe('staging')
    expect(calls.length).toBeGreaterThan(0)
  })

  it('stops without the sandbox credentials', async () => {
    const lines = await runSandboxProbe({ FLY_APP_NAME: 'aggregate-stg' }, sandbox([]))
    expect(lines[0]).toMatchObject({ step: 'credentials', ok: false })
  })

  it('reports a refused call from the status alone', async () => {
    const f = (async (input: RequestInfo | URL) => (String(input).includes('auth/o2') ? new Response(JSON.stringify({ access_token: 'x' })) : new Response('{"errors":[{"message":"internal detail"}]}', { status: 403 }))) as typeof fetch
    const lines = await runSandboxProbe(env, f)
    expect(lines.at(-1)).toMatchObject({ step: 'settlement list', ok: false })
    expect(JSON.stringify(lines)).not.toContain('internal detail')
  })
})
