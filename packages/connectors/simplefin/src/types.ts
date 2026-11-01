// SimpleFIN protocol v2 (https://www.simplefin.org/protocol.html): the parts Aggregate reads.

export interface SfConnection {
  conn_id: string
  name?: string
  org_id?: string
  org_url?: string
  sfin_url?: string
}

export interface SfError {
  code: string
  msg: string
  conn_id?: string
  account_id?: string
}

export interface SfTransaction {
  id: string
  /** Unix seconds; 0 while pending. */
  posted: number
  /** Decimal string, positive = money in. */
  amount: string
  description: string
  /** Protocol v2: the cleaned-up name of who was paid or paid you. */
  payee?: string
  /** Protocol v2: the bank's raw text. */
  memo?: string
  transacted_at?: number
  pending?: boolean
  extra?: Record<string, unknown>
}

export interface SfAccount {
  id: string
  name: string
  conn_id?: string
  currency: string
  balance: string
  'available-balance'?: string
  /** Unix seconds. */
  'balance-date': number
  transactions?: SfTransaction[]
  extra?: Record<string, unknown>
  /** v1 only. */
  org?: { name?: string; domain?: string }
}

export interface SfAccountSet {
  errlist?: SfError[]
  /** Deprecated display strings (v1); the Bridge also puts quota warnings here. */
  errors?: string[]
  connections?: SfConnection[]
  accounts: SfAccount[]
}
