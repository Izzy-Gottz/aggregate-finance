// The cap table as an append-only list of objects, shaped after Open Cap Format (OCF 1.x) so import/export is a mapping,
// not a translation. Objects are facts (a stakeholder, a share class, a plan, a 409A) or transactions (an issuance, a
// transfer, a SAFE, a grant…). The current cap table is a pure replay of them (captable.ts). Money is minor units;
// share prices may be fractional minor units (founder shares at $0.0001 = 0.01 cents). Cash posted to the ledger is
// always rounded to whole minor units.

import type { Money } from '@agfn/contracts'

export type IsoDate = string

export interface Vesting {
  /** Vesting commencement date. */
  start: IsoDate
  /** Total months, e.g. 48. */
  months: number
  /** Nothing vests before the cliff; then the cliff's share vests at once. e.g. 12. */
  cliffMonths: number
}

export interface StakeholderObj {
  type: 'STAKEHOLDER'
  id: string
  name: string
  stakeholderType: 'INDIVIDUAL' | 'INSTITUTION'
  relationship?: 'FOUNDER' | 'EMPLOYEE' | 'INVESTOR' | 'ADVISOR' | 'BOARD_MEMBER' | 'CONSULTANT' | 'OTHER'
  email?: string
}

export interface StockClassObj {
  type: 'STOCK_CLASS'
  id: string
  name: string
  classType: 'COMMON' | 'PREFERRED'
  authorized: number | null
  /** Higher is paid first in a liquidation. Common is 0. */
  seniority: number
  /** Original issue price, the basis of the liquidation preference. */
  pricePerShare?: Money
  /** 1 = 1x preference. */
  liquidationPrefMultiple: number
  participating: boolean
  /** Participating preferred stops at this multiple of its issue price (total, preference included). null = uncapped. */
  participationCapMultiple: number | null
  /** Common shares per preferred share. */
  conversionRatio: number
}

export interface StockPlanObj {
  type: 'STOCK_PLAN'
  id: string
  name: string
  stockClassId: string
  size: number
}

export interface ValuationObj {
  type: 'VALUATION'
  id: string
  date: IsoDate
  stockClassId: string
  pricePerShare: Money
  kind: '409A' | 'OTHER'
  provider?: string
}

export interface StockIssuanceTx {
  type: 'TX_STOCK_ISSUANCE'
  id: string
  date: IsoDate
  securityId: string
  stakeholderId: string
  stockClassId: string
  quantity: number
  pricePerShare?: Money
  vesting?: Vesting
  /** Shares bought for services or another non-cash reason (no cash posts to the ledger). */
  noCash?: boolean
}

export interface StockTransferTx {
  type: 'TX_STOCK_TRANSFER'
  id: string
  date: IsoDate
  securityId: string
  quantity: number
  toStakeholderId: string
}

export interface StockCancellationTx {
  type: 'TX_STOCK_CANCELLATION'
  id: string
  date: IsoDate
  securityId: string
  quantity: number
  reason?: string
}

export interface ConvertibleIssuanceTx {
  type: 'TX_CONVERTIBLE_ISSUANCE'
  id: string
  date: IsoDate
  securityId: string
  stakeholderId: string
  kind: 'SAFE' | 'NOTE'
  amount: Money
  valuationCap?: Money
  /** e.g. 20 for 20% off the round price. */
  discountPct?: number
  /** Notes: simple annual interest, e.g. 8. */
  interestPct?: number
  maturityDate?: IsoDate
  /** YC post-money SAFE (default for SAFEs) or pre-money (classic SAFEs and most notes). */
  timing: 'POST_MONEY' | 'PRE_MONEY'
}

export interface ConvertibleConversionTx {
  type: 'TX_CONVERTIBLE_CONVERSION'
  id: string
  date: IsoDate
  securityId: string
  /** The stock issuances it became (recorded as their own TX_STOCK_ISSUANCE objects). */
  resultingSecurityIds: string[]
}

export interface ConvertibleCancellationTx {
  type: 'TX_CONVERTIBLE_CANCELLATION'
  id: string
  date: IsoDate
  securityId: string
  reason?: string
}

export interface GrantTx {
  type: 'TX_EQUITY_COMPENSATION_ISSUANCE'
  id: string
  date: IsoDate
  securityId: string
  stakeholderId: string
  stockPlanId?: string
  stockClassId: string
  compensationType: 'OPTION_ISO' | 'OPTION_NSO' | 'RSU' | 'WARRANT'
  quantity: number
  exercisePrice?: Money
  vesting?: Vesting
  expirationDate?: IsoDate
}

export interface ExerciseTx {
  type: 'TX_EQUITY_COMPENSATION_EXERCISE'
  id: string
  date: IsoDate
  securityId: string
  quantity: number
  /** The stock issuance created by the exercise. */
  resultingSecurityId: string
}

/** RSUs settling: vested units become shares. Units withheld for tax are used up but not issued (net settlement). */
export interface ReleaseTx {
  type: 'TX_EQUITY_COMPENSATION_RELEASE'
  id: string
  date: IsoDate
  securityId: string
  /** Units released, withheld ones included. */
  quantity: number
  /** Units kept back to cover tax; quantity − withheld shares are issued. */
  withheld?: number
  /** The stock issuance created by the release. */
  resultingSecurityId: string
}

/** A warrant: the right to buy shares of a class (often preferred, often to a lender) at a fixed price until it expires. */
export interface WarrantIssuanceTx {
  type: 'TX_WARRANT_ISSUANCE'
  id: string
  date: IsoDate
  securityId: string
  stakeholderId: string
  /** The class it turns into when exercised. */
  stockClassId: string
  quantity: number
  exercisePrice?: Money
  /** What the holder paid for the warrant itself, if anything (posts as cash). */
  purchasePrice?: Money
  expirationDate?: IsoDate
}

export interface WarrantExerciseTx {
  type: 'TX_WARRANT_EXERCISE'
  id: string
  date: IsoDate
  securityId: string
  /** Warrant shares used up. */
  quantity: number
  /** Cashless (net) exercise: pays the price in shares at this fair value per share; no cash moves. */
  netFairValue?: Money
  resultingSecurityId: string
}

export interface WarrantCancellationTx {
  type: 'TX_WARRANT_CANCELLATION'
  id: string
  date: IsoDate
  securityId: string
  quantity: number
  reason?: string
}

export interface GrantCancellationTx {
  type: 'TX_EQUITY_COMPENSATION_CANCELLATION'
  id: string
  date: IsoDate
  securityId: string
  quantity: number
  reason?: string
}

export interface PoolAdjustmentTx {
  type: 'TX_STOCK_PLAN_POOL_ADJUSTMENT'
  id: string
  date: IsoDate
  stockPlanId: string
  /** New total size of the pool. */
  size: number
}

export interface AuthorizedAdjustmentTx {
  type: 'TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT'
  id: string
  date: IsoDate
  stockClassId: string
  authorized: number
}

export type EquityObject =
  | StakeholderObj
  | StockClassObj
  | StockPlanObj
  | ValuationObj
  | StockIssuanceTx
  | StockTransferTx
  | StockCancellationTx
  | ConvertibleIssuanceTx
  | ConvertibleConversionTx
  | ConvertibleCancellationTx
  | GrantTx
  | ExerciseTx
  | GrantCancellationTx
  | ReleaseTx
  | WarrantIssuanceTx
  | WarrantExerciseTx
  | WarrantCancellationTx
  | PoolAdjustmentTx
  | AuthorizedAdjustmentTx

export type ObjectType = EquityObject['type']

export const FACT_TYPES: ReadonlySet<ObjectType> = new Set(['STAKEHOLDER', 'STOCK_CLASS', 'STOCK_PLAN', 'VALUATION'])

/** Facts have no date of their own; sort them first. Transactions sort by date. */
export function objectDate(o: EquityObject): IsoDate {
  return 'date' in o ? o.date : '0000-01-01'
}

/** Banks, funds, trusts and companies are institutions, not people (OCF stakeholder_type). */
export const looksInstitutional = (name: string): boolean =>
  /\b(llc|inc|lp|l\.p\.|fund|ventures|capital|partners|ltd|gmbh|bank|bancorp|trust|holdings|group|corp|corporation|plc)\b/i.test(name)
