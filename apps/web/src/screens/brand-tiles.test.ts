// @vitest-environment happy-dom
// Add a connection: brand icons only where ui/brand/README.md allows them, a letter everywhere else, and the notice.
import { readFileSync, statSync } from 'node:fs'
import { render, screen, within } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'
import { SourceTile } from './workspace.ts'

const tile = (connectorKey: string, plaidMark?: boolean) => {
  const { container } = render(html`<${SourceTile} connectorKey=${connectorKey} plaidMark=${plaidMark} />`)
  return container.querySelector('.tile')!
}

describe('Brand icons', () => {
  it.each(['mercury', 'carta', 'shopify', 'square', 'deel', 'ramp', 'simplefin'])('%s shows its icon, hidden from screen readers (the row names it)', (key) => {
    const t = tile(key)
    expect(t.className).toContain(`brand-${key}`)
    expect(t.getAttribute('aria-hidden')).toBe('true')
    expect(t.textContent).toBe('')
  })

  // Forbidden without written permission, or no usable file. Changing this list means changing ui/brand/README.md first.
  it.each(['stripe', 'wefunder', 'paddle', 'polar', 'bill', 'quickbooks', 'xero', 'brex', 'gumroad', 'wise', 'appstoreconnect', 'googleplay', 'woocommerce', 'lightspeed', 'sumup', 'adsense', 'pinterest', 'youtube', 'squarespace', 'wix', 'freshbooks', 'patreon', 'harvest'])('%s keeps a letter', (key) => {
    const t = tile(key)
    expect(t.className).not.toContain('brand-')
    expect(t.textContent).not.toBe('')
  })

  it('Plaid’s mark is only for the row that offers it: a connected bank keeps the bank icon', () => {
    expect(tile('plaid', true).className).toContain('brand-plaid')
    const bank = tile('plaid')
    expect(bank.className).not.toContain('brand-')
    expect(bank.querySelector('svg')).toBeTruthy()
  })

  it('every icon in the stylesheet exists, on a white tile', () => {
    const css = readFileSync('apps/web/src/ui/ui.css', 'utf8')
    for (const key of ['shopify', 'square', 'plaid', 'deel', 'ramp', 'simplefin']) {
      const m = css.match(new RegExp(`\\.tile\\.brand-${key} \\{ background-image: url\\('\\./(brand/[^']+)'\\)`))
      expect(m, key).toBeTruthy()
      expect(statSync(`apps/web/src/ui/${m![1]}`).size).toBeGreaterThan(0)
    }
    expect(css).toMatch(/\.tile\.brand-simplefin \{ background: #fff center/)
  })

  it('the drawer leads with Bank, card or brokerage; with nothing connected it’s the one dark button', async () => {
    const api = new MockApi()
    api.s.connections = []
    location.hash = '#/?d=connect'
    render(html`<${Root} api=${api} />`)
    const drawer = await screen.findByRole('dialog')
    await within(drawer).findByText('Bank, card or brokerage')
    const buttons = within(drawer).getAllByRole('button', { name: /^Connect / })
    expect(buttons[0]!.getAttribute('aria-label')).toBe('Connect Bank or card')
    expect(buttons[0]!.className).not.toContain('quiet')
    expect(buttons[1]!.className).toContain('quiet')
  })

  it('The connections drawer says logos belong to their owners, once the list is there', async () => {
    location.hash = '#/?d=connect'
    render(html`<${Root} api=${new MockApi()} />`)
    const drawer = await screen.findByRole('dialog')
    await within(drawer).findByText('Logos belong to their owners and are shown only to identify services you can connect. No endorsement implied.')
    expect(drawer.querySelector('.tile.brand-plaid')).toBeTruthy()
  })
})

describe('Workspace layout', () => {
  it('Money has no Add a company once there’s one; the switcher keeps it; Connections has one quiet line', async () => {
    const api = new MockApi()
    location.hash = '#/'
    render(html`<${Root} api=${api} />`)
    const money = await screen.findByRole('region', { name: 'Money' })
    await within(money).findByRole('list', { name: 'Companies' })
    expect(within(money).queryByRole('button', { name: /Add a company/ })).toBeNull()
    const conns = await screen.findByRole('region', { name: 'Connections' })
    expect(within(conns).getByRole('button', { name: /Add a connection/ })).toBeTruthy()
    expect(within(conns).queryByRole('button', { name: 'Connect a bank or card' })).toBeNull()
  })

  it('brand-new, nothing connected: still one quiet line, no bank row', async () => {
    const api = new MockApi()
    api.s.connections = []
    location.hash = '#/'
    render(html`<${Root} api=${api} />`)
    const conns = await screen.findByRole('region', { name: 'Connections' })
    expect(within(conns).getByRole('button', { name: /Add a connection/ })).toBeTruthy()
    expect(within(conns).queryByRole('button', { name: 'Connect' })).toBeNull()
  })
})
