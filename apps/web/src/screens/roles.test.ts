// @vitest-environment happy-dom
// What each role is offered: only owners and admins see the actions the server allows only them (Disconnect, Move,
// Invite, Add a company, a company's name and year start). The rest used to see them and get refused.
import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'

const as = (role: string) => {
  const api = new MockApi()
  api.s.me = { ...api.s.me, workspaces: [{ id: api.s.me.workspaceId, name: 'Acme', role }] }
  return api
}
const start = (api: MockApi, hash: string) => {
  location.hash = hash
  return render(html`<${Root} api=${api} />`)
}

describe('Actions by role', () => {
  it('an accountant sees no Disconnect or Move on a connection', async () => {
    start(as('accountant'), '#/?d=connection:c_mercury')
    await screen.findByRole('heading', { name: 'Mercury' })
    for (const name of ['Disconnect', 'Disconnect and delete its data', 'Move to another company']) expect(screen.queryByRole('button', { name })).toBeNull()
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeTruthy()
  })

  it('an accountant sees no Invite someone or Add a company', async () => {
    start(as('accountant'), '#/preferences')
    await screen.findByText('Sign-in')
    expect(screen.queryByRole('button', { name: /Invite someone/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Add a company/ })).toBeNull()
  })

  it('an admin keeps them', async () => {
    start(as('admin'), '#/?d=connection:c_mercury')
    expect(await screen.findByRole('button', { name: 'Disconnect' })).toBeTruthy()
  })

  it('a member sees no name and year start on a company', async () => {
    start(as('employee'), '#/?d=company:e_acme')
    await screen.findByRole('heading', { name: 'Acme' })
    expect(screen.queryByRole('button', { name: /Name and year start/ })).toBeNull()
  })
})

describe('Company name and year start', () => {
  it('an owner renames a company and moves its year start', async () => {
    const api = as('owner')
    start(api, '#/?d=company:e_acme')
    fireEvent.click(await screen.findByRole('button', { name: /Name and year start/ }))
    const year = await screen.findByLabelText('Year starts')
    await waitFor(() => expect((year as HTMLSelectElement).disabled).toBe(false))
    fireEvent.input(screen.getByLabelText('Name'), { target: { value: '  Acme   Labs ' } })
    fireEvent.change(year, { target: { value: '7' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Saved.')
    const c = api.s.prefs.companies.find((x) => x.id === 'e_acme')!
    expect(c.name).toBe('Acme Labs')
    expect(c.fiscalYearStartMonth).toBe(7)
    expect(api.s.entities.find((x) => x.id === 'e_acme')!.name).toBe('Acme Labs')
  })

  it('an empty name is refused before saving', async () => {
    start(as('owner'), '#/?d=company:e_acme')
    fireEvent.click(await screen.findByRole('button', { name: /Name and year start/ }))
    await waitFor(() => expect((screen.getByLabelText('Year starts') as HTMLSelectElement).disabled).toBe(false))
    fireEvent.input(screen.getByLabelText('Name'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent).toBe('A company needs a name.')
  })
})
