// WooCommerce REST API v3 shapes, only the fields Aggregate asks for. Dates are the store's own time zone, without an
// offset; amounts are decimal strings. No customer field appears here because none is requested.

export interface WooOrder {
  id: number
  status: string
  currency: string
  date_created: string
  total: string
  total_tax: string
  shipping_total: string
}

export interface WooRefundLine {
  /** Negative on a refund. */
  total?: string
  total_tax?: string
}

export interface WooRefund {
  id: number
  parent_id: number
  date_created: string
  /** Positive: everything refunded, tax and shipping included. */
  amount: string
  line_items?: WooRefundLine[]
  shipping_lines?: WooRefundLine[]
  fee_lines?: WooRefundLine[]
}

export interface WooOrderRef {
  id: number
  status: string
  currency: string
}
