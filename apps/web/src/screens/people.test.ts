// @vitest-environment happy-dom
// People: remove someone, cancel or re-send an invite, make someone an owner, leave a workspace, and take an invite
// that went to another address (dc's routes: f0a897a9, 65c80ac9).
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact'
import { afterEach, describe, expect, it } from 'vitest'
import { HttpError } from '../api/http.ts'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import { gridFor } from '../lib/roles.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'

afterEach(() => history.replaceState(null, '', '/'))

const start = (api: MockApi, hash: string) => {
  location.hash = hash
  return render(html`<${Root} api=${api} />`)
}
/** Dana (owner, signed in), Maria (invited accountant) and Sam (an admin who has joined). */
const team = (myRole = 'owner') => {
  const api = new MockApi()
  api.s.prefs.people.push({ id: 'p_sam', name: 'Sam Lee', email: 'sam@acme.example', role: 'admin', entityIds: 'all', grid: gridFor('admin'), pending: false })
  api.s.me = { ...api.s.me, workspaces: [{ id: api.s.me.workspaceId, name: 'Acme', role: myRole }] }
  if (myRole !== 'owner') api.s.prefs.people.find((x) => x.id === 'p_owner')!.role = myRole as 'admin'
  if (myRole !== 'owner') api.s.prefs.people.push({ id: 'p_ana', name: 'Ana Ortiz', email: 'ana@acme.example', role: 'owner', entityIds: 'all', grid: gridFor('owner'), pending: false })
  return api
}

describe('Person drawer', () => {
  it('Remove asks first, then the person is gone from the list', async () => {
    const api = team()
    start(api, '#/preferences?d=person:p_sam')
    fireEvent.click(await screen.findByRole('button', { name: 'Remove from workspace' }))
    expect(screen.getByText(/Remove Sam Lee\? They lose access to this workspace/)).toBeTruthy()
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Cancel'))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }))
    await screen.findByText('Sam Lee is removed.')
    expect(api.s.prefs.people.some((x) => x.id === 'p_sam')).toBe(false)
    await waitFor(() => expect(screen.queryByRole('button', { name: /Sam Lee/ })).toBeNull())
  })

  it('the server’s reason shows inside, and the person stays', async () => {
    const api = team()
    api.removePerson = async () => {
      throw new HttpError(409, 'They’re the only owner. Make someone else an owner first.', 'last_owner')
    }
    start(api, '#/preferences?d=person:p_sam')
    fireEvent.click(await screen.findByRole('button', { name: 'Remove from workspace' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }))
    expect(await screen.findByText('They’re the only owner. Make someone else an owner first.')).toBeTruthy()
  })

  it('an invite can be re-sent or cancelled', async () => {
    const api = team()
    start(api, '#/preferences?d=person:p_maria')
    fireEvent.click(await screen.findByRole('button', { name: 'Resend invite' }))
    await screen.findByText('A new invite is on its way to maria@cole.example.')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel invite' }))
    expect(screen.getByText(/Cancel the invite to maria@cole\.example\? The link in it stops working\./)).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel invite' }).at(-1)!)
    await screen.findByText('The invite to maria@cole.example is cancelled.')
    expect(api.s.prefs.people.some((x) => x.id === 'p_maria')).toBe(false)
  })

  it('an owner can make someone an owner; an admin isn’t offered it', async () => {
    const api = team()
    const v = start(api, '#/preferences?d=person:p_sam')
    fireEvent.click(await screen.findByRole('radio', { name: /Owner/ }))
    await waitFor(() => expect(api.s.prefs.people.find((x) => x.id === 'p_sam')!.role).toBe('owner'))
    v.unmount()
    start(team('admin'), '#/preferences?d=person:p_sam')
    await screen.findByRole('radio', { name: /Admin/ })
    expect(screen.queryByRole('radio', { name: /^Owner/ })).toBeNull()
  })
})

describe('People list', () => {
  it('an admin can’t open an owner or themselves; an owner can open everyone else', async () => {
    const v = start(team('admin'), '#/preferences')
    await screen.findByText('Sam Lee')
    expect(screen.queryByRole('button', { name: /Ana Ortiz/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Dana Reyes/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Sam Lee/ })).toBeTruthy()
    v.unmount()
    start(team(), '#/preferences')
    expect(await screen.findByRole('button', { name: /Sam Lee/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Dana Reyes/ })).toBeNull()
  })
})

describe('Leave workspace', () => {
  it('not for the only owner', async () => {
    start(new MockApi(), '#/preferences')
    await screen.findByText('People')
    expect(screen.queryByRole('button', { name: 'Leave workspace' })).toBeNull()
  })

  it('anyone else leaves after a confirm, and lands where they still belong (setup when nowhere)', async () => {
    const api = team('admin')
    api.s.me.demo = false
    start(api, '#/preferences')
    fireEvent.click(await screen.findByRole('button', { name: 'Leave workspace' }))
    expect(screen.getByText(/Leave Acme\? You lose access to its companies/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }))
    await screen.findByText('You left Acme.')
    await waitFor(() => expect(location.hash).toContain('welcome'))
  })
})

describe('An invite sent to another address', () => {
  it('asks first; Join takes it with this account', async () => {
    const api = new MockApi()
    api.inviteClaim = { invitedEmail: 'dana@work.example' }
    history.replaceState(null, '', '/?invite=inv_0123456789abcdef#/')
    start(api, '#/')
    expect(await screen.findByRole('heading', { name: 'Join Acme?' })).toBeTruthy()
    expect(screen.getByText(/Sam Lee invited dana@work\.example\. You’re signed in as dana@example\.com\./)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Join with this account' }))
    await screen.findByText('Welcome to Acme.')
    expect(api.accepted).toBe('inv_0123456789abcdef')
  })

  it('Not now leaves it untouched', async () => {
    const api = new MockApi()
    api.inviteClaim = { invitedEmail: 'dana@work.example' }
    history.replaceState(null, '', '/?invite=inv_0123456789abcdef#/')
    start(api, '#/')
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Join Acme?' })).toBeNull())
    expect(api.accepted).toBeNull()
  })
})
