// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact'
import { describe, expect, it, vi } from 'vitest'
import { HttpError } from '../api/http.ts'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'

const start = (api: MockApi, hash: string) => {
  location.hash = hash
  return render(html`<${Root} api=${api} />`)
}

describe('Reconnect and refresh', () => {
  it('Reconnect repairs the connection in place (non-Plaid goes through its own connect flow)', async () => {
    const api = new MockApi()
    let asked: unknown[] = []
    const base = api.reconnect.bind(api)
    api.reconnect = async (id, sel) => ((asked = [id, sel]), base(id))
    start(api, '#/?d=connection:c_mercury')
    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }))
    await screen.findByRole('heading', { name: 'Connect Mercury' })
    expect(asked).toEqual(['c_mercury', false])
  })

  it('a connection with an error says why in plain words and offers Reconnect', async () => {
    const api = new MockApi()
    const stripe = api.s.connections.find((c) => c.connectorKey === 'stripe')!
    Object.assign(stripe, { status: 'error', message: 'Aggregate couldn’t read Stripe just now. Sync now to try again; if this keeps happening, reconnect Stripe.' })
    let asked = ''
    api.reconnect = async (id) => ((asked = id), { kind: 'connect' as const, connectorKey: 'stripe' })
    start(api, `#/?d=connection:${stripe.id}`)
    const d = await screen.findByRole('dialog')
    fireEvent.click(await within(d).findByRole('button', { name: 'Reconnect' }))
    expect(within(d).getAllByText(/if this keeps happening, reconnect Stripe/).length).toBeGreaterThan(0)
    await waitFor(() => expect(asked).toBe(stripe.id))
  })

  it('a connection removed at the bank says so and offers a fresh connect', async () => {
    const api = new MockApi()
    api.reconnect = async () => {
      throw new HttpError(409, 'Mercury removed this connection. Connect it again to keep syncing.', 'gone')
    }
    start(api, '#/?d=connection:c_mercury')
    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Mercury removed this connection.')
    expect(screen.getByRole('button', { name: 'Connect it again' })).toBeTruthy()
  })

  it('"new accounts" shows Choose accounts and asks for account selection', async () => {
    const api = new MockApi()
    const chase = api.s.connections.find((c) => c.id === 'c_chase')!
    Object.assign(chase, { attention: ['new_accounts'], message: 'Chase has new accounts. Choose which ones Aggregate reads.' })
    let sel: boolean | undefined
    api.reconnect = async (_id, s) => ((sel = s), { kind: 'connect' as const, connectorKey: 'plaid' })
    start(api, '#/?d=connection:c_chase')
    expect(await screen.findByText('Chase has new accounts. Choose which ones Aggregate reads.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Choose accounts' }))
    await waitFor(() => expect(sel).toBe(true))
  })

  it('Refresh balance runs only on the click, and explains the cooldown', async () => {
    const api = new MockApi()
    let calls = 0
    api.refreshBalance = async () => {
      calls++
      if (calls === 2) return { ok: true as const, live: false as const, reason: 'cooldown' as const, refreshedAt: new Date().toISOString(), retryAt: '2026-10-10T21:10:00.000Z', message: 'Refreshed just now. You can check live again 21:10 UTC.' }
      return { ok: true as const, live: true as const, at: new Date().toISOString() }
    }
    start(api, '#/?d=connection:c_chase')
    const btn = await screen.findByRole('button', { name: 'Refresh balance' })
    expect(calls).toBe(0)
    fireEvent.click(btn)
    await screen.findByText('Balance updated.')
    expect(await screen.findByText(/· checked/)).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh balance' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Refreshed just now. You can check live again 21:10 UTC.')
    expect(calls).toBe(2)
  })

  it('no Refresh balance where there is no live check', async () => {
    start(new MockApi(), '#/?d=connection:c_stripe_nex')
    await screen.findByRole('button', { name: 'Sync now' })
    expect(screen.queryByRole('button', { name: 'Refresh balance' })).toBeNull()
  })
})

describe('Sync now', () => {
  it('keeps checking while the connection syncs, then shows it done', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const api = new MockApi()
      const base = api.connection.bind(api)
      let reads = 0
      api.connection = async (id: string) => {
        reads++
        const c = await base(id)
        return { ...c, status: reads >= 2 && reads < 4 ? ('syncing' as const) : ('ok' as const) }
      }
      start(api, '#/?d=connection:c_chase')
      fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }))
      await screen.findByText('syncing…')
      await vi.advanceTimersByTimeAsync(3100)
      await vi.advanceTimersByTimeAsync(3100)
      await waitFor(() => expect(screen.queryByText('syncing…')).toBeNull())
      expect(reads).toBeGreaterThanOrEqual(4)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Connection company', () => {
  it('a connection with no company asks which, and saving moves it', async () => {
    const api = new MockApi()
    const stripe = api.s.connections.find((c) => c.id === 'c_stripe_nex')!
    stripe.entityNames = []
    start(api, '#/?d=connection:c_stripe_nex')
    expect(await screen.findByText('Which company is this for? Nothing from it counts until you choose.')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Company for Stripe'), { target: { value: 'e_acme' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/Stripe now belongs to Acme/)).toBeTruthy()
    expect(stripe.entityNames).toEqual(['Acme'])
  })
  it('a workspace with only Personal can place a connection there (a person’s own Carta portfolio)', async () => {
    const api = new MockApi()
    api.s.entities = api.s.entities.filter((e) => e.kind === 'personal')
    const stripe = api.s.connections.find((c) => c.id === 'c_stripe_nex')!
    stripe.entityNames = []
    start(api, '#/?d=connection:c_stripe_nex')
    expect(await screen.findByText('Which company is this for? Nothing from it counts until you choose.')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Company for Stripe'), { target: { value: 'e_personal' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/Stripe now belongs to Personal/)).toBeTruthy()
  })
  it('a placed single-company source offers a quiet move; banks do not', async () => {
    const v = start(new MockApi(), '#/?d=connection:c_stripe_nex')
    expect(await screen.findByRole('button', { name: 'Move to another company' })).toBeTruthy()
    v.unmount()
    start(new MockApi(), '#/?d=connection:c_chase')
    await screen.findByRole('button', { name: 'Sync now' })
    expect(screen.queryByRole('button', { name: 'Move to another company' })).toBeNull()
  })
})

describe('Xero wording', () => {
  it('Xero says "Connect to Xero" and "Disconnect from Xero"; others keep plain "Continue to …" and "Disconnect"', async () => {
    const api = new MockApi()
    api.s.connections.push({ ...api.s.connections.find((c) => c.id === 'c_stripe_nex')!, id: 'c_xero', connectorKey: 'xero', name: 'Xero' })
    const v = start(api, '#/?d=connection:c_xero')
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect from Xero' }))
    expect(screen.getByRole('button', { name: 'Disconnect from Xero' })).toBeTruthy()
    v.unmount()
    const w = start(new MockApi(), '#/?d=connection:c_stripe_nex')
    expect(await screen.findByRole('button', { name: 'Disconnect' })).toBeTruthy()
    w.unmount()
    start(new MockApi(), '#/?d=connect:stripe')
    expect(await screen.findByRole('button', { name: 'Continue to Stripe' })).toBeTruthy()
  })

  it('QuickBooks says "Connect to QuickBooks" and "Disconnect from QuickBooks" (Intuit\'s review)', async () => {
    const v = start(new MockApi(), '#/?d=connect:quickbooks')
    expect(await screen.findByRole('button', { name: 'Connect to QuickBooks' })).toBeTruthy()
    v.unmount()
    const api = new MockApi()
    api.s.connections.push({ ...api.s.connections.find((c) => c.id === 'c_stripe_nex')!, id: 'c_qbo', connectorKey: 'quickbooks', name: 'QuickBooks' })
    start(api, '#/?d=connection:c_qbo')
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect from QuickBooks' }))
    expect(screen.getByRole('button', { name: 'Disconnect from QuickBooks' })).toBeTruthy()
  })
})
