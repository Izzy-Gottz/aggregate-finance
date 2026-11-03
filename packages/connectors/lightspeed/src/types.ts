// Lightspeed Retail X-Series shapes (API 2026-10), only the fields Aggregate reads. A sale also carries line_items,
// customer_id, payments and note, and no parameter drops them from the response. They aren't typed here so nothing can read
// them: Lightspeed's terms need written approval for transaction data identifying the items bought.

export interface LightspeedSaleTotals {
  /** Tax exclusive. */
  price: number
  tax: number
}

export interface LightspeedSale {
  id: string
  /** RFC 3339, UTC. */
  date: string
  /** parked, pending, voided or closed. */
  state: string
  deleted_at?: string | null
  totals: LightspeedSaleTotals
}

export interface LightspeedRetailer {
  currency?: { code?: string }
  /** Default for the store; outlets can differ. */
  timezone?: string
}

export interface LightspeedSearchPage {
  data: unknown[]
  total_count?: number
  page_info?: { has_next_page?: boolean }
}
