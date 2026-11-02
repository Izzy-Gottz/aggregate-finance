// @vitest-environment happy-dom
// Add cash reaches someone with only a Personal space.
import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'

describe('Add cash on Personal', () => {
  it('works with no company, and doesn’t ask whose money paid', async () => {
    const api = new MockApi()
    api.s.entities = api.s.entities.filter((e) => e.kind === 'personal')
    const personal = api.s.entities[0]!
    let sent: { entityId: string; paidBy?: string } | undefined
    const base = api.addCash.bind(api)
    api.addCash = (e) => ((sent = e), base(e).then((r) => ({ ...r, summary: 'expense 40.00 USD in Sam Lee, paid personally, not taken from any account' })))
    location.hash = '#/?d=add:cash'
    render(html`<${Root} api=${api} />`)
    await waitFor(() => expect((screen.getByLabelText('Where') as HTMLSelectElement).value).toBe(personal.id))
    fireEvent.click(screen.getByRole('button', { name: 'Money out' }))
    expect(screen.queryByText('Whose money paid')).toBeNull()
    fireEvent.input(screen.getByLabelText('Amount'), { target: { value: '40' } })
    fireEvent.input(screen.getByLabelText(/Paid to/), { target: { value: 'Corner store' } })
    fireEvent.submit(screen.getByLabelText('Amount').closest('form')!)
    await waitFor(() => expect(sent).toMatchObject({ entityId: personal.id, paidBy: 'company' }))
    await screen.findByText(/^\$40(\.00)? paid personally, not taken from any account\.$/)
  })
})
