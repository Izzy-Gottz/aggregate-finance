// One Amazon settlement (financial event group), added up exactly in minor units by category, then checked against what
// Amazon says it paid before anything is sent.
//
// Every amount Amazon sends is signed as money into the seller's balance: a Principal charge is positive, a referral fee
// negative, a refund's charge adjustment negative and its fee adjustment positive. Amounts are added as sent, never by
// absolute value, so a sign this file reads wrongly can't hide: the check below fails instead. Categories:
//
//   sales        Principal, ShippingCharge, Giftwrap, Discount and the COD charges on shipments; their promotions; FBA
//                liquidation proceeds; removal-order revenue. Kind 'charge'.
//   fees         Every FeeComponent outside refunds and disputes (referral, FBA, closing, service, imaging, trial fees),
//                plus the event kinds that are a fee as a whole: Sponsored Products, deals, coupons, Early Reviewer,
//                value-added services, capacity reservation, charge refunds (a fee correction). Kind 'fee'.
//   refunds      RefundEventList: charge and promotion adjustments as gross, fee adjustments (Amazon handing its fee
//                back, less its refund administration fee) as a negative fee. Kind 'refund'.
//   disputes     ChargebackEventList and GuaranteeClaimEventList, the same way. Kind 'dispute'.
//   tax          Every tax charge (Tax, ShippingTax, GiftwrapTax, the COD tax charges, TaxDiscount) together with every
//                TaxesWithheld component (MarketplaceFacilitatorTax-*: Amazon collects it and remits it), retrocharges,
//                and removal-order tax less what Amazon withheld. Where Amazon is the marketplace facilitator these net
//                to zero. salesTax: true, so none of it is revenue.
//   reserve      AdjustmentEventList's ReserveEvent: money held back, still the seller's (balanceRole other_assets).
//   loan         LoanServicingEventList: a seller loan's advance and repayments (balanceRole other_liabilities).
//   adjustments  Everything else Amazon lists that moves the balance: other adjustment events, reimbursements, debt
//                recovery, direct payments, ad hoc disbursements, income tax withheld, other charge types on shipments.
//
// Fields that break a total down (AdjustmentItemList, DebtRecoveryItemList, ChargeInstrumentList, SAFE-T items, a total's
// own base and tax, RentalInitialValue, TaxWithholding BaseAmount) are never added: their parent's amount already holds
// them. An event list Aggregate doesn't know stops the sync rather than be left out.
//
// The check: the categories must sum to OriginalTotal exactly. If they don't, the group's BeginningBalance is tried as
// money carried in from the last settlement (the model calls it "the balance at the start of the settlement period"; its
// relation to OriginalTotal isn't documented) and kept as its own row. Neither: nothing from the group is sent.

import { ConnectorError, isRecord, toMinor, currencyExponent } from '@agfn/connector-sdk'
import { unreadable } from './client.ts'

const PROVIDER = 'amazon'

export type Category = 'sales' | 'fees' | 'refunds' | 'refundFees' | 'disputes' | 'disputeFees' | 'tax' | 'reserve' | 'loan' | 'adjustments'
export type Totals = Record<Category, number>

export const emptyTotals = (): Totals => ({ sales: 0, fees: 0, refunds: 0, refundFees: 0, disputes: 0, disputeFees: 0, tax: 0, reserve: 0, loan: 0, adjustments: 0 })

export const isTotals = (v: unknown): v is Totals => isRecord(v) && Object.keys(emptyTotals()).every((k) => typeof v[k] === 'number' && Number.isSafeInteger(v[k]))

/** A fixed message when a sum stops being exact: better no number than a wrong one. */
export function exact(n: number): number {
  if (!Number.isSafeInteger(n)) throw new ConnectorError('permanent', 'These Amazon totals are too large to add exactly.', { provider: PROVIDER, forUser: true })
  return n
}

export const sumTotals = (t: Totals): number => Object.values(t).reduce((s, n) => exact(s + n), 0)

/**
 * `{CurrencyCode, CurrencyAmount}` → exact minor units in the settlement's currency. Missing: 0 (the model makes every
 * amount optional). Present but in another currency, not a number, or with places the currency doesn't have: stop.
 * Currencies are never added together.
 */
export function amountIn(v: unknown, currency: string): number {
  if (v === undefined || v === null) return 0
  if (!isRecord(v)) throw unreadable('an amount')
  if (v.CurrencyCode !== currency) {
    if (typeof v.CurrencyCode === 'string' && /^[A-Z]{3}$/.test(v.CurrencyCode)) throw new ConnectorError('permanent', `Amazon listed an amount in ${v.CurrencyCode} inside a ${currency} settlement. Adding them would be wrong, so this sync stopped. No totals were changed.`, { provider: PROVIDER, forUser: true })
    throw unreadable('an amount')
  }
  const raw = v.CurrencyAmount
  const s = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : raw
  const m = typeof s === 'string' ? /^-?\d+(?:\.(\d+))?$/.exec(s) : null
  if (!m) throw unreadable('an amount')
  // Places past the currency's own must be zeros: never rounded.
  if (/[^0]/.test((m[1] ?? '').slice(currencyExponent(currency)))) throw unreadable('an amount')
  return toMinor(s as string, currency)
}

type Row = Record<string, unknown>
const list = (v: unknown, what: string): Row[] => {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || !v.every(isRecord)) throw unreadable(what)
  return v
}

const SALES_CHARGES = new Set(['Principal', 'ShippingCharge', 'Giftwrap', 'Discount', 'CODItemCharge', 'CODOrderCharge', 'CODShippingCharge'])
/** Tax the buyer paid on the sale (seller-collected), and India's tax collected at source. */
const isTaxCharge = (type: string) => /tax/i.test(type) || /^TCS-/.test(type)

/** Where one ShipmentEvent-shaped event's money goes: shipments to sales and fees, refunds and disputes to their own pair. */
type Flavour = 'shipment' | 'refund' | 'dispute'

export class Tally {
  readonly t: Totals
  readonly currency: string
  constructor(currency: string, start: Totals = emptyTotals()) {
    this.currency = currency
    this.t = { ...start }
  }

  private add(c: Category, minor: number): void {
    this.t[c] = exact(this.t[c] + minor)
  }
  private amt(v: unknown): number {
    return amountIn(v, this.currency)
  }

  private charge(c: Row, flavour: Flavour): void {
    const type = typeof c.ChargeType === 'string' ? c.ChargeType : ''
    const n = this.amt(c.ChargeAmount)
    if (isTaxCharge(type)) this.add('tax', n)
    else if (flavour === 'refund') this.add('refunds', n)
    else if (flavour === 'dispute') this.add('disputes', n)
    else this.add(SALES_CHARGES.has(type) ? 'sales' : 'adjustments', n)
  }
  private charges(v: unknown, flavour: Flavour): void {
    for (const c of list(v, 'a charge list')) this.charge(c, flavour)
  }
  private fee(c: Row, flavour: Flavour): void {
    this.add(flavour === 'refund' ? 'refundFees' : flavour === 'dispute' ? 'disputeFees' : 'fees', this.amt(c.FeeAmount))
  }
  private fees(v: unknown, flavour: Flavour = 'shipment'): void {
    for (const c of list(v, 'a fee list')) this.fee(c, flavour)
  }
  private promotions(v: unknown, flavour: Flavour): void {
    for (const p of list(v, 'a promotion list')) this.add(flavour === 'refund' ? 'refunds' : flavour === 'dispute' ? 'disputes' : 'sales', this.amt(p.PromotionAmount))
  }
  /** TaxWithheldComponent lists: the tax Amazon took back to remit. Sales tax either way. */
  private withheld(v: unknown): void {
    for (const w of list(v, 'a tax list')) for (const c of list(w.TaxesWithheld, 'a tax list')) this.add('tax', this.amt(c.ChargeAmount))
  }

  private shipmentEvent(e: Row, flavour: Flavour): void {
    this.charges(e.OrderChargeList, flavour)
    this.charges(e.OrderChargeAdjustmentList, flavour)
    for (const k of ['ShipmentFeeList', 'ShipmentFeeAdjustmentList', 'OrderFeeList', 'OrderFeeAdjustmentList']) this.fees(e[k], flavour)
    // Signed as sent: a stored value card's revenue is taken off the balance, its refund put back.
    for (const d of list(e.DirectPaymentList, 'a direct payment list')) this.add('adjustments', this.amt(d.DirectPaymentAmount))
    for (const item of [...list(e.ShipmentItemList, 'an item list'), ...list(e.ShipmentItemAdjustmentList, 'an item list')]) {
      this.charges(item.ItemChargeList, flavour)
      this.charges(item.ItemChargeAdjustmentList, flavour)
      this.fees(item.ItemFeeList, flavour)
      this.fees(item.ItemFeeAdjustmentList, flavour)
      this.promotions(item.PromotionList, flavour)
      this.promotions(item.PromotionAdjustmentList, flavour)
      this.withheld(item.ItemTaxWithheldList)
      // Amazon Points (Japan only): what granting them cost the seller, and what came back with a return.
      this.add('adjustments', -this.amt(item.CostOfPointsGranted))
      this.add('adjustments', this.amt(item.CostOfPointsReturned))
    }
  }

  /** One page's FinancialEvents. Every list must be one this file knows. */
  addEvents(events: Record<string, unknown>): void {
    for (const [name, v] of Object.entries(events)) {
      const rows = list(v, 'a list of events')
      if (!rows.length) continue
      const read = READERS[name]
      if (!read) throw new ConnectorError('permanent', amazonUnknownEvents(name), { provider: PROVIDER, forUser: true })
      for (const e of rows) read(this, e)
    }
  }

  // Readers for the flat event kinds, used by READERS below.
  sale = (v: unknown) => this.add('sales', this.amt(v))
  feeAmount = (v: unknown) => this.add('fees', this.amt(v))
  taxAmount = (v: unknown) => this.add('tax', this.amt(v))
  adjust = (v: unknown) => this.add('adjustments', this.amt(v))
  reserve = (v: unknown) => this.add('reserve', this.amt(v))
  loan = (v: unknown) => this.add('loan', this.amt(v))
  shipment = (e: Row, f: Flavour) => this.shipmentEvent(e, f)
  chargeList = (v: unknown, f: Flavour) => this.charges(v, f)
  chargeOne = (v: unknown, f: Flavour) => {
    if (v === undefined || v === null) return
    if (!isRecord(v)) throw unreadable('a charge')
    this.charge(v, f)
  }
  feeList = (v: unknown) => this.fees(v)
  taxWithheld = (v: unknown) => this.withheld(v)
  fbaLiquidationFee = (v: unknown) => {
    // "The seller receives this amount minus LiquidationFeeAmount": a cost, whichever sign it's written with.
    const n = this.amt(v)
    this.add('fees', n > 0 ? -n : n)
  }
}

export const amazonUnknownEvents = (name: string) => `Amazon listed a kind of settlement event Aggregate doesn’t read yet (${name.replace(/[^A-Za-z]/g, '').slice(0, 60)}). Leaving it out would make the totals wrong, so this sync stopped. No totals were changed.`

const READERS: Record<string, (t: Tally, e: Row) => void> = {
  ShipmentEventList: (t, e) => t.shipment(e, 'shipment'),
  ShipmentSettleEventList: (t, e) => t.shipment(e, 'shipment'),
  RefundEventList: (t, e) => t.shipment(e, 'refund'),
  GuaranteeClaimEventList: (t, e) => t.shipment(e, 'dispute'),
  ChargebackEventList: (t, e) => t.shipment(e, 'dispute'),
  EBTRefundReimbursementOnlyEventList: (t, e) => t.adjust(e.Amount),
  PayWithAmazonEventList: (t, e) => {
    t.chargeOne(e.Charge, 'shipment')
    t.feeList(e.FeeList)
  },
  ServiceProviderCreditEventList: (t, e) => t.adjust(e.TransactionAmount),
  RetrochargeEventList: (t, e) => {
    t.taxAmount(e.BaseTax)
    t.taxAmount(e.ShippingTax)
    t.taxWithheld(e.RetrochargeTaxWithheldList)
  },
  RentalTransactionEventList: (t, e) => {
    t.chargeList(e.RentalChargeList, 'shipment')
    t.feeList(e.RentalFeeList)
    t.taxWithheld(e.RentalTaxWithheldList)
    t.adjust(e.RentalReimbursement)
  },
  // transactionValue = baseValue + taxValue: the whole cost of the ads, tax on them included.
  ProductAdsPaymentEventList: (t, e) => t.feeAmount(e.transactionValue),
  ServiceFeeEventList: (t, e) => t.feeList(e.FeeList),
  SellerDealPaymentEventList: (t, e) => t.feeAmount(e.totalAmount),
  DebtRecoveryEventList: (t, e) => {
    t.adjust(e.RecoveryAmount)
    t.adjust(e.OverPaymentCredit)
  },
  LoanServicingEventList: (t, e) => t.loan(e.LoanAmount),
  AdjustmentEventList: (t, e) => (e.AdjustmentType === 'ReserveEvent' ? t.reserve(e.AdjustmentAmount) : t.adjust(e.AdjustmentAmount)),
  SAFETReimbursementEventList: (t, e) => t.adjust(e.ReimbursedAmount),
  SellerReviewEnrollmentPaymentEventList: (t, e) => t.feeAmount(e.TotalAmount),
  FBALiquidationEventList: (t, e) => {
    t.sale(e.LiquidationProceedsAmount)
    t.fbaLiquidationFee(e.LiquidationFeeAmount)
  },
  CouponPaymentEventList: (t, e) => t.feeAmount(e.TotalAmount),
  ImagingServicesFeeEventList: (t, e) => t.feeList(e.FeeList),
  NetworkComminglingTransactionEventList: (t, e) => {
    t.adjust(e.TaxExclusiveAmount)
    t.adjust(e.TaxAmount)
  },
  AffordabilityExpenseEventList: (t, e) => t.feeAmount(e.TotalExpense),
  AffordabilityExpenseReversalEventList: (t, e) => t.feeAmount(e.TotalExpense),
  RemovalShipmentEventList: (t, e) => {
    for (const i of list(e.RemovalShipmentItemList, 'an item list')) {
      t.sale(i.Revenue)
      t.feeAmount(i.FeeAmount)
      t.taxAmount(i.TaxAmount)
      t.taxAmount(negated(i.TaxWithheld))
    }
  },
  RemovalShipmentAdjustmentEventList: (t, e) => {
    for (const i of list(e.RemovalShipmentItemAdjustmentList, 'an item list')) {
      t.sale(i.RevenueAdjustment)
      t.taxAmount(i.TaxAmountAdjustment)
      t.taxAmount(negated(i.TaxWithheldAdjustment))
    }
  },
  TrialShipmentEventList: (t, e) => t.feeList(e.FeeList),
  TDSReimbursementEventList: (t, e) => t.adjust(e.ReimbursedAmount),
  AdhocDisbursementEventList: (t, e) => t.adjust(e.TransactionAmount),
  // Income tax withheld from the seller (not sales tax): money out, not revenue.
  TaxWithholdingEventList: (t, e) => t.adjust(e.WithheldAmount),
  ChargeRefundEventList: (t, e) => {
    for (const c of list(e.ChargeRefundTransactions, 'a charge refund list')) t.feeAmount(c.ChargeAmount)
  },
  FailedAdhocDisbursementEventList: (t, e) => t.adjust(e.TransferAmount),
  ValueAddedServiceChargeEventList: (t, e) => t.feeAmount(e.TransactionAmount),
  CapacityReservationBillingEventList: (t, e) => t.feeAmount(e.TransactionAmount),
}

/** Removal orders: TaxWithheld is written as the same positive number as TaxAmount, and is money Amazon kept. */
function negated(v: unknown): unknown {
  if (!isRecord(v)) return v
  const a = v.CurrencyAmount
  if (typeof a === 'number' && Number.isFinite(a)) return { ...v, CurrencyAmount: a === 0 ? 0 : -a }
  if (typeof a === 'string' && /^-?\d+(\.\d+)?$/.test(a)) return { ...v, CurrencyAmount: a.startsWith('-') ? a.slice(1) : `-${a}` }
  return v
}

export type Verdict = { ok: true; beginning: number } | { ok: false; events: number }

/**
 * Does the settlement add up? Exactly to OriginalTotal, or with BeginningBalance carried in. `beginning` is the carried
 * amount to send as its own row (0 when the events alone match).
 */
export function verify(t: Totals, total: number, beginning: number): Verdict {
  const events = sumTotals(t)
  if (events === total) return { ok: true, beginning: 0 }
  if (beginning !== 0 && exact(events + beginning) === total) return { ok: true, beginning }
  return { ok: false, events }
}
