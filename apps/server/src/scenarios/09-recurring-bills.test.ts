// Recurring bills and subscriptions: a founder's card and bank show SaaS charges, a utility that also sends a bill
// in QuickBooks, payroll, and a trial. The AI sees each series (with a price rise and a converted trial), bills due
// count every expected charge once, and the Monday note's "Bills due this week" includes the recurring ones.
import { describe, expect, it } from 'vitest'
import { withBypass } from '@agfn/db'
import { digestWithRecurring } from '../digest.ts'
import { financeFor } from '../finance.ts'
import { connectAi, connectProvider, entities, minor, signIn, startServer } from './harness.ts'

const usd = (m: number) => ({ minor: m, currency: 'USD' })
type Wire = { amount: string }
type Rec = { counterparty: string; status: string; cadence: string; amount: Wire; monthly: Wire; next_due: string; late: boolean; occurrences: number; changes: Array<{ kind: string; from: Wire; to: Wire; pct?: number }> }

describe('scenario 9: recurring bills and subscriptions', () => {
  it('series, price rises, trials, bills due and the Monday note — each charge once', async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'founder9@example.com', 'Acme')
      const E = await entities(s)
      const bank = await connectProvider(srv, s, 'plaid', { entityId: E.Acme, name: 'Chase' })
      let n = 0
      const t = (acct: string, date: string, dollars: number, who: string, memo = who.toUpperCase()) => ({ type: 'txn.upsert' as const, externalId: `x${++n}`, connectionId: '', accountExternalId: acct, date, amount: usd(-Math.round(dollars * 100)), status: 'posted' as const, counterparty: who, rawText: memo })
      const rows = [
        ...[['2026-06-14', 45], ['2026-07-14', 45], ['2026-08-14', 45], ['2026-09-14', 60]].map(([d, a]) => t('card', d as string, a as number, 'Slack Technologies')),
        t('card', '2026-07-01', 1, 'Linear', 'LINEAR TRIAL'),
        ...['2026-07-15', '2026-08-15', '2026-09-15'].map((d) => t('card', d, 24, 'Linear')),
        ...['2026-08-20', '2026-09-20'].map((d) => t('card', d, 49, 'Notion Labs')),
        ...[['2026-07-02', 100], ['2026-08-02', 104.5], ['2026-09-02', 98]].map(([d, a]) => t('card', d as string, a as number, 'Amazon Web Services')),
        ...['2026-07-16', '2026-08-16', '2026-09-16'].map((d) => t('chk', d, 120, 'Comcast Business')),
        ...['2026-09-04', '2026-09-18', '2026-10-02'].map((d) => t('chk', d, 6100, 'Gusto', 'GUSTO NET 8RTF2')),
        t('chk', '2026-09-22', 37.5, 'Uber'),
      ]
      bank.push((c) => [
        { type: 'account.upsert', externalId: 'chk', connectionId: c, name: 'Acme Checking', accountType: 'depository', currency: 'USD', institution: 'Chase' },
        { type: 'account.upsert', externalId: 'card', connectionId: c, name: 'Acme Card', accountType: 'credit_card', currency: 'USD', institution: 'Chase' },
        { type: 'balance.snapshot', externalId: 'b', connectionId: c, accountExternalId: 'chk', at: '2026-10-09T08:00:00Z', current: usd(10_000_000) },
        ...rows.map((r) => ({ ...r, connectionId: c })),
      ])
      expect((await bank.sync()).status).toBe('ok')
      // Comcast also sends its bill through QuickBooks: it's a bill, and must not be counted again as a subscription.
      const qb = await connectProvider(srv, s, 'quickbooks', { entityId: E.Acme, name: 'QuickBooks' })
      qb.push((c) => [{ type: 'invoice.upsert', externalId: 'cc10', connectionId: c, direction: 'payable', number: 'CC-10', counterparty: 'Comcast Business', issueDate: '2026-10-01', dueDate: '2026-10-16', total: usd(12_000), amountPaid: usd(0), status: 'open' }] as never)
      expect((await qb.sync()).status).toBe('ok')

      const ai = await connectAi(srv, s)
      const list = await ai.call<{ recurring: Rec[]; monthly_total_active: Wire[] }>('list_recurring', { company: 'Acme' })
      const by = Object.fromEntries(list.recurring.map((r) => [r.counterparty, r]))
      expect(Object.keys(by).sort()).toEqual(['Amazon Web Services', 'Comcast Business', 'Linear', 'Notion Labs', 'Slack Technologies'])
      expect(by['Slack Technologies']).toMatchObject({ status: 'active', cadence: 'monthly', amount: { amount: '60.00' }, next_due: '2026-10-14', occurrences: 4, changes: [{ kind: 'price_increase', from: { amount: '45.00' }, to: { amount: '60.00' }, pct: 33.3 }] })
      expect(by.Linear).toMatchObject({ status: 'active', amount: { amount: '24.00' }, next_due: '2026-10-15', changes: [{ kind: 'trial_converted', from: { amount: '1.00' }, to: { amount: '24.00' } }] })
      expect(by['Notion Labs']).toMatchObject({ status: 'suggested', occurrences: 2 })
      expect(by['Amazon Web Services']).toMatchObject({ status: 'active', amount: { amount: '98.00' }, next_due: '2026-10-02', late: true })
      expect(by['Comcast Business']).toMatchObject({ status: 'active', next_due: '2026-10-16' })
      // Payroll and one-off rides aren't subscriptions; monthly cost counts active ones only.
      expect(list.monthly_total_active.map((m) => m.amount)).toEqual(['302.00']) // 60 + 24 + 98 + 120

      const changes = await ai.call<{ recurring: Rec[] }>('list_recurring', { company: 'Acme', changes_only: true })
      expect(changes.recurring.map((r) => r.counterparty).sort()).toEqual(['Linear', 'Slack Technologies'])
      const week = await ai.call<{ recurring: Rec[] }>('list_recurring', { company: 'Acme', due_within_days: 7 })
      expect(week.recurring.map((r) => r.counterparty)).toEqual(['Slack Technologies', 'Linear', 'Comcast Business'])

      // Bills due in 30 days: the open Comcast bill (120) + Slack (60) + Linear (24). Comcast once, not twice.
      const ov = await ai.call<{ companies: Array<{ company: string; bills_due_30d: Wire }> }>('get_overview', {})
      expect(minor(ov.companies.find((c) => c.company === 'Acme')?.bills_due_30d)).toBe(20_400)
      const up = await ai.call<{ items: Array<{ kind: string; what: string; date: string; amount: Wire }> }>('list_upcoming', { company: 'Acme', days: 30 })
      expect(up.items.filter((i) => i.kind === 'subscription').map((i) => [i.what, i.date, i.amount.amount])).toEqual([
        ['Slack Technologies', '2026-10-14', '-60.00'],
        ['Linear', '2026-10-15', '-24.00'],
      ])
      expect(up.items.filter((i) => i.kind === 'bill').map((i) => i.what)).toEqual([expect.stringContaining('Comcast')])

      // The Monday note (week of Oct 12–18): one bill and two recurring charges, $204.
      const sv = srv.booted.services
      const digest = digestWithRecurring(sv.ledger as never, sv.db, () => financeFor(sv).reader)
      const note = await withBypass('test:digest', () => digest?.(s.workspaceId, new Date('2026-10-12T08:00:00Z')))
      expect(note?.lines[3]).toBe('Bills due this week: 3, $204 (2 recurring: Slack Technologies, Linear)')
      await ai.close()
    } finally {
      await srv.close()
    }
  }, 120_000)
})
