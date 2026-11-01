// @vitest-environment happy-dom
// After Plaid says yes, finishing takes seconds: the drawer says it's connecting and offers no second Connect.
import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { describe, expect, it, vi } from 'vitest'
import { HttpError } from '../api/http.ts'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'

const preloads = vi.hoisted(() => ({ n: 0 }))
vi.mock('../lib/plaid.ts', async (orig) => ({ ...(await orig<typeof import('../lib/plaid.ts')>()), openPlaidLink: async () => ({ publicToken: 'public-x', metadata: {} }), preloadPlaid: () => void preloads.n++ }))

describe('Connecting a bank', () => {
  it('shows "Connecting your bank…" with no button until the accounts arrive', async () => {
    const api = new MockApi({ empty: true })
    // A real (non-demo) server: Plaid opens, and finishing waits on the network.
    Object.defineProperty(api, 'simulated', { value: false })
    api.s.me.demo = false
    let release: () => void = () => {}
    const base = api.finishConnect.bind(api)
    api.finishConnect = (key, body) => new Promise((r) => (release = () => r(base(key, body))))
    location.hash = '#/'
    render(html`<${Root} api=${api} />`)
    fireEvent.input(await screen.findByLabelText('Company name'), { target: { value: 'Acme Inc' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click((await screen.findAllByRole('button', { name: 'Connect' }))[0]!)
    fireEvent.click(await screen.findByRole('button', { name: 'Choose your bank' }))
    expect((await screen.findByText(/Connecting your bank…/)).getAttribute('aria-busy')).toBe('true')
    expect(screen.queryByRole('button', { name: 'Choose your bank' })).toBeNull()
    release()
    await screen.findByRole('heading', { name: 'Which company is each account?' })
  })
})

describe('Opening one connector', () => {
  it('a link to one connector waits quietly for the list (no "More connections" flash)', async () => {
    const api = new MockApi()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const base = api.connectors.bind(api)
    api.connectors = async () => (await gate, base())
    location.hash = '#/?d=connect:plaid'
    render(html`<${Root} api=${api} />`)
    await screen.findByText('One moment…')
    expect(screen.queryByRole('heading', { name: 'More connections' })).toBeNull()
    release()
    await waitFor(() => expect(screen.queryByText('One moment…')).toBeNull())
    expect(screen.queryByRole('heading', { name: 'More connections' })).toBeNull()
  })

  it('loads Plaid when the drawer opens, and the button says "Opening…" (once) while it starts', async () => {
    const api = new MockApi({ empty: true })
    Object.defineProperty(api, 'simulated', { value: false })
    api.s.me.demo = false
    let release: () => void = () => {}
    let starts = 0
    const base = api.startConnect.bind(api)
    const gate = new Promise<void>((r) => (release = r))
    api.startConnect = (async (...a: Parameters<typeof api.startConnect>) => (starts++, await gate, base(...a))) as typeof api.startConnect
    location.hash = '#/'
    render(html`<${Root} api=${api} />`)
    fireEvent.input(await screen.findByLabelText('Company name'), { target: { value: 'Acme Inc' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    const before = preloads.n
    fireEvent.click((await screen.findAllByRole('button', { name: 'Connect' }))[0]!)
    fireEvent.click(await screen.findByRole('button', { name: 'Choose your bank' }))
    expect(preloads.n).toBeGreaterThan(before)
    const opening = await screen.findByRole('button', { name: 'Opening…' })
    expect(opening.hasAttribute('disabled')).toBe(true)
    fireEvent.click(opening)
    expect(starts).toBe(1)
    release()
    await screen.findByText(/Connecting your bank…/)
  })

  it('Statement files go straight to the upload (nothing to sign in to)', async () => {
    location.hash = '#/?d=connect'
    render(html`<${Root} api=${new MockApi()} />`)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Statement or CSV' }))
    await screen.findByRole('heading', { name: 'Upload a file' })
    expect(screen.queryByText('Aggregate only reads. It can’t move money.')).toBeNull()
  })

  it('a connector the server marks beta says so, in the list and in its drawer', async () => {
    const api = new MockApi()
    const all = api.connectors.bind(api)
    api.connectors = async () => (await all()).map((c) => (c.key === 'mercury' ? { ...c, beta: true } : c))
    location.hash = '#/?d=connect'
    render(html`<${Root} api=${api} />`)
    await screen.findByRole('button', { name: 'Connect Mercury' })
    expect(screen.getAllByText('Beta')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Connect Mercury' }))
    await screen.findByText(/Built to Mercury’s documentation; not yet tried with a real account/)
    expect(screen.getByText(/If a number looks off, tell us at/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'support@aggregate.finance' }).getAttribute('href')).toBe('mailto:support@aggregate.finance?subject=Mercury%20(beta)')
  })
})

describe('Connecting an investor portfolio (Wefunder)', () => {
  it('starts on Personal, even from a company page, and can be changed before continuing', async () => {
    const api = new MockApi()
    const all = api.connectors.bind(api)
    api.connectors = async () => [...(await all()), { key: 'wefunder', name: 'Wefunder', group: 'equity', provides: ['equity'], freshness: 'syncs daily', auth: 'oauth' } as never]
    const asked: Array<string | null> = []
    api.startConnect = (async (_key: string, entityId: string | null) => (asked.push(entityId), { kind: 'api_key', label: 'x', helpUrl: '', placeholder: '', state: 's' })) as never
    const company = api.s.entities.find((e) => e.kind === 'company')!
    const personal = api.s.entities.find((e) => e.kind === 'personal')!
    location.hash = `#/?d=connect:wefunder&scope=${company.id}`
    render(html`<${Root} api=${api} />`)
    const pick = (await screen.findByLabelText('Whose investments?')) as HTMLSelectElement
    expect(pick.value).toBe(personal.id)
    expect(screen.getByRole('option', { name: 'Personal (mine)' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Continue to Wefunder' }))
    await waitFor(() => expect(asked).toEqual([personal.id]))
  })
})

/** One company, so the drawer doesn't first ask which one. */
const oneCompany = (api: MockApi) => {
  const first = api.s.entities.find((e) => e.kind === 'company')
  api.s.entities = api.s.entities.filter((e) => e.kind !== 'company' || e === first)
}

describe('Connecting something with no bank accounts', () => {
  it('a pasted key that brings no accounts skips "Which company is each account?" and says it connected', async () => {
    const api = new MockApi()
    const base = api.finishConnect.bind(api)
    api.finishConnect = async (key, body) => ({ ...(await base(key, body)), accounts: [] })
    oneCompany(api)
    location.hash = '#/?d=connect:mercury'
    render(html`<${Root} api=${api} />`)
    fireEvent.click(await screen.findByRole('button', { name: 'Continue to Mercury' }))
    fireEvent.input(await screen.findByPlaceholderText('token_…'), { target: { value: 'token_x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByText('Mercury connected. Pulling 24 months of history; about a minute.')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Which company is each account?' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Connect Mercury' })).toBeNull()
  })

  it('accounts that do come back still ask which company', async () => {
    const api = new MockApi()
    oneCompany(api)
    location.hash = '#/?d=connect:mercury'
    render(html`<${Root} api=${api} />`)
    fireEvent.click(await screen.findByRole('button', { name: 'Continue to Mercury' }))
    fireEvent.input(await screen.findByPlaceholderText('token_…'), { target: { value: 'token_x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await screen.findByRole('heading', { name: 'Which company is each account?' })
  })
})

describe('Mercury’s required wording', () => {
  it('Connect Mercury shows "Powered by Mercury", the not-a-bank disclosure and a mercury.com link', async () => {
    const api = new MockApi()
    oneCompany(api)
    location.hash = '#/?d=connect:mercury'
    render(html`<${Root} api=${api} />`)
    await screen.findByRole('heading', { name: 'Connect Mercury' })
    expect(screen.getByText(/Powered by Mercury\. Mercury is a fintech company, not an FDIC-insured bank\./)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'mercury.com ↗' }).getAttribute('href')).toBe('https://mercury.com')
  })

  it('a Mercury connection in the list carries Mercury’s mark, not a letter (its design review)', async () => {
    const api = new MockApi()
    oneCompany(api)
    api.s.connections.push({ id: 'c_mercury', connectorKey: 'mercury', name: 'Mercury', entityNames: ['Acme'], status: 'ok', lastSyncAt: new Date().toISOString(), accountCount: 1 } as never)
    location.hash = '#/'
    render(html`<${Root} api=${api} />`)
    await screen.findAllByText(/^Mercury/)
    const tiles = document.querySelectorAll('.tile.brand-mercury')
    expect(tiles.length).toBeGreaterThan(0)
    expect(tiles[0]?.textContent).toBe('')
  })
})

describe('An expired email check', () => {
  it('"Continue to …" that comes back 403 recheck returns to the confirm step, with a line saying why', async () => {
    const api = new MockApi()
    // Confirmed a while ago in this tab, so the drawer goes straight to "Continue to …"; the server says it expired.
    sessionStorage.setItem('agfn.rechecked', String(Date.now()))
    api.startConnect = (() => Promise.reject(new HttpError(403, 'Confirm it’s you first.', 'recheck', { method: 'email' }))) as typeof api.startConnect
    oneCompany(api)
    location.hash = '#/?d=connect:mercury'
    render(html`<${Root} api=${api} />`)
    fireEvent.click(await screen.findByRole('button', { name: 'Continue to Mercury' }))
    expect((await screen.findByRole('alert')).textContent).toBe('That check expired. Confirm it’s you again.')
    expect(screen.getByRole('button', { name: 'Use email instead' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Continue to Mercury' })).toBeNull()
    expect(sessionStorage.getItem('agfn.rechecked')).toBeNull()
  })

  it('after confirming by code, an expired check also goes back (not a dead "Continue to …")', async () => {
    const api = new MockApi()
    // No passkey: the drawer asks for the emailed check first.
    api.s.prefs.signIn.passkeys = []
    api.s.prefs.signIn.noRecheck = false
    let expired = false
    const base = api.startConnect.bind(api)
    api.startConnect = ((...a: Parameters<typeof api.startConnect>) => (expired ? Promise.reject(new HttpError(403, 'Confirm it’s you first.', 'recheck', { method: 'email' })) : base(...a))) as typeof api.startConnect
    oneCompany(api)
    location.hash = '#/?d=connect:mercury'
    render(html`<${Root} api=${api} />`)
    fireEvent.click(await screen.findByRole('button', { name: 'Use email instead' }))
    fireEvent.input(await screen.findByLabelText('Or type the code from the email'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use code' }))
    await screen.findByText('Confirmed. It’s you.')
    expired = true
    fireEvent.click(screen.getByRole('button', { name: 'Continue to Mercury' }))
    expect((await screen.findByRole('alert')).textContent).toBe('That check expired. Confirm it’s you again.')
    expect(screen.getByRole('button', { name: 'Use email instead' })).toBeTruthy()
  })
})

describe('Connect drawer wording', () => {
  it('says how often it updates in a whole sentence, and Plaid reads "Connect your bank or card"', async () => {
    const api = new MockApi()
    oneCompany(api)
    location.hash = '#/?d=connect:mercury'
    const v = render(html`<${Root} api=${api} />`)
    expect(await screen.findByText('Aggregate will read balances, transactions. It updates hourly.')).toBeTruthy()
    v.unmount()
    location.hash = '#/?d=connect:plaid'
    render(html`<${Root} api=${new MockApi()} />`)
    expect(await screen.findByRole('heading', { name: 'Connect your bank or card' })).toBeTruthy()
  })
})

describe('Reconnect and duplicate nits (43, staging v149)', () => {
  it('a refused second copy shows only the server’s sentence and "Open it", not the identity check again', async () => {
    const api = new MockApi()
    api.s.prefs.signIn.passkeys = []
    api.s.prefs.signIn.noRecheck = false
    let dup = false
    const base = api.startConnect.bind(api)
    api.startConnect = ((...a: Parameters<typeof api.startConnect>) => (dup ? Promise.reject(new HttpError(409, 'Mercury is already connected. Open it under Connections.', 'duplicate', { connectionId: 'c_mercury' })) : base(...a))) as typeof api.startConnect
    oneCompany(api)
    location.hash = '#/?d=connect:mercury'
    render(html`<${Root} api=${api} />`)
    fireEvent.click(await screen.findByRole('button', { name: 'Use email instead' }))
    fireEvent.input(await screen.findByLabelText('Or type the code from the email'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use code' }))
    await screen.findByText('Confirmed. It’s you.')
    dup = true
    fireEvent.click(screen.getByRole('button', { name: 'Continue to Mercury' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Mercury is already connected. Open it under Connections.')
    expect(screen.queryByText('Confirmed. It’s you.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Continue to Mercury' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Use email instead' })).toBeNull()
    expect(screen.queryByText(/Still stuck/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }))
    expect(await screen.findByRole('heading', { name: 'Mercury' })).toBeTruthy()
  })

  it('Reconnect opens the connect drawer on the connection’s own company', async () => {
    const api = new MockApi()
    let company: string | null | undefined
    const base = api.startConnect.bind(api)
    api.startConnect = ((key: string, entityId: string | null) => ((company = entityId), base(key))) as typeof api.startConnect
    location.hash = '#/?d=connection:c_mercury'
    render(html`<${Root} api=${api} />`)
    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }))
    await screen.findByRole('heading', { name: 'Connect Mercury' })
    expect(screen.getByText('For Harbor Coffee')).toBeTruthy()
    expect(location.hash).toMatch(/connect:mercury:e_/)
    expect(screen.queryByRole('combobox')).toBeNull()
    sessionStorage.setItem('agfn.rechecked', String(Date.now()))
    fireEvent.click(screen.getByRole('button', { name: 'Continue to Mercury' }))
    await waitFor(() => expect(company).toBe(api.s.entities.find((e) => e.name === 'Harbor Coffee')!.id))
  })
})
