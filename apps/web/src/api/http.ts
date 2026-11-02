import type { Money } from '@agfn/contracts'
// AgfnApi over REST: the contract between apps/web (S8) and apps/server (S0, wired to S1 ledger / S7 grants).
// `Routes` is the source of truth: method + path → request body/query and response. The server returns the view models
// in types.ts as they are. Conventions:
// - JSON in and out; session by cookie (Better Auth, mounted at /api/auth/*); money is {minor, currency}.
// - Errors: non-2xx with {error?: string, message?: string}; `message` is shown to the person as is (plain words).
// - 401 → signed out. 403 {error:"recheck" or "step_up_required"} → passkey re-check (MASTER §9: adding a bank, creating AI access, widening a
//   grant), then the same request is retried once.
// - Every write the UI makes carries an idempotencyKey where the route says so.

import { defaultDataTypes, withOwnPersonal } from '../lib/grant.ts'
import { publicDemoOn } from '../lib/demo.ts'
import { signInCallback } from '../lib/deeplink.ts'
import { shownClientName } from '../lib/client-name.ts'
import { AI_DISCLOSURE, type ConnectorDescription, type GrantShape, type WriteResult } from '@agfn/contracts'
import type {
  AccountRow,
  AiActivity,
  AiDetail,
  AiSummary,
  BucketDetail,
  BucketField,
  FiledSummary,
  SetAsideInput,
  CashEntry,
  CompanyDetail,
  ConnectionSummary,
  ConnectStart,
  ConsentInfo,
  EquityDetail,
  ReconnectStart,
  WaitingStatement,
  InboundSettings,
  UnreadDocument,
  BalanceRefresh,
  EquityImportResult,
  EquityWritePayloadInput,
  EquityWriteResult,
  EntitySummary,
  Me,
  AgfnApi,
  NewAccount,
  PersonRow,
  Preferences,
  ReviewDecision,
  ReviewItem,
  RolePreset,
  SignInMethod,
  TxnRow,
  UploadResult,
  Workspace,
  Connector,
  MappingReply,
} from './types.ts'

type Ok = { ok: true }

/** Every route the web app calls. `body` is the JSON request body (or query for GETs), `res` the JSON response. */
export interface Routes {
  // ----- session (Better Auth endpoints, plus /api/me for the workspace-aware profile) -----
  /** signInMethods arrive as 'magic_link' for email; the client maps it to 'email'. */
  'GET /api/me': { body: void; res: Omit<Me, 'signInMethods'> & { signInMethods?: Array<SignInMethod | 'magic_link'> } }
  'POST /api/auth/sign-in/magic-link': { body: { email: string; callbackURL: string }; res: { status: boolean } }
  'POST /api/auth/sign-in/social': { body: { provider: 'google' | 'apple' | 'github'; callbackURL: string }; res: { url: string; redirect: boolean } }
  /** WebAuthn: options as PublicKeyCredentialRequestOptionsJSON. */
  'GET /api/auth/passkey/generate-authenticate-options': { body: void; res: PublicKeyCredentialRequestOptionsJSON }
  'POST /api/auth/passkey/verify-authentication': { body: { response: unknown }; res: { session: unknown } }
  'GET /api/auth/passkey/generate-register-options': { body: void; res: PublicKeyCredentialCreationOptionsJSON }
  'POST /api/auth/passkey/verify-registration': { body: { response: unknown; name?: string }; res: unknown }
  'POST /api/auth/passkey/delete-passkey': { body: { id: string }; res: unknown }
  'POST /api/auth/sign-out': { body: Record<string, never>; res: { success: boolean } }

  // ----- OAuth consent for Connect your AI -----
  /** Better Auth: an OAuth client's public info (for the consent page's name). */
  'GET /api/auth/oauth2/public-client': { body: { client_id: string }; res: { client_name?: string } }
  /** Creates the grant from the control sentence; then the client calls /api/auth/oauth2/continue. */
  'POST /api/ai/consent': { body: { clientId: string; clientName?: string; shape: GrantShape; disclosureVersion: string; oauthQuery: string }; res: { grantId: string; next: string } }
  /** Better Auth: resume the OAuth authorize request after consent. */
  'POST /api/auth/oauth2/continue': { body: { postLogin: true; oauth_query: string }; res: { url?: string; redirect?: boolean; redirectURI?: string } }
  /** Better Auth: accept the OAuth consent step that follows post-login (the control sentence was the real consent). */
  'POST /api/auth/oauth2/consent': { body: { accept: boolean; oauth_query: string }; res: { url?: string; redirect?: boolean; redirectURI?: string } }

  // ----- workspace -----
  'GET /api/workspace': { body: void; res: Workspace }
  'GET /api/entities/:id': { body: void; res: CompanyDetail }
  'GET /api/entities/:id/transactions': { body: { q: string }; res: TxnRow[] }
  'POST /api/workspaces': { body: { companyName?: string; currency?: string; timeZone?: string }; res: { workspaceId: string; companyId: string | null; personalId: string } }
  'POST /api/demo': { body: Record<string, never>; res: { workspaceId: string; created: boolean; entities: Array<{ id: string; name: string }> } }
  'DELETE /api/demo': { body: void; res: Ok }
  'DELETE /api/workspace': { body: { confirm: string }; res: Ok & { notRevoked?: string[] } }
  'GET /api/workspace/delete-preview': { body: void; res: { affected: Array<{ personId: string; name: string; email: string; personalConnections: number }> } }
  'GET /api/sign-in-methods': { body: void; res: { methods: Array<SignInMethod | 'magic_link'>; reviewerCode?: boolean } }
  'POST /api/review-access/code': { body: { code: string; email?: string }; res: { ok: true } }
  'DELETE /api/me': { body: { confirm: string }; res: Ok & { workspaces: number; grantsRevoked: number; connectionsRevoked: number; notRevoked?: string[]; documents: number } }
  'GET /api/invites/:id': { body: void; res: { workspaceId: string; workspaceName: string; inviterName: string; claim?: boolean; invitedEmail?: string } }
  'POST /api/invites/:id/accept': { body: Record<string, never>; res: { ok: true; workspaceId: string } }
  'POST /api/entities': { body: { name: string; currency?: string; kind: 'company' }; res: EntitySummary }
  'DELETE /api/entities/:id': { body: void; res: { ok: true; name: string } }

  // ----- connections -----
  'GET /api/connectors': { body: void; res: Connector[] }
  'POST /api/connectors/:key/start': { body: { entityId: string | null; returnTo?: string; investmentsFirst?: boolean }; res: ConnectStart }
  /** body: {state, ...}. Plaid {publicToken, institution?}; API key {apiKey}. OAuth finishes at the server's callback. */
  'POST /api/connectors/:key/finish': { body: Record<string, unknown> & { state: string }; res: { connectionId: string; accounts: NewAccount[] } }
  'POST /api/accounts/assign': { body: { assignments: Array<{ accountId: string; entityId: string }> }; res: Ok }
  'GET /api/connections/:id': { body: void; res: ConnectionSummary & { accounts: AccountRow[]; unassigned?: Array<{ id: string; name: string; mask?: string }>; provides: string[]; records?: number; storeSales?: Money[] } }
  'GET /api/connections/:id/shared': { body: void; res: { offers: Array<{ id: string; name: string }> } }
  'POST /api/connections/:id/shared': { body: { id: string }; res: { connectionId: string; name: string } }
  'POST /api/connections/:id/company': { body: { entityId: string }; res: { ok: true; moved: number } }
  'POST /api/connections/:id/reconnect': { body: { accountSelection?: boolean }; res: ReconnectStart }
  'POST /api/connections/:id/reconnect/finish': { body: { state: string; linkSessionId?: string }; res: Ok }
  'POST /api/connectors/plaid/link-event': { body: Record<string, string>; res: Ok }
  'POST /api/connections/:id/refresh-balance': { body: Record<string, never>; res: BalanceRefresh }
  'POST /api/connections/:id/sync': { body: Record<string, never>; res: Ok }
  'POST /api/connections/:id/disconnect': { body: { deleteData: boolean }; res: { ok: true; dataDeleted?: boolean; warning?: string } }

  // ----- buckets and records -----
  'GET /api/buckets/:id': { body: void; res: BucketDetail }
  'PATCH /api/buckets/:id': { body: Partial<Pick<BucketDetail, 'name' | 'fields' | 'schedule'>> & { setAside?: SetAsideInput | null; idempotencyKey: string }; res: BucketDetail }
  'POST /api/buckets': { body: { entityId: string; name: string; fields: BucketField[]; idempotencyKey: string }; res: BucketDetail }
  'POST /api/records/:id/undo': { body: { idempotencyKey: string }; res: WriteResult }

  // ----- Connect your AI (grants) -----
  'GET /api/ai/:grantId': { body: void; res: AiDetail }
  'PATCH /api/ai/:grantId': { body: { shape?: GrantShape; name?: string }; res: AiSummary }
  'POST /api/ai/:grantId/pause': { body: { paused: boolean }; res: Ok }
  'POST /api/ai/:grantId/revoke': { body: Record<string, never>; res: Ok }
  'POST /api/ai/pause-all': { body: { paused: boolean }; res: Ok }
  'POST /api/ai/keys': { body: { name: string; shape: GrantShape; disclosureVersion: string }; res: { grantId: string; key: string } }
  'GET /api/ai/activity/latest': { body: void; res: AiActivity | null }

  // ----- review -----
  'GET /api/review': { body: void; res: Array<ReviewItem & { pick?: ReviewPick }> }
  'POST /api/review/:id': { body: ReviewDecision; res: Ok & { recordId?: string; summary?: string } }
  'GET /api/review/filed': { body: void; res: FiledSummary }
  'POST /api/review/filed/:id/undo': { body: Record<string, never>; res: Ok }
  'POST /api/review/group/:key': { body: { action: 'confirm'; ids: string[] }; res: Ok & { count: number } }

  // ----- preferences and people -----
  'GET /api/preferences': { body: void; res: Preferences }
  'PATCH /api/preferences': { body: Partial<Omit<Preferences, 'people' | 'signIn' | 'recovery'>>; res: Preferences }
  'POST /api/people': { body: { email: string; role: RolePreset; entityIds: string[] | 'all' }; res: PersonRow }
  'GET /api/friend-invite': { body: void; res: { link: string } }
  'POST /api/friend-invite': { body: { email: string }; res: { ok: true } }
  'PATCH /api/people/:id': { body: Partial<Pick<PersonRow, 'role' | 'entityIds' | 'grid'>>; res: PersonRow }
  'DELETE /api/people/:id': { body: void; res: { ok: true } }
  'DELETE /api/documents/:id': { body: void; res: { ok: true; name: string } }
  'POST /api/people/:id/resend': { body: Record<string, never>; res: { ok: true; sentTo: string } }
  'POST /api/workspace/leave': { body: Record<string, never>; res: { ok: true } }
  'POST /api/export': { body: { format?: 'json' | 'beancount' | 'hledger' }; res: { url: string } }

  // ----- equity (S6) -----
  'GET /api/entities/:id/equity': { body: void; res: EquityDetail }
  // Investments (AGFN_INVESTMENTS; apps/server routes/investments.ts). Money in minor units.
  'GET /api/entities/:id/investments': { body: void; res: { positions: import('../lib/investments.ts').InvestmentView[]; totals: import('../lib/investments.ts').InvestmentTotals[] } }
  'POST /api/entities/:id/investments': { body: import('../lib/investments.ts').InvestmentInput & { idempotencyKey: string }; res: { status: string; positionId: string; recordId?: string; summary: string } }
  /** Body as record_equity_event's payload (money in minor units) + idempotencyKey. */
  'POST /api/entities/:id/equity/events': { body: EquityWritePayloadInput & { idempotencyKey: string }; res: EquityWriteResult }
  /** multipart/form-data: file (OCF .json or .csv). */
  'POST /api/entities/:id/equity/import': { body: FormData; res: EquityImportResult }
  /** The OCF file set as one JSON download (Content-Disposition: attachment). */
  'GET /api/entities/:id/equity/ocf': { body: void; res: Record<string, unknown> }

  // ----- add anything -----
  'POST /api/entries/cash': { body: CashEntry & { idempotencyKey: string }; res: WriteResult }
  /** multipart/form-data: entityId, file. */
  'POST /api/documents': { body: FormData; res: UploadResult }
  'GET /api/inbound/:entityId': { body: void; res: InboundSettings & { entityId: string } }
  'PUT /api/inbound/:entityId': { body: { extra: string[]; allowedSenders: string[] }; res: InboundSettings & { entityId: string } }
  'GET /api/entities/:id/mrr': { body: { months?: string }; res: import('@agfn/contracts').MrrMovementView[] }
  'POST /api/entities/:id/period': { body: { action: 'close' | 'reopen'; through?: string; note?: string; idempotencyKey: string }; res: { status: string; recordId?: string; summary: string } }
  'GET /api/documents': { body: { state: 'needs_account' | 'unread' }; res: WaitingStatement[] | UnreadDocument[] }
  'POST /api/documents/:id/account': { body: { accountId: string }; res: { state: 'imported' | 'unread'; message: string } }
  'POST /api/recheck/email': { body: { returnTo: string }; res: { ok: true; sentTo: string } }
  'POST /api/signin/code': { body: { code: string }; res: { ok: true } }
  'POST /api/recheck/code': { body: { code: string }; res: { ok: true } }
  'POST /api/documents/:id/answer': { body: { field: string; value: string }; res: MappingReply }
  'GET /api/share': { body: void; res: { cards: import('./types.ts').ShareCard[] } }
  'POST /api/share': { body: { entityId: string; kind: import('./types.ts').ShareKind }; res: { id: string } }
  'POST /api/share/:id/preview': { body: import('./types.ts').ShareOpts; res: import('./types.ts').SharePreview }
  'POST /api/share/:id/publish': { body: import('./types.ts').ShareOpts; res: { url: string } }
  'POST /api/share/:id/revoke': { body: Record<string, never>; res: { ok: true } }
}

export type RouteKey = keyof Routes

/** The route list, for docs and the server owner. Checked against `Routes` at compile time. */
export const ROUTES = [
  'GET /api/me', 'POST /api/auth/sign-in/magic-link', 'POST /api/auth/sign-in/social',
  'GET /api/auth/passkey/generate-authenticate-options', 'POST /api/auth/passkey/verify-authentication',
  'GET /api/auth/passkey/generate-register-options', 'POST /api/auth/passkey/verify-registration', 'POST /api/auth/passkey/delete-passkey',
  'POST /api/auth/sign-out',
  'GET /api/auth/oauth2/public-client', 'POST /api/ai/consent', 'POST /api/auth/oauth2/continue', 'POST /api/auth/oauth2/consent', 'POST /api/workspaces', 'POST /api/demo', 'DELETE /api/demo', 'DELETE /api/workspace', 'GET /api/workspace/delete-preview', 'DELETE /api/me', 'GET /api/sign-in-methods', 'POST /api/review-access/code', 'GET /api/invites/:id', 'POST /api/invites/:id/accept',
  'GET /api/workspace', 'GET /api/entities/:id', 'GET /api/entities/:id/transactions', 'POST /api/entities', 'DELETE /api/entities/:id',
  'GET /api/connectors', 'POST /api/connectors/:key/start', 'POST /api/connectors/:key/finish', 'POST /api/accounts/assign',
  'GET /api/connections/:id', 'GET /api/connections/:id/shared', 'POST /api/connections/:id/shared', 'POST /api/connections/:id/company', 'POST /api/connections/:id/reconnect', 'POST /api/connections/:id/reconnect/finish', 'POST /api/connectors/plaid/link-event', 'POST /api/connections/:id/refresh-balance', 'POST /api/connections/:id/sync', 'POST /api/connections/:id/disconnect',
  'GET /api/buckets/:id', 'PATCH /api/buckets/:id', 'POST /api/buckets', 'POST /api/records/:id/undo',
  'GET /api/ai/:grantId', 'PATCH /api/ai/:grantId', 'POST /api/ai/:grantId/pause', 'POST /api/ai/:grantId/revoke',
  'POST /api/ai/pause-all', 'POST /api/ai/keys', 'GET /api/ai/activity/latest',
  'GET /api/review', 'POST /api/review/:id', 'GET /api/review/filed', 'POST /api/review/filed/:id/undo', 'POST /api/review/group/:key',
  'GET /api/preferences', 'PATCH /api/preferences', 'POST /api/people', 'GET /api/friend-invite', 'POST /api/friend-invite', 'PATCH /api/people/:id', 'DELETE /api/people/:id', 'POST /api/people/:id/resend', 'POST /api/workspace/leave', 'POST /api/export',
  'GET /api/entities/:id/investments', 'POST /api/entities/:id/investments',
  'GET /api/entities/:id/equity', 'POST /api/entities/:id/equity/events', 'POST /api/entities/:id/equity/import', 'GET /api/entities/:id/equity/ocf',
  'POST /api/entries/cash', 'POST /api/documents', 'POST /api/documents/:id/account', 'POST /api/documents/:id/answer', 'POST /api/recheck/email', 'POST /api/signin/code', 'POST /api/recheck/code', 'GET /api/documents', 'DELETE /api/documents/:id', 'POST /api/entities/:id/period', 'GET /api/entities/:id/mrr', 'GET /api/inbound/:entityId', 'PUT /api/inbound/:entityId',
  'GET /api/share', 'POST /api/share', 'POST /api/share/:id/preview', 'POST /api/share/:id/publish', 'POST /api/share/:id/revoke',
] as const satisfies readonly RouteKey[]

// Compile-time check that ROUTES lists every key of Routes.
type Missing = Exclude<RouteKey, (typeof ROUTES)[number]>
const _complete: Missing extends never ? true : Missing = true
void _complete

/** No answer at all (offline, or the server is down): the one error that isn't about what you asked for. */
export const OFFLINE = 'Can’t reach Aggregate right now. Check your connection and try again.'

export class HttpError extends Error {
  status: number
  /** The server's `error` code, e.g. 'passkey_required', 'recheck', 'demo', 'duplicate'. */
  code: string | undefined
  /** The rest of the error body (e.g. connectionId on 'duplicate', retryAt on 'cooldown'). */
  data: Record<string, unknown>
  constructor(status: number, message: string, code?: string, data: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.code = code
    this.data = data
  }
}

export interface HttpOptions {
  /** Origin prefix, '' for same origin. */
  origin?: string
  fetch?: typeof fetch
  /** Runs the passkey re-check; resolves true when the person confirmed. */
  recheck?: () => Promise<boolean>
  /** Creates the person's first passkey when an action needs one (connecting accounts); resolves true when added. */
  setupPasskey?: () => Promise<boolean>
  onSignedOut?: () => void
  /** A passkey check didn't happen (cancelled, unavailable, or the person has none): offer the email link. */
  onRecheckFailed?: () => void
  /** Where Better Auth sends people back after Google/Apple/magic link (default: a kept connect link, else the app). */
  callbackURL?: () => string
}

const key = () => crypto.randomUUID()

export class HttpApi implements AgfnApi {
  private origin: string
  private f: typeof fetch
  private recheck: () => Promise<boolean>
  private setupPasskey: () => Promise<boolean>
  private onSignedOut: () => void
  private onRecheckFailed: () => void
  private callbackURL: () => string
  /** The workspace this tab is in, sent as x-agfn-workspace so a second workspace (or tab) never mixes them up. A new
   *  tab or a reload starts in the last one chosen in this browser; the server ignores it unless the person is a member,
   *  and its answer then replaces it. */
  private workspaceId: string | null = lastWorkspace()

  constructor(o: HttpOptions = {}) {
    this.origin = o.origin ?? ''
    this.f = o.fetch ?? ((...a) => fetch(...a))
    this.recheck = o.recheck ?? (async () => false)
    this.setupPasskey = o.setupPasskey ?? (async () => false)
    this.onSignedOut = o.onSignedOut ?? (() => {})
    this.onRecheckFailed = o.onRecheckFailed ?? (() => {})
    this.callbackURL = o.callbackURL ?? signInCallback
  }

  /** Typed call: fills `:params`, sends body as JSON (or query for GET), returns the route's response type. */
  async call<K extends RouteKey>(route: K, params: Record<string, string> = {}, body?: Routes[K]['body'], retried = false): Promise<Routes[K]['res']> {
    const [method, pattern] = route.split(' ') as [string, string]
    let path = pattern.replace(/:(\w+)/g, (_, k: string) => {
      const v = params[k]
      if (v === undefined) throw new Error(`Missing route param ${k} for ${route}`)
      return encodeURIComponent(v)
    })
    // The public demo: the server picks the workspace (it changes nightly), so none is named or remembered.
    const demo = publicDemoOn()
    const init: RequestInit = { method, credentials: 'same-origin', headers: { accept: 'application/json', ...(demo ? { 'x-agfn-public-demo': '1' } : this.workspaceId ? { 'x-agfn-workspace': this.workspaceId } : {}) } }
    if (method === 'GET' && body && typeof body === 'object') {
      path += '?' + new URLSearchParams(body as Record<string, string>).toString()
    } else if (body instanceof FormData) {
      init.body = body
    } else if (body !== undefined) {
      init.body = JSON.stringify(body)
      init.headers = { ...init.headers, 'content-type': 'application/json' }
    }
    // Server down or offline: one plain sentence, never "Failed to fetch".
    const r = await this.f(this.origin + path, init).catch(() => {
      throw new HttpError(0, OFFLINE, 'offline')
    })
    if (r.status === 204) return undefined as unknown as Routes[K]["res"]
    const data = (await r.json().catch(() => ({}))) as { error?: string; message?: string }
    // Nobody was signed in to lose: the device offered a passkey this server doesn't have.
    if (r.status === 401 && route === 'POST /api/auth/passkey/verify-authentication') throw new HttpError(401, 'This passkey isn’t recognized here. Use your email instead, then add a new passkey in Settings.', 'passkey_unknown')
    if (r.status === 401) {
      this.onSignedOut()
      throw new HttpError(401, 'Please sign in again.')
    }
    // No passkey to ask for: an emailed link or code instead (method 'email'), or a fresh sign-in (method 'signin', the
    // reviewer demo). The screen offers whichever it is; a passkey prompt here could never succeed.
    const checkWith = (data as { method?: string }).method
    if (r.status === 403 && data.error === 'recheck' && checkWith && checkWith !== 'passkey') {
      this.onRecheckFailed()
      throw new HttpError(403, data.message ?? 'Confirm it’s you first.', 'recheck', { ...(data as Record<string, unknown>), fallback: 'email' })
    }
    if (r.status === 403 && (data.error === 'recheck' || data.error === 'step_up_required') && !retried) {
      if (await this.recheck()) return this.call(route, params, body, true)
      // Passkey cancelled or unavailable: an emailed link works for every check (the app offers "Use email instead").
      this.onRecheckFailed()
      throw new HttpError(403, 'That needs a quick check that it’s you.', 'recheck', { ...(data as Record<string, unknown>), fallback: 'email' })
    }
    // Connecting accounts needs a passkey; adding the first one counts as the check, so retry once it's added.
    if (r.status === 403 && data.error === 'passkey_required' && !retried) {
      if (await this.setupPasskey()) return this.call(route, params, body, true)
      throw new HttpError(403, data.message ?? 'Add a passkey to connect accounts.', 'passkey_required')
    }
    if (!r.ok) throw new HttpError(r.status, data.message ?? 'Something went wrong. Nothing was changed.', data.error, data as Record<string, unknown>)
    const ws = route === 'POST /api/workspaces' || route === 'POST /api/demo' || route === 'GET /api/me' || route === 'GET /api/workspace' ? workspaceIdOf(data) : null
    if (ws && !(data as { publicDemo?: boolean }).publicDemo && !demo) this.useWorkspace(ws)
    return data as Routes[K]['res']
  }

  // ----- session -----
  async me(): Promise<Me | null> {
    try {
      const { signInMethods, ...m } = await this.call('GET /api/me')
      return signInMethods ? { ...m, signInMethods: signInMethods.map((x): SignInMethod => (x === 'magic_link' ? 'email' : x)) } : m
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) return null
      throw e
    }
  }
  async signIn(method: SignInMethod, email?: string): ReturnType<AgfnApi['signIn']> {
    try {
      if (method === 'email') {
        await this.call('POST /api/auth/sign-in/magic-link', {}, { email: email ?? '', callbackURL: this.callbackURL() })
        return { ok: true, next: 'check_email' }
      }
      if (method === 'google' || method === 'apple' || method === 'github') {
        const r = await this.call('POST /api/auth/sign-in/social', {}, { provider: method, callbackURL: this.callbackURL() })
        if (r.url) location.assign(r.url)
        return { ok: true, next: 'redirect' }
      }
      return (await this.passkey()) ? { ok: true } : { ok: false, message: 'Passkey sign-in was cancelled.' }
    } catch (e) {
      // A server validator's own words ("[body.email] Invalid email address") never reach the page.
      if (e instanceof HttpError && /^\[body\.email\]|invalid email/i.test(e.message)) return { ok: false, message: 'That doesn’t look like an email address.' }
      // Rate limited (the email or this network asked too often): the server's own words ("Too many emails. Wait a few
      // minutes…"), or a plain line when its body has none.
      if (e instanceof HttpError && e.status === 429) return { ok: false, message: e.data.message ? e.message : 'Too many tries. Wait a few minutes, then try again.' }
      return { ok: false, message: e instanceof HttpError ? e.message : 'That didn’t work. Try another way to sign in.' }
    }
  }
  /** Passkey sign-in, also used as the 10-minute re-check before sensitive actions. */
  async passkey(): Promise<boolean> {
    const opts = await this.call('GET /api/auth/passkey/generate-authenticate-options', {}, undefined, true)
    const cred = (await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(opts) }).catch(() => null)) as PublicKeyCredential | null
    if (!cred) return false
    await this.call('POST /api/auth/passkey/verify-authentication', {}, { response: cred.toJSON() }, true)
    return true
  }

  /**
   * Fetches the registration options now, so the returned function can open the passkey sheet straight from a click.
   * Safari only shows it when it's called in the click itself, not after a network round trip.
   */
  async preparePasskey(): Promise<(name: string) => Promise<boolean>> {
    const opts = await this.call('GET /api/auth/passkey/generate-register-options')
    return async (name: string) => {
      // "Already registered" (InvalidStateError: this device holds a passkey for this account) is thrown for the caller,
      // which then asks for that passkey; a cancel or timeout is just false.
      const cred = (await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(opts) }).catch((e: unknown) => {
        if ((e as { name?: string } | null)?.name === 'InvalidStateError') throw e
        return null
      })) as PublicKeyCredential | null
      if (!cred) return false
      await this.call('POST /api/auth/passkey/verify-registration', {}, { response: cred.toJSON(), name })
      return true
    }
  }

  async addPasskey(name: string): Promise<boolean> {
    const opts = await this.call('GET /api/auth/passkey/generate-register-options')
    const cred = (await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(opts) }).catch(() => null)) as PublicKeyCredential | null
    if (!cred) return false
    await this.call('POST /api/auth/passkey/verify-registration', {}, { response: cred.toJSON(), name })
    return true
  }
  async removePasskey(id: string) {
    await this.call('POST /api/auth/passkey/delete-passkey', {}, { id })
  }

  async signOut() {
    await this.call('POST /api/auth/sign-out', {}, {})
  }

  // ----- consent -----
  /** No server call: defaults come from the workspace (review mode, companies) and the requested scope. */
  async consentInfo(p: { clientId: string; clientName?: string; scope: string }): Promise<ConsentInfo> {
    const [ws, pub] = await Promise.all([
      this.workspace(),
      p.clientName ? Promise.resolve({ client_name: p.clientName }) : this.call('GET /api/auth/oauth2/public-client', {}, { client_id: p.clientId }).catch(() => ({ client_name: undefined })),
    ])
    return {
      clientName: shownClientName(p.clientId, pub.client_name),
      shape: {
        entityIds: 'all',
        // Everything a company has, so its AI can answer about documents, payroll and the cap table too, plus the
        // signed-in person's own Personal when they have one (the server only ever lets a grant see its own person's
        // Personal). It stays a toggle on the page.
        dataTypes: withOwnPersonal(defaultDataTypes(ws.entities), ws.entities),
        write: /\b(write|add)\b/.test(p.scope),
        reviewMode: ws.reviewModeOn ? 'review_all' : 'instant',
        expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
      },
      allowedEntityIds: 'all',
    }
  }
  async consent(i: { clientId: string; clientName: string; shape: GrantShape; oauthQuery: string }) {
    await this.call('POST /api/ai/consent', {}, { clientId: i.clientId, clientName: i.clientName, shape: i.shape, disclosureVersion: AI_DISCLOSURE.version, oauthQuery: i.oauthQuery })
    const r = await this.call('POST /api/auth/oauth2/continue', {}, { postLogin: true, oauth_query: i.oauthQuery })
    const next = r.url ?? r.redirectURI ?? null
    // Better Auth asks for its own consent step after post-login, pointing back at this page; accept it here,
    // or the browser lands on the consent page again and the AI never gets its code.
    if (next && next.includes('/connect-ai/consent')) {
      const c = await this.call('POST /api/auth/oauth2/consent', {}, { accept: true, oauth_query: next.slice(next.indexOf('?') + 1) })
      return { redirectTo: c.url ?? c.redirectURI ?? null }
    }
    return { redirectTo: next }
  }

  /**
   * "Don't allow": nothing is shared and no grant is made; the AI app is told access_denied instead of waiting.
   * Better Auth may still be in its post-login stage here, which refuses a consent answer; then continue first.
   */
  async decline(i: { oauthQuery: string }): Promise<{ redirectTo: string | null }> {
    const deny = async (query: string) => {
      const c = await this.call('POST /api/auth/oauth2/consent', {}, { accept: false, oauth_query: query })
      return { redirectTo: c.url ?? c.redirectURI ?? null }
    }
    try {
      return await deny(i.oauthQuery)
    } catch {
      const r = await this.call('POST /api/auth/oauth2/continue', {}, { postLogin: true, oauth_query: i.oauthQuery })
      const next = r.url ?? r.redirectURI ?? null
      if (!next || !next.includes('?')) return { redirectTo: next }
      return deny(next.slice(next.indexOf('?') + 1))
    }
  }

  // ----- workspace -----
  workspace = () => this.call('GET /api/workspace')
  company = (id: string) => this.call('GET /api/entities/:id', { id })
  searchTransactions = (id: string, q: string) => this.call('GET /api/entities/:id/transactions', { id }, { q })
  /** What this server offers on the sign-in page (no session needed). */
  signInMethods = async (): Promise<SignInMethod[]> => {
    const r = await this.call('GET /api/sign-in-methods').catch(() => null)
    if (!r) return ['passkey', 'email']
    const methods = r.methods.map((m): SignInMethod => (m === 'magic_link' ? 'email' : m))
    return r.reviewerCode ? [...methods, 'reviewer'] : methods
  }
  reviewerSignIn = (code: string, email?: string) => this.call('POST /api/review-access/code', {}, email ? { code, email } : { code })
  continueOAuthLogin = async (oauthQuery: string) => {
    const r = await this.call('POST /api/auth/oauth2/continue', {}, { postLogin: true, oauth_query: oauthQuery })
    return r.url ?? r.redirectURI ?? null
  }
  inviteInfo = (id: string) => this.call('GET /api/invites/:id', { id })
  acceptInvite = async (id: string) => {
    const r = await this.call('POST /api/invites/:id/accept', { id }, {})
    this.useWorkspace(r.workspaceId)
    return r
  }
  setWorkspace = (id: string) => this.useWorkspace(id)
  /** It's gone (deleted, left, demo over): the next call lets the server pick one the person still belongs to. */
  private forgetWorkspace() {
    this.workspaceId = null
    try {
      localStorage.removeItem(WORKSPACE_KEY)
    } catch {
      // Nothing stored.
    }
  }
  private useWorkspace(id: string) {
    this.workspaceId = id
    try {
      localStorage.setItem(WORKSPACE_KEY, id)
    } catch {
      // Private windows and blocked storage: this tab still remembers it.
    }
  }
  recheckByEmail = (returnTo: string) => this.call('POST /api/recheck/email', {}, { returnTo })
  signInCode = (code: string) => this.call('POST /api/signin/code', {}, { code })
  recheckCode = (code: string) => this.call('POST /api/recheck/code', {}, { code })
  deleteMe = async (confirm: string) => {
    const r = await this.call('DELETE /api/me', {}, { confirm })
    this.forgetWorkspace()
    return r
  }
  deleteWorkspacePreview = () => this.call('GET /api/workspace/delete-preview')
  deleteWorkspace = async (confirm: string) => {
    const r = await this.call('DELETE /api/workspace', {}, { confirm })
    this.forgetWorkspace()
    return r
  }
  startDemo = () => this.call('POST /api/demo', {}, {})
  leaveDemo = async () => {
    const r = await this.call('DELETE /api/demo')
    this.forgetWorkspace()
    return r
  }
  createWorkspace = (companyName: string | null, currency?: string) => this.call('POST /api/workspaces', {}, { ...(companyName ? { companyName } : {}), ...(currency ? { currency } : {}), ...(deviceTimeZone() ? { timeZone: deviceTimeZone() } : {}) })
  createCompany = (name: string, currency?: string) => this.call('POST /api/entities', {}, { name, kind: 'company', ...(currency ? { currency } : {}) })
  deleteCompany = (id: string) => this.call('DELETE /api/entities/:id', { id })

  // ----- connections -----
  connectors = () => this.call('GET /api/connectors')
  startConnect = (key: string, entityId: string | null, returnTo?: string, opts?: { investmentsFirst?: boolean }) =>
    this.call('POST /api/connectors/:key/start', { key }, { entityId, ...(returnTo && returnTo !== '/' ? { returnTo } : {}), ...(opts?.investmentsFirst ? { investmentsFirst: true } : {}) })
  finishConnect = (key: string, input: Record<string, unknown> & { state: string }) => this.call('POST /api/connectors/:key/finish', { key }, input)
  assignAccounts = async (assignments: Array<{ accountId: string; entityId: string }>) => {
    await this.call('POST /api/accounts/assign', {}, { assignments })
  }
  connection = (id: string) => this.call('GET /api/connections/:id', { id }) as ReturnType<AgfnApi['connection']>
  sharedOffers = async (id: string) => (await this.call('GET /api/connections/:id/shared', { id })).offers
  addShared = (id: string, orgId: string) => this.call('POST /api/connections/:id/shared', { id }, { id: orgId })
  setConnectionCompany = (id: string, entityId: string) => this.call('POST /api/connections/:id/company', { id }, { entityId })
  reconnect = (id: string, accountSelection?: boolean) => this.call('POST /api/connections/:id/reconnect', { id }, accountSelection ? { accountSelection } : {})
  finishReconnect = (id: string, input: { state: string; linkSessionId?: string }) => this.call('POST /api/connections/:id/reconnect/finish', { id }, input)
  linkEvent = (e: Record<string, string | undefined>) =>
    this.call('POST /api/connectors/plaid/link-event', {}, Object.fromEntries(Object.entries(e).filter(([, v]) => typeof v === 'string')) as Record<string, string>).catch(() => undefined)
  refreshBalance = (id: string) => this.call('POST /api/connections/:id/refresh-balance', { id }, {})
  syncNow = async (id: string) => {
    await this.call('POST /api/connections/:id/sync', { id }, {})
  }
  disconnect = async (id: string, deleteData: boolean) => {
    return await this.call('POST /api/connections/:id/disconnect', { id }, { deleteData })
  }

  // ----- buckets -----
  bucket = (id: string) => this.call('GET /api/buckets/:id', { id })
  updateBucket = (id: string, patch: Partial<Pick<BucketDetail, 'name' | 'fields' | 'schedule'>> & { setAside?: SetAsideInput | null }) => this.call('PATCH /api/buckets/:id', { id }, { ...patch, idempotencyKey: key() })
  createBucket = (entityId: string, b: { name: string; fields: BucketField[] }) => this.call('POST /api/buckets', {}, { entityId, ...b, idempotencyKey: key() })
  undo = (id: string) => this.call('POST /api/records/:id/undo', { id }, { idempotencyKey: key() })

  // ----- AI -----
  ai = (grantId: string) => this.call('GET /api/ai/:grantId', { grantId })
  updateGrant = (grantId: string, shape: GrantShape) => this.call('PATCH /api/ai/:grantId', { grantId }, { shape })
  renameKey = (grantId: string, name: string) => this.call('PATCH /api/ai/:grantId', { grantId }, { name })
  pauseAi = async (grantId: string, paused: boolean) => {
    await this.call('POST /api/ai/:grantId/pause', { grantId }, { paused })
  }
  revokeAi = async (grantId: string) => {
    await this.call('POST /api/ai/:grantId/revoke', { grantId }, {})
  }
  pauseAll = async (paused: boolean) => {
    await this.call('POST /api/ai/pause-all', {}, { paused })
  }
  createKey = (name: string, shape: GrantShape) => this.call('POST /api/ai/keys', {}, { name, shape, disclosureVersion: AI_DISCLOSURE.version })
  latestActivity = () => this.call('GET /api/ai/activity/latest')

  // ----- review -----
  review = async (): Promise<ReviewItem[]> => (await this.call('GET /api/review')).map(fromPick)
  reviewFiled = () => this.call('GET /api/review/filed')
  undoFiled = (id: string) => this.call('POST /api/review/filed/:id/undo', { id }, {})
  confirmGroup = (key: string, ids: string[]) => this.call('POST /api/review/group/:key', { key }, { action: 'confirm', ids })
  resolve = async (id: string, decision: ReviewDecision) => {
    const { recordId, summary } = await this.call('POST /api/review/:id', { id }, decision)
    return { ...(recordId ? { recordId } : {}), ...(summary ? { summary } : {}) }
  }

  // ----- preferences -----
  preferences = () => this.call('GET /api/preferences')
  updatePreferences = (patch: Routes['PATCH /api/preferences']['body']) => this.call('PATCH /api/preferences', {}, patch)
  friendLink = () => this.call('GET /api/friend-invite', {})
  inviteFriend = (email: string) => this.call('POST /api/friend-invite', {}, { email })
  invite = (email: string, role: RolePreset, entityIds: string[] | 'all') => this.call('POST /api/people', {}, { email, role, entityIds })
  updatePerson = (id: string, patch: Routes['PATCH /api/people/:id']['body']) => this.call('PATCH /api/people/:id', { id }, patch)
  removePerson = (id: string) => this.call('DELETE /api/people/:id', { id })
  resendInvite = (id: string) => this.call('POST /api/people/:id/resend', { id }, {})
  leaveWorkspace = async () => {
    const r = await this.call('POST /api/workspace/leave', {}, {})
    this.forgetWorkspace()
    return r
  }
  exportAll = (format?: 'json' | 'beancount' | 'hledger') => this.call('POST /api/export', {}, format ? { format } : {})

  // ----- equity -----
  // Investments: offered only where the server has them (me.investments, AGFN_INVESTMENTS).
  investments = (id: string) => this.call('GET /api/entities/:id/investments', { id })
  recordInvestment = (id: string, input: import('../lib/investments.ts').InvestmentInput) => this.call('POST /api/entities/:id/investments', { id }, { ...input, idempotencyKey: key() })
  equity = (id: string) => this.call('GET /api/entities/:id/equity', { id })
  recordEquity = (id: string, payload: EquityWritePayloadInput) => this.call('POST /api/entities/:id/equity/events', { id }, { ...payload, idempotencyKey: key() })
  importEquity = (id: string, file: File) => {
    const fd = new FormData()
    fd.set('file', file)
    return this.call('POST /api/entities/:id/equity/import', { id }, fd)
  }
  ocfExportUrl = (id: string) => `${this.origin}/api/entities/${encodeURIComponent(id)}/equity/ocf`

  // ----- add anything -----
  addCash = (entry: CashEntry) => this.call('POST /api/entries/cash', {}, { ...entry, idempotencyKey: key() })
  inboundSenders = (entityId: string) => this.call('GET /api/inbound/:entityId', { entityId })
  // Both keys: servers before members/extra read allowedSenders; newer ones read extra.
  setInboundSenders = (entityId: string, extra: string[]) => this.call('PUT /api/inbound/:entityId', { entityId }, { extra, allowedSenders: extra })
  mrrMovements = (id: string, months?: number) => this.call('GET /api/entities/:id/mrr', { id }, months ? { months: String(months) } : undefined)
  closePeriod = (id: string, through: string, note?: string) => this.call('POST /api/entities/:id/period', { id }, { action: 'close', through, ...(note ? { note } : {}), idempotencyKey: key() })
  reopenPeriod = (id: string) => this.call('POST /api/entities/:id/period', { id }, { action: 'reopen', idempotencyKey: key() })
  waitingStatements = () => this.call('GET /api/documents', {}, { state: 'needs_account' }) as Promise<WaitingStatement[]>
  unreadDocuments = () => this.call('GET /api/documents', {}, { state: 'unread' }) as Promise<UnreadDocument[]>
  deleteDocument = (id: string) => this.call('DELETE /api/documents/:id', { id })
  documentFileUrl = (id: string) => `${this.origin}/api/documents/${encodeURIComponent(id)}/file`
  chooseStatementAccount = (documentId: string, accountId: string) => this.call('POST /api/documents/:id/account', { id: documentId }, { accountId })
  answerMapping = (documentId: string, field: string, value: string) => this.call('POST /api/documents/:id/answer', { id: documentId }, { field, value })
  shareCards = async () => (await this.call('GET /api/share', {})).cards
  shareDraft = (entityId: string, kind: import('./types.ts').ShareKind) => this.call('POST /api/share', {}, { entityId, kind })
  sharePreview = (id: string, opts: import('./types.ts').ShareOpts) => this.call('POST /api/share/:id/preview', { id }, opts)
  sharePreviewUrl = (id: string, query: string) => `${this.origin}/api/share/${encodeURIComponent(id)}/preview.png?${query}`
  badgePreviewUrl = (id: string, query: string) => `${this.origin}/api/share/${encodeURIComponent(id)}/preview.svg?${query}`
  sharePublish = (id: string, opts: import('./types.ts').ShareOpts) => this.call('POST /api/share/:id/publish', { id }, opts)
  shareRevoke = async (id: string) => void (await this.call('POST /api/share/:id/revoke', { id }, {}))
  upload = (entityId: string, file: File) => {
    const fd = new FormData()
    fd.set('entityId', entityId)
    fd.set('file', file)
    return this.call('POST /api/documents', {}, fd)
  }
}

const WORKSPACE_KEY = 'agfn.workspace'
function lastWorkspace(): string | null {
  try {
    return globalThis.localStorage?.getItem(WORKSPACE_KEY) || null
  } catch {
    return null
  }
}

function workspaceIdOf(d: unknown): string | null {
  const x = d as { workspaceId?: unknown; me?: { workspaceId?: unknown } } | null
  const id = x?.workspaceId ?? x?.me?.workspaceId
  return typeof id === 'string' && id ? id : null
}

/** The browser's time zone, sent once at signup (the server falls back quietly if it doesn't know it). */
function deviceTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

/** "Which company is this account?" arrives as a pick of companies (and Personal); each becomes an answer button. */
type ReviewPick = { accountId: string | null; choices: Array<{ id: string; name: string }>; suggested?: string; connectionId?: string }
function fromPick({ pick, ...it }: ReviewItem & { pick?: ReviewPick }): ReviewItem {
  if (!pick?.choices.length) return it
  // The suggested answer first; it's still the person's choice.
  const choices = [...pick.choices].sort((a, b) => Number(b.id === pick.suggested) - Number(a.id === pick.suggested))
  const sug = choices.find((c) => c.id === pick.suggested)
  return {
    ...it,
    answers: choices.map((c) => ({ label: c.name, values: { companyId: c.id } })),
    ...(sug && pick.connectionId ? { batch: { key: `${pick.connectionId}:${sug.id}`, label: sug.name, values: { companyId: sug.id } } } : {}),
  }
}
