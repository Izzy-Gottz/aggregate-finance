// In-memory AgfnApi over the demo workspace. Behaves like the server would for the UI's purposes:
// writes return WriteResult, review items disappear when resolved, grants update the control sentence.

import { HttpError } from './http.ts'
import type { DataType, GrantShape, WriteResult } from '@agfn/contracts'
import { CONNECTORS, demoState, type DemoState } from './mock-data.ts'
import { gridFor } from '../lib/roles.ts'
import { shortDate } from '../lib/time.ts'
import { withOwnPersonal } from '../lib/grant.ts'
import { equityDetail, fullyDiluted, holders, importCapTableCsv, importOcf, parsePayload, planWrite, possibleDuplicates, replay, type EquityObject } from '@agfn/equity/math'
import { demoCapTable } from './mock-equity.ts'
import { positionsFrom, type InvestmentInput, type InvestmentTotals, type InvestmentView } from '../lib/investments.ts'
import type { EquityImportResult, EquityWritePayloadInput, EquityWriteResult } from './types.ts'
import type { AiSummary, BucketDetail, CompanyDetail, Connector, ConnectorSetup, MappingQuestion, MappingReply, EntitySummary, AgfnApi, PersonRow, Preferences, Workspace } from './types.ts'

const clone = <T>(x: T): T => structuredClone(x)

const app = (key: string, register: { name: string; url: string }, env: string[]) => ({
  configured: false,
  kind: 'app' as const,
  register,
  redirectUri: `https://money.example.com/api/connectors/${key}/callback`,
  env,
  docsUrl: `https://aggregate.finance/docs/self-host/${key}`,
})
const SELF_HOST_SETUP: Record<string, ConnectorSetup> = {
  quickbooks: app('quickbooks', { name: 'Intuit Developer', url: 'https://developer.intuit.com/app/developer/dashboard' }, ['QUICKBOOKS_CLIENT_ID', 'QUICKBOOKS_CLIENT_SECRET']),
  xero: app('xero', { name: 'Xero Developer', url: 'https://developer.xero.com/app/manage' }, ['XERO_CLIENT_ID', 'XERO_CLIENT_SECRET']),
  plaid: { ...app('plaid', { name: 'Plaid', url: 'https://dashboard.plaid.com/signup' }, ['PLAID_CLIENT_ID', 'PLAID_SECRET']), redirectUri: 'https://money.example.com/connect/plaid/oauth' },
}

export interface MockOptions {
  now?: number
  signedIn?: boolean
  /** Start with no companies (onboarding). */
  empty?: boolean
  /** Simulated latency in ms (0 in tests). */
  latency?: number
  /** A self-hosted server with no developer apps set up: QuickBooks, Xero and Plaid need their own keys. */
  selfHost?: boolean
}

export class MockApi implements AgfnApi {
  s: DemoState
  /** Cap-table objects per company; writes are grouped so undo removes a whole write. */
  equityObjects: Record<string, Array<{ writeId: string; o: EquityObject }>> = {}
  private nowMs: number | undefined
  private latency: number
  private seq = 0
  private selfHost = false

  constructor(o: MockOptions = {}) {
    this.nowMs = o.now
    this.s = demoState(o.now, { signedIn: o.signedIn ?? true, empty: o.empty ?? false })
    this.latency = o.latency ?? 0
    this.selfHost = !!o.selfHost
    if (!o.empty) this.equityObjects.e_acme = demoCapTable().map((x) => ({ writeId: 'seed', o: x }))
  }

  private eqObjects(entityId: string): EquityObject[] {
    return (this.equityObjects[entityId] ?? []).map((x) => x.o)
  }
  private today(): string {
    return new Date().toISOString().slice(0, 10)
  }
  /** The drawer's Equity section summary, from the same replay the full view uses. */
  private equitySummary(entityId: string) {
    const objs = this.eqObjects(entityId)
    if (!objs.length) return null
    const st = replay(objs, this.today())
    const fd = fullyDiluted(st)
    return {
      fullyDilutedShares: fd.total,
      holders: holders(st).slice(0, 4).map((h) => ({ name: h.name, role: h.stakeholderId === null ? 'not yet granted' : (h.relationship ? h.relationship[0] + h.relationship.slice(1).toLowerCase().replace('_', ' ') : ''), percent: h.fullyDilutedPct })),
      convertibles: st.convertibles.map((c) => ({ id: c.securityId, investor: st.stakeholders.find((x) => x.id === c.stakeholderId)?.name ?? '', kind: c.kind === 'SAFE' ? ('SAFE' as const) : ('Note' as const), amount: c.amount, ...(c.valuationCap ? { cap: c.valuationCap } : {}), ...(c.discountPct ? { discountPct: c.discountPct } : {}), date: c.date })),
    }
  }

  /** Whole dollars as money, for the fixtures below. */
  private static usd = (d: number) => ({ minor: d * 100, currency: 'USD' })
  /** Investment events per entity (the demo's own; the server keeps real ones). Personal starts with an angel's four. */
  investmentEvents: Record<string, Array<InvestmentInput & { positionId: string; recordId: string }>> = {
    e_personal: [
      { kind: 'invest', positionId: 'pos_lumen', recordId: 'iv1', issuer: 'Lumen Health', securityType: 'safe', date: '2024-03-14', amount: MockApi.usd(25_000), valuationCap: MockApi.usd(8_000_000), discountPct: 20 },
      { kind: 'mark', positionId: 'pos_lumen', recordId: 'iv2', issuer: 'Lumen Health', securityType: 'safe', date: '2026-06-30', amount: MockApi.usd(60_000), markSource: 'Series A price' },
      { kind: 'invest', positionId: 'pos_field', recordId: 'iv3', issuer: 'Fieldwork', securityType: 'preferred_stock', series: 'Seed', date: '2023-09-01', amount: MockApi.usd(50_000), shares: 40_000 },
      { kind: 'exit', positionId: 'pos_field', recordId: 'iv4', issuer: 'Fieldwork', securityType: 'preferred_stock', date: '2026-02-10', amount: MockApi.usd(140_000) },
      { kind: 'invest', positionId: 'pos_tide', recordId: 'iv5', issuer: 'Tidepool', securityType: 'convertible_note', date: '2022-05-01', amount: MockApi.usd(15_000) },
      { kind: 'write_off', positionId: 'pos_tide', recordId: 'iv6', issuer: 'Tidepool', securityType: 'convertible_note', date: '2025-11-20' },
      { kind: 'invest', positionId: 'pos_north', recordId: 'iv7', issuer: 'Northbeam', securityType: 'preferred_stock', series: 'Series A', date: '2025-01-15', amount: MockApi.usd(100_000), shares: 50_000 },
    ],
  }
  async investments(entityId: string) {
    this.entity(entityId)
    const positions = positionsFrom(entityId, this.investmentEvents[entityId] ?? [], this.today())
    return this.ok({ positions, totals: mockTotals(entityId, positions) })
  }
  async recordInvestment(entityId: string, input: InvestmentInput) {
    this.entity(entityId)
    const positionId = input.positionId ?? this.id('pos')
    // As the server refuses it: a position has one currency, its first invest's.
    const held = (this.investmentEvents[entityId] ?? []).find((e) => e.positionId === positionId && e.kind === 'invest' && e.amount)?.amount?.currency
    if (held && input.amount && input.amount.currency !== held) throw new HttpError(422, `${input.issuer} is held in ${held}; this amount is in ${input.amount.currency}. Record it in ${held}.`)
    const recordId = this.id('iv')
    ;(this.investmentEvents[entityId] ??= []).push({ ...input, positionId, recordId })
    return this.ok({ positionId, status: 'applied', recordId })
  }

  equity(entityId: string) {
    this.entity(entityId)
    return this.ok(equityDetail(entityId, replay(this.eqObjects(entityId), this.today())))
  }
  async recordEquity(entityId: string, payload: EquityWritePayloadInput): Promise<EquityWriteResult> {
    const e = this.entity(entityId)
    if (e.kind !== 'company') throw new Error('Only companies have a cap table.')
    const existing = this.eqObjects(entityId)
    const { objects, summary } = planWrite(replay(existing), existing, parsePayload(payload as unknown as Record<string, unknown>))
    const writeId = this.id('eqw')
    ;(this.equityObjects[entityId] ??= []).push(...objects.map((o) => ({ writeId, o })))
    return this.ok({ recordId: writeId, summary, possibleDuplicates: possibleDuplicates(existing, objects) })
  }
  async importEquity(entityId: string, file: File): Promise<EquityImportResult> {
    const text = await file.text()
    const existing = this.eqObjects(entityId)
    const r = /\.json$/i.test(file.name) || text.trimStart().startsWith('{') || text.trimStart().startsWith('[') ? importOcf(JSON.parse(text)) : importCapTableCsv(text, { existing, idPrefix: this.id('csv') })
    const have = new Set(existing.map((o) => o.id))
    const fresh = r.objects.filter((o) => !have.has(o.id))
    if (fresh.length < r.objects.length) r.notes.push(`${r.objects.length - fresh.length} items were already on the cap table and skipped.`)
    const writeId = fresh.length ? this.id('eqw') : null
    if (writeId) (this.equityObjects[entityId] ??= []).push(...fresh.map((o) => ({ writeId, o })))
    return this.ok({ writeId, added: fresh.length, notes: r.notes, warnings: replay(this.eqObjects(entityId)).warnings })
  }
  ocfExportUrl(entityId: string) {
    return `/api/entities/${entityId}/equity/ocf`
  }

  private async ok<T>(v: T): Promise<T> {
    if (this.latency) await new Promise((r) => setTimeout(r, this.latency))
    return clone(v)
  }
  private id(p: string) {
    return `${p}_${++this.seq}`
  }
  private entity(id: string): EntitySummary {
    const e = this.s.entities.find((x) => x.id === id)
    if (!e) throw new Error(`No company ${id}`)
    return e
  }

  me() {
    return this.ok(this.s.signedIn ? { ...this.s.me, needsOnboarding: this.s.entities.length === 0 } : null)
  }
  async signIn(method: string, email?: string) {
    if (method === 'email' && (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) {
      return this.ok({ ok: false as const, message: 'That doesn’t look like an email address.' })
    }
    this.s.signedIn = true
    return this.ok({ ok: true as const })
  }
  async signOut() {
    this.s.signedIn = false
  }

  consentInfo(p: { clientId: string; clientName?: string; scope: string }) {
    return this.ok({
      clientName: p.clientName ?? (p.clientId === 'chatgpt' ? 'ChatGPT' : 'Claude'),
      shape: { entityIds: 'all' as const, dataTypes: withOwnPersonal(['balances', 'transactions', 'invoices', 'bills', 'buckets', 'reports'], this.s.entities), write: p.scope.includes('write'), reviewMode: this.s.prefs.aiReviewMode ? ('review_all' as const) : ('instant' as const), expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString() },
      allowedEntityIds: 'all' as const,
    })
  }
  async decline(_i: { oauthQuery: string }) {
    return this.ok({ redirectTo: null })
  }
  async consent(i: { clientId: string; clientName: string; shape: GrantShape }) {
    {
      this.s.ais.push({ grantId: this.id('g'), client: i.clientName, personName: this.s.me.name.split(' ')[0] ?? '', shape: clone(i.shape), lastUsedAt: null, paused: false, connectedAt: new Date().toISOString(), via: 'claude.ai', activity: [] })
    }
    return this.ok({ redirectTo: null })
  }

  workspace(): Promise<Workspace> {
    return this.ok({
      me: this.s.me,
      entities: this.s.entities,
      connections: this.s.connections,
      suggested: this.s.entities.length ? CONNECTORS.filter((c) => c.key === 'quickbooks' && !this.s.connections.some((x) => x.connectorKey === c.key)) : [],
      ais: this.s.ais.map(({ activity: _a, connectedAt: _c, via: _v, ...rest }) => rest),
      aiPaused: this.s.aiPaused,
      inbound: this.s.entities.filter((e) => e.kind === 'company').map((e) => ({ entityId: e.id, address: `${e.name.toLowerCase().replace(/[^a-z0-9]+/g, '')}@in.example` })),
      reviewCount: this.s.review.length,
      reviewModeOn: this.s.prefs.aiReviewMode,
      health: this.health(),
    })
  }

  private health(): Workspace['health'] {
    if (!this.s.entities.length) return null
    const acme = this.s.entities.find((e) => e.kind === 'company')
    const items: NonNullable<Workspace['health']>['items'] = this.s.review.slice(0, 3).map((r) => ({ kind: 'review', entityId: null, text: r.title, refId: r.id }))
    if (acme && this.s.connections.length) items.push({ kind: 'in_transit', entityId: acme.id, text: '$4,200.00 left Mercury on Oct 1 and wasn’t seen arriving', refId: null })
    if (!items.length) return { status: 'ok', line: 'All reconciled', items: [] }
    const review = items.filter((i) => i.kind === 'review').length
    const parts = [review ? `${review} to review` : '', items.length - review ? `${items.length - review} transfer not seen arriving` : ''].filter(Boolean)
    return { status: 'needs_review', line: `${items.length} ${items.length === 1 ? 'thing needs' : 'things need'} a look: ${parts.join(', ')}`, items }
  }

  /** As the server: a company can go once nothing is connected to it (the mock drops a disconnected one); else which to disconnect. */
  private deleteBlocked(id: string): string | null {
    const e = this.entity(id)
    if (e.kind !== 'company') return null
    const live = this.s.connections.filter((x) => x.entityNames.includes(e.name))
    return live.length ? `Disconnect ${live.map((x) => x.name).join(', ')} first.` : null
  }

  company(id: string): Promise<CompanyDetail> {
    const c0 = this.s.companies[id]
    const c = c0 ? { ...c0, equity: this.equitySummary(id) } : undefined
    if (!c) {
      const e = this.entity(id)
      return this.ok({ entity: e, asOf: new Date().toISOString(), cash: null, runway: null, trend: [], accounts: [], owedToYou: null, bills: null, buckets: [], payroll: null, equity: this.equitySummary(id), whoseMoney: [], odd: [], hasTransactions: false, deleteBlocked: this.deleteBlocked(id) })
    }
    return this.ok({ ...c, deleteBlocked: this.deleteBlocked(id) })
  }

  searchTransactions(entityId: string, query: string) {
    const q = query.trim().toLowerCase()
    const rows = this.s.transactions[entityId] ?? []
    return this.ok(q ? rows.filter((r) => `${r.description} ${r.detail} ${r.account}`.toLowerCase().includes(q)) : rows)
  }

  createCompany(name: string, currency = 'USD') {
    const clean = name.trim()
    if (!clean) throw new Error('A company needs a name.')
    const e: EntitySummary = { id: this.id('e'), kind: 'company', name: clean, currency, cash: null, hidden: false }
    const personal = this.s.entities.findIndex((x) => x.kind === 'personal')
    if (personal === -1) this.s.entities.push(e)
    else this.s.entities.splice(personal, 0, e)
    this.s.prefs.companies.push({ id: e.id, name: e.name, currency, fiscalYearStartMonth: 1 })
    return this.ok(e)
  }

  async deleteCompany(id: string) {
    const e = this.s.entities.find((x) => x.id === id)
    if (!e || e.kind !== 'company') throw new Error('That company no longer exists.')
    if (this.s.companies[id] || this.s.connections.some((x) => x.entityNames.includes(e.name))) throw new Error(`${e.name} can’t be deleted: It still has a connection. Disconnect it first.`)
    this.s.entities = this.s.entities.filter((x) => x.id !== id)
    this.s.prefs.companies = this.s.prefs.companies.filter((x) => x.id !== id)
    return { ok: true as const, name: e.name }
  }

  /** True: the connect flows finish without the provider (there is no Plaid or OAuth behind the mock). */
  readonly simulated = true

  /** Their own company, named but empty, while they look around the demo (the server keeps both workspaces). */
  private beforeDemo: DemoState | null = null
  async startDemo() {
    const named = this.s.entities.length > 0 && this.s.connections.length === 0 && !this.s.me.demo
    if (named) this.beforeDemo = clone(this.s)
    const created = this.s.entities.length === 0 || named
    if (created) {
      const fresh = demoState(this.nowMs, { signedIn: true })
      Object.assign(this.s, fresh)
      this.equityObjects.e_acme = demoCapTable().map((x) => ({ writeId: 'seed', o: x }))
    }
    return this.ok({ workspaceId: this.s.me.workspaceId, created, entities: this.s.entities.map((e) => ({ id: e.id, name: e.name })) })
  }

  async signInMethods(): Promise<import('./types.ts').SignInMethod[]> {
    return ['passkey', 'apple', 'email']
  }
  async continueOAuthLogin(oauthQuery: string) {
    return `/#/connect-ai/consent?${oauthQuery}`
  }
  /** The mock's reviewer code is rev-123 (or a link ending in it); its account is reviewer-1@reviewers.aggregate.invalid. */
  async reviewerSignIn(code: string, email?: string) {
    if (code.trim().split('/').pop() !== 'rev-123' || (email !== undefined && email !== 'reviewer-1@reviewers.aggregate.invalid')) throw new HttpError(400, 'That access code isn’t valid. Paste it exactly as it was sent.', 'invalid_code')
    this.s.signedIn = true
    return this.ok({ ok: true as const })
  }
  /** Tests set this: the invite went to another address, so this account is offered to take it. */
  inviteClaim: { invitedEmail: string } | null = null
  accepted: string | null = null
  async inviteInfo(_id: string) {
    return this.ok({ workspaceId: this.s.me.workspaceId, workspaceName: 'Acme', inviterName: 'Sam Lee', ...(this.inviteClaim ? { claim: true, invitedEmail: this.inviteClaim.invitedEmail } : {}) })
  }
  async acceptInvite(id: string) {
    this.accepted = id
    this.inviteClaim = null
    return this.ok({ ok: true as const, workspaceId: this.s.me.workspaceId })
  }
  setWorkspace(_id: string) {}

  async deleteMe(confirm: string) {
    if (confirm.trim() !== 'DELETE') throw new Error('Type DELETE to confirm.')
    if (this.needsEmailRecheck) throw new HttpError(403, 'Confirm it’s you first.', 'recheck', { method: 'email' })
    this.s.signedIn = false
    return this.ok({ ok: true as const })
  }

  /** Tests set this: other members whose Personal connections would go. */
  affectedByDelete: Array<{ personId: string; name: string; email: string; personalConnections: number }> = []
  async deleteWorkspacePreview() {
    return this.ok({ affected: this.affectedByDelete })
  }
  async deleteWorkspace(confirm: string) {
    if (confirm.trim() !== 'DELETE') throw new Error('Type DELETE to confirm.')
    return this.leaveDemo()
  }

  async leaveDemo() {
    Object.assign(this.s, this.beforeDemo ?? demoState(this.nowMs, { signedIn: true, empty: true }))
    this.beforeDemo = null
    this.equityObjects = {}
    return this.ok({ ok: true as const })
  }

  async createWorkspace(companyName: string | null, currency = 'USD') {
    const c = companyName ? await this.createCompany(companyName, currency) : null
    // The owner sees their own Personal numbers; it stays private to everyone else.
    if (!this.s.entities.some((e) => e.kind === 'personal')) this.s.entities.push({ id: 'e_personal', kind: 'personal', name: 'Personal', currency, cash: null, hidden: false })
    return this.ok({ workspaceId: this.s.me.workspaceId, companyId: c?.id ?? null, personalId: 'e_personal' })
  }

  connectors() {
    if (!this.selfHost) return this.ok(CONNECTORS)
    return this.ok(CONNECTORS.map((c): Connector => (SELF_HOST_SETUP[c.key] ? { ...c, setup: SELF_HOST_SETUP[c.key]! } : c)))
  }
  startConnect(key: string) {
    const c = CONNECTORS.find((x) => x.key === key)
    if (!c) throw new Error(`Unknown connector ${key}`)
    switch (c.auth) {
      case 'link_widget':
        return this.ok({ kind: 'plaid_link' as const, linkToken: 'link-sandbox-demo', state: this.id('st') })
      case 'oauth':
        return this.ok({ kind: 'oauth' as const, url: `https://connect.example/${key}`, state: this.id('st') })
      case 'api_key':
        return this.ok({
          kind: 'api_key' as const,
          label: `${c.name} read-only token`,
          helpUrl: `https://${key}.example/settings/tokens`,
          placeholder: 'token_…',
          state: this.id('st'),
          ...(key === 'ramp' ? { fields: [{ name: 'clientId', label: 'Client ID' }, { name: 'clientSecret', label: 'Client secret', secret: true }, { name: 'env', label: 'Environment', options: ['live', 'sandbox'] }] } : {}),
        })
      default:
        return this.ok({ kind: 'upload' as const, accept: '.csv,.ofx,.qfx,.xml,.pdf', state: this.id('st') })
    }
  }
  lastFinish: Record<string, unknown> | null = null
  async finishConnect(key: string, input: Record<string, unknown> & { state: string }) {
    this.lastFinish = input
    const c = CONNECTORS.find((x) => x.key === key)!
    const id = this.id('c')
    this.s.connections.push({ id, connectorKey: key, name: key === 'plaid' ? 'Chase' : c.name, entityNames: [], status: 'syncing', lastSyncAt: null, accountCount: key === 'plaid' ? 3 : 1 })
    const first = this.s.entities.find((e) => e.kind === 'company')?.id ?? null
    const accounts =
      key === 'plaid'
        ? [
            { id: this.id('na'), name: 'Business Checking', mask: '4021', balance: { minor: 8_241_017, currency: 'USD' }, suggestedEntityId: first },
            { id: this.id('na'), name: 'Business Savings', mask: '7710', balance: { minor: 12_000_000, currency: 'USD' }, suggestedEntityId: first },
            { id: this.id('na'), name: 'Personal Checking', mask: '1188', balance: { minor: 620_400, currency: 'USD' }, suggestedEntityId: 'personal' as const },
          ]
        : [{ id: this.id('na'), name: `${c.name} balance`, balance: { minor: 1_488_000, currency: 'USD' }, suggestedEntityId: first }]
    return this.ok({ connectionId: id, accounts })
  }
  async assignAccounts(assignments: Array<{ accountId: string; entityId: string }>) {
    // An account already placed (the drawer's per-account move): it goes to the other company, nothing else changes.
    const moves = assignments.filter((a) => Object.values(this.s.companies).some((co) => co.accounts.some((x) => x.id === a.accountId)))
    if (moves.length) {
      for (const m of moves) {
        const to = m.entityId === 'personal' ? (this.s.entities.find((e) => e.kind === 'personal')?.id ?? '') : m.entityId
        const from = Object.values(this.s.companies).find((co) => co.accounts.some((x) => x.id === m.accountId))!
        const target = this.s.companies[to]
        if (!target || target === from) continue
        target.accounts.push(...from.accounts.filter((x) => x.id === m.accountId))
        from.accounts = from.accounts.filter((x) => x.id !== m.accountId)
      }
      return
    }
    const last = this.s.connections[this.s.connections.length - 1]
    if (last) {
      last.status = 'ok'
      last.lastSyncAt = new Date().toISOString()
      last.entityNames = [...new Set(assignments.filter((a) => a.entityId !== 'skip').map((a) => (a.entityId === 'personal' ? 'Personal' : this.entity(a.entityId).name)))]
    }
  }
  connection(id: string) {
    const c = this.s.connections.find((x) => x.id === id)
    if (!c) throw new Error(`No connection ${id}`)
    const accounts = Object.entries(this.s.companies).flatMap(([entityId, co]) => co.accounts.filter((a) => a.institution === c.name).map((a) => ({ ...a, entityId })))
    return this.ok({ ...c, accounts, provides: CONNECTORS.find((x) => x.key === c.connectorKey)?.provides ?? [], canRefreshBalance: c.connectorKey === 'plaid', ...(c.connectorKey === 'quickbooks' || c.connectorKey === 'wefunder' ? { erasesOnDisconnect: 'always' as const } : c.connectorKey === 'shopify' ? { erasesOnDisconnect: 'maybe' as const } : {}) })
  }
  /** Xero organisations shared with Aggregate before but not in this workspace yet. */
  xeroShared = [{ id: 'org-demo-us', name: 'Demo Company (US)' }]
  async sharedOffers(id: string) {
    const c = this.s.connections.find((x) => x.id === id)
    return c?.connectorKey === 'xero' ? this.xeroShared : []
  }
  async addShared(id: string, orgId: string) {
    const org = this.xeroShared.find((o) => o.id === orgId)
    if (!org) throw new Error('That organisation is no longer shared with Aggregate.')
    this.xeroShared = this.xeroShared.filter((o) => o !== org)
    const c = { id: `conn-${orgId}`, connectorKey: 'xero', name: `Xero · ${org.name}`, entityNames: [], status: 'syncing' as const, lastSyncAt: null, accountCount: 0 }
    this.s.connections.push(c)
    return { connectionId: c.id, name: c.name }
  }
  async setConnectionCompany(id: string, entityId: string) {
    const c = this.s.connections.find((x) => x.id === id)
    const e = this.s.entities.find((x) => x.id === entityId)
    if (!c || !e) throw new Error('That company was not found.')
    c.entityNames = [e.name]
    return { ok: true as const, moved: c.accountCount }
  }
  async reconnect(id: string, _accountSelection?: boolean): Promise<import('./types.ts').ReconnectStart> {
    const c = this.s.connections.find((x) => x.id === id)
    if (!c) throw new Error('That connection no longer exists.')
    return { kind: 'connect', connectorKey: c.connectorKey }
  }
  async finishReconnect(id: string) {
    const c = this.s.connections.find((x) => x.id === id)
    if (c) Object.assign(c, { status: 'ok', attention: undefined, message: undefined, lastSyncAt: new Date().toISOString() })
    return { ok: true }
  }
  async linkEvent() {
    return { ok: true }
  }
  async refreshBalance(_id: string): Promise<import('./types.ts').BalanceRefresh> {
    return { ok: true as const, live: true as const, at: new Date().toISOString() }
  }
  async syncNow(id: string) {
    const c = this.s.connections.find((x) => x.id === id)
    if (c) c.lastSyncAt = new Date().toISOString()
  }
  async disconnect(id: string) {
    this.s.connections = this.s.connections.filter((x) => x.id !== id)
  }

  bucket(id: string) {
    const b = this.s.buckets[id]
    if (!b) throw new Error(`No bucket ${id}`)
    return this.ok({ canSetAside: true, ...b })
  }
  createBucket(entityId: string, b: Parameters<AgfnApi['createBucket']>[1]) {
    const id = this.id('b')
    const d: BucketDetail = { id, entityId, name: b.name, fields: clone(b.fields), schedule: null, rules: [], payments: [], createdBy: { name: this.s.me.name, isAi: false, at: new Date().toISOString() }, undoUntil: new Date(Date.now() + 86_400_000).toISOString() }
    this.s.buckets[id] = d
    const c = this.s.companies[entityId]
    if (c) c.buckets.push({ id, name: b.name, line: b.fields.map((f) => (f.type === 'date' ? shortDate(f.value, true) : f.value)).filter(Boolean).slice(1).join(' · '), status: 'ok' })
    return this.ok(d)
  }
  updateBucket(id: string, patch: Parameters<AgfnApi['updateBucket']>[1]) {
    const b = this.s.buckets[id]
    if (!b) throw new Error(`No bucket ${id}`)
    const { setAside, ...rest } = clone(patch)
    Object.assign(b, rest)
    if (setAside === null) delete b.setAside
    else if (setAside) {
      const held = setAside.allocations.reduce((t, a) => t + (a.amount?.minor ?? 0), 0)
      const money = { minor: held, currency: 'USD' }
      const named = Object.values(this.s.companies).flatMap((c) => c.accounts)
      b.setAside = {
        countsInCash: setAside.countsInCash ?? true,
        held: money,
        perAccount: setAside.allocations.map((a) => ({ accountId: a.accountId, accountName: named.find((x) => x.id === a.accountId)?.name ?? 'Account', entityId: b.entityId, held: a.amount ?? money, heldBase: a.amount ?? money })),
        ...(setAside.goal ? { goal: { target: setAside.goal.amount, ...(setAside.goal.by ? { by: setAside.goal.by } : {}), progressPercent: Math.round((100 * held) / setAside.goal.amount.minor) } } : {}),
      }
    }
    for (const c of Object.values(this.s.companies)) {
      const row = c.buckets.find((x) => x.id === id)
      if (row && patch.name) row.name = patch.name
    }
    return this.ok(b)
  }
  async undo(recordId: string): Promise<WriteResult> {
    for (const k of Object.keys(this.equityObjects)) this.equityObjects[k] = this.equityObjects[k]!.filter((x) => x.writeId !== recordId)
    for (const ai of this.s.ais) for (const a of ai.activity) if (a.recordId === recordId) a.status = 'undone'
    for (const k of Object.keys(this.investmentEvents)) this.investmentEvents[k] = this.investmentEvents[k]!.filter((e) => e.recordId !== recordId)
    const b = this.s.buckets[recordId]
    if (b) {
      delete this.s.buckets[recordId]
      for (const c of Object.values(this.s.companies)) c.buckets = c.buckets.filter((x) => x.id !== recordId)
    }
    return this.ok({ status: 'applied', recordId, message: 'Undone.' })
  }

  ai(grantId: string) {
    const a = this.s.ais.find((x) => x.grantId === grantId)
    if (!a) throw new Error(`No AI ${grantId}`)
    return this.ok(a)
  }
  updateGrant(grantId: string, shape: GrantShape): Promise<AiSummary> {
    const a = this.s.ais.find((x) => x.grantId === grantId)
    if (!a) throw new Error(`No AI ${grantId}`)
    a.shape = clone(shape)
    const { activity: _a, connectedAt: _c, via: _v, ...rest } = a
    return this.ok(rest)
  }
  renameKey(grantId: string, name: string): Promise<AiSummary> {
    const a = this.s.ais.find((x) => x.grantId === grantId)
    if (!a) throw new Error(`No AI ${grantId}`)
    if (a.via !== 'key') throw new HttpError(400, 'Only keys can be renamed. An app keeps the name it signed in with.', 'bad_request')
    a.client = name
    const { activity: _a, connectedAt: _c, via: _v, ...rest } = a
    return this.ok(rest)
  }
  async pauseAi(grantId: string, paused: boolean) {
    const a = this.s.ais.find((x) => x.grantId === grantId)
    if (a) a.paused = paused
  }
  async revokeAi(grantId: string) {
    this.s.ais = this.s.ais.filter((x) => x.grantId !== grantId)
  }
  async pauseAll(paused: boolean) {
    this.s.aiPaused = paused
  }
  createKey(name: string, shape: GrantShape) {
    const grantId = this.id('g')
    this.s.ais.push({ grantId, client: name, personName: this.s.me.name.split(' ')[0] ?? '', shape, lastUsedAt: null, paused: false, connectedAt: new Date().toISOString(), via: 'key', activity: [] })
    return this.ok({ grantId, key: `mk_live_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}` })
  }
  latestActivity() {
    const all = this.s.ais.flatMap((a) => a.activity).sort((a, b) => b.at.localeCompare(a.at))
    return this.ok(all[0] ?? null)
  }

  review() {
    return this.ok(this.s.review)
  }
  async resolve(id: string): Promise<{ recordId?: string; summary?: string } | void> {
    this.s.review = this.s.review.filter((x) => x.id !== id && !x.alternatives?.some((a) => a.id === id))
  }
  /** Tests set this: what Aggregate filed by itself. */
  filed: Array<{ id: string; text: string; filedAt: string }> = []
  async reviewFiled() {
    return { count: this.filed.length, items: this.filed }
  }
  async undoFiled(id: string) {
    this.filed = this.filed.filter((x) => x.id !== id)
    return { ok: true as const }
  }
  async confirmGroup(key: string, ids: string[]) {
    const gone = this.s.review.filter((x) => x.group?.key === key && ids.includes(x.id))
    this.s.review = this.s.review.filter((x) => !gone.includes(x))
    return { ok: true as const, count: gone.length }
  }

  async preparePasskey() {
    return (name: string) => this.addPasskey(name)
  }
  async addPasskey(name: string) {
    this.s.prefs.signIn.passkeys.push({ id: this.id('pk'), name, addedAt: new Date().toISOString() })
    return true
  }
  async removePasskey(id: string) {
    this.s.prefs.signIn.passkeys = this.s.prefs.signIn.passkeys.filter((k) => k.id !== id)
  }

  preferences() {
    const owners = this.s.prefs.people.filter((x) => x.role === 'owner' && !x.pending)
    return this.ok({ ...this.s.prefs, canLeave: !(owners.length === 1 && owners[0]!.id === this.s.me.personId) })
  }
  updatePreferences(patch: Partial<Preferences>) {
    // A rename shows everywhere, as on the server (the entity is the same row).
    for (const c of patch.companies ?? []) {
      const e = this.s.entities.find((x) => x.id === c.id)
      if (e) e.name = c.name
    }
    Object.assign(this.s.prefs, clone(patch))
    return this.ok(this.s.prefs)
  }
  friendLink() {
    return this.ok({ link: 'https://app.aggregate.finance/?start=1&from=0123456789abcdef' })
  }
  inviteFriend(_email: string) {
    return this.ok({ ok: true as const })
  }
  invite(email: string, role: PersonRow['role'], entityIds: PersonRow['entityIds']) {
    const p: PersonRow = { id: this.id('p'), name: email.split('@')[0] ?? email, email, role, entityIds, grid: gridFor(role), pending: true }
    this.s.prefs.people.push(p)
    return this.ok(p)
  }
  updatePerson(id: string, patch: Partial<Pick<PersonRow, 'role' | 'entityIds' | 'grid'>>) {
    const p = this.s.prefs.people.find((x) => x.id === id)
    if (!p) throw new Error(`No person ${id}`)
    Object.assign(p, clone(patch))
    if (patch.role && !patch.grid) p.grid = gridFor(patch.role)
    return this.ok(p)
  }
  /** As the server: an owner only by an owner; the last owner can't go. */
  async removePerson(id: string) {
    const p = this.s.prefs.people.find((x) => x.id === id)
    if (!p) throw new HttpError(404, 'They’re not in this workspace.')
    if (p.role === 'owner' && this.s.prefs.people.filter((x) => x.role === 'owner' && !x.pending).length < 2) throw new HttpError(409, 'They’re the only owner. Make someone else an owner first.', 'last_owner')
    this.s.prefs.people = this.s.prefs.people.filter((x) => x.id !== id)
    return { ok: true as const }
  }
  async resendInvite(id: string) {
    const p = this.s.prefs.people.find((x) => x.id === id)
    if (!p?.pending) throw new HttpError(409, 'They’ve already joined.')
    return { ok: true as const, sentTo: p.email }
  }
  async leaveWorkspace() {
    const me = this.s.me.personId
    const owners = this.s.prefs.people.filter((x) => x.role === 'owner' && !x.pending)
    if (owners.length === 1 && owners[0]!.id === me) throw new HttpError(409, 'You’re the only owner. Make someone else an owner first, or delete the workspace.', 'last_owner')
    this.s.prefs.people = this.s.prefs.people.filter((x) => x.id !== me)
    // The mock has one workspace: after leaving it, nothing is left, so setup starts (needsOnboarding).
    this.s.entities = []
    return { ok: true as const }
  }
  exportAll(format?: 'json' | 'beancount' | 'hledger') {
    return this.ok({ url: format && format !== 'json' ? `/api/export/books.${format === 'beancount' ? 'beancount' : 'journal'}` : '/api/export/everything.zip' })
  }

  addCash(entry: Parameters<AgfnApi['addCash']>[0]): Promise<WriteResult> {
    if (entry.amount.minor <= 0) return this.ok({ status: 'rejected', message: 'Enter an amount above zero.' })
    const recordId = this.id('r')
    const signed = { ...entry.amount, minor: entry.direction === 'in' ? entry.amount.minor : -entry.amount.minor }
    const rows = (this.s.transactions[entry.entityId] ??= [])
    rows.unshift({ id: recordId, date: entry.date, description: entry.counterparty || (entry.direction === 'in' ? 'Cash in' : 'Cash out'), amount: signed, account: entry.paidBy === 'me' ? 'Paid personally' : 'Cash on hand', detail: 'added by you' })
    return this.ok({ status: 'applied', recordId, undoUntil: new Date(Date.now() + 30 * 86_400_000).toISOString() })
  }
  senders: Record<string, string[]> = {}
  refused: Record<string, Array<{ at: string; from: string; reason: string }>> = {}
  unread: import('./types.ts').UnreadDocument[] = []
  shares: import('./types.ts').ShareCard[] = []
  async shareCards() {
    return this.shares
  }
  async shareDraft(entityId: string, kind: import('./types.ts').ShareKind) {
    const id = this.id('share')
    this.shares.unshift({ id, kind, entityId, company: this.s.entities.find((e) => e.id === entityId)?.name ?? 'A company', status: 'draft', source: 'app', url: null, createdAt: new Date().toISOString(), publishedAt: null })
    return { id }
  }
  async sharePreview(_id: string, _opts: import('./types.ts').ShareOpts): Promise<import('./types.ts').SharePreview> {
    return { words: { big: '18', line: 'A company', alt: 'A company has 18 months of runway.' } }
  }
  sharePreviewUrl(_id: string, _query: string) {
    return '/og.png'
  }
  badgePreviewUrl(_id: string, _query: string) {
    return '/badge.svg'
  }
  async sharePublish(id: string, _opts: import('./types.ts').ShareOpts) {
    const c = this.shares.find((x) => x.id === id)
    if (!c || c.status !== 'draft') throw new Error('This card was not found.')
    Object.assign(c, { status: 'live', url: `${location.origin}/${c.kind === 'badge' ? 'b' : 'a'}/${id}`, publishedAt: new Date().toISOString() })
    return { url: c.url! }
  }
  async shareRevoke(id: string) {
    this.shares = this.shares.filter((x) => x.id !== id)
  }
  async unreadDocuments() {
    return this.unread
  }
  async deleteDocument(id: string) {
    const d = this.unread.find((x) => x.documentId === id) ?? this.waiting.find((x) => x.documentId === id)
    if (!d) throw new HttpError(404, 'That file no longer exists.')
    this.unread = this.unread.filter((x) => x.documentId !== id)
    this.waiting = this.waiting.filter((x) => x.documentId !== id)
    return { ok: true as const, name: d.name }
  }
  documentFileUrl(id: string) {
    return `#/doc/${id}`
  }
  async inboundSenders(entityId: string): Promise<import('./types.ts').InboundSettings> {
    const address = this.s.entities.find((e) => e.id === entityId)?.name.toLowerCase().replace(/[^a-z0-9]+/g, '') + '@in.example'
    const extra = this.senders[entityId] ?? []
    return { address, allowedSenders: extra, extra, members: [{ personId: this.s.me.personId, name: this.s.me.name, email: this.s.me.email }], recentRefused: this.refused[entityId] ?? [] }
  }
  async setInboundSenders(entityId: string, allowedSenders: string[]) {
    if (allowedSenders.some((x) => !/^(@?[a-z0-9.-]+\.[a-z]{2,}|[^\s@]+@[a-z0-9.-]+\.[a-z]{2,})$/.test(x))) throw new Error('List email addresses or domains (like @acme.com), up to 100.')
    this.senders[entityId] = allowedSenders
    return this.inboundSenders(entityId)
  }
  async mrrMovements(_entityId: string, months = 12) {
    const usd = (d: number) => ({ minor: d * 100, currency: 'USD' })
    const out: import('@agfn/contracts').MrrMovementView[] = []
    let start = 12_000
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(2026, 8 - i, 1))
      const nw = 1_000 + (i % 3) * 500, churn = 300 + (i % 2) * 200, exp = 200
      const end = start + nw + exp - churn
      out.push({ month: d.toISOString().slice(0, 7), start: usd(start), new: usd(nw), expansion: usd(exp), reactivation: usd(0), contraction: usd(0), churn: usd(churn), end: usd(end), customersStart: 40, customersEnd: 42, newCustomers: 3, churnedCustomers: 1, revenueChurnRate: churn / start, customerChurnRate: 1 / 40 })
      start = end
    }
    return out
  }
  async closePeriod(entityId: string, through: string, note?: string) {
    const c = this.s.companies[entityId]
    if (c) Object.assign(c, { periodLock: { through, note: note ?? null } })
    return { recordId: this.id('lock'), summary: `Books closed through ${through}` }
  }
  async reopenPeriod(entityId: string) {
    const c = this.s.companies[entityId]
    if (c) Object.assign(c, { periodLock: null })
    return { recordId: this.id('lock'), summary: 'Books reopened' }
  }
  waiting: import('./types.ts').WaitingStatement[] = []
  async waitingStatements() {
    return this.waiting
  }
  async chooseStatementAccount(documentId: string, _accountId: string) {
    this.waiting = this.waiting.filter((w) => w.documentId !== documentId)
    return { state: 'imported' as const, message: 'Imported 3 rows.' }
  }
  /** An unfamiliar CSV (any name with "export" in it): asks date → amount → date order → sign, then imports. */
  private mapping: Record<string, number> = {}
  private question(i: number): MappingQuestion {
    const headers = ['Posted', 'Details', 'Debit', 'Credit', 'Value']
    const sample = [['03/04/2026', 'Coffee', '4.50', '', '-4.50'], ['03/05/2026', 'Client payment', '', '1200.00', '1200.00'], ['03/09/2026', 'Rent', '2980.00', '', '-2980.00']]
    const cols = headers.map((h) => ({ value: h, label: h }))
    const qs: MappingQuestion[] = [
      { field: 'date', text: 'Which column is the date?', options: cols, headers, sample },
      { field: 'amount', text: 'Which column is the amount?', options: cols, headers, sample },
      { field: 'dateFormat', text: 'Is 03/04/2026 March 4 or April 3?', options: [{ value: 'MDY', label: 'March 4' }, { value: 'DMY', label: 'April 3' }], headers, sample },
      { field: 'sign', text: 'In this file, is a positive amount money you spent or money that came in?', options: [{ value: 'out', label: 'Money I spent' }, { value: 'in', label: 'Money that came in' }], headers, sample },
    ]
    return qs[i]!
  }
  /** Tests set this to make deletes ask for an emailed re-check first (a person with no passkey). */
  needsEmailRecheck = false
  /** The mock's emails always carry 123456. */
  async signInCode(code: string) {
    if (code !== '123456') throw new HttpError(400, 'That code isn’t right. 4 tries left.', 'wrong_code')
    this.s.signedIn = true
    return this.ok({ ok: true as const })
  }
  async recheckCode(code: string) {
    if (code !== '123456') throw new HttpError(400, 'That code isn’t right. 4 tries left.', 'wrong_code')
    return this.ok({ ok: true as const })
  }
  async recheckByEmail(_returnTo: string) {
    this.needsEmailRecheck = false
    return { ok: true as const, sentTo: this.s.me.email }
  }
  async answerMapping(documentId: string, _field: string, _value: string): Promise<MappingReply> {
    const i = (this.mapping[documentId] ?? 0) + 1
    this.mapping[documentId] = i
    if (i < 4) return { state: 'needs_mapping', message: this.question(i).text, question: this.question(i) }
    return { state: 'imported', message: 'Imported 3 rows.' }
  }
  upload(entityId: string, file: File) {
    if (/export.*\.csv$/i.test(file.name)) {
      const documentId = this.id('d')
      this.mapping[documentId] = 0
      return this.ok({ documentId, name: file.name, state: 'needs_mapping' as const, message: this.question(0).text, question: this.question(0) })
    }
    const structured = /\.(csv|ofx|qfx|xml)$/i.test(file.name)
    const accounts = this.s.companies[entityId]?.accounts ?? []
    if (/\.csv$/i.test(file.name) && accounts.length)
      return this.ok({
        documentId: this.id('d'),
        name: file.name,
        state: 'needs_account' as const,
        message: 'Which account is this statement for?',
        accounts: accounts.map((a) => ({ id: a.id, name: a.name, ...(a.mask ? { mask: a.mask } : {}), institution: a.institution })),
      })
    return this.ok({
      documentId: this.id('d'),
      name: file.name,
      state: structured ? ('imported' as const) : ('unread' as const),
      message: structured ? 'Imported. Duplicates were skipped.' : 'Saved. Ask your AI to read it: “Read my new documents in Aggregate.”',
    })
  }
}

/** The demo's stand-in for core's investmentTotals: per currency, never summed across them, the multiple to 2 places. */
function mockTotals(entityId: string, views: InvestmentView[]): InvestmentTotals[] {
  const by = new Map<string, InvestmentView[]>()
  for (const v of views) by.set(v.invested.currency, [...(by.get(v.invested.currency) ?? []), v])
  return [...by].map(([currency, vs]) => {
    const sum = (f: (v: InvestmentView) => number) => ({ minor: vs.reduce((t, v) => t + f(v), 0), currency })
    const known = vs.filter((v) => v.moic !== null)
    const cost = known.reduce((t, v) => t + v.invested.minor, 0)
    return {
      entityId,
      currency,
      positions: vs.length,
      active: vs.filter((v) => v.status === 'active').length,
      invested: sum((v) => v.invested.minor),
      value: sum((v) => v.value.minor),
      distributed: sum((v) => v.distributed.minor),
      writtenOff: sum((v) => (v.status === 'written_off' ? v.invested.minor : 0)),
      moic: cost > 0 ? Math.round((known.reduce((t, v) => t + v.value.minor + v.distributed.minor, 0) / cost) * 100) / 100 : null,
      moicExcludes: vs.length - known.length,
    }
  }).sort((a, b) => b.invested.minor - a.invested.minor)
}
