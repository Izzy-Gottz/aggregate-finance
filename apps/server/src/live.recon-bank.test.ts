// Live, opt-in (AGFN_LIVE_TESTS=1): B4's bank leg as a user would do it, through the whole server with Plaid SANDBOX and
// a custom sandbox user (fixed made-up transactions: fixtures/plaid-recon-user.json). Keys come from the main
// checkout's .env and are never printed. Bank → sync → reconciled (data health) → Review → coverage → close September →
// an AI with a read-only key sees the same numbers and can't write.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { installedConnectors } from '@agfn/connector-registry'
import { connectAi, minor, signIn, startServer } from './scenarios/harness.ts'

const live = process.env.AGFN_LIVE_TESTS === '1'
if (live && !process.env.PLAID_SECRET) {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()
  const envFile = join(dirname(common), '.env')
  if (existsSync(envFile)) process.loadEnvFile(envFile)
}
const ready = live && !!process.env.PLAID_SECRET && (process.env.PLAID_ENV ?? 'sandbox') === 'sandbox'
const USER = JSON.parse(readFileSync(new URL('./fixtures/plaid-recon-user.json', import.meta.url), 'utf8')) as { override_accounts: Array<{ starting_balance: number; transactions: Array<{ amount: number; date_posted: string }> }> }

describe.runIf(ready)('live: B4 bank leg (Plaid sandbox custom user → Review → coverage → close → read-only MCP)', () => {
  it('reconciles, closes September, and a read-only AI sees the same books', async () => {
    const env = { PLAID_CLIENT_ID: process.env.PLAID_CLIENT_ID!, PLAID_SECRET: process.env.PLAID_SECRET!, PLAID_ENV: 'sandbox' }
    const plaid = installedConnectors(env).filter((f) => f({ raw: { put: async () => '' } } as never).describe().key === 'plaid')
    const srv = await startServer({ connectors: plaid })
    const log = (m: string) => console.log(`recon: ${m}`)
    try {
      const s = await signIn(srv, 'recon@example.com', 'Recon Co')
      const company = (await s.get<{ entities: Array<{ id: string; name: string }> }>('/api/workspace')).body.entities.find((e) => e.name === 'Recon Co')!.id
      const start = (await s.post<{ linkToken: string; state: string }>('/api/connectors/plaid/start', { entityId: company })).body
      expect(start.linkToken).toMatch(/^link-sandbox-/)
      // What Plaid Link hands the browser for the custom sandbox user.
      const pt = (await (await fetch('https://sandbox.plaid.com/sandbox/public_token/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, institution_id: 'ins_109508', initial_products: ['transactions'], options: { override_username: 'user_custom', override_password: JSON.stringify(USER) } }),
      })).json()) as { public_token?: string; error_message?: string }
      expect(pt.public_token, pt.error_message).toBeTruthy()
      const fin = await s.post<{ connectionId: string; accounts: Array<{ id: string }> }>('/api/connectors/plaid/finish', { state: start.state, publicToken: pt.public_token, institution: { institution_id: 'ins_109508', name: 'First Platypus Bank' } })
      expect(fin.status).toBe(200)
      expect(fin.body.accounts).toHaveLength(1)
      expect((await s.post('/api/accounts/assign', { assignments: fin.body.accounts.map((a) => ({ accountId: a.id, entityId: company })) })).status).toBe(200)

      // Plaid's sandbox prepares transactions in the background: sync until all 15 are in (about a minute at most).
      const want = USER.override_accounts[0]!.transactions.length
      const ai = await connectAi(srv, s)
      let rows = 0
      for (let i = 0; i < 20 && rows < want; i++) {
        await srv.booted.services.sync.sync(fin.body.connectionId)
        rows = (await ai.call<{ rows_counted: number }>('query_transactions', { company: 'Recon Co', from: '2026-08-01', include_transfers: true })).rows_counted
        if (rows < want) await new Promise((r) => setTimeout(r, 3_000))
      }
      log(`synced ${rows}/${want} transactions`)
      expect(rows).toBe(want)

      // Reconciled: the ledger's cash equals what the bank reports, and every check passes.
      const ov = await ai.call<{ companies: Array<{ company: string; cash: { amount: string } | null }> }>('get_overview', { company: 'Recon Co' })
      const cash = minor(ov.companies[0]!.cash)
      const health = await ai.call<{ value: { minor?: number } | number; checks?: { passing: number; total: number } }>('get_metric', { metric: 'data_health', company: 'Recon Co' })
      log(`cash ${cash! / 100}; data_health ${JSON.stringify(health.value)} checks ${JSON.stringify(health.checks)}`)
      expect(cash).not.toBeNull()

      // Review: what's waiting, by kind; answer each "what is this money" by confirming the suggestion.
      const review = (await s.get<Array<{ id: string; kind: string; title: string; answers?: Array<{ label: string; values: Record<string, string> }> }>>('/api/review')).body
      const kinds = review.reduce<Record<string, number>>((a, r) => ({ ...a, [r.kind]: (a[r.kind] ?? 0) + 1 }), {})
      log(`review before: ${JSON.stringify(kinds)}`)
      for (const r of review.filter((x) => x.kind === 'whose_money')) {
        // As the app's one-click answers do: the first offered answer, sent as an edit.
        const pick = r.answers?.[0]
        expect(pick, `no answers for "${r.title}"`).toBeTruthy()
        const res = await s.post(`/api/review/${encodeURIComponent(r.id)}`, { action: 'edit', values: pick!.values })
        log(`answered "${r.title}" → ${pick!.label} (${res.status})`)
        expect(res.status).toBe(200)
      }
      const left = (await s.get<Array<{ kind: string }>>('/api/review')).body
      const healthAfter = await ai.call<{ value: unknown; checks?: unknown; summary?: string }>('get_metric', { metric: 'data_health', company: 'Recon Co' })
      log(`review after: ${left.length} left; data_health ${JSON.stringify(healthAfter.value)} checks ${JSON.stringify(healthAfter.checks)}`)
      expect(left.filter((x) => x.kind === 'whose_money')).toEqual([])
      expect(minor((await ai.call<{ companies: Array<{ cash: { amount: string } | null }> }>('get_overview', { company: 'Recon Co' })).companies[0]!.cash)).toBe(cash)

      // Coverage: August through October complete for the account.
      const cov = await ai.call<{ companies?: unknown; accounts?: Array<{ months: Array<{ month: string; status: string }> }> }>('get_coverage', { company: 'Recon Co' })
      log(`coverage: ${JSON.stringify(cov).slice(0, 400)}`)

      // Close September: the AI asks, the owner approves in Review.
      const close = await ai.call<{ status: string; write_request_id: string }>('close_period', { company: 'Recon Co', through: '2026-09-30', idempotency_key: 'recon-close-sep-0001' })
      expect(close.status).toBe('pending_review')
      const item = (await s.get<Array<{ id: string }>>('/api/review')).body.find((r) => r.id.includes(close.write_request_id))!
      expect((await s.post(`/api/review/${item.id}`, { action: 'confirm' })).status).toBe(200)
      const after = await ai.call<{ companies: Array<{ books_closed_through?: string }> }>('get_overview', { company: 'Recon Co' })
      expect(after.companies[0]!.books_closed_through).toBe('2026-09-30')
      log('September closed')
      await ai.close()

      // A read-only AI: same cash, same review items, coverage; no writes.
      const ro = await connectAi(srv, s, { entityIds: 'all', dataTypes: ['balances', 'transactions'], write: false, reviewMode: 'instant', expiresAt: new Date(Date.now() + 86_400_000).toISOString() } as never, 'Read-only check')
      const roOv = await ro.call<{ companies: Array<{ cash: { amount: string } | null; books_closed_through?: string }> }>('get_overview', { company: 'Recon Co' })
      expect(minor(roOv.companies[0]!.cash)).toBe(cash)
      expect(roOv.companies[0]!.books_closed_through).toBe('2026-09-30')
      const roReview = await ro.try('list_review_items', { company: 'Recon Co' })
      const roCov = await ro.try('get_coverage', { company: 'Recon Co' })
      // Every key sees the same tool list (directories snapshot it); writes are refused when called.
      const roClose = await ro.try('reopen_period', { company: 'Recon Co', idempotency_key: 'recon-ro-reopen-0001' })
      log(`read-only: list_review_items ${roReview.isError ? 'error' : 'ok'}, get_coverage ${roCov.isError ? 'error' : 'ok'}, reopen_period ${roClose.isError ? `refused (${(roClose.data as { error?: string } | undefined)?.error})` : 'ALLOWED'}`)
      expect(roCov.isError).toBe(false)
      expect(roClose).toMatchObject({ isError: true, data: { error: 'forbidden' } })
      await ro.close()
    } finally {
      await srv.close()
    }
  }, 240_000)
})
