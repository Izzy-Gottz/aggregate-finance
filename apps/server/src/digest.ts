// The Monday note's "Bills due this week" line: open bills (the ledger's digest), plus recurring charges expected
// this week that aren't billed yet (subscriptions paid by card, utilities, SaaS), plus card and loan minimum payments
// due (from the provider's terms). Everything else is the ledger's.
import type { FinanceReader, Money } from '@agfn/contracts'
import type { CoreTables } from '@agfn/db'
import { shortMoney, type WeeklyDigest } from '@agfn/core'
import { createRecurring } from '@agfn/recurring'
import type { Kysely } from 'kysely'
import type { DigestSource } from './notify.ts'
import { termsReader, type TermsTables } from './account-terms.ts'

type DigestLedger = {
  weeklyDigest?: (ws: string, asOf: Date) => Promise<{ subject: string; lines: string[] } | null>
  weeklyDigestDetail?: (ws: string, asOf?: string) => Promise<WeeklyDigest>
  metricContext?: (ws: string) => { toCurrency(amount: Money, to: string, date: string): Promise<Money> }
}

const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)

export function digestWithRecurring(ledger: DigestLedger, db: Kysely<CoreTables>, reader: () => FinanceReader): DigestSource | undefined {
  if (!ledger.weeklyDigestDetail) return ledger.weeklyDigest ? (ws, asOf) => (ledger.weeklyDigest as NonNullable<DigestLedger['weeklyDigest']>).call(ledger, ws, asOf) : undefined
  return async (ws, asOf) => {
    const date = asOf.toISOString().slice(0, 10)
    const d = await (ledger.weeklyDigestDetail as NonNullable<DigestLedger['weeklyDigestDetail']>).call(ledger, ws, date)
    if (!d.hasData) return null
    const companies = (await db.selectFrom('entities').select('id').where('workspace_id', '=', ws).where('kind', '=', 'company').where('archived_at', 'is', null).execute()).map((e) => e.id)
    const scope = { workspaceId: ws, entityIds: companies }
    const window = Math.max(0, days(date, d.data.billsDue.through))
    // A charge in another currency counts at the day's rate (a euro subscription is still due this week).
    const fx = ledger.metricContext?.(ws)
    const inHome = async <T extends { amount: Money }>(xs: T[]): Promise<T[]> => {
      const out: T[] = []
      for (const x of xs) {
        if (x.amount.currency === d.currency) out.push(x)
        else if (fx) {
          const { minor, currency } = await fx.toCurrency(x.amount, d.currency, date)
          out.push({ ...x, amount: { minor, currency } })
        }
      }
      return out
    }
    const payments = await inHome(await termsReader(db as unknown as Kysely<CoreTables & TermsTables>).paymentsDue(scope, date, window).catch(() => []))
    const due = await inHome(
      await createRecurring(reader())
        .due(scope, date, window)
        .catch(() => []),
    )
    // A recurring guess at a payment that is already scheduled counts once (same rule as bills_due_30d).
    const subs = due.filter((r) => r.amount.currency === d.currency && !payments.some((p) => p.entityId === r.entityId && Math.abs(Math.abs(p.amount.minor) - r.amount.minor) <= 0.075 * Math.max(Math.abs(p.amount.minor), r.amount.minor)))
    if (!subs.length && !payments.length) return { subject: d.subject, lines: [...d.lines] }
    const count = d.data.billsDue.count + subs.length + payments.length
    const total = { minor: d.data.billsDue.total.minor + subs.reduce((n, r) => n + r.amount.minor, 0) - payments.reduce((n, p) => n + p.amount.minor, 0), currency: d.currency }
    const names = (xs: string[]) => `${xs.slice(0, 3).join(', ')}${xs.length > 3 ? '…' : ''}`
    const cards = payments.filter((p) => p.paymentOf === 'card').map((p) => p.what.replace(/ minimum payment$/, ''))
    const loans = payments.filter((p) => p.paymentOf === 'loan').map((p) => p.what.replace(/ minimum payment$/, ''))
    const parts = [
      ...(subs.length ? [`${subs.length} recurring: ${names(subs.map((r) => r.counterparty))}`] : []),
      ...(cards.length ? [`${cards.length} card payment${cards.length > 1 ? 's' : ''}: ${names(cards)}`] : []),
      ...(loans.length ? [`${loans.length} loan payment${loans.length > 1 ? 's' : ''}: ${names(loans)}`] : []),
    ]
    const lines = [...d.lines]
    lines[3] = `Bills due this week: ${count}, ${shortMoney(total)} (${parts.join('; ')})`
    return { subject: d.subject, lines }
  }
}
