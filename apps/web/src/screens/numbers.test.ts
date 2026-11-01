// @vitest-environment happy-dom
// The company drawer says what the server says (docs/qa/web-number-sources.md): runway in the AI tools' states, and
// SAFEs in more than one currency never added together.
import { render, screen } from '@testing-library/preact'
import { afterEach, describe, expect, it } from 'vitest'
import { MockApi } from '../api/mock.ts'
import type { CompanyDetail } from '../api/types.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'

function open(change: (c: CompanyDetail) => CompanyDetail) {
  const api = new MockApi()
  const real = api.company.bind(api)
  api.company = async (id: string) => change(await real(id))
  location.hash = '#/?d=company:e_acme'
  render(html`<${Root} api=${api} />`)
}

describe('company drawer numbers', () => {
  afterEach(() => document.body.replaceChildren())

  it('runway: “not burning” and “not enough history yet”, as the AI tools say it', async () => {
    open((c) => ({ ...c, runway: c.runway && { ...c.runway, months: null, state: 'not_burning' } }))
    await screen.findByRole('button', { name: 'not burning' })
    document.body.replaceChildren()
    open((c) => ({ ...c, runway: c.runway && { ...c.runway, months: null, state: 'not_enough_history' } }))
    await screen.findByRole('button', { name: 'runway: not enough history yet' })
  })

  it('SAFEs in two currencies: one amount per currency, never summed across them', async () => {
    open((c) => ({
      ...c,
      equity: c.equity && {
        ...c.equity,
        convertibles: [
          { ...c.equity.convertibles[0]!, amount: { minor: 50_000_000, currency: 'USD' } },
          { ...c.equity.convertibles[0]!, id: 'eur', amount: { minor: 20_000_000, currency: 'EUR' } },
        ],
      },
    }))
    const line = await screen.findByText(/not yet converted/)
    expect(line.textContent).toBe('$500,000 + €200,000 not yet converted')
  })
})
