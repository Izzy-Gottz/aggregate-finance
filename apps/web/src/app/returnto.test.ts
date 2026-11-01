// @vitest-environment happy-dom
// Connect round trips (OAuth, Plaid OAuth banks) come back to the page they started on, so setup isn't skipped.
import { render, screen } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { HttpApi } from '../api/http.ts'
import { MockApi } from '../api/mock.ts'
import { plaidReturnHash, savePending, takePending } from '../lib/plaid.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'
import { Root } from './app.ts'
import { parseHash, returnPath } from './router.ts'

describe('returnTo', () => {
  it('is the page without drawers or params', () => {
    expect(returnPath(parseHash('#/welcome/2?d=connect:stripe'))).toBe('/welcome/2')
    expect(returnPath(parseHash('#/preferences?d=invite'))).toBe('/preferences')
    expect(returnPath(parseHash('#/?d=connect'))).toBe('/')
  })

  it('is sent with the connect start, except for the overview', async () => {
    const bodies: unknown[] = []
    const f = (async (_u: string, init: RequestInit) => (bodies.push(JSON.parse(String(init.body))), new Response(JSON.stringify({ kind: 'oauth', url: 'x', state: 's' })))) as unknown as typeof fetch
    const api = new HttpApi({ fetch: f })
    await api.startConnect('stripe', null, '/welcome/2')
    await api.startConnect('stripe', null, '/')
    expect(bodies).toEqual([{ entityId: null, returnTo: '/welcome/2' }, { entityId: null }])
  })

  it('a Plaid OAuth bank returns to the step it was connected from', () => {
    savePending({ connectorKey: 'plaid', linkToken: 't', state: 's', returnTo: '/welcome/2' })
    expect(plaidReturnHash()).toBe('/#/welcome/2?d=plaid-return')
    takePending()
    savePending({ connectorKey: 'plaid', linkToken: 't', state: 's', returnTo: 'https://evil.example/' })
    expect(plaidReturnHash()).toBe('/#/?d=plaid-return')
    takePending()
    expect(plaidReturnHash()).toBe('/#/?d=plaid-return')
  })

  it('back from OAuth on an onboarding step: stays on the step, the new connection listed', async () => {
    const api = new MockApi()
    location.hash = '#/welcome/2?d=connection:c_chase'
    render(html`<${Root} api=${api} />`)
    expect(await screen.findByRole('heading', { name: 'Connect your money' })).toBeTruthy()
    expect(location.hash.startsWith('#/welcome/2')).toBe(true)
    expect(screen.getByRole('list', { name: 'Connected' })).toBeTruthy()
  })

  it('a cancelled OAuth on an onboarding step reopens that connector there with a calm line', async () => {
    location.hash = '#/welcome/2?connect_error=access_denied&connector=stripe'
    render(html`<${Root} api=${new MockApi()} />`)
    expect(await screen.findByText('Nothing was connected. You can try again anytime.')).toBeTruthy()
    expect(location.hash.startsWith('#/welcome/2')).toBe(true)
    expect(screen.getByRole('heading', { name: 'Connect your money' })).toBeTruthy()
  })
})
