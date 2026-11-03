// The proof Wix's install redirect carries. The redirect names a site, and anyone can type a URL, so instanceId counts only when
// signedInstance vouches for it: "<signature>.<data>", both base64url, signed with HMAC-SHA256 over the data with the app's
// secret. The owner check is here too: Wix allows payment details for site owners only, and a site's contributors can install.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { ConnectorError, isRecord } from '@agfn/connector-sdk'

/** A signed instance older than this isn't an install that just finished. */
const FRESH_MS = 3_600_000

const refused = (why: string) => new ConnectorError('auth', `Wix install ${why}`, { provider: 'wix' })
export const WIX_OWNER_ONLY = 'Only the site’s owner can connect Wix, because the totals come from its payments. Ask the owner to connect it.'

const b64url = (s: string) => Buffer.from(s, 'base64url')

/** The site this install belongs to. Throws unless the signature, the instance, the age and the owner all hold. */
export function verifySignedInstance(signed: string, instanceId: string, secret: string, nowMs: number): string {
  const parts = signed.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw refused('is malformed')
  const [sig, data] = parts as [string, string]
  const want = createHmac('sha256', secret).update(data).digest()
  const given = b64url(sig)
  if (given.length !== want.length || !timingSafeEqual(given, want)) throw refused('has a bad signature')
  let claims: unknown
  try {
    claims = JSON.parse(b64url(data).toString('utf8'))
  } catch {
    throw refused('is malformed')
  }
  if (!isRecord(claims)) throw refused('is malformed')
  if (typeof claims.instanceId !== 'string' || !claims.instanceId || claims.instanceId !== instanceId) throw refused('is for another site')
  const signedAt = typeof claims.signDate === 'string' ? Date.parse(claims.signDate) : NaN
  if (!Number.isFinite(signedAt) || nowMs - signedAt > FRESH_MS) throw refused('is too old')
  const owner = claims.permissions === 'OWNER' || (typeof claims.uid === 'string' && claims.uid !== '' && claims.uid === claims.siteOwnerId)
  if (!owner) throw new ConnectorError('auth', WIX_OWNER_ONLY, { provider: 'wix', forUser: true })
  return claims.instanceId
}
