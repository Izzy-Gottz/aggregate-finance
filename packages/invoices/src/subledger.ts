// AR/AP subledger: invoices and bills, and what settled them (MASTER.md §6, finance-model.md §4.5).
//
// One `applications` list covers partial payments (several applications to one invoice), one payment covering
// several invoices (several applications from one source), credit notes and write-offs. Status and "overdue" are
// derived on read, never stored, so they can't go stale. The ledger (packages/core) owns journal lines; this module
// owns document state and hands the ledger normalized events.
import type {
  ConnectionId,
  CreditNoteUpsert,
  Currency,
  Id,
  InvoiceUpsert,
  IsoDate,
  Money,
  PaymentApplied,
} from '@agfn/contracts'
import { daysBetween, isIsoDate } from './dates.ts'
import { add, cmp, max, sub, sum, zero } from './money.ts'

export type Direction = 'receivable' | 'payable'

/** Statuses a reader sees. 'overdue' is not a status: see `InvoiceView.overdue`. */
export type DerivedStatus = 'draft' | 'open' | 'partially_paid' | 'paid' | 'void' | 'uncollectible' | 'disputed'

export type ApplicationSource = 'payment' | 'credit_note' | 'write_off' | 'manual'

export interface Application {
  id: Id
  invoiceKey: string
  sourceType: ApplicationSource
  /** Key of the payment / credit note (connectionId:externalId), or the caller's id for manual applications. */
  sourceKey: string
  amount: Money
  date: IsoDate
  /** Bank txn the money moved through, when known (for invoice_payment links). */
  bankTxnRef?: string
}

export interface InvoiceRecord {
  key: string
  connectionId: ConnectionId
  externalId: string
  direction: Direction
  number?: string
  counterparty: string
  issueDate: IsoDate
  dueDate?: IsoDate
  total: Money
  tax?: Money
  /** Provider-reported totals, used only when no application data exists for that component. */
  providerAmountPaid: Money
  providerAmountCredited?: Money
  providerStatus: InvoiceUpsert['status']
  rawRef?: Id
}

export interface InvoiceView {
  key: string
  direction: Direction
  number?: string
  counterparty: string
  issueDate: IsoDate
  dueDate?: IsoDate
  total: Money
  paid: Money
  credited: Money
  writtenOff: Money
  /** total − paid − credited − writtenOff, never below zero. */
  remaining: Money
  /** Applications beyond the total (a data problem shown in checks). Zero when healthy. */
  overApplied: Money
  status: DerivedStatus
  overdue: boolean
  /** Days past due as of the view date (0 when not due or settled). */
  daysOverdue: number
  /** Where `paid`/`credited` came from: our applications, or the provider's own totals. */
  paidBasis: 'applications' | 'provider'
  applications: Application[]
}

export interface UnappliedCredit {
  sourceKey: string
  sourceType: 'payment' | 'credit_note'
  direction: Direction
  counterparty?: string
  amount: Money
  date: IsoDate
}

export interface SubledgerIssue {
  code:
    | 'currency_mismatch'
    | 'application_sum_mismatch'
    | 'unknown_invoice'
    | 'direction_mismatch'
    | 'over_applied'
    | 'invalid_date'
    | 'negative_amount'
  message: string
  sourceKey: string
  invoiceKey?: string
}

export interface ApplyResult {
  key: string
  /** 'unchanged' when an identical event was already applied (idempotent re-sync). */
  outcome: 'created' | 'updated' | 'unchanged' | 'voided'
  issues: SubledgerIssue[]
}

const OPEN_LIKE: ReadonlySet<DerivedStatus> = new Set(['open', 'partially_paid', 'disputed'])

export function docKey(connectionId: ConnectionId, externalId: string): string {
  return `${connectionId}:${externalId}`
}

/** Deterministic, so the same sync always yields the same application ids. */
function appId(sourceKey: string, invoiceKey: string, i: number): Id {
  return `app_${sourceKey}_${invoiceKey}_${i}`
}

export class Subledger {
  private readonly invoices = new Map<string, InvoiceRecord>()
  /** Applications grouped by their source, so re-syncing a payment replaces its old applications atomically. */
  private readonly bySource = new Map<string, Application[]>()
  private readonly unapplied = new Map<string, UnappliedCredit>()
  /** Last applied event fingerprint per key, for idempotency. */
  private readonly fingerprints = new Map<string, string>()
  /** Applications whose invoice hasn't arrived yet (payments can sync before invoices). Re-checked on invoice upsert. */
  private readonly orphanIssues = new Map<string, SubledgerIssue[]>()

  // ---------- writes ----------

  apply(event: InvoiceUpsert | PaymentApplied | CreditNoteUpsert): ApplyResult {
    switch (event.type) {
      case 'invoice.upsert':
        return this.upsertInvoice(event)
      case 'payment.applied':
        return this.upsertPayment(event)
      case 'credit_note.upsert':
        return this.upsertCreditNote(event)
    }
  }

  private upsertInvoice(e: InvoiceUpsert): ApplyResult {
    const key = docKey(e.connectionId, e.externalId)
    const issues: SubledgerIssue[] = []
    const fp = fingerprint(e)
    if (this.fingerprints.get(key) === fp) return { key, outcome: 'unchanged', issues }
    if (!isIsoDate(e.issueDate) || (e.dueDate !== undefined && !isIsoDate(e.dueDate))) {
      issues.push({ code: 'invalid_date', message: `invoice ${e.number ?? e.externalId} has an invalid date`, sourceKey: key })
      return { key, outcome: 'unchanged', issues }
    }
    for (const m of [e.amountPaid, e.tax, e.amountCredited]) {
      if (m && m.currency !== e.total.currency) {
        issues.push({ code: 'currency_mismatch', message: `invoice ${e.number ?? e.externalId} mixes ${e.total.currency} and ${m.currency}`, sourceKey: key })
        return { key, outcome: 'unchanged', issues }
      }
    }
    if (e.total.minor < 0) {
      issues.push({ code: 'negative_amount', message: `invoice ${e.number ?? e.externalId} has a negative total; send it as a credit note`, sourceKey: key })
      return { key, outcome: 'unchanged', issues }
    }
    const existed = this.invoices.has(key)
    const rec: InvoiceRecord = {
      key,
      connectionId: e.connectionId,
      externalId: e.externalId,
      direction: e.direction,
      counterparty: e.counterparty,
      issueDate: e.issueDate,
      total: e.total,
      providerAmountPaid: e.amountPaid,
      providerStatus: e.status,
    }
    if (e.number !== undefined) rec.number = e.number
    if (e.dueDate !== undefined) rec.dueDate = e.dueDate
    if (e.tax !== undefined) rec.tax = e.tax
    if (e.amountCredited !== undefined) rec.providerAmountCredited = e.amountCredited
    if (e.rawRef !== undefined) rec.rawRef = e.rawRef
    this.invoices.set(key, rec)
    this.fingerprints.set(key, fp)
    // Applications that arrived before this invoice are now resolvable; re-validate them.
    this.orphanIssues.delete(key)
    issues.push(...this.validateInvoice(key))
    return { key, outcome: existed ? 'updated' : 'created', issues }
  }

  private upsertPayment(e: PaymentApplied): ApplyResult {
    const key = docKey(e.connectionId, e.externalId)
    const fp = fingerprint(e)
    if (this.fingerprints.get(key) === fp) return { key, outcome: 'unchanged', issues: [] }
    const existed = this.bySource.has(key) || this.unapplied.has(key)
    this.removeSource(key)
    this.fingerprints.set(key, fp)
    if (e.status === 'void') return { key, outcome: 'voided', issues: [] }

    const issues = this.checkSourceShape(key, e.date, e.amount, e.applications, e.unapplied)
    if (issues.some((i) => i.code === 'currency_mismatch' || i.code === 'invalid_date' || i.code === 'negative_amount')) {
      return { key, outcome: existed ? 'updated' : 'created', issues }
    }
    const apps = this.buildApplications(key, 'payment', e.connectionId, e.direction, e.date, e.applications, e.bankTxnRef, issues)
    this.bySource.set(key, apps)
    const leftover = e.unapplied ?? sub(e.amount, sum(e.applications.map((a) => a.amount), e.amount.currency))
    if (leftover.minor > 0) {
      const credit: UnappliedCredit = { sourceKey: key, sourceType: 'payment', direction: e.direction, amount: leftover, date: e.date }
      if (e.counterparty !== undefined) credit.counterparty = e.counterparty
      this.unapplied.set(key, credit)
    }
    for (const a of apps) issues.push(...this.validateInvoice(a.invoiceKey))
    return { key, outcome: existed ? 'updated' : 'created', issues }
  }

  private upsertCreditNote(e: CreditNoteUpsert): ApplyResult {
    const key = docKey(e.connectionId, e.externalId)
    const fp = fingerprint(e)
    if (this.fingerprints.get(key) === fp) return { key, outcome: 'unchanged', issues: [] }
    const existed = this.bySource.has(key) || this.unapplied.has(key)
    this.removeSource(key)
    this.fingerprints.set(key, fp)
    if (e.status === 'void') return { key, outcome: 'voided', issues: [] }

    const allocations =
      e.applications ?? (e.invoiceExternalId !== undefined && e.appliedTo === 'invoice' ? [{ invoiceExternalId: e.invoiceExternalId, amount: e.amount }] : [])
    const issues = this.checkSourceShape(key, e.date, e.amount, allocations, undefined)
    if (issues.some((i) => i.code === 'currency_mismatch' || i.code === 'invalid_date' || i.code === 'negative_amount')) {
      return { key, outcome: existed ? 'updated' : 'created', issues }
    }
    const apps = this.buildApplications(key, 'credit_note', e.connectionId, e.direction, e.date, allocations, undefined, issues)
    this.bySource.set(key, apps)
    // Refunded or handled outside the tool: nothing left as credit.
    if (e.appliedTo === 'invoice' || e.appliedTo === 'customer_credit') {
      const leftover = sub(e.amount, sum(allocations.map((a) => a.amount), e.amount.currency))
      if (leftover.minor > 0) {
        const credit: UnappliedCredit = { sourceKey: key, sourceType: 'credit_note', direction: e.direction, amount: leftover, date: e.date }
        if (e.counterparty !== undefined) credit.counterparty = e.counterparty
        this.unapplied.set(key, credit)
      }
    }
    for (const a of apps) issues.push(...this.validateInvoice(a.invoiceKey))
    return { key, outcome: existed ? 'updated' : 'created', issues }
  }

  /**
   * A Aggregate-native application: a bank row matched to an invoice, or an AI's `record_payment`.
   * `sourceKey` must be stable (e.g. the bank txn id or the write request id) so re-applying is idempotent.
   */
  applyManual(input: {
    sourceKey: string
    date: IsoDate
    applications: Array<{ invoiceKey: string; amount: Money }>
    bankTxnRef?: string
  }): ApplyResult {
    const key = `manual:${input.sourceKey}`
    const fp = JSON.stringify(input)
    if (this.fingerprints.get(key) === fp) return { key, outcome: 'unchanged', issues: [] }
    const existed = this.bySource.has(key)
    this.removeSource(key)
    this.fingerprints.set(key, fp)
    const issues: SubledgerIssue[] = []
    if (!isIsoDate(input.date)) {
      issues.push({ code: 'invalid_date', message: `invalid date ${input.date}`, sourceKey: key })
      return { key, outcome: 'unchanged', issues }
    }
    const apps: Application[] = []
    input.applications.forEach((a, i) => {
      const inv = this.invoices.get(a.invoiceKey)
      if (!inv) {
        issues.push({ code: 'unknown_invoice', message: `no invoice ${a.invoiceKey}`, sourceKey: key, invoiceKey: a.invoiceKey })
        return
      }
      if (a.amount.currency !== inv.total.currency) {
        issues.push({ code: 'currency_mismatch', message: `application in ${a.amount.currency} to a ${inv.total.currency} invoice`, sourceKey: key, invoiceKey: a.invoiceKey })
        return
      }
      if (a.amount.minor <= 0) {
        issues.push({ code: 'negative_amount', message: 'application amounts must be positive', sourceKey: key, invoiceKey: a.invoiceKey })
        return
      }
      const app: Application = { id: appId(key, a.invoiceKey, i), invoiceKey: a.invoiceKey, sourceType: 'manual', sourceKey: key, amount: a.amount, date: input.date }
      if (input.bankTxnRef !== undefined) app.bankTxnRef = input.bankTxnRef
      apps.push(app)
    })
    this.bySource.set(key, apps)
    for (const a of apps) issues.push(...this.validateInvoice(a.invoiceKey))
    return { key, outcome: existed ? 'updated' : 'created', issues }
  }

  /** Write off what remains (bad debt). Idempotent per invoice. */
  writeOff(invoiceKey: string, date: IsoDate, asOf: IsoDate = date): ApplyResult {
    const key = `writeoff:${invoiceKey}`
    this.removeSource(key)
    const view = this.view(invoiceKey, asOf)
    if (!view) return { key, outcome: 'unchanged', issues: [{ code: 'unknown_invoice', message: `no invoice ${invoiceKey}`, sourceKey: key, invoiceKey }] }
    if (view.remaining.minor === 0) return { key, outcome: 'unchanged', issues: [] }
    this.bySource.set(key, [{ id: appId(key, invoiceKey, 0), invoiceKey, sourceType: 'write_off', sourceKey: key, amount: view.remaining, date }])
    return { key, outcome: 'created', issues: [] }
  }

  removeSource(sourceKey: string): void {
    this.bySource.delete(sourceKey)
    this.unapplied.delete(sourceKey)
    this.fingerprints.delete(sourceKey)
  }

  // ---------- reads ----------

  get(invoiceKey: string): InvoiceRecord | undefined {
    return this.invoices.get(invoiceKey)
  }

  findByExternalId(connectionId: ConnectionId, externalId: string): InvoiceRecord | undefined {
    return this.invoices.get(docKey(connectionId, externalId))
  }

  applicationsFor(invoiceKey: string): Application[] {
    const out: Application[] = []
    for (const apps of this.bySource.values()) for (const a of apps) if (a.invoiceKey === invoiceKey) out.push(a)
    return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1))
  }

  applicationsFromSource(sourceKey: string): Application[] {
    return [...(this.bySource.get(sourceKey) ?? [])]
  }

  unappliedCredits(direction?: Direction): UnappliedCredit[] {
    return [...this.unapplied.values()].filter((c) => !direction || c.direction === direction)
  }

  /** The invoice as of a date. Applications dated after `asOf` are ignored, so aging can be computed historically. */
  view(invoiceKey: string, asOf: IsoDate): InvoiceView | undefined {
    const inv = this.invoices.get(invoiceKey)
    if (!inv) return undefined
    const cur = inv.total.currency
    const apps = this.applicationsFor(invoiceKey).filter((a) => a.date <= asOf)
    const byType = (t: ApplicationSource[]): Money => sum(apps.filter((a) => t.includes(a.sourceType)).map((a) => a.amount), cur)

    const hasPaymentApps = apps.some((a) => a.sourceType === 'payment' || a.sourceType === 'manual')
    const hasCreditApps = apps.some((a) => a.sourceType === 'credit_note')
    // Provider totals have no dates, so they only count for "now"-ish views (asOf on/after issue date).
    const providerOk = asOf >= inv.issueDate
    const paid = hasPaymentApps ? byType(['payment', 'manual']) : providerOk ? inv.providerAmountPaid : zero(cur)
    const credited = hasCreditApps ? byType(['credit_note']) : providerOk ? (inv.providerAmountCredited ?? zero(cur)) : zero(cur)
    const writtenOff = byType(['write_off'])
    const raw = sub(sub(sub(inv.total, paid), credited), writtenOff)
    const remaining = max(raw, zero(cur))
    const overApplied = raw.minor < 0 ? money0(-raw.minor, cur) : zero(cur)

    const status = deriveStatus(inv, paid, credited, writtenOff, remaining)
    const dueOpen = OPEN_LIKE.has(status) && inv.dueDate !== undefined
    const daysOverdue = dueOpen ? Math.max(0, daysBetween(inv.dueDate as IsoDate, asOf)) : 0

    const v: InvoiceView = {
      key: inv.key,
      direction: inv.direction,
      counterparty: inv.counterparty,
      issueDate: inv.issueDate,
      total: inv.total,
      paid,
      credited,
      writtenOff,
      remaining,
      overApplied,
      status,
      overdue: daysOverdue > 0,
      daysOverdue,
      paidBasis: hasPaymentApps || hasCreditApps ? 'applications' : 'provider',
      applications: apps,
    }
    if (inv.number !== undefined) v.number = inv.number
    if (inv.dueDate !== undefined) v.dueDate = inv.dueDate
    return v
  }

  list(filter: { direction?: Direction; asOf: IsoDate; counterparty?: string; openOnly?: boolean; currency?: Currency }): InvoiceView[] {
    const out: InvoiceView[] = []
    for (const inv of this.invoices.values()) {
      if (filter.direction && inv.direction !== filter.direction) continue
      if (filter.currency && inv.total.currency !== filter.currency) continue
      if (filter.counterparty && normalizeName(inv.counterparty) !== normalizeName(filter.counterparty)) continue
      if (inv.issueDate > filter.asOf) continue // didn't exist yet
      const v = this.view(inv.key, filter.asOf)
      if (!v) continue
      if (filter.openOnly && !OPEN_LIKE.has(v.status)) continue
      out.push(v)
    }
    return out.sort(byDueThenIssue)
  }

  /** Integrity checks over the whole subledger (shown as "needs review" by the ledger checks). */
  checks(asOf: IsoDate): SubledgerIssue[] {
    const issues: SubledgerIssue[] = []
    for (const key of this.invoices.keys()) issues.push(...this.validateInvoice(key, asOf))
    for (const list of this.orphanIssues.values()) issues.push(...list)
    return issues
  }

  // ---------- internals ----------

  private checkSourceShape(
    key: string,
    date: IsoDate,
    amount: Money,
    allocations: Array<{ invoiceExternalId: string; amount: Money }>,
    unapplied: Money | undefined,
  ): SubledgerIssue[] {
    const issues: SubledgerIssue[] = []
    if (!isIsoDate(date)) issues.push({ code: 'invalid_date', message: `invalid date ${date}`, sourceKey: key })
    if (amount.minor < 0) issues.push({ code: 'negative_amount', message: 'payment and credit amounts are positive; direction gives the sign', sourceKey: key })
    for (const a of allocations) {
      if (a.amount.currency !== amount.currency) {
        issues.push({ code: 'currency_mismatch', message: `application in ${a.amount.currency} from a ${amount.currency} payment`, sourceKey: key })
        return issues
      }
      if (a.amount.minor <= 0) issues.push({ code: 'negative_amount', message: 'application amounts must be positive', sourceKey: key })
    }
    if (unapplied && unapplied.currency !== amount.currency) {
      issues.push({ code: 'currency_mismatch', message: 'unapplied amount in a different currency', sourceKey: key })
      return issues
    }
    const applied = sum(allocations.map((a) => a.amount), amount.currency)
    const total = unapplied ? add(applied, unapplied) : applied
    if (cmp(total, amount) > 0 || (unapplied && cmp(total, amount) !== 0)) {
      issues.push({
        code: 'application_sum_mismatch',
        message: `applications (${applied.minor}${unapplied ? ` + unapplied ${unapplied.minor}` : ''}) don't add up to the amount (${amount.minor})`,
        sourceKey: key,
      })
    }
    return issues
  }

  private buildApplications(
    key: string,
    sourceType: 'payment' | 'credit_note',
    connectionId: ConnectionId,
    direction: Direction,
    date: IsoDate,
    allocations: Array<{ invoiceExternalId: string; amount: Money }>,
    bankTxnRef: string | undefined,
    issues: SubledgerIssue[],
  ): Application[] {
    const apps: Application[] = []
    const orphans: SubledgerIssue[] = []
    allocations.forEach((a, i) => {
      if (a.amount.minor <= 0) return
      const invoiceKey = docKey(connectionId, a.invoiceExternalId)
      const inv = this.invoices.get(invoiceKey)
      if (inv && inv.direction !== direction) {
        issues.push({ code: 'direction_mismatch', message: `a ${direction} ${sourceType} applied to a ${inv.direction} document`, sourceKey: key, invoiceKey })
        return
      }
      if (inv && inv.total.currency !== a.amount.currency) {
        // Cross-currency settlement must be converted by the connector into the invoice currency first.
        issues.push({ code: 'currency_mismatch', message: `${a.amount.currency} application to a ${inv.total.currency} invoice`, sourceKey: key, invoiceKey })
        return
      }
      if (!inv) orphans.push({ code: 'unknown_invoice', message: `${sourceType} references invoice ${a.invoiceExternalId} that hasn't synced`, sourceKey: key, invoiceKey })
      const app: Application = { id: appId(key, invoiceKey, i), invoiceKey, sourceType, sourceKey: key, amount: a.amount, date }
      if (bankTxnRef !== undefined) app.bankTxnRef = bankTxnRef
      apps.push(app)
    })
    for (const o of orphans) {
      const list = this.orphanIssues.get(o.invoiceKey as string) ?? []
      list.push(o)
      this.orphanIssues.set(o.invoiceKey as string, list)
    }
    issues.push(...orphans)
    return apps
  }

  private validateInvoice(invoiceKey: string, asOf = '9999-12-31'): SubledgerIssue[] {
    const v = this.view(invoiceKey, asOf)
    if (!v || v.overApplied.minor === 0) return []
    return [
      {
        code: 'over_applied',
        message: `${v.number ?? invoiceKey} has ${v.overApplied.minor} minor units applied beyond its total`,
        sourceKey: invoiceKey,
        invoiceKey,
      },
    ]
  }
}

function money0(minor: number, currency: Currency): Money {
  return { minor, currency }
}

function deriveStatus(inv: InvoiceRecord, paid: Money, credited: Money, writtenOff: Money, remaining: Money): DerivedStatus {
  if (inv.providerStatus === 'void') return 'void'
  if (inv.providerStatus === 'draft') return 'draft'
  if (inv.providerStatus === 'uncollectible' || (writtenOff.minor > 0 && remaining.minor === 0)) return 'uncollectible'
  if (remaining.minor === 0) return 'paid'
  if (inv.providerStatus === 'disputed') return 'disputed'
  if (paid.minor > 0 || credited.minor > 0) return 'partially_paid'
  // A provider can say "paid" without payment detail (e.g. marked paid out of band) — trust it.
  if (inv.providerStatus === 'paid') return 'paid'
  return 'open'
}

function byDueThenIssue(a: InvoiceView, b: InvoiceView): number {
  const ad = a.dueDate ?? a.issueDate
  const bd = b.dueDate ?? b.issueDate
  if (ad !== bd) return ad < bd ? -1 : 1
  if (a.issueDate !== b.issueDate) return a.issueDate < b.issueDate ? -1 : 1
  return a.key < b.key ? -1 : 1
}

/** Case/punctuation/suffix-insensitive counterparty name used for grouping and matching. */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|pty|sa|bv|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function fingerprint(e: InvoiceUpsert | PaymentApplied | CreditNoteUpsert): string {
  // rawRef changes on every re-sync even when the document didn't; leave it out.
  const { rawRef: _r, ...rest } = e
  return JSON.stringify(rest)
}

