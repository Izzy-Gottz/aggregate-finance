// @vitest-environment happy-dom
// "Don't see your app? Request it +" at the foot of Add a connection: names only, Request turns into Requested, and none
// of it in a demo or on a self-hosted server.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'

const open = (api: MockApi) => {
  location.hash = '#/?d=connect'
  render(html`<${Root} api=${api} />`)
}

describe('Request an app', () => {
  it('opens a list with Hospitable; Request becomes Requested; the filter narrows it; no logos', async () => {
    const api = new MockApi()
    api.s.me.demo = false
    open(api)
    fireEvent.click(await screen.findByRole('button', { name: 'Don’t see your app? Request it +' }))
    const list = await screen.findByRole('list', { name: 'Apps you can request' })
    expect(within(list).getByText('Hospitable')).toBeTruthy()
    expect(list.querySelector('.tile, img')).toBeNull()
    fireEvent.click(within(list).getByRole('button', { name: 'Request Hospitable' }))
    await within(list).findByText('Requested')
    expect(within(list).queryByRole('button', { name: 'Request Hospitable' })).toBeNull()
    expect(api.requested.has('hospitable')).toBe(true)
    // A name this server already offers (the mock offers Rippling) isn't on the list.
    expect(within(list).queryByText('Rippling')).toBeNull()

    fireEvent.input(screen.getByLabelText('App name'), { target: { value: 'harv' } })
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Apps you can request' })).queryByText('Hospitable')).toBeNull())
    expect(screen.getByText('Harvest')).toBeTruthy()
    fireEvent.input(screen.getByLabelText('App name'), { target: { value: 'zzzz' } })
    await screen.findByText('Not on the list.')
  })

  it('sits above the logo notice', async () => {
    const api = new MockApi()
    api.s.me.demo = false
    open(api)
    const line = await screen.findByRole('button', { name: 'Don’t see your app? Request it +' })
    const notice = screen.getByText(/Logos belong to their owners/)
    expect(line.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('isn’t offered in a demo or on a self-hosted server', async () => {
    const demo = new MockApi()
    demo.s.me.demo = true
    open(demo)
    await screen.findByText(/Logos belong to their owners/)
    expect(screen.queryByRole('button', { name: /Request it/ })).toBeNull()
  })

  it('isn’t offered self-hosted (a request would reach nobody)', async () => {
    const api = new MockApi({ selfHost: true } as never)
    api.s.me.demo = false
    ;(api.s.me as { selfHosted: boolean }).selfHosted = true
    open(api)
    await screen.findByText(/Logos belong to their owners/)
    expect(screen.queryByRole('button', { name: /Request it/ })).toBeNull()
  })
})
