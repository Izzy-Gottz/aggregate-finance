import { readFileSync } from 'node:fs'
import type { ConnectionRef, InvoiceUpsert, NormalizedEvent, PaymentApplied } from '@agfn/contracts'
import { isConnectorError, MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { describe, expect, it } from 'vitest'
import { classifyExpensify, createExpensifyConnector, windows, type ExpensifySecret } from './connector.ts'
import { categoryRole, reportStatus, reportUrl } from './map.ts'
import { EXPORT_TEMPLATE, parseExport } from './template.ts'

export const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/expensify.json', import.meta.url), 'utf8')) as {
  fileName: string
  files: Record<string, string>
  errors: { badCredentials: unknown; rate: unknown; validation: unknown }
}
const NOW = Date.parse('2026-10-14T12:00:00Z')

type Job = { type: string; credentials: { partnerUserID: string; partnerUserSecret: string }; inputSettings?: { filters: { startDate: string; endDate: string } }; fileName?: string; onFinish?: unknown }
const jobOf = (body: unknown) => JSON.parse((body as Record<string, string>).requestJobDescription ?? '{}') as Job

/** The export names the October file when the window covers it, an empty one otherwise; download serves the file. */
export const expensifyRoutes = (extra: FixtureRoute[] = []): FixtureRoute[] => [
  ...extra,
  {
    method: 'POST',
    match: '/Integration-Server/ExpensifyIntegrations',
    respond: (_u, body) => {
      const j = jobOf(body)
      if (j.type === 'file') {
        const f = j.inputSettings?.filters
        return { text: f && f.startDate <= '2026-10-02' && f.endDate >= '2026-10-12' ? fx.fileName : 'exportredacted0002.txt' }
      }
      if (j.type === 'download') return { text: fx.files[j.fileName ?? ''] ?? '' }
      return { json: fx.errors.validation }
    },
  },
]

function make(o: { extra?: FixtureRoute[]; now?: number } = {}) {
  const ff = fixtureFetch(expensifyRoutes(o.extra))
  const connector = createExpensifyConnector({ deps: { raw: new MemoryRawSink(), fetch: ff.fetch, clock: fakeClock(o.now ?? NOW), random: () => 0.5 } })
  const conn: ConnectionRef = { id: 'conn_ex', workspaceId: 'ws', connectorKey: 'expensify', secret: { partnerUserID: 'aa_redacted_user', partnerUserSecret: 'redacted-secret' } satisfies ExpensifySecret, config: {} }
  return { connector, conn, ff }
}
const of = <T extends NormalizedEvent['type']>(ev: NormalizedEvent[], t: T) => ev.filter((e): e is Extract<NormalizedEvent, { type: T }> => e.type === t)

describe('expensify contract', () => {
  it('passes the connector contract', async () => {
    const r = await runConnectorContract({ make: () => make(), minEvents: 6 })
    expect(r.pages).toBe(3) // two years in windows of at most a year
  })
  it('fixture is redacted', () => assertRedacted(fx))
})

describe('expensify: the export template', () => {
  it('URL-encodes every text field, defaults every value, and writes one object per expense per line', () => {
    expect(EXPORT_TEMPLATE.startsWith('<#list reports as report><#list report.transactionList as expense>{')).toBe(true)
    expect(EXPORT_TEMPLATE).toContain(`"m":"\${((expense.merchant)!"")?string?url('UTF-8')}"`)
    expect(EXPORT_TEMPLATE).toContain(`"a":"<#if (expense.amount)?has_content>\${(expense.amount)?c}</#if>"`)
    expect(EXPORT_TEMPLATE).toContain(`"reim":"<#if (expense.reimbursable)!false>1<#else>0</#if>"`)
    expect(EXPORT_TEMPLATE.endsWith('}\n</#list></#list>')).toBe(true)
  })
  it('decodes quotes, apostrophes and line breaks back exactly', () => {
    const rows = parseExport(fx.files[fx.fileName] as string)
    expect(rows).toHaveLength(6)
    expect(rows[1]).toMatchObject({ m: 'Joe’s "Diner"', note: 'client dinner\nwith Acme', cat: 'Meals & Entertainment', re: 'jane@example.test' })
  })
})

describe('expensify: expenses into bills (hand-checked)', () => {
  it('company-card expenses: a paid bill + payment each, Expensify’s edit wins, a negative one (a refund) is not sent', async () => {
    const ev = (await runSync(make().connector, make().conn, null)).events
    const bills = of(ev, 'invoice.upsert') as InvoiceUpsert[]
    const card = bills.filter((b) => b.externalId.startsWith('exp:'))
    expect(card.map((b) => [b.externalId, b.counterparty, b.issueDate, b.total.minor, b.status, b.lines?.[0]?.category])).toEqual([
      ['exp:T003', 'Amazon Web Services', '2026-10-03', 129_99, 'paid', 'cloud'],
      // Edited in Expensify: $24.50 and "Uber Trip" win over SmartScan's $23.40 "Uber".
      ['exp:T004', 'Uber Trip', '2026-10-04', 24_50, 'paid', 'travel'],
    ])
    expect(card[0]?.lines?.[0]?.description).toBe(`Amazon Web Services · Hosting · report Card spend: ${reportUrl('R00002')}`)
    const pays = of(ev, 'payment.applied') as PaymentApplied[]
    expect(pays.map((p) => [p.externalId, p.amount.minor, p.method, p.applications[0]?.invoiceExternalId])).toEqual([
      ['exp:T003', 129_99, 'card', 'exp:T003'],
      ['exp:T004', 24_50, 'card', 'exp:T004'],
    ])
    expect(of(ev, 'credit_note.upsert')).toEqual([])
    expect(ev.some((e) => e.externalId === 'exp:T005')).toBe(false)
  })

  it('reimbursable: one bill per report owed to who paid; an approved report is open, a draft is not booked', async () => {
    const ev = (await runSync(make().connector, make().conn, null)).events
    const reports = (of(ev, 'invoice.upsert') as InvoiceUpsert[]).filter((b) => b.externalId.startsWith('report:'))
    expect(reports.map((b) => [b.externalId, b.counterparty, b.issueDate, b.total.minor, b.status, b.lines?.map((l) => [l.amount.minor, l.category])])).toEqual([
      // 412.30 + 38.75 = 451.05
      ['report:R00001', 'jane@example.test', '2026-10-03', 451_05, 'open', [[412_30, 'travel'], [38_75, 'meals']]],
      ['report:R00003', 'sam@example.test', '2026-10-12', 6_50, 'draft', [[6_50, 'meals']]],
    ])
    // No payment is invented for a reimbursement: the bank row settles the bill.
    expect((of(ev, 'payment.applied') as PaymentApplied[]).some((p) => p.externalId.startsWith('report:'))).toBe(false)
  })

  it('only read jobs, never marking reports exported; the next cycle reads back four months', async () => {
    const m = make()
    const first = await runSync(m.connector, m.conn, null)
    const jobs = m.ff.calls.map((c) => jobOf(c.body))
    expect([...new Set(jobs.map((j) => j.type))].sort()).toEqual(['download', 'file'])
    expect(jobs.some((j) => j.onFinish !== undefined)).toBe(false)
    expect(m.ff.calls.every((c) => c.method === 'POST' && (c.body as Record<string, string>).requestJobDescription)).toBe(true)
    const later = make({ now: NOW + 30 * 86_400_000 })
    await runSync(later.connector, later.conn, first.cursor)
    const w = later.ff.calls.map((c) => jobOf(c.body)).filter((j) => j.type === 'file').map((j) => j.inputSettings?.filters)
    expect(w).toEqual([{ startDate: '2026-06-16', endDate: '2026-11-13' }])
  })

  it('windows are at most a year', () => {
    expect(windows('2024-10-14', '2026-10-14')).toEqual([
      ['2024-10-14', '2025-10-13'],
      ['2025-10-14', '2026-10-13'],
      ['2026-10-14', '2026-10-14'],
    ])
  })
})

describe('expensify: errors and credentials', () => {
  it('wrong credentials (often a JSON error in a 200) mean reconnect; rate limit and validation are told apart', async () => {
    const bad = make({ extra: [{ method: 'POST', match: '/Integration-Server/ExpensifyIntegrations', respond: { json: fx.errors.badCredentials } }] })
    const err = await bad.connector.sync(bad.conn, null).catch((e: unknown) => e)
    expect(isConnectorError(err) && err.kind).toBe('auth')
    expect((await bad.connector.health(bad.conn)).status).toBe('needs_reauth')
    await expect(bad.connector.connect({ partnerUserID: 'x', partnerUserSecret: 'y' })).rejects.toMatchObject({ kind: 'auth' })
    expect(classifyExpensify(200, JSON.stringify(fx.errors.rate))?.kind).toBe('rate_limited')
    expect(classifyExpensify(200, JSON.stringify(fx.errors.validation))?.kind).toBe('invalid_input')
    expect(classifyExpensify(200, 'exportredacted0001.txt')).toBeUndefined()
  })

  it('connect checks the credentials with a one-week export and warns they can’t be limited to reading', async () => {
    const m = make()
    const r = await m.connector.connect({ partnerUserID: ' aa_redacted_user ', partnerUserSecret: 'redacted-secret' })
    expect(r.secret).toEqual({ partnerUserID: 'aa_redacted_user', partnerUserSecret: 'redacted-secret' })
    expect((r.config.warnings as string[])[0]).toMatch(/can’t be limited to reading/)
    expect(jobOf(m.ff.calls[0]?.body).inputSettings?.filters).toEqual({ startDate: '2026-10-07', endDate: '2026-10-14' })
    await expect(m.connector.connect({ partnerUserID: 'x' })).rejects.toMatchObject({ kind: 'invalid_input', forUser: true })
  })

  it('categories and statuses', () => {
    expect(['Airfare', 'Meals & Entertainment', 'Software', 'Office Supplies', 'Misc'].map(categoryRole)).toEqual(['travel', 'meals', 'software', 'other_expense', 'uncategorized_expense'])
    expect(['Open', 'Processing', 'Approved', 'Closed', 'Reimbursed', 'Archived'].map(reportStatus)).toEqual(['draft', 'draft', 'approved', 'approved', 'reimbursed', 'approved'])
  })
})
