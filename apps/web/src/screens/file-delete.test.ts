// @vitest-environment happy-dom
// "Delete file" on files nothing was imported from (dc's DELETE /api/documents/:id): the way out of a company-delete
// blocked by "It has files. Delete them first."
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { HttpError } from '../api/http.ts'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'

const start = (api: MockApi, hash: string) => {
  location.hash = hash
  return render(html`<${Root} api=${api} />`)
}
const unread = (api: MockApi) => {
  api.unread = [{ documentId: 'd9', name: 'invoice-0042.pdf', entityId: 'e_acme', arrivedVia: 'email', createdAt: new Date().toISOString() }]
}

describe('Delete file', () => {
  it('an unread file: asks first, then deletes it, says so, and the row goes', async () => {
    const api = new MockApi()
    unread(api)
    let reloads = 0
    const me = api.me.bind(api)
    api.me = (() => (reloads++, me())) as typeof api.me
    start(api, '#/?d=company:e_acme')
    const sec = await screen.findByRole('region', { name: 'Waiting to be read' })
    fireEvent.click(within(sec).getByRole('button', { name: 'Delete file invoice-0042.pdf' }))
    expect(within(sec).getByRole('alert').textContent).toContain('Delete invoice-0042.pdf? This can’t be undone.')
    expect(document.activeElement?.textContent).toBe('Cancel')
    const before = reloads
    fireEvent.click(within(sec).getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('Deleted invoice-0042.pdf.')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Waiting to be read' })).toBeNull())
    // The workspace reloads too (a review item citing it is rejected, so the count changes).
    await waitFor(() => expect(reloads).toBeGreaterThan(before))
  })

  it('Cancel keeps it; the server’s refusal is shown as given', async () => {
    const api = new MockApi()
    unread(api)
    api.deleteDocument = async () => {
      throw new HttpError(409, 'This statement was imported. Remove it with its connection’s “Delete its data”.')
    }
    start(api, '#/?d=company:e_acme')
    const sec = await screen.findByRole('region', { name: 'Waiting to be read' })
    fireEvent.click(within(sec).getByRole('button', { name: 'Delete file invoice-0042.pdf' }))
    fireEvent.click(within(sec).getByRole('button', { name: 'Cancel' }))
    expect(document.activeElement?.textContent).toContain('Delete file')
    fireEvent.click(within(sec).getByRole('button', { name: 'Delete file invoice-0042.pdf' }))
    fireEvent.click(within(sec).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(sec.textContent).toContain('This statement was imported. Remove it with its connection’s “Delete its data”.'))
    expect(sec.textContent).toContain('invoice-0042.pdf')
  })

  it('already gone (404): just refreshes the list, no error', async () => {
    const api = new MockApi()
    unread(api)
    api.deleteDocument = async () => {
      api.unread = []
      throw new HttpError(404, 'That file no longer exists.')
    }
    start(api, '#/?d=company:e_acme')
    const sec = await screen.findByRole('region', { name: 'Waiting to be read' })
    fireEvent.click(within(sec).getByRole('button', { name: 'Delete file invoice-0042.pdf' }))
    fireEvent.click(within(sec).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Waiting to be read' })).toBeNull())
    expect(screen.queryByText('That file no longer exists.')).toBeNull()
  })

  it('a statement waiting for an account can be deleted from the Workspace line', async () => {
    const api = new MockApi()
    api.waiting = [{ documentId: 'd1', name: 'chase-aug.csv', entityId: 'e_acme', arrivedVia: 'email', createdAt: new Date().toISOString(), accounts: [{ id: 'a1', name: 'Checking', mask: '4411', institution: 'Chase' }] }]
    start(api, '#/')
    fireEvent.click(await screen.findByRole('button', { name: '1 statement needs an account' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete file chase-aug.csv' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('Deleted chase-aug.csv.')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('button', { name: /statement needs an account/ })).toBeNull())
  })

  it('members don’t see it', async () => {
    const api = new MockApi()
    unread(api)
    ;(api.s.me as { workspaces?: unknown }).workspaces = [{ id: api.s.me.workspaceId, name: 'Demo', role: 'member' }]
    start(api, '#/?d=company:e_acme')
    const sec = await screen.findByRole('region', { name: 'Waiting to be read' })
    expect(within(sec).queryByRole('button', { name: /Delete file/ })).toBeNull()
  })

  it('an unfamiliar CSV still asking about its columns can be deleted right in the upload drawer', async () => {
    const api = new MockApi()
    const asked: string[] = []
    api.deleteDocument = async (id) => (asked.push(id), { ok: true as const, name: 'bank-export.csv' })
    start(api, '#/?d=add:upload')
    const input = (await screen.findByLabelText('Choose files to upload')) as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'bank-export.csv', { type: 'text/csv' })] } })
    await screen.findByText('Which column is the date?')
    fireEvent.click(screen.getByRole('button', { name: 'Delete file bank-export.csv' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('Deleted bank-export.csv.')).toBeTruthy()
    expect(screen.queryByText('Which column is the date?')).toBeNull()
    expect(asked).toHaveLength(1)
  })
})
