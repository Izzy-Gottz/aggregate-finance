// @vitest-environment happy-dom
import { render, screen, within } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'

describe('the Lightspeed line in connection details', () => {
  it('says what it is, in the words agreed, to the cent', async () => {
    const api = new MockApi()
    api.s.connections.push({ id: 'c_l', connectorKey: 'lightspeed', name: 'Lightspeed', entityNames: ['Demo'], status: 'ok', lastSyncAt: new Date().toISOString(), accountCount: 0, storeSales: [{ minor: 1129_95, currency: 'USD' }] } as never)
    location.hash = '#/?d=connection:c_l'
    render(html`<${Root} api=${api} />`)
    const d = await screen.findByRole('dialog')
    expect(await within(d).findByText('Sales reported by the store: $1,129.95 this month, not counted as revenue')).toBeTruthy()
  })
})
