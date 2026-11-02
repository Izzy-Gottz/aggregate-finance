// @vitest-environment happy-dom
// Set-asides: the overview line, and the bucket drawer's held amounts, goal line and one-account form.
import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { HttpError } from '../api/http.ts'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'
import { goalLine } from './bucket.ts'

const usd = (dollars: number) => ({ minor: dollars * 100, currency: 'USD' })
const start = (api: MockApi, hash: string) => {
  location.hash = hash
  return render(html`<${Root} api=${api} />`)
}
const firstBucket = (api: MockApi) => Object.values(api.s.buckets)[0]!

describe('Set aside', () => {
  it('the company drawer says what’s free and what’s set aside; without one, no line', async () => {
    const api = new MockApi()
    const id = api.s.entities.find((e) => e.kind === 'company')!.id
    api.s.companies[id]!.entity.setAside = { available: usd(12_500), held: usd(7_500) }
    start(api, `#/?d=company:${id}`)
    await screen.findByText('Available $12,500 · $7,500 set aside')
  })

  it('a bucket with nothing set aside offers it behind +', async () => {
    const api = new MockApi()
    start(api, `#/?d=bucket:${firstBucket(api).id}`)
    await screen.findByRole('button', { name: /Set money aside/ })
    expect(screen.queryByRole('heading', { name: 'Set aside' })).toBeNull()
  })

  it('setting an amount aside sends one allocation, and "Don’t count in cash"', async () => {
    const api = new MockApi()
    const b = firstBucket(api)
    let sent: unknown
    const base = api.updateBucket.bind(api)
    api.updateBucket = (id, p) => ((sent = p.setAside), base(id, p))
    start(api, `#/?d=bucket:${b.id}`)
    fireEvent.click(await screen.findByRole('button', { name: /Set money aside/ }))
    await waitFor(() => expect((screen.getByLabelText('From') as HTMLSelectElement).options.length).toBeGreaterThan(0))
    expect([...(screen.getByLabelText('From') as HTMLSelectElement).options].map((o) => o.text).join()).not.toMatch(/Card|Loan/i)
    fireEvent.input(screen.getByLabelText('Amount'), { target: { value: '$7,500' } })
    fireEvent.click(screen.getByLabelText(/Don’t count in cash/))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('heading', { name: 'Set aside' })
    await screen.findByText('Not counted in cash')
    expect(sent).toMatchObject({ allocations: [{ amount: { minor: 750_000, currency: 'USD' } }], countsInCash: false })
  })

  it('the server’s plain refusal shows in the form', async () => {
    const api = new MockApi()
    api.updateBucket = (async () => {
      throw new HttpError(422, 'More than 100% of Savings would be set aside', 'invalid', {})
    }) as typeof api.updateBucket
    start(api, `#/?d=bucket:${firstBucket(api).id}`)
    fireEvent.click(await screen.findByRole('button', { name: /Set money aside/ }))
    await waitFor(() => expect((screen.getByLabelText('From') as HTMLSelectElement).options.length).toBeGreaterThan(0))
    fireEvent.input(screen.getByLabelText('Amount'), { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent).toBe('More than 100% of Savings would be set aside')
  })

  it('stopping keeps the bucket and sends null', async () => {
    const api = new MockApi()
    const b = firstBucket(api)
    b.setAside = { countsInCash: true, held: usd(100), perAccount: [{ accountId: 'a', accountName: 'Savings', entityId: b.entityId, held: usd(100), heldBase: usd(100) }] }
    start(api, `#/?d=bucket:${b.id}`)
    fireEvent.click(await screen.findByRole('button', { name: 'Stop setting aside' }))
    await screen.findByRole('button', { name: /Set money aside/ })
    expect(api.s.buckets[b.id]!.setAside).toBeUndefined()
  })

  it('Change keeps the goal and "Don’t count in cash" unless they’re changed', async () => {
    const api = new MockApi()
    const b = firstBucket(api)
    const account = api.s.companies[b.entityId]!.accounts.find((a) => a.kind !== 'card' && a.kind !== 'loan')!
    b.setAside = { countsInCash: false, held: usd(100), note: 'For taxes', goal: { target: usd(10_000), by: '2027-12-31', progressPercent: 1 }, perAccount: [{ accountId: account.id, accountName: account.name, entityId: b.entityId, held: usd(100), heldBase: usd(100) }] }
    let sent: unknown
    const base = api.updateBucket.bind(api)
    api.updateBucket = (id, p) => ((sent = p.setAside), base(id, p))
    start(api, `#/?d=bucket:${b.id}`)
    fireEvent.click(await screen.findByRole('button', { name: 'Change' }))
    await waitFor(() => expect((screen.getByLabelText('From') as HTMLSelectElement).options.length).toBeGreaterThan(0))
    fireEvent.input(screen.getByLabelText('Amount'), { target: { value: '200' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(sent).toBeTruthy())
    expect(sent).toMatchObject({ allocations: [{ accountId: account.id, amount: usd(200) }], countsInCash: false, goal: { amount: usd(10_000), by: '2027-12-31' } })
  })

  it('a server without set-asides shows nothing about them, even one already stored', async () => {
    const api = new MockApi()
    const b = firstBucket(api)
    b.canSetAside = false
    start(api, `#/?d=bucket:${b.id}`)
    await screen.findByRole('heading', { name: b.name })
    expect(screen.queryByRole('button', { name: /Set money aside/ })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Set aside' })).toBeNull()
  })

  it('emptying the note in Change removes it', async () => {
    const api = new MockApi()
    const b = firstBucket(api)
    const account = api.s.companies[b.entityId]!.accounts.find((a) => a.kind !== 'card' && a.kind !== 'loan')!
    b.setAside = { countsInCash: true, held: usd(100), note: 'For taxes', perAccount: [{ accountId: account.id, accountName: account.name, entityId: b.entityId, held: usd(100), heldBase: usd(100) }] }
    let sent: { note?: string | null } | null | undefined
    const base = api.updateBucket.bind(api)
    api.updateBucket = (id, p) => ((sent = p.setAside), base(id, p))
    start(api, `#/?d=bucket:${b.id}`)
    fireEvent.click(await screen.findByRole('button', { name: 'Change' }))
    const field = await screen.findByLabelText('Note (optional)') as HTMLInputElement
    expect(field.value).toBe('For taxes')
    fireEvent.input(field, { target: { value: '' } })
    await waitFor(() => expect((screen.getByLabelText('From') as HTMLSelectElement).options.length).toBeGreaterThan(0))
    fireEvent.input(screen.getByLabelText('Amount'), { target: { value: '200' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(sent).toBeTruthy())
    expect(sent!.note).toBeNull()
  })

  it('the goal line reads plainly, with pace only when known', () => {
    expect(goalLine(usd(4_000), { target: usd(10_000), by: '2026-12-31', progressPercent: 40, onPace: true })).toBe('$4,000 of $10,000 by Dec 2026 · on pace')
    expect(goalLine(usd(4_000), { target: usd(10_000), by: '2026-12-31', progressPercent: 40, onPace: false })).toBe('$4,000 of $10,000 by Dec 2026 · behind')
    expect(goalLine(usd(4_000), { target: usd(10_000), progressPercent: 40 })).toBe('$4,000 of $10,000')
  })
})
