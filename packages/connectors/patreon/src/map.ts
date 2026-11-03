// Patreon member → SubscriptionUpsert. One member is one subscription: "The record of a user's membership to a
// campaign. Remains consistent across months of pledging", so a patron who leaves and comes back is the same record.
//
//   former_patron                       canceled, MRR 0, ended at the last charge (Patreon gives no end date)
//   is_free_trial                       trialing, MRR 0
//   declined_patron                     past_due, at the entitled amount, or what the next cycle would charge if the
//                                       decline already took the entitlement to 0
//   active_patron with a positive amount  active
//   anything else (0 cents, no status, a gift):
//     paid before                       canceled, MRR 0: a patron who dropped to the free tier must leave MRR, because
//                                       nothing else would ever end the subscription
//     never paid                        skipped: a free member isn't a subscription, and a creator can have a great many
//
// Gifts count as free: is_gifted is "from a free gift", one-off money rather than recurring revenue (and Patreon's
// developer forum reports they show 0 cents anyway).
//
// Annual and other non-monthly pledges: Patreon's API docs say pledge_cadence is the "Number of months between charges"
// but not whether currently_entitled_amount_cents is per charge or per month. Patreon's own WordPress plugin treats it
// as per charge ("Convert annual pledges into a monthly total": amount ÷ cadence), so this does too, and the sync warns
// until it has been checked against a real annual patron.
//
// Currency: the campaign's. The docs give campaign_lifetime_support_cents "in the campaign's currency" but no currency
// for currently_entitled_amount_cents, and a pledge can be in the patron's own. The only per-member currency is on the
// pledge_history include, whose fields[] type name the docs don't give, so a mismatch can't be detected here.

import type { Money, SubscriptionUpsert } from '@agfn/contracts'
import { isoTimestamp } from '@agfn/connector-sdk'
import { PATREON_MEMBER_FIELDS } from './client.ts'
import type { PatreonMember, PatreonMemberAttributes } from './types.ts'

export interface PatreonCampaignRef {
  id: string
  currency: string
}

export interface MappedMember {
  event: SubscriptionUpsert
  /** A paying pledge billed less often than monthly. */
  nonMonthly?: boolean
  /** A paying pledge with no usable pledge_cadence, counted as monthly. */
  cadenceUnknown?: boolean
}

/** Cents per charge → cents per month: exact integers, rounded once, half up. */
export function monthlyCents(cents: number, cadence: number): number {
  return Math.floor((2 * cents + cadence) / (2 * cadence))
}

function cadenceOf(a: PatreonMemberAttributes): number | undefined {
  const raw = a.pledge_cadence
  const n = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : raw
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : undefined
}

const cents = (v: number | null | undefined) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0)

/** What's kept of a member: the requested fields, even if Patreon ever sends more. */
export function rawMember(m: PatreonMember, campaignId: string): Record<string, unknown> {
  const a = (m.attributes ?? {}) as Record<string, unknown>
  return { id: m.id, campaignId, attributes: Object.fromEntries(PATREON_MEMBER_FIELDS.map((k) => [k, a[k] ?? null])) }
}

export function mapMember(m: PatreonMember, campaign: PatreonCampaignRef, nowIso: string, connectionId: string, rawRef: string): MappedMember | undefined {
  const a = m.attributes ?? {}
  const amount = cents(a.currently_entitled_amount_cents)
  const cadence = cadenceOf(a)
  const every = cadence ?? 1
  const money = (minor: number): Money => ({ minor, currency: campaign.currency })
  const startedAt = isoTimestamp(a.pledge_relationship_start ?? a.last_charge_date ?? nowIso)
  const nextCharge = a.next_charge_date ? { currentPeriodEnd: isoTimestamp(a.next_charge_date) } : {}
  const base = (perCharge: number) => ({
    type: 'subscription.upsert' as const,
    externalId: m.id,
    connectionId,
    rawRef,
    customer: m.id,
    interval: every === 12 ? ('year' as const) : ('month' as const),
    intervalCount: every === 12 ? 1 : every,
    startedAt,
    ...(perCharge > 0 ? { items: [{ priceExternalId: campaign.id, quantity: 1, amount: money(perCharge) }] } : {}),
  })
  const ended = (perCharge: number): MappedMember => {
    const at = a.last_charge_date ? isoTimestamp(a.last_charge_date) : startedAt
    return { event: { ...base(perCharge), status: 'canceled', mrr: money(0), canceledAt: at, endedAt: at } }
  }
  const live = (status: 'active' | 'past_due', perCharge: number): MappedMember => ({
    event: { ...base(perCharge), status, mrr: money(monthlyCents(perCharge, every)), ...nextCharge },
    ...(every > 1 ? { nonMonthly: true } : {}),
    ...(cadence === undefined ? { cadenceUnknown: true } : {}),
  })

  if (a.patron_status === 'former_patron') return ended(amount)
  if (a.is_free_trial === true) return { event: { ...base(amount), status: 'trialing', mrr: money(0), ...nextCharge } }
  if (a.patron_status === 'declined_patron') return live('past_due', amount || cents(a.will_pay_amount_cents))
  if (a.patron_status === 'active_patron' && amount > 0 && a.is_gifted !== true) return live('active', amount)
  return cents(a.campaign_lifetime_support_cents) > 0 ? ended(0) : undefined
}
