// Open Cap Format (OCF 1.x) import and export. Export writes the standard file set (Manifest + one file per object
// family) as JSON; import reads that set, a flat array of OCF objects, or a single OCF file. Unknown object types are
// reported, never guessed. Money in OCF is {amount: "1.00", currency_code: "USD"}; quantities are decimal strings.
// Spec: https://github.com/Open-Cap-Table-Coalition/Open-Cap-Format-OCF

import type { Money } from '@agfn/contracts'
import { looksInstitutional, type EquityObject, type IsoDate, type Vesting } from './model.ts'
import { vestingSchedule } from './vesting.ts'

export const OCF_VERSION = '1.2.0'

type Json = Record<string, unknown>

const money = (m: Money): Json => ({ amount: (m.minor / 100).toFixed(m.minor % 1 ? 4 : 2), currency_code: m.currency })
const qty = (n: number) => String(n)

function toMinor(v: unknown): Money | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as { amount?: unknown; currency_code?: unknown }
  const n = Number(o.amount)
  if (!Number.isFinite(n) || typeof o.currency_code !== 'string') return undefined
  return { minor: Math.round(n * 100 * 10_000) / 10_000, currency: o.currency_code.toUpperCase() }
}
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : undefined
}
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const date = (v: unknown): IsoDate | undefined => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined)

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

export interface OcfIssuer {
  id: string
  legalName: string
  /** ISO 3166 country of formation, e.g. "US". */
  country?: string
  /** e.g. "DE" for Delaware. */
  subdivision?: string
}

const FILES: Array<{ file: string; type: string; match: (o: Json) => boolean }> = [
  { file: 'Stakeholders.ocf.json', type: 'OCF_STAKEHOLDERS_FILE', match: (o) => o.object_type === 'STAKEHOLDER' },
  { file: 'StockClasses.ocf.json', type: 'OCF_STOCK_CLASSES_FILE', match: (o) => o.object_type === 'STOCK_CLASS' },
  { file: 'StockPlans.ocf.json', type: 'OCF_STOCK_PLANS_FILE', match: (o) => o.object_type === 'STOCK_PLAN' },
  { file: 'Valuations.ocf.json', type: 'OCF_VALUATIONS_FILE', match: (o) => o.object_type === 'VALUATION' },
  { file: 'Transactions.ocf.json', type: 'OCF_TRANSACTIONS_FILE', match: (o) => String(o.object_type).startsWith('TX_') },
]

/** One OCF object per cap-table object. */
export function toOcfObject(o: EquityObject): Json {
  switch (o.type) {
    case 'STAKEHOLDER':
      return {
        object_type: 'STAKEHOLDER',
        id: o.id,
        name: { legal_name: o.name },
        // Saved before banks and trusts were recognized ("Harbor Bank" as a person): export them as institutions.
        stakeholder_type: o.stakeholderType === 'INDIVIDUAL' && looksInstitutional(o.name) ? 'INSTITUTION' : o.stakeholderType,
        ...(o.relationship ? { current_relationship: o.relationship } : {}),
        ...(o.email ? { contact_info: { emails: [{ email_address: o.email, email_type: 'BUSINESS' }] } } : {}),
      }
    case 'STOCK_CLASS':
      return {
        object_type: 'STOCK_CLASS',
        id: o.id,
        name: o.name,
        class_type: o.classType,
        default_id_prefix: o.classType === 'COMMON' ? 'CS-' : 'PS-',
        initial_shares_authorized: o.authorized == null ? 'UNLIMITED' : qty(o.authorized),
        votes_per_share: '1',
        seniority: qty(o.seniority),
        ...(o.pricePerShare ? { price_per_share: money(o.pricePerShare) } : {}),
        ...(o.classType === 'PREFERRED'
          ? {
              liquidation_preference_multiple: String(o.liquidationPrefMultiple),
              // OCF: a participation cap means participating; we write "0" for uncapped participation.
              ...(o.participating ? { participation_cap_multiple: o.participationCapMultiple == null ? '0' : String(o.participationCapMultiple) } : {}),
              conversion_rights: [{ type: 'STOCK_CLASS_CONVERSION_RIGHT', conversion_mechanism: { type: 'RATIO_CONVERSION', ratio: { numerator: String(o.conversionRatio), denominator: '1' }, rounding_type: 'NORMAL' }, converts_to_stock_class_id: 'COMMON' }],
            }
          : {}),
      }
    case 'STOCK_PLAN':
      return { object_type: 'STOCK_PLAN', id: o.id, plan_name: o.name, initial_shares_reserved: qty(o.size), stock_class_ids: [o.stockClassId] }
    case 'VALUATION':
      return { object_type: 'VALUATION', id: o.id, stock_class_id: o.stockClassId, price_per_share: money(o.pricePerShare), effective_date: o.date, valuation_type: o.kind === '409A' ? '409A' : 'OTHER', ...(o.provider ? { provider: o.provider } : {}) }
    case 'TX_STOCK_ISSUANCE':
      return {
        object_type: 'TX_STOCK_ISSUANCE',
        id: o.id,
        date: o.date,
        security_id: o.securityId,
        custom_id: o.securityId,
        stakeholder_id: o.stakeholderId,
        stock_class_id: o.stockClassId,
        quantity: qty(o.quantity),
        share_price: money(o.pricePerShare ?? { minor: 0, currency: 'USD' }),
        security_law_exemptions: [],
        ...(o.vesting ? { vestings: vestingSchedule(o.quantity, o.vesting).map((v) => ({ date: v.date, amount: qty(v.amount) })), comments: [vestingComment(o.vesting)] } : {}),
      }
    case 'TX_STOCK_TRANSFER':
      return { object_type: 'TX_STOCK_TRANSFER', id: o.id, date: o.date, security_id: o.securityId, quantity: qty(o.quantity), resulting_security_ids: [`${o.id}:to`], comments: [`to:${o.toStakeholderId}`] }
    case 'TX_STOCK_CANCELLATION':
      return { object_type: 'TX_STOCK_CANCELLATION', id: o.id, date: o.date, security_id: o.securityId, quantity: qty(o.quantity), reason_text: o.reason ?? 'Cancelled' }
    case 'TX_CONVERTIBLE_ISSUANCE': {
      const mech: Json =
        o.kind === 'SAFE'
          ? { type: 'SAFE_CONVERSION', conversion_mfn: false, conversion_timing: o.timing, ...(o.valuationCap ? { conversion_valuation_cap: money(o.valuationCap) } : {}), ...(o.discountPct ? { conversion_discount: String(o.discountPct / 100) } : {}) }
          : {
              type: 'CONVERTIBLE_NOTE_CONVERSION',
              interest_rates: o.interestPct ? [{ rate: String(o.interestPct / 100), accrual_start_date: o.date }] : [],
              day_count_convention: 'ACTUAL_365',
              interest_payout: 'DEFERRED',
              interest_accrual_period: 'DAILY',
              compounding_type: 'SIMPLE',
              ...(o.valuationCap ? { conversion_valuation_cap: money(o.valuationCap) } : {}),
              ...(o.discountPct ? { conversion_discount: String(o.discountPct / 100) } : {}),
            }
      return {
        object_type: 'TX_CONVERTIBLE_ISSUANCE',
        id: o.id,
        date: o.date,
        security_id: o.securityId,
        custom_id: o.securityId,
        stakeholder_id: o.stakeholderId,
        investment_amount: money(o.amount),
        convertible_type: o.kind === 'SAFE' ? 'SAFE' : 'NOTE',
        conversion_triggers: [{ type: 'AUTOMATIC_ON_CONDITION', trigger_id: `${o.id}-financing`, conversion_right: { type: 'CONVERTIBLE_CONVERSION_RIGHT', conversion_mechanism: mech } }],
        security_law_exemptions: [],
        seniority: 1,
        ...(o.maturityDate ? { comments: [`maturity:${o.maturityDate}`] } : {}),
      }
    }
    case 'TX_CONVERTIBLE_CONVERSION':
      return { object_type: 'TX_CONVERTIBLE_CONVERSION', id: o.id, date: o.date, security_id: o.securityId, resulting_security_ids: o.resultingSecurityIds, reason_text: 'Converted in a priced round' }
    case 'TX_CONVERTIBLE_CANCELLATION':
      return { object_type: 'TX_CONVERTIBLE_CANCELLATION', id: o.id, date: o.date, security_id: o.securityId, reason_text: o.reason ?? 'Cancelled' }
    case 'TX_EQUITY_COMPENSATION_ISSUANCE':
      return {
        object_type: 'TX_EQUITY_COMPENSATION_ISSUANCE',
        id: o.id,
        date: o.date,
        security_id: o.securityId,
        custom_id: o.securityId,
        stakeholder_id: o.stakeholderId,
        ...(o.stockPlanId ? { stock_plan_id: o.stockPlanId } : {}),
        stock_class_id: o.stockClassId,
        compensation_type: o.compensationType,
        quantity: qty(o.quantity),
        ...(o.exercisePrice ? { exercise_price: money(o.exercisePrice) } : {}),
        expiration_date: o.expirationDate ?? null,
        termination_exercise_windows: [],
        security_law_exemptions: [],
        ...(o.vesting ? { vestings: vestingSchedule(o.quantity, o.vesting).map((v) => ({ date: v.date, amount: qty(v.amount) })), comments: [vestingComment(o.vesting)] } : {}),
      }
    case 'TX_EQUITY_COMPENSATION_EXERCISE':
      return { object_type: 'TX_EQUITY_COMPENSATION_EXERCISE', id: o.id, date: o.date, security_id: o.securityId, quantity: qty(o.quantity), resulting_security_ids: [o.resultingSecurityId] }
    case 'TX_EQUITY_COMPENSATION_CANCELLATION':
      return { object_type: 'TX_EQUITY_COMPENSATION_CANCELLATION', id: o.id, date: o.date, security_id: o.securityId, quantity: qty(o.quantity), reason_text: o.reason ?? 'Cancelled' }
    case 'TX_EQUITY_COMPENSATION_RELEASE':
      return { object_type: 'TX_EQUITY_COMPENSATION_RELEASE', id: o.id, date: o.date, security_id: o.securityId, quantity: qty(o.quantity), settlement_date: o.date, resulting_security_ids: [o.resultingSecurityId], ...(o.withheld ? { comments: [`withheld:${o.withheld}`] } : {}) }
    case 'TX_WARRANT_ISSUANCE':
      return {
        object_type: 'TX_WARRANT_ISSUANCE',
        id: o.id,
        date: o.date,
        security_id: o.securityId,
        custom_id: o.securityId,
        stakeholder_id: o.stakeholderId,
        quantity: qty(o.quantity),
        purchase_price: money(o.purchasePrice ?? { minor: 0, currency: o.exercisePrice?.currency ?? 'USD' }),
        ...(o.exercisePrice ? { exercise_price: money(o.exercisePrice) } : {}),
        ...(o.expirationDate ? { warrant_expiration_date: o.expirationDate } : {}),
        exercise_triggers: [{ type: 'ELECTIVE_AT_WILL', trigger_id: `${o.id}-exercise`, conversion_right: { type: 'WARRANT_CONVERSION_RIGHT', conversion_mechanism: { type: 'FIXED_AMOUNT_CONVERSION', converts_to_quantity: qty(o.quantity) }, converts_to_stock_class_id: o.stockClassId } }],
        security_law_exemptions: [],
      }
    case 'TX_WARRANT_EXERCISE':
      return { object_type: 'TX_WARRANT_EXERCISE', id: o.id, date: o.date, security_id: o.securityId, quantity: qty(o.quantity), resulting_security_ids: [o.resultingSecurityId], ...(o.netFairValue ? { comments: [`net:${o.netFairValue.minor}:${o.netFairValue.currency}`] } : {}) }
    case 'TX_WARRANT_CANCELLATION':
      return { object_type: 'TX_WARRANT_CANCELLATION', id: o.id, date: o.date, security_id: o.securityId, quantity: qty(o.quantity), reason_text: o.reason ?? 'Cancelled' }
    case 'TX_STOCK_PLAN_POOL_ADJUSTMENT':
      return { object_type: 'TX_STOCK_PLAN_POOL_ADJUSTMENT', id: o.id, date: o.date, stock_plan_id: o.stockPlanId, shares_reserved: qty(o.size) }
    case 'TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT':
      return { object_type: 'TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT', id: o.id, date: o.date, stock_class_id: o.stockClassId, new_shares_authorized: qty(o.authorized) }
  }
}

const vestingComment = (v: Vesting) => `vesting:${v.start}/${v.months}/${v.cliffMonths}`

/** The OCF file set, keyed by file name. */
export function exportOcf(issuer: OcfIssuer, objects: readonly EquityObject[], asOf: IsoDate): Record<string, Json> {
  const commonId = objects.find((o) => o.type === 'STOCK_CLASS' && o.classType === 'COMMON')?.id
  const all = objects.map(toOcfObject).map((o) => {
    if (o.object_type !== 'STOCK_CLASS' || !Array.isArray(o.conversion_rights)) return o
    return { ...o, conversion_rights: (o.conversion_rights as Json[]).map((r) => ({ ...r, converts_to_stock_class_id: commonId ?? 'COMMON' })) }
  })
  const files: Record<string, Json> = {}
  for (const f of FILES) files[f.file] = { file_type: f.type, items: all.filter(f.match) }
  files['Manifest.ocf.json'] = {
    file_type: 'OCF_MANIFEST_FILE',
    ocf_version: OCF_VERSION,
    as_of_date: asOf,
    generated_at: new Date().toISOString(),
    issuer: { object_type: 'ISSUER', id: issuer.id, legal_name: issuer.legalName, formation_date: null, country_of_formation: issuer.country ?? 'US', ...(issuer.subdivision ? { country_subdivision_of_formation: issuer.subdivision } : {}), tax_ids: [] },
    stakeholders_files: [{ filepath: 'Stakeholders.ocf.json', md5: '' }],
    stock_classes_files: [{ filepath: 'StockClasses.ocf.json', md5: '' }],
    stock_plans_files: [{ filepath: 'StockPlans.ocf.json', md5: '' }],
    valuations_files: [{ filepath: 'Valuations.ocf.json', md5: '' }],
    transactions_files: [{ filepath: 'Transactions.ocf.json', md5: '' }],
    vesting_terms_files: [],
    stock_legend_templates_files: [],
  }
  return files
}

// ---------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------

export interface ImportResult {
  objects: EquityObject[]
  /** Plain-language notes: skipped object types, missing fields. */
  notes: string[]
}

/** Accepts the OCF file set ({"Manifest.ocf.json": …}), one OCF file ({file_type, items}), or an array of objects. */
export function importOcf(input: unknown): ImportResult {
  const items: Json[] = []
  const collect = (v: unknown) => {
    if (Array.isArray(v)) for (const x of v) if (x && typeof x === 'object') items.push(x as Json)
  }
  if (Array.isArray(input)) collect(input)
  else if (input && typeof input === 'object') {
    const o = input as Json
    if (Array.isArray(o.items)) collect(o.items)
    else for (const v of Object.values(o)) if (v && typeof v === 'object' && Array.isArray((v as Json).items)) collect((v as Json).items)
  }
  const notes: string[] = []
  const objects: EquityObject[] = []
  const skipped = new Map<string, number>()
  for (const x of items) {
    try {
      const o = fromOcfObject(x)
      if (o) objects.push(o)
      else skipped.set(String(x.object_type), (skipped.get(String(x.object_type)) ?? 0) + 1)
    } catch (e) {
      notes.push(`${String(x.object_type)} ${String(x.id ?? '')}: ${e instanceof Error ? e.message : 'unreadable'}`)
    }
  }
  for (const [t, n] of skipped) notes.push(`Skipped ${n} ${t} ${n === 1 ? 'object' : 'objects'} (not used for the cap table yet).`)
  if (!items.length) notes.push('No OCF objects found in this file.')
  return { objects, notes }
}

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`missing ${what}`)
  return v
}

function vestingFrom(x: Json): Vesting | undefined {
  const c = Array.isArray(x.comments) ? x.comments.find((s) => typeof s === 'string' && s.startsWith('vesting:')) : undefined
  if (typeof c === 'string') {
    const [start, months, cliff] = c.slice(8).split('/')
    if (start && months) return { start, months: Number(months), cliffMonths: Number(cliff ?? 0) }
  }
  // Other tools' explicit schedules: infer start, length and cliff from the vesting dates.
  const v = Array.isArray(x.vestings) ? (x.vestings as Json[]).map((e) => ({ date: date(e.date), amount: num(e.amount) ?? 0 })).filter((e) => e.date) : []
  if (v.length < 2) return undefined
  const first = v[0]!.date!
  const last = v[v.length - 1]!.date!
  const months = monthsBetween(first, last) + (v.length > 1 ? monthsBetween(first, v[1]!.date!) : 0)
  const total = v.reduce((a, e) => a + e.amount, 0)
  const firstShare = total ? v[0]!.amount / total : 0
  const cliff = Math.round(firstShare * months)
  const start = addMonthsIso(first, -Math.max(cliff, monthsBetween(first, v[1]!.date!)))
  return { start, months, cliffMonths: cliff > monthsBetween(first, v[1]!.date!) ? cliff : 0 }
}
function monthsBetween(a: string, b: string): number {
  const [y1, m1] = a.split('-').map(Number) as [number, number]
  const [y2, m2] = b.split('-').map(Number) as [number, number]
  return (y2 - y1) * 12 + (m2 - m1)
}
function addMonthsIso(d: string, n: number): string {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number]
  const t = new Date(Date.UTC(y, m - 1 + n, day))
  return t.toISOString().slice(0, 10)
}

export function fromOcfObject(x: Json): EquityObject | null {
  const id = need(str(x.id), 'id')
  switch (x.object_type) {
    case 'STAKEHOLDER': {
      const name = x.name as Json | undefined
      const email = ((x.contact_info as Json | undefined)?.emails as Json[] | undefined)?.[0]?.email_address
      const rel = str(x.current_relationship)
      return {
        type: 'STAKEHOLDER',
        id,
        name: need(str(name?.legal_name) ?? [str(name?.first_name), str(name?.last_name)].filter(Boolean).join(' ') ?? undefined, 'name'),
        stakeholderType: x.stakeholder_type === 'INSTITUTION' ? 'INSTITUTION' : 'INDIVIDUAL',
        ...(rel && ['FOUNDER', 'EMPLOYEE', 'INVESTOR', 'ADVISOR', 'BOARD_MEMBER', 'CONSULTANT', 'OTHER'].includes(rel) ? { relationship: rel as 'FOUNDER' } : {}),
        ...(typeof email === 'string' ? { email } : {}),
      }
    }
    case 'STOCK_CLASS': {
      const preferred = x.class_type === 'PREFERRED'
      const cap = str(x.participation_cap_multiple)
      const rights = Array.isArray(x.conversion_rights) ? (x.conversion_rights as Json[]) : []
      const ratio = (rights[0]?.conversion_mechanism as Json | undefined)?.ratio as Json | undefined
      return {
        type: 'STOCK_CLASS',
        id,
        name: need(str(x.name), 'name'),
        classType: preferred ? 'PREFERRED' : 'COMMON',
        authorized: x.initial_shares_authorized === 'UNLIMITED' || x.initial_shares_authorized == null ? null : (num(x.initial_shares_authorized) ?? null),
        seniority: num(x.seniority) ?? (preferred ? 1 : 0),
        ...(toMinor(x.price_per_share) ? { pricePerShare: toMinor(x.price_per_share)! } : {}),
        liquidationPrefMultiple: preferred ? (num(x.liquidation_preference_multiple) ?? 1) : 0,
        participating: preferred && cap !== undefined,
        participationCapMultiple: cap !== undefined && Number(cap) > 0 ? Number(cap) : null,
        conversionRatio: ratio ? (num(ratio.numerator) ?? 1) / (num(ratio.denominator) ?? 1) : 1,
      }
    }
    case 'STOCK_PLAN':
      return { type: 'STOCK_PLAN', id, name: str(x.plan_name) ?? 'Option pool', stockClassId: need(str((x.stock_class_ids as unknown[] | undefined)?.[0]) ?? str(x.stock_class_id), 'stock_class_ids'), size: need(num(x.initial_shares_reserved), 'initial_shares_reserved') }
    case 'VALUATION':
      return { type: 'VALUATION', id, date: need(date(x.effective_date), 'effective_date'), stockClassId: need(str(x.stock_class_id), 'stock_class_id'), pricePerShare: need(toMinor(x.price_per_share), 'price_per_share'), kind: x.valuation_type === '409A' ? '409A' : 'OTHER', ...(str(x.provider) ? { provider: str(x.provider)! } : {}) }
    case 'TX_STOCK_ISSUANCE': {
      const v = vestingFrom(x)
      const price = toMinor(x.share_price)
      return {
        type: 'TX_STOCK_ISSUANCE',
        id,
        date: need(date(x.date), 'date'),
        securityId: need(str(x.security_id), 'security_id'),
        stakeholderId: need(str(x.stakeholder_id), 'stakeholder_id'),
        stockClassId: need(str(x.stock_class_id), 'stock_class_id'),
        quantity: need(num(x.quantity), 'quantity'),
        ...(price && price.minor > 0 ? { pricePerShare: price } : {}),
        ...(v ? { vesting: v } : {}),
      }
    }
    case 'TX_STOCK_TRANSFER': {
      const to = Array.isArray(x.comments) ? (x.comments as string[]).find((c) => c.startsWith('to:'))?.slice(3) : undefined
      if (!to) throw new Error('transfer recipient unknown (OCF records it as a new issuance; import that instead)')
      return { type: 'TX_STOCK_TRANSFER', id, date: need(date(x.date), 'date'), securityId: need(str(x.security_id), 'security_id'), quantity: need(num(x.quantity), 'quantity'), toStakeholderId: to }
    }
    case 'TX_STOCK_CANCELLATION':
      return { type: 'TX_STOCK_CANCELLATION', id, date: need(date(x.date), 'date'), securityId: need(str(x.security_id), 'security_id'), quantity: need(num(x.quantity), 'quantity'), ...(str(x.reason_text) ? { reason: str(x.reason_text)! } : {}) }
    case 'TX_CONVERTIBLE_ISSUANCE': {
      const mech = ((x.conversion_triggers as Json[] | undefined)?.[0]?.conversion_right as Json | undefined)?.conversion_mechanism as Json | undefined
      const kind = x.convertible_type === 'SAFE' ? 'SAFE' : 'NOTE'
      const rate = num(((mech?.interest_rates as Json[] | undefined)?.[0] as Json | undefined)?.rate)
      const disc = num(mech?.conversion_discount)
      const cap = toMinor(mech?.conversion_valuation_cap)
      const maturity = Array.isArray(x.comments) ? (x.comments as string[]).find((c) => c.startsWith('maturity:'))?.slice(9) : undefined
      return {
        type: 'TX_CONVERTIBLE_ISSUANCE',
        id,
        date: need(date(x.date), 'date'),
        securityId: need(str(x.security_id), 'security_id'),
        stakeholderId: need(str(x.stakeholder_id), 'stakeholder_id'),
        kind,
        amount: need(toMinor(x.investment_amount), 'investment_amount'),
        ...(cap ? { valuationCap: cap } : {}),
        ...(disc ? { discountPct: Math.round(disc * 10_000) / 100 } : {}),
        ...(rate ? { interestPct: Math.round(rate * 10_000) / 100 } : {}),
        ...(maturity ? { maturityDate: maturity } : {}),
        timing: mech?.conversion_timing === 'PRE_MONEY' || kind === 'NOTE' ? 'PRE_MONEY' : 'POST_MONEY',
      }
    }
    case 'TX_CONVERTIBLE_CONVERSION':
      return { type: 'TX_CONVERTIBLE_CONVERSION', id, date: need(date(x.date), 'date'), securityId: need(str(x.security_id), 'security_id'), resultingSecurityIds: Array.isArray(x.resulting_security_ids) ? (x.resulting_security_ids as string[]) : [] }
    case 'TX_CONVERTIBLE_CANCELLATION':
      return { type: 'TX_CONVERTIBLE_CANCELLATION', id, date: need(date(x.date), 'date'), securityId: need(str(x.security_id), 'security_id') }
    case 'TX_EQUITY_COMPENSATION_ISSUANCE': {
      const v = vestingFrom(x)
      const ct = str(x.compensation_type)
      return {
        type: 'TX_EQUITY_COMPENSATION_ISSUANCE',
        id,
        date: need(date(x.date), 'date'),
        securityId: need(str(x.security_id), 'security_id'),
        stakeholderId: need(str(x.stakeholder_id), 'stakeholder_id'),
        ...(str(x.stock_plan_id) ? { stockPlanId: str(x.stock_plan_id)! } : {}),
        stockClassId: str(x.stock_class_id) ?? 'common',
        compensationType: ct === 'OPTION_ISO' || ct === 'RSU' || ct === 'WARRANT' ? ct : ct === 'OPTION' ? 'OPTION_NSO' : 'OPTION_NSO',
        quantity: need(num(x.quantity), 'quantity'),
        ...(toMinor(x.exercise_price) ? { exercisePrice: toMinor(x.exercise_price)! } : {}),
        ...(v ? { vesting: v } : {}),
        ...(date(x.expiration_date) ? { expirationDate: date(x.expiration_date)! } : {}),
      }
    }
    case 'TX_EQUITY_COMPENSATION_EXERCISE':
      return { type: 'TX_EQUITY_COMPENSATION_EXERCISE', id, date: need(date(x.date), 'date'), securityId: need(str(x.security_id), 'security_id'), quantity: need(num(x.quantity), 'quantity'), resultingSecurityId: str((x.resulting_security_ids as string[] | undefined)?.[0]) ?? `${id}:stock` }
    case 'TX_EQUITY_COMPENSATION_CANCELLATION':
      return { type: 'TX_EQUITY_COMPENSATION_CANCELLATION', id, date: need(date(x.date), 'date'), securityId: need(str(x.security_id), 'security_id'), quantity: need(num(x.quantity), 'quantity') }
    case 'TX_EQUITY_COMPENSATION_RELEASE': {
      const w = ((x.comments as string[] | undefined) ?? []).map((c) => /^withheld:(\d+)$/.exec(c)?.[1]).find(Boolean)
      return { type: 'TX_EQUITY_COMPENSATION_RELEASE', id, date: need(date(x.settlement_date) ?? date(x.date), 'date'), securityId: need(str(x.security_id), 'security_id'), quantity: need(num(x.quantity), 'quantity'), ...(w ? { withheld: Number(w) } : {}), resultingSecurityId: str((x.resulting_security_ids as string[] | undefined)?.[0]) ?? `${id}:stock` }
    }
    case 'TX_WARRANT_ISSUANCE': {
      const right = ((x.exercise_triggers as Json[] | undefined)?.[0]?.conversion_right as Json | undefined) ?? {}
      const purchase = toMinor(x.purchase_price)
      return {
        type: 'TX_WARRANT_ISSUANCE',
        id,
        date: need(date(x.date), 'date'),
        securityId: need(str(x.security_id), 'security_id'),
        stakeholderId: need(str(x.stakeholder_id), 'stakeholder_id'),
        stockClassId: str(right.converts_to_stock_class_id) ?? str(x.stock_class_id) ?? 'common',
        quantity: need(num(x.quantity) ?? num((right.conversion_mechanism as Json | undefined)?.converts_to_quantity), 'quantity'),
        ...(toMinor(x.exercise_price) ? { exercisePrice: toMinor(x.exercise_price)! } : {}),
        ...(purchase && purchase.minor > 0 ? { purchasePrice: purchase } : {}),
        ...(date(x.warrant_expiration_date) ? { expirationDate: date(x.warrant_expiration_date)! } : {}),
      }
    }
    case 'TX_WARRANT_EXERCISE': {
      const net = ((x.comments as string[] | undefined) ?? []).map((c) => /^net:(\d+(?:\.\d+)?):([A-Z]{3})$/.exec(c)).find(Boolean)
      return { type: 'TX_WARRANT_EXERCISE', id, date: need(date(x.date), 'date'), securityId: need(str(x.security_id), 'security_id'), quantity: need(num(x.quantity), 'quantity'), ...(net ? { netFairValue: { minor: Number(net[1]), currency: net[2]! } } : {}), resultingSecurityId: str((x.resulting_security_ids as string[] | undefined)?.[0]) ?? `${id}:stock` }
    }
    case 'TX_WARRANT_CANCELLATION':
      return { type: 'TX_WARRANT_CANCELLATION', id, date: need(date(x.date), 'date'), securityId: need(str(x.security_id), 'security_id'), quantity: need(num(x.quantity), 'quantity') }
    case 'TX_STOCK_PLAN_POOL_ADJUSTMENT':
      return { type: 'TX_STOCK_PLAN_POOL_ADJUSTMENT', id, date: need(date(x.date), 'date'), stockPlanId: need(str(x.stock_plan_id), 'stock_plan_id'), size: need(num(x.shares_reserved), 'shares_reserved') }
    case 'TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT':
      return { type: 'TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT', id, date: need(date(x.date), 'date'), stockClassId: need(str(x.stock_class_id), 'stock_class_id'), authorized: need(num(x.new_shares_authorized), 'new_shares_authorized') }
    default:
      return null
  }
}
