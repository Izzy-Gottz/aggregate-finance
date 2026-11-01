// Plaid Link in the browser (MASTER §2 Banks: Plaid only). The script loads from Plaid's CDN only when someone connects
// a bank. OAuth banks (Chase…) leave the page and come back to /connect/plaid/oauth, which re-opens Link with the same
// token; the pending attempt is kept in sessionStorage for that round trip.

const SRC = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js'
const KEY = 'agfn.plaid.pending'

export interface PlaidSuccess {
  publicToken: string
  institution?: { name?: string; institution_id?: string }
  /** What the person picked, so the server can spot a bank that's already connected. */
  accounts?: Array<{ mask?: string; subtype?: string }>
  linkSessionId?: string
}
export interface Pending {
  connectorKey: string
  linkToken: string
  state: string
  /** 'reconnect' = update mode on an existing connection (no new Item, no token exchange). */
  mode?: 'connect' | 'reconnect'
  connectionId?: string
  /** The app page to come back to after an OAuth bank (e.g. /welcome/2), so setup carries on where it was. */
  returnTo?: string
  /** The company it was started for, so the OAuth return can ask again with investments first (null = Personal). */
  entityId?: string | null
  /** The investments-first retry already ran: a second NO_ACCOUNTS is an error, never another round. */
  retried?: boolean
}
/** Link's funnel events, for the server's log (Plaid recommends it). Never carries a token. */
export interface LinkEvent {
  event: string
  linkSessionId?: string
  institutionId?: string
  errorType?: string
  errorCode?: string
  requestId?: string
}

type PlaidMeta = {
  link_session_id?: string
  request_id?: string
  institution?: { name?: string; institution_id?: string } | null
  /** onEvent's metadata is flat: the institution sits here, not under `institution` (that's onSuccess and onExit). */
  institution_id?: string | null
  institution_name?: string | null
  accounts?: Array<{ mask?: string | null; subtype?: string | null }>
  error_type?: string | null
  error_code?: string | null
}

interface PlaidHandler {
  open(): void
  destroy(): void
}
interface PlaidGlobal {
  create(o: {
    token: string
    receivedRedirectUri?: string
    onSuccess(publicToken: string, metadata: PlaidMeta): void
    onExit(err: { display_message?: string | null; error_type?: string | null; error_code?: string | null } | null, metadata?: PlaidMeta): void
    onEvent?(eventName: string, metadata: PlaidMeta): void
  }): PlaidHandler
}

let loading: Promise<PlaidGlobal> | null = null
/** Fetch Plaid's script ahead of the press (the connect drawer opening), so "Choose your bank" opens at once. */
export function preloadPlaid(): void {
  if (typeof document === 'undefined') return
  load().catch(() => {})
}

function load(): Promise<PlaidGlobal> {
  const w = window as unknown as { Plaid?: PlaidGlobal }
  if (w.Plaid) return Promise.resolve(w.Plaid)
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = SRC
    s.async = true
    s.onload = () => (w.Plaid ? resolve(w.Plaid) : reject(new Error('Plaid didn’t load.')))
    s.onerror = () => {
      loading = null
      reject(new Error('Couldn’t reach Plaid. Check your connection and try again.'))
    }
    document.head.append(s)
  })
  return loading
}

export const savePending = (p: Pending) => {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* private mode: OAuth banks then need a fresh start */
  }
}
/** Reads the pending attempt without taking it (the return view takes it). */
export function peekPending(): Pending | null {
  try {
    const v = sessionStorage.getItem(KEY)
    return v ? (JSON.parse(v) as Pending) : null
  } catch {
    return null
  }
}
/** Where an OAuth bank lands in the app: the page it was connected from (an onboarding step stays on that step). */
export function plaidReturnHash(): string {
  const back = peekPending()?.returnTo
  return `/#${back && /^\/[A-Za-z0-9/_-]{0,80}$/.test(back) ? back : '/'}?d=plaid-return`
}
export function takePending(): Pending | null {
  try {
    const v = sessionStorage.getItem(KEY)
    sessionStorage.removeItem(KEY)
    return v ? (JSON.parse(v) as Pending) : null
  } catch {
    return null
  }
}

let current: { close: () => void } | null = null

/** Closes an open Link (its iframe sits over the app) when the connect drawer closes or the route changes. */
export function closePlaidLink(): void {
  current?.close()
  current = null
}

// Link closed with an error (Plaid's onExit). Branch on error_code, never on the message (Plaid ITEM-002); a null error
// is the person closing it, and nothing is said (WEB-003).
/** Not enabled for this app at that bank yet: registration pending (Plaid's institution errors). */
const NOT_YET = new Set(['INSTITUTION_REGISTRATION_REQUIRED', 'UNAUTHORIZED_INSTITUTION', 'INSTITUTION_NOT_ENABLED_IN_ENVIRONMENT'])
/** A login with no accounts for the products asked (a brokerage-only login): worth one retry asking for investments first. */
export const INVESTMENTS_RETRY = new Set(['NO_ACCOUNTS', 'PRODUCTS_NOT_SUPPORTED'])
/** The bank itself is down or slow for now. */
const BANK_DOWN = new Set(['INSTITUTION_DOWN', 'INSTITUTION_NOT_RESPONDING', 'INSTITUTION_NOT_AVAILABLE'])

/** Link closed on an error. `kind` tells the drawer how to say it: not_yet is a plain line, not a failure. */
export class PlaidExitError extends Error {
  readonly kind: 'not_yet' | 'bank_down' | 'other'
  readonly code: string | null
  constructor(message: string, kind: 'not_yet' | 'bank_down' | 'other', code: string | null) {
    super(message)
    this.kind = kind
    this.code = code
  }
}

/** What to say when Link closes: null when the person just closed it. */
export function plaidExit(err: { display_message?: string | null; error_code?: string | null } | null, bank?: string | null): PlaidExitError | null {
  if (!err) return null
  const code = err.error_code ?? null
  const name = bank?.trim() || 'This bank'
  if (code && NOT_YET.has(code)) return new PlaidExitError(`${name} isn’t available through Plaid for us yet. We’ve asked, and it usually takes up to 2 weeks. Try another bank meanwhile.`, 'not_yet', code)
  if (code && BANK_DOWN.has(code)) return new PlaidExitError(`${name} isn’t responding right now. Try again later, or try another bank.`, 'bank_down', code)
  return new PlaidExitError(err.display_message || 'Your bank didn’t connect. Try again, or try another bank.', 'other', code)
}

/** How long an exit waits for Link's late events (most arrive at session end, Plaid WEB-007). */
const LATE_EVENTS_MS = 600

/**
 * Opens Link; resolves with the public token, or null when the person closes it. With `noAccounts`, a session where
 * Link showed NO_ACCOUNTS (it sends the person back to the bank list rather than exiting) ends in a NO_ACCOUNTS error
 * whatever onExit says, so a new connect can ask once more with investments first.
 */
export async function openPlaidLink(linkToken: string, receivedRedirectUri?: string, onEvent?: (e: LinkEvent) => void, opts?: { noAccounts?: boolean }): Promise<PlaidSuccess | null> {
  const Plaid = await load()
  closePlaidLink()
  return new Promise((resolve, reject) => {
    let sawNoAccounts = false
    let sawExitEvent = false
    let pendingExit: (() => void) | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const settleExit = () => {
      clearTimeout(timer)
      const f = pendingExit
      pendingExit = null
      f?.()
    }
    const h = Plaid.create({
      token: linkToken,
      ...(receivedRedirectUri ? { receivedRedirectUri } : {}),
      onSuccess: (publicToken, metadata) => {
        h.destroy()
        current = null
        const inst = metadata.institution
        const accounts = (metadata.accounts ?? []).map((x) => ({ ...(x.mask ? { mask: x.mask } : {}), ...(x.subtype ? { subtype: x.subtype } : {}) }))
        resolve({
          publicToken,
          ...(inst ? { institution: { ...(inst.name ? { name: inst.name } : {}), ...(inst.institution_id ? { institution_id: inst.institution_id } : {}) } } : {}),
          ...(accounts.length ? { accounts } : {}),
          ...(metadata.link_session_id ? { linkSessionId: metadata.link_session_id } : {}),
        })
      },
      onExit: (err, metadata) => {
        h.destroy()
        current = null
        log(onEvent, 'EXIT', metadata, err)
        const finish = () => {
          const e = opts?.noAccounts && sawNoAccounts ? new PlaidExitError(plaidExit(err, metadata?.institution?.name)?.message ?? 'Your bank didn’t connect. Try again, or try another bank.', 'other', 'NO_ACCOUNTS') : plaidExit(err, metadata?.institution?.name)
          e ? reject(e) : resolve(null)
        }
        // Already a retry code, or nothing to wait for: decide now.
        if (!opts?.noAccounts || sawNoAccounts || sawExitEvent || INVESTMENTS_RETRY.has(err?.error_code ?? '')) return finish()
        pendingExit = finish
        timer = setTimeout(settleExit, LATE_EVENTS_MS)
      },
      onEvent: (eventName, metadata) => {
        log(onEvent, eventName, metadata)
        if (eventName === 'ERROR' && metadata?.error_code === 'NO_ACCOUNTS') sawNoAccounts = true
        if (eventName === 'EXIT') {
          sawExitEvent = true
          settleExit()
        }
      },
    })
    const me = {
      close: () => {
        h.destroy()
        resolve(null)
      },
    }
    current = me
    h.open()
  })
}

function log(onEvent: ((e: LinkEvent) => void) | undefined, event: string, m?: PlaidMeta, err?: { error_type?: string | null; error_code?: string | null } | null) {
  if (!onEvent) return
  const errorType = err?.error_type ?? m?.error_type
  const errorCode = err?.error_code ?? m?.error_code
  try {
    onEvent({
      event,
      ...(m?.link_session_id ? { linkSessionId: m.link_session_id } : {}),
      ...((m?.institution?.institution_id ?? m?.institution_id) ? { institutionId: (m?.institution?.institution_id ?? m?.institution_id)! } : {}),
      ...(errorType ? { errorType } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(m?.request_id ? { requestId: m.request_id } : {}),
    })
  } catch {
    /* logging never breaks Link */
  }
}
