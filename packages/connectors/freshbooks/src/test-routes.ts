// FreshBooks-shaped responses for the fixture, shared by this package's tests and the server scenarios.
import { readFileSync } from 'node:fs'
import type { FixtureRoute } from '@agfn/connector-sdk/testing'

export type Fixture = Record<string, unknown> & { profit_and_loss: Record<string, Record<string, unknown>> }
export const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/redacted/books.json', import.meta.url), 'utf8')) as Fixture

type Row = Record<string, unknown>
const LISTS: Array<[string, string]> = [
  ['/invoices/invoices', 'invoices'],
  ['/payments/payments', 'payments'],
  ['/expenses/expenses', 'expenses'],
  ['/bills/bills', 'bills'],
  ['/bill_payments/bill_payments', 'bill_payments'],
]

/** Page, per_page, vis_state and the id filters, as the docs describe them. Deleted rows only with search[vis_state]=1. */
export function routes(fix: Fixture = FIXTURE): FixtureRoute[] {
  return [
    { match: '/auth/api/v1/users/me', respond: { json: fix.me } },
    ...LISTS.map(([path, key]): FixtureRoute => ({
      match: (url) => url.pathname.endsWith(path),
      respond: (url) => {
        const q = url.searchParams
        const page = Number(q.get('page') ?? 1)
        const size = Math.min(100, Number(q.get('per_page') ?? 100))
        let all = (fix[key] as Row[]) ?? []
        const want = q.get('search[vis_state]')
        all = all.filter((r) => (want ? String(r.vis_state ?? 0) === want : r.vis_state !== 1))
        const invoiceIds = q.getAll('search[invoiceids][]')
        if (invoiceIds.length) all = all.filter((r) => invoiceIds.includes(String(r.id)))
        const ids = q.getAll('search[ids][]')
        if (ids.length) all = all.filter((r) => ids.includes(String(r.id)))
        return { json: { response: { result: { [key]: all.slice((page - 1) * size, page * size), page, pages: Math.max(1, Math.ceil(all.length / size)), per_page: size, total: all.length } } } }
      },
    })),
    { match: '/reports/chart_of_accounts', respond: { json: { response: { result: { journal_entry_accounts: fix.journal_entry_accounts } } } } },
    {
      match: (url) => url.pathname.endsWith('/journal_entries'),
      respond: (url) => {
        const number = Number(url.searchParams.get('page_number') ?? 1)
        const size = Number(url.searchParams.get('page_size') ?? 100)
        const all = (fix.manualJournalEntries as Row[]) ?? []
        return { json: { manualJournalEntries: all.slice((number - 1) * size, number * size), page: { number, size, pages: Math.max(1, Math.ceil(all.length / size)), total: all.length } } }
      },
    },
    {
      match: '/reports/profit_and_loss',
      respond: (url) => {
        const report = fix.profit_and_loss[(url.searchParams.get('start_date') ?? '').slice(0, 7)]
        return { json: { response: { result: { profit_and_loss: report ?? { currency_code: 'USD', income: [], expenses: [], total_income: { total: { amount: '0.00', code: 'USD' } }, total_expenses: { total: { amount: '0.00', code: 'USD' } }, net_profit: { total: { amount: '0.00', code: 'USD' } } } } } } }
      },
    },
  ]
}
