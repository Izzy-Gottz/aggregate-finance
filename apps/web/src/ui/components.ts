// The design system's building blocks (MASTER §12): Section, Row, PlusAction, plus Tile, Button, Copy, Sparkline,
// Toggle and Segmented. Screens compose these; they never add their own styles.
import type { ComponentChildren, VNode } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { html } from './html.ts'
import { Icon, type IconName } from './icons.ts'

// ---------- Section: serif heading + one grey line + hairline rule + rows ----------
export interface SectionProps {
  title: string
  sub?: ComponentChildren
  children?: ComponentChildren
  /** Smaller heading, used inside drawers. */
  compact?: boolean
  id?: string
}
export function Section({ title, sub, children, compact, id }: SectionProps) {
  const hid = id ?? 'sec-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  return html`<section class=${'section' + (compact ? ' compact' : '')} aria-labelledby=${hid}>
    <header><h2 id=${hid}>${title}</h2>${sub ? html`<p class="sub">${sub}</p>` : null}</header>
    ${children}
  </section>`
}

// ---------- Row: icon, name, one grey line, one thing on the right ----------
export interface RowProps {
  icon?: VNode | null
  name: ComponentChildren
  line?: ComponentChildren
  /** A value (number), a button, or nothing. A chevron is added when the row itself is clickable. */
  right?: ComponentChildren
  onClick?: () => void
  /** Accessible label when the visible text isn't enough. */
  label?: string
  chevron?: boolean
}
export function Row({ icon, name, line, right, onClick, label, chevron }: RowProps) {
  const cls = 'row' + (icon === undefined || icon === null ? ' noicon' : '')
  const body = html`${icon ?? null}
    <span class="txt"><span class="name">${name}</span>${line ? html`<span class="line">${line}</span>` : null}</span>
    <span class="right">${right}${onClick && chevron !== false ? html`<span class="chev"><${Icon} name="chevron" size=${16} /></span>` : null}</span>`
  return onClick
    ? html`<li><button type="button" class=${cls} onClick=${onClick} aria-label=${label}>${body}</button></li>`
    : html`<li><div class=${cls}>${body}</div></li>`
}
/** `wrap`: names and lines wrap instead of trailing off (long sentences, names that run past a phone's width). */
export const Rows = ({ children, label, wrap }: { children?: ComponentChildren; label?: string; wrap?: boolean }) => html`<ul class=${wrap ? 'rows wrap' : 'rows'} aria-label=${label}>${children}</ul>`

// ---------- PlusAction: the quiet grey "+" that ends a section ----------
export function PlusAction({ children, onClick, href }: { children: ComponentChildren; onClick?: () => void; href?: string }) {
  const inner = html`<span class="p" aria-hidden="true">+</span><span>${children}</span>`
  return href ? html`<a class="plus" href=${href}>${inner}</a>` : html`<button type="button" class="plus" onClick=${onClick}>${inner}</button>`
}
export const Pluses = ({ children }: { children: ComponentChildren }) => html`<div class="pluses">${children}</div>`

// ---------- Tile: 28px square for a source logo letter or a line icon ----------
export type BrandTile = 'carta' | 'mercury' | 'shopify' | 'square' | 'plaid' | 'deel' | 'ramp' | 'simplefin'
export function Tile({ letter, icon, serif, brand }: { letter?: string; icon?: IconName; serif?: boolean; brand?: BrandTile }) {
  if (brand) return html`<span class=${'tile brand-' + brand} aria-hidden="true"></span>`
  return html`<span class=${'tile' + (serif ? ' serif' : '')} aria-hidden="true">${icon ? html`<${Icon} name=${icon} />` : letter}</span>`
}

// ---------- Buttons ----------
export interface ButtonProps {
  children: ComponentChildren
  onClick?: (e: Event) => void
  quiet?: boolean
  big?: boolean
  type?: 'button' | 'submit'
  disabled?: boolean
  label?: string
  /** Red, for the one irreversible action on a screen. */
  danger?: boolean
}
export const Button = ({ children, onClick, quiet, big, type = 'button', disabled, label, danger }: ButtonProps) =>
  html`<button type=${type} class=${'btn' + (quiet ? ' quiet' : '') + (big ? ' wide' : '') + (danger ? ' danger' : '')} onClick=${onClick} disabled=${disabled} aria-label=${label}>${children}</button>`

export const LinkButton = ({ children, onClick, danger }: { children: ComponentChildren; onClick: () => void; danger?: boolean }) =>
  html`<button type="button" class=${'link' + (danger ? ' danger' : '')} onClick=${onClick}>${children}</button>`

/** Black Copy button that says "Copied" for 2 seconds. */
export function CopyButton({ text, label = 'Copy', what, onCopy }: { text: string; label?: string; what?: string; onCopy?: () => void }) {
  const [done, setDone] = useState(false)
  const t = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(t.current), [])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.append(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    setDone(true)
    onCopy?.()
    clearTimeout(t.current)
    t.current = setTimeout(() => setDone(false), 2000)
  }
  return html`<button type="button" class="btn" onClick=${copy} aria-label=${what ? `Copy ${what}` : undefined} aria-live="polite">${done ? 'Copied' : label}</button>`
}

// ---------- Toggle and Segmented ----------
export function Toggle({ label, line, checked, onChange }: { label: string; line?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return html`<div class="toggle">
    <span><span class="name" style="font-weight:500">${label}</span>${line ? html`<span class="line sub" style="display:block">${line}</span>` : null}</span>
    <button type="button" role="switch" class="switch" aria-checked=${checked ? 'true' : 'false'} aria-label=${label} onClick=${() => onChange(!checked)}></button>
  </div>`
}

/** `wrap`: many choices flow onto a second line instead of needing a sideways scroll. */
export function Segmented<T extends string>({ value, options, onChange, label, wrap }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label: string; wrap?: boolean }) {
  return html`<div class=${wrap ? 'seg wrap' : 'seg'} role="group" aria-label=${label}>
    ${options.map((o) => html`<button type="button" aria-pressed=${o.value === value ? 'true' : 'false'} onClick=${() => onChange(o.value)}>${o.label}</button>`)}
  </div>`
}

// ---------- Sparkline: one per company, max ----------
export function Sparkline({ points, width = 96, height = 24, label }: { points: number[]; width?: number; height?: number; label: string }) {
  if (points.length < 2) return null
  const lo = Math.min(...points)
  const hi = Math.max(...points)
  const span = hi - lo || 1
  const d = points
    .map((p, i) => `${i ? 'L' : 'M'}${((i / (points.length - 1)) * (width - 2) + 1).toFixed(1)} ${(height - 1 - ((p - lo) / span) * (height - 2)).toFixed(1)}`)
    .join(' ')
  return html`<svg class="spark" width=${width} height=${height} viewBox=${`0 0 ${width} ${height}`} role="img" aria-label=${label}><path d=${d} fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" /></svg>`
}

export const Field = ({ label, children }: { label: string; children: ComponentChildren }) =>
  html`<label class="field"><span>${label}</span>${children}</label>`
