// RevenueCat REST API v2 client: https://api.revenuecat.com/v2, Bearer secret key. Aggregate only ever issues GETs.
//
// Limits are per domain: Customer Information 480 a minute, Project Configuration 60 a minute. Each domain gets its own
// HttpClient so product reads don't eat into customer reads. 429s wait for Retry-After through the SDK.

import { ConnectorError, HttpClient, isRecord, type ConnectorDeps, type ConnectorErrorKind } from '@agfn/connector-sdk'

export const REVENUECAT_BASE = 'https://api.revenuecat.com/v2'

type Query = Record<string, string | number | undefined>

/** Errors: { type, message, retryable, doc_url, backoff_ms }. */
export function classifyRevenueCatError(status: number, body: unknown): ConnectorError {
  const b = isRecord(body) ? body : {}
  const message = (typeof b.message === 'string' && b.message) || `RevenueCat HTTP ${status}`
  const code = typeof b.type === 'string' ? b.type : undefined
  let kind: ConnectorErrorKind
  if (status === 401 || status === 403) kind = 'auth'
  else if (status === 429) kind = 'rate_limited'
  // 423: RevenueCat is busy with this customer. Its docs mark it as worth retrying.
  else if (status === 423 || status === 408 || status >= 500) kind = 'transient'
  else if (status === 400 || status === 422) kind = 'invalid_input'
  else kind = 'permanent'
  return new ConnectorError(kind, message.slice(0, 300), {
    provider: 'revenuecat',
    status,
    ...(code ? { code } : {}),
    ...(typeof b.backoff_ms === 'number' ? { retryAfterMs: b.backoff_ms } : {}),
  })
}

export class RevenueCatClient {
  private readonly customers: HttpClient
  private readonly config: HttpClient

  constructor(apiKey: string, deps: Omit<ConnectorDeps, 'raw'>) {
    const http = (rateLimit: { perSecond: number; burst: number }) =>
      new HttpClient({
        provider: 'revenuecat',
        baseUrl: REVENUECAT_BASE,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.clock ? { clock: deps.clock } : {}),
        ...(deps.random ? { random: deps.random } : {}),
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        rateLimit,
        classifyError: ({ status, body }) => classifyRevenueCatError(status, body),
      })
    this.customers = http({ perSecond: 7, burst: 8 })
    this.config = http({ perSecond: 0.9, burst: 3 })
  }

  /** Customer Information domain. */
  async get<T>(path: string, query?: Query): Promise<T> {
    return (await this.customers.request<T>({ path, ...(query ? { query } : {}) })).data
  }

  /** Project Configuration domain. */
  async getConfig<T>(path: string, query?: Query): Promise<T> {
    return (await this.config.request<T>({ path, ...(query ? { query } : {}) })).data
  }
}
