import type { ConnectionRef, InvoiceUpsert, JournalUpsert, NormalizedEvent, PaymentApplied, ReportSnapshot } from '@agfn/contracts'
import { ConnectorError, MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, assertValidEvents, fakeClock, fixtureFetch, runConnectorContract, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { describe, expect, it } from 'vitest'
import { createFreshBooksConnector, DEFAULT_SCOPES, type FreshBooksSecret } from './connector.ts'
import { accountRoles, mapBill, mapExpense, mapInvoice, mapJournal, mapPayment, mapProfitAndLoss } from './map.ts'
import { FIXTURE, routes, type Fixture } from './test-routes.ts'

const NOW = Date.parse('2026-10-10T12:00:00Z')
const REDIRECT = 'https://app.example.com/api/connectors/freshbooks/callback'
const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`

function make(opts: { extra?: FixtureRoute[]; tokens?: Partial<FreshBooksSecret['tokens']>; saved?: unknown[]; fix?: Fixture; config?: Record<string, unknown>; pageSize?: number } = {}) {
  const ff = fixtureFetch([...(opts.extra ?? []), ...routes(opts.fix)])
  const connector = createFreshBooksConnector({
    deps: { raw: new MemoryRawSink(), fetch: ff.fetch, clock: fakeClock(NOW), random: () => 0.5, saveSecret: async (_id, s) => void opts.saved?.push(s) },
    oauth: { clientId: 'client-test', clientSecret: 'secret-test', redirectUri: REDIRECT },
    pageSize: opts.pageSize ?? 2,
  })
  const conn: ConnectionRef = {
    id: 'conn_fb',
    workspaceId: 'ws_1',
    connectorKey: 'freshbooks',
    secret: { tokens: { accessToken: 'at-test', refreshToken: 'rt-test', expiresAt: NOW + 3_600_000, ...opts.tokens } } satisfies FreshBooksSecret,
    config: { accountId: 'ACCT1', businessUuid: 'biz-uuid-1', baseCurrency: 'USD', pnlMonths: 1, ...opts.config },
  }
  return { connector, conn, ff }
}
/** Every page, keeping the warnings each one returns. */
async function syncAll(connector: ReturnType<typeof make>['connector'], conn: ConnectionRef) {
  const events: NormalizedEvent[] = []
  const warnings: string[] = []
  let cursor: string | null = null
  for (let i = 0; i < 60; i++) {
    const r = await connector.sync(conn, cursor)
    events.push(...r.events)
    warnings.push(...(r.warnings ?? []))
    cursor = r.cursor
    if (!r.hasMore) break
  }
  return { events, warnings }
}
const find = (events: NormalizedEvent[], type: NormalizedEvent['type'], id: string) => events.find((e) => e.type === type && e.externalId === id)
const ctx = { connectionId: 'c', baseCurrency: 'USD' }
const m = (amount: string, code = 'USD') => ({ amount, code })

describe('FreshBooks connector', () => {
  it('fixture is redacted', () => assertRedacted(FIXTURE))
  it('asks for read scopes only', () => expect(DEFAULT_SCOPES.every((s) => /^user:[a-z_]+:read$/.test(s))).toBe(true))
  it('passes the connector contract', async () => {
    await runConnectorContract({ make: () => make(), minEvents: 10 })
  })

  it('never writes: every call during a sync is a GET', async () => {
    const { connector, conn, ff } = make()
    await runSync(connector, conn, null)
    expect(ff.calls.length).toBeGreaterThan(5)
    expect(ff.calls.every((c) => c.method === 'GET')).toBe(true)
  })

  it('invoices keep the real customer name, the gross total and the currency', async () => {
    const { connector, conn } = make()
    const { events } = await runSync(connector, conn, null)
    assertValidEvents(events, { connectionId: conn.id })
    expect(find(events, 'invoice.upsert', '101')).toMatchObject({ direction: 'receivable', counterparty: 'Globex Corp', number: '0000101', status: 'paid', issueDate: '2026-09-01', total: { minor: 108_000, currency: 'USD' }, amountPaid: { minor: 108_000, currency: 'USD' }, subtotal: { minor: 100_000 }, tax: { minor: 8_000 } })
    expect(find(events, 'invoice.upsert', '102')).toMatchObject({ counterparty: 'Jane Doe', status: 'open', total: { minor: 45_000 }, subtotal: { minor: 45_000 }, tax: { minor: 0 } })
    expect(find(events, 'invoice.upsert', '103')).toMatchObject({ status: 'partially_paid', amountPaid: { minor: 10_000 } })
    expect(find(events, 'invoice.upsert', '104')).toMatchObject({ status: 'draft' })
  })

  it("payments are receivable, name the invoice's customer, and find it with an id filter", async () => {
    const { connector, conn, ff } = make()
    const { events } = await runSync(connector, conn, null)
    expect(find(events, 'payment.applied', '9001')).toMatchObject({ direction: 'receivable', counterparty: 'Globex Corp', date: '2026-09-12', amount: { minor: 108_000, currency: 'USD' }, applications: [{ invoiceExternalId: '101', amount: { minor: 108_000 } }], status: 'posted' })
    expect(ff.calls.some((c) => decodeURIComponent(c.url).includes('search[invoiceids][]=101'))).toBe(true)
  })

  it('a payment from client credit is not cash, so it is left out', async () => {
    const { connector, conn } = make()
    const { events } = await runSync(connector, conn, null)
    expect(find(events, 'payment.applied', '9003')).toBeUndefined()
  })

  it('bills, bill payments and expenses', async () => {
    const { connector, conn } = make()
    const { events } = await runSync(connector, conn, null)
    expect(find(events, 'invoice.upsert', 'bill:201')).toMatchObject({ direction: 'payable', counterparty: 'Hosting Co', status: 'paid', total: { minor: 40_000 }, lines: [{ category: 'software', amount: { minor: 40_000 } }] })
    expect(find(events, 'invoice.upsert', 'bill:202')).toMatchObject({ status: 'open', lines: [{ category: 'cogs' }] })
    expect(find(events, 'payment.applied', 'bp:301')).toMatchObject({ direction: 'payable', counterparty: 'Hosting Co', date: '2026-09-10', applications: [{ invoiceExternalId: 'bill:201', amount: { minor: 40_000 } }] })
    expect(find(events, 'invoice.upsert', 'expense:401')).toMatchObject({ direction: 'payable', counterparty: 'Delta', status: 'paid', lines: [{ category: 'travel' }] })
    expect(find(events, 'payment.applied', 'expense:401')).toMatchObject({ direction: 'payable', applications: [{ invoiceExternalId: 'expense:401', amount: { minor: 8_975 } }] })
    // Flagged as a duplicate in FreshBooks: it stops counting.
    expect(find(events, 'invoice.upsert', 'expense:402')).toMatchObject({ status: 'void' })
  })

  it('a journal touching a bank account is skipped; others post', async () => {
    const { connector, conn } = make()
    const { events } = await runSync(connector, conn, null)
    const journals = events.filter((e) => e.type === 'journal.upsert') as JournalUpsert[]
    expect(journals.map((j) => j.externalId)).toEqual(['je:je-dep'])
    expect(journals[0]).toMatchObject({ date: '2026-09-30', status: 'posted' })
    expect(journals[0]!.lines.map((l) => [l.role, l.amount.minor])).toEqual([['other_expense', 12_000], ['other_liabilities', -12_000]])
  })

  it('journal skipping: cash sub-accounts, unknown accounts and lines that do not balance', () => {
    const roles = accountRoles(FIXTURE.journal_entry_accounts as Array<Record<string, unknown>>)
    expect(roles['acc-bank']).toBe('bank')
    expect(roles['acc-cash-sub']).toBe('bank')
    const je = (a: string, debit: string, credit: string) => ({ id: 'x', userEnteredDate: { year: 2026, month: 1, day: 2 }, details: [{ accountId: 'acc-dep', amount: m(debit), type: 'TYPE_DEBIT' }, { accountId: a, amount: m(credit), type: 'TYPE_CREDIT' }] })
    expect(mapJournal(je('acc-cash-sub', '1.00', '1.00'), { ...ctx, roles })).toBeNull()
    expect(mapJournal(je('acc-nobody-knows', '1.00', '1.00'), { ...ctx, roles })).toBeNull()
    expect(mapJournal(je('acc-ppe', '2.00', '1.00'), { ...ctx, roles })).toBeNull()
    expect(mapJournal(je('acc-ppe', '1.00', '1.00'), { ...ctx, roles })).not.toBeNull()
    // The account type wins over a money word in the name, so this journal posts.
    const fees = accountRoles([{ account_uuid: 'acc-fees', account_name: 'Bank Fees', account_type: 'expense' }, { account_uuid: 'acc-loan', account_name: 'Loan Interest', account_type: 'expense' }])
    expect(fees['acc-fees']).not.toBe('bank')
    expect(fees['acc-loan']).not.toBe('bank')
    expect(mapJournal(je('acc-fees', '1.00', '1.00'), { ...ctx, roles: { ...roles, ...fees } })).not.toBeNull()
  })

  it('the P&L report is a snapshot with FreshBooks totals', async () => {
    const { connector, conn, ff } = make()
    const { events } = await runSync(connector, conn, null)
    const snap = find(events, 'report.snapshot', 'pnl:2026-09-01:2026-09-30:accrual') as ReportSnapshot
    expect(snap).toMatchObject({ kind: 'profit_and_loss', basis: 'accrual', currency: 'USD', totals: { income: { minor: 170_000 }, netIncome: { minor: 94_000 } } })
    expect(snap.rows.find((r) => r.account === 'Total Expenses')?.amount.minor).toBe(76_000)
    expect(snap.rows.find((r) => r.account === 'Consulting')).toMatchObject({ section: 'Income', accountExternalId: 'acc-sales', depth: 2, amount: { minor: 170_000 } })
    expect(snap.rows.find((r) => r.account === 'Travel (general)')).toMatchObject({ section: 'Expenses' })
    expect(snap.notCovered?.text).toContain('credit notes')
    const call = ff.calls.find((c) => c.url.includes('/accounting/businesses/biz-uuid-1/reports/profit_and_loss') && c.url.includes('2026-09-01'))
    expect(call?.url).toContain('use_ledger_entries=true')
    expect(call?.url).toContain('cash_based=false')
  })

  it('statuses, deletion and archiving', () => {
    const base = FIXTURE.invoices as Array<Record<string, unknown>>
    const inv = (o: Record<string, unknown>) => mapInvoice({ ...base[1], lines: [], ...o }, ctx) as InvoiceUpsert
    expect(inv({ status: 0 }).status).toBe('disputed')
    for (const [s, want] of [[1, 'draft'], [2, 'open'], [3, 'open'], [4, 'paid'], [5, 'paid'], [6, 'open'], [7, 'open'], [8, 'partially_paid']] as const) expect(inv({ status: s }).status, String(s)).toBe(want)
    expect(inv({ status: 2, vis_state: 1 }).status).toBe('void')
    expect(inv({ status: 2, vis_state: 2 }).status).toBe('open')
    expect(inv({ status: 2, paid: m('5.00') }).status).toBe('partially_paid')
    expect(inv({ status: 4, paid: m('0.00') }).amountPaid.minor).toBe(45_000)
    const bill = (o: Record<string, unknown>) => mapBill({ ...(FIXTURE.bills as Array<Record<string, unknown>>)[1], ...o }, ctx) as InvoiceUpsert
    for (const [s, want] of [['unpaid', 'open'], ['overdue', 'open'], ['partial', 'partially_paid'], ['paid', 'paid']] as const) expect(bill({ status: s }).status).toBe(want)
    expect(bill({ vis_state: 1 }).status).toBe('void')
    expect((mapPayment({ ...(FIXTURE.payments as Array<Record<string, unknown>>)[0], vis_state: 1 }, ctx) as PaymentApplied).status).toBe('void')
    expect((mapExpense({ ...(FIXTURE.expenses as Array<Record<string, unknown>>)[0], vis_state: 1 }, ctx)[0] as InvoiceUpsert).status).toBe('void')
  })

  it('an impossible tax split is dropped, so the total alone posts', () => {
    const e = mapInvoice({ id: 1, status: 2, currency_code: 'USD', create_date: '2026-01-01', organization: 'A', amount: m('10.00'), paid: m('0.00'), lines: [{ name: 'x', amount: m('20.00') }] }, ctx) as InvoiceUpsert
    expect(e.tax).toBeUndefined()
    expect(e.subtotal).toBeUndefined()
  })

  it('zero-decimal and other currencies stay as billed', () => {
    const e = mapInvoice({ id: 1, status: 2, currency_code: 'JPY', create_date: '2026-01-01', fname: 'Ken', lname: 'Sato', amount: m('5000', 'JPY'), paid: m('0', 'JPY') }, ctx) as InvoiceUpsert
    expect(e.total).toEqual({ minor: 5000, currency: 'JPY' })
    expect((mapPayment({ id: 2, invoiceid: 1, date: '2026-01-02', amount: m('10.50', 'EUR'), vis_state: 0 }, ctx) as PaymentApplied).amount).toEqual({ minor: 1050, currency: 'EUR' })
  })

  it('a payment with no invoice stays as unapplied money', () => {
    expect(mapPayment({ id: 2, date: '2026-01-02', amount: m('10.00'), vis_state: 0 }, ctx)).toMatchObject({ applications: [], unapplied: { minor: 1000 } })
  })

  it('pages to the end and resumes page by page from the cursor', async () => {
    const fix = structuredClone(FIXTURE)
    fix.invoices = Array.from({ length: 5 }, (_, i) => ({ ...(FIXTURE.invoices as Array<Record<string, unknown>>)[0], id: i + 1, invoiceid: i + 1 }))
    const { connector, conn } = make({ fix })
    const { events } = await runSync(connector, conn, null)
    expect(events.filter((e) => e.type === 'invoice.upsert' && /^\d+$/.test(e.externalId))).toHaveLength(5)
    let cursor: string | null = null
    const seen: string[] = []
    for (let i = 0; i < 50; i++) {
      const r = await connector.sync(conn, cursor)
      seen.push(...r.events.filter((e) => e.type === 'invoice.upsert' && /^\d+$/.test(e.externalId)).map((e) => e.externalId))
      cursor = r.cursor
      if (!r.hasMore) break
    }
    expect(seen).toEqual(['1', '2', '3', '4', '5'])
  })

  it('the next pass filters on updated_min (a day back), and asks for deleted rows', async () => {
    const { connector, conn, ff } = make()
    const first = await runSync(connector, conn, null)
    const before = ff.calls.length
    await runSync(connector, conn, first.cursor)
    const later = ff.calls.slice(before).map((c) => decodeURIComponent(c.url))
    expect(later.find((u) => u.includes('/invoices/invoices?'))).toContain('search[updated_min]=2026-10-09')
    expect(later.some((u) => u.includes('/invoices/invoices') && u.includes('search[vis_state]=1'))).toBe(true)
    expect(later.some((u) => u.includes('/payments/payments') && u.includes('search[vis_state]=1'))).toBe(true)
    expect(later.some((u) => u.includes('/expenses/expenses') && u.includes('search[vis_state]=1'))).toBe(true)
  })

  it('a deleted invoice comes through as void', async () => {
    const fix = structuredClone(FIXTURE)
    ;(fix.invoices as Array<Record<string, unknown>>).push({ ...(FIXTURE.invoices as Array<Record<string, unknown>>)[1], id: 105, invoiceid: 105, vis_state: 1 })
    const { events } = await runSync(...((({ connector, conn }) => [connector, conn, null] as const)(make({ fix }))))
    expect(find(events, 'invoice.upsert', '105')).toMatchObject({ status: 'void' })
  })

  it('what is re-read in full every pass (bills, bill payments, journals) closes with scoped listings', async () => {
    const { connector, conn } = make()
    const { events } = await runSync(connector, conn, null)
    const listings = events.filter((e) => e.type === 'listing.complete')
    expect(listings.map((l) => [l.kinds, l.scope])).toEqual([[['bill'], 'bill:'], [['payment'], 'bp:'], [['journal'], 'je:']])
  })

  it('401 says reconnect; 429 is rate limited with its wait', async () => {
    const denied = make({ extra: [{ match: '/invoices/invoices', respond: { status: 401, json: { response: { errors: [{ message: 'nope' }] } } } }] })
    await expect(denied.connector.sync(denied.conn, null)).rejects.toMatchObject({ kind: 'auth', status: 401 })
    const limited = make({ extra: [{ match: '/invoices/invoices', respond: { status: 429, headers: { 'retry-after': '600' }, json: {} } }] })
    await expect(limited.connector.sync(limited.conn, null)).rejects.toMatchObject({ kind: 'rate_limited', code: 'limit' })
  })

  it('403 on a list is an access problem; 403 on the report (a manager) only skips the report, with a warning', async () => {
    const list = make({ extra: [{ match: '/invoices/invoices', respond: { status: 403, json: {} } }] })
    await expect(list.connector.sync(list.conn, null)).rejects.toMatchObject({ kind: 'auth', status: 403 })
    const report = make({ extra: [{ match: '/reports/profit_and_loss', respond: { status: 403, json: {} } }] })
    const { events, warnings } = await syncAll(report.connector, report.conn)
    expect(events.some((e) => e.type === 'report.snapshot')).toBe(false)
    expect(events.some((e) => e.type === 'invoice.upsert')).toBe(true)
    expect(warnings.join(' ')).toMatch(/profit and loss/i)
  })

  it('a plan without bills: 403 skips them with a warning and no listing, so nothing is voided', async () => {
    const { connector, conn } = make({ extra: [{ match: '/bills/bills', respond: { status: 403, json: {} } }, { match: '/bill_payments/bill_payments', respond: { status: 403, json: {} } }] })
    const { events, warnings } = await syncAll(connector, conn)
    expect(events.filter((e) => e.type === 'listing.complete').map((l) => l.scope)).toEqual(['je:'])
    expect(events.some((e) => e.externalId === '9001')).toBe(true)
    expect(warnings.join(' ')).toMatch(/bills/)
  })

  it('403 on the chart skips journals and their listing, nothing voided by mistake', async () => {
    const { connector, conn } = make({ extra: [{ match: '/reports/chart_of_accounts', respond: { status: 403, json: {} } }] })
    const { events, warnings } = await syncAll(connector, conn)
    expect(events.some((e) => e.type === 'journal.upsert')).toBe(false)
    expect(events.filter((e) => e.type === 'listing.complete').map((l) => l.scope)).toEqual(['bill:', 'bp:'])
    expect(warnings.join(' ')).toMatch(/journal/i)
  })

  it('a connection without the business uuid skips what needs it and says so', async () => {
    const { connector, conn } = make({ config: { businessUuid: undefined } })
    const { events, warnings } = await syncAll(connector, conn)
    expect(events.some((e) => e.type === 'invoice.upsert')).toBe(true)
    expect(events.some((e) => e.type === 'report.snapshot' || e.type === 'journal.upsert')).toBe(false)
    expect(warnings.length).toBeGreaterThan(0)
  })
})

describe('FreshBooks sign-in', () => {
  it('the sign-in link is the documented one: no scope parameter, scopes live on the app', () => {
    const { connector } = make()
    const u = new URL(connector.authorizationUrl('st'))
    expect(u.origin + u.pathname).toBe('https://auth.freshbooks.com/oauth/authorize/')
    expect(Object.fromEntries(u.searchParams)).toEqual({ response_type: 'code', client_id: 'client-test', redirect_uri: REDIRECT, state: 'st' })
  })

  it('connects each business, sharing one rotating token', async () => {
    const fix = structuredClone(FIXTURE)
    ;(fix.me as { response: { business_memberships: unknown[] } }).response.business_memberships.push({ id: 100, role: 'owner', business: { id: 56, business_uuid: 'biz-uuid-2', name: 'Second Co', account_id: 'ACCT2' } })
    const { connector, ff } = make({ fix, extra: [{ method: 'POST', match: '/auth/oauth/token', respond: { json: { access_token: jwt(NOW / 1000 + 3600), refresh_token: 'rt-new', token_type: 'Bearer' } } }] })
    const r = await connector.connect({ code: 'the-code' })
    expect(r.config).toMatchObject({ accountId: 'ACCT1', businessUuid: 'biz-uuid-1', displayName: 'FreshBooks · Fixture Co', sharedSecretKey: 'freshbooks:7' })
    expect(r.additional?.[0]?.config).toMatchObject({ accountId: 'ACCT2', sharedSecretKey: 'freshbooks:7' })
    // The documented JSON-shaped body, with the credentials in it.
    const token = ff.calls.find((c) => c.url.endsWith('/auth/oauth/token'))!
    expect(token.headers['content-type']).toBe('application/json')
    expect(token.body).toEqual({ grant_type: 'authorization_code', client_id: 'client-test', client_secret: 'secret-test', code: 'the-code', redirect_uri: REDIRECT })
    expect(ff.calls.find((c) => c.url.includes('/users/me'))?.headers['api-version']).toBe('alpha')
    // No expires_in: the access token's own expiry counts.
    expect((r.secret as FreshBooksSecret).tokens.expiresAt).toBe(NOW + 3_600_000)
  })

  it('one business gets no shared key', async () => {
    const { connector } = make({ extra: [{ method: 'POST', match: '/auth/oauth/token', respond: { json: { access_token: 'a', refresh_token: 'r', expires_in: 3600 } } }] })
    const r = await connector.connect({ code: 'c' })
    expect(r.config.sharedSecretKey).toBeUndefined()
    expect(r.additional).toBeUndefined()
  })

  it('no business with an account is a plain error', async () => {
    const fix = structuredClone(FIXTURE)
    ;(fix.me as { response: { business_memberships: unknown[] } }).response.business_memberships = []
    const { connector } = make({ fix, extra: [{ method: 'POST', match: '/auth/oauth/token', respond: { json: { access_token: 'a' } } }] })
    await expect(connector.connect({ code: 'c' })).rejects.toBeInstanceOf(ConnectorError)
  })

  it('refreshes with redirect_uri and saves the single-use token before reading anything', async () => {
    const saved: unknown[] = []
    const { connector, conn, ff } = make({ saved, tokens: { expiresAt: NOW - 1 }, extra: [{ method: 'POST', match: '/auth/oauth/token', respond: { json: { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 } } }] })
    const r = await connector.sync(conn, null)
    expect(ff.calls[0]!.body).toEqual({ grant_type: 'refresh_token', client_id: 'client-test', client_secret: 'secret-test', refresh_token: 'rt-test', redirect_uri: REDIRECT })
    expect(saved).toHaveLength(1)
    expect((r.updatedSecret as FreshBooksSecret).tokens.refreshToken).toBe('rt-2')
  })

  it('disconnect revokes at FreshBooks', async () => {
    const { connector, conn, ff } = make({ extra: [{ method: 'POST', match: '/auth/oauth/revoke', respond: { json: {} } }] })
    expect(await connector.disconnect!(conn)).toBeUndefined()
    expect(ff.calls[0]).toMatchObject({ method: 'POST', body: { client_id: 'client-test', client_secret: 'secret-test', token: 'rt-test' } })
  })

  it('a refused revoke returns notRevoked text with no token in it', async () => {
    const { connector, conn } = make({ extra: [{ method: 'POST', match: '/auth/oauth/revoke', respond: { status: 500, json: {} } }] })
    const out = await connector.disconnect!(conn)
    expect(out?.notRevoked).toContain('FreshBooks')
    expect(out?.notRevoked).not.toContain('rt-test')
  })

  it('another business on the same sign-in keeps the token', async () => {
    const { connector, conn, ff } = make({ config: { sharedSecretKey: 'freshbooks:7', lastOfGrant: false } })
    await connector.disconnect!(conn)
    expect(ff.calls).toHaveLength(0)
  })
})

describe('mapProfitAndLoss', () => {
  it('needs a report', () => expect(mapProfitAndLoss({}, ctx, { from: '2026-01-01', to: '2026-01-31' })).toBeNull())
})
