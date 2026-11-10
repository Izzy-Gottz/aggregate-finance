// Finance routes for the web UI: the company drawer, transaction search, and payroll register upload.
// Mounted under /api after session auth (c.get('person')). Shapes: apps/web/src/api/types.ts (CompanyDetail, TxnRow).
// Every section is checked with permissions.can() for its own data type; a slice that isn't installed yet leaves its
// section empty instead of failing the whole drawer.

import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AccountView, Actor, DataType, FinanceReader, HoldingView, MetricAnswer, Money, ReadScope, SetAsideView } from '@agfn/contracts'
import { RegisterError } from '@agfn/connector-payroll-detect'
import { ToolError } from '@agfn/mcp'
import type { RequestPerson } from '../app.ts'
import { financeFor } from '../finance.ts'
import { DEFAULT_TIME_ZONE, defineRole, exponentOf, isFixedRole, localDate, trailingMonths } from '@agfn/core'
import { termsByAccount } from '../account-terms.ts'
import { personalHidden } from '../personal.ts'
import { companyNotEmpty, isWorkspaceOwner } from '../delete-company.ts'
import type { Services } from '../services.ts'

type Env = { Variables: { person: RequestPerson } }
type S = Pick<Services, 'db' | 'ledger' | 'syncDeps' | 'permissions'> & Partial<Pick<Services, 'mcp'>>

const MAX_REGISTER_BYTES = 2 * 1024 * 1024

function reply(status: number, body: Record<string, unknown>): never {
  throw new HTTPException(status as 400, { res: new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) })
}

/** A section's data, or null when that part of the system isn't installed or has nothing yet. */
async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof ToolError && (e.code === 'unavailable' || e.code === 'not_found')) return null
    throw e
  }
}

const ACCOUNT_KIND: Partial<Record<AccountView['type'], 'bank' | 'card' | 'payments' | 'cash' | 'loan' | 'investment' | 'crypto'>> = {
  depository: 'bank',
  credit_card: 'card',
  processor_balance: 'payments',
  cash_on_hand: 'cash',
  loan: 'loan',
  investment: 'investment',
  crypto: 'crypto',
}
const STALE_MS = 48 * 3600_000

/** A bucket without a schedule, told by what it holds: "$25,000 · SAFE · Mar 1, 2026"; "N paid" once payments exist. */
export function bucketLine(b: { name: string; fields: Array<{ key: string; type: string }>; values: Record<string, unknown>; status: { paid: number } }, held?: Money): string {
  if (b.status.paid > 0) return `${b.status.paid} paid`
  const of = (type: string) => b.fields.filter((f) => f.type === type).map((f) => b.values[f.key])
  const money = of('money').filter((v): v is Money => !!v && typeof v === 'object' && typeof (v as Money).minor === 'number' && typeof (v as Money).currency === 'string').map(fmtMoney)
  const name = b.name.toLowerCase()
  const text = of('text').filter((v): v is string => typeof v === 'string' && !!v.trim() && !name.includes(v.trim().toLowerCase())).map((v) => v.trim().slice(0, 40))
  const dates = of('date').filter((v): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)).map((v) => new Date(`${v}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }))
  const parts = [...money, ...text, ...dates]
  if (parts.length) return parts.slice(0, 4).join(' · ')
  return held ? `Set aside ${fmtMoney(held)}` : 'Nothing paid yet'
}

/** Minor units to major ones by the currency's own exponent (JPY 0, USD 2, BHD 3), never a fixed 100. */
const major = (m: Money): number => m.minor / 10 ** exponentOf(m.currency)

export function fmtMoney(m: Money): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: m.currency, maximumFractionDigits: 0 }).format(major(m))
  } catch {
    return `${major(m).toFixed(0)} ${m.currency}`
  }
}

export function financeRoutes(s: S, o: { setAsides?: boolean } = {}): Hono<Env> {
  const app = new Hono<Env>()
  const reader = (): FinanceReader => financeFor(s).reader

  async function entityCtx(c: Context<Env>) {
    const p = c.get('person')
    if (!p.workspaceId) reply(409, { error: 'onboarding', message: 'Create your first company to get started.' })
    const ws = p.workspaceId
    const id = c.req.param('id') as string
    const visible = await s.permissions.entitiesFor(ws, p.personId)
    const entity = visible.find((e) => e.id === id)
    // Not visible and not existing look the same: no probing for other people's companies.
    if (!entity) reply(404, { message: 'That company was not found.' })
    const actor: Actor = { kind: 'person', personId: p.personId, workspaceId: ws }
    const can = (action: 'view' | 'add', dt: DataType) => s.permissions.can(actor, action, id, dt)
    const row = await s.db.selectFrom('entities').select(['base_currency']).where('id', '=', id).executeTakeFirst()
    const scope: ReadScope = { workspaceId: ws, entityIds: [id] }
    return { ws, p, entity, scope, can, currency: row?.base_currency ?? 'USD' }
  }

  // ---------- GET /api/entities/:id → CompanyDetail ----------
  app.get('/entities/:id', async (c) => {
    const { ws, p, entity, scope, can, currency } = await entityCtx(c)
    const r = reader()
    const [seeBalances, seeTxns, seeInvoices, seeBills, seeBuckets, seePayroll, seeEquity] = await Promise.all(
      (['balances', 'transactions', 'invoices', 'bills', 'buckets', 'payroll', 'equity'] as DataType[]).map((d) => can('view', d)),
    )
    const now = new Date()
    const today = await workspaceToday(s, ws, now)
    const books = financeFor(s).books
    // Every section below reads independently: start them all at once (on Postgres they run side by side on the
    // pool instead of one after another), then assemble.
    const started = {
      available: safe(() => r.dataAvailability(scope)),
      accounts: seeBalances ? safe(() => r.accounts(scope, {})) : Promise.resolve(null),
      cash: seeBalances ? safe(() => r.metric('cash', { workspaceId: ws, entityIds: [entity.id] })) : Promise.resolve(null),
      availableCash: seeBalances && o.setAsides ? safe(() => r.metric('available_cash', { workspaceId: ws, entityIds: [entity.id] })) : Promise.resolve(null),
      terms: seeBalances ? termsByAccount(r, scope) : Promise.resolve(new Map()),
      runway: seeBalances ? safe(() => r.metric('runway', { workspaceId: ws, entityIds: [entity.id] })) : Promise.resolve(null),
      trend: seeBalances ? cashTrend(s, r, ws, entity.id, now) : Promise.resolve([] as number[]),
      drawer: seePayroll ? books.reader.drawer(ws, entity.id) : Promise.resolve(null),
      inv: seeInvoices || seeBills ? safe(() => r.searchInvoices(scope, { limit: 200 })) : Promise.resolve(null),
      buckets: seeBuckets ? safe(() => r.buckets(scope)) : Promise.resolve(null),
      cap: seeEquity ? safe(() => r.capTable(scope)) : Promise.resolve(null),
      owner: seeBalances ? safe(() => r.ownerBalances(scope, p.personId)) : Promise.resolve(null),
      anomalies: seeTxns ? anomaliesOf(s, scope) : Promise.resolve([] as AnomalyRow[]),
      mrr: seeTxns ? mrrSummary(r, ws, entity.id, today) : Promise.resolve(null),
      // Payroll cost for payroll_cost's own default period (the last calendar month), labelled with that month.
      payrollCost: seePayroll ? safe(() => r.metric('payroll_cost', scope)) : Promise.resolve(null),
      locks: safe(async () => (r.periodLocks ? await r.periodLocks(scope) : [])),
      holdings: seeBalances && r.holdings ? safe(() => r.holdings!(scope)) : Promise.resolve(null),
      // The figures get_overview reports for this company (cash state, runway state, owed to you, bills due in 30
      // days): one definition for the app and the AI tools. The rows below are only the lists under them.
      overview: seeBalances || seeInvoices || seeBills ? safe(() => r.overview(scope)) : Promise.resolve(null),
      canClose: entity.kind === 'company' && !!s.mcp ? s.permissions.canManageWorkspace(ws, p.personId) : Promise.resolve(false),
    }
    // Nothing is left unobserved if one section throws before the others are awaited.
    for (const x of Object.values(started)) void (x as Promise<unknown>).catch(() => undefined)
    const available = new Set((await started.available) ?? [])

    // Cash, runway, trend, accounts.
    const accounts = (await started.accounts) ?? []
    const cashAnswer = await started.cash
    // Unknown cash has no honest total: null, as on the Workspace page and in get_overview (never a made-up 0).
    const cashValue = cashAnswer && cashAnswer.state !== 'unknown' && cashAnswer.value && typeof cashAnswer.value === 'object' ? (cashAnswer.value as Money) : null
    const ov = ((await started.overview)?.entities ?? []).find((e) => e.entityId === entity.id)
    const terms = await started.terms
    const accountRows = accounts.flatMap((a) => {
      const kind = ACCOUNT_KIND[a.type]
      if (!kind || a.closed) return []
      const row: Record<string, unknown> = {
        id: a.id,
        name: a.name,
        institution: a.institution ?? '',
        kind,
        balance: a.balance ?? { minor: 0, currency: a.currency },
        asOf: a.lastSyncAt ?? now.toISOString(),
        stale: !a.lastSyncAt || now.getTime() - Date.parse(a.lastSyncAt) > STALE_MS,
      }
      if (a.mask) row.mask = a.mask
      const t = terms.get(a.id)
      if (t) row.terms = t
      return [row]
    })
    const explained = (label: string, answer: MetricAnswer) => ({
      label,
      answer,
      rows: accounts
        .filter((a) => answer.includedAccounts.includes(a.id) && a.balance)
        .map((a) => ({ id: a.id, label: a.name, ...(a.institution ? { detail: a.institution } : {}), amount: a.balance as Money })),
    })
    const runwayAnswer = await started.runway
    // Set-asides that don't count: only when there are some. cash stays the bank's total; the app shows both.
    const availableAnswer = await started.availableCash
    const availableValue = availableAnswer?.value && typeof availableAnswer.value === 'object' ? availableAnswer.value : null
    const setAside = cashValue && availableValue && availableValue.minor !== cashValue.minor ? { available: availableValue, held: { minor: cashValue.minor - availableValue.minor, currency: cashValue.currency } } : null
    // Runway starts from available cash, so the rows have to come to that figure.
    const runwayExplained = (answer: MetricAnswer) => {
      const e = explained('Runway', answer)
      return setAside ? { ...e, rows: [...e.rows, { id: 'set-aside', label: 'Set aside', detail: 'Doesn’t count in cash', amount: { minor: -setAside.held.minor, currency: setAside.held.currency } }] } : e
    }
    const trend = cashValue ? await started.trend : []

    // Books, payroll and equity sections.
    const drawer = await started.drawer
    const inv = await started.inv
    const receivable = (inv?.rows ?? []).filter((v) => v.direction === 'receivable' && ['open', 'overdue', 'partially_paid', 'disputed'].includes(v.status))
    const payable = (inv?.rows ?? []).filter((v) => v.direction === 'payable' && ['open', 'overdue', 'partially_paid', 'disputed'].includes(v.status))
    const open = (v: { total: Money; amountPaid: Money }): Money => ({ minor: v.total.minor - v.amountPaid.minor, currency: v.total.currency })

    let owedToYou: Record<string, unknown> | null = null
    if (seeInvoices && receivable.length) {
      const total = inv?.totals.find((t) => t.direction === 'receivable' && t.open.currency === currency) ?? inv?.totals.find((t) => t.direction === 'receivable')
      const ag = inv?.aging.find((a) => a.direction === 'receivable' && a.currency === total?.open.currency)
      const labels: Array<[keyof NonNullable<typeof ag>, string]> = [['current', 'Not due yet'], ['d1_30', '1–30 days'], ['d31_60', '31–60 days'], ['d61_90', '61–90 days'], ['d90_plus', 'Over 90 days']]
      owedToYou = {
        total: ov?.owedToYou.total ?? total?.open ?? { minor: 0, currency },
        overdue: ov?.owedToYou.overdue ?? total?.overdue ?? { minor: 0, currency },
        aging: ag ? labels.map(([k, label]) => ({ label, amount: ag[k] as Money })).filter((x) => x.amount.minor > 0) : [],
        invoices: receivable.map((v) => ({ id: v.id, counterparty: v.counterparty, ...(v.number ? { number: v.number } : {}), total: v.total, open: open(v), dueDate: v.dueDate ?? v.issueDate, source: v.source })),
      }
    }
    let bills: Record<string, unknown> | null = null
    if (seeBills && (payable.length || (ov?.billsDue30d.minor ?? 0) > 0)) {
      // Due in the next 30 days as get_overview counts it: open bills, recurring charges and card/loan minimums.
      const due30 = payable.filter((v) => (v.dueDate ?? v.issueDate) <= addDays(today, 30))
      const soon = due30.filter((v) => v.total.currency === currency)
      const openSoon = soon.reduce((sum, v) => sum + open(v).minor, 0)
      const dueSoon = ov?.billsDue30d ?? { minor: openSoon, currency }
      // A bill in another currency is in dueSoon at the day's rate but not in openSoon: no split, rather than call it recurring.
      const other = due30.length === soon.length ? dueSoon.minor - openSoon : 0
      bills = {
        dueSoon,
        ...(other > 0 ? { breakdown: { openBills: { minor: openSoon, currency: dueSoon.currency }, recurring: { minor: other, currency: dueSoon.currency } } } : {}),
        rows: payable
          .sort((a, b) => ((a.dueDate ?? a.issueDate) < (b.dueDate ?? b.issueDate) ? -1 : 1))
          .map((v) => ({ id: v.id, name: v.counterparty, amount: open(v), dueDate: v.dueDate ?? v.issueDate, detail: v.status === 'overdue' ? `${v.daysOverdue} days overdue` : (v.number ?? v.source) })),
      }
    }

    // Only this company's accounts, and only for someone who may see its balances: a set-aside can span companies.
    const heldHere = (b: { setAside?: SetAsideView }): Money | undefined => {
      const here = o.setAsides && seeBalances ? (b.setAside?.perAccount ?? []).filter((p) => p.entityId === entity.id) : []
      const minor = here.reduce((n, p) => n + p.heldBase.minor, 0)
      return minor > 0 ? { minor, currency: here[0]!.heldBase.currency } : undefined
    }
    const buckets = seeBuckets
      ? ((await started.buckets) ?? []).map((b) => ({
          id: b.id,
          name: b.name,
          line: b.schedule ? `${fmtMoney(b.schedule.amount)} ${b.schedule.cadence}${b.schedule.dueDay ? ` · day ${b.schedule.dueDay}` : ''}` : bucketLine(b, heldHere(b)),
          status: b.status.missed > 0 ? 'missed' : b.status.upcoming > 0 ? 'upcoming' : 'ok',
        }))
      : []

    const cap = seeEquity ? ((await started.cap) ?? [])[0] : undefined
    const equity = cap
      ? {
          fullyDilutedShares: cap.fullyDilutedShares,
          holders: cap.holders.map((h) => ({ name: h.name, role: h.class, percent: h.fullyDilutedPct })),
          convertibles: cap.safesAndNotes.map((x, i) => ({
            id: `${entity.id}:conv:${i}`,
            investor: x.holder,
            kind: x.kind === 'safe' ? 'SAFE' : 'Note',
            amount: x.amount,
            ...(x.cap ? { cap: x.cap } : {}),
            ...(x.discountPct !== undefined ? { discountPct: x.discountPct } : {}),
            date: cap.asOf,
          })),
        }
      : null

    const owner = (await started.owner) ?? []
    const whoseMoney = owner
      .filter((o) => o.balance.minor !== 0)
      .map((o) => ({
        id: `${o.entityId}:${o.personId}`,
        label: o.balance.minor > 0 ? `${entity.name} owes you` : `You owe ${entity.name}`,
        amount: { minor: Math.abs(o.balance.minor), currency: o.balance.currency },
        detail: [o.loans.minor ? `loans ${fmtMoney(o.loans)}` : '', o.unreimbursedExpenses.minor ? `expenses to repay ${fmtMoney(o.unreimbursedExpenses)}` : '', o.unspecified.minor ? `${fmtMoney(o.unspecified)} not yet labeled` : '']
          .filter(Boolean)
          .join(' · '),
      }))

    // What needs a look, built from the sections above (the workspace overview would recompute eight metrics for
    // this one company): failing checks and stale or unreviewed sources from cash and runway, low runway, and the
    // three most overdue invoices.
    type Check = { name: string; message: string; entityId: string | null; status: string }
    const checks = new Map<string, Check>()
    for (const a of [cashAnswer, runwayAnswer]) for (const ch of ((a as { failedChecks?: Check[] } | null)?.failedChecks ?? [])) if (ch.status === 'fail' && (!ch.entityId || ch.entityId === entity.id)) checks.set(`${ch.name}|${ch.message}`, ch)
    const attention: Array<{ id: string; label: string; detail: string; tone: 'red' | 'amber' | 'grey' }> = []
    if (runwayAnswer && typeof runwayAnswer.value === 'number' && runwayAnswer.value < 6) attention.push({ id: 'att:runway', label: ATTENTION_LABEL.low_runway, detail: `${entity.name}: about ${runwayAnswer.value} months of runway`, tone: 'red' })
    // Invoice text only for people who can see invoices.
    for (const v of (seeInvoices ? receivable : []).filter((x) => x.daysOverdue > 0).sort((a, b) => b.daysOverdue - a.daysOverdue).slice(0, 3))
      attention.push({ id: v.id, label: ATTENTION_LABEL.overdue_invoice, detail: `${v.number ?? 'An invoice'} to ${v.counterparty} is ${v.daysOverdue} days overdue`, tone: 'amber' })
    if (cashAnswer && cashAnswer.pendingReviewCount > 0) attention.push({ id: 'att:review', label: ATTENTION_LABEL.needs_review, detail: `${entity.name}: ${cashAnswer.pendingReviewCount} item(s) to review`, tone: 'amber' })
    for (const sId of cashAnswer?.staleSources ?? []) attention.push({ id: sId, label: ATTENTION_LABEL.stale_source, detail: `A connection for ${entity.name} hasn't synced in over a day`, tone: 'grey' })
    for (const ch of checks.values()) attention.push({ id: `att:check:${ch.name}`, label: ATTENTION_LABEL.failed_check, detail: ch.message, tone: 'amber' })
    const odd = [
      ...[...checks.values()].map((ch, i) => ({ id: `check:${i}`, label: 'Needs review', detail: ch.message, tone: 'amber' as const })),
      ...attention,
      // S1 anomalies: duplicate charges, price increases, billed twice, large expenses, missed payments (warnings first).
      // Titles and details may carry counterparty names: third-party text, rendered as plain text only.
      ...(await started.anomalies).map((a) => ({ id: a.id, label: a.title, detail: a.detail, tone: a.severity === 'warn' ? ('amber' as const) : ('grey' as const), recordIds: a.recordIds })),
    ]

    // Recurring revenue: one quiet line when the company has subscriptions (MRR 'no_data' hides it).
    const mrr = await started.mrr
    const lock = ((await started.locks) ?? []).find((l) => l.entityId === entity.id)
    return c.json({
      entity: { id: entity.id, kind: entity.kind, name: entity.name, currency, cash: cashValue, ...(setAside ? { setAside } : {}), hidden: await personalHidden(s.db, ws, entity, p.personId) },
      asOf: now.toISOString(),
      cash: cashAnswer ? explained('Cash', cashAnswer) : null,
      runway: runwayAnswer ? { months: runwayAnswer.state !== 'unknown' && typeof runwayAnswer.value === 'number' ? runwayAnswer.value : null, state: ov?.runwayState ?? runwayAnswer.state ?? 'no_data', explained: runwayExplained(runwayAnswer) } : null,
      trend,
      accounts: accountRows,
      owedToYou,
      bills,
      buckets,
      payroll: payrollOf(drawer?.payroll ?? null, await started.payrollCost, today),
      equity,
      whoseMoney,
      odd,
      hasTransactions: seeTxns && available.has('transactions'),
      periodLock: lock ? { through: lock.through, note: lock.note } : null,
      mrr,
      canClosePeriod: await started.canClose,
      // For owners (who may delete a company): null when it can go, else what to remove first (delete-company.ts).
      // `deletable` stays until the web reads deleteBlocked.
      ...(await (async () => {
        if (entity.kind !== 'company' || !(await isWorkspaceOwner(s.db, ws, p.personId))) return { deletable: false }
        const deleteBlocked = await companyNotEmpty(s.db, ws, entity.id)
        return { deleteBlocked, deletable: deleteBlocked === null }
      })()),
      ...holdingsOf(await started.holdings),
    })
  })

  // ---------- GET /api/entities/:id/mrr?months=12 → MrrMovementView[] (newest last) ----------
  app.get('/entities/:id/mrr', async (c) => {
    const { scope, can } = await entityCtx(c)
    if (!(await can('view', 'transactions'))) reply(403, { message: "You can't see this company's revenue." })
    const r = reader()
    if (!r.mrrMovements) return c.json([])
    const months = Math.min(24, Math.max(1, Number(c.req.query('months')) || 12))
    const to = lastCompleteMonth(await workspaceToday(s, scope.workspaceId, new Date()))
    return c.json((await safe(() => r.mrrMovements!(scope, addMonths(to, -(months - 1)), to))) ?? [])
  })

  // ---------- POST /api/entities/:id/period {action:'close', through, note?} | {action:'reopen'} ----------
  // Owners and admins close a company's books through a date; through S7's pipeline so it's logged and undoable.
  app.post('/entities/:id/period', async (c) => {
    const { ws, p, entity } = await entityCtx(c)
    if (entity.kind !== 'company') reply(400, { message: 'Only a company’s books can be closed.' })
    if (!(await s.permissions.canManageWorkspace(ws, p.personId))) reply(403, { message: 'Only an owner or admin can close or reopen the books.' })
    const pipeline = (s.mcp as { pipeline?: { submit: (w: Record<string, unknown>) => Promise<{ status: string; recordId?: string; message?: string; summary?: string }> } } | undefined)?.pipeline
    if (!pipeline) reply(503, { message: 'Closing the books needs the AI connection module on this server.' })
    const b = (await c.req.json().catch(() => ({}))) as { action?: string; through?: string; note?: string; idempotencyKey?: string }
    const key = typeof b.idempotencyKey === 'string' ? b.idempotencyKey : ''
    let payload: Record<string, unknown>
    if (b.action === 'close') {
      const today = await workspaceToday(s, ws, new Date())
      if (!b.through || !/^\d{4}-\d{2}-\d{2}$/.test(b.through)) reply(400, { message: 'Pick the last day to close.' })
      if (b.through >= today) reply(400, { message: 'Close a day before today.' })
      payload = { through: b.through, ...(b.note?.trim() ? { note: b.note.trim().slice(0, 200) } : {}) }
    } else if (b.action === 'reopen') payload = {}
    else reply(400, { message: 'Say close or reopen.' })
    const actor = { kind: 'person', workspaceId: ws, personId: p.personId, label: p.name || p.email }
    const r = await pipeline.submit({ actor, origin: 'ui', op: b.action === 'close' ? 'close_period' : 'reopen_period', entityId: entity.id, dataType: 'transactions', payload: payload!, idempotencyKey: key }).catch((e: unknown) => {
      if (e instanceof ToolError) reply(e.code === 'forbidden' ? 403 : 422, { error: e.code, message: e.message })
      throw e
    })
    if (r.status === 'rejected') reply(422, { message: r.message ?? 'That wasn’t saved.' })
    return c.json({ status: r.status, ...(r.recordId ? { recordId: r.recordId } : {}), summary: r.summary ?? r.message ?? '' })
  })

  // ---------- GET /api/entities/:id/transactions?q= → TxnRow[] ----------
  app.get('/entities/:id/transactions', async (c) => {
    const { scope, can } = await entityCtx(c)
    if (!(await can('view', 'transactions'))) reply(403, { message: "You can't see this company's transactions." })
    const q = (c.req.query('q') ?? '').trim().slice(0, 200)
    const r = reader()
    const res = await safe(() => r.searchTransactions(scope, { ...(q ? { text: q } : {}), limit: 100 }))
    if (!res) return c.json([])
    const all = (await safe(() => r.accounts(scope, { includeClosed: true }))) ?? []
    const accounts = new Map(all.map((a) => [a.id, a.name]))
    const institutions = new Map(all.map((a) => [a.id, a.institution ?? '']))
    const p = c.get('person')
    const companies = new Map((await s.permissions.entitiesFor(scope.workspaceId, p.personId)).map((e) => [e.id, e.name]))
    const names: RoleNames = { entity: (id) => companies.get(id), account: (id) => accounts.get(id) }
    return c.json(
      res.rows.map((t) => ({
        id: t.id,
        date: t.date,
        // The counterparty is cleaned text; the raw memo stays out of the UI list.
        // A payout reads "Stripe payout" on both legs (the bank's counterparty "Stripe" and the processor's own leg).
        description:
          t.kind === 'payout'
            ? describeWithout(t, t.counterparty ?? ((t.accountId && institutions.get(t.accountId)) || ''))
            : (t.counterparty ?? describeWithout(t, (t.accountId && institutions.get(t.accountId)) || '')),
        amount: t.amount,
        account: (t.accountId && accounts.get(t.accountId)) || '',
        detail: [categoryLabel(t.category, names), t.status === 'pending' ? 'pending' : '', t.needsReview ? 'needs review' : ''].filter(Boolean).join(' · '),
        ...(t.addedBy.kind !== 'sync' ? { addedBy: t.addedBy.name } : {}),
        kind: t.kind === 'transfer' ? 'transfer' : 'normal',
      })),
    )
  })

  // ---------- POST /api/entities/:id/payroll-register (CSV) ----------
  // Body: multipart/form-data {file, currency?, provider?, dateOrder?, decimal?}, or text/csv with ?currency= etc.
  app.post('/entities/:id/payroll-register', async (c) => {
    const { ws, entity, can, currency } = await entityCtx(c)
    if (!(await can('add', 'payroll'))) reply(403, { message: "You can't add payroll for this company." })
    const type = c.req.header('content-type') ?? ''
    let csv: string
    let fields: Record<string, string> = {}
    if (type.startsWith('multipart/form-data')) {
      const form = await c.req.formData()
      const file = form.get('file')
      if (!file || typeof file === 'string') reply(400, { message: 'Attach the payroll register as a CSV file.' })
      if (file.size > MAX_REGISTER_BYTES) reply(413, { message: 'That file is too large (2 MB max).' })
      csv = await file.text()
      for (const k of ['currency', 'provider', 'dateOrder', 'decimal']) {
        const v = form.get(k)
        if (typeof v === 'string' && v) fields[k] = v
      }
    } else if (type.startsWith('text/csv') || type.startsWith('text/plain')) {
      csv = await c.req.text()
      if (csv.length > MAX_REGISTER_BYTES) reply(413, { message: 'That file is too large (2 MB max).' })
      fields = Object.fromEntries(['currency', 'provider', 'dateOrder', 'decimal'].flatMap((k) => (c.req.query(k) ? [[k, c.req.query(k) as string]] : [])))
    } else reply(415, { message: 'Send the payroll register as a CSV file.' })

    const cur = (fields.currency ?? currency).toUpperCase()
    if (!/^[A-Z]{3}$/.test(cur)) reply(400, { message: 'currency must be a 3-letter code.' })
    if (fields.dateOrder && fields.dateOrder !== 'mdy' && fields.dateOrder !== 'dmy') reply(400, { message: 'dateOrder is mdy or dmy.' })
    if (fields.decimal && fields.decimal !== '.' && fields.decimal !== ',') reply(400, { message: 'decimal is "." or ",".' })
    try {
      const res = await financeFor(s).books.ingestRegister(ws, entity.id, csv, {
        currency: cur,
        ...(fields.provider ? { provider: fields.provider.slice(0, 60) } : {}),
        ...(fields.dateOrder ? { dateOrder: fields.dateOrder as 'mdy' | 'dmy' } : {}),
        ...(fields.decimal ? { decimal: fields.decimal as '.' | ',' } : {}),
      })
      return c.json(res, res.runs > 0 ? 201 : 200)
    } catch (e) {
      if (e instanceof RegisterError) reply(422, { message: e.message })
      throw e
    }
  })

  return app
}

const ATTENTION_LABEL: Record<NonNullable<Awaited<ReturnType<FinanceReader['overview']>>>['attention'][number]['kind'], string> = {
  overdue_invoice: 'Overdue invoice',
  low_runway: 'Low runway',
  failed_check: 'Numbers don’t add up',
  stale_source: 'Connection not updating',
  needs_review: 'Waiting for review',
  large_change: 'Large change',
  suspicious_text: 'Suspicious text in a document',
}

function addDays(d: string, n: number): string {
  return new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10)
}

/** 12 month-end cash points, oldest first (the current month is "today"). Empty when history isn't available. */
export async function cashTrend(s: S, r: FinanceReader, ws: string, entityId: string, now: Date): Promise<number[]> {
  // Month ends and "today" on the workspace's own calendar (just after midnight UTC is still yesterday in New York).
  const today = await workspaceToday(s, ws, now)
  const [y, m] = today.split('-').map(Number) as [number, number]
  const ends: string[] = []
  for (let i = 11; i >= 1; i--) ends.push(new Date(Date.UTC(y, m - 1 - i + 1, 0)).toISOString().slice(0, 10))
  ends.push(today)
  // S1's one-pass history when the ledger has it (one read of balances and lines instead of twelve metric runs).
  const ledger = s.ledger as { cashHistory?: (ws: string, o: { entityIds: string[]; days: string[] }) => Promise<Array<Money | null>> }
  if (ledger.cashHistory) {
    const days = await ledger.cashHistory(ws, { entityIds: [entityId], days: ends }).catch(() => null)
    // A month before the company's cash is known is left out, never drawn as $0 (that would show a climb from nothing).
    // A gap after the first known month means no trend at all rather than a false dip.
    if (days) {
      const first = days.findIndex((m) => m !== null)
      const known = first < 0 ? [] : days.slice(first)
      return known.some((m) => !m) ? [] : known.map((m) => major(m!))
    }
  }
  const answers = await Promise.all(ends.map((to) => safe(() => r.metric('cash', { workspaceId: ws, entityIds: [entityId], to }))))
  if (answers.some((a) => !a)) return []
  return answers.map((a) => (a && a.value && typeof a.value === 'object' ? major(a.value as Money) : 0))
}

interface AnomalyRow {
  id: string
  entityId: string
  title: string
  detail: string
  severity: 'info' | 'warn'
  recordIds: string[]
}

/** S1's "anything odd" finder (engine.anomalies), when the ledger has it. Not in the FinanceReader contract yet. */
async function anomaliesOf(s: S, scope: ReadScope): Promise<AnomalyRow[]> {
  const ledger = s.ledger as { anomalies?: (ws: string, o: { entityIds: string[] }) => Promise<AnomalyRow[]> }
  if (!ledger.anomalies) return []
  const list = await ledger.anomalies(scope.workspaceId, { entityIds: scope.entityIds }).catch(() => [] as AnomalyRow[])
  return list.filter((a) => scope.entityIds.includes(a.entityId)).slice(0, 10)
}

/** Names for a role's parameter: a company the person can see, or an account. */
export interface RoleNames {
  entity?: (id: string) => string | undefined
  account?: (id: string) => string | undefined
}

/**
 * Ledger role keys ("clearing_payouts") as people read them ("Payouts in transit"), including the ones that name a
 * company or an account ("due_to:<id>" → "Owed to Brightline Studio", core's chart of accounts wording); custom
 * categories keep their names. A company the person can't see is "another company", never its id.
 */
export function categoryLabel(key: string | undefined, names: RoleNames = {}): string {
  if (!key) return ''
  if (isFixedRole(key)) return defineRole(key).name
  const m = /^(cash|processor|card|loan|due_from|due_to|owner_payable|investment):(.+)$/.exec(key)
  if (m) {
    const [, kind, param] = m as unknown as [string, string, string]
    const byEntity = kind === 'due_from' || kind === 'due_to' || kind === 'owner_payable'
    const name = byEntity ? (names.entity?.(param) ?? 'another company') : (names.account?.(param) ?? 'an account')
    return defineRole(key as never, byEntity ? { entityName: name } : { sourceAccountName: name }).name
  }
  return key.includes('_') && /^[a-z_]+$/.test(key) ? key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : key
}

/** A row without a counterparty (payouts, card-sales batches, fees) is named by what it is and where it came from. */
export function describeWithout(t: { kind?: string }, provider: string): string {
  const p = provider.trim()
  switch (t.kind) {
    case 'transfer':
      return 'Transfer'
    case 'payout':
      return p ? `${p} payout` : 'Payout'
    case 'revenue':
      return 'Card sales'
    case 'fee':
      return p ? `${p} fees` : 'Fees'
    case 'card_payment':
      return 'Card payment'
    case 'refund':
      return 'Refund'
    case 'payroll':
      return 'Payroll'
    case 'tax':
      return 'Tax'
    default:
      return 'Transaction'
  }
}

/** 'YYYY-MM' of the last finished calendar month before `today` (a workspace-local day), as the metrics count it. */
export function lastCompleteMonth(today: Date | string): string {
  return trailingMonths(typeof today === 'string' ? today : today.toISOString().slice(0, 10), 1)[0]!.from.slice(0, 7)
}

/** Today in the workspace's own time zone (the day metrics use), not UTC. */
export async function workspaceToday(s: S, ws: string, now: Date): Promise<string> {
  const row = await s.db.selectFrom('workspaces').select('time_zone').where('id', '=', ws).executeTakeFirst()
  return localDate(now.toISOString(), row?.time_zone ?? DEFAULT_TIME_ZONE)
}
function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7)
}

/** MRR now, plus net new MRR and churn for the last finished month; each part says why when it isn't known. */
async function mrrSummary(r: FinanceReader, ws: string, entityId: string, today: string) {
  const scope = { workspaceId: ws, entityIds: [entityId] }
  const m = await safe(() => r.metric('mrr', scope))
  if (!m || m.state === 'no_data' || !m.value || typeof m.value !== 'object') return null
  const part = async (key: 'net_new_mrr' | 'mrr_churn_rate') => {
    const a = await safe(() => r.metric(key, scope))
    if (!a) return null
    if (a.state === 'unknown' || a.value == null) return { reason: a.unknownReason ?? 'Not known yet.' }
    return { value: a.value }
  }
  const [netNew, churn] = await Promise.all([part('net_new_mrr'), part('mrr_churn_rate')])
  const value = m.value as Money
  // No recurring revenue and nothing moved: no line at all ("+$0 net new · 0% churn" says nothing).
  const moved = netNew && 'value' in netNew && typeof netNew.value === 'object' && netNew.value !== null && (netNew.value as Money).minor !== 0
  if (value.minor === 0 && !moved) return null
  return { value, month: lastCompleteMonth(today), netNew, churn }
}

/** The books' payroll section with its total swapped for payroll_cost's: one month, the one the metric counts. */
function payrollOf<P extends { last3Months?: Money }>(p: P | null, cost: MetricAnswer | null, today: string): (Omit<P, 'last3Months'> & { lastMonth: { month: string; amount: Money | null } }) | null {
  if (!p) return null
  const { last3Months: _dropped, ...rest } = p
  const amount = cost && cost.state !== 'unknown' && cost.value && typeof cost.value === 'object' ? (cost.value as Money) : null
  return { ...rest, lastMonth: { month: lastCompleteMonth(today), amount } }
}

/** The rows and a total per currency, never added across currencies: the rule get_holdings totals by. */
export function holdingsOf(rows: HoldingView[] | null): { holdings: ReturnType<typeof holdingRows>; holdingsTotal: Money[] } {
  const by = new Map<string, number>()
  for (const h of rows ?? []) by.set(h.value.currency, (by.get(h.value.currency) ?? 0) + h.value.minor)
  return { holdings: holdingRows(rows), holdingsTotal: [...by].map(([currency, minor]) => ({ minor, currency })) }
}

/** Investment positions as the drawer lists them (null when there are none). */
export function holdingRows(rows: HoldingView[] | null): Array<{ id: string; name: string; detail: string; quantity: string; value: Money; account: string }> | null {
  if (!rows?.length) return null
  return rows.map((h) => ({ id: `${h.securityId}:${h.accountId}`, name: h.ticker ?? h.name ?? 'Unnamed security', detail: h.ticker ? (h.name ?? '') : '', quantity: h.quantity, value: h.value, account: h.accountName }))
}
