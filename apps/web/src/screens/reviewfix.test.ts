// @vitest-environment happy-dom
import { render, screen } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'
import { namesLine } from './review.ts'

const start = (api: MockApi, hash: string) => {
  location.hash = hash
  return render(html`<${Root} api=${api} />`)
}

describe('A short set-aside in Review', () => {
  it('reads plainly and has nothing to confirm or reject', async () => {
    const api = new MockApi()
    api.review = async () => [{ id: 'underfunded_set_aside:a1', kind: 'set_aside_short', title: 'Set-aside is short', detail: 'Savings has $3,000 but $5,000 is set aside from it.', entityName: 'Acme', createdAt: '2026-11-01T12:00:00.000Z' }] as never
    start(api, '#/review')
    expect(await screen.findByText('Savings has $3,000 but $5,000 is set aside from it.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull()
  })
})

describe('Review while loading', () => {
  it('says Loading… (never "Nothing waiting.") until the list arrives', async () => {
    const api = new MockApi()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const base = api.review.bind(api)
    api.review = async () => (await gate, base())
    start(api, '#/review')
    await screen.findByText('Loading…')
    expect(screen.queryByText('Nothing waiting.')).toBeNull()
    release()
    await screen.findByText(/^\d+ questions?|Nothing waiting\./)
    expect(screen.queryByText('Loading…')).toBeNull()
  })
})

describe('batch names', () => {
  it('names two, then a count', () => {
    expect(namesLine(['A'])).toBe('A')
    expect(namesLine(['A', 'B'])).toBe('A and B')
    expect(namesLine(['A', 'B', 'C'])).toBe('A, B and C')
    expect(namesLine(['Plaid Checking ··0000', 'Plaid Saving ··1111', 'c', 'd', 'e', 'f', 'g', 'h', 'i'])).toBe('Plaid Checking ··0000, Plaid Saving ··1111 and 7 more')
  })
})

describe('Shared links in Preferences', () => {
  it('an owner with a draft sees it listed', async () => {
    const api = new MockApi()
    api.s.me = { ...api.s.me, workspaces: [{ id: api.s.me.workspaceId, name: 'Demo', role: 'owner' }] }
    await api.shareDraft('e_acme', 'runway')
    start(api, '#/preferences')
    await screen.findByRole('heading', { name: 'Shared links' })
  })
})
