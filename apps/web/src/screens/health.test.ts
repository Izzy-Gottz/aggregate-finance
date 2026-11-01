// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact'
import { describe, expect, it, vi } from 'vitest'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'

const start = (api: MockApi, hash: string) => {
  location.hash = hash
  return render(html`<${Root} api=${api} />`)
}

describe('Data health line', () => {
  it('shows one grey line under Money that opens what needs a look', async () => {
    start(new MockApi(), '#/')
    const line = await screen.findByRole('button', { name: /things? needs? a look/ })
    fireEvent.click(line)
    await screen.findByRole('heading', { name: 'Needs a look' })
    expect(location.hash).toBe('#/?d=health')
    const transit = screen.getByRole('button', { name: /wasn’t seen arriving/ })
    fireEvent.click(transit)
    expect(location.hash).toMatch(/^#\/\?d=health\/txns:/)
  })

  it('an account with no balance yet says so and opens its company', async () => {
    const api = new MockApi()
    const health = () => ({ status: 'needs_review' as const, line: '1 thing needs a look: 1 balance not reported yet', items: [{ kind: 'stale_source' as const, entityId: 'e_cla', text: 'Square hasn’t reported a balance yet', refId: 'acct_sq' }] })
    ;(api as unknown as { health: typeof health }).health = health
    start(api, '#/?d=health')
    const row = await screen.findByRole('button', { name: 'Square hasn’t reported a balance yet' })
    expect(row.textContent).toContain('No balance yet · Harbor Coffee')
    fireEvent.click(row)
    await screen.findByRole('heading', { name: 'Harbor Coffee' })
  })

  it('says All reconciled quietly when nothing needs a look, and nothing when there is no data', async () => {
    const api = new MockApi()
    const health = () => ({ status: 'ok' as const, line: 'All reconciled', items: [] })
    ;(api as unknown as { health: typeof health }).health = health
    const v = start(api, '#/')
    expect((await screen.findByText('All reconciled')).tagName).toBe('P')
    v.unmount()
    start(new MockApi({ empty: true } as never), '#/')
    await screen.findByRole('region', { name: 'Money' })
    expect(screen.queryByText(/reconciled|a look/)).toBeNull()
  })
})

describe('Anything odd', () => {
  it('rows backed by records open the transactions', async () => {
    start(new MockApi(), '#/?d=company:e_acme')
    const row = await screen.findByRole('button', { name: /Figma charged twice/ })
    fireEvent.click(row)
    await screen.findByRole('heading', { name: /Transactions/ })
    expect(location.hash).toBe('#/?d=company:e_acme/txns:e_acme')
  })
})

describe('Accounts waiting for a company', () => {
  it('the connection drawer asks which company, and saving assigns them', async () => {
    const api = new MockApi()
    const base = api.connection.bind(api)
    let assigned: unknown = null
    api.connection = async (id: string) => ({ ...(await base(id)), unassigned: [{ id: 'acct_new', name: 'Plaid Checking', mask: '0000' }] })
    api.assignAccounts = async (a) => void (assigned = a)
    start(api, '#/?d=connection:c_mercury')
    await screen.findByRole('region', { name: 'Which company is each account?' })
    fireEvent.change(screen.getByLabelText('Company for Plaid Checking'), { target: { value: 'personal' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Saved. Its transactions are coming in.')
    expect(assigned).toEqual([{ accountId: 'acct_new', entityId: 'personal' }])
  })
})

describe('Connections list', () => {
  it('hides built-in sources and never repeats the company in a name', async () => {
    const api = new MockApi()
    api.s.connections.push(
      { id: 'c_cap', connectorKey: 'equity', name: 'Cap table', entityNames: ['Acme'], status: 'ok', lastSyncAt: null, accountCount: 0 },
      { id: 'c_demo', connectorKey: 'stripe', name: 'Demo data · Acme', entityNames: ['Acme'], status: 'ok', lastSyncAt: null, accountCount: 1 },
    )
    start(api, '#/')
    const list = await screen.findByRole('list', { name: 'Connections' })
    expect(list.textContent).not.toContain('Cap table')
    expect(list.textContent).toContain('Demo data · Acme')
    expect(list.textContent).not.toContain('Demo data · Acme · Acme')
  })
})

describe('Missing statements', () => {
  it('an uploaded account’s missing month opens Upload; a quiet synced one opens its company', async () => {
    const api = new MockApi()
    ;(api as unknown as { health: () => unknown }).health = () => ({
      status: 'needs_review',
      line: '2 things need a look: 2 months missing',
      items: [
        { kind: 'missing_statement', entityId: 'e_acme', text: 'Statement for Savings ··9001 missing for August', refId: 'a1' },
        { kind: 'missing_statement', entityId: 'e_acme', text: 'No Chase ··4411 transactions in August', refId: 'a2' },
      ],
    })
    start(api, '#/?d=health')
    fireEvent.click(await screen.findByRole('button', { name: /Statement for Savings/ }))
    await waitFor(() => expect(location.hash).toBe('#/?d=health/add:upload'))
    location.hash = '#/?d=health'
    fireEvent.click(await screen.findByRole('button', { name: /No Chase ··4411/ }))
    await waitFor(() => expect(location.hash).toBe('#/?d=health/company:e_acme'))
  })
})

describe('Statement upload that needs an account', () => {
  it('asks which account, then imports', async () => {
    const api = new MockApi()
    let chosen: string[] = []
    const base = api.chooseStatementAccount.bind(api)
    api.chooseStatementAccount = async (d, a) => ((chosen = [d, a]), base(d, a))
    start(api, '#/?d=add:upload')
    await screen.findByRole('heading', { name: 'Upload a file' })
    const input = screen.getByLabelText('Choose files to upload') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['date,amount\n'], 'chase-aug.csv', { type: 'text/csv' })] } })
    expect(await screen.findByText('Which account is this statement for?')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Account for chase-aug.csv'), { target: { value: 'new' } })
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    expect(await screen.findByText('Imported 3 rows.')).toBeTruthy()
    expect(chosen[1]).toBe('new')
  })
})

describe('Unknown and stale cash', () => {
  it('says unknown (with why) instead of a 0, and keeps a stale number with a quiet note', async () => {
    const api = new MockApi()
    const [acme, nex] = api.s.entities
    Object.assign(acme!, { cashCaveat: { state: 'stale', reason: 'Chase ··4411 last reported Sep 28; total uses that balance' } })
    Object.assign(nex!, { cash: null, cashCaveat: { state: 'unknown', reason: 'No balance from Stripe yet' } })
    const co = api.s.companies.e_acme!
    co.cash!.answer = { ...co.cash!.answer, state: 'stale', unknownReason: 'Chase ··4411 last reported Sep 28; total uses that balance' }
    const v = start(api, '#/')
    const money = await screen.findByRole('list', { name: 'Companies' })
    expect(money.textContent).toContain('unknown')
    expect(money.textContent).toContain('No balance from Stripe yet')
    expect(money.textContent).toContain('Chase ··4411 last reported Sep 28')
    v.unmount()
    start(api, '#/?d=company:e_acme')
    expect(await screen.findByText('Chase ··4411 last reported Sep 28; total uses that balance')).toBeTruthy()
  })
})

describe('Demo filling, waiting statements, guided keys', () => {
  it('says the demo is filling until it is ready', async () => {
    const api = new MockApi()
    ;(api.s.me as { demoReady?: boolean }).demoReady = false
    start(api, '#/')
    expect(await screen.findByText(/Filling the demo with a year of made-up activity/)).toBeTruthy()
  })

  it('statements waiting for an account show as one line with the picker behind it', async () => {
    const api = new MockApi()
    api.waiting = [{ documentId: 'd1', name: 'chase-aug.csv', entityId: 'e_acme', arrivedVia: 'email', createdAt: new Date().toISOString(), accounts: [{ id: 'a1', name: 'Checking', mask: '4411', institution: 'Chase' }] }]
    start(api, '#/')
    fireEvent.click(await screen.findByRole('button', { name: '1 statement needs an account' }))
    const imp = await screen.findByRole('button', { name: 'Import' })
    expect((imp as HTMLButtonElement).disabled).toBe(true) // nothing preselected
    fireEvent.change(screen.getByLabelText('Account for chase-aug.csv'), { target: { value: 'a1' } })
    fireEvent.click(imp)
    expect(await screen.findByText('chase-aug.csv: Imported 3 rows.')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('button', { name: /statement needs an account/ })).toBeNull())
  })

  it('an API-key connector shows its own numbered steps and the read-only permissions', async () => {
    const api = new MockApi()
    const base = api.startConnect.bind(api)
    ;(api as unknown as { startConnect: (k: string) => Promise<unknown> }).startConnect = async (key: string) => ({ ...(await base(key)), steps: ['Open Settings → API.', 'Create a restricted key.', 'Paste it here.'], permissions: ['Balance: Read', 'Payouts: Read'] })
    start(api, '#/?d=connect:mercury')
    fireEvent.change(await screen.findByLabelText('For which company?'), { target: { value: 'e_acme' } })
    fireEvent.click(screen.getByRole('button', { name: /Continue to Mercury/ }))
    expect(await screen.findByText('Create a restricted key.')).toBeTruthy()
    expect(screen.getByText('Payouts: Read')).toBeTruthy()
  })
})

describe('Review link from an AI', () => {
  it('goes to the held item, or says it was already decided', async () => {
    const api = new MockApi()
    const id = api.s.review[1]!.id
    api.s.review[1]!.id = `write:${id}`
    const v = start(api, `#/review?w=${id}`)
    await waitFor(() => expect(document.querySelector('li.linked [data-review]')?.getAttribute('data-review')).toBe(`write:${id}`))
    v.unmount()
    start(new MockApi(), '#/review?w=gone123')
    expect(await screen.findByText('That change was already decided, or it’s no longer waiting.')).toBeTruthy()
  })
})

describe('Who can email a company', () => {
  it('members are automatic; extra senders are edited, a bad line is named, refused senders can be allowed', async () => {
    const api = new MockApi()
    api.refused.e_acme = [{ at: new Date().toISOString(), from: 'billing@vendor.com', reason: 'not an allowed sender' }]
    start(api, '#/?d=add:email')
    const sec = await screen.findByRole('region', { name: 'Who can email Acme' })
    expect(sec.textContent).toContain('Everyone who can add documents here: Dana Reyes')
    fireEvent.click(within(sec).getByRole('button', { name: 'Allow' }))
    await waitFor(() => expect(api.senders.e_acme).toEqual(['billing@vendor.com']))
    await waitFor(() => expect(sec.textContent).not.toContain('Refused · not an allowed sender')) // allowed now, so no longer listed
    fireEvent.click(within(sec).getByRole('button', { name: 'Change' }))
    fireEvent.input(within(sec).getByLabelText('Senders for Acme, one per line'), { target: { value: 'me@acme.com\nnot an email' } })
    fireEvent.click(within(sec).getByRole('button', { name: 'Save' }))
    expect((await within(sec).findByRole('alert')).textContent).toBe('“not an email” isn’t an email address or a domain like @acme.com.')
    fireEvent.input(within(sec).getByLabelText('Senders for Acme, one per line'), { target: { value: 'me@acme.com\n@vendor.com' } })
    fireEvent.click(within(sec).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(sec.textContent).toContain('Also: me@acme.com, @vendor.com'))
  })
})

describe('Waiting to be read', () => {
  it('the company drawer lists unread documents with how they arrived', async () => {
    const api = new MockApi()
    api.unread = [{ documentId: 'd9', name: 'invoice-0042.pdf', entityId: 'e_acme', arrivedVia: 'email', createdAt: new Date().toISOString() }]
    start(api, '#/?d=company:e_acme')
    const sec = await screen.findByRole('region', { name: 'Waiting to be read' })
    expect(sec.textContent).toContain('invoice-0042.pdf')
    expect(sec.textContent).toContain('emailed in')
  })
})

describe('Card terms', () => {
  it('a card shows its minimum, due date and APR in the company drawer', async () => {
    const api = new MockApi()
    const card = api.s.companies.e_acme!.accounts.find((a) => a.kind === 'card') ?? api.s.companies.e_acme!.accounts[0]!
    card.terms = { kind: 'credit', apr: '24.9', minimumPayment: { minor: 3500, currency: 'USD' }, nextPaymentDueDate: '2026-10-28' }
    start(api, '#/?d=company:e_acme')
    expect(await screen.findByText(/Min \$35 due Oct 28 · 24\.9% APR/)).toBeTruthy()
  })
})

describe('Workspace refresh while syncing', () => {
  it('re-reads the workspace while a connection is syncing, and stops when it is done', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const api = new MockApi()
      const chase = api.s.connections.find((c) => c.id === 'c_chase')!
      chase.status = 'syncing'
      let reads = 0
      const base = api.workspace.bind(api)
      api.workspace = () => (reads++, base())
      start(api, '#/')
      await screen.findByRole('region', { name: 'Money' })
      const before = reads
      await vi.advanceTimersByTimeAsync(5100)
      await waitFor(() => expect(reads).toBeGreaterThan(before))
      chase.status = 'ok'
      await vi.advanceTimersByTimeAsync(5100)
      const settled = reads
      await vi.advanceTimersByTimeAsync(15000)
      expect(reads).toBe(settled)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Books closed', () => {
  it('managers close the books through a date; the drawer then says so and offers Reopen', async () => {
    const api = new MockApi()
    Object.assign(api.s.companies.e_acme!, { canClosePeriod: true, periodLock: null })
    start(api, '#/?d=company:e_acme')
    fireEvent.click(await screen.findByRole('button', { name: 'Close the books' }))
    expect(screen.getByText('Changes to a closed period post on the next open day, so closed months stay as reported.')).toBeTruthy()
    fireEvent.input(screen.getByLabelText('Closed through'), { target: { value: '2026-08-31' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Close the books' }).at(-1)!)
    expect(await screen.findByText('Books closed through Aug 31, 2026.')).toBeTruthy()
    expect(api.s.companies.e_acme!.periodLock).toMatchObject({ through: '2026-08-31' })
    // The drawer itself catches up: the closed line and Reopen, no "Close the books".
    expect(await screen.findByText('Books closed through Aug 31, 2026')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    await screen.findByRole('button', { name: 'Close the books' })
    expect(screen.queryByText('Books closed through Aug 31, 2026')).toBeNull()
  })
})

describe('MRR', () => {
  it('one quiet line on a company with subscriptions, opening the month-by-month drawer; unknown parts say why', async () => {
    const api = new MockApi()
    Object.assign(api.s.companies.e_acme!, {
      mrr: { value: { minor: 1_900_000, currency: 'USD' }, month: '2026-09', netNew: { value: { minor: 400_000, currency: 'USD' } }, churn: { reason: 'Stripe hasn’t synced past Sep 30 yet' } },
    })
    start(api, '#/?d=company:e_acme')
    const line = await screen.findByRole('button', { name: 'MRR $19,000 · +$4,000 net new in Sep · Stripe hasn’t synced past Sep 30 yet' })
    expect(line.textContent).not.toContain('0%')
    fireEvent.click(line)
    await screen.findByRole('heading', { name: 'Recurring revenue' })
    const sec = await screen.findByRole('region', { name: 'Month by month' })
    expect(sec.textContent).toContain('Sep 2026')
    expect(sec.textContent).toMatch(/\+\$[\d,]+ new/)
  })
  it('no line without subscriptions', async () => {
    start(new MockApi(), '#/?d=company:e_acme')
    await screen.findByRole('region', { name: 'Cash & accounts' })
    expect(screen.queryByText(/^MRR /)).toBeNull()
  })
})
