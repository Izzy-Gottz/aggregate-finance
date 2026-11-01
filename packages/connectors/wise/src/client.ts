// Wise HTTP client. Auth is a personal API token (Bearer). Read-only: profiles, balances and balance statements.
// Balance statements may require SCA: see sca.ts. A 403 carrying `x-2fa-approval-result: REJECTED` and a one-time
// token becomes a WiseScaRequiredError so the caller can sign and retry.

import { ConnectorError, HttpClient, type ConnectorDeps, type HttpErrorInfo, type HttpRequest } from '@agfn/connector-sdk'
import { WiseScaRequiredError } from './sca.ts'

export const WISE_HOSTS = { production: 'https://api.wise.com', sandbox: 'https://api.wise-sandbox.com' } as const
export type WiseEnv = keyof typeof WISE_HOSTS

function wiseMessage(body: unknown): { message?: string; code?: string } {
  if (!body || typeof body !== 'object') return typeof body === 'string' && body ? { message: body.slice(0, 300) } : {}
  const b = body as Record<string, unknown>
  const first = Array.isArray(b.errors) && b.errors[0] && typeof b.errors[0] === 'object' ? (b.errors[0] as Record<string, unknown>) : undefined
  const s = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 300) : undefined)
  const message = s(first?.message) ?? s(b.error_description) ?? s(b.message) ?? s(b.error)
  const code = s(first?.code) ?? s(b.error) ?? s(b.code)
  return { ...(message ? { message } : {}), ...(code ? { code } : {}) }
}

export function classifyWiseError({ status, headers, body }: HttpErrorInfo): ConnectorError {
  const { message, code } = wiseMessage(body)
  const opts = { provider: 'wise', status, ...(code ? { code } : {}) }
  const ott = headers.get('x-2fa-approval')
  if (status === 403 && ott && (headers.get('x-2fa-approval-result') ?? '').toUpperCase() === 'REJECTED') {
    return new WiseScaRequiredError('Wise requires Strong Customer Authentication (a signed one-time token) for this request', ott, opts)
  }
  if (status === 401) {
    return new ConnectorError('auth', 'Wise rejected the personal API token; create a new token in Wise (Settings → API tokens) and reconnect', { ...opts, forUser: true })
  }
  if (status === 403) return new ConnectorError('auth', 'Wise refused access; the token may be read-limited or not allowed on this profile', { ...opts, forUser: true })
  if (status === 429) return new ConnectorError('rate_limited', message ?? 'Wise rate limit', opts)
  if (status >= 500 || status === 408) return new ConnectorError('transient', message ?? `Wise HTTP ${status}`, opts)
  if (status === 400 || status === 422) return new ConnectorError('invalid_input', message ?? 'Wise rejected the request', opts)
  return new ConnectorError('permanent', message ?? `Wise HTTP ${status}`, opts)
}

export class WiseClient {
  private readonly http: HttpClient

  constructor(token: string, deps: Omit<ConnectorDeps, 'raw'>, opts: { env?: WiseEnv; baseUrl?: string } = {}) {
    this.http = new HttpClient({
      provider: 'wise',
      baseUrl: opts.baseUrl ?? WISE_HOSTS[opts.env ?? 'production'],
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      headers: { authorization: `Bearer ${token}` },
      // Personal tokens: 100 req/s and 900 req/min per user. Stay well under.
      rateLimit: { perSecond: 5, burst: 10 },
      classifyError: classifyWiseError,
    })
  }

  async get<T>(path: string, query?: HttpRequest['query'], headers?: Record<string, string>): Promise<T> {
    const res = await this.http.request<T>({ path, ...(query ? { query } : {}), ...(headers ? { headers } : {}) })
    return res.data
  }
}
