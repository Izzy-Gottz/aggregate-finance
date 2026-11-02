// @vitest-environment happy-dom
import { render, screen, within } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'

const open = (storeSales?: Array<{ minor: number; currency: string }>, connectorKey = 'woocommerce') => {
  const api = new MockApi()
  api.s.connections.push({ id: 'c_woo', connectorKey, name: 'WooCommerce', entityNames: ['Demo'], status: 'ok', lastSyncAt: new Date().toISOString(), accountCount: 0, ...(storeSales ? { storeSales } : {}) } as never)
  location.hash = '#/?d=connection:c_woo'
  render(html`<${Root} api=${api} />`)
  return screen.findByRole('dialog')
}

describe('the WooCommerce line in connection details', () => {
  it('says what it is, in the words agreed, to the cent', async () => {
    const d = await open([{ minor: 1_234_56, currency: 'USD' }])
    expect(await within(d).findByText('Sales reported by the store: $1,234.56 this month, not counted as revenue')).toBeTruthy()
  })
  it('one line each for several currencies', async () => {
    const d = await open([{ minor: 20_00, currency: 'EUR' }, { minor: 3000, currency: 'JPY' }, { minor: 10_00, currency: 'USD' }])
    expect(await within(d).findByText('Sales reported by the store: €20.00 this month, not counted as revenue')).toBeTruthy()
    expect(within(d).getByText('Sales reported by the store: ¥3,000 this month, not counted as revenue')).toBeTruthy()
    expect(within(d).getByText('Sales reported by the store: $10.00 this month, not counted as revenue')).toBeTruthy()
  })
  it('zero and negative read as money', async () => {
    const d = await open([{ minor: -15_00, currency: 'USD' }])
    expect(await within(d).findByText('Sales reported by the store: −$15.00 this month, not counted as revenue')).toBeTruthy()
  })
  it('no snapshot, no line', async () => {
    const d = await open()
    await within(d).findByRole('heading', { name: /WooCommerce/ })
    expect(within(d).queryByText(/Sales reported by the store/)).toBeNull()
  })
})
