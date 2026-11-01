// @vitest-environment happy-dom
// Deleting a workspace says whose Personal connections go with it (dc's preview, 29af2b5b): names and counts only.
import { render, screen } from '@testing-library/preact'
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
    await screen.findByText('Export everything first if you want a copy.')
    expect(screen.queryByText(/It also disconnects/)).toBeNull()
  })

  it('reads well for one, and for three', () => {
    expect(alsoLine([{ name: 'Ana Ortiz', email: 'a@x', personalConnections: 3 }])).toBe('It also disconnects the Personal accounts of Ana Ortiz (3 connections). We’ll email them first.')
    expect(alsoLine([{ name: '', email: 'a@x', personalConnections: 1 }, { name: 'B', email: 'b@x', personalConnections: 1 }, { name: 'C', email: 'c@x', personalConnections: 1 }])).toBe('It also disconnects the Personal accounts of a@x (1 connection), B (1 connection) and C (1 connection). We’ll email each of them first.')
  })
})
