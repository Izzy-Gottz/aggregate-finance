// @vitest-environment happy-dom
// More than one workspace: a reload or new tab stays in the one you chose, and the company menu switches between them.
import { fireEvent, render, screen, within } from '@testing-library/preact'
import { describe, expect, it, vi } from 'vitest'
import { HttpApi } from '../api/http.ts'
import { MockApi } from '../api/mock.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'
import { Root } from './app.ts'

const header = (init: RequestInit) => (init.headers as Record<string, string>)['x-agfn-workspace']

describe('workspaces', () => {
  it('a new HttpApi (reload, new tab) starts in the last workspace chosen in this browser', async () => {
    const calls: RequestInit[] = []
    const f = vi.fn(async (_url: string, init: RequestInit) => (calls.push(init), new Response(JSON.stringify({ id: 'b1' }), { status: 200 })))
    new HttpApi({ fetch: f as unknown as typeof fetch }).setWorkspace('ws_invited')
    await new HttpApi({ fetch: f as unknown as typeof fetch }).bucket('b1')
    expect(header(calls[0]!)).toBe('ws_invited')
  })

  it('the company menu lists the workspaces and switches, and connect names the one it goes into', async () => {
    const api = new MockApi()
    api.s.me.workspaces = [
      { id: api.s.me.workspaceId, name: 'Dana’s companies' },
      { id: 'ws_b', name: 'Northwind board' },
    ]
    const picked: string[] = []
    api.setWorkspace = (id) => void picked.push(id)
    location.hash = '#/'
    render(html`<${Root} api=${api} />`)
    fireEvent.click((await screen.findAllByRole('button', { name: /All companies/ }))[0]!)
    const group = screen.getByRole('group', { name: 'Workspaces' })
    expect(within(group).getByRole('menuitemradio', { name: 'Dana’s companies' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(group).getByRole('menuitemradio', { name: 'Northwind board' }))
    expect(picked).toEqual(['ws_b'])

    location.hash = '#/?d=connect:quickbooks'
    await screen.findByRole('heading', { name: 'Connect QuickBooks' })
    expect(screen.getByText('Into Dana’s companies')).toBeTruthy()
  })
})
