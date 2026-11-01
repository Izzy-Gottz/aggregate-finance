// "Confirm it's you" by email: the link (opened on any device) confirms for 10 minutes and brings the person back here.

/** This page, marked so the app can offer "Add a passkey on this device" when they come back. Extra params ride along. */
export function returnHere(extra: Record<string, string> = {}): string {
  const hash = location.hash || '#/'
  const params = new URLSearchParams({ ...extra, rechecked: '1' }).toString()
  return location.pathname + hash + (hash.includes('?') ? '&' : '?') + params
}

/** Said the same way everywhere. */
export const recheckSentLine = (to: string) => `Check your email at ${to} and open the link on any device. Then come back and try again.`

/**
 * A check by email (the link, or its code) counts on the server for 10 minutes. Remember when, for this tab, so a reload
 * doesn't ask again before trying (9 minutes, to stay inside the server's window). Never the code, only the time.
 */
const RECHECK_KEY = 'agfn.rechecked'
export function markRechecked(now = Date.now()): void {
  try {
    sessionStorage.setItem(RECHECK_KEY, String(now))
  } catch {
    // Storage off: the next connect asks again, as before.
  }
}
export function recentlyRechecked(now = Date.now()): boolean {
  try {
    const at = Number(sessionStorage.getItem(RECHECK_KEY))
    return at > 0 && now - at < 9 * 60_000
  } catch {
    return false
  }
}
export function forgetRechecked(): void {
  try {
    sessionStorage.removeItem(RECHECK_KEY)
  } catch {
    // Storage off: nothing remembered.
  }
}
