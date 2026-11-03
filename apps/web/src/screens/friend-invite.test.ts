// @vitest-environment happy-dom
// Invite someone (their own account) and Add a teammate (this workspace) stay two different things.
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

describe('Invite someone', () => {
  it('says nothing is shared, sends the address, and offers the link', async () => {
    const api = new MockApi()
    api.s.me.demo = false
    let sent = ''
    api.inviteFriend = (async (e: string) => ((sent = e), { ok: true })) as typeof api.inviteFriend
    start(api, '#/?d=friend-invite')
    await screen.findByText('They get their own Aggregate account. Nothing of yours is shared.')
    await screen.findByRole('button', { name: /Copy invite link/i })
    expect(screen.queryByLabelText(/message/i)).toBeNull()
    fireEvent.input(screen.getByLabelText('Email'), { target: { value: 'friend@example.test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }))
    await waitFor(() => expect(sent).toBe('friend@example.test'))
  })

  it('off on this server: nothing offered, and the link opens nothing', async () => {
    const api = new MockApi()
    api.s.me.friendInvites = false
    api.s.me.demo = false
    start(api, '#/')
    await screen.findByRole('heading', { name: 'Money' })
    expect(screen.queryByRole('button', { name: /Invite someone/ })).toBeNull()
    location.hash = '#/?d=friend-invite'
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByText(/Nothing of yours is shared/)).toBeNull()
  })

  it('a demo workspace doesn’t offer it: the server refuses it there', async () => {
    const api = new MockApi()
    api.s.me.demo = true
    start(api, '#/')
    await screen.findByRole('heading', { name: 'Money' })
    expect(screen.queryByRole('button', { name: /Invite someone/ })).toBeNull()
    location.hash = '#/?d=friend-invite'
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByText(/Nothing of yours is shared/)).toBeNull()
  })

  it('shows the server’s plain refusal', async () => {
    const api = new MockApi()
    api.s.me.demo = false
    api.inviteFriend = (async () => {
      throw new HttpError(429, 'That’s 10 invites today. You can send more tomorrow.', 'limit', {})
    }) as typeof api.inviteFriend
    start(api, '#/?d=friend-invite')
    fireEvent.input(await screen.findByLabelText('Email'), { target: { value: 'friend@example.test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }))
    expect((await screen.findByRole('alert')).textContent).toBe('That’s 10 invites today. You can send more tomorrow.')
  })

  it('the sidebar offers it once; Add a teammate sits on the Workspace page', async () => {
    const api = new MockApi()
    api.s.me.demo = false
    start(api, '#/')
    const nav = await screen.findByRole('navigation', { name: 'Main' })
    expect(within(nav).getAllByRole('button', { name: /Invite someone/ })).toHaveLength(1)
    expect(within(nav).queryByRole('button', { name: /Add a teammate/ })).toBeNull()
    expect(screen.queryAllByRole('button', { name: /Invite someone/ })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /Add a teammate/ })).toHaveLength(1)
  })
})
