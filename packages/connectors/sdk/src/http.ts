// One HTTP client for every connector: timeouts, retries with exponential backoff + full jitter, Retry-After,
// a token-bucket rate limiter, and error classification into ConnectorError. Request bodies and auth headers
// are never put into error messages or logs.

import { ConnectorError, kindForStatus } from './errors.ts'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface RetryPolicy {
  /** Total attempts including the first. */
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 30_000 }

export interface Clock {
  now(): number
  sleep(ms: number): Promise<void>
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/** Token bucket: `ratePerSecond` steady rate, up to `burst` requests at once. */
export class RateLimiter {
  private readonly ratePerSecond: number
  private readonly burst: number
  private readonly clock: Clock
  private tokens: number
  private last: number
  private queue: Promise<void> = Promise.resolve()

  constructor(ratePerSecond: number, burst: number = Math.max(1, Math.ceil(ratePerSecond)), clock: Clock = systemClock) {
    if (!(ratePerSecond > 0)) throw new RangeError('ratePerSecond must be > 0')
    this.ratePerSecond = ratePerSecond
    this.burst = burst
    this.clock = clock
    this.tokens = this.burst
    this.last = clock.now()
  }

  /** Resolves when a request may be sent. Calls are served in order. */
  acquire(): Promise<void> {
    const next = this.queue.then(() => this.take())
    this.queue = next.catch(() => undefined)
    return next
  }

  /** Called when the provider says to back off: drain tokens so following calls wait too. */
  penalize(ms: number): void {
    this.tokens = Math.min(this.tokens, 0) - (ms / 1000) * this.ratePerSecond
  }

  private async take(): Promise<void> {
    for (;;) {
      const now = this.clock.now()
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSecond)
      this.last = now
      if (this.tokens >= 1) {
        this.tokens -= 1
        return
      }
      await this.clock.sleep(Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1000))
    }
  }
}

export interface HttpErrorInfo {
  status: number
  headers: Headers
  body: unknown
}

export interface HttpClientOptions {
  provider: string
  baseUrl: string
  fetch?: FetchLike
  retry?: Partial<RetryPolicy>
  /** Steady requests per second allowed against this provider (per client instance). */
  rateLimit?: { perSecond: number; burst?: number }
  timeoutMs?: number
  /**
   * Longest provider-requested wait (Retry-After) we sleep through in-process. A longer one (e.g. a daily quota)
   * is thrown at once as rate_limited with retryAfterMs set, so the scheduler retries later. Default 2 minutes.
   */
  maxRetryAfterMs?: number
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>)
  clock?: Clock
  random?: () => number
  /**
   * Turn a non-2xx response into an error. Return undefined to use the default
   * (status → kind, provider message from common body shapes).
   */
  classifyError?: (info: HttpErrorInfo) => ConnectorError | undefined
  /**
   * Response header carrying the provider's request id (QuickBooks `intuit_tid`, Xero `xero-correlation-id`). On an
   * error it becomes ConnectorError.requestId (safe to log, and what provider support asks for).
   */
  requestIdHeader?: string
}

export interface HttpRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Path appended to baseUrl, or an absolute https URL (pagination links). */
  path: string
  query?: Record<string, string | number | boolean | undefined | null | Array<string | number>>
  headers?: Record<string, string>
  json?: unknown
  form?: Record<string, string>
  /** Raw body (already encoded). */
  body?: string
  /** POSTs are only retried when marked idempotent (read endpoints, or a request carrying an idempotency key). */
  idempotent?: boolean
  responseType?: 'json' | 'text' | 'bytes'
}

export interface HttpResponse<T> {
  status: number
  headers: Headers
  data: T
}

export class HttpClient {
  readonly provider: string
  private readonly baseUrl: string
  private readonly fetchFn: FetchLike
  private readonly retry: RetryPolicy
  private readonly limiter: RateLimiter | undefined
  private readonly timeoutMs: number
  private readonly clock: Clock
  private readonly random: () => number
  private readonly opts: HttpClientOptions

  constructor(opts: HttpClientOptions) {
    this.opts = opts
    this.provider = opts.provider
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init))
    this.retry = { ...DEFAULT_RETRY, ...opts.retry }
    this.clock = opts.clock ?? systemClock
    this.random = opts.random ?? Math.random
    this.timeoutMs = opts.timeoutMs ?? 30_000
    this.limiter = opts.rateLimit
      ? new RateLimiter(opts.rateLimit.perSecond, opts.rateLimit.burst, this.clock)
      : undefined
  }

  url(path: string, query?: HttpRequest['query']): string {
    const u = new URL(/^https?:\/\//.test(path) ? path : this.baseUrl + (path.startsWith('/') ? path : '/' + path))
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null) continue
      if (Array.isArray(v)) for (const item of v) u.searchParams.append(k, String(item))
      else u.searchParams.set(k, String(v))
    }
    return u.toString()
  }

  async request<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>> {
    const method = req.method ?? 'GET'
    const retryable = req.idempotent ?? (method === 'GET' || method === 'PUT' || method === 'DELETE')
    const url = this.url(req.path, req.query)
    let attempt = 0
    for (;;) {
      attempt++
      try {
        return await this.once<T>(method, url, req)
      } catch (e) {
        const err = toConnectorError(e, this.provider)
        if (!retryable || !err.retryable || attempt >= this.retry.maxAttempts) throw err
        if (err.retryAfterMs !== undefined && err.retryAfterMs > (this.opts.maxRetryAfterMs ?? 120_000)) throw err
        const backoff = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** (attempt - 1))
        const delay = err.retryAfterMs ?? Math.floor(this.random() * backoff)
        if (err.kind === 'rate_limited') this.limiter?.penalize(delay)
        await this.clock.sleep(delay)
      }
    }
  }

  private async once<T>(method: string, url: string, req: HttpRequest): Promise<HttpResponse<T>> {
    await this.limiter?.acquire()
    const base = typeof this.opts.headers === 'function' ? await this.opts.headers() : (this.opts.headers ?? {})
    const headers: Record<string, string> = { accept: 'application/json', ...base, ...req.headers }
    let body: string | undefined = req.body
    if (req.json !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(req.json)
    } else if (req.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      body = new URLSearchParams(req.form).toString()
    }

    let res: Response
    try {
      res = await this.fetchFn(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      // A guarded fetch's own refusal (a blocked address) says what it is; it isn't a network error to retry.
      if (e instanceof ConnectorError) throw e
      const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
      throw new ConnectorError('transient', timeout ? 'request timed out' : 'network error', {
        provider: this.provider,
        cause: e,
      })
    }

    if (!res.ok) {
      const parsed = await readBody(res, 'json').catch(() => undefined)
      const info: HttpErrorInfo = { status: res.status, headers: res.headers, body: parsed }
      const custom = this.opts.classifyError?.(info)
      const err = redactSent(custom ?? defaultError(this.provider, info), sentValues(url, headers, req))
      throw withRequestId(withRetryAfter(err, res.headers, this.clock), this.opts.requestIdHeader ? res.headers.get(this.opts.requestIdHeader) : null)
    }
    const data = (await readBody(res, req.responseType ?? 'json')) as T
    return { status: res.status, headers: res.headers, data }
  }
}

async function readBody(res: Response, type: 'json' | 'text' | 'bytes'): Promise<unknown> {
  if (type === 'bytes') return new Uint8Array(await res.arrayBuffer())
  const text = await res.text()
  if (type === 'text') return text
  if (text === '') return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

/**
 * What we sent that may be a credential: auth and other non-standard header values (Basic decoded into its id and
 * secret), body and form values, query values. Short values are skipped (they can't be secrets and would mangle
 * the message).
 */
function sentValues(url: string, headers: Record<string, string>, req: HttpRequest): string[] {
  const out: string[] = []
  const add = (v: unknown) => {
    if (typeof v === 'string' && v.length >= 8) out.push(v)
    else if (v && typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) add(x)
  }
  for (const [k, v] of Object.entries(headers)) {
    if (/^(accept|content-type|user-agent)$/i.test(k)) continue
    add(v)
    const [scheme, token] = v.split(/\s+/, 2)
    if (token && /^basic$/i.test(scheme ?? '')) {
      const decoded = Buffer.from(token, 'base64').toString('utf8')
      add(token)
      for (const part of decoded.split(':')) add(safeDecode(part))
    } else if (token) add(token)
  }
  add(req.json)
  add(req.form)
  if (typeof req.body === 'string') for (const [, v] of new URLSearchParams(req.body)) add(v)
  for (const [, v] of new URL(url).searchParams) add(v)
  return out.sort((a, b) => b.length - a.length)
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v)
  } catch {
    return v
  }
}

/** A provider that reflects our request in its error (some echo the client_secret back) must not leak it onward. */
function redactSent(err: ConnectorError, sent: string[]): ConnectorError {
  const scrub = (t: string) => sent.reduce((acc, v) => acc.split(v).join('[redacted]'), t)
  const message = scrub(err.message)
  const code = err.code === undefined ? undefined : scrub(err.code)
  if (message === err.message && code === err.code) return err
  return new ConnectorError(err.kind, message, {
    provider: err.provider,
    ...(err.status !== undefined ? { status: err.status } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
    ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
  })
}

/** Pull a human message out of the usual provider error shapes, without echoing anything else. */
export function providerMessage(body: unknown): { message?: string; code?: string } {
  if (typeof body === 'string') return { message: body.slice(0, 300) }
  if (!body || typeof body !== 'object') return {}
  const b = body as Record<string, unknown>
  const nested = (b.error && typeof b.error === 'object' ? b.error : b) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 300) : undefined)
  const message =
    str(nested.message) ?? str(nested.error_message) ?? str(nested.detail) ?? str(b.message) ?? str(b.error) ?? str(b.title)
  const code = str(nested.code) ?? str(nested.error_code) ?? str(nested.type) ?? str(b.code)
  return { ...(message ? { message } : {}), ...(code ? { code } : {}) }
}

function defaultError(provider: string, info: HttpErrorInfo): ConnectorError {
  const { message, code } = providerMessage(info.body)
  return new ConnectorError(kindForStatus(info.status), message ?? `HTTP ${info.status}`, {
    provider,
    status: info.status,
    ...(code ? { code } : {}),
  })
}

function withRetryAfter(err: ConnectorError, headers: Headers, clock: Clock): ConnectorError {
  if (!err.retryable) return err
  // The provider's own Retry-After wins over a connector's default wait (a guess for when it sends none).
  const ms = parseRetryAfter(headers.get('retry-after'), clock.now())
  if (ms === undefined || ms === err.retryAfterMs) return err
  return new ConnectorError(err.kind, err.message, {
    provider: err.provider,
    retryAfterMs: ms,
    ...(err.status !== undefined ? { status: err.status } : {}),
    ...(err.code !== undefined ? { code: err.code } : {}),
    ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
  })
}

/** The provider's request id from the response, unless the connector already set one. Ids only: short, no spaces. */
function withRequestId(err: ConnectorError, id: string | null): ConnectorError {
  const v = id?.trim()
  if (!v || err.requestId !== undefined || !/^[A-Za-z0-9._:-]{1,128}$/.test(v)) return err
  return new ConnectorError(err.kind, err.message, {
    provider: err.provider,
    requestId: v,
    ...(err.status !== undefined ? { status: err.status } : {}),
    ...(err.code !== undefined ? { code: err.code } : {}),
    ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
  })
}

/** Retry-After is either delta-seconds or an HTTP date. Returned uncapped; HttpClient decides whether to wait. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined
  if (/^\d+(\.\d+)?$/.test(value.trim())) return Math.ceil(Number(value) * 1000)
  const at = Date.parse(value)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - now)
}

export function toConnectorError(e: unknown, provider: string): ConnectorError {
  if (e instanceof ConnectorError) return e
  return new ConnectorError('transient', e instanceof Error ? e.message : 'unknown error', { provider, cause: e })
}
