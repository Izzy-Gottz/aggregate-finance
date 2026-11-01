// Who is calling, and which entities they may touch for a given action and data type.
// The effective permission is always grant ∩ person: grantCovers() AND the person's own can().

import type { Action, Can, DataType, EntityId, PersonId, WorkspaceId } from '@agfn/contracts'
import { grantCovers, type Grant } from './grants.ts'
import type { Clock, EntityInfo, FinanceReader, PeopleDirectory } from './ports.ts'

/** An AI acting through a grant (OAuth token, agent key, or local stdio key). */
export interface Principal {
  workspaceId: WorkspaceId
  personId: PersonId
  grant: Grant
  via: 'oauth' | 'key'
  keyId?: string
  /** "Claude · Yisrael": shown as "added by …" and in Activity. */
  label: string
  scopes: string[]
  ip?: string
  userAgent?: string
}

export type ToolErrorCode = 'not_found' | 'forbidden' | 'invalid' | 'paused' | 'rate_limited' | 'cap_reached' | 'conflict' | 'unavailable'

/** An error the AI can act on: says what went wrong and how to recover. */
export class ToolError extends Error {
  override name = 'ToolError'
  readonly code: ToolErrorCode
  readonly hint: string | undefined
  constructor(code: ToolErrorCode, message: string, hint?: string) {
    super(message)
    this.code = code
    this.hint = hint
  }
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[b.length]!
}

export function closest(input: string, names: string[]): string | undefined {
  const q = input.toLowerCase()
  let best: { name: string; d: number } | undefined
  for (const n of names) {
    const d = levenshtein(q, n.toLowerCase())
    if (!best || d < best.d) best = { name: n, d }
  }
  return best && best.d <= Math.max(2, Math.floor(input.length / 3)) ? best.name : undefined
}

export class Access {
  readonly reader: FinanceReader
  readonly people: PeopleDirectory
  readonly clock: Clock
  constructor(reader: FinanceReader, people: PeopleDirectory, clock: Clock) {
    this.reader = reader
    this.people = people
    this.clock = clock
  }

  /** Whether this call's "all" left out a Personal space the connection can see (the answer then says so). */
  leftOutPersonal(p: Principal): boolean {
    return this.#calls.get(p)?.leftOutPersonal === true
  }

  /** Whether the person behind this connection manages the workspace (owner or admin), checked live. */
  async canManageWorkspace(p: Principal): Promise<boolean> {
    return this.people.canManageWorkspace(p.workspaceId, p.personId)
  }

  /**
   * What one tool call has read: the workspace's entities, the person's checker, and each (action, data type) answer.
   * Keyed by the call's own principal object (callToolIn makes a fresh one per call), so nothing outlives the call and
   * no two calls share it. get_overview resolves five scopes; before this each re-read every entity and membership.
   */
  readonly #calls = new WeakMap<Principal, { all?: Promise<EntityInfo[]>; can?: Can; scopes: Map<string, Promise<EntityInfo[]>>; leftOutPersonal?: boolean }>()

  #call(p: Principal) {
    let c = this.#calls.get(p)
    if (!c) {
      c = { scopes: new Map() }
      this.#calls.set(p, c)
    }
    return c
  }

  /** Every entity the principal may use for (action, dataType). */
  entities(p: Principal, action: Action, dataType: DataType): Promise<EntityInfo[]> {
    const c = this.#call(p)
    const key = `${action}|${dataType}`
    let hit = c.scopes.get(key)
    if (!hit) {
      hit = this.#entities(p, action, dataType, c)
      c.scopes.set(key, hit)
      hit.catch(() => c.scopes.delete(key))
    }
    return hit.then((xs) => [...xs])
  }

  async #entities(p: Principal, action: Action, dataType: DataType, c: { all?: Promise<EntityInfo[]>; can?: Can }): Promise<EntityInfo[]> {
    const now = this.clock.now()
    c.all ??= this.reader.entities(p.workspaceId)
    c.can ??= this.people.forCall?.() ?? this.people.can
    const all = await c.all
    const out: EntityInfo[] = []
    const actor = { kind: 'person' as const, personId: p.personId, workspaceId: p.workspaceId }
    for (const e of all) {
      if (!grantCovers(p.grant, e, action, dataType, now)) continue
      // The person half: a grant never exceeds the person who made it (checked live once per call, so role changes
      // apply from the next call).
      if (!(await c.can(actor, action, e.id, dataType))) continue
      out.push(e)
    }
    return out
  }

  /** Entities the principal can see for any purpose (whoami, sentence). */
  async anyVisible(p: Principal): Promise<EntityInfo[]> {
    const seen = new Map<EntityId, EntityInfo>()
    for (const d of p.grant.dataTypes) for (const e of await this.entities(p, 'view', d)) seen.set(e.id, e)
    return [...seen.values()]
  }

  /** A counterparty with exactly this name in a company this connection can see transactions for (for a better "not found"). */
  private async counterpartyNamed(p: Principal, q: string): Promise<{ name: string; where: string } | null> {
    if (!p.grant.dataTypes.includes('transactions')) return null
    const ents = (await this.entities(p, 'view', 'transactions').catch(() => [])).filter((e) => e.kind !== 'personal')
    if (!ents.length) return null
    const cp = await this.reader.counterparty({ workspaceId: p.workspaceId, entityIds: ents.map((e) => e.id) }, q).catch(() => null)
    // The ledger matches names loosely ("Alder Family Office" finds "ALDER FAMILY OFFICE LP"); trust its match.
    if (!cp) return null
    const where = ents.find((e) => cp.entityIds.includes(e.id))
    return where ? { name: cp.name, where: where.name } : null
  }

  /**
   * The company whose subscriptions are for a product of this name ("Bean Club" is Harbor Coffee's coffee club), so
   * the error can say its MRR and members are that company's (the benchmark's model found the right MRR and then
   * refused it as "all customers, not Bean Club").
   */
  private async productOf(p: Principal, q: string): Promise<{ company: string; products: string[] } | null> {
    if (!p.grant.dataTypes.includes('transactions')) return null
    const ents = (await this.entities(p, 'view', 'transactions').catch(() => [])).filter((e) => e.kind !== 'personal')
    const ql = q.toLowerCase()
    for (const e of ents) {
      const a = await this.reader.metric('mrr', { workspaceId: p.workspaceId, entityIds: [e.id], figureOnly: true }).catch(() => null)
      if (a?.products?.some((x) => x.toLowerCase() === ql)) return { company: e.name, products: a.products }
    }
    return null
  }

  /**
   * The first company whose transactions mention this text (a product or plan like "Bean Club", a memo word), for a
   * better "not found". Only points the model at where to look; it never resolves the company for it, since a wrong
   * company would be a wrong number.
   */
  private async mentionedIn(p: Principal, q: string): Promise<string | null> {
    if (!p.grant.dataTypes.includes('transactions')) return null
    const ents = (await this.entities(p, 'view', 'transactions').catch(() => [])).filter((e) => e.kind !== 'personal')
    for (const e of ents) {
      const r = await this.reader.searchTransactions({ workspaceId: p.workspaceId, entityIds: [e.id] }, { text: q, limit: 1 }).catch(() => null)
      if (r?.rows.length) return e.name
    }
    return null
  }

  /**
   * Resolve a `company` argument (name, id, "Personal", or "all"/omitted when allowAll) to permitted entities.
   * "all" means every company, as in core's scopeEntities: Personal is private and only included when named, so
   * "cash across my companies" never mixes in personal money. A Personal-only account (no companies here) gets
   * Personal. `allIncludesPersonal` is for lookups by account (pin_balance, refresh_balance with an account), not totals.
   * Errors list what is allowed and suggest the closest name.
   */
  async resolve(p: Principal, company: string | undefined, action: Action, dataType: DataType, opts: { allowAll: boolean; allIncludesPersonal?: boolean }): Promise<EntityInfo[]> {
    const allowed = await this.entities(p, action, dataType)
    const names = allowed.map((e) => (e.kind === 'personal' ? 'Personal' : e.name))
    if (company === undefined || company.trim() === '' || company.trim().toLowerCase() === 'all') {
      if (!opts.allowAll) throw new ToolError('invalid', 'Say which company this is for.', allowed.length ? `Allowed: ${names.join(', ')}. Ask the user if unsure.` : undefined)
      if (allowed.length === 0) throw new ToolError('forbidden', `This connection has no access to ${dataType} in any company.`, 'The owner can widen access under Connect your AI.')
      const companies = allowed.filter((e) => e.kind !== 'personal')
      if (opts.allIncludesPersonal || !companies.length) return allowed
      if (companies.length < allowed.length) this.#call(p).leftOutPersonal = true
      return companies
    }
    const q = company.trim()
    const ql = q.toLowerCase()
    const hit =
      allowed.find((e) => e.id === q) ??
      allowed.find((e) => e.name.toLowerCase() === ql) ??
      (ql === 'personal' ? allowed.find((e) => e.kind === 'personal') : undefined)
    if (hit) return [hit]
    // Visible to the person but outside this grant? Say so. Entities the person can't see are reported as not found.
    const personal = await this.people.entitiesFor(p.workspaceId, p.personId)
    const exists = personal.some((e) => e.id === q || e.name.toLowerCase() === ql)
    if (exists) {
      throw new ToolError('forbidden', `This connection can't ${action === 'view' ? 'see' : 'change'} ${dataType} for "${q}".`, allowed.length ? `Allowed: ${names.join(', ')}.` : undefined)
    }
    const guess = closest(q, names)
    const cp = guess ? null : await this.counterpartyNamed(p, q)
    if (cp) {
      throw new ToolError('not_found', `"${q}" isn't one of your companies; it's a counterparty of ${cp.where}.`, `To see money to or from it, use query_transactions with company "${cp.where}" and query counterparty:"${cp.name}" (or get_counterparty).${allowed.length ? ` Companies: ${names.join(', ')}.` : ''}`)
    }
    const product = guess ? null : await this.productOf(p, q)
    if (product) {
      const { company: c, products } = product
      // Only when it's the company's one product is the company's MRR all of it; otherwise MRR isn't split by product.
      const mrr = products.length === 1 ? `Its MRR, subscribers and churn are ${c}'s` : `${c}'s MRR is made of ${products.join(', ')}, and isn't split by product`
      throw new ToolError('not_found', `"${q}" isn't a company; it's ${c}'s subscription product.`, `${mrr}: use company "${c}" (get_metric mrr, get_mrr_movements), and search "${q}" for its charges.${allowed.length ? ` Companies: ${names.join(', ')}.` : ''}`)
    }
    const where = guess ? null : await this.mentionedIn(p, q)
    if (where) {
      throw new ToolError('not_found', `"${q}" isn't a company here; it appears in ${where}'s data.`, `Use company "${where}" and search "${q}" (search_transactions or query_transactions, query "${q}").${allowed.length ? ` Companies: ${names.join(', ')}.` : ''}`)
    }
    throw new ToolError('not_found', `Company "${q}" not found.${guess ? ` Did you mean "${guess}"?` : ''}`, allowed.length ? `Allowed: ${names.join(', ')}.${guess ? '' : ` If "${q}" is a product, customer or payee, use one of these companies (or leave company out) and search for it.`}` : undefined)
  }
}
