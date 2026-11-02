// @vitest-environment happy-dom
// The Review rework: plain questions, one line for same-kind items, what was filed behind +, the AI line.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { MockApi } from '../api/mock.ts'
import type { ReviewItem } from '../api/types.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'
import { topLine } from './review.ts'

const at = new Date().toISOString()
const q = (id: string, more: Partial<ReviewItem> = {}): ReviewItem => ({ id, kind: 'match', title: `Old title ${id}`, detail: '', entityName: 'Acme', createdAt: at, question: `Did you move $500 (${id})?`, confirmLabel: 'Yes', rejectLabel: 'No', ...more })
const start = (api: MockApi) => {
  location.hash = '#/review'
  return render(html`<${Root} api=${api} />`)
}

describe('Review', () => {
  it('top line counts questions and what was filed', () => {
    expect(topLine(1, 0)).toBe('1 question')
    expect(topLine(3, 12)).toBe('3 questions · 12 filed for you')
    expect(topLine(0, 2)).toBe('Nothing waiting · 2 filed for you')
    expect(topLine(0, 2, 1)).toBe('Nothing to answer · 2 filed for you')
  })

  it('a question shows plainly with Yes and No; No sends reject', async () => {
    const api = new MockApi()
    api.s.review = [q('a')]
    const sent: unknown[] = []
    const base = api.resolve.bind(api)
    api.resolve = ((id: string, d: unknown) => (sent.push(d), (base as (i: string) => Promise<void>)(id))) as typeof api.resolve
    start(api)
    await screen.findByText('Did you move $500 (a)?')
    expect(screen.queryByText('Old title a')).toBeNull()
    expect(screen.getByRole('button', { name: 'Yes' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'No' }))
    await waitFor(() => expect(sent).toEqual([{ action: 'reject' }]))
  })

  it('keeps the server’s order and offers the AI', async () => {
    const api = new MockApi()
    api.s.review = [q('big'), q('small')]
    start(api)
    await screen.findByText('Did you move $500 (big)?')
    const rows = [...document.querySelectorAll('[data-review]')].map((r) => r.getAttribute('data-review'))
    expect(rows).toEqual(['big', 'small'])
    expect(screen.getByText('Or ask your AI to go through these.')).toBeTruthy()
  })

  it('same-kind items are one line; Confirm all sends the ids shown; each is behind +', async () => {
    const api = new MockApi()
    const group = { key: 'moves', label: '2 moves between your own accounts' }
    api.s.review = [q('m1', { group }), q('m2', { group }), q('solo')]
    let sent: unknown
    const base = api.confirmGroup.bind(api)
    api.confirmGroup = (k, ids) => ((sent = { k, ids }), base(k, ids))
    start(api)
    await screen.findByText('2 moves between your own accounts')
    expect(screen.queryByText('Did you move $500 (m1)?')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /See each one/ }))
    await screen.findByText('Did you move $500 (m1)?')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm all' }))
    await screen.findByText('Confirmed 2.')
    expect(sent).toEqual({ k: 'moves', ids: ['m1', 'm2'] })
  })

  it('a group with one item left is just its question', async () => {
    const api = new MockApi()
    api.s.review = [q('m1', { group: { key: 'moves', label: '1 move' } })]
    start(api)
    await screen.findByText('Did you move $500 (m1)?')
    expect(screen.queryByRole('button', { name: 'Confirm all' })).toBeNull()
  })

  it('other possible matches sit behind +, and each resolves by its own id', async () => {
    const api = new MockApi()
    api.s.review = [q('best', { alternatives: [{ id: 'alt', question: 'Or this deposit on Oct 23?', detail: '' }] })]
    const ids: string[] = []
    const base = api.resolve.bind(api)
    api.resolve = ((id: string) => (ids.push(id), (base as (i: string) => Promise<void>)(id))) as typeof api.resolve
    start(api)
    fireEvent.click(await screen.findByRole('button', { name: /1 other possible match/ }))
    const line = (await screen.findByText(/Or this deposit on Oct 23\?/)).closest('.line') as HTMLElement
    fireEvent.click(within(line).getByRole('button', { name: 'Yes' }))
    await waitFor(() => expect(ids).toEqual(['alt']))
  })

  it('what was filed is a count on top, a list behind +, and undo', async () => {
    const api = new MockApi()
    api.s.review = [q('a')]
    api.filed = [{ id: 'link:1', text: 'Moved $200 from Chase to Ally', filedAt: at }]
    start(api)
    await screen.findByText(/1 question · 1 filed for you/)
    expect(screen.queryByText('Moved $200 from Chase to Ally')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /See what was filed/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Undo Moved $200 from Chase to Ally' }))
    await waitFor(() => expect(api.filed).toEqual([]))
  })

  it('a notice has nothing to answer: no Yes, a link to the company, and it doesn’t count as a question', async () => {
    const api = new MockApi()
    const id = api.s.entities.find((e) => e.kind === 'company')!.id
    api.s.review = [{ id: 'underfunded_set_aside:a', kind: 'set_aside_short', title: 'Set-aside is short', detail: 'Savings has $100 but $500 is set aside.', entityName: 'Acme', entityId: id, createdAt: at }]
    start(api)
    await screen.findByText('Set-aside is short')
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Open Acme' })).toBeTruthy()
    expect(screen.getByText(/Nothing to answer/)).toBeTruthy()
  })
})
