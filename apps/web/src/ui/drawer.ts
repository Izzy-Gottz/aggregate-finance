// Drawer: the right-side "peek" (full sheet on phone). A real modal dialog: focus moves in, Tab is trapped,
// Esc closes, focus returns to whatever opened it. One drawer at a time; deeper views stack inside it with a Back link.
import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import { OFFLINE } from '../api/http.ts'
import { Button } from './components.ts'
import { html } from './html.ts'
import { Icon } from './icons.ts'

/** Slide in only when a drawer opens from nothing; moving deeper (Back / a bucket) swaps content without motion. */
let lastClosedAt = 0

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

export interface DrawerProps {
  title: string
  sub?: ComponentChildren
  onClose: () => void
  onBack?: (() => void) | null
  backLabel?: string
  children?: ComponentChildren
  /** Extra thing in the header row next to the title (e.g. a sparkline). */
  aside?: ComponentChildren
}

export function Drawer({ title, sub, onClose, onBack, backLabel = 'Back', children, aside }: DrawerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const enter = useRef(Date.now() - lastClosedAt > 100)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const el = ref.current
    const first = el?.querySelector<HTMLElement>('h2')
    first?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // A popover inside handles its own Escape first.
        if (e.target instanceof Element && e.target.closest('.pop')) return
        e.preventDefault()
        closeRef.current()
        return
      }
      if (e.key !== 'Tab' || !el) return
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement)
      if (!items.length) return
      const a = items[0]!
      const b = items[items.length - 1]!
      // From the title (or anything that isn't a stop), wrap when no stop lies that way, or Tab leaves the drawer: a
      // drawer still loading has only Close, which comes before the title.
      const at = document.activeElement
      const none = (dir: number) => !!at && !items.includes(at as HTMLElement) && !items.some((x) => at.compareDocumentPosition(x) & dir)
      if (e.shiftKey && (at === a || !el.contains(at) || none(Node.DOCUMENT_POSITION_PRECEDING))) {
        e.preventDefault()
        b.focus()
      } else if (!e.shiftKey && (at === b || none(Node.DOCUMENT_POSITION_FOLLOWING))) {
        e.preventDefault()
        a.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      lastClosedAt = Date.now()
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      if (opener && document.contains(opener)) opener.focus()
    }
  }, [])

  // Moving to a deeper view: put focus on the new title so screen readers announce it.
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('h2')?.focus()
  }, [title])

  return html`<div>
    <div class=${'scrim' + (enter.current ? ' enter' : '')} onClick=${onClose} aria-hidden="true"></div>
    <div class=${'drawer' + (enter.current ? ' enter' : '')} role="dialog" aria-modal="true" aria-labelledby="drawer-title" ref=${ref}>
      <div class="dhead">
        ${onBack ? html`<button type="button" class="back" onClick=${onBack}><${Icon} name="back" size=${16} />${backLabel}</button>` : html`<span></span>`}
        <button type="button" class="iconbtn" onClick=${onClose} aria-label="Close"><${Icon} name="close" /></button>
      </div>
      <div class="dbody">
        <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px">
          <div style="min-width:0">
            <h2 class="dtitle" id="drawer-title" tabindex="-1">${title}</h2>
            ${sub ? html`<p class="sub dsub">${sub}</p>` : null}
          </div>
          ${aside}
        </div>
        ${children}
      </div>
    </div>
  </div>`
}

/** A drawer whose data didn't load. Offline says so, whatever the drawer was; Try again where it can reload. */
export function LoadFailed({ title, error, reload, ...p }: Omit<DrawerProps, 'sub' | 'children'> & { error: string; reload?: () => void }) {
  const off = error === OFFLINE
  return html`<${Drawer} title=${off ? 'Can’t reach Aggregate' : title} sub=${off ? 'Check your connection, then try again.' : error} ...${p}>
    ${off && reload ? html`<div style="margin-top:24px"><${Button} onClick=${reload}>Try again</${Button}></div>` : null}
  </${Drawer}>`
}
