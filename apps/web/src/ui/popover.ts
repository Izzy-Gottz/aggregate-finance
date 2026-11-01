// A small anchored menu used by the control sentence and the company switcher. Opens below its trigger, closes on
// Escape or Tabbing past its ends (focus back to the trigger), or a click outside.
import type { ComponentChildren, VNode } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import { html } from './html.ts'
import { Icon } from './icons.ts'

export function Popover({ open, onClose, children, label }: { open: boolean; onClose: () => void; children: ComponentChildren; label: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const el = ref.current
    const trigger = el?.parentElement?.querySelector<HTMLElement>('[aria-expanded]')
    el?.querySelector<HTMLElement>('button,input')?.focus()
    const onDown = (e: MouseEvent) => {
      if (el && !el.parentElement?.contains(e.target as Node)) onClose()
    }
    // Escape anywhere while open closes just this menu (captured first, so a drawer behind it stays open).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        const inside = !!el?.parentElement?.contains(document.activeElement) || document.activeElement === document.body
        onClose()
        if (inside) trigger?.focus()
      }
      // Tab moves through the menu; past either end it closes and goes back to the trigger, so it never stays open
      // behind the focus.
      if (e.key === 'Tab' && el?.contains(document.activeElement)) {
        const items = [...el.querySelectorAll<HTMLElement>('button, input, a[href]')]
        const edge = e.shiftKey ? items[0] : items[items.length - 1]
        if (document.activeElement === edge) {
          e.preventDefault()
          e.stopPropagation()
          onClose()
          trigger?.focus()
        }
      }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && el?.contains(document.activeElement)) {
        const opts = [...el.querySelectorAll<HTMLElement>('.opt')]
        const i = opts.indexOf(document.activeElement as HTMLElement)
        const next = opts[(i + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length]
        next?.focus()
        e.preventDefault()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  if (!open) return null
  return html`<div class="pop" ref=${ref} role="group" aria-label=${label}>${children}</div>`
}

/** One option. `checked` shows a tick (multi-select) or marks the current choice (single). */
export function Opt({ children, checked, onClick, role = 'menuitemcheckbox' }: { children: ComponentChildren; checked?: boolean; onClick: () => void; role?: string }): VNode {
  return html`<button type="button" class="opt" role=${role} aria-checked=${checked ? 'true' : 'false'} onClick=${onClick}>
    <span class="check">${checked ? html`<${Icon} name="check" size=${16} />` : null}</span><span>${children}</span>
  </button>`
}
