// An AI's authorization (the consent page, #/connect-ai/consent?…) that a brand-new account reached before it had a
// workspace: kept for this tab while first-run setup asks for the company name, then resumed, so the AI app waiting
// for its callback gets it. Only ever a consent route.
import { parseHash } from '../app/router.ts'

const KEY = 'agfn.pending-consent'
/** Better Auth's signed authorize query doesn't outlive this anyway. */
const TTL = 30 * 60 * 1000

export function keepConsent(hash: string): void {
  if (parseHash(hash).page !== 'consent') return
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ hash, at: Date.now() }))
  } catch {
    /* storage blocked: setup ends on the Workspace as before */
  }
}

export function peekConsent(): string | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as { hash?: string; at?: number } | null
    return v?.hash && v.at && Date.now() - v.at < TTL && parseHash(v.hash).page === 'consent' ? v.hash : null
  } catch {
    return null
  }
}

export function takeConsent(): string | null {
  const h = peekConsent()
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
  return h
}
