import { passkeyName, passkeysAvailable } from './lib/passkey.ts'
import { render } from 'preact'
import './ui/tokens.css'
import './ui/ui.css'
import { HttpApi } from './api/http.ts'
import { MockApi } from './api/mock.ts'
import { gridFor } from './lib/roles.ts'
import type { AgfnApi } from './api/types.ts'
import { Root } from './app/app.ts'
import { applyTheme, initialTheme } from './app/theme.ts'
import { html } from './ui/html.ts'
import { PLAID_REDIRECT } from './screens/connections.ts'
import { plaidReturnHash } from './lib/plaid.ts'

// A --mock build (or ?api=mock on the dev server) runs the demo workspace in the browser, with no server.
// ?empty starts the mock signed in with no companies (onboarding); ?signedout starts at sign-in.
// Production builds define AGFN_API as 'http', so this folds to false and the mock isn't bundled (~40 KB less).
declare const AGFN_API: 'http' | 'dev' | 'mock'
const q = new URLSearchParams(location.search)
// ?team: a real (not demo) workspace with a second owner and an admin who joined, so Remove and Leave show.
// ?claim (with ?invite=…): the invite went to another address, so "Join … with this account?" shows.
function previewMock(m: MockApi): MockApi {
  if (q.has('team')) {
    m.s.me.demo = false
    m.s.prefs.people.push(
      { id: 'p_sam', name: 'Sam Lee', email: 'sam@acme.example', role: 'admin', entityIds: 'all', grid: gridFor('admin'), pending: false },
      { id: 'p_ana', name: 'Ana Ortiz', email: 'ana@acme.example', role: 'owner', entityIds: 'all', grid: gridFor('owner'), pending: false },
    )
    m.affectedByDelete = [
      { personId: 'p_ana', name: 'Ana Ortiz', email: 'ana@acme.example', personalConnections: 1 },
      { personId: 'p_sam', name: 'Sam Lee', email: 'sam@acme.example', personalConnections: 2 },
    ]
  }
  if (q.has('claim')) m.inviteClaim = { invitedEmail: 'dana@work.example' }
  return m
}
const api: AgfnApi = AGFN_API === 'mock' || (AGFN_API === 'dev' && q.get('api') === 'mock')
  ? previewMock(new MockApi({ latency: 120, empty: q.has('empty'), signedIn: !q.has('signedout') }))
  : (() => {
      const http: HttpApi = new HttpApi({
        // The app remembers where you were and asks you to sign in again (app.ts listens).
        onSignedOut: () => dispatchEvent(new Event('agfn:signed-out')),
        // A passkey check that didn't happen: the app offers "Use email instead" (app.ts listens).
        onRecheckFailed: () => dispatchEvent(new Event('agfn:recheck-needed')),
        recheck: () => (passkeysAvailable() ? http.passkey().catch(() => false) : Promise.resolve(false)),
        setupPasskey: () => http.addPasskey(passkeyName()).catch(() => false),
      })
      return http
    })()

// Plaid OAuth banks return to /connect/plaid/oauth (linkRedirectUri). Keep the full URL for Link, then continue in-app.
if (location.pathname === '/connect/plaid/oauth') {
  try {
    sessionStorage.setItem(PLAID_REDIRECT, location.href)
  } catch {
    /* ignore */
  }
  history.replaceState(null, '', plaidReturnHash())
}

applyTheme(initialTheme())
render(html`<${Root} api=${api} />`, document.getElementById('app')!)

