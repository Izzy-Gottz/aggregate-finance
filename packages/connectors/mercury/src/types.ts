// The parts of Mercury's API responses we read (https://docs.mercury.com/reference). Everything else stays in the
// raw payload. Amounts are JSON numbers in dollars (multipleOf 0.01), signed from the account's point of view (money
// in positive, out negative), which is already Aggregate's sign rule. Mercury documents that sign only on
// merchant.amount; for credit accounts it says balances are "usually negative" (balance-events changelog), which fits.
// Careful: the credit statement endpoint (not read here) returns charges positive and payments negative.

export interface MercuryPageInfo {
  nextPage?: string | null
  previousPage?: string | null
}

export interface MercuryAccount {
  id: string
  name: string
  nickname?: string | null
  accountNumber?: string | null
  routingNumber?: string | null
  status: 'active' | 'deleted' | 'pending' | 'archived' | string
  /** 'mercury' for Mercury-held accounts; 'external' / 'recipient' for linked ones. */
  type: 'mercury' | 'external' | 'recipient' | string
  /** Free string; documented example 'checking' (savings exists too). */
  kind: string
  availableBalance: number
  currentBalance: number
  createdAt?: string
  legalBusinessName?: string | null
}

export interface MercuryAccountsResponse {
  accounts: MercuryAccount[]
  page?: MercuryPageInfo
}

/** GET /credit: Mercury IO credit card accounts. */
export interface MercuryCreditAccount {
  id: string
  status: string
  createdAt?: string
  availableBalance: number
  currentBalance: number
}

/** GET /treasury */
export interface MercuryTreasuryAccount {
  id: string
  status: string
  createdAt?: string
  availableBalance: number
  currentBalance: number
}

export type MercuryTxnStatus = 'pending' | 'sent' | 'cancelled' | 'failed' | 'reversed' | 'blocked'

export interface MercuryTransaction {
  id: string
  accountId?: string
  amount: number
  status: MercuryTxnStatus | string
  kind: string
  createdAt: string
  postedAt?: string | null
  estimatedDeliveryDate?: string | null
  failedAt?: string | null
  counterpartyId?: string | null
  counterpartyName?: string | null
  counterpartyNickname?: string | null
  bankDescription?: string | null
  note?: string | null
  externalMemo?: string | null
  feeId?: string | null
  cardId?: string | null
  checkNumber?: string | null
  mercuryCategory?: string | null
  relatedTransactions?: Array<{ id: string; accountId?: string; amount?: number; relationKind?: string }> | null
}

export interface MercuryTransactionsResponse {
  total: number
  transactions: MercuryTransaction[]
}

/** Webhook / Events API body. */
export interface MercuryEvent {
  id: string
  resourceType: string
  resourceId: string
  operationType: 'create' | 'update' | 'delete' | string
  occurredAt?: string
  mergePatch?: Record<string, unknown>
}
