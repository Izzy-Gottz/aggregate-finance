// Plaid SANDBOX matrix through the real server (opt-in: AGFN_LIVE_TESTS=1). Each persona and product is linked,
// synced, and its numbers read back over REST (as the UI and agents do) and MCP, then compared with what Plaid itself
// returns, to the cent. Refuses to run unless PLAID_ENV=sandbox and the client points at sandbox.plaid.com. Keys come
// from the environment or the main checkout's git-ignored .env and are never printed.
//   AGFN_LIVE_TESTS=1 npx vitest run --maxWorkers=1 apps/server/src/live.plaid-matrix.test.ts
//
// Plaid cannot reach a local server, so /sandbox/item/fire_webhook is fired for real and the same body is then
// delivered to /api/webhooks/plaid: first unsigned (refused), then with the signature check stood down for that one
// delivery. The JWT check itself is covered by packages/connectors/plaid (plaid.test.ts).

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPlaidConnector, type PlaidConnector } from '@agfn/connector-plaid'
import { plaidFromEnv } from '@agfn/connector-registry'
import { unseal } from '@agfn/security'
import { SECRET_PURPOSE, type ConnectorFactory } from '@agfn/sync'
import { withBypass } from '@agfn/db'
import { connectAi, minor, signIn, startServer, type Ai, type Server, type Session } from './scenarios/harness.ts'

const live = process.env.AGFN_LIVE_TESTS === '1'
if (live && !process.env.PLAID_SECRET) {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()
  const envFile = join(dirname(common), '.env')
  if (existsSync(envFile)) process.loadEnvFile(envFile)
}
const ready = live && !!process.env.PLAID_CLIENT_ID && !!process.env.PLAID_SECRET && process.env.PLAID_ENV === 'sandbox'
const INSTITUTION = { institution_id: 'ins_109508', name: 'First Platypus Bank' }

interface PlaidAccount { account_id: string; type: string; subtype: string | null; balances: { current: number | null; iso_currency_code: string | null } }
interface PlaidTxn { transaction_id: string; account_id: string; amount: number; pending: boolean }

let server: Server | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

/** Every Plaid call in this file (the server's and the test's own) goes through this: sandbox.plaid.com or nothing. */
const sandboxOnly: typeof fetch = (input, init) => {
  const host = new URL(input instanceof Request ? input.url : String(input)).host
  if (host !== 'sandbox.plaid.com') throw new Error(`refusing a non-sandbox Plaid host: ${host}`)
  return fetch(input, init)
}

/** Set while the test hands the server a webhook body Plaid fired but could not deliver here. */
let trustNextWebhook = false

interface World {
  server: Server
  s: Session
  ai: Ai
  companyId: string
  connectionId: string
  accessToken: string
  direct: PlaidConnector
  rest<T>(path: string): Promise<T>
  sync(): Promise<{ status: string }>
}

async function world(persona: string, products: string[]): Promise<World> {
  const env = { PLAID_CLIENT_ID: process.env.PLAID_CLIENT_ID, PLAID_SECRET: process.env.PLAID_SECRET, PLAID_ENV: 'sandbox' }
  const real = plaidFromEnv(env)!
  const plaid: ConnectorFactory = (deps) => {
    const c = real({ ...deps, fetch: sandboxOnly }) as PlaidConnector
    return { ...c, webhook: { ...c.webhook, verify: async (req: Parameters<PlaidConnector['webhook']['verify']>[0]) => (trustNextWebhook ? undefined : c.webhook.verify(req)) } }
  }
  server = await startServer({ connectors: [plaid] })
  const direct = createPlaidConnector({ clientId: env.PLAID_CLIENT_ID!, secret: env.PLAID_SECRET!, env: 'sandbox' }, { raw: { put: async () => '' }, fetch: sandboxOnly })

  const email = `${persona}.${products.join('-')}@example.com`
  const s = await signIn(server, email, 'Testco')
  await withPasskey(server, s.personId)
  const companyId = (await s.get<{ entities: Array<{ id: string; kind: string }> }>('/api/workspace')).body.entities.find((e) => e.kind !== 'personal')!.id

  const start = await s.post<{ kind: string; linkToken: string; state: string }>('/api/connectors/plaid/start', { entityId: companyId })
  expect(start.body).toMatchObject({ kind: 'plaid_link', linkToken: expect.stringMatching(/^link-sandbox-/) })
  const publicToken = await direct.sandboxPublicToken(INSTITUTION.institution_id, products, { username: persona })
  const fin = await s.post<{ connectionId: string; accounts: Array<{ id: string }> }>('/api/connectors/plaid/finish', { state: start.body.state, publicToken, institution: INSTITUTION, accounts: [], linkSessionId: `matrix-${persona}` })
  expect(fin.status).toBe(200)
  const { connectionId, accounts } = fin.body
  expect((await s.post('/api/accounts/assign', { assignments: accounts.map((a) => ({ accountId: a.id, entityId: companyId })) })).status).toBe(200)

  const sv = server.booted.services
  const row = await withBypass('test:secret', () => sv.db.selectFrom('connections').select(['secret_enc', 'workspace_id']).where('id', '=', connectionId).executeTakeFirstOrThrow())
  const { accessToken } = unseal(sv.keys, row.secret_enc!, { workspaceId: row.workspace_id, recordId: connectionId, purpose: SECRET_PURPOSE }) as { accessToken: string }

  const ai = await paced(await connectAi(server, s, { entityIds: [companyId], dataTypes: ['balances', 'transactions'], write: false, reviewMode: 'instant', expiresAt: new Date(Date.now() + 86_400_000).toISOString() }, 'Matrix bot'))
  const app = server.app
  return {
    server,
    s,
    ai,
    companyId,
    connectionId,
    accessToken,
    direct,
    rest: async <T>(path: string) => {
      let res = await app.request(path, { headers: { authorization: `Bearer ${ai.key}` } })
      for (let i = 0; res.status === 429 && i < 3; i++) {
        await wait((Number(res.headers.get('retry-after')) || 30) * 1000)
        res = await app.request(path, { headers: { authorization: `Bearer ${ai.key}` } })
      }
      expect(res.status, path).toBe(200)
      const body = (await res.json()) as { data?: T } & T
      return body.data ?? body
    },
    sync: () => withBypass('worker:connection.sync', () => sv.sync.sync(connectionId)) as Promise<{ status: string }>,
  }
}

/** Agent keys get 120 reads a minute; this file reads a lot, so it waits out the limit the way an agent should. */
async function paced(ai: Ai): Promise<Ai> {
  const call = ai.call.bind(ai)
  return Object.assign(ai, {
    async call<T>(tool: string, args?: Record<string, unknown>): Promise<T> {
      for (let i = 0; ; i++) {
        try {
          return await call<T>(tool, args)
        } catch (e) {
          const s = /try again in (\d+)s/.exec(String(e))
          if (!s || i >= 3) throw e
          await wait((Number(s[1]) + 1) * 1000)
        }
      }
    },
  })
}

async function withPasskey(server: Server, personId: string): Promise<void> {
  await withBypass('test:passkey', async () => {
    const db = server.booted.services.db
    const p = await db.selectFrom('people').select(['id', 'auth_user_id']).where('id', '=', personId).executeTakeFirstOrThrow()
    const anyDb = db as unknown as import('kysely').Kysely<Record<string, Record<string, unknown>>>
    await anyDb.insertInto('passkey').values({ id: `pk_${p.id}`, name: 'Mac', publicKey: 'x', userId: p.auth_user_id, credentialID: `cred_${p.id}`, counter: 0, deviceType: 'singleDevice', backedUp: 0, transports: 'internal', createdAt: new Date().toISOString() }).execute()
    await db.insertInto('reauth_events').values({ id: `re_${p.id}`, person_id: p.id, method: 'passkey', at: new Date().toISOString() }).execute()
  })
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const cents = (n: number) => Math.round(n * 100)
const LIABILITY = new Set(['credit', 'loan'])

/** Plaid's own view: balances from /accounts/get, and every transaction from a fresh /transactions/sync. */
async function plaidTruth(w: World): Promise<{ accounts: PlaidAccount[]; txns: PlaidTxn[] }> {
  const { accounts } = await w.direct.client.call<{ accounts: PlaidAccount[] }>('/accounts/get', { access_token: w.accessToken })
  for (let attempt = 0; ; attempt++) {
    try {
      const txns = new Map<string, PlaidTxn>()
      let cursor: string | undefined
      for (;;) {
        const d = await w.direct.client.call<{ added: PlaidTxn[]; modified: PlaidTxn[]; removed: Array<{ transaction_id: string }>; next_cursor: string; has_more: boolean }>('/transactions/sync', { access_token: w.accessToken, count: 500, ...(cursor ? { cursor } : {}) })
        for (const t of [...d.added, ...d.modified]) txns.set(t.transaction_id, t)
        for (const r of d.removed) txns.delete(r.transaction_id)
        cursor = d.next_cursor
        if (!d.has_more) break
      }
      return { accounts, txns: [...txns.values()] }
    } catch (e) {
      if (attempt >= 3) throw e
      await wait(2000)
    }
  }
}

/** Sync until the transactions have landed (the sandbox fills them a few seconds after linking). */
async function syncUntilTxns(w: World): Promise<void> {
  for (let i = 0; i < 20; i++) {
    expect((await w.sync()).status).toMatch(/ok|partial/)
    const n = await withBypass('test:count', async () => Number((await w.server.booted.services.db.selectFrom('raw_records').select(({ fn }) => fn.countAll<number>().as('n')).where('connection_id', '=', w.connectionId).where('kind', '=', 'plaid.transaction').executeTakeFirstOrThrow()).n))
    if (n > 0) return
    await wait(3000)
  }
  throw new Error('no transactions arrived from the sandbox')
}

/**
 * The sandbox keeps adding history for a few seconds after the first rows: sync again until our counts equal Plaid's
 * (each later row arrives as "added" from our saved cursor, so this also exercises incremental sync).
 */
async function settle(w: World): Promise<{ accounts: PlaidAccount[]; txns: PlaidTxn[] }> {
  for (let i = 0; ; i++) {
    const truth = await plaidTruth(w)
    // One read per round (agent keys are rate limited): the company-wide count against Plaid's total.
    // (Rows Plaid removed stay listed as void with no amount, so count the live statuses.)
    const counts = await Promise.all((['posted', 'pending'] as const).map(async (status) => {
      const got = await w.ai.call<WireTxns>('search_transactions', { from: '2000-01-01', to: '2100-01-01', limit: 1, status })
      return got.total_count === truth.txns.filter((t) => t.pending === (status === 'pending')).length
    }))
    if (counts.every(Boolean) || i >= 10) return truth
    await wait(3000)
    expect((await w.sync()).status).toMatch(/ok|partial/)
  }
}

interface WireAccount { id: string; name: string; type: string; balance: { amount: string; currency: string } | null; last4: string | null }
interface WireTxns { total_count: number; sums: Array<{ amount: string; currency: string }> }

/** Aggregate's accounts keyed by Plaid account_id, as REST and MCP report them (they must agree). */
async function ours(w: World): Promise<Map<string, WireAccount>> {
  const viaRest = (await w.rest<{ accounts: WireAccount[] }>('/v1/accounts')).accounts
  const viaMcp = (await w.ai.call<{ accounts: WireAccount[] }>('list_accounts', {})).accounts
  expect(viaMcp).toEqual(viaRest)
  const ext = await withBypass('test:accounts', () => w.server.booted.services.db.selectFrom('accounts').select(['id', 'external_id']).where('connection_id', '=', w.connectionId).execute())
  const byId = new Map(viaRest.map((a) => [a.id, a]))
  return new Map(ext.map((r) => [r.external_id!, byId.get(r.id)!]))
}

/** Every Plaid balance equals ours to the cent (cards and loans are owed, so they read negative), and cash adds up. */
async function balancesMatch(w: World, truth: { accounts: PlaidAccount[] }): Promise<Map<string, WireAccount>> {
  const mine = await ours(w)
  for (const a of truth.accounts) {
    const m = mine.get(a.account_id)
    expect(m, `${a.type}/${a.subtype} ${a.account_id}`).toBeDefined()
    if (a.balances.current === null) continue
    const want = cents(a.balances.current) * (LIABILITY.has(a.type) ? -1 : 1)
    expect(minor(m!.balance), `${a.type}/${a.subtype} balance`).toBe(want)
    expect(m!.balance!.currency).toBe(a.balances.iso_currency_code ?? 'USD')
  }
  // Cash is spendable bank money: a CD (locked until it matures) and an HSA (medical costs only) aren't.
  const cashWant = truth.accounts.filter((a) => a.type === 'depository' && !['cd', 'hsa'].includes(a.subtype ?? '')).reduce((t, a) => t + cents(a.balances.current ?? 0), 0)
  const viaRest = await w.rest<{ value: { amount: string } | null }>(`/v1/metrics/cash`)
  const viaMcp = await w.ai.call<{ value: { amount: string } | null }>('get_metric', { metric: 'cash' })
  expect(minor(viaRest.value)).toBe(cashWant)
  expect(minor(viaMcp.value)).toBe(cashWant)
  const ws = await w.s.get<{ entities: Array<{ id: string; cash: { minor: number } | null }> }>('/api/workspace')
  expect(ws.body.entities.find((e) => e.id === w.companyId)!.cash?.minor).toBe(cashWant)
  return mine
}

/** Per account: our transaction count and sum (REST and MCP) equal Plaid's set (Plaid amounts are positive for money out). */
async function transactionsMatch(w: World, truth: { txns: PlaidTxn[] }, mine: Map<string, WireAccount>): Promise<void> {
  const byAccount = new Map<string, PlaidTxn[]>()
  for (const t of truth.txns) byAccount.set(t.account_id, [...(byAccount.get(t.account_id) ?? []), t])
  for (const [accountId, txns] of byAccount) {
    const id = mine.get(accountId)!.id
    const q = { account_id: id, from: '2000-01-01', to: '2100-01-01', limit: 1 }
    const rest = (extra: Record<string, string>) => w.rest<WireTxns>(`/v1/transactions?${new URLSearchParams({ ...Object.fromEntries(Object.entries(q).map(([k, v]) => [k, String(v)])), ...extra })}`)
    // Rows Plaid removed stay listed as void with no amount (sums leave them out), so counts are per live status.
    for (const status of ['posted', 'pending'] as const) {
      const want = txns.filter((t) => t.pending === (status === 'pending')).length
      expect((await rest({ status })).total_count, `${status} via REST ${accountId}`).toBe(want)
      expect((await w.ai.call<WireTxns>('search_transactions', { ...q, status })).total_count, `${status} via MCP ${accountId}`).toBe(want)
    }
    const want = -txns.reduce((t, x) => t + cents(x.amount), 0)
    for (const got of [await rest({}), await w.ai.call<WireTxns>('search_transactions', q)]) expect(got.sums.reduce((t, m) => t + minor(m)!, 0), `sum ${accountId}`).toBe(want)
  }
}

describe.runIf(ready)('live: Plaid sandbox matrix', () => {
  it('user_good: balances and every transaction match Plaid to the cent', async () => {
    const w = await world('user_good', ['transactions'])
    await syncUntilTxns(w)
    const truth = await settle(w)
    expect(truth.txns.length).toBeGreaterThan(0)
    await transactionsMatch(w, truth, await balancesMatch(w, truth))
    // A mapping upgrade (dataVersion) re-reads the whole history once: the same rows, nothing counted twice.
    await withBypass('test:version', () => w.server.booted.services.db.deleteFrom('settings').where('key', '=', `sync:data_version:${w.connectionId}`).execute())
    expect((await w.sync()).status).toMatch(/ok|partial/)
    await transactionsMatch(w, truth, await balancesMatch(w, truth))
  }, 240_000)

  it('user_transactions_dynamic: incremental sync applies added, modified and removed', async () => {
    const w = await world('user_transactions_dynamic', ['transactions'])
    await syncUntilTxns(w)
    const before = await settle(w)
    await transactionsMatch(w, before, await balancesMatch(w, before))

    // New activity at the bank: two custom rows (sandbox, this persona only), then a refresh. Pending rows that settle
    // in the same pass arrive as removed + added under new ids; the full-set comparison below covers whatever came.
    const today = new Date().toISOString().slice(0, 10)
    await w.direct.client.call('/sandbox/transactions/create', {
      access_token: w.accessToken,
      transactions: [
        { amount: 12.34, date_posted: today, date_transacted: today, description: 'Matrix Coffee', iso_currency_code: 'USD' },
        { amount: -250, date_posted: today, date_transacted: today, description: 'Matrix Refund', iso_currency_code: 'USD' },
      ],
    })
    await w.direct.client.call('/transactions/refresh', { access_token: w.accessToken })
    let after = before
    const ids = (t: { txns: PlaidTxn[] }) => new Set(t.txns.map((x) => x.transaction_id))
    for (let i = 0; i < 40; i++) {
      await wait(3000)
      after = await plaidTruth(w)
      const a = ids(after)
      if ([...a].some((x) => !ids(before).has(x)) || [...ids(before)].some((x) => !a.has(x))) break
    }
    const gone = [...ids(before)].filter((x) => !ids(after).has(x))
    const added = [...ids(after)].filter((x) => !ids(before).has(x))
    expect(added.length + gone.length).toBeGreaterThan(0)
    expect((await w.sync()).status).toMatch(/ok|partial/)
    after = await settle(w)
    await transactionsMatch(w, after, await balancesMatch(w, after))
    // The two rows made at the bank are here once each, with their sign (Plaid: + is money out).
    for (const [words, amount] of [['Matrix Coffee', '-12.34'], ['Matrix Refund', '250.00']] as const) {
      const live = after.txns.filter((t) => Object.values(t as unknown as Record<string, unknown>).includes(words))
      expect(live.length, `${words} at Plaid`).toBe(1)
      const got = await w.ai.call<WireTxns & { transactions: Array<{ amount: { amount: string } }> }>('search_transactions', { query: words, from: '2000-01-01', to: '2100-01-01' })
      expect(got.transactions.map((t) => t.amount.amount), words).toEqual([amount])
    }
  }, 300_000)

  it('Liabilities: credit card and loans show what is owed, to the cent', async () => {
    const w = await world('user_good', ['transactions', 'liabilities'])
    await syncUntilTxns(w)
    const truth = await settle(w)
    expect(truth.accounts.some((a) => a.type === 'credit')).toBe(true)
    expect(truth.accounts.some((a) => a.type === 'loan')).toBe(true)
    const mine = await balancesMatch(w, truth)
    for (const a of truth.accounts.filter((x) => LIABILITY.has(x.type))) expect(mine.get(a.account_id)!.type).toBe(a.type === 'credit' ? 'credit_card' : 'loan')
    // Terms: what Plaid's /liabilities/get says, over REST and MCP (cards: purchase APR; loans: interest rate).
    type Wire = { amount: string } | undefined
    type Terms = { account_id: string; kind: string; apr?: string; minimum_payment?: Wire; next_payment_due?: string; last_statement_balance?: Wire }
    const viaRest = (await w.rest<{ liabilities: Terms[] }>('/v1/liabilities')).liabilities
    const viaMcp = (await w.ai.call<{ liabilities: Terms[] }>('get_liabilities', {})).liabilities
    expect(viaMcp).toEqual(viaRest)
    const plaid = (await w.direct.client.call<{ liabilities: { credit?: Array<Record<string, unknown>>; student?: Array<Record<string, unknown>>; mortgage?: Array<Record<string, unknown>> } }>('/liabilities/get', { access_token: w.accessToken })).liabilities
    const byPlaid = new Map([...mine].map(([ext, a]) => [a.id, ext]))
    const mineByExt = new Map(viaRest.map((t) => [byPlaid.get(t.account_id), t]))
    const c = (v: unknown) => (typeof v === 'number' ? Math.round(v * 100) : undefined)
    const checks: Array<[Record<string, unknown>, string, unknown, unknown]> = [
      ...(plaid.credit ?? []).map((x) => [x, 'credit', (x.aprs as Array<{ apr_type: string; apr_percentage: number }>).find((a) => a.apr_type === 'purchase_apr')?.apr_percentage, x.minimum_payment_amount] as [Record<string, unknown>, string, unknown, unknown]),
      ...(plaid.student ?? []).map((x) => [x, 'student', x.interest_rate_percentage, x.minimum_payment_amount] as [Record<string, unknown>, string, unknown, unknown]),
      ...(plaid.mortgage ?? []).map((x) => [x, 'mortgage', (x.interest_rate as { percentage?: number } | undefined)?.percentage, x.next_monthly_payment] as [Record<string, unknown>, string, unknown, unknown]),
    ]
    expect(checks.length).toBeGreaterThan(1)
    for (const [x, kind, apr, min] of checks) {
      const t = mineByExt.get(x.account_id as string)
      expect(t, `${kind} ${x.account_id}`).toBeDefined()
      expect(t!.kind).toBe(kind)
      if (typeof apr === 'number') expect(Number(t!.apr), `${kind} apr`).toBeCloseTo(apr, 6)
      if (c(min) !== undefined) expect(minor(t!.minimum_payment as { amount: string }), `${kind} minimum`).toBe(c(min))
      if (x.next_payment_due_date) expect(t!.next_payment_due).toBe(x.next_payment_due_date)
      if (c(x.last_statement_balance) !== undefined) expect(minor(t!.last_statement_balance as { amount: string })).toBe(c(x.last_statement_balance))
    }
  }, 240_000)

  it('Investments: brokerage and retirement balances match Plaid to the cent', async () => {
    const w = await world('user_good', ['transactions', 'investments'])
    await syncUntilTxns(w)
    const truth = await settle(w)
    expect(truth.accounts.some((a) => a.type === 'investment')).toBe(true)
    const mine = await balancesMatch(w, truth)
    for (const a of truth.accounts.filter((x) => x.type === 'investment')) expect(mine.get(a.account_id)!.type).toBe('investment')
    // Positions: what Plaid's /investments/holdings/get says, over REST and MCP, to the cent.
    type Pos = { security_id: string; quantity: string; value: { amount: string }; cost_basis?: { amount: string } }
    type Acct = { account_id: string; total: Array<{ amount: string }>; positions: Pos[] }
    const viaRest = (await w.rest<{ accounts: Acct[] }>('/v1/holdings')).accounts
    const viaMcp = (await w.ai.call<{ accounts: Acct[] }>('get_holdings', {})).accounts
    expect(viaMcp).toEqual(viaRest)
    const plaid = await w.direct.client.call<{ holdings: Array<{ account_id: string; security_id: string; quantity: number; institution_value: number; cost_basis: number | null }> }>('/investments/holdings/get', { access_token: w.accessToken })
    expect(plaid.holdings.length).toBeGreaterThan(0)
    const idOf = new Map([...mine].map(([ext, a]) => [ext, a.id]))
    for (const h of plaid.holdings) {
      const acct = viaRest.find((a) => a.account_id === idOf.get(h.account_id))
      const p = acct?.positions.find((x) => x.security_id === h.security_id)
      expect(p, `${h.account_id} ${h.security_id}`).toBeDefined()
      expect(Number(p!.quantity)).toBeCloseTo(h.quantity, 8)
      expect(minor(p!.value)).toBe(Math.round(h.institution_value * 100))
      if (h.cost_basis !== null) expect(minor(p!.cost_basis)).toBe(Math.round(h.cost_basis * 100))
    }
    expect(viaRest.reduce((n, a) => n + a.positions.length, 0)).toBe(plaid.holdings.length)
  }, 240_000)

  it('ITEM_LOGIN_REQUIRED → needs_reauth → update-mode reconnect keeps the same connection and accounts', async () => {
    const w = await world('user_good', ['transactions'])
    await syncUntilTxns(w)
    const before = await ours(w)
    await w.direct.client.call('/sandbox/item/reset_login', { access_token: w.accessToken })
    await w.sync()
    const status = async () => (await w.s.get<{ connections: Array<{ id: string; status: string }> }>('/api/workspace')).body.connections.find((c) => c.id === w.connectionId)!.status
    expect(await status()).toBe('needs_reauth')
    // An AI still sees the last good numbers while the login is broken.
    const truth = await plaidTruth(w).catch(() => undefined)
    expect(truth).toBeUndefined()
    expect([...(await ours(w)).values()].map((a) => a.balance)).toEqual([...before.values()].map((a) => a.balance))

    const re = await w.s.post<{ kind: string; linkToken: string; state: string }>(`/api/connections/${w.connectionId}/reconnect`, {})
    expect(re.body).toMatchObject({ kind: 'plaid_link', linkToken: expect.stringMatching(/^link-sandbox-/) })
    // Update mode is a Link token for the SAME Item (the access token and Item stay; nothing new is exchanged).
    const linkToken = await w.direct.client.call<{ expiration: string }>('/link/token/get', { link_token: re.body.linkToken })
    expect(linkToken.expiration).toBeTruthy()
    expect((await w.s.post(`/api/connections/${w.connectionId}/reconnect/finish`, { state: re.body.state, linkSessionId: 'matrix-relink' })).status).toBe(200)
    const after = await ours(w)
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    expect([...after.values()].map((a) => a.id).sort()).toEqual([...before.values()].map((a) => a.id).sort())
    const conns = (await w.s.get<{ connections: Array<{ id: string }> }>('/api/workspace')).body.connections
    expect(conns.map((c) => c.id)).toEqual([w.connectionId])
    // Plaid keeps the login broken until a person signs in through the Link UI, so the next sync says so again
    // (and never invents data); the browser half of update mode is the it.todo below.
    await w.sync()
    expect(await status()).toBe('needs_reauth')
  }, 240_000)

  it.todo('update mode in a real browser: Link sign-in with user_good/pass_good clears ITEM_LOGIN_REQUIRED and the same connection syncs again')

  it('SYNC_UPDATES_AVAILABLE: Plaid fires it, an unsigned copy is refused, a delivered one queues a sync', async () => {
    const w = await world('user_good', ['transactions'])
    await syncUntilTxns(w)
    const itemId = (await w.direct.client.call<{ item: { item_id: string } }>('/item/get', { access_token: w.accessToken })).item.item_id
    // fire_webhook needs a webhook on the Item; the address only has to be well-formed (Plaid's delivery can't reach a test).
    await w.direct.client.call('/item/webhook/update', { access_token: w.accessToken, webhook: 'https://webhooks.example.com/api/webhooks/plaid' })
    expect(await w.direct.client.call('/sandbox/item/fire_webhook', { access_token: w.accessToken, webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE' })).toMatchObject({ webhook_fired: true })

    const body = JSON.stringify({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: itemId, initial_update_complete: true, historical_update_complete: true, environment: 'sandbox' })
    const deliver = (headers: Record<string, string> = {}) => w.server.app.request('/api/webhooks/plaid', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })
    expect((await deliver()).status).toBe(401)
    expect((await deliver({ 'plaid-verification': 'e30.e30.e30' })).status).toBe(401)
    const queued = () => withBypass('test:jobs', () => w.server.booted.services.db.selectFrom('jobs').select(['status']).where('kind', '=', 'connection.sync').where('unique_key', '=', w.connectionId).where('status', '=', 'queued').execute())
    const already = (await queued()).length
    trustNextWebhook = true
    try {
      expect((await deliver({ 'plaid-verification': 'trusted-in-test' })).status).toBe(200)
    } finally {
      trustNextWebhook = false
    }
    expect((await queued()).length).toBeGreaterThanOrEqual(Math.max(1, already))
    // The queued sync runs clean and the numbers still match Plaid.
    expect((await w.sync()).status).toMatch(/ok|partial/)
    const truth = await settle(w)
    await transactionsMatch(w, truth, await balancesMatch(w, truth))
  }, 240_000)
})
