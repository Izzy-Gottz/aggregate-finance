// Live Plaid SANDBOX test (opt-in). Runs only with AGFN_LIVE_TESTS=1, so CI and other sessions' `npm test` never hit
// the network. Keys come from the environment, or from the repo's git-ignored .env (main checkout) when
// AGFN_LIVE_TESTS=1 and PLAID_SECRET isn't already set. Keys are never printed, logged or written anywhere.
//   AGFN_LIVE_TESTS=1 npx vitest run packages/connectors/plaid/src/plaid.sandbox.test.ts

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AccountUpsert, BalanceSnapshot, ConnectionRef, NormalizedEvent, TxnUpsert } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertValidEvents } from '@agfn/connector-sdk/testing'
import { createPlaidConnector } from './index.ts'

const live = process.env.AGFN_LIVE_TESTS === '1'

if (live && !process.env.PLAID_SECRET) {
  // The .env lives in the main checkout; worktrees share its git dir.
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()
  const envFile = join(dirname(common), '.env')
  if (existsSync(envFile)) process.loadEnvFile(envFile)
}

const ready = live && !!process.env.PLAID_CLIENT_ID && !!process.env.PLAID_SECRET && (process.env.PLAID_ENV ?? 'sandbox') === 'sandbox'

describe.runIf(ready)('plaid sandbox (live)', () => {
  it('links a sandbox Item, syncs accounts, balances and transactions, then removes it', async () => {
    const raw = new MemoryRawSink()
    const plaid = createPlaidConnector(
      { clientId: process.env.PLAID_CLIENT_ID ?? '', secret: process.env.PLAID_SECRET ?? '', env: 'sandbox' },
      { raw },
    )
    const publicToken = await plaid.sandboxPublicToken('ins_109508', ['transactions'])
    const { secret, config } = await plaid.connect({ publicToken })
    const conn: ConnectionRef = { id: 'conn_live', workspaceId: 'ws_live', connectorKey: 'plaid', secret, config }
    try {
      expect(await plaid.health(conn)).toMatchObject({ status: 'ok' })

      // Sandbox transactions take a few seconds to be ready; poll whole sync cycles until they arrive.
      const all: NormalizedEvent[] = []
      let cursor: string | null = null
      for (let i = 0; i < 20 && !all.some((e) => e.type === 'txn.upsert'); i++) {
        const r = await runSync(plaid, conn, cursor)
        all.push(...r.events)
        cursor = r.cursor
        if (!all.some((e) => e.type === 'txn.upsert')) await new Promise((res) => setTimeout(res, 3000))
      }

      const latest = new Map(all.map((e) => [e.type + '\0' + e.externalId, e]))
      const events = [...latest.values()]
      assertValidEvents(events, { connectionId: conn.id })

      const accounts = events.filter((e): e is AccountUpsert => e.type === 'account.upsert')
      const balances = events.filter((e): e is BalanceSnapshot => e.type === 'balance.snapshot')
      const txns = events.filter((e): e is TxnUpsert => e.type === 'txn.upsert')
      expect(accounts.length).toBeGreaterThan(0)
      expect(balances.length).toBeGreaterThan(0)
      expect(txns.length).toBeGreaterThan(0)
      expect(accounts.some((a) => a.accountType === 'depository')).toBe(true)
      // Every balance and transaction references an account we emitted, amounts are integer minor units.
      const ids = new Set(accounts.map((a) => a.externalId))
      for (const t of txns) expect(ids.has(t.accountExternalId)).toBe(true)
      for (const b of balances) expect(Number.isSafeInteger(b.current.minor)).toBe(true)
      expect(raw.records.size).toBeGreaterThan(0)
    } finally {
      await plaid.removeItem(conn)
    }
  }, 120_000)

  it('reconnects a broken login in update mode on the same Item, and reads live balances', async () => {
    const plaid = createPlaidConnector(
      { clientId: process.env.PLAID_CLIENT_ID ?? '', secret: process.env.PLAID_SECRET ?? '', env: 'sandbox', consentedProducts: ['investments', 'liabilities'] },
      { raw: new MemoryRawSink() },
    )
    // A new-link token with Transactions required and the extras consented must be accepted by Plaid.
    expect((await plaid.createLinkToken({ clientUserId: 'agfn-live-test' })).linkToken).toMatch(/^link-sandbox-/)
    const { secret, config } = await plaid.connect({ publicToken: await plaid.sandboxPublicToken('ins_109508', ['transactions']) })
    const conn: ConnectionRef = { id: 'conn_live_2', workspaceId: 'ws_live', connectorKey: 'plaid', secret, config }
    try {
      const live = await plaid.refreshBalances(conn)
      expect(live.length).toBeGreaterThan(0)
      expect(live.every((e) => e.type === 'balance.snapshot')).toBe(true)

      // Break the login, then make an update-mode token for the SAME Item (empty products list), with and without
      // account selection.
      await plaid.client.call('/sandbox/item/reset_login', { access_token: (secret as { accessToken: string }).accessToken })
      expect(await plaid.health(conn)).toMatchObject({ status: 'needs_reauth' })
      const begin = await plaid.begin({ workspaceId: 'ws_live', redirectUri: 'https://example.com/cb', state: 's', userRef: 'agfn-live-test', connection: conn })
      expect(begin).toMatchObject({ kind: 'link_widget', token: expect.stringMatching(/^link-sandbox-/) })
      const withSelection = await plaid.begin({ workspaceId: 'ws_live', redirectUri: 'https://example.com/cb', state: 's', userRef: 'agfn-live-test', connection: conn, accountSelection: true })
      expect(withSelection).toMatchObject({ kind: 'link_widget' })
    } finally {
      await plaid.removeItem(conn)
    }
  }, 120_000)
})
