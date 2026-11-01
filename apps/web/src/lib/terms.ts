import type { AccountTerms } from '../api/types.ts'
import { fmt } from './money.ts'
import { shortDate } from './time.ts'

/** "Min $35 due Oct 28 · 24.9% APR": only the parts the provider sent; null when it sent none. */
export function termsLine(t: AccountTerms | undefined): string | null {
  if (!t) return null
  const parts: string[] = []
  const due = t.nextPaymentDueDate ? `due ${shortDate(t.nextPaymentDueDate)}` : null
  if (t.minimumPayment) parts.push(`Min ${fmt(t.minimumPayment)}${due ? ' ' + due : ''}`)
  else if (due) parts.push(`Payment ${due}`)
  const apr = t.apr != null ? Number(t.apr) : NaN
  if (Number.isFinite(apr)) parts.push(`${Number(apr.toFixed(2))}% APR`)
  return parts.length ? parts.join(' · ') : null
}
