// @vitest-environment happy-dom
// Investments: the arithmetic (cost, marks, write-offs, exits, the multiple), then the page on the demo's angel
// portfolio in Personal: totals, a position opened, add / mark / exit / write off, and the page only where it's served.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import { moicText, positionsFrom } from '../lib/investments.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'

const usd = (d: number) => ({ minor: d * 100, currency: 'USD' })

describe('the arithmetic', () => {
  const ev = (positionId: string, kind: 'invest' | 'mark' | 'distribution' | 'write_off' | 'exit' | 'convert', date: string, amount?: number, extra = {}) => ({ positionId, recordId: `${positionId}-${date}-${kind}`, kind, issuer: positionId, securityType: 'safe' as const, date, ...(amount !== undefined ? { amount: usd(amount) } : {}), ...extra })
  const events = [
    ev('a', 'invest', '2024-01-01', 100, { valuationCap: usd(8_000_000), discountPct: 20 }),
    ev('a', 'invest', '2025-01-01', 50),
    ev('a', 'mark', '2026-01-01', 450),
    ev('a', 'distribution', '2026-02-01', 30),
    ev('b', 'invest', '2023-01-01', 200),
    ev('b', 'mark', '2024-01-01', 400),
    ev('b', 'write_off', '2025-06-01'),
    ev('c', 'invest', '2022-01-01', 100),
    ev('c', 'exit', '2026-03-01', 0),
    ev('d', 'invest', '2027-01-01', 999),
  ]
  const v = positionsFrom('e', events, '2026-10-12')

  it('cost is every invest; value is the latest mark, else cost; 0 once written off or exited; the future isn’t counted', () => {
    expect(v.map((p) => p.positionId)).toEqual(['c', 'b', 'a'])
    const a = v.find((p) => p.positionId === 'a')!
    expect(a).toMatchObject({ invested: usd(150), value: usd(450), valueSource: 'mark', markedAt: '2026-01-01', distributed: usd(30), status: 'active', valuationCap: usd(8_000_000), discountPct: 20 })
    expect(a.moic).toBeCloseTo(3.2)
    expect(v.find((p) => p.positionId === 'b')).toMatchObject({ value: usd(0), valueSource: 'written_off', status: 'written_off', moic: 0 })
    expect(v.find((p) => p.positionId === 'c')).toMatchObject({ value: usd(0), distributed: usd(0), status: 'exited', moic: 0 })
  })

  it('a SAFE converting into a priced round takes the new terms; the cost and any mark carry over', () => {
    const [p] = positionsFrom('e', [
      ev('s', 'invest', '2024-01-01', 100, { valuationCap: usd(8_000_000), discountPct: 20 }),
      ev('s', 'mark', '2025-06-01', 250),
      { ...ev('s', 'convert', '2025-07-01', undefined, { series: 'Series A', shares: 31_250 }), securityType: 'preferred_stock' as const },
    ], '2026-10-12')
    expect(p).toMatchObject({ securityType: 'preferred_stock', series: 'Series A', shares: 31_250, invested: usd(100), value: usd(250), status: 'active' })
    expect(p!.valuationCap).toBeUndefined()
    expect(p!.discountPct).toBeUndefined()
  })

  it('the multiple is the server’s 2-place figure, shown to 2 places', () => {
    expect(moicText(1.07)).toBe('1.07×')
    expect(moicText(3.2)).toBe('3.20×')
    expect(moicText(null)).toBe('—')
  })

  it('totals come from the server (the demo’s stand-in): per currency, never summed across them', async () => {
    const api = new MockApi()
    await api.recordInvestment('e_personal', { kind: 'invest', issuer: 'Fjord AS', securityType: 'common_stock', date: '2025-05-01', amount: { minor: 5_000_000, currency: 'EUR' } })
    const { totals } = await api.investments('e_personal')
    expect(totals.map((t) => t.currency)).toEqual(['USD', 'EUR'])
    expect(totals[1]).toMatchObject({ invested: { minor: 5_000_000, currency: 'EUR' }, positions: 1 })
  })
})

const start = (api: MockApi, hash: string) => {
  location.hash = hash
  return render(html`<${Root} api=${api} />`)
}

describe('the Investments page', () => {
  it('Personal’s portfolio: totals, then each position with its multiple, active first (largest value first)', async () => {
    start(new MockApi(), '#/?d=company:e_personal')
    fireEvent.click(await screen.findByRole('button', { name: /Portfolio/ }))
    await screen.findByRole('heading', { name: 'Investments' })
    const totalsList = screen.getByRole('list', { name: 'Totals' })
    for (const [name, value] of [['Invested', '$190,000'], ['Value', '$160,000'], ['Distributed', '$140,000'], ['Written off', '$15,000'], ['Multiple', '1.58×']] as const) expect(within(totalsList).getByText(name).closest('li')!.textContent).toContain(value)
    const rows = [...document.querySelectorAll('.positions > li > button')].map((b) => b.textContent ?? '')
    expect(rows).toEqual([expect.stringMatching(/^Northbeam.*Priced · Series A.*1\.00×/), expect.stringMatching(/^Lumen Health.*SAFE.*2\.40×/), expect.stringMatching(/^Fieldwork.*Exited.*2\.80×/), expect.stringMatching(/^Tidepool.*Written off.*0\.00×/)])
  })

  it('open a position: its figures, then mark it, record an exit or write it off', async () => {
    const api = new MockApi()
    start(api, '#/?d=company:e_personal/investments:e_personal')
    fireEvent.click(await screen.findByRole('button', { name: /^Northbeam/ }))
    expect(screen.getByText('At cost (no mark yet)')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Mark' }))
    fireEvent.input(screen.getByLabelText('Worth now'), { target: { value: '$250,000' } })
    fireEvent.input(screen.getByLabelText('Based on (optional)'), { target: { value: 'Series B price' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save mark' }))
    await screen.findByText('Northbeam: Marked.')
    await waitFor(() => expect(screen.getByRole('button', { name: /^Northbeam/ }).textContent).toMatch(/2\.50×/))
    expect(api.investmentEvents.e_personal!.at(-1)).toMatchObject({ kind: 'mark', positionId: 'pos_north', amount: usd(250_000), markSource: 'Series B price' })

    fireEvent.click(screen.getByRole('button', { name: /^Lumen Health/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Write off' }))
    expect(screen.getByText(/The \$25,000 cost counts as lost/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Write it off' }))
    await screen.findByText('Lumen Health: Written off.')
    await waitFor(() => expect(screen.getByRole('button', { name: /^Lumen Health/ }).textContent).toMatch(/Written off/))
  })

  it('a position a connection brought in links to its source; hand-added ones don’t', async () => {
    const api = new MockApi()
    const base = api.investments.bind(api)
    api.investments = async (id: string) => {
      const r = await base(id)
      return { ...r, positions: r.positions.map((x) => (x.issuer === 'Northbeam' ? { ...x, source: { name: 'Wefunder', url: 'https://wefunder.com/portfolio' } } : x)) }
    }
    start(api, '#/?d=company:e_personal/investments:e_personal')
    fireEvent.click(await screen.findByRole('button', { name: /^Northbeam/ }))
    const link = screen.getByRole('link', { name: 'Via Wefunder ↗' })
    expect(link.getAttribute('href')).toBe('https://wefunder.com/portfolio')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    fireEvent.click(screen.getByRole('button', { name: /^Lumen Health/ }))
    expect(screen.queryByRole('link', { name: /^Via / })).toBeNull()
  })

  it('convert a SAFE: round and shares received; it then reads as priced, and only SAFEs and notes offer it', async () => {
    const api = new MockApi()
    start(api, '#/?d=company:e_personal/investments:e_personal')
    fireEvent.click(await screen.findByRole('button', { name: /^Northbeam/ }))
    expect(screen.queryByRole('button', { name: 'Convert' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Lumen Health/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Convert' }))
    expect(screen.getByText(/The \$25,000 SAFE becomes shares/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Convert' }))
    expect(screen.getByRole('alert').textContent).toBe('Which round, e.g. Series A?')
    fireEvent.input(screen.getByLabelText('Round'), { target: { value: 'Series A' } })
    fireEvent.input(screen.getByLabelText('Shares received'), { target: { value: '31,250' } })
    fireEvent.click(screen.getByRole('button', { name: 'Convert' }))
    await screen.findByText('Lumen Health: Converted.')
    expect(api.investmentEvents.e_personal!.at(-1)).toMatchObject({ kind: 'convert', positionId: 'pos_lumen', securityType: 'preferred_stock', series: 'Series A', shares: 31_250 })
    await waitFor(() => expect(screen.getByRole('button', { name: /^Lumen Health/ }).textContent).toMatch(/Priced · Series A.*2\.40×/))
  })

  it('add an investment: a SAFE with its cap and discount; the form says what’s missing', async () => {
    const api = new MockApi()
    start(api, '#/?d=company:e_personal/investments:e_personal')
    fireEvent.click(await screen.findByRole('button', { name: 'Add an investment' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.getByRole('alert').textContent).toBe('Which company?')
    fireEvent.input(screen.getByLabelText('Company'), { target: { value: 'Kestrel' } })
    fireEvent.input(screen.getByLabelText('Amount'), { target: { value: '$20,000' } })
    fireEvent.input(screen.getByLabelText('Valuation cap (optional)'), { target: { value: '$10,000,000' } })
    fireEvent.input(screen.getByLabelText('Discount % (optional)'), { target: { value: '15' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await screen.findByText('Kestrel added.')
    expect(api.investmentEvents.e_personal!.at(-1)).toMatchObject({ kind: 'invest', issuer: 'Kestrel', securityType: 'safe', amount: usd(20_000), valuationCap: usd(10_000_000), discountPct: 15 })
    await screen.findByRole('button', { name: /^Kestrel.*1\.00×/ })
  })

  it('only where the server serves investments', async () => {
    const api = new MockApi()
    api.s.me = { ...api.s.me, investments: false }
    start(api, '#/?d=company:e_personal')
    await screen.findByRole('heading', { name: 'Personal' })
    expect(screen.queryByRole('button', { name: /Portfolio/ })).toBeNull()
  })
})

describe('43’s staging findings', () => {
  const toPortfolio = async () => {
    location.hash = '#/?d=investments:e_personal'
    const api = new MockApi()
    render(html`<${Root} api=${api} />`)
    await screen.findByRole('button', { name: /^Lumen Health/ })
    return api
  }

  it('€450,000 on a USD position is refused, never saved as $450,000', async () => {
    const api = await toPortfolio()
    fireEvent.click(screen.getByRole('button', { name: /^Lumen Health/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Mark' }))
    fireEvent.input(screen.getByLabelText('Worth now'), { target: { value: '€450,000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save mark' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/held in USD; this amount is in EUR/)
    const { positions } = await api.investments('e_personal')
    expect(positions.find((p) => p.issuer === 'Lumen Health')!.value.currency).toBe('USD')
  })

  it('adding the same company and security again is a follow-on into that position, with Undo on the toast', async () => {
    const api = await toPortfolio()
    const before = (await api.investments('e_personal')).positions.length
    fireEvent.click(await screen.findByRole('button', { name: 'Add an investment' }))
    fireEvent.input(screen.getByLabelText('Company'), { target: { value: 'lumen health' } })
    fireEvent.input(screen.getByLabelText('Amount'), { target: { value: '50,000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await screen.findByText(/Added \$50,000 to Lumen Health\./)
    expect((await api.investments('e_personal')).positions).toHaveLength(before)
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await screen.findByText('Undone.')
  })
})

describe('Carta’s branding (its production review)', () => {
  it('“Powered by Carta” under the positions only when the company has a Carta connection; Carta rows carry its mark', async () => {
    const api = new MockApi()
    location.hash = '#/?d=investments:e_personal'
    const view = render(html`<${Root} api=${api} />`)
    await screen.findByRole('button', { name: /^Lumen Health/ })
    expect(screen.queryByRole('img', { name: 'Powered by Carta' })).toBeNull()
    view.unmount()

    api.s.connections.push({ id: 'c_carta', connectorKey: 'carta', name: 'Carta', entityNames: ['Personal'], status: 'ok', lastSyncAt: new Date().toISOString(), accountCount: 0 } as never)
    location.hash = '#/?d=investments:e_personal'
    render(html`<${Root} api=${api} />`)
    await screen.findByRole('button', { name: /^Lumen Health/ })
    expect(screen.getByRole('img', { name: 'Powered by Carta' }).className).toBe('powered-carta')
    location.hash = '#/'
    await screen.findByText(/^Carta/)
    expect(document.querySelectorAll('.tile.brand-carta').length).toBeGreaterThan(0)
  })
})
