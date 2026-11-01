// The provider's own exchange rate on a foreign-currency document (QuickBooks ExchangeRate, Xero CurrencyRate), so the
// ledger converts at the rate the books used instead of its market rate for the day.
import type { Currency, NormalizedEvent, ProviderFx } from '@agfn/contracts'

/** A rate (home units per 1 foreign) as a plain decimal string, or undefined when it isn't a positive number. */
export function rateString(v: unknown): string | undefined {
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined
  // Plain digits (never 1e-7), at most 12 significant digits.
  const s = Number(n.toPrecision(12)).toFixed(12).replace(/\.?0+$/, '')
  return s === '0' ? undefined : s
}

/** The ProviderFx for a document in `currency` when the books are in `home`; undefined for home-currency documents. */
export function providerFx(currency: Currency, home: Currency, rate: unknown): ProviderFx | undefined {
  if (currency === home) return undefined
  const r = rateString(rate)
  return r ? { rate: r, home } : undefined
}

function amountOf(e: NormalizedEvent): Currency | undefined {
  switch (e.type) {
    case 'invoice.upsert':
      return e.total.currency
    case 'payment.applied':
    case 'credit_note.upsert':
    case 'txn.upsert':
      return e.amount.currency
    case 'journal.upsert':
      return e.lines[0]?.amount.currency
    default:
      return undefined
  }
}

/** Puts `fx` on the events a document produced that are in the document's currency (fee lines in home stay as they are). */
export function withFx(events: NormalizedEvent[], currency: Currency, fx: ProviderFx | undefined): NormalizedEvent[] {
  if (!fx) return events
  return events.map((e) => (amountOf(e) === currency ? ({ ...e, fx } as NormalizedEvent) : e))
}
