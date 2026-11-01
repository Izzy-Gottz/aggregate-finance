// @vitest-environment happy-dom
// Intuit's 10-27 guidance: say plainly that the customer's chosen AI gets their data, on consent, keys and connects.
import { AI_DISCLOSURE, aiDisclosure } from '@agfn/contracts'
import { fireEvent, render, screen } from '@testing-library/preact'
import { describe, expect, it, vi } from 'vitest'
import { HttpApi, HttpError } from '../api/http.ts'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'

const start = (api: MockApi, hash: string) => {
  location.hash = hash
  return render(html`<${Root} api=${api} />`)
}

describe('AI provider disclosure', () => {
  it('the consent page says, near the title, that the data goes to that AI under its terms', async () => {
    start(new MockApi(), '#/connect-ai/consent?client_id=claude&client_name=Claude&scope=finance%3Aread&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&consent_code=x')
    await screen.findByRole('heading', { level: 1 })
    const line = screen.getByText('Your financial data will be sent to Claude and handled under that provider’s terms. Aggregate never trains on it.')
    expect(line.textContent).toBe(aiDisclosure('Claude'))
    // Prominent: body text, not the grey sub.
    expect(line.className).toBe('lead')
  })

  it('every connect drawer (QuickBooks too) and the bot-key form carry the short line', async () => {
    const v = start(new MockApi(), '#/?d=connect:quickbooks')
    expect(await screen.findByText(AI_DISCLOSURE.connectText)).toBeTruthy()
    v.unmount()
    start(new MockApi(), '#/?d=connect-ai')
    expect(await screen.findByText(AI_DISCLOSURE.keyText)).toBeTruthy()
  })

  it('consent and key creation send the disclosure version, so the server can refuse a stale page', async () => {
    const bodies: unknown[] = []
    const f = vi.fn(async (_url: string, init: RequestInit) => (bodies.push(JSON.parse(String(init.body))), new Response(JSON.stringify({ grantId: 'g', key: 'k', next: '/' }), { status: 200 })))
    const api = new HttpApi({ fetch: f as unknown as typeof fetch })
    await api.createKey('Bot', { entityIds: 'all', dataTypes: ['balances'], write: false, reviewMode: 'instant', expiresAt: null })
    expect(bodies[0]).toMatchObject({ disclosureVersion: AI_DISCLOSURE.version })
    await api.consent({ clientId: 'c1', clientName: 'Claude', shape: { entityIds: 'all', dataTypes: ['balances'], write: false, reviewMode: 'instant', expiresAt: null }, oauthQuery: '' }).catch(() => undefined)
    expect(bodies[1]).toMatchObject({ clientId: 'c1', disclosureVersion: AI_DISCLOSURE.version })
  })

  it('a stale page (409 consent_outdated) says only to reload, with a Reload button', async () => {
    const api = new MockApi()
    api.consent = () => Promise.reject(new HttpError(409, 'This page is out of date. Reload this page and try again.', 'consent_outdated'))
    start(api, '#/connect-ai/consent?client_id=claude&client_name=Claude&scope=finance%3Aread&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&consent_code=x')
    fireEvent.click(await screen.findByRole('button', { name: 'Allow' }))
    expect((await screen.findByRole('alert')).textContent).toBe('This page is out of date. Reload this page and try again.')
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
  })
})
