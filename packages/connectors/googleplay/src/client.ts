// Google Play reports live in the developer's Cloud Storage bucket (gs://pubsite_prod_rev_…). This client mints an
// access token from the service account (cached until a minute before expiry), lists objects and downloads them.
// Read-only scope (devstorage.read_only); no write endpoint exists in this client.

import type { KeyObject } from 'node:crypto'
import { ConnectorError, HttpClient, isRecord, systemClock, type Clock, type ConnectorDeps, type ConnectorErrorKind } from '@agfn/connector-sdk'
import { GOOGLE_TOKEN_URL, JWT_BEARER_GRANT, loadRsaKey, serviceAccountAssertion, type ServiceAccount } from './auth.ts'

export const GCS_BASE = 'https://storage.googleapis.com'

export interface GcsObject {
  name: string
  /** Decimal string; changes whenever the object is rewritten. */
  generation: string
  size?: string
  updated?: string
}

interface GcsList {
  items?: GcsObject[]
  nextPageToken?: string
}

/** GCS errors: { error: { code, message, errors: [{ reason }] } }; token endpoint: { error, error_description }. */
export function classifyGoogleError(status: number, body: unknown): ConnectorError {
  let message = `Google HTTP ${status}`
  let code: string | undefined
  if (isRecord(body)) {
    if (isRecord(body.error)) {
      if (typeof body.error.message === 'string') message = body.error.message
      const first = Array.isArray(body.error.errors) && isRecord(body.error.errors[0]) ? body.error.errors[0] : undefined
      if (first && typeof first.reason === 'string') code = first.reason
    } else if (typeof body.error === 'string') {
      code = body.error
      message = typeof body.error_description === 'string' ? body.error_description : body.error
    }
  }
  let kind: ConnectorErrorKind
  if (status === 401 || code === 'invalid_grant' || code === 'invalid_client' || code === 'unauthorized_client') kind = 'auth'
  else if (status === 403) {
    kind = 'auth'
    message = `The service account can't read the reports bucket (${message}). In Play Console, invite it with "View financial data" set to Global.`
  } else if (status === 429) kind = 'rate_limited'
  else if (status >= 500 || status === 408) kind = 'transient'
  else if (status === 400) kind = 'invalid_input'
  else kind = 'permanent'
  return new ConnectorError(kind, message.slice(0, 300), { provider: 'googleplay', status, ...(code ? { code } : {}) })
}

export class GooglePlayClient {
  readonly bucket: string
  private readonly sa: ServiceAccount
  private readonly key: KeyObject
  private readonly clock: Clock
  private readonly oauth: HttpClient
  private readonly gcs: HttpClient
  private token: { value: string; until: number } | undefined

  constructor(sa: ServiceAccount, bucket: string, deps: Omit<ConnectorDeps, 'raw'>) {
    this.sa = sa
    this.bucket = bucket
    this.key = loadRsaKey(sa.privateKey)
    this.clock = deps.clock ?? systemClock
    const common = {
      provider: 'googleplay',
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      classifyError: ({ status, body }: { status: number; body: unknown }) => classifyGoogleError(status, body),
    }
    this.oauth = new HttpClient({ ...common, baseUrl: GOOGLE_TOKEN_URL })
    this.gcs = new HttpClient({
      ...common,
      baseUrl: GCS_BASE,
      headers: async () => ({ authorization: `Bearer ${await this.accessToken()}` }),
      rateLimit: { perSecond: 5, burst: 10 },
      timeoutMs: 120_000,
    })
  }

  async accessToken(): Promise<string> {
    const now = this.clock.now()
    if (this.token && this.token.until > now) return this.token.value
    const res = await this.oauth.request<{ access_token?: string; expires_in?: number }>({
      method: 'POST',
      path: GOOGLE_TOKEN_URL,
      form: { grant_type: JWT_BEARER_GRANT, assertion: serviceAccountAssertion(this.sa, now, this.key) },
      // Minting a token changes nothing: safe to retry.
      idempotent: true,
    })
    const value = res.data.access_token
    if (!value) throw new ConnectorError('auth', 'Google token endpoint returned no access_token', { provider: 'googleplay' })
    const ttl = Math.max(60, res.data.expires_in ?? 3600)
    this.token = { value, until: now + (ttl - 60) * 1000 }
    return value
  }

  /** Every object under a prefix (follows nextPageToken). */
  async list(prefix: string, maxResults?: number): Promise<GcsObject[]> {
    const out: GcsObject[] = []
    let pageToken: string | undefined
    do {
      const res = await this.gcs.request<GcsList>({
        path: `/storage/v1/b/${encodeURIComponent(this.bucket)}/o`,
        query: { prefix, pageToken, maxResults },
      })
      // A present bucket listing with no `items` is a real empty prefix; a null/non-object body (an empty body, or the
      // sign-in/error page the shared client rejects as non-JSON) is unreadable and must stop, never read as no files.
      if (!isRecord(res.data as unknown)) throw new ConnectorError('transient', 'Google Play sent a response Aggregate couldn’t read, so this sync stopped. No totals were changed.', { provider: 'googleplay' })
      out.push(...(Array.isArray(res.data.items) ? res.data.items : []))
      pageToken = maxResults ? undefined : res.data.nextPageToken
    } while (pageToken)
    return out
  }

  async download(name: string, generation: string): Promise<Uint8Array> {
    const res = await this.gcs.request<Uint8Array>({
      path: `/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(name)}`,
      query: { alt: 'media', generation },
      responseType: 'bytes',
    })
    return res.data
  }
}
