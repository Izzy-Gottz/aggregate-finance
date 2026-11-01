// "Or type the code from the email": for when the link opens in another browser or device. Sign-in and re-checks
// both send a 6-digit code under the button; typing it here finishes in this browser.
import { markRechecked } from '../lib/recheck.ts'
import { useState } from 'preact/hooks'
import { HttpError } from '../api/http.ts'
import { useApp } from '../app/context.ts'
import { Button, LinkButton } from './components.ts'
import { html } from './html.ts'

export function EmailCode({ kind, onDone, onResend }: { kind: 'signin' | 'recheck'; onDone: () => void; onResend?: () => void | Promise<unknown> }) {
  const app = useApp()
  const [code, setCode] = useState('')
  const [err, setErr] = useState('')
  // Expired, used, too many tries, or not this browser: only a new email helps.
  const [spent, setSpent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [resent, setResent] = useState(false)
  // A new email means a new code: start the field over and say it went.
  const resend = async () => {
    await onResend?.()
    setCode('')
    setErr('')
    setSpent(false)
    setResent(true)
  }
  const submit = async (e: Event) => {
    e.preventDefault()
    // This form often sits inside another one (the delete drawer's): its submit must not also submit that one, or
    // "Use code" fires the delete before the check is recorded and the drawer asks to confirm again.
    e.stopPropagation()
    const digits = code.replace(/\D/g, '')
    if (digits.length !== 6) return setErr('The code is 6 digits.')
    setErr('')
    setBusy(true)
    try {
      await (kind === 'signin' ? app.api.signInCode(digits) : app.api.recheckCode(digits))
      if (kind === 'recheck') markRechecked()
      onDone()
    } catch (x) {
      setResent(false)
      const c = x instanceof HttpError ? x.code : ''
      setSpent(c === 'no_code' || c === 'too_many')
      setErr(x instanceof Error ? x.message : 'That didn’t work. Try again.')
    } finally {
      setBusy(false)
    }
  }
  return html`<form onSubmit=${submit} novalidate style="margin-top:16px">
    <label class="sub" for=${'code-' + kind}>Or type the code from the email</label>
    <div class="formrow" style="margin-top:6px;align-items:center">
      <input id=${'code-' + kind} class="input tn" style="flex:1;max-width:180px;letter-spacing:2px" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123 456" value=${code} onInput=${(e: Event) => setCode((e.target as HTMLInputElement).value)} />
      <${Button} quiet type="submit" disabled=${busy}>${busy ? 'Checking…' : 'Use code'}</${Button}>
    </div>
    ${err ? html`<p class="err" role="alert">${err}</p>` : null}
    ${resent ? html`<p class="sub" role="status" style="margin-top:8px">A new email is on its way, with a new code.</p>` : null}
    ${spent && onResend ? html`<div class="links"><${LinkButton} onClick=${resend}>Send a new email</${LinkButton}></div>` : null}
  </form>`
}
