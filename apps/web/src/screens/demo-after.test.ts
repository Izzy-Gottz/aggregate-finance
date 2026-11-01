// @vitest-environment happy-dom
// 43 / Yisrael on live: naming the company used to end the chance to look around the demo. Now "Connect your money"
// and the empty home offer it until there's data; leaving the demo comes back to their company.
import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'

const LINK = 'Or look around with made-up companies first'
const start = (api: MockApi, hash: string) => {
  location.hash = hash
  return render(html`<${Root} api=${api} />`)
}
const newPerson = () => {
  const api = new MockApi({ empty: true })
  api.s.me = { ...api.s.me, demo: false }
  return api
}

describe('the demo after naming a company', () => {
  it('Connect your money offers it; the demo opens in its own workspace; leaving lands back in their company', async () => {
    const api = newPerson()
    let adopted = ''
    api.setWorkspace = (id: string) => void (adopted = id)
    start(api, '#/welcome/1')
    fireEvent.input(await screen.findByLabelText('Company name'), { target: { value: 'Brightline' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Connect your money' })
    fireEvent.click(screen.getByRole('button', { name: LINK }))
    await waitFor(() => expect(location.hash).toMatch(/^#\/($|\?)/))
    expect(adopted).toBeTruthy()
    await screen.findByText(/You’re looking at a demo with made-up companies/)

    fireEvent.click(screen.getByRole('button', { name: 'Start with your own companies →' }))
    await waitFor(() => expect(screen.queryByText(/You’re looking at a demo/)).toBeNull())
    // Their own company, on the home screen (not setup from the start).
    await screen.findByRole('button', { name: /^Brightline/ })
    expect(location.hash).not.toMatch(/welcome/)
  })

  it('the empty home offers it; it goes once there is a connection', async () => {
    const api = newPerson()
    await api.createWorkspace('Brightline')
    start(api, '#/')
    await screen.findByRole('button', { name: LINK })
    api.s.connections.push({ id: 'c1', connectorKey: 'plaid', name: 'Chase', entityNames: ['Brightline'], status: 'ok', lastSyncAt: new Date().toISOString(), accountCount: 1 } as never)
    window.dispatchEvent(new Event('focus'))
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(screen.queryByRole('button', { name: LINK })).toBeNull())
  })

  it('never inside the demo itself', async () => {
    start(new MockApi(), '#/')
    await screen.findByText(/You’re looking at a demo/)
    expect(screen.queryByRole('button', { name: LINK })).toBeNull()
  })
})

describe('a brand-new company on the home screen (43)', () => {
  it('says "Nothing connected yet." instead of a cash warning and "All reconciled"; those come back with data', async () => {
    const api = newPerson()
    await api.createWorkspace('AG test')
    api.s.entities = api.s.entities.map((e) => ({ ...e, cash: null, cashCaveat: { state: 'unknown', reason: 'No account counts as cash (a bank, cash on hand or processor balance account)' } }) as never)
    start(api, '#/')
    await screen.findByText('Nothing connected yet.')
    expect(screen.queryByText(/No account counts as cash/)).toBeNull()
    expect(screen.queryByText('unknown')).toBeNull()
    expect(screen.queryByText('All reconciled')).toBeNull()
    expect(screen.getByRole('button', { name: LINK })).toBeTruthy()
  })

  it('per company: one with nothing in it still reads "no data yet" once another has a statement (43)', async () => {
    const api = newPerson()
    await api.createWorkspace('Daft Test Co')
    const caveat = { state: 'unknown', reason: 'No account counts as cash (a bank, cash on hand or processor balance account)' }
    api.s.entities = api.s.entities.map((e) => (e.kind === 'personal' ? { ...e, cash: { minor: 338_800, currency: 'USD' } } : { ...e, cash: null, cashCaveat: caveat }) as never)
    api.s.connections = [{ id: 'c_files', connectorKey: 'files', name: 'Bank of America checking', entityNames: ['Personal'], status: 'ok', lastSyncAt: new Date().toISOString(), accountCount: 1 } as never]
    start(api, '#/')
    const daft = await screen.findByRole('button', { name: /^Daft Test Co/ })
    expect(daft.textContent).toMatch(/no data yet/)
    expect(daft.textContent).not.toMatch(/No account counts as cash|unknown/)
    expect(screen.getByRole('button', { name: /^Personal/ }).textContent).toMatch(/\$3,388/)
    // There is data now: no "Nothing connected yet.", and the health line is back.
    expect(screen.queryByText('Nothing connected yet.')).toBeNull()
  })
})
