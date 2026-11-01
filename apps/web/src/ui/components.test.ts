// @vitest-environment happy-dom
import type { GrantShape } from '@agfn/contracts'
import { fireEvent, render, screen } from '@testing-library/preact'
import { useState } from 'preact/hooks'
import { describe, expect, it, vi } from 'vitest'
import type { EntitySummary } from '../api/types.ts'
import { tick } from '../test/setup.ts'
import { PlusAction, Row, Rows, Section, Sparkline, Toggle } from './components.ts'
import { ControlSentence } from './control-sentence.ts'
import { Drawer } from './drawer.ts'
import { html } from './html.ts'

describe('Section and Row', () => {
  it('renders heading, grey line and rows as a labelled region', () => {
    const onClick = vi.fn()
    render(html`<${Section} title="Money" sub="Cash in each company"><${Rows}><${Row} name="Acme" right="$284,410" onClick=${onClick} /></${Rows}><${PlusAction} onClick=${() => {}}>Add a company</${PlusAction}></${Section}>`)
    const region = screen.getByRole('region', { name: 'Money' })
    expect(region.textContent).toContain('Cash in each company')
    fireEvent.click(screen.getByRole('button', { name: /Acme/ }))
    expect(onClick).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: /Add a company/ }).className).toBe('plus')
  })
  it('a row without onClick is not a button', () => {
    render(html`<${Rows}><${Row} name="Plain" /></${Rows}>`)
    expect(screen.queryByRole('button')).toBeNull()
  })
  it('toggle is a switch with state', () => {
    const onChange = vi.fn()
    render(html`<${Toggle} label="Monday email" checked=${true} onChange=${onChange} />`)
    const sw = screen.getByRole('switch', { name: 'Monday email' })
    expect(sw.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sw)
    expect(onChange).toHaveBeenCalledWith(false)
  })
  it('sparkline needs two points and is labelled', () => {
    const { container } = render(html`<div><${Sparkline} points=${[1]} label="x" /><${Sparkline} points=${[1, 3, 2]} label="Acme cash" /></div>`)
    expect(container.querySelectorAll('svg')).toHaveLength(1)
    expect(screen.getByRole('img', { name: 'Acme cash' })).toBeTruthy()
  })
})

describe('Drawer', () => {
  it('is a modal dialog: focuses its title, traps Tab, closes on Escape and restores focus', async () => {
    const onClose = vi.fn()
    function Host() {
      const [open, setOpen] = useState(false)
      return html`<div>
        <button onClick=${() => setOpen(true)}>Open</button>
        ${open ? html`<${Drawer} title="Acme" onClose=${() => (onClose(), setOpen(false))}><button>Inside</button></${Drawer}>` : null}
      </div>`
    }
    render(html`<${Host} />`)
    const opener = screen.getByRole('button', { name: 'Open' })
    opener.focus()
    fireEvent.click(opener)
    await tick()
    const dialog = screen.getByRole('dialog', { name: 'Acme' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement?.textContent).toBe('Acme')
    const inside = screen.getByRole('button', { name: 'Inside' })
    inside.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    await tick()
    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })
  it('shows Back only when there is somewhere to go back to', () => {
    const onBack = vi.fn()
    render(html`<${Drawer} title="Rent" onClose=${() => {}} onBack=${onBack} backLabel="Acme" />`)
    fireEvent.click(screen.getByRole('button', { name: 'Acme' }))
    expect(onBack).toHaveBeenCalled()
  })
})

describe('ControlSentence', () => {
  const now = Date.parse('2026-10-09T16:00:00Z')
  const ents: EntitySummary[] = [
    { id: 'a', kind: 'company', name: 'Acme', currency: 'USD', cash: null, hidden: false },
    { id: 'n', kind: 'company', name: 'Bluebird Studio', currency: 'USD', cash: null, hidden: false },
  ]
  const base: GrantShape = { entityIds: ['a', 'n'], dataTypes: ['balances', 'transactions', 'invoices'], write: true, reviewMode: 'instant', expiresAt: new Date(now + 90 * 864e5).toISOString() }

  function Host({ spy }: { spy: (s: GrantShape) => void }) {
    const [shape, setShape] = useState(base)
    return html`<${ControlSentence} client="Claude" shape=${shape} entities=${ents} now=${now} onChange=${(s: GrantShape) => (spy(s), setShape(s))} />`
  }

  it('reads as one sentence with the permanent line', () => {
    const { container } = render(html`<${Host} spy=${() => {}} />`)
    expect(container.querySelector('.sentence')?.textContent).toBe(
      'Claude can see Acme and Bluebird Studio: balances, transactions, invoices. Can add records. Changes apply immediately. Expires in 90 days.',
    )
    expect(container.textContent).toContain('Can’t ever: move money, pay bills, send invoices or emails.')
  })
  it('click a word to change it', async () => {
    const spy = vi.fn()
    const { container } = render(html`<${Host} spy=${spy} />`)
    const slot = screen.getByRole('button', { name: 'Can add records' })
    expect(slot.getAttribute('aria-haspopup')).toBe('true')
    fireEvent.click(slot)
    expect(slot.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Read only' }))
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ write: false }))
    await tick()
    expect(container.querySelector('.sentence')?.textContent).toContain('Read only.')
  })
  it('removes a company and adds a data type', () => {
    const spy = vi.fn()
    render(html`<${Host} spy=${spy} />`)
    fireEvent.click(screen.getByRole('button', { name: 'Acme and Bluebird Studio' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Bluebird Studio' }))
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ entityIds: ['a'] }))
    fireEvent.click(screen.getByRole('button', { name: /balances, transactions, invoices/ }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Payroll' }))
    expect(spy.mock.lastCall?.[0].dataTypes).toContain('payroll')
  })
  it('never offers companies beyond the connecting person', () => {
    render(html`<${ControlSentence} client="Claude" shape=${{ ...base, entityIds: ['a'] }} entities=${ents} allowedEntityIds=${['a']} onChange=${() => {}} now=${now} />`)
    fireEvent.click(screen.getByRole('button', { name: 'Acme' }))
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Bluebird Studio' })).toBeNull()
  })
  it('Escape closes the menu', async () => {
    render(html`<${Host} spy=${() => {}} />`)
    fireEvent.click(screen.getByRole('button', { name: 'Changes apply immediately' }))
    const opt = screen.getByRole('menuitemradio', { name: 'Changes wait for my review' })
    fireEvent.keyDown(opt, { key: 'Escape' })
    await tick()
    expect(screen.queryByRole('menuitemradio')).toBeNull()
  })
})
