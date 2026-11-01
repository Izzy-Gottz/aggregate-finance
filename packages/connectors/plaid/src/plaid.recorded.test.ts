// Contract test on responses RECORDED from Plaid Sandbox (scripts/record-plaid.ts), redacted.
// Complements sandbox-item.json (hand-built edge cases) with Plaid's real shapes.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AccountUpsert, BalanceSnapshot, ConnectionRef, TxnUpsert } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract } from '@agfn/connector-sdk/testing'
import { createPlaidConnector } from './index.ts'

const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/sandbox-recorded.json', import.meta.url), 'utf8')) as Record<string, unknown> & {
  sync_pages: Record<string, unknown>
}

/** Serves /investments/transactions/get like Plaid: filtered by the date window, paged by offset/count. */
function invResponder(data: unknown) {
  const all = data as { investment_transactions: Array<{ date: string }>; [k: string]: unknown }
  return (_u: URL, body: unknown) => {
    const b = body as { start_date: string; end_date: string; options?: { count?: number; offset?: number } }
    const rows = all.investment_transactions.filter((t) => t.date >= b.start_date && t.date <= b.end_date)
    const off = b.options?.offset ?? 0
    const n = b.options?.count ?? 100
    return { json: { ...all, investment_transactions: rows.slice(off, off + n), total_investment_transactions: rows.length } }
  }
}

const conn: ConnectionRef = {
  id: 'conn_rec',
  workspaceId: 'ws1',
  connectorKey: 'plaid',
  secret: { accessToken: 'access-sandbox-redacted-2', itemId: 'item_rec' },
  config: { itemId: 'item_rec', institution: 'First Platypus Bank', products: ['liabilities', 'investments'] },
}

function make() {
  const f = fixtureFetch([
    { match: '/accounts/get', respond: { json: fx.accounts_get } },
    { match: '/liabilities/get', respond: { json: fx.liabilities_get } },
    { match: '/investments/holdings/get', respond: { json: fx.holdings_get } },
    { match: '/investments/transactions/get', respond: invResponder(fx.inv_txns) },
    { match: '/item/get', respond: { json: fx.item_get } },
    { match: '/transactions/sync', respond: (_u, body) => ({ json: fx.sync_pages[String((body as { cursor?: string }).cursor ?? '')] }) },
  ])
  return { connector: createPlaidConnector({ clientId: 'c', secret: 's', env: 'sandbox', pageSize: 25 }, { raw: new MemoryRawSink(), fetch: f.fetch, clock: fakeClock() }), conn }
}

describe('plaid on recorded sandbox data', () => {
  it('fixture is redacted', () => {
    assertRedacted(fx, [/^access-sandbox/])
  })

  it('passes the connector contract', async () => {
    const report = await runConnectorContract({ make, minEvents: 30 })
    const txns = report.events.filter((e): e is TxnUpsert => e.type === 'txn.upsert')
    expect(txns.length).toBeGreaterThan(10)
    expect(txns.some((t) => t.amount.minor > 0)).toBe(true)
    expect(txns.some((t) => t.amount.minor < 0)).toBe(true)
  })

  it('maps every liability type Plaid returns, including installment loans', async () => {
    const { events } = await runSync(make().connector, conn, null)
    const accounts = events.filter((e): e is AccountUpsert => e.type === 'account.upsert')
    const kinds = new Set(accounts.map((a) => a.liability?.kind).filter(Boolean))
    expect(kinds).toEqual(new Set(['credit', 'mortgage', 'student', 'other']))
    // Every loan and card balance is negative (owed); every depository balance is >= 0.
    const typeOf = new Map(accounts.map((a) => [a.externalId, a.accountType]))
    for (const b of events.filter((e): e is BalanceSnapshot => e.type === 'balance.snapshot')) {
      const t = typeOf.get(b.accountExternalId)
      if (t === 'loan' || t === 'credit_card') expect(b.current.minor).toBeLessThanOrEqual(0)
      if (t === 'depository') expect(b.current.minor).toBeGreaterThanOrEqual(0)
    }
    expect(events.some((e) => e.type === 'balance.snapshot' && (e.holdings?.length ?? 0) > 0)).toBe(true)
  })
})
