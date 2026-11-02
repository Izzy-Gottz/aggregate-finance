// @vitest-environment happy-dom
// No email-in on this server (inbound: []): no palette entry, and a saved link lands on adding a file, not an empty drawer.
import { fireEvent, render, screen, within } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'

const noInbound = () => {
  const api = new MockApi()
  const base = api.workspace.bind(api)
  api.workspace = (async () => ({ ...(await base()), inbound: [] })) as typeof api.workspace
  return api
}

describe('Email-in when the server has no addresses', () => {
  it('a saved link opens Upload, never an empty "Email it in"', async () => {
    location.hash = '#/?d=add:email'
    render(html`<${Root} api=${noInbound()} />`)
    const drawer = await screen.findByRole('dialog')
    await within(drawer).findByRole('heading', { name: /Upload/ })
    expect(screen.queryByRole('heading', { name: 'Email it in' })).toBeNull()
  })

  it('addresses present: the drawer still opens', async () => {
    location.hash = '#/?d=add:email'
    render(html`<${Root} api=${new MockApi()} />`)
    await screen.findByRole('heading', { name: 'Email it in' })
  })

  it('the command palette doesn’t offer it', async () => {
    location.hash = '#/'
    render(html`<${Root} api=${noInbound()} />`)
    await screen.findByRole('heading', { name: 'Money' })
    fireEvent.keyDown(document, { key: 'k', metaKey: true })
    await screen.findByRole('combobox')
    expect(screen.queryByText('Email addresses for bills and receipts')).toBeNull()
  })
})
