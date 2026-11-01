// Plaid webhooks. Verification follows Plaid's documented scheme: the Plaid-Verification header is an ES256 JWT whose
// key (by kid) comes from /webhook_verification_key/get; its payload has iat (≤ 5 minutes old) and
// request_body_sha256, which must equal the SHA-256 of the exact body. A verified webhook only tells us which Item
// to sync or flag for relink; the data itself is always pulled from the API.

import { createHash, createPublicKey, timingSafeEqual, verify, type JsonWebKey } from 'node:crypto'
import { ConnectorError, isRecord, systemClock, type Clock, type WebhookOutcome, type WebhookRequest, header } from '@agfn/connector-sdk'
import { RELINK_CODES, type PlaidClient } from './client.ts'
import type { PlaidWebhookBody } from './types.ts'

const MAX_AGE_MS = 5 * 60_000

interface CachedKey {
  jwk: JsonWebKey
  expiredAt: number | null
}

export class PlaidWebhookVerifier {
  private readonly client: PlaidClient
  private readonly clock: Clock
  private readonly keys = new Map<string, CachedKey>()

  constructor(client: PlaidClient, clock: Clock = systemClock) {
    this.client = client
    this.clock = clock
  }

  /** Throws ConnectorError('auth') when the webhook is not authentic. */
  async verify(req: WebhookRequest): Promise<void> {
    const token = header(req, 'plaid-verification')
    if (!token) throw reject('missing Plaid-Verification header')
    const parts = token.split('.')
    if (parts.length !== 3) throw reject('malformed JWT')
    const [h64, p64, s64] = parts as [string, string, string]
    const head = parseJson(h64)
    if (!isRecord(head) || head.alg !== 'ES256' || typeof head.kid !== 'string') throw reject('unexpected JWT header')

    const key = await this.key(head.kid)
    const ok = verify(
      'sha256',
      Buffer.from(`${h64}.${p64}`),
      { key: createPublicKey({ key: key, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
      Buffer.from(s64, 'base64url'),
    )
    if (!ok) throw reject('bad signature')

    const payload = parseJson(p64)
    if (!isRecord(payload) || typeof payload.iat !== 'number' || typeof payload.request_body_sha256 !== 'string') {
      throw reject('unexpected JWT payload')
    }
    if (this.clock.now() - payload.iat * 1000 > MAX_AGE_MS) throw reject('webhook too old')
    const want = Buffer.from(createHash('sha256').update(req.body, 'utf8').digest('hex'))
    const got = Buffer.from(payload.request_body_sha256)
    if (want.length !== got.length || !timingSafeEqual(want, got)) throw reject('body hash mismatch')
  }

  private async key(kid: string): Promise<JsonWebKey> {
    const cached = this.keys.get(kid)
    if (cached && (cached.expiredAt === null || cached.expiredAt > this.clock.now())) return cached.jwk
    const d = await this.client.call<{ key: JsonWebKey & { expired_at?: number | null } }>('/webhook_verification_key/get', { key_id: kid })
    const { expired_at, ...jwk } = d.key
    const expiredAt = typeof expired_at === 'number' ? expired_at * 1000 : null
    if (expiredAt !== null && expiredAt <= this.clock.now()) throw reject('verification key expired')
    this.keys.set(kid, { jwk, expiredAt })
    return jwk
  }
}

function parseJson(b64: string): unknown {
  try {
    return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
}

function reject(msg: string): ConnectorError {
  return new ConnectorError('auth', `Plaid webhook rejected: ${msg}`, { provider: 'plaid' })
}

/** Decide what a (verified) webhook means. Unknown types are ignored, never trusted. */
export function interpretPlaidWebhook(req: WebhookRequest): WebhookOutcome {
  const dedupeKey = 'plaid:' + createHash('sha256').update(req.body, 'utf8').digest('hex')
  let body: PlaidWebhookBody
  try {
    body = JSON.parse(req.body) as PlaidWebhookBody
  } catch {
    return { action: 'ignore', dedupeKey, reason: 'unparsable body' }
  }
  if (!isRecord(body) || typeof body.webhook_type !== 'string' || typeof body.webhook_code !== 'string') {
    return { action: 'ignore', dedupeKey, reason: 'not a Plaid webhook' }
  }
  const match = typeof body.item_id === 'string' ? { field: 'itemId', value: body.item_id } : undefined
  const out = (action: WebhookOutcome['action'], reason: string): WebhookOutcome => ({
    action,
    dedupeKey,
    reason,
    ...(match ? { match } : {}),
  })
  const t = `${body.webhook_type}.${body.webhook_code}`
  switch (t) {
    // Webhooks are triggers, never data: each of these just pulls fresh state from the API.
    case 'TRANSACTIONS.SYNC_UPDATES_AVAILABLE':
    case 'HOLDINGS.DEFAULT_UPDATE':
    case 'INVESTMENTS_TRANSACTIONS.DEFAULT_UPDATE':
    case 'INVESTMENTS_TRANSACTIONS.HISTORICAL_UPDATE':
    case 'LIABILITIES.DEFAULT_UPDATE':
      return out('sync', t)
    // Legacy /transactions/get webhooks; this connector uses /transactions/sync, whose own webhook covers them.
    case 'TRANSACTIONS.DEFAULT_UPDATE':
    case 'TRANSACTIONS.INITIAL_UPDATE':
    case 'TRANSACTIONS.HISTORICAL_UPDATE':
    case 'TRANSACTIONS.TRANSACTIONS_REMOVED':
      return out('ignore', t)
    case 'ITEM.LOGIN_REPAIRED':
      return out('repaired', t)
    case 'ITEM.NEW_ACCOUNTS_AVAILABLE':
      return out('new_accounts', t)
    // 7-day warnings (US/CA consent ending, EU/UK expiry): data still flows; ask for a reconnect before it stops.
    case 'ITEM.PENDING_EXPIRATION':
    case 'ITEM.PENDING_DISCONNECT':
      return out('reconnect_soon', t)
    case 'ITEM.USER_PERMISSION_REVOKED':
    case 'ITEM.USER_ACCOUNT_REVOKED':
      return out('disconnected', t)
    // Confirms /item/webhook/update moved this Item to a new receiver; nothing to do.
    case 'ITEM.WEBHOOK_UPDATE_ACKNOWLEDGED':
      return out('ignore', t)
    case 'ITEM.ERROR': {
      const code = body.error?.error_code
      if (code === 'ITEM_NOT_FOUND') return out('disconnected', `${t} ${code}`)
      return code && RELINK_CODES.has(code) ? out('needs_reauth', `${t} ${code}`) : out('sync', `${t} ${code ?? ''}`.trim())
    }
    default:
      return out('ignore', t)
  }
}
