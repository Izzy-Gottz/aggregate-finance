// Wefunder portfolio positions (GET /portfolio/positions, read:investments) → investment.event.
//
// One position per offering the investor backed (Wefunder's own grouping). Each entry of `securities` (an early-bird
// tier, a stake held personally vs through an entity) is an invest at its own cost and terms; a position with no
// breakdown is one invest at the position's totals. Then, from the position's status:
//   active  → a mark at current_value_cents (as of `as_of`) when Wefunder's value differs from cost;
//   exited / sold → an exit for cost + realized gain, dated `exited_on` (older rows have none: `as_of`);
//   failed  → a write-off, dated `exited_on` (Wefunder dates failures there too), else `as_of`.
// Each event links to the company's Wefunder page (`company.url`, else wefunder.com/<slug>), Wefunder's attribution.
// Money is integer cents; shares and prices are decimal strings in major units. Wefunder's portfolio read is in beta
// and has no distributions, so money paid out before an exit isn't seen (docs/partners/wefunder.md lists the gaps).
import type { InvestmentEvent } from '@agfn/contracts'
import { isRecord, normalizeCurrency, str } from '@agfn/connector-sdk'

export const PROVIDER = 'wefunder'
/** Every record starts with this, so a full listing can void positions that disappeared (listing.complete). */
export const SCOPE = 'wefunder:'

type Obj = Record<string, unknown>

const cents = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined)
const day = (v: unknown): string | undefined => {
  const s = str(v)
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined
}
const decimal = (v: unknown): number | undefined => {
  const s = typeof v === 'number' ? String(v) : str(v)
  if (!s || !/^-?\d+(\.\d+)?$/.test(s.trim())) return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

/** Wefunder security types → the contract's flattened OCF classes. */
export function securityType(type: string | undefined): InvestmentEvent['securityType'] {
  const t = (type ?? '').toLowerCase()
  if (t.includes('safe')) return 'safe'
  if (t.includes('note') || t.includes('convertible')) return 'convertible_note'
  if (t.includes('prefer')) return 'preferred_stock'
  if (t.includes('common') || t === 'stock' || t === 'equity' || t === 'shares') return 'common_stock'
  if (t.includes('warrant')) return 'warrant'
  return 'other'
}

/** A discount written as a fraction ("0.2") or a percent ("20"); the contract wants the percent. */
export function percent(v: unknown): number | undefined {
  const n = decimal(v)
  if (n === undefined || n <= 0) return undefined
  return n <= 1 ? Math.round(n * 1e6) / 1e4 : n
}

export const positionIdOf = (offeringId: string) => `${SCOPE}${offeringId}`

/** The company's page on Wefunder: its `url` when that is an https wefunder.com link, else wefunder.com/<slug>. */
export function companyUrl(company: Obj): string | undefined {
  const url = str(company.url)
  if (url) {
    try {
      const u = new URL(url)
      if (u.protocol === 'https:' && (u.hostname === 'wefunder.com' || u.hostname === 'www.wefunder.com')) return `https://wefunder.com${u.pathname}`
    } catch {
      // fall through to the slug
    }
  }
  const slug = str(company.slug)
  return slug && /^[a-z0-9][a-z0-9_-]{0,99}$/i.test(slug) ? `https://wefunder.com/${slug}` : undefined
}

/** One position → its events. Positions without an offering id, cost or date are skipped (nothing to book). */
export function mapPosition(p: Obj, connectionId: string, rawRef?: string): InvestmentEvent[] {
  const a = isRecord(p.attributes) ? p.attributes : p
  const offeringId = str(a.offering_id) ?? str(p.id)
  if (!offeringId) return []
  const company = isRecord(a.company) ? a.company : {}
  const issuer = (str(company.name) ?? 'Company').slice(0, 120)
  const currency = normalizeCurrency(str(a.currency), 'USD')
  const sec = isRecord(a.security) ? a.security : {}
  const type = securityType(str(sec.type))
  const positionId = positionIdOf(offeringId)
  const page = companyUrl(company)
  const base = { type: 'investment.event' as const, connectionId, ...(rawRef ? { rawRef } : {}), issuer, positionId, securityType: type, ...(page ? { sourceUrl: page } : {}) }
  const out: InvestmentEvent[] = []
  const asOf = day(a.as_of)

  const parts = (Array.isArray(a.securities) ? a.securities.filter(isRecord) : []) as Obj[]
  const lines: Obj[] = parts.length ? parts : [{ security: sec, cost_basis_cents: a.cost_basis_cents, shares_held: a.shares_held, invested_at: a.invested_at }]
  for (const [i, s] of lines.entries()) {
    const cost = cents(s.cost_basis_cents)
    const date = day(s.invested_at) ?? day(a.invested_at)
    if (!cost || cost <= 0 || !date) continue
    const ss = isRecord(s.security) ? s.security : sec
    const terms = isRecord(s.terms) ? s.terms : {}
    const owner = isRecord(s.owner) ? str(s.owner.kind) : undefined
    const label = str(ss.label)
    const series = label ? `${label}${s.early_bird === true ? ' (early bird)' : ''}` : undefined
    const shares = decimal(s.shares_held)
    // Older rows: note_cap_cents / note_discount ("0.0" when none); newer ones send null and an uncapped flag.
    const cap = terms.uncapped === true ? undefined : cents(terms.note_cap_cents ?? terms.valuation_cap_cents)
    const discountPct = percent(terms.note_discount ?? terms.discount)
    // Stable across syncs: what the line is, not its place in the list (Wefunder may reorder it).
    const key = [str(ss.type) ?? 'security', s.early_bird === true ? 'eb' : '', owner ?? '', date, parts.length ? '' : 'total'].filter(Boolean).join(':')
    out.push({
      ...base,
      externalId: `${positionId}:invest:${key}${lines.findIndex((x, j) => j < i && sameLine(x, s)) >= 0 ? `:${i}` : ''}`,
      kind: 'invest',
      date,
      amount: { minor: cost, currency },
      ...(shares && shares > 0 ? { shares } : {}),
      ...(series ? { series } : {}),
      ...(cap && cap > 0 ? { valuationCap: { minor: cap, currency } } : {}),
      ...(discountPct ? { discountPct } : {}),
    })
  }
  if (!out.length) return []

  const status = str(a.status)
  const invested = out.reduce((t, e) => t + (e.amount?.minor ?? 0), 0)
  const valueDate = asOf ?? out.map((e) => e.date).sort().at(-1)!
  if (status === 'exited' || status === 'sold') {
    const gain = cents(a.realized_gain_cents)
    const proceeds = gain === undefined ? undefined : invested + gain
    out.push({ ...base, externalId: `${positionId}:exit`, kind: 'exit', date: day(a.exited_on) ?? valueDate, ...(proceeds !== undefined && proceeds >= 0 ? { amount: { minor: proceeds, currency } } : {}) })
  } else if (status === 'failed') {
    out.push({ ...base, externalId: `${positionId}:write_off`, kind: 'write_off', date: day(a.exited_on) ?? day(a.failed_on) ?? valueDate })
  } else {
    const value = cents(a.current_value_cents)
    if (value !== undefined && value >= 0 && value !== invested && asOf) {
      out.push({ ...base, externalId: `${positionId}:mark:${asOf}`, kind: 'mark', date: asOf, amount: { minor: value, currency }, markSource: `Wefunder current value as of ${asOf}` })
    }
  }
  return out
}

function sameLine(x: Obj, y: Obj): boolean {
  const sx = isRecord(x.security) ? str(x.security.type) : undefined
  const sy = isRecord(y.security) ? str(y.security.type) : undefined
  const ox = isRecord(x.owner) ? str(x.owner.kind) : undefined
  const oy = isRecord(y.owner) ? str(y.owner.kind) : undefined
  return sx === sy && (x.early_bird === true) === (y.early_bird === true) && ox === oy && day(x.invested_at) === day(y.invested_at)
}
