// @vitest-environment happy-dom
// A bank account placed under the wrong company moves from the connection drawer (34, after a by-hand fix on live).
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'

const start = (api: MockApi) => {
  location.hash = '#/?d=connection:c_chase'
  return render(html`<${Root} api=${api} />`)
}

describe('Move a bank account to another company', () => {
  it('lists the other companies and Personal, not its own, and moves just that account', async () => {
    const api = new MockApi()
    const calls: unknown[] = []
    const base = api.assignAccounts.bind(api)
    api.assignAccounts = async (a) => (calls.push(a), base(a))
    start(api)
    const d = await screen.findByRole('dialog')
    fireEvent.click(await within(d).findByRole('button', { name: 'Move Business Checking to another company' }))
    const select = within(d).getByLabelText('Company for Business Checking ··4021') as HTMLSelectElement
    const names = [...select.options].filter((o) => !o.disabled).map((o) => o.textContent)
    expect(names).not.toContain('Acme')
    expect(names).toContain('Personal')
    fireEvent.change(select, { target: { value: 'e_personal' } })
    fireEvent.click(within(d).getByRole('button', { name: 'Move' }))
    await screen.findByText('Business Checking ··4021 now belongs to Personal.')
    expect(calls).toEqual([[{ accountId: 'ac1', entityId: 'personal' }]])
    // The account now counts toward Personal: moving it again no longer offers Personal, and offers Acme.
    fireEvent.click(await within(d).findByRole('button', { name: 'Move Business Checking to another company' }))
    const again = [...(within(d).getByLabelText('Company for Business Checking ··4021') as HTMLSelectElement).options].map((o) => o.textContent)
    expect(again).toContain('Acme')
    expect(again).not.toContain('Personal')
  })

  it('Cancel closes it without saving; a failure says so and keeps the choice open', async () => {
    const api = new MockApi()
    api.assignAccounts = async () => {
      throw new Error('You can’t add accounts to that company.')
    }
    start(api)
    const d = await screen.findByRole('dialog')
    fireEvent.click(await within(d).findByRole('button', { name: 'Move Business Savings to another company' }))
    fireEvent.click(within(d).getByRole('button', { name: 'Cancel' }))
    expect(within(d).queryByLabelText('Company for Business Savings ··7710')).toBeNull()
    fireEvent.click(within(d).getByRole('button', { name: 'Move Business Savings to another company' }))
    const select = within(d).getByLabelText('Company for Business Savings ··7710') as HTMLSelectElement
    fireEvent.change(select, { target: { value: select.options[1]!.value } })
    fireEvent.click(within(d).getByRole('button', { name: 'Move' }))
    expect((await within(d).findByRole('alert')).textContent).toBe('You can’t add accounts to that company.')
    expect(within(d).getByLabelText('Company for Business Savings ··7710')).toBeTruthy()
  })

  it('members, and sources that aren’t banks, don’t get the link', async () => {
    const api = new MockApi()
    ;(api.s.me as { workspaces?: unknown }).workspaces = [{ id: api.s.me.workspaceId, name: 'Demo', role: 'member' }]
    start(api)
    const d = await screen.findByRole('dialog')
    await within(d).findByText('Business Checking ··4021')
    expect(within(d).queryByRole('button', { name: /to another company/ })).toBeNull()
  })

  it('sources that aren’t banks keep their one-company move (no per-account link)', async () => {
    location.hash = '#/?d=connection:c_mercury'
    render(html`<${Root} api=${new MockApi()} />`)
    const d = await screen.findByRole('dialog')
    await within(d).findByRole('heading', { name: 'Mercury' })
    expect(within(d).queryAllByRole('button', { name: /^Move .+ to another company$/ })).toHaveLength(0)
  })
})

describe('Disconnecting something whose data can’t stay', () => {
  const open = async (connectorKey: string, erases?: 'always' | 'maybe') => {
    const api = new MockApi()
    api.s.connections.push({ id: 'c_x', connectorKey, name: 'QuickBooks', entityNames: ['Acme'], status: 'ok', lastSyncAt: new Date().toISOString(), accountCount: 1 } as never)
    if (erases) {
      const base = api.connection.bind(api)
      api.connection = (async (id: string) => ({ ...(await base(id)), erasesOnDisconnect: erases })) as typeof api.connection
    }
    location.hash = '#/?d=connection:c_x'
    render(html`<${Root} api=${api} />`)
    return api
  }

  it('always: one action, says the data will be deleted, never that it stays', async () => {
    await open('quickbooks')
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect from QuickBooks' }))
    await screen.findByText('Disconnect QuickBooks?')
    await screen.findByText('Its data will be deleted.')
    expect(screen.queryByText(/stays/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Disconnect and delete its data' })).toBeNull()
  })

  it('maybe: says it may be deleted', async () => {
    await open('shopify', 'maybe')
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))
    await screen.findByText('Its data may be deleted when you do.')
  })

  it('everything else keeps both choices and "stays"', async () => {
    await open('stripe')
    expect(await screen.findByRole('button', { name: 'Disconnect and delete its data' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    await screen.findByText('We stop syncing. What already synced stays.')
  })

  it('names the provider, not the account there, and shows the provider’s step until Done', async () => {
    const api = new MockApi()
    api.s.connections.push({ id: 'c_s', connectorKey: 'stripe', name: 'Stripe · Aggregate', entityNames: ['Acme'], status: 'ok', lastSyncAt: new Date().toISOString(), accountCount: 1 } as never)
    api.disconnect = (async () => ({ ok: true, warning: 'In Stripe, open Installed apps → ⋯ next to Aggregate → View app details → Uninstall app.' })) as unknown as typeof api.disconnect
    location.hash = '#/?d=connection:c_s'
    render(html`<${Root} api=${api} />`)
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))
    await screen.findByText('Disconnect Stripe?')
    fireEvent.click(screen.getAllByRole('button', { name: 'Disconnect' }).at(-1)!)
    await screen.findByRole('heading', { name: 'Stripe disconnected' })
    await screen.findByText(/One more step: in Stripe, open Installed apps → ⋯ next to Aggregate → View app details → Uninstall app\./)
    expect((screen.getByRole('link', { name: /Open Stripe/ }) as HTMLAnchorElement).href).toContain('dashboard.stripe.com')
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Stripe disconnected' })).toBeNull())
  })

  it('nothing left to do: a short toast', async () => {
    const api = new MockApi()
    api.s.connections.push({ id: 'c_s', connectorKey: 'stripe', name: 'Stripe', entityNames: ['Acme'], status: 'ok', lastSyncAt: new Date().toISOString(), accountCount: 1 } as never)
    location.hash = '#/?d=connection:c_s'
    render(html`<${Root} api=${api} />`)
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Disconnect' }).at(-1)!)
    await screen.findByText('Stripe disconnected.')
  })
})
