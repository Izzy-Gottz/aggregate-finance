// The Patreon API v2 fields Aggregate asks for, nothing else (JSON:API shape). Every attribute is optional: v2 returns
// only what's requested, and the docs mark most of these "Can be null".

export interface PatreonMemberAttributes {
  patron_status?: string | null
  currently_entitled_amount_cents?: number | null
  will_pay_amount_cents?: number | null
  /** "Number of months between charges." The docs type it as a string; Patreon's own plugin compares it as a number. */
  pledge_cadence?: number | string | null
  is_free_trial?: boolean | null
  is_gifted?: boolean | null
  last_charge_status?: string | null
  last_charge_date?: string | null
  next_charge_date?: string | null
  pledge_relationship_start?: string | null
  campaign_lifetime_support_cents?: number | null
}

export interface PatreonMember {
  id: string
  attributes?: PatreonMemberAttributes
}

export interface PatreonCampaign {
  id: string
  attributes?: { currency?: string | null; is_monthly?: boolean | null; pay_per_name?: string | null }
}

export interface PatreonList<T> {
  data?: T[]
  meta?: { pagination?: { cursors?: { next?: string | null }; total?: number } }
}
