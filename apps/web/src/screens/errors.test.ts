// @vitest-environment happy-dom
// What a new person sees when something fails: offline says so with Try again, a failed approval isn't "Done",
// every file that didn't upload is named, and a page that can't load says why instead of loading forever.
import { fireEvent, render, screen, within } from '@testing-library/preact'
import { afterEach, describe, expect, it } from 'vitest'
import { HttpError, OFFLINE } from '../api/http.ts'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'

const start = (api: MockApi, hash: string) => {
  location.hash = hash
  return render(html`<${Root} api=${api} />`)
}
const offline = () => Promise.reject(new HttpError(0, OFFLINE, 'offline'))

describe('error states', () => {
  afterEach(() => document.body.replaceChildren())

  it('a drawer that can’t reach the server says so, and Try again loads it', async () => {
    const api = new MockApi()
    const real = api.connection.bind(api)
    let fail = true
    api.connection = (id: string) => (fail ? offline() : real(id))
    start(api, '#/?d=connection:c_chase')
    // A failed load swaps in its own drawer, so look the dialog up again each time.
    await screen.findByRole('heading', { name: 'Can’t reach Aggregate' })
    expect(screen.getByRole('dialog').textContent).not.toMatch(/gone/)
    fail = false
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Try again' }))
    await screen.findByText(/Can’t move money/)
  })

  it('consent: offline isn’t “expired”, and a failed Allow isn’t “Done”', async () => {
    const api = new MockApi()
    const info = api.consentInfo.bind(api)
    api.consentInfo = () => offline()
    start(api, '#/connect-ai/consent?client_id=claude&scope=read&exp=1&sig=abc')
    await screen.findByRole('heading', { name: 'Can’t reach Aggregate' })
    api.consentInfo = info
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    const allow = await screen.findByRole('button', { name: 'Allow' })
    api.consent = () => Promise.reject(new HttpError(500, 'Something went wrong. Nothing was changed.'))
    fireEvent.click(allow)
    await screen.findByRole('heading', { name: 'That didn’t work' })
    expect(screen.queryByRole('heading', { name: 'Done' })).toBeNull()
  })

  it('upload names every file that didn’t make it, with the server’s 8 MB limit', async () => {
    start(new MockApi(), '#/?d=add:upload')
    const d = await screen.findByRole('dialog')
    const input = within(d).getByLabelText('Choose files to upload') as HTMLInputElement
    const big = new File(['x'], 'year.pdf')
    Object.defineProperty(big, 'size', { value: 9 * 1024 * 1024 })
    fireEvent.change(input, { target: { files: [new File(['x'], 'run.exe'), big, new File(['x'], 'bank.qbo')] } })
    const alert = await within(d).findByRole('alert')
    expect(alert.textContent).toMatch(/run.exe isn’t a file Aggregate takes/)
    expect(alert.textContent).toMatch(/year.pdf is too large \(8 MB max\)/)
    expect(alert.textContent).not.toMatch(/bank.qbo/)
  })

  it('Review that can’t load says why and offers Try again, instead of loading forever', async () => {
    const api = new MockApi()
    const real = api.review.bind(api)
    api.review = () => offline()
    start(api, '#/review')
    expect((await screen.findByRole('alert')).textContent).toMatch(/Can’t reach Aggregate/)
    api.review = real
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByText(/question|Nothing waiting/)
  })
})
