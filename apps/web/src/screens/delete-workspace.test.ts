// @vitest-environment happy-dom
// Deleting a workspace says whose Personal connections go with it (dc's preview, 29af2b5b): names and counts only.
import { fireEvent, render, screen } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'
import { alsoLine } from './preferences.ts'

const start = (api: MockApi, hash: string) => {
  location.hash = hash
  return render(html`<${Root} api=${api} />`)
}

describe('Delete workspace: who else is affected', () => {
  it('names the other members and how many Personal connections each loses', async () => {
    const api = new MockApi()
    api.s.me.demo = false
    api.affectedByDelete = [
      { personId: 'p_ana', name: 'Ana Ortiz', email: 'ana@acme.example', personalConnections: 1 },
      { personId: 'p_ben', name: 'Ben Ito', email: 'ben@acme.example', personalConnections: 2 },
    ]
    start(api, '#/preferences?d=delete-workspace')
    expect(await screen.findByText('It also disconnects the Personal accounts of Ana Ortiz (1 connection) and Ben Ito (2 connections). We’ll email each of them first.')).toBeTruthy()
  })

  it('says nothing extra when nobody else is affected', async () => {
    const api = new MockApi()
    api.s.me.demo = false
    start(api, '#/preferences?d=delete-workspace')
    await screen.findByText(/Export everything first if you want a copy\./)
    expect(screen.queryByText(/It also disconnects/)).toBeNull()
  })

  it('never uses a name that can match a company: it says workspace, and that everything goes', async () => {
    const api = new MockApi()
    api.s.me.demo = false
    api.s.me.workspaces = [{ id: api.s.me.workspaceId, name: 'Acme', role: 'owner' }] as never
    start(api, '#/preferences?d=delete-workspace')
    await screen.findByText('This deletes everything: every company, including Personal, all connections and all AI links. To remove one company, use Delete company in that company’s drawer.')
    expect(screen.getByRole('heading', { name: 'Delete workspace' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete workspace' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Delete Acme' })).toBeNull()
    expect(screen.getByLabelText('Type DELETE to confirm')).toBeTruthy()
  })

  it('with several workspaces, says which one, as a workspace', async () => {
    const api = new MockApi()
    api.s.me.demo = false
    api.s.me.workspaces = [{ id: api.s.me.workspaceId, name: 'Acme', role: 'owner' }, { id: 'w2', name: 'Other', role: 'owner' }] as never
    start(api, '#/preferences?d=delete-workspace')
    await screen.findByText(/^This is the workspace named Acme\./)
    expect(screen.getByRole('heading', { name: 'Delete workspace' })).toBeTruthy()
  })

  it('Settings keeps it in its own Delete section, pointing to Delete company', async () => {
    const api = new MockApi()
    api.s.me.demo = false
    start(api, '#/preferences')
    await screen.findByRole('heading', { name: 'Delete' })
    await screen.findByText('To remove one company, open it and use Delete company.')
    expect(screen.getByRole('button', { name: 'Delete workspace' })).toBeTruthy()
  })

  it('lists what’s still connected at a provider and holds it on screen until Done', async () => {
    const api = new MockApi()
    api.s.me.demo = false
    api.deleteWorkspace = (async () => ({ ok: true, notRevoked: ['Delete the key named Aggregate in Ramp.', 'Remove Aggregate in Mercury.'] })) as typeof api.deleteWorkspace
    start(api, '#/preferences?d=delete-workspace')
    fireEvent.input(await screen.findByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete workspace' }).at(-1)!)
    await screen.findByText('Still connected at the provider. Remove these yourself:')
    expect(screen.getByText('Delete the key named Aggregate in Ramp.')).toBeTruthy()
    expect(screen.getByText('Remove Aggregate in Mercury.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await screen.findByText('The workspace and everything in it is deleted. Your banks aren’t affected.')
  })

  it('an account delete says them on the sign-in page, since it signs out', async () => {
    const api = new MockApi()
    api.s.me.demo = false
    const base = api.deleteMe.bind(api)
    api.deleteMe = (async (c: string) => (await base(c), { ok: true, notRevoked: ['Delete the key named Aggregate in Ramp.'] })) as typeof api.deleteMe
    start(api, '#/preferences?d=delete-me')
    fireEvent.input(await screen.findByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete your Aggregate account' }).at(-1)!)
    await screen.findByText('Your account and its data are deleted. Still connected at the provider. Remove these yourself: Delete the key named Aggregate in Ramp.')
  })

  it('account delete can’t be taken for workspace delete: its own title, line and place', async () => {
    const api = new MockApi()
    api.s.me.demo = false
    start(api, '#/preferences')
    await screen.findByText('Every company, including Personal, all connections and AI links. You keep your sign-in.')
    await screen.findByText('Your sign-in and passkeys, and every workspace where you’re the only member.')
    fireEvent.click(screen.getByRole('button', { name: 'Delete your Aggregate account' }))
    await screen.findByRole('heading', { name: 'Delete your Aggregate account' })
    await screen.findByText('You’ll be signed out everywhere and your sign-in, passkeys and every workspace where you’re the only member are erased.')
    expect(screen.getByLabelText('Type DELETE to confirm')).toBeTruthy()
  })

  it('reads well for one, and for three', () => {
    expect(alsoLine([{ name: 'Ana Ortiz', email: 'a@x', personalConnections: 3 }])).toBe('It also disconnects the Personal accounts of Ana Ortiz (3 connections). We’ll email them first.')
    expect(alsoLine([{ name: '', email: 'a@x', personalConnections: 1 }, { name: 'B', email: 'b@x', personalConnections: 1 }, { name: 'C', email: 'c@x', personalConnections: 1 }])).toBe('It also disconnects the Personal accounts of a@x (1 connection), B (1 connection) and C (1 connection). We’ll email each of them first.')
  })
})
