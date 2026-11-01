// Every connector failure is a ConnectorError with a kind the sync engine can act on:
// retry later, ask the user to reconnect, or surface a permanent problem.

export type ConnectorErrorKind =
  /** Credentials rejected or revoked: user must reconnect (Plaid ITEM_LOGIN_REQUIRED, 401s). */
  | 'auth'
  /** Provider throttled us; retry after `retryAfterMs`. */
  | 'rate_limited'
  /** Network failure, timeout, 5xx: safe to retry. */
  | 'transient'
  /** Bad request, missing permission, unsupported account: retrying won't help. */
  | 'permanent'
  /** Caller passed bad input (e.g. malformed key, unparsable file). */
  | 'invalid_input'
  /** The stored cursor is no longer valid; restart from null. */
  | 'cursor_invalid'

export interface ConnectorErrorOptions {
  provider: string
  status?: number
  code?: string
  retryAfterMs?: number
  /** Provider request id (Plaid request_id): safe to log, and what provider support asks for. */
  requestId?: string
  /** The message was written for the person using Aggregate and is shown as is. Provider text never is (plainError). */
  forUser?: boolean
  cause?: unknown
}

export class ConnectorError extends Error {
  readonly kind: ConnectorErrorKind
  readonly provider: string
  readonly status?: number
  readonly code?: string
  readonly retryAfterMs?: number
  readonly requestId?: string
  readonly forUser?: boolean

  constructor(kind: ConnectorErrorKind, message: string, opts: ConnectorErrorOptions) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause })
    this.name = 'ConnectorError'
    this.kind = kind
    this.provider = opts.provider
    if (opts.status !== undefined) this.status = opts.status
    if (opts.code !== undefined) this.code = opts.code
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs
    if (opts.requestId !== undefined) this.requestId = opts.requestId
    if (opts.forUser) this.forUser = true
  }

  get retryable(): boolean {
    return this.kind === 'transient' || this.kind === 'rate_limited'
  }
}

export function isConnectorError(e: unknown): e is ConnectorError {
  return e instanceof ConnectorError
}

/** Default mapping from an HTTP status to an error kind. Connectors refine with provider error codes. */
export function kindForStatus(status: number): ConnectorErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limited'
  if (status === 408 || status >= 500) return 'transient'
  return 'permanent'
}

/** Missing permission rather than a dead login: a 403, or a provider code that says scope/permission. */
function isPermission(e: ConnectorError): boolean {
  return e.status === 403 || /scope|permission|forbidden|access_denied|not_authorized/i.test(e.code ?? '')
}

/**
 * What a person sees when a connector fails: a sentence they can act on, never the provider's own text (that stays in
 * the log with its request id). A connector's hand-written message (forUser) is shown as is. `connect` is the paste-key
 * or sign-in step; `sync` is a background sync, shown on the connection with a Reconnect path.
 */
export function plainError(err: unknown, name: string, phase: 'sync' | 'connect' = 'sync'): { status: 'needs_reauth' | 'error'; message: string } {
  if (!isConnectorError(err)) {
    return phase === 'connect'
      ? { status: 'error', message: `${name} didn’t accept that. Try again.` }
      : { status: 'error', message: `Aggregate couldn’t finish syncing ${name}. It will try again; if this keeps happening, reconnect ${name}.` }
  }
  const status = err.kind === 'auth' ? 'needs_reauth' : 'error'
  if (err.forUser) return { status, message: err.message }
  // Our own check of what was pasted ("the Mercury token must not contain spaces"): no provider was asked.
  if (phase === 'connect' && err.kind === 'invalid_input' && err.status === undefined) return { status, message: `${name} didn’t accept that: ${err.message}` }
  switch (err.kind) {
    case 'auth':
      if (isPermission(err)) {
        return phase === 'connect'
          ? { status, message: `${name} signed in, but didn’t allow Aggregate to read. Allow read access (or use a read-only key with access to accounts and transactions) and try again.` }
          : { status, message: `${name} isn’t allowing Aggregate to read this any more. Reconnect ${name} and allow read access.` }
      }
      return phase === 'connect'
        ? { status, message: `${name} didn’t accept that. Check it’s copied in full and still active, then try again.` }
        : { status, message: `${name} access was removed or has expired. Reconnect to keep syncing.` }
    case 'rate_limited':
      return { status, message: `${name} is limiting how fast Aggregate can read right now. ${phase === 'connect' ? 'Wait a minute and try again.' : 'It will try again shortly.'}` }
    case 'transient':
      return { status, message: `${name} isn’t responding right now. ${phase === 'connect' ? 'Try again in a few minutes.' : 'Aggregate will try again shortly.'}` }
    default:
      return phase === 'connect'
        ? { status, message: `${name} didn’t accept that. Try again.` }
        : { status, message: `Aggregate couldn’t read ${name} just now. Sync now to try again; if this keeps happening, reconnect ${name}.` }
  }
}
