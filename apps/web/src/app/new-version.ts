// A tab opened before a deploy keeps the old app until it reloads. Check, quietly, whether the server now serves a
// newer one (its index names a different app-<hash>.js), and offer one click to reload. Never reloads on its own.
import { useEffect, useState } from 'preact/hooks'
import { html } from '../ui/html.ts'

const APP_JS = /assets\/app-[A-Z0-9]+\.js/

/** The app bundle this page is running, or null in dev and tests (nothing to compare). */
export function runningBundle(doc: Document = document): string | null {
  for (const s of Array.from(doc.querySelectorAll<HTMLScriptElement>('script[src]'))) {
    const m = APP_JS.exec(s.getAttribute('src') ?? '')
    if (m) return m[0]
  }
  return null
}

/** The bundle the server's index.html names now. */
export async function servedBundle(fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const r = await fetcher('/', { cache: 'no-store', credentials: 'same-origin' })
    return r.ok ? (APP_JS.exec(await r.text())?.[0] ?? null) : null
  } catch {
    return null
  }
}

/** Checks when the tab comes back into view and every 15 minutes while it's visible. */
export function NewVersion({ every = 15 * 60_000 }: { every?: number }) {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const mine = runningBundle()
    if (!mine) return
    const check = async () => {
      if (document.visibilityState !== 'visible') return
      const now = await servedBundle()
      if (now && now !== mine) setReady(true)
    }
    const t = setInterval(() => void check(), every)
    const onVis = () => void check()
    document.addEventListener('visibilitychange', onVis)
    return () => (clearInterval(t), document.removeEventListener('visibilitychange', onVis))
  }, [])
  if (!ready) return null
  return html`<div class="toast" role="status">
    <span>A new version of Aggregate is ready.</span>
    <button type="button" onClick=${() => location.reload()}>Reload</button>
    <button type="button" aria-label="Close" onClick=${() => setReady(false)}>×</button>
  </div>`
}
