// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'

const start = (api: MockApi, hash: string) => {
  location.hash = hash
  return render(html`<${Root} api=${api} />`)
}
const type = (el: HTMLElement, value: string) => fireEvent.input(el, { target: { value } })

describe('Equity', () => {
  it('company drawer shows the cap table summary and opens the full table', async () => {
    start(new MockApi(), '#/?d=company:e_acme')
    const sec = await screen.findByRole('region', { name: 'Equity' })
    expect(sec.textContent).toContain('10,000,000 shares, fully diluted')
    expect(within(sec).getByText('Dana Reyes')).toBeTruthy()
    expect(within(sec).getByText('2 SAFEs and notes')).toBeTruthy()
    fireEvent.click(within(sec).getByRole('button', { name: /Cap table/ }))
    await screen.findByRole('heading', { name: 'Cap table' })
    for (const name of ['Who owns what', 'SAFEs and notes', 'Option pool', 'Share classes', '409A']) expect(screen.getByRole('region', { name })).toBeTruthy()
    expect(screen.getByText(/409A \$0\.21/)).toBeTruthy()
    expect(screen.getByText('62%')).toBeTruthy()
    expect(location.hash).toBe('#/?d=company:e_acme/equity:e_acme')
  })

  it('record a SAFE, see it on the table, undo it', async () => {
    const api = new MockApi()
    start(api, '#/?d=company:e_acme/equity:e_acme/equity-add:e_acme')
    await screen.findByRole('heading', { name: 'Record something' })
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Say who this is for.')
    type(screen.getByLabelText('Investor'), 'Bay Capital')
    type(screen.getByLabelText('Amount'), '500,000')
    type(screen.getByLabelText('Valuation cap (optional)'), '12,000,000')
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    const toast = await screen.findByRole('status')
    expect(toast.textContent).toContain('Recorded a $500,000 SAFE from Bay Capital at a $12,000,000 cap.')
    await screen.findByRole('heading', { name: 'Cap table' })
    await screen.findByText('Bay Capital')
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(api.equityObjects.e_acme!.some((x) => x.o.type === 'STAKEHOLDER' && x.o.name === 'Bay Capital')).toBe(false))
  })

  it('options grant with vesting, and impossible requests are refused in plain words', async () => {
    const api = new MockApi()
    start(api, '#/?d=equity-add:e_acme')
    await screen.findByRole('heading', { name: 'Record something' })
    fireEvent.click(screen.getByRole('button', { name: 'Exercise' }))
    type(await screen.findByLabelText('Who'), 'Sam Lee')
    type(screen.getByLabelText('Shares'), '999,999')
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Sam Lee has 160,000 options left, not 999,999.')
  })

  it('records a warrant and shows it under Warrants', async () => {
    const api = new MockApi()
    start(api, '#/?d=company:e_acme/equity:e_acme/equity-add:e_acme')
    await screen.findByRole('heading', { name: 'Record something' })
    fireEvent.click(screen.getByRole('button', { name: 'Warrant' }))
    type(await screen.findByLabelText('Holder'), 'Harbor Bank')
    type(screen.getByLabelText('Shares'), '50,000')
    type(screen.getByLabelText('Exercise price'), '0.65')
    fireEvent.input(screen.getByLabelText('Expires (optional)'), { target: { value: '2033-01-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    expect((await screen.findByRole('status')).textContent).toContain('Issued a warrant to Harbor Bank for 50,000 Common shares at $0.65, expiring Jan 1, 2033.')
    const sec = await screen.findByRole('region', { name: 'Warrants' })
    expect(within(sec).getByText('Harbor Bank')).toBeTruthy()
    expect(sec.textContent).toContain('expires Jan 1, 2033')
  })

  it('Undo from the toast updates the open cap table; switching tabs starts the form over', async () => {
    const api = new MockApi()
    start(api, '#/?d=company:e_acme/equity:e_acme/equity-add:e_acme')
    await screen.findByRole('heading', { name: 'Record something' })
    fireEvent.click(screen.getByRole('button', { name: 'Warrant' }))
    type(await screen.findByLabelText('Holder'), 'Harbor Bank')
    fireEvent.click(screen.getByRole('button', { name: 'RSUs' }))
    expect((screen.getByLabelText('Who') as HTMLInputElement).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Warrant' }))
    type(screen.getByLabelText('Holder'), 'Harbor Bank')
    type(screen.getByLabelText('Shares'), '50,000')
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    await screen.findByRole('region', { name: 'Warrants' })
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Warrants' })).toBeNull())
  })

  it('grants RSUs, and won’t release them before they vest', async () => {
    const api = new MockApi()
    const first = start(api, '#/?d=equity-add:e_acme')
    await screen.findByRole('heading', { name: 'Record something' })
    fireEvent.click(screen.getByRole('button', { name: 'RSUs' }))
    type(await screen.findByLabelText('Who'), 'Rui Costa')
    type(screen.getByLabelText('RSUs'), '48,000')
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    expect((await screen.findByRole('status')).textContent).toContain('Granted 48,000 RSUs to Rui Costa.')
    first.unmount()
    start(api, '#/?d=equity-add:e_acme')
    await screen.findByRole('heading', { name: 'Record something' })
    fireEvent.click(screen.getByRole('button', { name: 'Exercise' }))
    fireEvent.click(await screen.findByRole('button', { name: 'RSUs (release)' }))
    type(screen.getByLabelText('Who'), 'Rui Costa')
    type(screen.getByLabelText('RSUs to release'), '1,000')
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/^Rui Costa has 0 vested RSUs to release on \d{4}-\d{2}-\d{2}, not 1,000\.$/)
  })

  it('models the next round in the browser: SAFEs convert at their caps', async () => {
    start(new MockApi(), '#/?d=equity-round:e_acme')
    await screen.findByRole('heading', { name: 'Model the next round' })
    const conv = await screen.findByRole('region', { name: 'SAFEs and notes convert' })
    expect(within(conv).getByText('Kite Ventures')).toBeTruthy()
    expect(conv.textContent).toMatch(/\(cap\)/)
    const after = screen.getByRole('region', { name: 'After the round' })
    expect(within(after).getByText('New investors')).toBeTruthy()
    type(screen.getByLabelText('Pre-money valuation'), 'abc')
    expect((await screen.findByRole('alert')).textContent).toBe('Enter a valuation and an amount.')
  })

  it('exit waterfall: preferred takes its preference at a low price and converts at a high one', async () => {
    start(new MockApi(), '#/?d=equity-exit:e_acme')
    await screen.findByRole('heading', { name: 'What if we sell?' })
    await screen.findByRole('region', { name: 'Preferred' })
    const pref = () => screen.getByRole('region', { name: 'Preferred' })
    expect(pref().textContent).toContain('converts to common') // $25M: 23% of common-equivalent beats a $1.5M preference
    type(screen.getByLabelText('Sale price'), '2,000,000')
    await waitFor(() => expect(pref().textContent).toContain('preference $1,500,060')) // 2,300,000 × $0.6522
  })

  it('imports a Carta CSV into a company with no cap table', async () => {
    const api = new MockApi()
    start(api, '#/?d=equity:e_nex')
    await screen.findByText(/has no cap table yet/)
    const input = screen.getByLabelText('Choose a cap table file') as HTMLInputElement
    const file = new File(['Stakeholder,Security Type,Shares,Issue Date\nAda,Common,1000000,2025-01-01\n'], 'carta.csv', { type: 'text/csv' })
    fireEvent.change(input, { target: { files: [file] } })
    expect((await screen.findByRole('status')).textContent).toMatch(/^Imported 3 items/)
    await screen.findByText('1,000,000 shares fully diluted')
    // One Undo takes the whole import back.
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await screen.findByText(/has no cap table yet/)
  })
})
