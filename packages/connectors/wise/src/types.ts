// The parts of Wise's API responses we read (https://docs.wise.com, legacy endpoints). Everything else stays in the
// raw payload. Wise amounts are JSON numbers in major units ({value: 310.86, currency}); statement amounts are
// signed ("negative for debits"), which is already Aggregate's sign rule.

export interface WiseAmount {
  value: number
  currency: string
}

/** GET /v2/profiles item (flat). Older /v1 shape had lowercase type and a `details` object; both are tolerated. */
export interface WiseProfile {
  id: number
  type: 'PERSONAL' | 'BUSINESS' | 'personal' | 'business' | string
  businessName?: string | null
  fullName?: string | null
  currentState?: string | null
  details?: { name?: string | null; firstName?: string | null; lastName?: string | null } | null
}

/** GET /v4/profiles/{profileId}/balances?types=STANDARD */
export interface WiseBalance {
  id: number
  currency: string
  type: 'STANDARD' | 'SAVINGS' | string
  name?: string | null
  amount: WiseAmount
  reservedAmount?: WiseAmount | null
  cashAmount?: WiseAmount | null
  totalWorth?: WiseAmount | null
  creationTime?: string
  modificationTime?: string
  visible?: boolean
}

export type WiseDetailsType =
  | 'CARD' | 'CONVERSION' | 'DEPOSIT' | 'TRANSFER' | 'MONEY_ADDED' | 'INCOMING_CROSS_BALANCE' | 'OUTGOING_CROSS_BALANCE'
  | 'DIRECT_DEBIT' | 'BALANCE_INTEREST' | 'BALANCE_ADJUSTMENT' | 'UNKNOWN' | 'ACCRUAL_CHARGE' | 'INVESTMENT_TRADE_ORDER'
  | 'ACQUIRING_PAYMENT' | 'CARD_CASHBACK' | 'CARD_ORDER_CHECKOUT' | string

export interface WiseStatementTxn {
  type: 'DEBIT' | 'CREDIT' | string
  date: string
  amount: WiseAmount
  totalFees?: WiseAmount | null
  details: {
    type: WiseDetailsType
    description?: string | null
    senderName?: string | null
    senderAccount?: string | null
    paymentReference?: string | null
    category?: string | null
    amount?: WiseAmount | null
    merchant?: { name?: string | null; category?: string | null; city?: string | null; country?: string | null } | null
    sourceAmount?: WiseAmount | null
    targetAmount?: WiseAmount | null
    fee?: WiseAmount | null
    rate?: number | null
  }
  exchangeDetails?: { forAmount?: WiseAmount | null; rate?: number | null } | null
  runningBalance?: WiseAmount | null
  referenceNumber: string
}

export interface WiseStatement {
  transactions: WiseStatementTxn[]
  endOfStatementBalance?: WiseAmount | null
  query?: { intervalStart: string; intervalEnd: string; currency: string; accountId: number }
}

export interface WiseWebhookBody {
  event_type?: string
  subscription_id?: string
  schema_version?: string
  sent_at?: string
  data?: {
    resource?: { type?: string; id?: number | string; profile_id?: number | string }
    balance_id?: number | string
    currency?: string
    transaction_type?: string
    occurred_at?: string
  }
}
