// @vitest-environment happy-dom
import { render, screen, within } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'

describe('the Zeffy line in connection details', () => {
  it('says what it is, in the words agreed, to the cent', async () => {
    const api = new MockApi()
    api.s.connections.push({ id: 'c_z', connectorKey: 'zeffy', name: 'Zeffy', entityNames: ['Demo'], status: 'ok', lastSyncAt: new Date().toISOString(), accountCount: 0, storeSales: [{ minor: 2325_50, currency: 'CAD' }] } as never)
    location.hash = '#/?d=connection:c_z'
    render(html`<${Root} api=${api} />`)
    const d = await screen.findByRole('dialog')
    expect(await within(d).findByText('Received online through Zeffy: CA$2,325.50 this month, not counted as revenue')).toBeTruthy()
    expect(within(d).queryByText(/Sales reported by the store/)).toBeNull()
  })
})
