// The parts of Shopify's GraphQL Admin API we read (ShopifyPaymentsAccount, its payouts and balance transactions).

export interface MoneyV2 {
  /** Decimal string, e.g. "12.34". */
  amount: string
  currencyCode: string
}

export interface PageInfo {
  hasNextPage: boolean
  endCursor?: string | null
}

export interface ShopifyPayoutSummary {
  adjustmentsFee?: MoneyV2
  adjustmentsGross?: MoneyV2
  advanceFees?: MoneyV2
  advanceGross?: MoneyV2
  chargesFee?: MoneyV2
  chargesGross?: MoneyV2
  refundsFee?: MoneyV2
  refundsFeeGross?: MoneyV2
  reservedFundsFee?: MoneyV2
  reservedFundsGross?: MoneyV2
  retriedPayoutsFee?: MoneyV2
  retriedPayoutsGross?: MoneyV2
}

export interface ShopifyPayout {
  id: string
  legacyResourceId?: string
  issuedAt: string
  /** SCHEDULED, IN_TRANSIT, PAID, FAILED, CANCELED. */
  status: string
  /** DEPOSIT (to the bank) or WITHDRAWAL (back from the bank). */
  transactionType?: string
  net: MoneyV2
  summary?: ShopifyPayoutSummary | null
}

export interface ShopifyBalanceTransaction {
  id: string
  type: string
  test: boolean
  amount: MoneyV2
  fee: MoneyV2
  net: MoneyV2
  sourceType?: string | null
  sourceId?: string | null
  sourceOrderTransactionId?: string | null
  associatedPayout?: { id?: string | null; status?: string | null } | null
  transactionDate: string
  adjustmentReason?: string | null
}

export interface ShopifyPaymentsAccountInfo {
  id: string
  activated?: boolean
  defaultCurrency?: string
  balance: MoneyV2[]
}

export interface GraphQLError {
  message: string
  path?: Array<string | number>
  extensions?: { code?: string; requiredAccess?: string; documentation?: string }
}

export interface ThrottleStatus {
  maximumAvailable: number
  currentlyAvailable: number
  restoreRate: number
}

export interface GraphQLResponse<T> {
  data?: T | null
  errors?: GraphQLError[] | string
  extensions?: { cost?: { requestedQueryCost?: number; actualQueryCost?: number | null; throttleStatus?: ThrottleStatus } }
}
