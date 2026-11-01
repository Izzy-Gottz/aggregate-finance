// @vitest-environment happy-dom
// Leaving a full demo takes seconds on the server (43, staging): the link says so and a second press does nothing.
import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'

describe('Leaving the demo', () => {
  it('shows "Leaving the demo…" while the server works, and leaves once', async () => {
    const api = new MockApi()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const base = api.leaveDemo.bind(api)
    let calls = 0
    api.leaveDemo = async () => (calls++, await gate, base())
    location.hash = '#/'
    render(html`<${Root} api=${api} />`)
    fireEvent.click(await screen.findByRole('button', { name: 'Start with your own companies →' }))
    // The bar's link and the menu's button both say so.
    const busy = await screen.findAllByRole('button', { name: 'Leaving the demo…' })
    expect(busy.every((b) => (b as HTMLButtonElement).disabled)).toBe(true)
    fireEvent.click(busy[0]!)
    release()
    await waitFor(() => expect(screen.queryByText(/You’re looking at a demo/)).toBeNull())
    expect(calls).toBe(1)
  })
})
