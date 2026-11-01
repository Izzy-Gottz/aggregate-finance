// ControlSentence: an AI's permissions written as one sentence; every variable word is a button that opens a menu.
// "Claude can see [Acme and Bluebird Studio]: [balances, transactions, invoices]. [Can add records]. [Changes apply
//  immediately]. [Expires in 90 days]."  Changes save right away (the parent calls the API).
import type { DataType, GrantShape } from '@agfn/contracts'
import { useState } from 'preact/hooks'
import type { EntitySummary } from '../api/types.ts'
import { CANT_EVER, DATA_TYPES, EXPIRY_CHOICES, expiresAtFor, grantSentence, type Slot } from '../lib/grant.ts'
import { html } from './html.ts'
import { Opt, Popover } from './popover.ts'

export interface ControlSentenceProps {
  client: string
  shape: GrantShape
  entities: EntitySummary[]
  onChange: (next: GrantShape) => void
  /** The connecting person's own reach; an AI never sees more (MASTER §2 AI control). */
  allowedEntityIds?: string[] | 'all'
  now?: number
}

export function ControlSentence({ client, shape, entities, onChange, allowedEntityIds = 'all', now }: ControlSentenceProps) {
  const [open, setOpen] = useState<Slot | null>(null)
  const parts = grantSentence(client, shape, entities, now)
  // Companies are chosen one by one; Personal is the 'personal' data type (it's only ever the person's own).
  const choosable = entities.filter((e) => e.kind === 'company' && (allowedEntityIds === 'all' || allowedEntityIds.includes(e.id)))
  const hasPersonal = entities.some((e) => e.kind === 'personal')
  const ownIn = shape.dataTypes.includes('personal')
  // Personal accounts connected but not shared with this AI: say so, since "how much do I have?" would leave them out.
  const nudge = !ownIn && entities.some((e) => e.kind === 'personal' && e.cash)
  const selected = (id: string) => shape.entityIds === 'all' || shape.entityIds.includes(id)

  // A chosen list carries the Personal entity exactly when Personal is shared, so the server sees it both ways.
  const personalIds = entities.filter((e) => e.kind === 'personal').map((e) => e.id)
  const withOwn = (ids: string[], on: boolean) => [...ids.filter((x) => !personalIds.includes(x)), ...(on ? personalIds : [])]
  const toggleEntity = (id: string) => {
    const current = (shape.entityIds === 'all' ? choosable.map((e) => e.id) : shape.entityIds).filter((x) => !personalIds.includes(x))
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id]
    onChange({ ...shape, entityIds: next.length === choosable.length && allowedEntityIds === 'all' ? 'all' : withOwn(next, ownIn) })
  }
  const toggleData = (k: DataType) => {
    const on = !shape.dataTypes.includes(k)
    const next = on ? [...shape.dataTypes, k] : shape.dataTypes.filter((x) => x !== k)
    onChange({ ...shape, dataTypes: next, ...(k === 'personal' && shape.entityIds !== 'all' ? { entityIds: withOwn(shape.entityIds, on) } : {}) })
  }

  const menu = (slot: Slot) => {
    switch (slot) {
      case 'companies':
        return html`
          <${Opt} checked=${shape.entityIds === 'all'} onClick=${() => onChange({ ...shape, entityIds: 'all' })}>All your companies</${Opt}>
          ${choosable.map((e) => html`<${Opt} checked=${shape.entityIds !== 'all' && selected(e.id)} onClick=${() => toggleEntity(e.id)}>${e.name}</${Opt}>`)}
          ${hasPersonal ? html`<${Opt} checked=${ownIn} onClick=${() => toggleData('personal')}>Your own money (Personal)</${Opt}>` : null}`
      case 'data':
        return DATA_TYPES.map((d) => html`<${Opt} checked=${shape.dataTypes.includes(d.key)} onClick=${() => toggleData(d.key)}>${d.label[0]!.toUpperCase() + d.label.slice(1)}</${Opt}>`)
      case 'write':
        return html`
          <${Opt} role="menuitemradio" checked=${!shape.write} onClick=${() => (onChange({ ...shape, write: false }), setOpen(null))}>Read only</${Opt}>
          <${Opt} role="menuitemradio" checked=${shape.write} onClick=${() => (onChange({ ...shape, write: true }), setOpen(null))}>Can add records</${Opt}>`
      case 'review':
        return html`
          <${Opt} role="menuitemradio" checked=${shape.reviewMode === 'instant'} onClick=${() => (onChange({ ...shape, reviewMode: 'instant' }), setOpen(null))}>Changes apply immediately</${Opt}>
          <${Opt} role="menuitemradio" checked=${shape.reviewMode === 'review_all'} onClick=${() => (onChange({ ...shape, reviewMode: 'review_all' }), setOpen(null))}>Changes wait for my review</${Opt}>`
      case 'expiry':
        return EXPIRY_CHOICES.map(
          (c) => html`<${Opt} role="menuitemradio" checked=${c.days === null ? shape.expiresAt === null : false} onClick=${() => (onChange({ ...shape, expiresAt: expiresAtFor(c.days, now) }), setOpen(null))}>${c.days === null ? 'Never expires' : 'Expires ' + c.label}</${Opt}>`,
        )
    }
  }

  // Each clause is an inline span acting as a button, not a <button>: a button is one box, so a clause that wraps
  // pushed the full stop and every later clause onto lines of their own.
  const toggle = (slot: Slot) => setOpen(open === slot ? null : slot)
  return html`<div>
    <p class="sentence">
      ${parts.map((p) =>
        'slot' in p
          ? html`<span class="popwrap"><span role="button" tabindex="0" class="slot" aria-haspopup="true" aria-expanded=${open === p.slot ? 'true' : 'false'} onClick=${() => toggle(p.slot)} onKeyDown=${(e: KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle(p.slot))} data-slot=${p.slot}>${p.text}</span><${Popover} open=${open === p.slot} onClose=${() => setOpen(null)} label=${'Change ' + p.slot}>${menu(p.slot)}</${Popover}></span>`
          : p.text,
      )}
    </p>
    ${nudge ? html`<p class="sub" style="margin-top:8px">Your Personal money isn’t included, so ${client} can’t answer about it. <button type="button" class="link" onClick=${() => toggleData('personal')}>Include it</button></p>` : null}
    <p class="sub cant">${CANT_EVER}</p>
  </div>`
}
