// Connect your AI: one AI's drawer (control sentence, activity, pause, revoke), the "connect another AI" sheet with
// the list of assistants (assistants.ts), a key for bots that can't sign in, and the OAuth consent screen (#/connect-ai/consent).
import { EmailCode } from '../ui/email-code.ts'
import { AI_DISCLOSURE, aiDisclosure, type GrantShape } from '@agfn/contracts'
import { useEffect, useState } from 'preact/hooks'
import { HttpError, OFFLINE } from '../api/http.ts'
import type { AiActivity } from '../api/types.ts'
import { isReviewer, useApp, useLoad } from '../app/context.ts'
import { CANT_EVER, defaultDataTypes, expiresAtFor } from '../lib/grant.ts'
import { passkeysAvailable } from '../lib/passkey.ts'
import { returnHere } from '../lib/recheck.ts'
import { ago } from '../lib/time.ts'
import { Button, CopyButton, LinkButton, PlusAction, Row, Rows, Section, Tile } from '../ui/components.ts'
import { ControlSentence } from '../ui/control-sentence.ts'
import { Drawer, LoadFailed } from '../ui/drawer.ts'
import { AssistantList } from './assistants.ts'
import { html } from '../ui/html.ts'

export function AiView({ id, onClose, onBack }: { id: string; onClose: () => void; onBack: (() => void) | null }) {
  const app = useApp()
  const { data: ai, error, reload } = useLoad(() => app.api.ai(id), [id])
  const [confirmRevoke, setConfirmRevoke] = useState(false)
  const [naming, setNaming] = useState<string | null>(null)
  const [nameErr, setNameErr] = useState('')
  // The Workspace list keeps "last used" from its last load; if this drawer knows of newer activity, refresh it.
  const newest = ai?.activity.reduce((m, a) => (a.at > m ? a.at : m), '') ?? ''
  const listed = app.ws?.ais.find((a) => a.grantId === id)?.lastUsedAt ?? ''
  useEffect(() => {
    if (newest > listed) void app.reload()
  }, [newest])
  if (error) return html`<${LoadFailed} title="This AI isn’t connected" error=${error} reload=${reload} onClose=${onClose} onBack=${onBack} />`
  if (!ai || !app.ws) return html`<${Drawer} title="Loading…" onClose=${onClose} onBack=${onBack} />`
  const now = app.now()

  const change = async (shape: GrantShape) => {
    await app.api.updateGrant(ai.grantId, shape)
    reload()
    app.reload()
  }
  const pause = async () => {
    await app.api.pauseAi(ai.grantId, !ai.paused)
    reload()
    app.reload()
  }
  const revoke = async () => {
    await app.api.revokeAi(ai.grantId)
    app.toast({ text: `${ai.client} can’t reach Aggregate any more.` })
    await app.reload()
    onClose()
  }
  const undo = async (a: AiActivity) => {
    if (!a.recordId) return
    await app.api.undo(a.recordId)
    app.toast({ text: 'Undone.' })
    reload()
    app.reload()
  }

  const isKey = /key/i.test(ai.via)
  const rename = async (e: Event) => {
    e.preventDefault()
    const name = (naming ?? '').trim().replace(/\s+/g, ' ')
    if (!name) return setNameErr('Give it a name.')
    try {
      await app.api.renameKey(ai.grantId, name)
      setNaming(null)
      setNameErr('')
      reload()
      app.reload()
    } catch (x) {
      setNameErr(x instanceof Error ? x.message : 'That didn’t work. Try again.')
    }
  }
  const unused = !ai.lastUsedAt && !ai.activity.length
  const sub = `${isKey ? 'Made' : 'Connected'} ${ago(ai.connectedAt, now)}${unused ? ', not used yet' : ''} · ${ai.via}${ai.paused ? ' · paused' : ''}`
  return html`<${Drawer} title=${`${ai.client} · ${ai.personName}`} sub=${sub} onClose=${onClose} onBack=${onBack}>
    ${isKey
      ? naming !== null
        ? html`<form onSubmit=${rename} novalidate class="formrow" style="align-items:center;margin-top:16px">
            <label class="sr" for="rename-key">Key name</label>
            <input id="rename-key" class="input" style="flex:1" value=${naming} maxlength="60" autofocus onInput=${(e: Event) => setNaming((e.target as HTMLInputElement).value)} />
            <${Button} type="submit">Save</${Button}><${LinkButton} onClick=${() => (setNaming(null), setNameErr(''))}>Cancel</${LinkButton}>
          </form>
          ${nameErr ? html`<p class="err" role="alert">${nameErr}</p>` : null}`
        : html`<p class="meta" style="margin-top:12px"><${LinkButton} onClick=${() => setNaming(ai.client)}>Rename</${LinkButton}></p>`
      : null}
    ${app.ws.me.demo ? html`<p class="sub" style="margin-top:16px">Part of the demo: it shows what an AI reading and recording looks like.</p>` : null}
    <div style="margin-top:24px">
      <${ControlSentence} client=${ai.client} shape=${ai.shape} entities=${app.ws.entities} onChange=${change} now=${now} />
    </div>

    <${Section} compact title="Activity" sub="Every question it asked, and what it got or wrote">
      <${Rows} label="Activity">
        ${ai.activity.map(
          (a) => html`<${Row}
            name=${html`<span class=${a.kind === 'blocked' ? 'red' : ''}>${a.summary[0]!.toUpperCase() + a.summary.slice(1)}</span>`}
            line=${`${ago(a.at, now)} · ${a.status === 'undone' ? 'undone' : a.result}`}
            right=${a.kind === 'write' && a.status !== 'undone' && a.undoUntil && Date.parse(a.undoUntil) > now ? html`<${LinkButton} onClick=${() => undo(a)}>Undo</${LinkButton}>` : null}
          />`,
        )}
      </${Rows}>
      ${!ai.activity.length ? html`<p class="empty">When ${ai.client} asks Aggregate something, it shows up here.</p>` : null}
    </${Section}>

    <div class="links" style="margin-top:40px">
      <${LinkButton} onClick=${pause}>${ai.paused ? 'Resume' : 'Pause'}</${LinkButton}>
      ${confirmRevoke
        ? html`<span class="sub">Revoke ${ai.client}? It loses access right away. <${LinkButton} danger onClick=${revoke}>Revoke now</${LinkButton}> · <${LinkButton} onClick=${() => setConfirmRevoke(false)}>Keep</${LinkButton}></span>`
        : html`<${LinkButton} danger onClick=${() => setConfirmRevoke(true)}>Revoke</${LinkButton}>`}
    </div>
  </${Drawer}>`
}

/**
 * A key is shown once. Until it's copied it lives here, in memory only (never storage): leaving the drawer, or going
 * elsewhere in the app, and coming back still shows it. Closing before copying asks first; so does closing the tab.
 */
let unsaved: { name: string; key: string; copied: boolean } | null = null
if (typeof addEventListener === 'function')
  addEventListener('beforeunload', (e: BeforeUnloadEvent) => {
    if (unsaved && !unsaved.copied) e.preventDefault()
  })
/** Tests start each case with no key on screen. */
export const forgetUnsavedKey = () => void (unsaved = null)

export function ConnectAiView({ onClose, onBack }: { onClose: () => void; onBack: (() => void) | null }) {
  const app = useApp()
  const [made, setMade] = useState(unsaved)
  const [name, setName] = useState(() => app.route.params.keyname ?? '')
  const [err, setErr] = useState('')
  const [guard, setGuard] = useState<null | 'close' | 'back'>(null)
  const me = app.ws?.me
  if (!me) return null
  const local = me.selfHosted && /localhost|127\.0\.0\.1/.test(me.mcpUrl)
  // A key is access to your money: making one needs a quick check that it's you. Without a passkey (or with the
  // passkey sheet cancelled) say so and offer the emailed link, like connecting a bank.
  const [check, setCheck] = useState<null | 'ask' | { sentTo: string }>(null)
  const [busy, setBusy] = useState(false)
  const makeKey = async (e?: Event) => {
    e?.preventDefault()
    const label = name.trim()
    if (!label) return setErr('Name it, so you can tell your keys apart.')
    const shape: GrantShape = { entityIds: 'all', dataTypes: defaultDataTypes(app.ws?.entities ?? []), write: false, reviewMode: 'instant', expiresAt: expiresAtFor(90) }
    setErr('')
    setBusy(true)
    try {
      const r = await app.api.createKey(label, shape)
      unsaved = { name: label, key: r.key, copied: false }
      setMade(unsaved)
      setCheck(null)
      app.reload()
    } catch (x) {
      if (x instanceof HttpError && x.code === 'passkey_required') setCheck('ask')
      else setErr(x instanceof Error ? x.message : 'That didn’t work. Try again.')
    } finally {
      setBusy(false)
    }
  }
  const emailCheck = async () => {
    setErr('')
    try {
      // Back from the link, the name is still filled in and one click makes the key.
      setCheck({ sentTo: (await app.api.recheckByEmail(returnHere({ keyname: name.trim() }))).sentTo })
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'That didn’t send. Try again in a minute.')
    }
  }
  const copied = () => {
    if (unsaved) unsaved = { ...unsaved, copied: true }
    setMade(unsaved)
    setGuard(null)
  }
  const forget = () => {
    unsaved = null
    setMade(null)
  }
  // Leaving with a key not yet copied: ask once. Once copied (or "Close anyway"), the key is gone for good.
  const leave = (how: 'close' | 'back') => () => {
    if (made && !made.copied && guard !== how) return setGuard(how)
    if (made?.copied || guard) forget()
    how === 'back' && onBack ? onBack() : onClose()
  }
  return html`<${Drawer} title="Connect your AI" sub="Each AI sees only what you allow, and never more than you." onClose=${leave('close')} onBack=${onBack ? leave('back') : null}>
    <${Rows}><${Row} name=${html`<span class="mono" style="font-size:14px">${me.mcpUrl}</span>`} right=${html`<${CopyButton} text=${me.mcpUrl} what="AI link" />`} /></${Rows}>
    ${local ? html`<p class="sub amber" style="margin-top:12px">Claude, ChatGPT and Grok on the web can’t reach your computer. Use Claude Code, Cursor or another app on this computer, or turn on a public link.</p>` : null}
    <${AssistantList} url=${me.mcpUrl} />
    <${Section} compact title="Then ask" sub="Click to copy a first question">
      <${Rows} wrap>${firstQuestions(app.ws?.entities.find((e) => e.kind === 'company')?.name).map((q) => html`<${Row} name=${`“${q}”`} right=${html`<${CopyButton} text=${q} what="question" />`} />`)}</${Rows}>
    </${Section}>
    <${Section} compact title="A key for a bot" sub="For bots that can’t sign in. Read only, all companies, 90 days. Change it after." id="bot-key">
      ${made
        ? html`<p class="sub" style="margin-top:12px">${made.name}</p>
            <div class="formrow" style="align-items:center;margin-top:4px"><code class="code" style="flex:1">${made.key}</code><${CopyButton} text=${made.key} what="key" onCopy=${copied} /></div>
            ${guard
              ? html`<p class="sub amber" role="alert" style="margin-top:8px">Copy it first. It can’t be shown again; without it you’d make a new key. <${LinkButton} onClick=${leave(guard)}>${guard === 'back' ? 'Go back anyway' : 'Close anyway'}</${LinkButton}></p>`
              : html`<p class="sub" style="margin-top:8px">${made.copied ? 'Copied. It won’t be shown again once you close this.' : 'Shown once. Copy it and store it somewhere safe.'}${made.copied ? html` <${LinkButton} onClick=${forget}>Done</${LinkButton}>` : null}</p>`}`
        : html`<p style="margin-top:12px">${AI_DISCLOSURE.keyText}</p>
          <form onSubmit=${makeKey} novalidate class="formrow" style="align-items:center;margin-top:12px">
            <label class="sr" for="key-name">Key name</label>
            <input id="key-name" class="input" style="flex:1" value=${name} onInput=${(e: Event) => setName((e.target as HTMLInputElement).value)} placeholder="Name it, e.g. Invoice bot" maxlength="60" />
            <${Button} type="submit" disabled=${busy}>${busy ? 'Making…' : 'Make a key'}</${Button}>
          </form>
          ${check === 'ask'
            ? html`<p class="sub" role="status" style="margin-top:8px">Making a key needs a quick check that it’s you.</p>
                <div class="links"><${LinkButton} onClick=${() => makeKey()}>Use a passkey</${LinkButton}>${isReviewer(app) ? null : html`<${LinkButton} onClick=${emailCheck}>Email me a link instead</${LinkButton}>`}</div>`
            : check
              ? html`<p class="sub" role="status" style="margin-top:8px">Check your email at ${check.sentTo} and open the link. It brings you back here with the name filled in; then make the key.</p>
                  <${EmailCode} kind="recheck" onDone=${() => (setCheck(null), void makeKey())} onResend=${emailCheck} />`
              : null}
          ${err ? html`<p class="err" role="alert">${err}</p>` : null}`}
    </${Section}>
    <p class="sub cant" style="margin-top:32px">${CANT_EVER}</p>
  </${Drawer}>`
}

/** Three first questions; the last one names one of your own companies. */
export const firstQuestions = (company?: string) => ['How much cash do I have?', 'Which invoices are overdue, and by how long?', `I got $1,200 in cash from a customer today. Add it to ${company || 'my company'}.`]

/** The OAuth query exactly as Better Auth sent it (it may be signed, so never re-encode it). */
/**
 * Where approving sends you. Any app can call itself "Claude", so the page shows this instead of trusting the name:
 * a web host ("claude.ai"), "an app on this computer" for loopback, or a custom scheme ("com.foo.app").
 */
export function redirectPlace(uri: string): string {
  try {
    const u = new URL(uri)
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      const h = u.hostname.replace(/^\[|\]$/g, '')
      return h === 'localhost' || h === '::1' || /^127\./.test(h) ? 'an app on this computer' : h
    }
    return u.protocol.replace(/:$/, '')
  } catch {
    return 'an unknown address'
  }
}

function oauthQuery(): string {
  const h = location.hash
  const i = h.indexOf('?')
  // Our own marks (the drawer stack, back from an emailed check) aren't part of the AI's request, which may be signed.
  if (i !== -1) return h.slice(i + 1).split('&').filter((kv) => !kv.startsWith('d=') && !kv.startsWith('rechecked=')).join('&')
  return location.search.slice(1)
}

/** OAuth consent: what an AI asks for, written as the control sentence, before you approve (Better Auth redirects here). */
export function ConsentPage() {
  const app = useApp()
  const params = app.route.params
  const clientId = params.client_id ?? ''
  const scope = params.scope ?? ''
  const clientName = params.client_name
  const { data: info, error, reload } = useLoad(() => app.api.consentInfo({ clientId, scope, ...(clientName ? { clientName } : {}) }), [clientId, scope])
  const [shape, setShape] = useState<GrantShape | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [expired, setExpired] = useState(false)
  const [outdated, setOutdated] = useState(false)
  // Signed in a while ago: Allow needs a quick check that it's you first (a passkey, or a code by email). Shown right
  // here with its own buttons; the AI's request is kept, so the check ends in Allow, never a dead end.
  // Reviewer demo accounts (method 'signin', or any way we don't know) can't use either: a fresh sign-in is their check.
  const [check, setCheck] = useState<null | { passkey: boolean; sentTo?: string; err?: string; signIn?: string }>(null)
  const current = shape ?? info?.shape ?? null
  const decide = async (accept: boolean) => {
    if (!current || !info) return
    setBusy(true)
    // Declining shares nothing and makes no grant; the AI app is told no (access_denied) instead of waiting.
    if (!accept) {
      try {
        const r = await app.api.decline({ oauthQuery: oauthQuery() })
        if (r.redirectTo) return location.assign(r.redirectTo)
      } catch {
        /* the answer is still no: nothing was shared */
      } finally {
        setBusy(false)
      }
      return setDone('Nothing was shared. You can close this tab.')
    }
    try {
      const r = await app.api.consent({ clientId, clientName: info.clientName, shape: current, oauthQuery: oauthQuery() })
      setCheck(null)
      if (r.redirectTo) location.assign(r.redirectTo)
      else setDone(`${info.clientName} is connected. Go back to it and ask your first question.`)
    } catch (e) {
      if (e instanceof HttpError && e.code === 'recheck') {
        const method = (e.data as { method?: string } | undefined)?.method
        if (method && method !== 'email' && method !== 'passkey') setCheck({ passkey: false, signIn: e.message })
        else setCheck((c) => ({ ...c, passkey: method !== 'email' && passkeysAvailable() }))
      }
      // The words changed since this page loaded (c7's 409): reloading shows the current ones; the AI app needn't restart.
      else if (e instanceof HttpError && e.code === 'consent_outdated') (setOutdated(true), setFailed(e.message || 'This page is out of date. Reload this page and try again.'))
      // Better Auth's signed query outlived its 30 minutes (auth.ts codeExpiresIn), or was changed: only the AI app can start a new one.
      else if (e instanceof HttpError && e.code === 'invalid_signature') (setExpired(true), setFailed('Links to connect an AI last 30 minutes. Start again from your AI app.'))
      else setFailed(`${e instanceof Error ? e.message : 'That didn’t work.'} Start again from your AI app.`)
    } finally {
      setBusy(false)
    }
  }
  // Sign out, then the sign-in page with the AI's request: signing in brings this consent back (signin.ts).
  const signInAgain = async () => {
    setBusy(true)
    await app.api.signOut().catch(() => {})
    location.replace(`${location.pathname}#/sign-in?${oauthQuery()}`)
    location.reload()
  }
  const emailCode = async () => {
    try {
      const r = await app.api.recheckByEmail(returnHere())
      setCheck((c) => ({ passkey: c?.passkey ?? false, sentTo: r.sentTo }))
    } catch (e) {
      setCheck((c) => ({ passkey: c?.passkey ?? false, err: e instanceof Error ? e.message : 'That didn’t send. Try again in a minute.' }))
    }
  }
  return html`<main class="solo" id="main">
    <div class="wordmark">Aggregate</div>
    <div class="card">
      ${error === OFFLINE
        ? html`<h1>Can’t reach Aggregate</h1><p class="sub lead">Check your connection, then try again.</p><div class="stack" style="margin-top:32px"><${Button} big onClick=${reload}>Try again</${Button}></div>`
        : error
          ? html`<h1>This link expired</h1><p class="sub lead">${error} Start again from your assistant.</p>`
          : null}
      ${done ? html`<h1>Done</h1><p class="sub lead">${done}</p>` : null}
      ${failed ? html`<h1>${expired ? 'This link expired' : 'That didn’t work'}</h1><p class="sub lead" role="alert">${failed}</p>${outdated ? html`<div class="stack" style="margin-top:32px"><${Button} big onClick=${() => location.reload()}>Reload</${Button}></div>` : null}` : null}
      ${!error && !info ? html`<p class="sub lead" role="status">Loading…</p>` : null}
      ${!error && !done && !failed && info && current && app.ws
        ? html`<h1>Connect “${info.clientName}”?<span class="sub unverified"><span class="sr"> · </span>unverified name</span></h1>
          ${params.redirect_uri ? html`<p class="sub">Sends you back to ${redirectPlace(params.redirect_uri)}</p>` : null}
          <p class="lead" style="margin-top:16px">${aiDisclosure(info.clientName)}</p>
          <p class="sub lead">Click any underlined words to change them.</p>
          <div style="margin-top:28px"><${ControlSentence} client=${info.clientName} shape=${current} entities=${app.ws.entities} allowedEntityIds=${info.allowedEntityIds} onChange=${setShape} /></div>
          ${check?.signIn
            ? html`<div role="status" style="margin-top:32px">
                <h2 style="font-weight:400;font-size:17px;margin:0">First, sign in again</h2>
                <p class="sub" style="margin-top:4px">${check.signIn}</p>
              </div>
              <div class="stack" style="margin-top:24px">
                <${Button} big disabled=${busy} onClick=${signInAgain}>Sign in again</${Button}>
                <${Button} big quiet disabled=${busy} onClick=${() => decide(false)}>Don’t allow</${Button}>
              </div>`
            : check
            ? html`<div role="status" style="margin-top:32px">
                <h2 style="font-weight:400;font-size:17px;margin:0">First, a quick check that it’s you</h2>
                <p class="sub" style="margin-top:4px">You signed in a while ago. ${check.sentTo ? `We sent a code to ${check.sentTo}. Type it here, or open the link in the email.` : check.passkey ? 'Use your passkey, or get a code by email.' : 'We’ll email you a code.'}</p>
                ${check.sentTo ? html`<${EmailCode} kind="recheck" onDone=${() => void decide(true)} onResend=${emailCode} />` : null}
                ${check.err ? html`<p class="err" role="alert">${check.err}</p>` : null}
              </div>
              <div class="stack" style="margin-top:24px">
                ${check.sentTo ? null : check.passkey ? html`<${Button} big disabled=${busy} onClick=${() => decide(true)}>Use a passkey</${Button}>` : null}
                ${check.sentTo ? null : html`<${Button} big quiet=${check.passkey} disabled=${busy} onClick=${emailCode}>Email me a code</${Button}>`}
                <${Button} big quiet disabled=${busy} onClick=${() => decide(false)}>Don’t allow</${Button}>
              </div>`
            : html`<div class="stack" style="margin-top:32px">
                <${Button} big disabled=${busy} onClick=${() => decide(true)}>Allow</${Button}>
                <${Button} big quiet disabled=${busy} onClick=${() => decide(false)}>Don’t allow</${Button}>
              </div>`}`
        : null}
    </div>
  </main>`
}

export const AiTile = () => html`<${Tile} icon="spark" />`
