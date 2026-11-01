// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact'
import { describe, expect, it, vi } from 'vitest'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'
import { score } from './palette.ts'

const start = (api: MockApi, hash = '#/') => {
  location.hash = hash
  return render(html`<${Root} api=${api} />`)
}

describe('score', () => {
  it('prefers prefixes, then substrings, then subsequences', () => {
    expect(score('acm', 'Acme')).toBeGreaterThan(score('acm', 'Upload Acme file'))
    expect(score('upf', 'Upload a file')).toBeGreaterThan(0)
    expect(score('zzz', 'Acme')).toBe(0)
    expect(score('', 'anything')).toBe(1)
  })
})

describe('⌘K', () => {
  it('opens with ⌘K, finds a company, Enter opens its drawer', async () => {
    start(new MockApi())
    await screen.findByRole('region', { name: 'Money' })
    fireEvent.keyDown(document, { key: 'k', metaKey: true })
    const box = await screen.findByRole('combobox')
    fireEvent.input(box, { target: { value: 'bluebi' } })
    const first = (await screen.findAllByRole('option'))[0]!
    expect(first.textContent).toContain('Bluebird Studio')
    fireEvent.keyDown(box, { key: 'Enter' })
    await screen.findByRole('heading', { name: 'Bluebird Studio' })
    expect(screen.queryByRole('combobox')).toBeNull()
  })
  it('typing an amount offers to add it, prefilled', async () => {
    start(new MockApi())
    fireEvent.click(await screen.findByRole('button', { name: /Search/ }))
    fireEvent.input(await screen.findByRole('combobox'), { target: { value: 'paid designer $500' } })
    const opt = (await screen.findAllByRole('option'))[0]!
    expect(opt.textContent).toBe('Add $500 cash out')
    fireEvent.click(opt)
    const d = await screen.findByRole('dialog', { name: 'Add cash or a receipt' })
    expect((within(d).getByLabelText('Amount') as HTMLInputElement).value).toBe('500')
    expect(within(d).getByRole('button', { name: 'Money out' }).getAttribute('aria-pressed')).toBe('true')
  })
  it('Escape closes; "A" opens Add cash when not typing', async () => {
    start(new MockApi())
    await screen.findByRole('region', { name: 'Money' })
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    fireEvent.keyDown(await screen.findByRole('combobox'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull())
    fireEvent.keyDown(document.body, { key: 'a' })
    await screen.findByRole('dialog', { name: 'Add cash or a receipt' })
  })
})

describe('help', () => {
  it('Help in the menu: the setup guide and email support', async () => {
    const opened: unknown[] = []
    const realOpen = window.open
    window.open = ((...a: unknown[]) => (opened.push(a), null)) as typeof window.open
    start(new MockApi(), '#/')
    fireEvent.click(await screen.findByRole('button', { name: 'Help' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Setup guide/ }))
    expect(opened[0]).toEqual(['/docs/connect-your-ai', '_blank', 'noopener'])
    fireEvent.click(screen.getByRole('button', { name: 'Help' }))
    expect(screen.getByRole('menuitem', { name: 'Email support' })).toBeTruthy()
    window.open = realOpen
  })
  it('the palette has both, and a failed connect says where to get help', async () => {
    const v = start(new MockApi(), '#/')
    await screen.findByRole('region', { name: 'Money' })
    fireEvent.keyDown(document, { key: 'k', metaKey: true })
    const box = await screen.findByRole('combobox')
    fireEvent.input(box, { target: { value: 'support' } })
    expect(await screen.findByText('Contact support')).toBeTruthy()
    fireEvent.input(box, { target: { value: 'help' } })
    expect(await screen.findByText('Help: setup guide')).toBeTruthy()
    v.unmount()
    const api = new MockApi()
    api.startConnect = async () => { throw new Error('Stripe didn’t answer.') }
    localStorage.setItem('agfn.scope', 'e_acme')
    start(api, '#/?d=connect:stripe')
    fireEvent.click(await screen.findByRole('button', { name: 'Continue to Stripe' }))
    expect(await screen.findByText('Stripe didn’t answer.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'support@aggregate.finance' }).getAttribute('href')).toBe('mailto:support@aggregate.finance')
    localStorage.removeItem('agfn.scope')
  })
})

describe('connect forms', () => {
  it('renders one input per field and finishes with state + values', async () => {
    const api = new MockApi()
    const startSpy = vi.spyOn(api, 'startConnect')
    start(api, '#/?d=connect:ramp')
    // From "All companies" with several companies: ask which one, never guess.
    fireEvent.click(await screen.findByRole('button', { name: 'Continue to Ramp' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Choose which company this is for.')
    expect(startSpy).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('For which company?'), { target: { value: 'e_nex' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue to Ramp' }))
    await waitFor(() => expect(startSpy).toHaveBeenCalledWith('ramp', 'e_nex', '/'))
    const secret = (await screen.findByLabelText('Client secret')) as HTMLInputElement
    expect(secret.type).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Client ID is needed.')
    fireEvent.input(screen.getByLabelText('Client ID'), { target: { value: 'cid' } })
    fireEvent.input(secret, { target: { value: 'shh' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await screen.findByRole('heading', { name: 'Which company is each account?' })
    expect(api.lastFinish).toMatchObject({ clientId: 'cid', clientSecret: 'shh', env: 'live' })
    expect(typeof api.lastFinish?.state).toBe('string')
  })
  it('with a company in scope, or only one company, it doesn\'t ask', async () => {
    const api = new MockApi()
    localStorage.setItem('agfn.scope', 'e_cla')
    start(api, '#/?d=connect:mercury')
    await screen.findByRole('button', { name: 'Continue to Mercury' })
    expect(screen.queryByLabelText('For which company?')).toBeNull()
    expect(screen.getByText('For Harbor Coffee')).toBeTruthy()
    localStorage.removeItem('agfn.scope')
  })
  it('a single token finishes with apiKey', async () => {
    const api = new MockApi()
    start(api, '#/?d=connect:mercury')
    fireEvent.change(await screen.findByLabelText('For which company?'), { target: { value: 'e_acme' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue to Mercury' }))
    fireEvent.input(await screen.findByLabelText('Mercury read-only token'), { target: { value: 'tok' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await screen.findByRole('heading', { name: 'Which company is each account?' })
    expect(api.lastFinish).toMatchObject({ apiKey: 'tok' })
  })
})

describe('passkeys', () => {
  it('add and remove from Preferences', async () => {
    const api = new MockApi()
    start(api, '#/preferences')
    fireEvent.click(await screen.findByRole('button', { name: /Add a passkey/ }))
    await screen.findByText(/Passkey added/)
    expect(api.s.prefs.signIn.passkeys).toHaveLength(2)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Remove' }))[0]!)
    await waitFor(() => expect(api.s.prefs.signIn.passkeys).toHaveLength(1))
  })
})

describe('connect_error', () => {
  it('shows the server’s plain message and clears it from the URL', async () => {
    start(new MockApi(), '#/?connect_error=Stripe%20sign-in%20was%20cancelled.')
    expect((await screen.findByRole('status')).textContent).toContain('Stripe sign-in was cancelled.')
    await waitFor(() => expect(location.hash).toBe('#/'))
  })
})
