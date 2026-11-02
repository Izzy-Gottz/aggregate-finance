// @vitest-environment happy-dom
import { render, screen } from '@testing-library/preact'
import { afterEach, describe, expect, it } from 'vitest'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'

const start = (api: MockApi, search: string, hash: string) => {
  history.replaceState(null, '', `/${search}${hash}`)
  return render(html`<${Root} api=${api} />`)
}

afterEach(() => history.replaceState(null, '', '/'))

describe('Creator perk', () => {
  it('sign-in says "Free during beta, then 3 months free" after a creator link', async () => {
    start(new MockApi({ signedIn: false }), '?ref=1', '')
    await screen.findByRole('heading', { name: 'Sign in' })
    expect(screen.getByText('Free during beta, then 3 months free')).toBeTruthy()
  })

  it('sign-in says only "Free during beta" without one', async () => {
    start(new MockApi({ signedIn: false }), '', '')
    await screen.findByRole('heading', { name: 'Sign in' })
    expect(screen.getByText('Free during beta')).toBeTruthy()
    expect(screen.queryByText(/3 months free/)).toBeNull()
  })

  it('from Get started the page says so, and doesn’t assume an account', async () => {
    start(new MockApi({ signedIn: false }), '?start=1', '')
    await screen.findByRole('heading', { name: 'Get started' })
    expect(screen.getByText('New or returning, continue with your passkey or email.')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull()
  })

  it('Preferences has a Plan section: free during beta, with notice before paid plans, never "free forever"', async () => {
    start(new MockApi(), '', '#/preferences')
    await screen.findByRole('heading', { name: 'Plan' })
    expect(screen.getByText('Free during beta')).toBeTruthy()
    expect(screen.getByText(/We may introduce paid plans later, and we’ll let you know before anything changes\./)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/free forever/i)
  })

  it('Preferences shows the perk when the account has one', async () => {
    const api = new MockApi()
    api.s.me = { ...api.s.me, perk: { label: '3 months free' } }
    start(api, '', '#/preferences')
    await screen.findByRole('heading', { name: 'Sign-in' })
    expect(screen.getByText('3 months free')).toBeTruthy()
  })

  it('Preferences shows the free-grant line instead of the perk, never both', async () => {
    const api = new MockApi()
    api.s.me = { ...api.s.me, perk: { label: '3 months free' }, freeGrant: { label: '12 months free (YC Deal)' } }
    start(api, '', '#/preferences')
    await screen.findByText('12 months free (YC Deal)')
    expect(screen.queryByText('3 months free')).toBeNull()
  })

  it('Preferences shows nothing without a perk', async () => {
    start(new MockApi(), '', '#/preferences')
    await screen.findByRole('heading', { name: 'Sign-in' })
    expect(screen.queryByText('3 months free')).toBeNull()
  })
})
