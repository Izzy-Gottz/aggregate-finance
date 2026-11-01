// @vitest-environment happy-dom
// The Stripe App's install button links to #/?d=connect:stripe: that must survive sign-in and first-run setup.
import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it } from 'vitest'
import { HttpApi } from '../api/http.ts'
import { MockApi } from '../api/mock.ts'
import { connectIntent, keepIntent, peekIntent, signInCallback, takeIntent } from '../lib/deeplink.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'
import { Root } from './app.ts'

const start = (api: MockApi, hash: string) => {
  location.hash = hash
  return render(html`<${Root} api=${api} />`)
}

beforeEach(() => void takeIntent())

describe('connect links', () => {
  it('only connect:<known connector>, never any other route', () => {
    expect(connectIntent('#/?d=connect:stripe')).toBe('stripe')
    expect(connectIntent('#/welcome/2?d=connect:xero')).toBe('xero')
    for (const k of ['coinbase', 'expensify', 'gumroad', 'polar']) expect(connectIntent(`#/?d=connect:${k}`)).toBe(k)
    for (const h of ['#/?d=connect:evil', '#/?d=connect', '#/?d=connect:stripe/connect:xero', '#/?d=delete-me', '#/preferences?d=invite', '#/?d=add:cash'])
      expect(connectIntent(h)).toBeNull()
  })

  it('the sign-in link carries a kept connector, and nothing else', async () => {
    expect(signInCallback()).toBe('/#/')
    keepIntent('stripe')
    expect(signInCallback()).toBe('/#/?d=connect:stripe')
    const bodies: Array<Record<string, unknown>> = []
    const f = (async (_u: string, init: RequestInit) => (bodies.push(JSON.parse(String(init.body))), new Response(JSON.stringify({ status: true })))) as unknown as typeof fetch
    await new HttpApi({ fetch: f }).signIn('email', 'a@example.com')
    expect(bodies[0]).toMatchObject({ callbackURL: '/#/?d=connect:stripe' })
  })

  it('signed out → sign in → first-run setup → the Stripe drawer opens on "Connect your money"', async () => {
    const api = new MockApi({ signedIn: false, empty: true })
    const first = start(api, '#/?d=connect:stripe')
    await waitFor(() => expect(location.hash).toMatch(/^#\/signin/))
    expect(peekIntent()).toBe('stripe')
    // The emailed link comes back to the connector (as Better Auth's callbackURL does), signed in now.
    await api.signIn('email', 'new@example.com')
    first.unmount()
    // Opened on another device: nothing kept there, the link alone carries it.
    const link = signInCallback().slice(1)
    takeIntent()
    start(api, link)
    const name = await screen.findByLabelText('Company name')
    fireEvent.input(name, { target: { value: 'Acme' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Connect your money' })
    expect(await screen.findByRole('dialog', { name: /Stripe/ })).toBeTruthy()
    expect(peekIntent()).toBeNull()
  })

  it('already signed in: the link opens the drawer straight away', async () => {
    start(new MockApi(), '#/?d=connect:stripe')
    expect(await screen.findByRole('dialog', { name: /Stripe/ })).toBeTruthy()
  })
})
