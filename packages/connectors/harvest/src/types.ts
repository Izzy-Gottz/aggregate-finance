// Harvest API v2 shapes, only the fields Aggregate reads. Harvest can't be asked for fewer fields, so its responses also
// carry the client, line items, subject, notes and who recorded a payment; those are read past and never kept.

export interface HarvestInvoice {
  id: number
  /** draft, open, paid or closed (written off). */
  state: string
  currency: string
  amount: number
  due_amount: number
  tax_amount: number | null
  tax2_amount: number | null
  /** YYYY-MM-DD. */
  issue_date: string
  /** YYYY-MM-DD, once paid in full. */
  paid_date: string | null
}

export interface HarvestPayment {
  id: number
  amount: number
  paid_date: string | null
  paid_at?: string | null
}

export interface HarvestAccount {
  id: number
  name: string
  product: string
}
