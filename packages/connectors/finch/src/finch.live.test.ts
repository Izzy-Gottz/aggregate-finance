// Live Finch SANDBOX run (opt-in: AGFN_LIVE_TESTS=1). Keys come from the environment or the main checkout's
// git-ignored .env and are never printed; refuses unless FINCH_SANDBOX=1 (a sandbox app).
//   AGFN_LIVE_TESTS=1 npx vitest run --maxWorkers=1 packages/connectors/finch/src/finch.live.test.ts
// 1. begin() makes a real Connect session; its link opens (not "Link Inactive") and carries our state.
// 2. A sandbox connection (POST /sandbox/connections stands in for an employer finishing Connect) syncs, and every
//    pay run equals Finch's own /employer/payment answer to the cent.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryRawSink } from '@agfn/connector-sdk'
import type { NormalizedEvent, PayrollRun } from '@agfn/contracts'
import { createFinchConnector } from './connector.ts'

const live = process.env.AGFN_LIVE_TESTS === '1'
if (live && !process.env.FINCH_CLIENT_SECRET) {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()
  const envFile = join(dirname(common), '.env')
  if (existsSync(envFile)) process.loadEnvFile(envFile)
}
const ready = live && !!process.env.FINCH_CLIENT_ID && !!process.env.FINCH_CLIENT_SECRET && process.env.FINCH_SANDBOX === '1'
const API = 'https://api.tryfinch.com'

describe.runIf(ready)('live: Finch sandbox', () => {
  const oauth = { clientId: process.env.FINCH_CLIENT_ID!, clientSecret: process.env.FINCH_CLIENT_SECRET!, redirectUri: 'http://localhost:8787/api/connectors/finch/callback' }
  const basic = `Basic ${Buffer.from(`${oauth.clientId}:${oauth.clientSecret}`).toString('base64')}`

  it('Connect session: a working link with our state', async () => {
    const c = createFinchConnector({ deps: { raw: new MemoryRawSink() }, oauth, sandbox: 'finch' })
    const b = (await c.begin!({ workspaceId: 'ws_live', redirectUri: oauth.redirectUri, state: `st_${Date.now()}`, userRef: 'p' })) as { kind: string; url: string }
    expect(b.kind).toBe('oauth')
    const url = new URL(b.url)
    expect(url.host).toBe('connect.tryfinch.com')
    expect(url.searchParams.get('session')).toBeTruthy()
    expect(url.searchParams.get('state')).toMatch(/^st_/)
    const page = await fetch(url, { redirect: 'follow' })
    expect(page.status).toBe(200)
    expect(await page.text()).not.toMatch(/no longer active|link inactive/i)
  }, 60_000)

  it('sandbox connection: every pay run matches Finch to the cent', async () => {
    const made = await fetch(`${API}/sandbox/connections`, {
      method: 'POST',
      headers: { authorization: basic, 'content-type': 'application/json', 'finch-api-version': '2020-09-17' },
      body: JSON.stringify({ provider_id: 'gusto', products: ['company', 'directory', 'payment', 'pay_statement'], employee_size: 10 }),
    })
    expect(made.status, await made.clone().text().then((t) => t.slice(0, 200))).toBeLessThan(300)
    const { access_token: accessToken } = (await made.json()) as { access_token: string }
    const c = createFinchConnector({ deps: { raw: new MemoryRawSink() }, oauth })
    const conn = { id: 'conn_live', workspaceId: 'ws_live', connectorKey: 'finch', secret: { accessToken }, config: { providerId: 'gusto' } }
    const runs: PayrollRun[] = []
    let cursor: string | null = null
    for (let page = 0; page < 60; page++) {
      let r
      try {
        r = await c.sync(conn, cursor)
      } catch (e) {
        // A new connection's first pull can still be running at Finch, or the app is briefly rate limited.
        const err = e as { code?: string; kind?: string }
        if (err.code !== 'data_sync_in_progress' && err.kind !== 'rate_limited') throw e
        await new Promise((ok) => setTimeout(ok, 20_000))
        continue
      }
      runs.push(...r.events.filter((e: NormalizedEvent): e is PayrollRun => e.type === 'payroll.run'))
      cursor = r.cursor
      if (!r.hasMore) break
    }
    expect(runs.length).toBeGreaterThan(0)

    // The sync reads 730 days back and 31 ahead (scheduled runs).
    const today = new Date(Date.now() + 31 * 86_400_000).toISOString().slice(0, 10)
    const from = new Date(Date.now() - 730 * 86_400_000).toISOString().slice(0, 10)
    const truth = (await (await fetch(`${API}/employer/payment?start_date=${from}&end_date=${today}`, { headers: { authorization: `Bearer ${accessToken}`, 'finch-api-version': '2020-09-17' } })).json()) as Array<{ id: string; pay_date: string; gross_pay: { amount: number } | null; net_pay: { amount: number } | null; employer_taxes: { amount: number } | null }>
    const withTotals = truth.filter((p) => p.gross_pay && p.net_pay)
    expect(new Set(runs.map((r) => r.externalId))).toEqual(new Set(withTotals.map((p) => p.id)))
    for (const p of withTotals) {
      const r = runs.find((x) => x.externalId === p.id)!
      expect([r.payDate, r.gross.minor, r.net.minor], p.id).toEqual([p.pay_date, p.gross_pay!.amount, p.net_pay!.amount])
      if (p.employer_taxes?.amount) expect(r.employerTaxes.minor, p.id).toBe(p.employer_taxes.amount)
      // Providers that report employer taxes only per statement (Gusto in the sandbox) still get them.
      else if (r.lines?.length) expect(r.employerTaxes.minor, p.id).toBeGreaterThan(0)
    }
  }, 300_000)
})
