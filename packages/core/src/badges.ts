// "Verified by Aggregate" badges (launch, for 51's public badge): a company's MRR, its growth and a runway band, each
// with the formula behind it, and whether Aggregate can vouch for them right now. Internal transfers, payouts and
// owner money are never revenue or burn here: the figures come from the same metrics as the app (cash basis), which
// already leave them out.
import type { EntityId, IsoDate, Money, WorkspaceId } from '@agfn/contracts'
import type { LedgerEngine } from './engine.ts'
import { addMonths, monthEnd, monthStart, trailingMonths } from './queries.ts'

export type RunwayBand = 'Under 6 months' | '6–12 months' | '12–24 months' | '24+ months' | 'Not burning'

export interface Badge {
  key: 'mrr' | 'growth' | 'runway'
  label: string
  /** What the badge shows, e.g. "$12,480", "+8.2% in 3 months", "12–24 months". */
  display: string
  state: 'ok' | 'unavailable'
  /** MRR: money; growth: a fraction (0.082); runway: months (never shown exactly, only the band). */
  value: Money | number | null
  band?: RunwayBand
  formula: string
}

export interface VerifiedBadges {
  workspaceId: WorkspaceId
  entityId: EntityId
  /** The last complete month the figures describe (its last day). */
  asOf: IsoDate
  /** True only when the books behind the figures are clean right now (see `reasons`). */
  verified: boolean
  /** Why not verified, in plain words; empty when verified. */
  reasons: string[]
  badges: Badge[]
}

export function runwayBand(months: number | null, notBurning: boolean): RunwayBand | null {
  if (notBurning) return 'Not burning'
  if (months === null) return null
  return months < 6 ? 'Under 6 months' : months < 12 ? '6–12 months' : months < 24 ? '12–24 months' : '24+ months'
}

const isMoney = (v: unknown): v is Money => typeof v === 'object' && v !== null && 'minor' in v
const dollars = (m: Money) => `${m.minor < 0 ? '-' : ''}$${Math.round(Math.abs(m.minor) / 100).toLocaleString('en-US')}`
const pct = (x: number) => `${x >= 0 ? '+' : ''}${(Math.round(x * 1000) / 10).toFixed(1)}%`

/**
 * The badges for one company. `today` defaults to the engine's clock; the figures describe the last complete month.
 * Verified requires the company's data health to be clean (no failing check, nothing waiting for review, no money in
 * transit for over a week, every source synced within a day, no missing month) and enough history for runway (two
 * complete months).
 */
export async function verifiedBadges(engine: Pick<LedgerEngine, 'metric' | 'dataHealth' | 'now'>, ws: WorkspaceId, entityId: EntityId, opts: { today?: IsoDate } = {}): Promise<VerifiedBadges> {
  const today = opts.today ?? engine.now().slice(0, 10)
  const [last] = trailingMonths(today, 1) as [{ from: IsoDate; to: IsoDate }]
  const asOf = last.to
  const scope = { workspaceId: ws, entityIds: [entityId] }
  const reasons: string[] = []
  const badges: Badge[] = []

  // MRR at the end of the last complete month, and three months before it.
  const threeBack = monthEnd(addMonths(monthStart(asOf), -3))
  const [mrr, mrrThen] = await Promise.all([engine.metric('mrr', { ...scope, to: asOf }), engine.metric('mrr', { ...scope, to: threeBack })])
  const hasMrr = mrr.state === 'ok' && isMoney(mrr.value) && mrr.value.minor > 0
  badges.push(
    hasMrr
      ? { key: 'mrr', label: 'MRR', display: dollars(mrr.value as Money), state: 'ok', value: mrr.value as Money, formula: `Monthly recurring revenue from active subscriptions on ${asOf} (Stripe's definition: after discounts, without tax or usage).` }
      : { key: 'mrr', label: 'MRR', display: '—', state: 'unavailable', value: null, formula: 'No subscription revenue: MRR needs a subscription source such as Stripe Billing.' },
  )

  // Growth: MRR over three months when there is MRR to grow; else revenue, the last three months against the three before.
  if (hasMrr && isMoney(mrrThen.value) && mrrThen.value.minor > 0) {
    const g = (mrr.value as Money).minor / mrrThen.value.minor - 1
    badges.push({ key: 'growth', label: 'MRR growth', display: `${pct(g)} in 3 months`, state: 'ok', value: g, formula: `MRR on ${asOf} (${dollars(mrr.value as Money)}) ÷ MRR on ${threeBack} (${dollars(mrrThen.value)}) − 1.` })
  } else {
    const recent = trailingMonths(today, 3)
    const before = trailingMonths(recent[0]!.from, 3)
    const [a, b] = await Promise.all([
      engine.metric('revenue', { ...scope, from: recent[0]!.from, to: recent[2]!.to, basis: 'cash' }),
      engine.metric('revenue', { ...scope, from: before[0]!.from, to: before[2]!.to, basis: 'cash' }),
    ])
    if (isMoney(a.value) && isMoney(b.value) && b.value.minor > 0) {
      const g = a.value.minor / b.value.minor - 1
      badges.push({ key: 'growth', label: 'Revenue growth', display: `${pct(g)} vs the 3 months before`, state: 'ok', value: g, formula: `Revenue ${recent[0]!.from} to ${recent[2]!.to} (${dollars(a.value)}) ÷ revenue ${before[0]!.from} to ${before[2]!.to} (${dollars(b.value)}) − 1. Cash basis, gross of processor fees; transfers, payouts, refunds of spending and owner money are not revenue.` })
    } else {
      badges.push({ key: 'growth', label: 'Growth', display: '—', state: 'unavailable', value: null, formula: 'Needs six complete months with revenue.' })
    }
  }

  // Runway, shown only as a band.
  const runway = await engine.metric('runway', { ...scope, to: today })
  const band = runwayBand(typeof runway.value === 'number' ? runway.value : null, runway.state === 'not_burning')
  badges.push(
    band
      ? { key: 'runway', label: 'Runway', display: band, state: 'ok', value: typeof runway.value === 'number' ? runway.value : null, band, formula: `${runway.formula ?? ''} Shown as a band; transfers between the company's own accounts are not burn.`.trim() }
      : { key: 'runway', label: 'Runway', display: '—', state: 'unavailable', value: null, formula: 'Needs at least two complete months of bank history.' },
  )

  // Can Aggregate vouch for it? Exactly when the company's data health is clean (its "All reconciled": nothing failing,
  // waiting for review, in transit, stale or missing), and runway has its history. Counted from the totals: the items
  // list stops at ten.
  const { counts } = await engine.dataHealth(ws, [entityId])
  const n = (k: keyof typeof counts) => counts[k] ?? 0
  const plural = (x: number, one: string, many: string) => `${x} ${x === 1 ? one : many}`
  if (n('failedChecks')) reasons.push(`${plural(n('failedChecks'), 'reconciliation check', 'reconciliation checks')} failing`)
  if (n('toReview')) reasons.push(`${plural(n('toReview'), 'question', 'questions')} waiting for review`)
  if (n('unmatchedInTransit')) reasons.push(`${n('unmatchedInTransit') === 1 ? 'Money' : `${n('unmatchedInTransit')} amounts`} in transit for over a week`)
  if (n('staleSources')) reasons.push(`${plural(n('staleSources'), 'source', 'sources')} not synced in the last day`)
  if (n('notTiedOut')) reasons.push(`${plural(n('notTiedOut'), 'account', 'accounts')} not tied out yet`)
  if (n('missingStatements')) reasons.push(`${plural(n('missingStatements'), 'month', 'months')} of statements missing`)
  if (runway.state === 'not_enough_history') reasons.push('Not enough history yet (two complete months of bank activity)')
  return { workspaceId: ws, entityId, asOf, verified: reasons.length === 0, reasons, badges }
}
