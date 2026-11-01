// "Or look around with made-up companies first": offered until the person has data of their own (no connections, no cash).
// The demo is its own workspace beside theirs (the server refuses once theirs holds data); leaving it comes back here.
import { useState } from 'preact/hooks'
import { isReviewer, useApp, type App } from '../app/context.ts'
import { html } from '../ui/html.ts'

/** Before any data of their own: no workspace yet, or one with no connections. Never in a demo or the reviewer's. */
export const canTryDemo = (app: Pick<App, 'me' | 'ws'>): boolean =>
  !app.me?.publicDemo && !app.ws?.me.demo && !isReviewer(app) && (!!app.me?.needsOnboarding || (!!app.ws && app.ws.connections.length === 0 && !app.ws.entities.some((e) => e.cash)))

export function DemoLink() {
  const app = useApp()
  const [starting, setStarting] = useState(false)
  const [err, setErr] = useState('')
  const start = async () => {
    if (starting) return
    setStarting(true)
    setErr('')
    try {
      const r = await app.api.startDemo()
      // A second workspace now: this tab moves into the demo (the company switcher has both).
      app.api.setWorkspace(r.workspaceId)
      await app.reload()
      app.go({ page: 'workspace', step: 0, stack: [] })
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'That didn’t work. Try again.')
      setStarting(false)
    }
  }
  return html`<p class="meta" style="margin-top:20px"><button type="button" class="link" onClick=${start} disabled=${starting}>${starting ? 'Setting up the demo…' : 'Or look around with made-up companies first'}</button></p>
    ${err ? html`<p class="err" role="alert">${err}</p>` : null}`
}
