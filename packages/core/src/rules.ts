// Deterministic rules: conditions on a transaction → actions (company, kind, category, bucket).
// No regex from users (no ReDoS, same answer every time): patterns are case-insensitive globs where "*" means anything.
import type { TxnUpsert } from '@agfn/contracts'
import { defineRole } from './coa.ts'
import type { RecordOverride, Rule, RuleActions, RuleConditions, SourceAccountInfo, SourceRecord } from './model.ts'
import { matchesFilter, parseQuery, type TxnFilter } from './query.ts'

export class RuleValidationError extends Error {
  override name = 'RuleValidationError'
}

const MAX_PATTERN = 200

/** "SQ *BLUE BOTTLE 4482" → "sq blue bottle". Used for matching and for learning rules. */
export function merchantKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9& ]+/g, ' ')
    .replace(/\b[0-9]+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Linear-time glob match: "*" matches any run of characters; everything else is literal; case-insensitive. */
export function globMatch(pattern: string, text: string): boolean {
  const parts = normalizeText(pattern).split('*')
  const t = normalizeText(text)
  if (parts.length === 1) return t.includes(parts[0] ?? '')
  let pos = 0
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] ?? ''
    if (p === '') continue
    const at = t.indexOf(p, pos)
    if (at < 0) return false
    pos = at + p.length
  }
  return true
}

export function validateRule(conditions: RuleConditions, actions: RuleActions): void {
  const hasCondition =
    (conditions.textPatterns?.length ?? 0) > 0 ||
    conditions.counterparty !== undefined ||
    conditions.minAbsMinor !== undefined ||
    conditions.maxAbsMinor !== undefined ||
    (conditions.sourceAccountIds?.length ?? 0) > 0 ||
    Boolean(conditions.query?.trim())
  if (!hasCondition) throw new RuleValidationError('A rule needs at least one of: query, text pattern, counterparty, amount range, account')
  if (conditions.query !== undefined) {
    let f: TxnFilter
    try {
      f = parseQuery(conditions.query)
    } catch (err) {
      throw new RuleValidationError(err instanceof Error ? err.message : String(err))
    }
    if (f.category !== undefined) throw new RuleValidationError('A rule sets the category, so its query can\'t test one')
    const narrows = f.words.length + f.notWords.length + f.accounts.length > 0 || f.counterparty !== undefined || f.minAbs !== undefined || f.maxAbs !== undefined || f.currency !== undefined
    if (!narrows) throw new RuleValidationError('A rule query needs text, a counterparty, an amount, an account or a currency (dates alone would match everything in them)')
  }
  for (const p of conditions.textPatterns ?? []) {
    if (p.trim() === '' || p.replace(/\*/g, '').trim() === '') throw new RuleValidationError('A text pattern must contain some text')
    if (p.length > MAX_PATTERN) throw new RuleValidationError(`Text patterns are limited to ${MAX_PATTERN} characters`)
  }
  for (const v of [conditions.minAbsMinor, conditions.maxAbsMinor]) {
    if (v !== undefined && (!Number.isSafeInteger(v) || v < 0)) throw new RuleValidationError('Amount bounds must be non-negative minor units')
  }
  if (conditions.minAbsMinor !== undefined && conditions.maxAbsMinor !== undefined && conditions.minAbsMinor > conditions.maxAbsMinor) {
    throw new RuleValidationError('minAbsMinor is greater than maxAbsMinor')
  }
  if (!actions.forEntityId && !actions.kind && !actions.category && !actions.bucketId && !actions.renameTo?.trim()) {
    throw new RuleValidationError('A rule needs at least one action: company, kind, category, bucket or a new name')
  }
  if (actions.renameTo !== undefined && (actions.renameTo.trim() === '' || actions.renameTo.length > 100)) throw new RuleValidationError('A new name must be 1-100 characters')
  if (actions.category) defineRole(actions.category)
}

const parsed = new Map<string, TxnFilter>()

function filterOf(query: string): TxnFilter {
  let f = parsed.get(query)
  if (!f) {
    f = parseQuery(query)
    if (parsed.size > 1000) parsed.clear()
    parsed.set(query, f)
  }
  return f
}

/** Does this rule match a posted/pending bank or card transaction? */
export function ruleMatches(cond: RuleConditions, record: SourceRecord, account?: SourceAccountInfo | null): boolean {
  if (record.event.type !== 'txn.upsert') return false
  const ev: TxnUpsert = record.event
  if (cond.query) {
    const acct = account ?? null
    const row = { text: ev.rawText ?? '', counterparty: ev.counterparty ?? null, amount: ev.amount, date: record.date, account: acct ? { id: acct.id, name: acct.name, mask: acct.mask ?? null } : record.sourceAccountId ? { id: record.sourceAccountId, name: '', mask: null } : null }
    if (!matchesFilter(filterOf(cond.query), row)) return false
  }
  const text = [ev.counterparty ?? '', ev.rawText ?? ''].join(' ')
  if (cond.textPatterns && cond.textPatterns.length > 0 && !cond.textPatterns.some((p) => globMatch(p, text))) return false
  // A row with no counterparty (a CSV statement has only its description) is matched on its description.
  if (cond.counterparty !== undefined && merchantKey(ev.counterparty ?? ev.rawText ?? '') !== merchantKey(cond.counterparty)) return false
  if (cond.direction === 'in' && ev.amount.minor <= 0) return false
  if (cond.direction === 'out' && ev.amount.minor >= 0) return false
  const absMinor = Math.abs(ev.amount.minor)
  if (cond.minAbsMinor !== undefined && absMinor < cond.minAbsMinor) return false
  if (cond.maxAbsMinor !== undefined && absMinor > cond.maxAbsMinor) return false
  if (cond.currency !== undefined && ev.amount.currency !== cond.currency) return false
  if (cond.sourceAccountIds && cond.sourceAccountIds.length > 0 && (!record.sourceAccountId || !cond.sourceAccountIds.includes(record.sourceAccountId))) return false
  if (cond.entityIds && cond.entityIds.length > 0 && (!record.entityId || !cond.entityIds.includes(record.entityId))) return false
  if (cond.createdAfter !== undefined && record.createdAt < cond.createdAfter) return false
  return true
}

export interface RuleResult {
  actions: RuleActions
  /** Rules that contributed at least one action, in order. */
  ruleIds: string[]
}

/** Active rules in priority order; for each action field the first matching rule wins; a "stop" rule ends the run. */
export function applyRules(rules: readonly Rule[], record: SourceRecord, account?: SourceAccountInfo | null): RuleResult {
  const actions: RuleActions = {}
  const ruleIds: string[] = []
  for (const rule of rules) {
    if (rule.status !== 'active' || !ruleMatches(rule.conditions, record, account)) continue
    let used = false
    for (const key of ['forEntityId', 'kind', 'category', 'bucketId', 'renameTo'] as const) {
      const v = rule.actions[key]
      if (v !== undefined && actions[key] === undefined) {
        ;(actions as Record<string, unknown>)[key] = v
        used = true
      }
    }
    if (used) ruleIds.push(rule.id)
    if (rule.actions.stop) break
  }
  return { actions, ruleIds }
}

export interface RuleSuggestion {
  name: string
  conditions: RuleConditions
  actions: RuleActions
  /** Record ids that showed the pattern. */
  evidence: string[]
}

/**
 * Learn from what people and AIs set by hand: when the same merchant + direction got the same
 * (company, kind, category, bucket) `threshold` times (default 3; the spec allows 2-3), suggest a rule.
 * Skips patterns an existing rule (active, suggested or rejected) already covers.
 */
export function suggestRules(
  records: readonly SourceRecord[],
  overrides: ReadonlyMap<string, RecordOverride>,
  existing: readonly Rule[],
  threshold = 3,
): RuleSuggestion[] {
  if (threshold < 2) throw new RuleValidationError('Suggestion threshold must be at least 2')
  const groups = new Map<string, { key: string; direction: 'in' | 'out'; actions: RuleActions; evidence: string[]; label: string; entityIds: Set<string> }>()
  for (const r of records) {
    if (r.event.type !== 'txn.upsert') continue
    const o = overrides.get(r.id)
    if (!o) continue
    // An opening balance happens once for an account: a repeat of it isn't a habit to learn.
    if (o.category === 'opening_balance_equity') continue
    const actions: RuleActions = {}
    if (o.forEntityId) actions.forEntityId = o.forEntityId
    if (o.kind) actions.kind = o.kind
    if (o.category) actions.category = o.category
    if (o.bucketId) actions.bucketId = o.bucketId
    if (Object.keys(actions).length === 0) continue
    const label = r.event.counterparty ?? r.event.rawText ?? ''
    const key = merchantKey(label)
    if (key.length < 3) continue
    const direction = r.event.amount.minor < 0 ? 'out' : 'in'
    const gk = JSON.stringify([key, direction, actions.forEntityId ?? null, actions.kind ?? null, actions.category ?? null, actions.bucketId ?? null])
    const g = groups.get(gk) ?? { key, direction, actions, evidence: [], label, entityIds: new Set<string>() }
    g.evidence.push(r.id)
    if (r.entityId) g.entityIds.add(r.entityId)
    groups.set(gk, g)
  }
  const out: RuleSuggestion[] = []
  for (const g of groups.values()) {
    if (g.evidence.length < threshold) continue
    const conditions: RuleConditions = { textPatterns: [`*${g.key}*`], direction: g.direction, ...(g.entityIds.size ? { entityIds: [...g.entityIds].sort() } : {}) }
    const covered = existing.some(
      (rule) =>
        rule.conditions.direction === g.direction &&
        (rule.conditions.textPatterns ?? []).some((p) => merchantKey(p) === g.key) &&
        JSON.stringify(sortKeys(rule.actions)) === JSON.stringify(sortKeys(g.actions)),
    )
    if (covered) continue
    out.push({ name: `${g.label.trim() || g.key} → ${describeActions(g.actions)}`, conditions, actions: g.actions, evidence: g.evidence })
  }
  return out.sort((a, b) => b.evidence.length - a.evidence.length || (a.name < b.name ? -1 : 1))
}

function sortKeys(a: RuleActions): RuleActions {
  return Object.fromEntries(Object.entries(a).sort(([x], [y]) => (x < y ? -1 : 1))) as RuleActions
}

function describeActions(a: RuleActions): string {
  return [a.category ? defineRole(a.category).name : a.kind?.replace(/_/g, ' '), a.bucketId ? 'a bucket' : undefined, a.forEntityId ? 'another company' : undefined].filter(Boolean).join(', ')
}
