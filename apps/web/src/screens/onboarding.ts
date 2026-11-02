// Sign in → name your first company → connect (provider's own popup) → copy AI link → first question (MASTER §4).
// Target: under 5 minutes. Every optional step has "Skip for now".
import { EmailCode } from '../ui/email-code.ts'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { SignInMethod } from '../api/types.ts'
import { isUpdating, useApp } from '../app/context.ts'
import { Button, CopyButton, PlusAction, Pluses, Row, Rows, Tile } from '../ui/components.ts'
import { passkeysAvailable } from '../lib/passkey.ts'
import { html } from '../ui/html.ts'
import { PLAN } from '../lib/support.ts'
import { Icon } from '../ui/icons.ts'
import { firstQuestions } from './ai.ts'
import { AssistantList } from './assistants.ts'
import { bankWay, PLAID_SOON, SIMPLEFIN_LINE, SourceTile, STATEMENTS_LINE, useOffered } from './workspace.ts'
import { cleanEmail } from '../lib/email.ts'
import { canTryDemo, DemoLink } from './demo-link.ts'

export const STEPS = 4

function Shell({ step, children }: { step?: number; children: unknown }) {
  return html`<main class="solo" id="main">
    ${step ? html`<div class="progress" role="progressbar" aria-label="Setup progress" aria-valuemin="1" aria-valuemax=${STEPS} aria-valuenow=${step}><span style=${{ width: `${(step / STEPS) * 100}%` }}></span></div>` : null}
    <div class="wordmark">Aggregate</div>
    <div class="card">${children}</div>
  </main>`
}

/**
 * An invite link opened by an account other than the one it went to (Apple's Hide My Email, a work address) while
 * nobody has used it: join with this account, or not. Never on its own (dc, 65c80ac9).
 */
export function ClaimInvitePage({ claim, email, onDone }: { claim: { id: string; workspaceName: string; inviterName: string; invitedEmail: string }; email: string; onDone: (joined: boolean) => void }) {
  const app = useApp()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const join = async () => {
    if (busy) return
    setBusy(true)
    setErr('')
    try {
      await app.api.acceptInvite(claim.id)
    } catch (e) {
      setBusy(false)
      return setErr(e instanceof Error && e.message ? e.message : 'That didn’t work. Ask for a new invite.')
    }
    onDone(true)
  }
  return html`<${Shell}>
    <h1>Join ${claim.workspaceName}?</h1>
    <p class="sub lead">${claim.inviterName} invited ${claim.invitedEmail}. You’re signed in as ${email}. Join with this account and that address isn’t needed.</p>
    ${err ? html`<p class="err" role="alert">${err}</p>` : null}
    <div class="stack" style="margin-top:32px"><${Button} big onClick=${join} disabled=${busy}>${busy ? 'Joining…' : 'Join with this account'}</${Button}></div>
    <p class="meta" style="margin-top:24px;text-align:center"><button type="button" class="link" onClick=${() => onDone(false)}>Not now</button></p>
  </${Shell}>`
}

/** Arrived from a creator link (/r/<code> redirects to /?ref=1). */
const referred = () => new URLSearchParams(location.search).get('ref') === '1'

export function SignInPage({ onSignedIn, methods, note, email: prefill }: { onSignedIn: () => void; methods?: SignInMethod[]; note?: string; email?: string }) {
  const app = useApp()
  // Prefilled when a flow knows the address it needs (a Shopify install: the store's staff email).
  const [email, setEmail] = useState(prefill ?? '')
  const [err, setErr] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [password, setPassword] = useState('')
  // Apple and Google only once the server says they're configured; passkey and email always work.
  // A passkey only where the browser can make one (not on http://<LAN IP>); the email link always works.
  const has = (m: SignInMethod) => (m === 'passkey' && !passkeysAvailable() ? false : methods ? methods.includes(m) : m === 'passkey' || m === 'email')
  // An app-directory reviewer's address (reviewer.ts on the server; its mail is never delivered): sign in with the
  // password they were given (the access code), the plain username/password login review forms expect.
  const reviewerLogin = has('reviewer') && isReviewerAddress(email)
  // From the homepage's Get started (?start=1): someone may be new, so the page doesn't assume an account.
  const starting = new URLSearchParams(location.search).get('start') === '1'
  const named = [has('passkey') ? 'your passkey' : null, has('google') ? 'Google' : null, has('apple') ? 'Apple' : null, has('email') ? 'email' : null].filter(Boolean) as string[]
  const ways = named.length > 1 ? `${named.slice(0, -1).join(', ')} or ${named.at(-1)}` : (named[0] ?? 'any way below')
  const signInReviewer = async () => {
    if (!password.trim()) return setErr('Enter the password you were given.')
    setErr('')
    setBusy(true)
    try {
      await app.api.reviewerSignIn(password.trim(), cleanEmail(email))
      onSignedIn()
    } catch {
      setErr('That email and password don’t match. Check them and try again.')
      setBusy(false)
    }
  }
  const go = async (m: SignInMethod) => {
    if (m === 'email' && reviewerLogin) return signInReviewer()
    setErr('')
    setBusy(true)
    const clean = cleanEmail(email)
    if (m === 'email') setEmail(clean)
    const r = await app.api.signIn(m, m === 'email' ? clean : undefined)
    setBusy(false)
    if (!r.ok) return setErr(r.message)
    if (r.next === 'check_email') return setSent(true)
    if (r.next !== 'redirect') onSignedIn()
  }
  if (sent)
    return html`<${Shell}><h1>Check your email</h1><p class="sub lead">We sent a sign-in link to ${email}. It works for 10 minutes.</p>
      <${EmailCode} kind="signin" onDone=${onSignedIn} onResend=${() => go('email')} />
      <p style="margin-top:24px"><button type="button" class="link" onClick=${() => (setSent(false), setEmail(''), setErr(''))}>Use a different email</button></p></${Shell}>`
  return html`<${Shell}>
    <h1>${starting ? 'Get started' : 'Sign in'}</h1>
    <p class="sub lead">${note ?? (starting ? `New or returning, continue with ${ways}.` : `Your money in one place, every company and your own, ready for any AI. New here? ${has('email') ? 'Enter your email' : 'Sign in any way below'} and we’ll set you up.`)}</p>
    <div class="stack" style="margin-top:32px">
      ${has('passkey') ? html`<${Button} big disabled=${busy} onClick=${() => go('passkey')}>${starting ? 'Continue with a passkey' : 'Sign in with a passkey'}</${Button}>` : null}
      ${has('apple') ? html`<${Button} big quiet disabled=${busy} onClick=${() => go('apple')}>Continue with Apple</${Button}>` : null}
      ${has('google') ? html`<${Button} big quiet disabled=${busy} onClick=${() => go('google')}>Continue with Google</${Button}>` : null}
      ${has('github') ? html`<${Button} big quiet disabled=${busy} onClick=${() => go('github')}>Continue with GitHub</${Button}>` : null}
    </div>
    ${has('email')
      ? html`<div class="or">or</div>
        <form onSubmit=${(e: Event) => (e.preventDefault(), go('email'))} novalidate>
          <label class="sr" for="email">Email</label>
          <input id="email" class="input" type="email" autocomplete="email" placeholder="you@email.com" value=${email} onInput=${(e: Event) => setEmail((e.target as HTMLInputElement).value)} />
          ${reviewerLogin
            ? html`<label class="sr" for="password">Password</label>
              <input id="password" class="input" style="margin-top:8px" type="password" autocomplete="current-password" placeholder="Password" value=${password} onInput=${(e: Event) => setPassword((e.target as HTMLInputElement).value)} />`
            : null}
          <div class="stack" style="margin-top:8px"><${Button} big quiet type="submit" disabled=${busy}>${reviewerLogin ? 'Sign in' : 'Email me a link'}</${Button}></div>
        </form>`
      : null}
    ${err ? html`<p class="err" role="alert">${err}</p>` : null}
    <p class="meta" style="margin-top:32px">Aggregate only reads your money. It can’t move it.</p>
    <p class="meta">${referred() ? `${PLAN}, then 3 months free` : PLAN}</p>
    ${has('reviewer') ? html`<${ReviewerCode} onSignedIn=${onSignedIn} />` : null}
    <p class="meta legal"><a href="/security">Security</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p>
  </${Shell}>`
}

export function WelcomePage() {
  const app = useApp()
  const step = Math.min(STEPS, app.route.step || 1)
  const next = () => app.go({ page: 'welcome', step: step + 1, stack: [] })
  const done = () => app.go({ page: 'workspace', step: 0, stack: [] })
  switch (step) {
    case 1:
      return html`<${CompanyStep} onNext=${next} />`
    case 2:
      return html`<${ConnectStep} onNext=${next} />`
    case 3:
      return html`<${AiStep} onNext=${next} onSkip=${done} />`
    default:
      return html`<${FirstQuestionStep} onDone=${done} />`
  }
}

function CompanyStep({ onNext }: { onNext: () => void }) {
  const app = useApp()
  const existing = app.ws?.entities.find((e) => e.kind === 'company')
  const [name, setName] = useState(existing?.name ?? '')
  const [err, setErr] = useState('')
  // Creating the workspace can take a while under load: one press, and the button says so (never a second workspace).
  const [saving, setSaving] = useState(false)
  const submit = async (e: Event) => {
    e.preventDefault()
    if (saving) return
    if (!name.trim()) return setErr('What’s it called? You can add more companies later.')
    setSaving(true)
    try {
      if (app.me?.needsOnboarding) await app.api.createWorkspace(name.trim())
      else if (!existing) await app.api.createCompany(name.trim())
      await app.reload()
      onNext()
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'That didn’t work. Try again.')
      setSaving(false)
    }
  }
  // No company (individuals, investors): a Personal-only workspace. Companies can still be added later.
  const [solo, setSolo] = useState(false)
  const justMe = async () => {
    if (solo) return
    setSolo(true)
    try {
      await app.api.createWorkspace(null)
      await app.reload()
      onNext()
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'That didn’t work. Try again.')
      setSolo(false)
    }
  }
  const [starting, setStarting] = useState(false)
  const tryDemo = async () => {
    if (starting) return
    setStarting(true)
    try {
      const r = await app.api.startDemo()
      app.api.setWorkspace(r.workspaceId)
      await app.reload()
      app.go({ page: 'workspace', step: 0, stack: [] })
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'That didn’t work. Try again.')
      setStarting(false)
    }
  }
  return html`<${Shell} step=${1}>
    <h1>What’s your company called?</h1>
    <p class="sub lead">You can add more companies, and your personal money, any time.</p>
    <form onSubmit=${submit} novalidate style="margin-top:28px">
      <label class="sr" for="cname">Company name</label>
      <input id="cname" class="input" value=${name} onInput=${(e: Event) => setName((e.target as HTMLInputElement).value)} placeholder="Acme Inc" autofocus />
      ${err ? html`<p class="err" role="alert">${err}</p>` : null}
      <div class="stack" style="margin-top:16px"><${Button} big type="submit" disabled=${saving || solo || starting}>${saving ? 'Setting up…' : 'Continue'}</${Button}></div>
    </form>
    ${app.me?.needsOnboarding
      ? html`<p class="meta" style="margin-top:20px">${solo
          ? 'Setting up…'
          : html`<button type="button" class="link" onClick=${justMe}>No company? Just my own money</button> · <button type="button" class="link" onClick=${justMe}>I invest in companies</button>`}</p>`
      : null}
    ${app.me?.needsOnboarding ? html`<p class="meta" style="margin-top:12px"><button type="button" class="link" onClick=${tryDemo} disabled=${starting}>${starting ? 'Setting up the demo…' : 'Or look around with made-up companies first'}</button></p>` : null}
  </${Shell}>`
}

function ConnectStep({ onNext }: { onNext: () => void }) {
  const app = useApp()
  const connected = app.ws?.connections ?? []
  const companies = (app.ws?.entities ?? []).filter((e) => e.kind === 'company')
  const open = (key: string) => () => app.open({ kind: 'connect', key })
  const solo = !companies.length
  const personalId = app.ws?.entities.find((e) => e.kind === 'personal')?.id
  // Rows follow what this server offers: no Plaid (hosted, until production keys) → SimpleFIN Bridge and a statement,
  // and a plain "coming soon"; no Stripe → Payments is Square alone.
  const offered = useOffered()
  const bank = bankWay(offered)
  const plaid = bank?.key === 'plaid'
  const choices = (opts: Array<[string, string]>) => {
    const shown = opts.filter(([k]) => offered?.has(k))
    return shown.length ? html`<span style="display:flex;gap:8px">${shown.map(([k, label]) => html`<${Button} quiet onClick=${open(k)}>${label}</${Button}>`)}</span>` : null
  }
  const upload = () => app.open({ kind: 'add', what: 'upload' })
  // "More: …" names only what this server offers (hosted has no PayPal, for one).
  const more = (names: Array<[string[], string]>, last: string) => `More: ${[...names.filter(([keys]) => keys.some((k) => offered?.has(k))).map(([, n]) => n), last].join(', ')}…`
  const bankRows = (line: string) =>
    plaid
      ? html`<${Row} icon=${html`<${SourceTile} connectorKey="plaid" />`} name="Bank or card" line=${line} right=${html`<${Button} onClick=${open('plaid')}>Connect</${Button}>`} />`
      : // No Plaid: a statement is the quickest way in, so it comes first; SimpleFIN is there for daily updates.
        html`<${Row} icon=${html`<${SourceTile} connectorKey="files" />`} name="Upload a statement" line=${STATEMENTS_LINE} right=${html`<${Button} onClick=${upload}>Upload</${Button}>`} />
          ${bank?.key === 'simplefin' ? html`<${Row} icon=${html`<${SourceTile} connectorKey="simplefin" />`} name="Bank or card" line=${SIMPLEFIN_LINE} right=${html`<${Button} quiet onClick=${open('simplefin')}>Connect</${Button}>`} />` : null}`
  return html`<${Shell} step=${2}>
    <h1>Connect your money</h1>
    <p class="sub lead">Each one opens the provider’s own sign-in. Aggregate only reads.</p>
    ${!offered
      ? html`<p class="sub" aria-busy="true" style="margin-top:20px">Loading…</p>`
      : solo
      ? html`<ul class="rows wrap" style="margin-top:20px">
          ${bankRows('Checking, savings and cards, through Plaid')}
          ${plaid ? html`<${Row} icon=${html`<${SourceTile} connectorKey="plaid" />`} name="Brokerage" line="Stocks and funds you hold, through Plaid" right=${html`<${Button} quiet onClick=${open('plaid')}>Connect</${Button}>`} />` : null}
        </ul>
        ${plaid ? null : html`<p class="meta" style="margin-top:12px">${PLAID_SOON}.</p>`}
        <${Pluses}>
          <${PlusAction} onClick=${() => app.open({ kind: 'connect' })}>${more([[['paypal'], 'PayPal'], ...(bank?.key === 'simplefin' ? [] : [[['simplefin'], 'SimpleFIN'] as [string[], string]])], 'a statement')}</${PlusAction}>
          ${personalId ? html`<${PlusAction} onClick=${() => app.open({ kind: 'stake-add', id: personalId })}>A stake in a company you invested in</${PlusAction}>` : null}
        </${Pluses}>`
      : html`<ul class="rows wrap" style="margin-top:20px">
          ${bankRows('Any US bank, through Plaid')}
          ${offered.has('quickbooks') || offered.has('xero') ? html`<${Row} icon=${html`<${SourceTile} connectorKey=${offered.has('quickbooks') ? 'quickbooks' : 'xero'} />`} name="Books" line="Invoices, bills and reports" right=${choices([['quickbooks', 'QuickBooks'], ['xero', 'Xero']])} />` : null}
          ${offered.has('stripe') || offered.has('square') ? html`<${Row} icon=${html`<${SourceTile} connectorKey=${offered.has('stripe') ? 'stripe' : 'square'} />`} name="Payments" line="Charges, payouts and fees" right=${choices([['stripe', 'Stripe'], ['square', 'Square']])} />` : null}
        </ul>
        ${plaid ? null : html`<p class="meta" style="margin-top:12px">${PLAID_SOON}.</p>`}
        <${PlusAction} onClick=${() => app.open({ kind: 'connect' })}>${more([[['shopify'], 'Shopify'], [['mercury'], 'Mercury'], [['gusto', 'rippling', 'deel', 'finch'], 'payroll']], 'a statement')}</${PlusAction}>`}
    <${AddCompany} count=${companies.length} />
    ${connected.length
      ? html`<${Rows} label="Connected">${connected.map((c) => html`<${Row} icon=${html`<${Tile} icon="check" />`} name=${c.name} line=${c.entityNames.join(', ') || 'connected'} />`)}</${Rows}>`
      : null}
    <div class="stack" style="margin-top:28px">
      <${Button} big onClick=${onNext}>${connected.length ? 'Continue' : 'Skip for now'}</${Button}>
    </div>
    ${canTryDemo(app) ? html`<${DemoLink} />` : null}
  </${Shell}>`
}

/** Skipping leaves the AI unconnected (the Workspace keeps offering it) and skips "Ask it something", which needs one. */
/** More than one company? Add the others here, one name at a time; connections then ask which company they're for. */
function AddCompany({ count }: { count: number }) {
  const app = useApp()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [err, setErr] = useState('')
  const add = async (e: Event) => {
    e.preventDefault()
    if (!name.trim()) return setErr('What’s it called?')
    try {
      await app.api.createCompany(name.trim())
      await app.reload()
      app.toast({ text: `${name.trim()} added.` })
      setName('')
      setErr('')
      setOpen(false)
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'That didn’t work. Try again.')
    }
  }
  if (!open) return html`<${PlusAction} onClick=${() => setOpen(true)}>${count > 1 ? 'Add another company' : count ? 'Have more than one company? Add another' : 'Have a company too? Add it'}</${PlusAction}>`
  return html`<form onSubmit=${add} novalidate class="formrow" style="margin-top:12px;align-items:center">
    <label class="sr" for="another">Company name</label>
    <input id="another" class="input" style="flex:1" value=${name} onInput=${(e: Event) => setName((e.target as HTMLInputElement).value)} placeholder="Company name" autofocus />
    <${Button} type="submit">Add</${Button}>
    ${err ? html`<p class="err" role="alert" style="width:100%">${err}</p>` : null}
  </form>`
}

function AiStep({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  const app = useApp()
  // Approving the AI happens on the consent page (often another tab); coming back reloads the Workspace. Once a new AI
  // shows up, move on by itself: no "I've added it" click needed.
  const count = app.ws ? app.ws.ais.length : null
  const before = useRef<number | null>(count)
  useEffect(() => {
    if (count === null) return
    if (before.current === null) before.current = count
    else if (count > before.current) onNext()
  }, [count])
  const me = app.ws?.me
  if (!me || !app.ws) return null
  // Whether there's anything to ask about yet: connected and in, still arriving, or nothing connected (try the demo).
  const ws = app.ws
  const coming = ws.entities.some((e) => isUpdating(ws, e.name))
  const dataLine = coming ? 'Your data: still coming in. Give it a minute before you ask.' : ws.connections.length ? 'Your data: ready.' : 'Your data: nothing connected yet. You can still connect your AI now.'
  return html`<${Shell} step=${3}>
    <h1>Connect your AI</h1>
    <p class="sub lead">Paste this link into Claude, ChatGPT, Grok or any assistant.</p>
    <div class="formrow" style="align-items:center;margin-top:24px"><code class="code" style="flex:1">${me.mcpUrl}</code><${CopyButton} text=${me.mcpUrl} what="AI link" /></div>
    <p class="meta" style="margin-top:12px" role="status">${dataLine}</p>
    <${AssistantList} url=${me.mcpUrl} />
    <p class="meta" style="margin-top:16px">Claude works on any plan (Free allows one custom connector). ChatGPT depends on your plan: <a class="link" href="https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt" target="_blank" rel="noopener">OpenAI’s help</a>.</p>
    ${me.demoMcpUrl
      ? html`<p class="meta" style="margin-top:12px">Try it on the demo books first: add this link the same way. Made-up companies, no sign-in.</p>
          <div class="formrow" style="align-items:center;margin-top:4px"><code class="code" style="flex:1">${me.demoMcpUrl}</code><${CopyButton} text=${me.demoMcpUrl} what="demo link" /></div>`
      : null}
    <p class="meta" style="margin-top:16px">When you approve it, you choose exactly what it can see. It can never move money.</p>
    <p class="meta" style="margin-top:24px;text-align:center"><button type="button" class="link" onClick=${onSkip}>Skip, I’ll ask later</button></p>
  </${Shell}>`
}

function FirstQuestionStep({ onDone }: { onDone: () => void }) {
  const app = useApp()
  const [since] = useState(() => new Date(app.now()).toISOString())
  const [heard, setHeard] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const tick = async () => {
      const a = await app.api.latestActivity().catch(() => null)
      if (alive && a && a.at >= since) setHeard(`${a.client} just ${a.summary}`)
    }
    tick()
    const t = setInterval(tick, 3000)
    return () => ((alive = false), clearInterval(t))
  }, [])
  return html`<${Shell} step=${4}>
    <h1>Ask it something</h1>
    <p class="sub lead">Click to copy, then paste into your AI.</p>
    <ul class="rows wrap" style="margin-top:20px">${firstQuestions(app.ws?.entities.find((e) => e.kind === 'company')?.name).map((q) => html`<${Row} name=${`“${q}”`} right=${html`<${CopyButton} text=${q} what="question" />`} />`)}</ul>
    <p class="sub" style="margin-top:20px;display:flex;gap:8px;align-items:center" aria-live="polite">
      ${heard ? html`<${Icon} name="check" size=${16} /> ${heard}.` : 'Waiting for your AI’s first question…'}
    </p>
    <div class="stack" style="margin-top:28px"><${Button} big onClick=${onDone}>Go to Workspace</${Button}></div>
  </${Shell}>`
}

/** Reviewer accounts' reserved, undeliverable domain (REVIEWER_EMAIL_DOMAIN in @agfn/auth). */
const REVIEWER_DOMAIN = 'reviewers.aggregate.invalid'
const isReviewerAddress = (email: string) => email.trim().toLowerCase().endsWith(`@${REVIEWER_DOMAIN}`)

/**
 * App-directory reviewers (OpenAI, Anthropic…) sign in with an access code instead of an email they can't open. Shown
 * only while the server has reviewer links on; it also works on the sign-in page inside an AI's OAuth window.
 */
function ReviewerCode({ onSignedIn }: { onSignedIn: () => void }) {
  const app = useApp()
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: Event) => {
    e.preventDefault()
    if (!code.trim()) return setErr('Paste the access code you were given.')
    setErr('')
    setBusy(true)
    try {
      await app.api.reviewerSignIn(code.trim())
      onSignedIn()
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'That didn’t work. Try again.')
      setBusy(false)
    }
  }
  if (!open) return html`<p class="meta" style="margin-top:24px"><button type="button" class="link" onClick=${() => setOpen(true)}>Reviewer? Use an access code</button></p>`
  return html`<form onSubmit=${submit} novalidate style="margin-top:24px">
    <label class="sub" for="reviewer-code">Access code</label>
    <input id="reviewer-code" class="input mono" style="margin-top:6px" autocomplete="off" autocapitalize="off" spellcheck=${false} value=${code} onInput=${(e: Event) => setCode((e.target as HTMLInputElement).value)} autofocus />
    ${err ? html`<p class="err" role="alert">${err}</p>` : null}
    <div class="stack" style="margin-top:8px"><${Button} big quiet type="submit" disabled=${busy}>${busy ? 'Signing in…' : 'Sign in'}</${Button}></div>
  </form>`
}
