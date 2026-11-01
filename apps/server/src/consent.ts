import { HTTPException } from 'hono/http-exception'
import { AI_DISCLOSURE } from '@agfn/contracts'

/**
 * The AI disclosure a page showed, kept on the grant as consent evidence (Intuit, case #00231347, 2026-10-27). A page
 * showing an older version is refused so the person reads the current line. A caller that sent no version (scripts,
 * an older page) gets a grant with no evidence rather than a record of a line it never showed.
 */
export function consentShown(version: unknown, text: string): { version: string; text: string } | undefined {
  if (version === undefined || version === null) return undefined
  if (version !== AI_DISCLOSURE.version) {
    const body = { message: 'This page is out of date. Reload this page and try again.', error: 'consent_outdated' }
    throw new HTTPException(409, { res: new Response(JSON.stringify(body), { status: 409, headers: { 'content-type': 'application/json' } }) })
  }
  return { version: AI_DISCLOSURE.version, text }
}
