// @vitest-environment happy-dom
// From 43's fresh-user run: one press on "Continue", a pasted "me@x.com.", and the note after deleting an account.
import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import { cleanEmail } from '../lib/email.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'

const start = (api: MockApi, hash: string) => {
  location.hash = hash
  return render(html`<${Root} api=${api} />`)
}

describe('Company name step', () => {
  it('a slow create is one press: the button says Setting up… and a second press does nothing', async () => {
    const api = new MockApi({ empty: true })
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const base = api.createWorkspace.bind(api)
    let calls = 0
    api.createWorkspace = async (...a: Parameters<MockApi['createWorkspace']>) => (calls++, await gate, base(...a))
    start(api, '#/welcome/1')
    fireEvent.input(await screen.findByLabelText('Company name'), { target: { value: 'Acme' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    const busy = await screen.findByRole('button', { name: 'Setting up…' })
    expect((busy as HTMLButtonElement).disabled).toBe(true)
    fireEvent.submit(busy.closest('form')!)
    release()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Setting up…' })).toBeNull())
    expect(calls).toBe(1)
  })
})

describe('Pasted email', () => {
  it('drops spaces and a sentence’s full stop', () => {
    expect(cleanEmail(' me+e2e1@gmail.com. ')).toBe('me+e2e1@gmail.com')
    expect(cleanEmail('me@x.com')).toBe('me@x.com')
  })

  it('sign-in sends the tidied address', async () => {
    const api = new MockApi({ signedIn: false })
    let sent: string | undefined
    const base = api.signIn.bind(api)
    api.signIn = async (m: string, e?: string) => ((sent = e), base(m, e))
    start(api, '#/signin')
    fireEvent.input(await screen.findByLabelText('Email'), { target: { value: 'me+e2e1@gmail.com. ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Email me a link' }))
    await waitFor(() => expect(sent).toBe('me+e2e1@gmail.com'))
    expect(screen.queryByText('That doesn’t look like an email address.')).toBeNull()
  })
})

describe('After deleting an account', () => {
  it('a refresh that started before the delete never brings back "You were signed out"', async () => {
    const api = new MockApi()
    ;(api.s.me as { demo: boolean }).demo = false
    start(api, '#/preferences')
    fireEvent.click(await screen.findByRole('button', { name: 'Delete my account' }))
    await screen.findByRole('heading', { name: 'Delete my account' })
    // A refresh starts while still signed in and answers after the account is gone (slow server).
    const old = (await api.me())
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const base = api.me.bind(api)
    api.me = async () => (await gate, old)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    fireEvent.input(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete my account' }).at(-1)!)
    await screen.findByText(/Your account and its data are deleted/)
    api.me = base
    release()
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy()
    expect(screen.getByText(/Your account and its data are deleted/)).toBeTruthy()
    expect(screen.queryByText(/You were signed out/)).toBeNull()
  })
})
