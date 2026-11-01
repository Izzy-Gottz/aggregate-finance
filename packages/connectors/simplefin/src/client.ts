// SimpleFIN HTTP client. The user pastes a one-time Setup Token (base64 of a claim URL); claiming it with a POST
// returns the Access URL (https://user:pass@host/path), which is the secret. Requests send the user:pass as Basic
// auth and never put the credentials in a URL that could be logged.

import { ConnectorError, HttpClient, providerMessage, type ConnectorDeps, type HttpErrorInfo, type HttpRequest } from '@agfn/connector-sdk'

/** Hosts a hosted Aggregate accepts for claim and access URLs (SimpleFIN Bridge). Self-hosters can allow any https host. */
export const SIMPLEFIN_HOSTS = ['bridge.simplefin.org', 'beta-bridge.simplefin.org']

export function classifySimplefinError({ status, body }: HttpErrorInfo): ConnectorError {
  const { message } = providerMessage(body)
  const opts = { provider: 'simplefin', status }
  if (status === 402) return new ConnectorError('auth', 'SimpleFIN says the subscription needs a payment. Renew it at SimpleFIN Bridge, then sync again', { ...opts, forUser: true })
  if (status === 401 || status === 403) return new ConnectorError('auth', 'SimpleFIN refused access: the access was revoked or the token was already used. Create a new Setup Token and reconnect', { ...opts, forUser: true })
  if (status === 429) return new ConnectorError('rate_limited', 'SimpleFIN daily request limit reached', opts)
  if (status >= 500 || status === 408) return new ConnectorError('transient', message ?? `SimpleFIN HTTP ${status}`, opts)
  if (status === 400) return new ConnectorError('invalid_input', message ?? 'SimpleFIN rejected the request', opts)
  return new ConnectorError('permanent', message ?? `SimpleFIN HTTP ${status}`, opts)
}

function checkHost(u: URL, anyHost: boolean, what: string): void {
  if (u.protocol !== 'https:') throw new ConnectorError('invalid_input', `the SimpleFIN ${what} must be https`, { provider: 'simplefin' })
  if (!anyHost && (!SIMPLEFIN_HOSTS.includes(u.hostname) || (u.port !== '' && u.port !== '443'))) {
    throw new ConnectorError('invalid_input', `the SimpleFIN ${what} must point at SimpleFIN Bridge (${SIMPLEFIN_HOSTS[0]})`, { provider: 'simplefin' })
  }
}

/** Decodes a Setup Token into its claim URL (validated). */
export function claimUrlOf(setupToken: string, anyHost = false): URL {
  const t = setupToken.trim()
  let decoded: string
  try {
    if (!/^[A-Za-z0-9+/=_-]+$/.test(t)) throw new Error('not base64')
    decoded = Buffer.from(t, 'base64').toString('utf8').trim()
  } catch {
    throw new ConnectorError('invalid_input', 'that is not a SimpleFIN Setup Token (copy the long token from SimpleFIN Bridge)', { provider: 'simplefin' })
  }
  let u: URL
  try {
    u = new URL(decoded)
  } catch {
    throw new ConnectorError('invalid_input', 'that is not a SimpleFIN Setup Token (copy the long token from SimpleFIN Bridge)', { provider: 'simplefin' })
  }
  checkHost(u, anyHost, 'Setup Token')
  return u
}

export interface ParsedAccessUrl {
  base: string
  username: string
  password: string
}

export function parseAccessUrl(accessUrl: string, anyHost = false): ParsedAccessUrl {
  let u: URL
  try {
    u = new URL(accessUrl.trim())
  } catch {
    throw new ConnectorError('invalid_input', 'SimpleFIN returned an unusable Access URL', { provider: 'simplefin' })
  }
  checkHost(u, anyHost, 'Access URL')
  const username = decodeURIComponent(u.username)
  const password = decodeURIComponent(u.password)
  if (!username || !password) throw new ConnectorError('invalid_input', 'SimpleFIN returned an Access URL without credentials', { provider: 'simplefin' })
  u.username = ''
  u.password = ''
  return { base: u.toString().replace(/\/+$/, ''), username, password }
}

const httpOpts = (deps: Omit<ConnectorDeps, 'raw'>) => ({
  ...(deps.fetch ? { fetch: deps.fetch } : {}),
  ...(deps.clock ? { clock: deps.clock } : {}),
  ...(deps.random ? { random: deps.random } : {}),
})

/** POSTs the claim URL once; returns the Access URL. A 403 means the token was used before (maybe by someone else). */
export async function claimAccessUrl(claim: URL, deps: Omit<ConnectorDeps, 'raw'>): Promise<string> {
  const http = new HttpClient({
    provider: 'simplefin',
    baseUrl: claim.origin,
    ...httpOpts(deps),
    classifyError: (info) =>
      info.status === 403
        ? new ConnectorError(
            'invalid_input',
            'SimpleFIN says this Setup Token was already used. Create a new one; if you did not use it yourself, disable the old access in SimpleFIN Bridge',
            { provider: 'simplefin', status: 403, forUser: true },
          )
        : classifySimplefinError(info),
  })
  try {
    const res = await http.request<string>({ method: 'POST', path: claim.pathname + claim.search, body: '', responseType: 'text' })
    return String(res.data).trim()
  } catch (e) {
    // The claim may have gone through even though no answer came back: the token is then used up.
    if (e instanceof ConnectorError && e.kind === 'transient') {
      throw new ConnectorError('transient', 'SimpleFIN didn’t answer in time. If trying again says the token was already used, create a new Setup Token in SimpleFIN Bridge', { provider: 'simplefin', forUser: true })
    }
    throw e
  }
}

export class SimplefinClient {
  private readonly http: HttpClient

  constructor(access: ParsedAccessUrl, deps: Omit<ConnectorDeps, 'raw'>) {
    this.http = new HttpClient({
      provider: 'simplefin',
      baseUrl: access.base,
      ...httpOpts(deps),
      headers: { authorization: `Basic ${Buffer.from(`${access.username}:${access.password}`).toString('base64')}` },
      // The Bridge allows about 24 requests a day per access token; pacing within a run doesn't matter, but retries
      // spend that quota (and a token pushed past its warnings is disabled), so a failing request is tried twice at most.
      rateLimit: { perSecond: 1, burst: 2 },
      retry: { maxAttempts: 2 },
      classifyError: classifySimplefinError,
    })
  }

  async accounts<T>(query: HttpRequest['query']): Promise<T> {
    const res = await this.http.request<T>({ path: '/accounts', query: { version: 2, ...query } })
    return res.data
  }
}
