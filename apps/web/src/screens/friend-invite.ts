// "Invite someone": a friend's own Aggregate account, nothing of yours shared. "Add a teammate" (preferences.ts) is the
// other one: someone joining this workspace.
import { useState } from 'preact/hooks'
import { useApp, useLoad } from '../app/context.ts'
import { Button, CopyButton, Field } from '../ui/components.ts'
import { Drawer } from '../ui/drawer.ts'
import { html } from '../ui/html.ts'

export function FriendInviteView({ onClose, onBack }: { onClose: () => void; onBack: (() => void) | null }) {
  const app = useApp()
  const on = !!app.ws?.me.friendInvites && !app.ws.me.demo
  const { data } = useLoad(() => (on ? app.api.friendLink() : Promise.resolve(null)), [on])
  const [email, setEmail] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: Event) => {
    e.preventDefault()
    const to = email.trim()
    if (!to) return setErr('Who should we invite?')
    setErr('')
    setBusy(true)
    try {
      await app.api.inviteFriend(to)
      app.toast({ text: `Thanks. If we can invite ${to}, they’ll get an email.` })
      onClose()
    } catch (x) {
      setBusy(false)
      setErr(x instanceof Error && x.message ? x.message : 'That invite didn’t send. Try again.')
    }
  }
  if (!on) return null
  return html`<${Drawer} title="Invite someone" sub="They get their own Aggregate account. Nothing of yours is shared." onClose=${onClose} onBack=${onBack}>
    <form onSubmit=${submit} novalidate>
      <${Field} label="Email"><input class="input" type="email" value=${email} onInput=${(e: Event) => setEmail((e.target as HTMLInputElement).value)} placeholder="name@company.com" /></${Field}>
      ${err ? html`<p class="err" role="alert">${err}</p>` : null}
      <div class="formrow"><${Button} type="submit" disabled=${busy}>${busy ? 'Sending…' : 'Send invite'}</${Button}>${data ? html`<${CopyButton} text=${data.link} label="Copy invite link" what="Invite link" />` : null}</div>
    </form>
  </${Drawer}>`
}
