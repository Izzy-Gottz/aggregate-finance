// @vitest-environment happy-dom
import { render, screen, within } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'

describe('the Pinterest line in connection details', () => {
  it('says what it is, in the words agreed, to the cent', async () => {
    const api = new MockApi()
    api.s.connections.push({ id: 'c_a', connectorKey: 'pinterest', name: 'Pinterest Ads', entityNames: ['Demo'], status: 'ok', lastSyncAt: new Date().toISOString(), accountCount: 0, storeSales: [{ minor: 34_56, currency: 'USD' }] } as never)
    location.hash = '#/?d=connection:c_a'
    render(html`<${Root} api=${api} />`)
    const d = await screen.findByRole('dialog')
    expect(await within(d).findByText('Spent on Pinterest ads: $34.56 this month, not counted as an expense')).toBeTruthy()
  })
})
