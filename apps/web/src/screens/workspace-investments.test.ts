// @vitest-environment happy-dom
// Money: a quiet "Investments $…" line under a company's cash when it holds investments (Yisrael, 11-01). Cash stays cash.
import { render, screen, within } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'

const usd = (dollars: number) => ({ minor: Math.round(dollars * 100), currency: 'USD' })
const moneyRow = async (name: string) => {
  const list = await screen.findByRole('list', { name: 'Companies' })
  return within(list).getByRole('button', { name: new RegExp(`^${name},`) })
}

describe('Investments under cash on the Workspace', () => {
  it('shows "Investments $8,725" under Personal’s cash, rounded like cash; cash itself unchanged', async () => {
    const api = new MockApi()
    const personal = api.s.entities.find((e) => e.kind === 'personal')!
    personal.investments = [usd(8_725.22)]
    location.hash = '#/'
    render(html`<${Root} api=${api} />`)
    const row = await moneyRow('Personal')
    expect(within(row).getByText('Investments $8,725')).toBeTruthy()
    expect(within(row).getByText('$18,904')).toBeTruthy()
    expect(row.getAttribute('aria-label')).toBe('Personal, only you see this, $18,904, Investments $8,725. Open details')
  })

  it('no line for a company without investments', async () => {
    location.hash = '#/'
    render(html`<${Root} api=${new MockApi()} />`)
    const row = await moneyRow('Acme')
    expect(within(row).queryByText(/Investments/)).toBeNull()
  })

  it('a company with investments gets the line too; several currencies stay apart', async () => {
    const api = new MockApi()
    api.s.entities.find((e) => e.name === 'Acme')!.investments = [usd(1_200), { minor: 50_000, currency: 'EUR' }]
    location.hash = '#/'
    render(html`<${Root} api=${api} />`)
    const row = await moneyRow('Acme')
    expect(within(row).getByText(/^Investments \$1,200 · €500$/)).toBeTruthy()
  })

  it('hidden Personal (someone else’s) shows "private" and no investments', async () => {
    const api = new MockApi()
    const personal = api.s.entities.find((e) => e.kind === 'personal')!
    Object.assign(personal, { hidden: true, cash: null, investments: [usd(8_725.22)] })
    location.hash = '#/'
    render(html`<${Root} api=${api} />`)
    const row = await moneyRow('Personal')
    expect(within(row).getByText('private')).toBeTruthy()
    expect(within(row).queryByText(/Investments/)).toBeNull()
  })
})
