// Coinbase through the real ledger, worked by hand: the USD wallet reconciles to Coinbase's balance, the money moved
// into crypto is an asset (not spending), rewards are income, and crypto is never cash.
import { readFileSync } from 'node:fs'
import type { ConnectionRef } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { fakeClock, fixtureFetch } from '@agfn/connector-sdk/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { makeKit, snapshot, txn, usd, type Kit } from '../../../core/src/test-kit.ts'
import { createCoinbaseConnector, type CoinbaseSecret } from './connector.ts'

const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/coinbase.json', import.meta.url), 'utf8')) as {
  accounts: Record<string, unknown>
  rates: unknown
  transactions: Record<string, unknown>
}
const NOW = Date.parse('2026-10-14T12:00:00Z')

describe.each(['memory', 'sqlite'] as const)('coinbase into the ledger (%s)', (backend) => {
  let k: Kit
  afterEach(async () => k.close())

  it('USD wallet matches Coinbase to the cent; 480.00 net into crypto is Other assets; $10 rewards are income; no crypto in cash', async () => {
    k = await makeKit(backend, { now: '2026-10-14T12:00:00.000Z' })
    const me = await k.personal('Test Holder')
    const connId = await k.connection({ entityId: me, key: 'coinbase' })
    const cb = createCoinbaseConnector({
      deps: {
        raw: new MemoryRawSink(),
        fetch: fixtureFetch([
          { match: (u) => u.pathname === '/v2/accounts', respond: (u) => ({ json: fx.accounts[u.searchParams.get('starting_after') ?? ''] }) },
          { match: (u) => u.pathname === '/v2/exchange-rates', respond: { json: fx.rates } },
          { match: (u) => u.pathname === '/v2/accounts/acct-usd/transactions', respond: (u) => ({ json: fx.transactions[u.searchParams.get('starting_after') ?? ''] }) },
        ]).fetch,
        clock: fakeClock(NOW),
        random: () => 0.5,
      },
      oauth: { clientId: 'x', clientSecret: 'y', redirectUri: 'https://app.example.com/api/connectors/coinbase/callback' },
    })
    const conn: ConnectionRef = { id: connId, workspaceId: k.ws, connectorKey: 'coinbase', secret: { kind: 'oauth', tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: NOW + 3_600_000 } } satisfies CoinbaseSecret, config: {} }
    // The person's bank, where the $1,000 came from.
    const bank = await k.account({ entityId: me, name: 'Checking' })
    await k.engine.postBatch(k.ws, [
      snapshot(bank, '2026-10-01', 500_000),
      txn(bank, '2026-10-03', -100_000, { counterparty: 'Coinbase', rawText: 'COINBASE.COM TRANSFER' }),
      snapshot(bank, '2026-10-04', 400_000),
      // The Apple Pay buy, as the bank shows it.
      txn(bank, '2026-10-09', -10_000, { counterparty: 'Coinbase', rawText: 'COINBASE.COM APPLE PAY' }),
      snapshot(bank, '2026-10-10', 390_000),
    ])
    await k.engine.postBatch(k.ws, (await runSync(cb, conn, null)).events)

    const accounts = (await k.engine.directory.listSourceAccounts(k.ws)).filter((a) => a.connectionId === connId)
    const usdWallet = accounts.find((a) => a.externalId === 'acct-usd')
    expect(usdWallet).toMatchObject({ accountType: 'crypto', currency: 'USD', includeInCash: false })
    expect(accounts.filter((a) => a.currency === 'XXX').map((a) => a.name).sort()).toEqual(['Coinbase BTC', 'Coinbase ETH', 'Coinbase USDC'])
    for (const a of accounts) if (!a.entityId) await k.assign(a.id, me)

    // 1,000 in − 500 bought + 120 sold + 10 rewards (+ 100 paid in − 100 bought) = 630.00, as Coinbase says. The pending
    // withdrawal isn't booked yet.
    expect(await k.bal(me, `cash:${usdWallet?.id}`)).toBe(630_00)
    expect(await k.bal(me, 'other_assets')).toBe(480_00)
    expect(await k.bal(me, 'interest_income')).toBe(-10_00)
    expect(await k.bal(me, 'uncategorized_expense')).toBe(0)
    // The $1,000 from the bank and the Apple Pay $100 each meet their Coinbase row as one transfer: nothing left in
    // transit, nothing asked.
    expect((await k.engine.store.listLinks(k.ws, { types: ['transfer'] })).map((l) => [l.status, l.amount?.minor]).sort()).toEqual([['confirmed', 100_000], ['confirmed', 10_000]].sort())
    expect(await k.bal(me, 'clearing_transfers')).toBe(0)
    expect(await k.bal(me, 'suspense')).toBe(0)
    expect(await k.tb(me)).toBe(0)
    const cash = await k.engine.metric('cash', { workspaceId: k.ws, entityIds: [me] })
    expect(cash.value).toEqual(usd(390_000))
    const failed = (await k.engine.checks(k.ws, { entityIds: [me] })).filter((c) => c.status === 'fail' && accounts.some((a) => a.id === c.subjectId))
    expect(failed).toEqual([])
  })
})
