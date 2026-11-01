// Root: loads the session and workspace, owns the route (hash), the company scope and the toast.
import { leaveFor } from './navigate.ts'
import { endPublicDemo, publicDemoOn } from '../lib/demo.ts'
import { NewVersion } from './new-version.ts'
import { EmailCode } from '../ui/email-code.ts'
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { Me, AgfnApi, SignInMethod, Workspace } from '../api/types.ts'
import { html } from '../ui/html.ts'
import { AppCtx, isReviewer, type App, type Toast } from './context.ts'
import { markRechecked, returnHere, recheckSentLine } from '../lib/recheck.ts'
import { passkeyName, passkeysAvailable } from '../lib/passkey.ts'
import { Drawers } from './drawers.ts'
import { formatHash, parseHash, type Route, type View } from './router.ts'
import { Shell } from '../screens/shell.ts'
import { WorkspacePage } from '../screens/workspace.ts'
import { ReviewPage } from '../screens/review.ts'
import { PreferencesPage } from '../screens/preferences.ts'
import { ClaimInvitePage, SignInPage, WelcomePage } from '../screens/onboarding.ts'
import { ConsentPage } from '../screens/ai.ts'
import { connectIntent, keepIntent, peekIntent, takeIntent } from '../lib/deeplink.ts'
import { keepConsent, peekConsent, takeConsent } from '../lib/pending-consent.ts'
import { Palette } from '../screens/palette.ts'

const SCOPE_KEY = 'agfn.scope'
/** Where someone was when their session ran out, so signing in again (even from an emailed link) lands there. */
const RETURN_KEY = 'agfn.return'
const remember = (hash: string) => {
  try {
    localStorage.setItem(RETURN_KEY, JSON.stringify({ hash, at: Date.now() }))
  } catch {
    /* ignore */
  }
}
const recall = (): string | null => {
  try {
    const v = JSON.parse(localStorage.getItem(RETURN_KEY) ?? 'null') as { hash?: string; at?: number } | null
    localStorage.removeItem(RETURN_KEY)
    return v?.hash && v.at && Date.now() - v.at < 60 * 60 * 1000 ? v.hash : null
  } catch {
    return null
  }
}
const readScope = () => {
  try {
    return localStorage.getItem(SCOPE_KEY)
  } catch {
    return null
  }
}

export interface RootProps {
  api: AgfnApi
  /** Injectable clock for tests and screenshots. */
  now?: () => number
}

export function Root({ api, now = Date.now }: RootProps) {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash))
  const [me, setMe] = useState<Me | null | undefined>(undefined)
  const [ws, setWs] = useState<Workspace | null>(null)
  const [scope, setScopeState] = useState<string | null>(readScope)
  const [toast, setToast] = useState<Toast | null>(null)
  const [palette, setPalette] = useState(() => new URLSearchParams(location.search).has('palette'))
  const toastTimer = useRef<ReturnType<typeof setTimeout>>()
  const invited = useRef<string | null>(null)
  /** An invite sent to another address (Hide My Email, a work address) that this account may take: asked first. */
  const [claim, setClaim] = useState<{ id: string; workspaceName: string; inviterName: string; invitedEmail: string } | null>(null)
  /** The server couldn't be reached on first load: one line and Try again (later failures keep what's on screen). */
  const [down, setDown] = useState(false)
  const loaded = useRef(false)
  const resumed = useRef(false)
  /** Someone was signed in during this page's life (so a later 401 means the session ran out). */
  const hadSession = useRef(false)
  /** A deliberate sign-out (account deleted) is underway: its 401s aren't a session running out. */
  const leaving = useRef(false)
  // Bumped by leave(): a refresh that started before (say, mid account deletion) mustn't sign them back in.
  const epoch = useRef(0)
  const [signInNote, setSignInNote] = useState<string | null>(null)
  /** A passkey check didn't happen: "Use email instead", then "Check your email…". */
  const [confirmIt, setConfirmIt] = useState<{ step: 'ask' } | { step: 'sent'; to: string } | { step: 'error'; text: string } | null>(null)
  /** Signed out mid-session (the cookie expired): say so on the sign-in page. */
  const [expired, setExpired] = useState(false)
  // Signed out: ask the server which sign-in buttons it actually has (Apple/Google only when configured).
  const [signInMethods, setSignInMethods] = useState<SignInMethod[] | null>(null)
  useEffect(() => {
    if (me === null && !signInMethods) api.signInMethods().then(setSignInMethods, () => {})
  }, [me])

  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash))
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])

  const reload = useCallback(async () => {
    try {
      await load()
      loaded.current = true
      setDown(false)
    } catch {
      // Only the first load shows "can't reach"; a failed refresh keeps the last good state on screen.
      if (!loaded.current) setDown(true)
    }
  }, [api])
  const load = async () => {
    const started = epoch.current
    let m = await api.me()
    // Shopify install started while signed out: hand back to Shopify's consent once (the server clears it on resume).
    if (m?.pendingInstall === 'shopify' && !resumed.current) {
      resumed.current = true
      location.assign('/api/connectors/shopify/install/resume')
      return
    }
    // Arrived from an invite email (/?invite=<id>): open the workspace they were invited to, greet them, tidy the URL.
    const query = new URLSearchParams(location.search)
    const inviteId = query.get('invite')
    // A sign-in or invite link opened after it expired (or a second time) comes back signed out with ?error=…TOKEN.
    // An invite outlives its 10-minute link (7 days, and the membership already exists), so say how to get a new one.
    if (!m && /^(EXPIRED|INVALID)_TOKEN$/.test(query.get('error') ?? ''))
      setSignInNote(inviteId ? 'That invite link has expired or was already used. Your invite still stands: enter the email it was sent to for a new sign-in link.' : 'That sign-in link has expired or was already used. Enter your email for a new one.')
    if (m && inviteId) {
      history.replaceState(null, '', location.pathname + location.hash)
      const inv = await api.inviteInfo(inviteId).catch(() => null)
      if (inv?.claim) setClaim({ id: inviteId, workspaceName: inv.workspaceName, inviterName: inv.inviterName, invitedEmail: inv.invitedEmail ?? 'another address' })
      else if (inv) {
        api.setWorkspace(inv.workspaceId)
        m = await api.me().catch(() => m)
        invited.current = `${inv.inviterName} invited you to ${inv.workspaceName}. Welcome.`
      }
    }
    // Demo mode asked for, but this browser is signed in: the person's own books, never the demo.
    if (m && !m.publicDemo && publicDemoOn()) endPublicDemo()
    // Order matters: ws before me, so the routing effect never sees a signed-in person with a stale workspace.
    const w = m && !m.needsOnboarding ? await api.workspace() : null
    // Companies first, Personal last, whatever order the server sends.
    if (w) w.entities = [...w.entities.filter((e) => e.kind !== 'personal'), ...w.entities.filter((e) => e.kind === 'personal')]
    if (started !== epoch.current) return
    setWs(w)
    setMe(m)
    if (m) {
      hadSession.current = true
      leaving.current = false
      setSignInNote(null)
    }
  }
  useEffect(() => {
    reload()
  }, [reload])
  // Keep the Workspace current while any connection is importing (status, "synced …", cash), and when the tab comes back.
  const syncing = !!ws?.connections.some((c) => c.status === 'syncing')
  useEffect(() => {
    if (!syncing) return
    const t = setInterval(() => void reload(), 5000)
    return () => clearInterval(t)
  }, [syncing, reload])
  useEffect(() => {
    const on = () => document.visibilityState === 'visible' && void reload()
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [reload])

  const go = useCallback((r: Partial<Route>) => {
    const cur = parseHash(location.hash)
    const next = { ...cur, ...r }
    if (r.page && r.page !== cur.page && !r.params) next.params = {}
    const h = formatHash(next)
    // Update state directly (hashchange may be async or absent); the listener then sees the same route.
    setRoute(next)
    if (h !== location.hash) location.hash = h
  }, [])

  const app = useMemo<App>(
    () => ({
      api,
      me: me ?? null,
      ws,
      reload,
      route,
      go,
      open: (v: View) => go({ stack: [v] }),
      push: (v: View) => go({ stack: [...parseHash(location.hash).stack, v] }),
      back: () => go({ stack: parseHash(location.hash).stack.slice(0, -1) }),
      close: () => go({ stack: [] }),
      scope: ws && scope && ws.entities.some((e) => e.id === scope) ? scope : null,
      setScope: (id) => {
        setScopeState(id)
        try {
          id ? localStorage.setItem(SCOPE_KEY, id) : localStorage.removeItem(SCOPE_KEY)
        } catch {
          /* ignore */
        }
      },
      leave: (note) => {
        leaving.current = true
        epoch.current++
        setSignInNote(note)
        setExpired(false)
        setWs(null)
        setMe(null)
        try {
          localStorage.removeItem(RETURN_KEY)
        } catch {
          /* ignore */
        }
        go({ page: 'signin', step: 0, stack: [], params: {} })
      },
      toast: (t) => {
        setToast(t)
        clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(null), t.undo ? 10_000 : 4000)
      },
      now,
    }),
    [api, me, ws, reload, route, go, scope, now],
  )

  useEffect(() => {
    if (ws && invited.current) {
      app.toast({ text: invited.current })
      invited.current = null
    }
  }, [ws])

  // The session ran out mid-use (any call answered 401): remember where they were, then ask them to sign in again.
  useEffect(() => {
    const on = () => {
      // A first visit also answers 401 to "who am I?": that isn't a session ending, so say nothing and remember nothing.
      if (!loaded.current || !hadSession.current || leaving.current) return
      if (!['signin', 'welcome', 'consent'].includes(parseHash(location.hash).page)) remember(location.hash)
      setExpired(true)
      setWs(null)
      setMe(null)
    }
    addEventListener('agfn:signed-out', on)
    return () => removeEventListener('agfn:signed-out', on)
  }, [])

  // Any passkey prompt that didn't happen (cancelled, none on this device, http://LAN) can use an emailed link instead.
  // The delete dialogs say this themselves, inline.
  useEffect(() => {
    const on = () => {
      const top = parseHash(location.hash).stack.at(-1)?.kind
      // The consent page (approving an AI) asks inline, with its own buttons.
      if (top === 'delete-me' || top === 'delete-workspace' || parseHash(location.hash).page === 'consent') return
      setConfirmIt({ step: 'ask' })
    }
    addEventListener('agfn:recheck-needed', on)
    return () => removeEventListener('agfn:recheck-needed', on)
  }, [])
  const emailMe = async () => {
    try {
      const r = await api.recheckByEmail(returnHere())
      setConfirmIt({ step: 'sent', to: r.sentTo })
    } catch (e) {
      setConfirmIt({ step: 'error', text: e instanceof Error ? e.message : 'That didn’t send. Try again in a minute.' })
    }
  }

  // Signed out → sign in. Signed in with no companies → onboarding. Signed back in → where they were.
  useEffect(() => {
    // A connect link (#/?d=connect:stripe) is kept before sign-in or first-run setup sends them elsewhere.
    const intent = (me === null && route.page !== 'signin') || me?.needsOnboarding ? connectIntent(location.hash) : null
    if (intent) keepIntent(intent)
    if (me === null && route.page !== 'signin') go({ page: 'signin', stack: [] })
    // An AI app sent a brand-new account here to approve it: keep its authorization through the company-name step.
    if (me?.needsOnboarding && route.page === 'consent') keepConsent(location.hash)
    if (me?.needsOnboarding && !(route.page === 'welcome' && route.step === 1)) go({ page: 'welcome', step: 1, stack: [] })
    // Setup has a workspace now: straight back to approving the AI (the rest of setup can wait; the app offers it).
    else if (me && !me.needsOnboarding && (route.page === 'welcome' || route.page === 'workspace') && peekConsent()) {
      const back = takeConsent()!
      location.hash = back
      setRoute(parseHash(back))
    }
    else if (me && route.page === 'signin') {
      setExpired(false)
      const back = recall()
      back ? ((location.hash = back), setRoute(parseHash(back))) : go({ page: 'workspace', step: 0, stack: [] })
    }
  }, [me, ws, route.page])

  // Back from an emailed check: it counts for 10 minutes, remembered for this tab (lib/recheck.ts).
  useEffect(() => {
    if (route.params.rechecked === '1') markRechecked()
  }, [route.params.rechecked])

  // ⌘K / Ctrl+K anywhere; "A" adds (when not typing). Signed in only: on the sign-in page a typed email isn't a shortcut.
  const inApp = useRef(false)
  inApp.current = !!me && !!ws && !me.needsOnboarding && route.page !== 'signin' && route.page !== 'welcome' && route.page !== 'consent'
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!inApp.current) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette((v) => !v)
        return
      }
      const t = e.target
      const typing = t instanceof Element && !!t.closest('input,textarea,select,[contenteditable]')
      if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'a' && !document.querySelector('.drawer,.palette')) {
        e.preventDefault()
        go({ stack: [{ kind: 'add', what: 'cash' }] })
      }
    }
    document.addEventListener('keydown', on)
    return () => document.removeEventListener('keydown', on)
  }, [go])

  // OAuth connectors come back with ?connect_error=<plain message> when cancelled or failed.
  useEffect(() => {
    const msg = route.params.connect_error
    if (!msg) return
    // Cancelling at the provider is a choice, not an error; an attempt that sat too long just needs another go.
    const plain = /^(access_denied|consent_required|user_cancelled|login_required)$/i.test(msg) || /^the (user|resource owner) (denied|cancel)/i.test(msg)
      ? 'Nothing was connected. You can try again anytime.'
      : /expired|timed? ?out|took too long/i.test(msg)
        ? 'That took too long. Try again.'
        : msg
    const { connect_error: _e, connector, ...rest } = route.params
    // Back on the same connector's drawer with one calm line and its usual button, never a dead end.
    if (connector && /^[\w.-]{1,40}$/.test(connector)) go({ stack: [{ kind: 'connect', key: connector }], params: { ...rest, connect_note: plain } })
    else {
      app.toast({ text: plain })
      go({ params: rest })
    }
  }, [route.params.connect_error])

  // A kept connect link opens once there's a workspace: on setup's "Connect your money" step, or the first app page.
  useEffect(() => {
    if (!me || me.needsOnboarding || !ws || !peekIntent()) return
    const ready = (route.page === 'welcome' && route.step === 2) || ['workspace', 'review', 'preferences'].includes(route.page)
    if (!ready || isReviewer({ me, ws })) return
    const key = takeIntent()
    if (key && !(route.stack.length === 1 && route.stack[0]!.kind === 'connect')) go({ stack: [{ kind: 'connect', key }] })
  }, [me, ws, route.page, route.step])

  // Page titles for screen readers and tabs.
  useEffect(() => {
    const t = { workspace: 'Workspace', review: 'Review', preferences: 'Preferences', signin: 'Sign in', welcome: 'Get started', consent: 'Connect your AI' }[route.page]
    document.title = `${t} · Aggregate`
  }, [route.page])

  // Connecting a Shopify store: sign in (or sign up) with the store's staff email, which the link needs.
  const shopifyNote = route.params.signin_for === 'shopify' ? 'Use your Shopify email: sign in or sign up with the email you use for your Shopify store, then the store connects.' : undefined
  const prefill = typeof route.params.signin_email === 'string' && /^[^@\s]+@[^@\s]+$/.test(route.params.signin_email) ? route.params.signin_email : undefined
  // On an AI's OAuth login page (#/sign-in?client_id=…, query exactly as Better Auth signed it), signing in carries on
  // the authorization to the consent page instead of landing in the Workspace. Passkey and reviewer code sign in here;
  // they don't leave the page.
  const oauthLogin = route.page === 'signin' && !!route.params.client_id ? location.hash.slice(location.hash.indexOf('?') + 1) : null
  const afterSignIn = async () => {
    if (oauthLogin) {
      const next = await api.continueOAuthLogin(oauthLogin).catch(() => null)
      if (next) return leaveFor(next)
    }
    await reload()
  }
  let page
  if (me === undefined && down)
    page = html`<div class="solo"><div class="wordmark">Aggregate</div><p class="sub" role="alert" style="margin-top:24px">Can’t reach Aggregate right now.</p><p style="margin-top:16px"><button type="button" class="btn" onClick=${reload}>Try again</button></p></div>`
  else if (me === undefined) page = html`<div class="solo" aria-busy="true"><div class="wordmark">Aggregate</div></div>`
  else if (route.page === 'signin' || me === null)
    page = html`<${SignInPage} methods=${me?.signInMethods ?? signInMethods ?? undefined} onSignedIn=${afterSignIn} email=${prefill} note=${expired ? 'You were signed out. Sign in to pick up where you left off.' : (shopifyNote ?? signInNote ?? undefined)} />`
  else if (claim)
    page = html`<${ClaimInvitePage} claim=${claim} email=${me.email} onDone=${async (joined: boolean) => {
      setClaim(null)
      if (!joined) return
      await reload()
      go({ page: 'workspace', step: 0, stack: [] })
      app.toast({ text: `Welcome to ${claim.workspaceName}.` })
    }} />`
  else if (route.page === 'welcome') page = html`<${WelcomePage} />`
  else if (route.page === 'consent') page = html`<${ConsentPage} />`
  else
    page = html`<${Shell} onSearch=${() => setPalette(true)}>
      ${route.page === 'review' ? html`<${ReviewPage} />` : route.page === 'preferences' && !me?.publicDemo ? html`<${PreferencesPage} />` : html`<${WorkspacePage} />`}
    </${Shell}>`

  return html`<${AppCtx.Provider} value=${app}>
    ${page}
    ${me && ws ? html`<${Drawers} />` : null}
    ${me && ws && palette ? html`<${Palette} onClose=${() => setPalette(false)} />` : null}
    ${me && confirmIt && !isReviewer({ me, ws })
      ? html`<div class="toast" role="status">
          <span>${confirmIt.step === 'ask' ? 'Confirm it’s you to continue.' : confirmIt.step === 'sent' ? recheckSentLine(confirmIt.to) : confirmIt.text}</span>
          ${confirmIt.step === 'ask' ? html`<button type="button" onClick=${emailMe}>Use email instead</button>` : null}
          ${confirmIt.step === 'sent' ? html`<${EmailCode} kind="recheck" onDone=${() => (setConfirmIt(null), app.toast({ text: 'Confirmed. You can continue.' }))} onResend=${emailMe} />` : null}
          <button type="button" aria-label="Close" onClick=${() => setConfirmIt(null)}>×</button>
        </div>`
      : me && route.params.rechecked === '1' && !toast
        ? html`<${AddPasskeyHere} onDone=${() => {
            const { rechecked: _r, ...rest } = route.params
            go({ params: rest })
          }} />`
        : null}
    ${toast ? null : html`<${NewVersion} />`}
    ${toast ? html`<div class="toast" role="status">${toast.text}${toast.undo ? html`<button type="button" onClick=${() => (toast.undo?.(), setToast(null))}>Undo</button>` : null}</div>` : null}
  </${AppCtx.Provider}>`
}

/** Back from an emailed check: confirmed for 10 minutes. Offer a passkey so next time is one tap (where passkeys work). */
function AddPasskeyHere({ onDone }: { onDone: () => void }) {
  const app = useContext(AppCtx)!
  // The passkey sheet must open straight from the click (Safari), so its options are fetched ahead.
  const [ceremony, setCeremony] = useState<((name: string) => Promise<boolean>) | null>(null)
  useEffect(() => {
    if (!passkeysAvailable()) return
    let live = true
    app.api.preparePasskey().then((f) => live && setCeremony(() => f), () => {})
    return () => void (live = false)
  }, [])
  const add = async () => {
    const ok = ceremony ? await ceremony(passkeyName()).catch(() => false) : false
    onDone()
    app.toast({ text: ok ? 'Passkey added. Next time it’s one tap.' : 'No passkey added. You can add one in Preferences.' })
  }
  return html`<div class="toast" role="status">
    <span>Confirmed. You can continue.</span>
    ${passkeysAvailable() ? html`<button type="button" onClick=${add} disabled=${!ceremony}>Add a passkey on this device</button>` : null}
    <button type="button" aria-label="Close" onClick=${onDone}>×</button>
  </div>`
}
