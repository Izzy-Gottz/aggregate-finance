// @vitest-environment happy-dom
// When Plaid Link closes on a bank that isn't enabled for us yet, the drawer says so plainly (not "Something went wrong").
import { fireEvent, render, screen } from '@testing-library/preact'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import { openPlaidLink, plaidExit, PlaidExitError, savePending } from '../lib/plaid.ts'
import { PLAID_REDIRECT } from './connections.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'

/** A stand-in for Plaid's script: opening Link closes it at once with this error and institution. */
const fakePlaid = (err: { error_type?: string; error_code?: string; display_message?: string | null } | null, bank?: string) => {
  ;(globalThis as { Plaid?: unknown }).Plaid = {
    create: (o: { onExit: (e: unknown, m: unknown) => void }) => ({ open: () => o.onExit(err, { institution: bank ? { name: bank } : null }), destroy: () => {} }),
  }
}
afterEach(() => void delete (globalThis as { Plaid?: unknown }).Plaid)

describe('Plaid exit errors', () => {
  it('a bank not enabled for us yet (registration pending) names the bank and says what happens next', async () => {
    fakePlaid({ error_type: 'INSTITUTION_ERROR', error_code: 'INSTITUTION_REGISTRATION_REQUIRED', display_message: null }, 'Chase')
    const e = await openPlaidLink('link-x').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(PlaidExitError)
    expect((e as PlaidExitError).message).toBe('Chase isn’t available through Plaid for us yet. We’ve asked, and it usually takes up to 2 weeks. Try another bank meanwhile.')
    expect((e as PlaidExitError).kind).toBe('not_yet')
  })

  it('the same for UNAUTHORIZED_INSTITUTION and INSTITUTION_NOT_ENABLED_IN_ENVIRONMENT; a bank that is down reads differently', () => {
    expect(plaidExit({ error_code: 'UNAUTHORIZED_INSTITUTION' }, 'Ally')!.kind).toBe('not_yet')
    expect(plaidExit({ error_code: 'INSTITUTION_NOT_ENABLED_IN_ENVIRONMENT' })!.message).toMatch(/^This bank isn’t available through Plaid for us yet\./)
    expect(plaidExit({ error_code: 'INSTITUTION_DOWN' }, 'Chase')!.message).toBe('Chase isn’t responding right now. Try again later, or try another bank.')
  })

  it('closing Link is not an error; any other error still says something', async () => {
    fakePlaid(null)
    expect(await openPlaidLink('link-x')).toBeNull()
    expect(plaidExit({ error_code: 'INVALID_CREDENTIALS', display_message: null })!.message).toBe('Your bank didn’t connect. Try again, or try another bank.')
    expect(plaidExit({ error_code: 'INVALID_CREDENTIALS', display_message: 'The credentials were not correct.' })!.message).toBe('The credentials were not correct.')
  })

  it('in the connect drawer: a plain line above "Choose your bank", which still works', async () => {
    fakePlaid({ error_type: 'INSTITUTION_ERROR', error_code: 'INSTITUTION_REGISTRATION_REQUIRED', display_message: null }, 'Chase')
    const api = new MockApi({ empty: true })
    Object.defineProperty(api, 'simulated', { value: false })
    api.s.me.demo = false
    await api.createCompany('Acme Inc')
    location.hash = `#/?d=connect:plaid`
    render(html`<${Root} api=${api} />`)
    fireEvent.click(await screen.findByRole('button', { name: 'Choose your bank' }))
    const line = await screen.findByText('Chase isn’t available through Plaid for us yet. We’ve asked, and it usually takes up to 2 weeks. Try another bank meanwhile.')
    expect(line.getAttribute('role')).toBe('status')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Choose your bank' })).toBeTruthy()
  })
})

describe('Brokerage-only logins and Link events', () => {
  it('NO_ACCOUNTS on a new connect asks once more with investments first, and finishes with that token', async () => {
    let opens = 0
    ;(globalThis as { Plaid?: unknown }).Plaid = {
      create: (o: { token: string; onExit: (e: unknown, m: unknown) => void; onSuccess: (t: string, m: unknown) => void }) => ({
        open: () => (opens++ === 0 ? o.onExit({ error_type: 'ITEM_ERROR', error_code: 'NO_ACCOUNTS', display_message: null }, { institution: { name: 'Fidelity' } }) : o.onSuccess(`public-for-${o.token}`, { institution: { name: 'Fidelity' } })),
        destroy: () => {},
      }),
    }
    const api = new MockApi({ empty: true })
    Object.defineProperty(api, 'simulated', { value: false })
    api.s.me.demo = false
    await api.createCompany('Acme Inc')
    const starts: Array<{ investmentsFirst?: boolean } | undefined> = []
    const base = api.startConnect.bind(api)
    api.startConnect = ((key: string, _e: string | null, _r?: string, opts?: { investmentsFirst?: boolean }) => (starts.push(opts), base(key).then((s) => (s.kind === 'plaid_link' ? { ...s, linkToken: opts?.investmentsFirst ? 'link-inv' : 'link-1', state: opts?.investmentsFirst ? 'st-inv' : 'st-1' } : s)))) as typeof api.startConnect
    location.hash = '#/?d=connect:plaid'
    render(html`<${Root} api=${api} />`)
    fireEvent.click(await screen.findByRole('button', { name: 'Choose your bank' }))
    await screen.findByRole('heading', { name: 'Which company is each account?' })
    expect(starts).toEqual([undefined, { investmentsFirst: true }])
    expect(opens).toBe(2)
    expect(api.lastFinish).toMatchObject({ state: 'st-inv', publicToken: 'public-for-link-inv' })
  })

  it('only one retry: NO_ACCOUNTS again says so instead of looping', async () => {
    fakePlaid({ error_type: 'ITEM_ERROR', error_code: 'NO_ACCOUNTS', display_message: null }, 'Fidelity')
    const api = new MockApi({ empty: true })
    Object.defineProperty(api, 'simulated', { value: false })
    api.s.me.demo = false
    await api.createCompany('Acme Inc')
    let n = 0
    const base = api.startConnect.bind(api)
    api.startConnect = ((key: string) => (n++, base(key))) as typeof api.startConnect
    location.hash = '#/?d=connect:plaid'
    render(html`<${Root} api=${api} />`)
    fireEvent.click(await screen.findByRole('button', { name: 'Choose your bank' }))
    expect(await screen.findByText('Your bank didn’t connect. Try again, or try another bank.')).toBeTruthy()
    expect(n).toBe(2)
  })

  it('Link events log the institution from onEvent’s flat metadata', async () => {
    const events: Array<{ event: string; institutionId?: string }> = []
    ;(globalThis as { Plaid?: unknown }).Plaid = {
      create: (o: { onEvent: (n: string, m: unknown) => void; onExit: (e: unknown, m: unknown) => void }) => ({
        open: () => (o.onEvent('SELECT_INSTITUTION', { institution_id: 'ins_3', institution_name: 'Chase' }), o.onExit(null, { institution: { institution_id: 'ins_3' } })),
        destroy: () => {},
      }),
    }
    await openPlaidLink('link-x', undefined, (e) => events.push(e))
    expect(events.map((e) => [e.event, e.institutionId])).toEqual([['SELECT_INSTITUTION', 'ins_3'], ['EXIT', 'ins_3']])
  })

  it('Link’s own NO_ACCOUNTS (an ERROR event, then the person exits) retries too, whatever onExit says', async () => {
    let opens = 0
    ;(globalThis as { Plaid?: unknown }).Plaid = {
      create: (o: { token: string; onEvent: (n: string, m: unknown) => void; onExit: (e: unknown, m: unknown) => void; onSuccess: (t: string, m: unknown) => void }) => ({
        open: () => (opens++ === 0 ? (o.onEvent('ERROR', { error_type: 'ITEM_ERROR', error_code: 'NO_ACCOUNTS' }), o.onExit(null, { institution: { name: 'Fidelity' } })) : o.onSuccess(`public-for-${o.token}`, {})),
        destroy: () => {},
      }),
    }
    const api = new MockApi({ empty: true })
    Object.defineProperty(api, 'simulated', { value: false })
    api.s.me.demo = false
    await api.createCompany('Acme Inc')
    const base = api.startConnect.bind(api)
    api.startConnect = ((key: string, _e: string | null, _r?: string, opts?: { investmentsFirst?: boolean }) => base(key).then((s) => (s.kind === 'plaid_link' ? { ...s, linkToken: opts?.investmentsFirst ? 'link-inv' : 'link-1', state: opts?.investmentsFirst ? 'st-inv' : 'st-1' } : s))) as typeof api.startConnect
    location.hash = '#/?d=connect:plaid'
    render(html`<${Root} api=${api} />`)
    fireEvent.click(await screen.findByRole('button', { name: 'Choose your bank' }))
    await screen.findByRole('heading', { name: 'Which company is each account?' })
    expect(api.lastFinish).toMatchObject({ state: 'st-inv', publicToken: 'public-for-link-inv' })
  })

  it('an ERROR event that arrives after onExit (Link sends most events at session end) still counts', async () => {
    ;(globalThis as { Plaid?: unknown }).Plaid = {
      create: (o: { onEvent: (n: string, m: unknown) => void; onExit: (e: unknown, m: unknown) => void }) => ({
        open: () => (o.onExit(null, {}), o.onEvent('ERROR', { error_code: 'NO_ACCOUNTS' }), o.onEvent('EXIT', {})),
        destroy: () => {},
      }),
    }
    const e = await openPlaidLink('link-x', undefined, undefined, { noAccounts: true }).catch((x: unknown) => x)
    expect((e as PlaidExitError).code).toBe('NO_ACCOUNTS')
    // Without the option (reconnects), closing is still just closing.
    expect(await openPlaidLink('link-x')).toBeNull()
  })

  it('back from an OAuth brokerage: the same single retry with investments first, for the same company', async () => {
    let opens = 0
    const tokens: string[] = []
    ;(globalThis as { Plaid?: unknown }).Plaid = {
      create: (o: { token: string; onExit: (e: unknown, m: unknown) => void; onSuccess: (t: string, m: unknown) => void }) => ({
        open: () => (tokens.push(o.token), opens++ === 0 ? o.onExit({ error_type: 'ITEM_ERROR', error_code: 'NO_ACCOUNTS', display_message: null }, {}) : o.onSuccess(`public-for-${o.token}`, {})),
        destroy: () => {},
      }),
    }
    const api = new MockApi({ empty: true })
    Object.defineProperty(api, 'simulated', { value: false })
    api.s.me.demo = false
    const co = await api.createCompany('Acme Inc')
    const coId = (co as { id: string }).id
    const starts: unknown[] = []
    const base = api.startConnect.bind(api)
    api.startConnect = ((key: string, entityId: string | null, _r?: string, opts?: { investmentsFirst?: boolean }) => (starts.push([entityId, opts]), base(key).then((s) => (s.kind === 'plaid_link' ? { ...s, linkToken: 'link-inv', state: 'st-inv' } : s)))) as typeof api.startConnect
    savePending({ mode: 'connect', connectorKey: 'plaid', linkToken: 'link-1', state: 'st-1', returnTo: '/', entityId: coId })
    sessionStorage.setItem(PLAID_REDIRECT, 'https://app.test/connect/plaid/oauth?oauth_state_id=x')
    location.hash = '#/?d=plaid-return'
    render(html`<${Root} api=${api} />`)
    await screen.findByRole('heading', { name: 'Which company is each account?' })
    expect(tokens).toEqual(['link-1', 'link-inv'])
    expect(starts).toEqual([[coId, { investmentsFirst: true }]])
    expect(api.lastFinish).toMatchObject({ state: 'st-inv', publicToken: 'public-for-link-inv' })
  })

  it('back from an OAuth bank after the retry already ran: no second round', async () => {
    fakePlaid({ error_type: 'ITEM_ERROR', error_code: 'NO_ACCOUNTS', display_message: null })
    const api = new MockApi({ empty: true })
    Object.defineProperty(api, 'simulated', { value: false })
    api.s.me.demo = false
    await api.createCompany('Acme Inc')
    let n = 0
    const base = api.startConnect.bind(api)
    api.startConnect = ((key: string) => (n++, base(key))) as typeof api.startConnect
    savePending({ mode: 'connect', connectorKey: 'plaid', linkToken: 'link-inv', state: 'st-inv', returnTo: '/', entityId: null, retried: true })
    sessionStorage.setItem(PLAID_REDIRECT, 'https://app.test/connect/plaid/oauth?oauth_state_id=x')
    location.hash = '#/?d=plaid-return'
    render(html`<${Root} api=${api} />`)
    expect(await screen.findByRole('heading', { name: 'Your bank didn’t connect' })).toBeTruthy()
    expect(n).toBe(0)
  })
})
