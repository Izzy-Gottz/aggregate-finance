// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'

const start = (api: MockApi, hash: string) => {
  location.hash = hash
  return render(html`<${Root} api=${api} />`)
}

describe('Delete an empty company', () => {
  it('an empty company can be deleted after an inline confirm, and leaves the list', async () => {
    const api = new MockApi()
    const e = await api.createCompany('Test Co')
    start(api, `#/?d=company:${e.id}`)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete company' }))
    expect(screen.getByText(/Delete Test Co\? Nothing connects to it or counts in it any more\./)).toBeTruthy()
    // Cancel keeps it.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete company' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await screen.findByText('Test Co is deleted.')
    await waitFor(() => expect(api.s.entities.some((x) => x.id === e.id)).toBe(false))
  })

  it('a company with a live connection says what to disconnect first, with no Delete', async () => {
    start(new MockApi(), '#/?d=company:e_acme')
    fireEvent.click(await screen.findByRole('button', { name: 'Delete company' }))
    expect(screen.getByText(/Acme can’t be deleted yet\. Disconnect Chase first\./)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
  })

  it('only owners see it: an admin doesn’t', async () => {
    const api = new MockApi()
    const e = await api.createCompany('Test Co')
    api.s.me = { ...api.s.me, workspaces: [{ id: api.s.me.workspaceId, name: 'Acme', role: 'admin' }] }
    start(api, `#/?d=company:${e.id}`)
    await screen.findByRole('heading', { name: 'Test Co' })
    expect(screen.queryByRole('button', { name: 'Delete company' })).toBeNull()
  })

  it('the server’s reason shows inside the confirm when it refuses', async () => {
    const api = new MockApi()
    const e = await api.createCompany('Test Co')
    api.deleteCompany = async () => {
      throw new Error('Test Co can’t be deleted: It still has a connection. Disconnect it first.')
    }
    start(api, `#/?d=company:${e.id}`)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete company' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText(/It still has a connection\. Disconnect it first\./)).toBeTruthy()
    expect(api.s.entities.some((x) => x.id === e.id)).toBe(true)
  })

  it('deleting the company the switcher is on goes back to All companies', async () => {
    const api = new MockApi()
    const e = await api.createCompany('Test Co')
    start(api, `#/?d=company:${e.id}`)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete company' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await screen.findByText('Test Co is deleted.')
    await waitFor(() => expect(location.hash).not.toContain(e.id))
  })

  it('not in the public demo', async () => {
    const api = new MockApi()
    const e = await api.createCompany('Test Co')
    api.s.me = { ...api.s.me, publicDemo: true }
    start(api, `#/?d=company:${e.id}`)
    await screen.findByRole('heading', { name: 'Test Co' })
    expect(screen.queryByRole('button', { name: 'Delete company' })).toBeNull()
  })

  it('Rename company and Delete company sit at the top of the drawer, above the figures', async () => {
    const api = new MockApi()
    api.s.me.demo = false
    const id = api.s.entities.find((e) => e.kind === 'company')!.id
    location.hash = `#/?d=company:${id}`
    render(html`<${Root} api=${api} />`)
    const del = await screen.findByRole('button', { name: 'Delete company' })
    const rename = screen.getByRole('button', { name: /Rename company/ })
    expect(rename.compareDocumentPosition(del) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const figures = screen.getAllByRole('heading').filter((h) => !h.classList.contains('dtitle') && h.closest('.dbody'))[0]!
    expect(del.compareDocumentPosition(figures) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
