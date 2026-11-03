// @vitest-environment happy-dom
// End-to-end flows through the real Root, against the in-memory MockApi.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact'
import { describe, expect, it, vi } from 'vitest'
import { HttpError } from '../api/http.ts'
import { MockApi } from '../api/mock.ts'
import '../test/setup.ts'
import { tick } from '../test/setup.ts'
import { html } from '../ui/html.ts'
import { Root } from './app.ts'
import { forgetUnsavedKey } from '../screens/ai.ts'

const start = (api: AgfnApiLike, hash = '#/') => {
  location.hash = hash
  return render(html`<${Root} api=${api} />`)
}
type AgfnApiLike = MockApi
const typeInto = (el: HTMLElement, value: string) => fireEvent.input(el, { target: { value } })
const drawer = () => screen.getByRole('dialog')

describe('signed out', () => {
  it('sign in with an email link lands on the Workspace', async () => {
    const api = new MockApi({ signedIn: false })
    start(api)
    await screen.findByRole('heading', { name: 'Sign in' })
    fireEvent.click(screen.getByRole('button', { name: 'Email me a link' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/email address/)
    typeInto(screen.getByLabelText('Email'), 'me@acme.example')
    fireEvent.click(screen.getByRole('button', { name: 'Email me a link' }))
    await screen.findByRole('region', { name: 'Money' })
    expect(location.hash).toBe('#/')
  })
})

describe('expired links', () => {
  it('an invite link opened late says the invite still stands; a plain sign-in link says to ask for a new one', async () => {
    const at = location.pathname
    try {
      history.replaceState(null, '', `${at}?invite=inv123&error=INVALID_TOKEN`)
      const a = start(new MockApi({ signedIn: false }))
      await screen.findByRole('heading', { name: 'Sign in' })
      expect(await screen.findByText(/That invite link has expired or was already used\. Your invite still stands/)).toBeTruthy()
      a.unmount()
      history.replaceState(null, '', `${at}?error=EXPIRED_TOKEN`)
      start(new MockApi({ signedIn: false }))
      expect(await screen.findByText('That sign-in link has expired or was already used. Enter your email for a new one.')).toBeTruthy()
    } finally {
      history.replaceState(null, '', at)
    }
  })
})

describe('Email code', () => {
  it('the sign-in email’s code, typed in this browser, signs in (for a link opened elsewhere)', async () => {
    const api = new MockApi({ signedIn: false })
    // A real server only emails a link; signing in waits for the link or the code.
    api.signIn = async () => ({ ok: true as const, next: 'check_email' as const })
    start(api)
    typeInto(await screen.findByLabelText('Email'), 'me@acme.example')
    fireEvent.click(screen.getByRole('button', { name: 'Email me a link' }))
    await screen.findByRole('heading', { name: 'Check your email' })
    typeInto(screen.getByLabelText('Or type the code from the email'), '000 000')
    fireEvent.click(screen.getByRole('button', { name: 'Use code' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/isn’t right/)
    typeInto(screen.getByLabelText('Or type the code from the email'), '123 456')
    fireEvent.click(screen.getByRole('button', { name: 'Use code' }))
    await screen.findByRole('region', { name: 'Money' })
  })
})

describe('Reviewer access code', () => {
  it('only while reviewer links are on; a wrong code says so, the right one signs in', async () => {
    const api = new MockApi({ signedIn: false })
    const v = start(api)
    await screen.findByRole('heading', { name: 'Sign in' })
    expect(screen.queryByRole('button', { name: 'Reviewer? Use an access code' })).toBeNull()
    v.unmount()
    api.signInMethods = async () => ['passkey', 'email', 'reviewer']
    start(api)
    fireEvent.click(await screen.findByRole('button', { name: 'Reviewer? Use an access code' }))
    typeInto(screen.getByLabelText('Access code'), 'nope')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/isn’t valid/)
    typeInto(screen.getByLabelText('Access code'), 'https://app.aggregate.finance/review/rev-123')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByRole('region', { name: 'Money' })
  })

  it('a reviewer email asks for a password (the access code) instead of emailing a link', async () => {
    const api = new MockApi({ signedIn: false })
    api.signInMethods = async () => ['passkey', 'email', 'reviewer']
    let emailed = false
    api.signIn = async () => ((emailed = true), { ok: true as const, next: 'check_email' as const })
    start(api)
    await screen.findByRole('heading', { name: 'Sign in' })
    expect(screen.queryByLabelText('Password')).toBeNull()
    await screen.findByRole('button', { name: 'Reviewer? Use an access code' }) // the server's sign-in methods are in
    typeInto(screen.getByLabelText('Email'), 'reviewer-1@reviewers.aggregate.invalid')
    typeInto(await screen.findByLabelText('Password'), 'wrong')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/don’t match/)
    typeInto(screen.getByLabelText('Password'), 'rev-123')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByRole('region', { name: 'Money' })
    expect(emailed).toBe(false)
  })

  it('without reviewer links on, a reviewer-looking email is just an email', async () => {
    const api = new MockApi({ signedIn: false })
    start(api)
    await screen.findByRole('heading', { name: 'Sign in' })
    typeInto(screen.getByLabelText('Email'), 'reviewer-1@reviewers.aggregate.invalid')
    expect(screen.queryByLabelText('Password')).toBeNull()
    expect(screen.getByRole('button', { name: 'Email me a link' })).toBeTruthy()
  })

  it('works on the sign-in page inside an AI’s OAuth window, then shows the consent', async () => {
    const api = new MockApi({ signedIn: false })
    api.signInMethods = async () => ['passkey', 'email', 'reviewer']
    // Better Auth sends a signed-out AI login here, with its signed query. The consent page differs only in the hash, so the
    // page must load fresh at it (in memory the app is still signed out and would bounce back to sign-in).
    const went: string[] = []
    const real = { replace: window.location.replace, reload: window.location.reload, assign: window.location.assign }
    for (const k of ['replace', 'assign'] as const) Object.defineProperty(window.location, k, { configurable: true, value: (u: string) => went.push(`${k} ${u}`) })
    Object.defineProperty(window.location, 'reload', { configurable: true, value: () => went.push('reload') })
    try {
      start(api, '#/sign-in?client_id=claude&scope=read&exp=1&sig=abc')
      fireEvent.click(await screen.findByRole('button', { name: 'Reviewer? Use an access code' }))
      typeInto(screen.getByLabelText('Access code'), 'rev-123')
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
      await waitFor(() => expect(went).toEqual([`replace ${location.origin}/#/connect-ai/consent?client_id=claude&scope=read&exp=1&sig=abc`, 'reload']))
    } finally {
      for (const k of ['replace', 'reload', 'assign'] as const) Object.defineProperty(window.location, k, { configurable: true, value: real[k] })
    }
  })
})

describe('Signing out and back in', () => {
  it('log out says you’re signed out (not that the session ran out); a different email starts empty', async () => {
    const api = new MockApi()
    ;(api.s.me as { demo: boolean }).demo = false
    start(api)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Log out' }))[0]!)
    await screen.findByRole('heading', { name: 'Sign in' })
    expect(screen.getByText('You’re signed out.')).toBeTruthy()
    expect(screen.queryByText(/You were signed out/)).toBeNull()
  })

  it('a spent code offers a new email, and says when it went', async () => {
    const api = new MockApi({ signedIn: false })
    api.signIn = async () => ({ ok: true as const, next: 'check_email' as const })
    api.signInCode = async () => {
      throw new HttpError(410, 'That sign-in was already used or has expired. Ask for a new email.', 'no_code')
    }
    start(api)
    typeInto(await screen.findByLabelText('Email'), 'me@acme.example')
    fireEvent.click(screen.getByRole('button', { name: 'Email me a link' }))
    typeInto(await screen.findByLabelText('Or type the code from the email'), '123456')
    fireEvent.click(screen.getByRole('button', { name: 'Use code' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Send a new email' }))
    await screen.findByText('A new email is on its way, with a new code.')
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Use a different email' }))
    expect((await screen.findByLabelText('Email') as HTMLInputElement).value).toBe('')
  })
})

describe('onboarding', () => {
  it('no Plaid or Stripe on this server: SimpleFIN Bridge and a statement, "coming soon", Payments is Square alone', async () => {
    const api = new MockApi({ empty: true })
    const all = api.connectors.bind(api)
    api.connectors = async () => (await all()).filter((c) => c.key !== 'plaid' && c.key !== 'stripe')
    start(api)
    typeInto(await screen.findByLabelText('Company name'), 'Acme Inc')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Connect your money' })
    await screen.findByText('For daily updates (SimpleFIN, $1.50/mo)')
    // A statement first (quickest), SimpleFIN second for daily updates. Plaid is a plain line, never a button.
    const rowNames = [...document.querySelectorAll('.rows.wrap .row .name')].map((n) => n.textContent)
    expect(rowNames.slice(0, 2)).toEqual(['Upload a statement', 'Bank or card'])
    expect(screen.getByText('CSV, OFX, QFX, QBO or PDF')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy()
    expect(screen.getByText('Bank connections via Plaid: coming soon.')).toBeTruthy()
    expect(screen.queryByText(/through Plaid/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stripe' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Square' })).toBeTruthy()
    // "More: …" names only what's offered.
    expect(screen.getByRole('button', { name: /^More: Shopify, Mercury/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
    await screen.findByRole('heading', { name: 'Upload a file' })
  })

  it('signed in a while ago: Allow asks for a quick check right on the page, then connects with the AI’s request intact', async () => {
    const api = new MockApi()
    let checked = false
    const queries: string[] = []
    const consent = api.consent.bind(api)
    api.consent = (async (i: Parameters<typeof api.consent>[0]) => {
      queries.push((i as { oauthQuery?: string }).oauthQuery ?? '')
      if (!checked) throw new HttpError(403, 'That needs a quick check that it’s you.', 'recheck', { method: 'email', fallback: 'email' })
      return consent(i)
    }) as typeof api.consent
    const code = api.recheckCode.bind(api)
    api.recheckCode = async (c: string) => ((checked = true), code(c))
    // Back from an emailed link, the page carries rechecked=1: it never reaches the AI's (signed) request.
    start(api, '#/connect-ai/consent?client_id=claude&scope=read&exp=1&sig=abc&rechecked=1')
    fireEvent.click(await screen.findByRole('button', { name: 'Allow' }))
    await screen.findByRole('heading', { name: 'First, a quick check that it’s you' })
    expect(screen.queryByRole('heading', { name: 'Done' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Don’t allow' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Email me a code' }))
    typeInto(await screen.findByLabelText('Or type the code from the email'), '123456')
    fireEvent.click(screen.getByRole('button', { name: 'Use code' }))
    await screen.findByText(/Claude is connected/)
    expect(queries).toEqual(['client_id=claude&scope=read&exp=1&sig=abc', 'client_id=claude&scope=read&exp=1&sig=abc'])
  })

  for (const [method, passkeyButton] of [['email', false], ['passkey', true]] as const) {
    it(`the quick check on consent, in a browser that has passkeys: ${method === 'email' ? 'an email-only account gets only the code' : 'an account with a passkey may use it'}`, async () => {
      // happy-dom has PublicKeyCredential; only the secure context is missing.
      const had = Object.getOwnPropertyDescriptor(window, 'isSecureContext')
      Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
      try {
        const api = new MockApi()
        api.consent = (async () => {
          throw new HttpError(403, 'That needs a quick check that it’s you.', 'recheck', { method, fallback: 'email' })
        }) as typeof api.consent
        start(api, '#/connect-ai/consent?client_id=claude&scope=read')
        fireEvent.click(await screen.findByRole('button', { name: 'Allow' }))
        await screen.findByRole('heading', { name: 'First, a quick check that it’s you' })
        expect(!!screen.queryByRole('button', { name: 'Use a passkey' })).toBe(passkeyButton)
        expect(screen.getByRole('button', { name: 'Email me a code' })).toBeTruthy()
      } finally {
        if (had) Object.defineProperty(window, 'isSecureContext', had)
        else delete (window as { isSecureContext?: boolean }).isSecureContext
      }
    })
  }

  it('a reviewer demo account (method signin): no passkey, no email, a "Sign in again" that comes back to this consent', async () => {
    const api = new MockApi()
    let signedOut = false
    api.signOut = async () => void (signedOut = true)
    api.consent = (async () => {
      throw new HttpError(403, 'In the reviewer demo, a fresh sign-in with your access code is the check, and only for connecting an AI. Sign in again, then connect.', 'recheck', { method: 'signin', fallback: 'email' })
    }) as typeof api.consent
    const went: string[] = []
    const real = { replace: window.location.replace, reload: window.location.reload }
    Object.defineProperty(window.location, 'replace', { configurable: true, value: (u: string) => went.push(`replace ${u}`) })
    Object.defineProperty(window.location, 'reload', { configurable: true, value: () => went.push('reload') })
    try {
      start(api, '#/connect-ai/consent?client_id=claude&scope=read&exp=1&sig=abc')
      fireEvent.click(await screen.findByRole('button', { name: 'Allow' }))
      await screen.findByRole('heading', { name: 'First, sign in again' })
      expect(screen.getByText(/a fresh sign-in with your access code is the check/)).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Email me a code' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Use a passkey' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
      await waitFor(() => expect(went).toEqual([`replace ${location.pathname}#/sign-in?client_id=claude&scope=read&exp=1&sig=abc`, 'reload']))
      expect(signedOut).toBe(true)
    } finally {
      for (const k of ['replace', 'reload'] as const) Object.defineProperty(window.location, k, { configurable: true, value: real[k] })
    }
  })

  it('a brand-new account sent by an AI: company name, then straight back to its consent, then Allow', async () => {
    sessionStorage.clear()
    const api = new MockApi({ empty: true })
    start(api, '#/connect-ai/consent?client_id=claude&scope=read&consent_code=c1')
    // No workspace yet: setup asks for the company first, keeping the AI's authorization.
    await screen.findByRole('heading', { name: 'What’s your company called?' })
    typeInto(screen.getByLabelText('Company name'), 'Acme Inc')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: /Connect “Claude”\?/ })
    expect(location.hash).toBe('#/connect-ai/consent?client_id=claude&scope=read&consent_code=c1')
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    await screen.findByText(/Claude is connected/)
    // Resumed once only: the next visit to setup or the Workspace doesn't bounce back to the consent.
    expect(sessionStorage.getItem('agfn.pending-consent')).toBeNull()
  })

  it('a brand-new account sent by an AI that picks "Just my own money" also returns to the consent', async () => {
    sessionStorage.clear()
    const api = new MockApi({ empty: true })
    start(api, '#/connect-ai/consent?client_id=claude&scope=read&consent_code=c1')
    await screen.findByRole('heading', { name: 'What’s your company called?' })
    fireEvent.click(screen.getByRole('button', { name: 'No company? Just my own money' }))
    await screen.findByRole('heading', { name: /Connect “Claude”\?/ })
  })

  it('company → connect a bank → which company → AI link → first question', async () => {
    const api = new MockApi({ empty: true })
    start(api)
    await screen.findByRole('heading', { name: 'What’s your company called?' })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/What’s it called/)
    typeInto(screen.getByLabelText('Company name'), 'Acme Inc')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await screen.findByRole('heading', { name: 'Connect your money' })
    await screen.findByText('Bank or card') // the rows follow the server's catalog
    fireEvent.click(screen.getAllByRole('button', { name: 'Connect' })[0]!)
    fireEvent.click(await screen.findByRole('button', { name: 'Choose your bank' }))
    await screen.findByRole('heading', { name: 'Which company is each account?' })
    const personal = screen.getByLabelText('Company for Personal Checking') as HTMLSelectElement
    expect(personal.value).toBe('personal')
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await screen.findByText('Acme Inc, Personal')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await screen.findByRole('heading', { name: 'Connect your AI' })
    expect(screen.getAllByText('https://app.aggregate.finance/mcp').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: /^Claude Code, Codex/ }))
    expect(screen.getByText((_, el) => el?.tagName === 'CODE' && el.textContent === 'claude mcp add --transport http --scope user aggregate https://app.aggregate.finance/mcp')).toBeTruthy()
    // Approving the AI (on the consent page, often another tab) is what moves on: no "I've added it" to click.
    expect(screen.queryByRole('button', { name: 'I’ve added it' })).toBeNull()
    api.s.ais.push({ grantId: 'g_new', client: 'Claude', personName: 'Dana', shape: { entityIds: 'all', dataTypes: ['balances'], write: false, reviewMode: 'instant', expiresAt: null }, lastUsedAt: null, paused: false, connectedAt: new Date().toISOString(), via: 'claude.ai', activity: [] })
    document.dispatchEvent(new Event('visibilitychange'))

    await screen.findByRole('heading', { name: 'Ask it something' })
    expect(screen.getByText('“How much cash do I have?”')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Go to Workspace' }))
    await screen.findByRole('region', { name: 'Money' })
    expect(screen.getByRole('button', { name: /^Acme Inc,/ })).toBeTruthy()
  })
  it('no company: a Personal-only workspace, bank and brokerage, and only the owner sees it', async () => {
    const api = new MockApi({ empty: true })
    start(api)
    fireEvent.click(await screen.findByRole('button', { name: 'No company? Just my own money' }))
    await screen.findByRole('heading', { name: 'Connect your money' })
    await screen.findByText('Bank or card') // the rows follow the server's catalog
    expect(api.s.entities.map((e) => e.kind)).toEqual(['personal'])
    for (const name of ['Bank or card', 'Brokerage']) expect(screen.getByText(name)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'QuickBooks' })).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'Connect' })[0]!)
    fireEvent.click(await screen.findByRole('button', { name: 'Choose your bank' }))
    await screen.findByRole('heading', { name: 'Which accounts should sync?' })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('button', { name: 'Have a company too? Add it' })).toBeTruthy()
  })

  it('"I invest in companies" starts the same Personal-first setup', async () => {
    const api = new MockApi({ empty: true })
    start(api)
    fireEvent.click(await screen.findByRole('button', { name: 'I invest in companies' }))
    await screen.findByRole('heading', { name: 'Connect your money' })
    await screen.findByText('Bank or card') // the rows follow the server's catalog
    expect(api.s.entities.map((e) => e.kind)).toEqual(['personal'])
  })

  it('step 2: books and payments side by side, and more companies added inline', async () => {
    const api = new MockApi({ empty: true })
    start(api)
    typeInto(await screen.findByLabelText('Company name'), 'Acme Inc')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Connect your money' })
    await screen.findByText('Bank or card') // the rows follow the server's catalog
    for (const name of ['QuickBooks', 'Xero', 'Stripe', 'Square']) expect(screen.getByRole('button', { name })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Have more than one company\? Add another/ }))
    typeInto(await screen.findByLabelText('Company name'), 'Bluebird Studio')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await screen.findByText('Bluebird Studio added.')
    expect(api.s.entities.filter((e) => e.kind === 'company').map((e) => e.name)).toEqual(['Acme Inc', 'Bluebird Studio'])
    expect(screen.getByRole('button', { name: 'Add another company' })).toBeTruthy()
  })
})

describe('workspace', () => {
  it('shows the four sections, and Review only when something waits', async () => {
    start(new MockApi())
    for (const name of ['Money', 'Connections', 'Connect your AI', 'Add anything']) await screen.findByRole('region', { name })
    expect(screen.getByRole('link', { name: /Review/ }).textContent).toContain('4')
    expect(screen.getByText('only you see this')).toBeTruthy()
    expect(screen.getByText('Reconnect needed')).toBeTruthy()
  })

  it('Personal: the owner sees their numbers and holdings, and is told only they do', async () => {
    start(new MockApi())
    fireEvent.click(await screen.findByRole('button', { name: /^Personal, only you see this, \$18,904/ }))
    await within(drawer()).findByRole('heading', { name: 'Personal' })
    expect(within(drawer()).getByText('Only you see this.')).toBeTruthy()
    within(drawer()).getByRole('region', { name: 'Holdings' })
    expect(within(drawer()).getByText('$20,407 in 3 positions')).toBeTruthy()
    expect(within(drawer()).getByText('Vanguard Total Stock Market ETF · 42.5 shares · Fidelity ··7730')).toBeTruthy()
    // The brokerage's cash is a position too, without a share count.
    expect(within(drawer()).getAllByText('Fidelity ··7730').length).toBe(1)
  })

  it('an account named like its bank isn’t doubled ("Demo Brokerage", not "Demo Brokerage Brokerage")', async () => {
    const api = new MockApi()
    api.s.companies.e_personal!.accounts.push({ id: 'ps9', name: 'Brokerage', institution: 'Demo Brokerage', mask: '7714', kind: 'investment', balance: { minor: 12_950_000, currency: 'USD' }, asOf: new Date().toISOString(), stale: false })
    start(api, '#/?d=company:e_personal')
    expect(await within(await screen.findByRole('dialog')).findByText('Demo Brokerage ··7714')).toBeTruthy()
  })

  it('Personal: add a stake in a company, and it shows under Buckets', async () => {
    const api = new MockApi()
    start(api, '#/?d=company:e_personal')
    fireEvent.click(await screen.findByRole('button', { name: 'Add a stake in a company' }))
    await screen.findByRole('heading', { name: 'Add a stake' })
    fireEvent.click(screen.getByRole('button', { name: 'Add stake' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Which company?')
    typeInto(screen.getByLabelText('Company'), 'Lumen Health')
    typeInto(screen.getByLabelText('Amount'), '25000')
    typeInto(screen.getByLabelText('Date'), '2026-03-01')
    fireEvent.click(screen.getByRole('button', { name: 'Add stake' }))
    await screen.findByText('Stake in Lumen Health added.')
    await within(drawer()).findByRole('region', { name: 'Buckets' })
    expect(within(drawer()).getByText('Stake in Lumen Health')).toBeTruthy()
    const b = Object.values(api.s.buckets).find((x) => x.name === 'Stake in Lumen Health')!
    expect(b.entityId).toBe('e_personal')
    expect(b.fields.map((f) => f.value)).toEqual(['Lumen Health', 'SAFE', '25000.00 USD', '2026-03-01'])
  })

  it('one suggested connection is a quiet line under the list, never a row that looks like a connection', async () => {
    const api = new MockApi()
    ;(api.s.me as { demo: boolean }).demo = false
    start(api)
    const conns = await screen.findByRole('region', { name: 'Connections' })
    const line = await within(conns).findByRole('button', { name: 'QuickBooks for invoices, bills and reports. Connect →' })
    expect(line.closest('ul')).toBeNull()
    expect(within(conns).queryByRole('button', { name: 'Connect QuickBooks' })).toBeNull()
    fireEvent.click(line)
    await screen.findByRole('dialog')
  })

  it('company drawer: sections with data, explain the cash number, a bucket, back and close', async () => {
    start(new MockApi())
    fireEvent.click(await screen.findByRole('button', { name: /^Acme, \$284,410/ }))
    await within(drawer()).findByRole('heading', { name: 'Acme' })
    for (const name of ['Cash & accounts', 'Owed to you', 'Bills & you owe soon', 'Buckets', /^Payroll · [A-Z][a-z]+$/, 'Equity', 'Transactions', 'Whose money', 'Anything odd'])
      expect(within(drawer()).getByRole('region', { name })).toBeTruthy()

    fireEvent.click(within(drawer()).getByRole('button', { name: /How this is worked out/ }))
    await within(drawer()).findByRole('region', { name: 'How this is worked out' })
    expect(within(drawer()).getByText(/Cards and loans are not cash/)).toBeTruthy()
    expect(within(drawer()).getByText('card balance (money owed, not cash)')).toBeTruthy()
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Acme' }))

    fireEvent.click(await within(drawer()).findByRole('button', { name: /Rent/ }))
    await within(drawer()).findByRole('heading', { name: 'Rent' })
    expect(within(drawer()).getByText('Bank payments to WEWORK → here')).toBeTruthy()
    expect(within(drawer()).getByText(/Created by Claude/)).toBeTruthy()
    expect(location.hash).toBe('#/?d=company:e_acme/bucket:b_rent')

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(location.hash).toBe('#/')
  })

  it('a company with little data shows only what it has', async () => {
    start(new MockApi(), '#/?d=company:e_cla')
    await within(await screen.findByRole('dialog')).findByRole('heading', { name: 'Harbor Coffee' })
    await within(drawer()).findByText('Mercury needs you to sign in again')
    expect(within(drawer()).queryByRole('region', { name: /^Payroll/ })).toBeNull()
    expect(within(drawer()).queryByRole('region', { name: 'Equity' })).toBeNull()
    expect(await within(drawer()).findByText('Mercury needs you to sign in again')).toBeTruthy()
  })

  it('search transactions inside a company', async () => {
    start(new MockApi(), '#/?d=company:e_acme')
    const box = await within(await screen.findByRole('dialog')).findByLabelText('Search transactions')
    typeInto(box, 'wework')
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Transactions' })).getAllByRole('listitem')).toHaveLength(1))
    typeInto(box, 'zzzz')
    await within(drawer()).findByText(/Nothing called “zzzz”/)
  })

  it('switching company narrows the page', async () => {
    start(new MockApi())
    fireEvent.click((await screen.findAllByRole('button', { name: /All companies/ }))[0]!)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Bluebird Studio' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Acme,/ })).toBeNull())
    expect(screen.getByRole('button', { name: /^Bluebird Studio,/ })).toBeTruthy()
  })
})

describe('add anything', () => {
  it('adds cash, then undo from the toast', async () => {
    const api = new MockApi()
    start(api, '#/?d=add:cash')
    const d = await screen.findByRole('dialog')
    fireEvent.click(within(d).getByRole('button', { name: 'Add' }))
    expect((await within(d).findByRole('alert')).textContent).toMatch(/Enter an amount/)
    typeInto(within(d).getByLabelText('Amount'), '1,200')
    typeInto(within(d).getByLabelText('From'), 'Lee’s Deli')
    fireEvent.click(within(d).getByRole('button', { name: 'Add' }))
    const toast = await screen.findByRole('status')
    expect(toast.textContent).toContain('Added $1,200 to Acme.')
    const rows = await api.searchTransactions('e_acme', 'Lee’s Deli')
    expect(rows.some((r) => r.amount.minor === 120000 && r.detail === 'added by you')).toBe(true)
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }))
    await tick()
  })

  it('“I paid personally” is offered for money out', async () => {
    start(new MockApi(), '#/?d=add:cash')
    const d = await screen.findByRole('dialog')
    fireEvent.click(within(d).getByRole('button', { name: 'Money out' }))
    fireEvent.click(await within(d).findByRole('button', { name: 'I paid personally' }))
    await within(d).findByText(/The company will owe you this/)
  })

  it('upload refuses unsafe file types and keeps PDFs for your AI', async () => {
    start(new MockApi(), '#/?d=add:upload')
    const d = await screen.findByRole('dialog')
    const input = within(d).getByLabelText('Choose files to upload') as HTMLInputElement
    const exe = new File(['x'], 'run.exe')
    const pdf = new File(['%PDF'], 'Cole LLP.pdf', { type: 'application/pdf' })
    fireEvent.change(input, { target: { files: [exe, pdf] } })
    expect((await within(d).findByRole('alert')).textContent).toMatch(/run.exe isn’t a file Aggregate takes/)
    await within(d).findByText(/Ask your AI to read it/)
  })
})

describe('Connect your AI', () => {
  it('change the control sentence, see activity, undo a write, pause and revoke', async () => {
    const api = new MockApi()
    start(api, '#/?d=ai:g_claude')
    const d = await screen.findByRole('dialog')
    await within(d).findByText(/Claude can see/)
    fireEvent.click(within(d).getByRole('button', { name: 'Can add records' }))
    fireEvent.click(within(d).getByRole('menuitemradio', { name: 'Read only' }))
    await waitFor(() => expect(api.s.ais[0]!.shape.write).toBe(false))
    await within(d).findByText('Read only')

    expect(within(d).getByText('Asked for cash in each company')).toBeTruthy()
    fireEvent.click(within(d).getAllByRole('button', { name: 'Undo' })[0]!)
    await waitFor(() => expect(api.s.ais[0]!.activity.find((a) => a.id === 'a2')!.status).toBe('undone'))

    fireEvent.click(within(d).getByRole('button', { name: 'Pause' }))
    await waitFor(() => expect(api.s.ais[0]!.paused).toBe(true))
    fireEvent.click(within(d).getByRole('button', { name: 'Revoke' }))
    fireEvent.click(within(d).getByRole('button', { name: 'Revoke now' }))
    await waitFor(() => expect(api.s.ais.some((a) => a.grantId === 'g_claude')).toBe(false))
  })

  it('consent page approves with the edited sentence', async () => {
    const api = new MockApi()
    start(api, '#/connect-ai/consent?client_id=claude&scope=read&consent_code=c1')
    await screen.findByRole('heading', { name: 'Connect “Claude”? · unverified name' })
    fireEvent.click(screen.getByRole('button', { name: 'all your companies and your own money' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Harbor Coffee' }))
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    await screen.findByText(/Claude is connected/)
    const g = api.s.ais[api.s.ais.length - 1]!
    expect(g.shape.entityIds).toEqual(['e_acme', 'e_nex', 'e_personal'])
    expect(g.shape.write).toBe(false)
  })

  it('consent: your own Personal is on by default, can be turned off (then nudged), and back on', async () => {
    const api = new MockApi()
    start(api, '#/connect-ai/consent?client_id=claude&scope=read&consent_code=c1')
    await screen.findByRole('heading', { name: 'Connect “Claude”? · unverified name' })
    expect(screen.queryByText(/Your Personal money isn’t included/)).toBeNull()
    // Still a choice: turning it off leaves it out and says what that costs.
    fireEvent.click(screen.getByRole('button', { name: 'all your companies and your own money' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Your own money (Personal)' }))
    fireEvent.click(screen.getByRole('button', { name: 'all your companies' }))
    expect(screen.getByText(/Your Personal money isn’t included, so Claude can’t answer about it/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Include it' }))
    expect(screen.getByRole('button', { name: 'all your companies and your own money' })).toBeTruthy()
    expect(screen.queryByText(/Your Personal money isn’t included/)).toBeNull()
    // Narrowing to some companies keeps Personal in, as its own entity too.
    fireEvent.click(screen.getByRole('button', { name: 'all your companies and your own money' }))
    expect(screen.getByRole('menuitemcheckbox', { name: 'Your own money (Personal)' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Harbor Coffee' }))
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    await screen.findByText(/Claude is connected/)
    const g = api.s.ais[api.s.ais.length - 1]!
    expect(g.shape.dataTypes).toContain('personal')
    expect(g.shape.entityIds).toEqual(['e_acme', 'e_nex', 'e_personal'])
  })

  it('makes a named key for a bot, shown once, and won’t lose it before it’s copied', async () => {
    forgetUnsavedKey()
    const api = new MockApi()
    start(api, '#/?d=connect-ai')
    const d = await screen.findByRole('dialog')
    fireEvent.click(within(d).getByRole('button', { name: 'Make a key' }))
    expect((await within(d).findByRole('alert')).textContent).toMatch(/Name it/)
    typeInto(within(d).getByLabelText('Key name'), 'Invoice bot')
    fireEvent.click(within(d).getByRole('button', { name: 'Make a key' }))
    await within(d).findByText(/^mk_live_/)
    expect(api.s.ais.at(-1)!.client).toBe('Invoice bot')
    expect(within(d).getByText('Shown once. Copy it and store it somewhere safe.')).toBeTruthy()

    // Closing before copying asks first; leaving and coming back still shows the same key.
    fireEvent.click(within(d).getByRole('button', { name: 'Close' }))
    expect((await within(d).findByRole('alert')).textContent).toMatch(/Copy it first/)
    const key = within(d).getByText(/^mk_live_/).textContent
    location.hash = '#/'
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    location.hash = '#/?d=connect-ai'
    expect((await within(await screen.findByRole('dialog')).findByText(/^mk_live_/)).textContent).toBe(key)

    // Copied: closing is quiet, and the key is gone for good.
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Copy key' }))
    await within(screen.getByRole('dialog')).findByText(/^Copied\. It won’t be shown again/)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    location.hash = '#/?d=connect-ai'
    expect(await within(await screen.findByRole('dialog')).findByLabelText('Key name')).toBeTruthy()
  })
})

describe('A key without a passkey', () => {
  it('says it needs a check and offers the emailed link, which brings the name back', async () => {
    forgetUnsavedKey()
    const api = new MockApi()
    const asked: string[] = []
    api.createKey = async () => {
      throw new HttpError(403, 'Add a passkey to connect accounts.', 'passkey_required')
    }
    const base = api.recheckByEmail.bind(api)
    api.recheckByEmail = async (r) => (asked.push(r), base(r))
    start(api, '#/?d=connect-ai')
    typeInto(await screen.findByLabelText('Key name'), 'Invoice bot')
    fireEvent.click(screen.getByRole('button', { name: 'Make a key' }))
    await screen.findByText('Making a key needs a quick check that it’s you.')
    fireEvent.click(screen.getByRole('button', { name: 'Email me a link instead' }))
    await screen.findByText(/Check your email at .* It brings you back here with the name filled in/)
    expect(asked[0]).toMatch(/d=connect-ai.*keyname=Invoice\+bot.*rechecked=1/)
    // The code from that email, typed here, confirms it and makes the key.
    api.createKey = async () => ({ grantId: 'g_new', key: 'mk_live_abc' })
    typeInto(screen.getByLabelText('Or type the code from the email'), '123 456')
    fireEvent.click(screen.getByRole('button', { name: 'Use code' }))
    await screen.findByText('mk_live_abc')
  })
})

describe('An AI’s drawer', () => {
  it('an unused key says when it was made, not "connected"', async () => {
    const api = new MockApi()
    const { grantId } = await api.createKey('Invoice bot', api.s.ais[0]!.shape)
    start(api, `#/?d=ai:${grantId}`)
    expect(await screen.findByText(/^Made just now, not used yet/)).toBeTruthy()
  })

  it('a key can be renamed; an app signed in with OAuth can’t', async () => {
    const api = new MockApi()
    const { grantId } = await api.createKey('Key for my bot', api.s.ais[0]!.shape)
    start(api, `#/?d=ai:${grantId}`)
    fireEvent.click(await screen.findByRole('button', { name: 'Rename' }))
    typeInto(screen.getByLabelText('Key name'), '  Invoice   bot ')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('heading', { name: /^Invoice bot ·/ })
    expect(api.s.ais.find((a) => a.grantId === grantId)!.client).toBe('Invoice bot')
    location.hash = '#/?d=ai:g_claude'
    await screen.findByRole('heading', { name: /^Claude ·/ })
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull()
  })

  it('in a Personal-only workspace, a new key can see Personal (else it would see nothing)', async () => {
    forgetUnsavedKey()
    const api = new MockApi()
    api.s.entities = api.s.entities.filter((e) => e.kind === 'personal')
    start(api, '#/?d=connect-ai')
    typeInto(await screen.findByLabelText('Key name'), 'Budget bot')
    fireEvent.click(screen.getByRole('button', { name: 'Make a key' }))
    await screen.findByText(/^mk_live_/)
    expect(api.s.ais.at(-1)!.shape.dataTypes).toContain('personal')
  })
})

describe('Xero shared organisations', () => {
  it('a Xero connection offers organisations shared before, and adds one only on a click', async () => {
    const api = new MockApi()
    api.s.connections.push({ id: 'c_xero', connectorKey: 'xero', name: 'Xero · Northwind', entityNames: [], status: 'ok', lastSyncAt: null, accountCount: 0 })
    const add = vi.spyOn(api, 'addShared')
    start(api, '#/?d=connection:c_xero')
    const btn = await screen.findByRole('button', { name: 'Add Demo Company (US)' })
    expect(add).not.toHaveBeenCalled()
    fireEvent.click(btn)
    await waitFor(() => expect(add).toHaveBeenCalledWith('c_xero', 'org-demo-us'))
    await screen.findByText(/Demo Company \(US\) is added/)
    expect(api.s.connections.some((c) => c.id === 'conn-org-demo-us')).toBe(true)
  })
  it('a Xero connection without bank accounts says what it brought in, not "No data yet"', async () => {
    const api = new MockApi()
    api.s.connections.push({ id: 'c_xero', connectorKey: 'xero', name: 'Xero · Northwind', entityNames: ['Acme'], status: 'ok', lastSyncAt: new Date().toISOString(), accountCount: 0 })
    const base = api.connection.bind(api)
    api.connection = async (id: string) => ({ ...(await base(id)), records: 233 })
    start(api, '#/?d=connection:c_xero')
    expect(await screen.findByText('233 records brought in.')).toBeTruthy()
    expect(screen.queryByText(/No data yet/)).toBeNull()
  })
  it('with no company known yet, it never claims where the data counts', async () => {
    const api = new MockApi()
    api.s.connections.push({ id: 'c_xero', connectorKey: 'xero', name: 'Xero · Northwind', entityNames: [], status: 'ok', lastSyncAt: new Date().toISOString(), accountCount: 0 })
    start(api, '#/?d=connection:c_xero')
    expect(await screen.findByText('Synced just now.')).toBeTruthy()
    expect(screen.queryByText(/count toward/)).toBeNull()
  })
  it('other connections never ask', async () => {
    const api = new MockApi()
    const offers = vi.spyOn(api, 'sharedOffers')
    start(api, '#/?d=connection:c_chase')
    await screen.findByRole('dialog')
    expect(offers).not.toHaveBeenCalled()
  })
})

describe('review', () => {
  it('Y confirms and N rejects the focused row, then focus moves on', async () => {
    const api = new MockApi()
    start(api, '#/review')
    const rows = await screen.findAllByRole('listitem')
    expect(rows).toHaveLength(4)
    const first = rows[0]!.querySelector<HTMLElement>('[data-review]')!
    first.focus()
    fireEvent.keyDown(first, { key: 'y' })
    await waitFor(() => expect(api.s.review).toHaveLength(3))
    await screen.findByText(/Link them: Same money\?/)
    const next = document.querySelector<HTMLElement>('[data-review="rv3"]')!
    next.focus()
    fireEvent.keyDown(next, { key: 'n' })
    await waitFor(() => expect(api.s.review).toHaveLength(2))
  })
  it('an item with answers shows one button per answer, and a number key picks one', async () => {
    const api = new MockApi()
    const resolve = vi.spyOn(api, 'resolve')
    start(api, '#/review')
    await screen.findAllByRole('listitem')
    const row = document.querySelector<HTMLElement>('[data-review="rv2"]')!
    expect(row.textContent).toContain('A loan to the company')
    expect(row.textContent).not.toContain('Confirm')
    row.focus()
    fireEvent.keyDown(row, { key: 'y' })
    expect(resolve).not.toHaveBeenCalled()
    fireEvent.keyDown(row, { key: '2' })
    await waitFor(() => expect(resolve).toHaveBeenCalledWith('rv2', { action: 'edit', values: { kind: 'owner_investment' } }))
    await screen.findByText(/An investment: Loan or investment\?/)
  })
  it('the toast says what the answer did, and offers Undo when it made a record', async () => {
    const api = new MockApi()
    const undone: string[] = []
    api.resolve = async (id: string) => ((api.s.review = api.s.review.filter((x) => x.id !== id)), { recordId: 'rec_dep', summary: 'Linked: pays invoice 1012 ($274.50)' })
    api.undo = async (id: string) => (undone.push(id), { status: 'applied' as const, recordId: id, message: 'Undone.' })
    start(api, '#/review')
    await screen.findAllByRole('listitem')
    const first = document.querySelector<HTMLElement>('[data-review]')!
    first.focus()
    fireEvent.keyDown(first, { key: 'y' })
    await screen.findByText('Linked: pays invoice 1012 ($274.50)')
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(undone).toEqual(['rec_dep']))
  })
  it('accounts from one connection that look personal: one tap puts them all in Personal', async () => {
    const api = new MockApi()
    const at = new Date().toISOString()
    const ask = (id: string, name: string) => ({ id, kind: 'whose_money' as const, title: `Which company is ${name}?`, detail: 'Its transactions wait', entityName: '', createdAt: at, answers: [{ label: 'Personal', values: { companyId: 'personal' } }, { label: 'Acme', values: { companyId: 'e_acme' } }], batch: { key: 'c_chase:personal', label: 'Personal', values: { companyId: 'personal' } } })
    api.s.review = [ask('which_company:a1', 'Savings ··1'), ask('which_company:a2', 'IRA ··2'), ask('which_company:a3', '401k ··3')]
    const resolve = vi.spyOn(api, 'resolve')
    start(api, '#/review')
    fireEvent.click(await screen.findByRole('button', { name: 'Put all in Personal' }))
    expect(screen.getByText('These 3 accounts look personal')).toBeTruthy()
    await screen.findByText('3 accounts put in Personal. Change any one in its connection.')
    expect(resolve.mock.calls.map((c) => c[0])).toEqual(['which_company:a1', 'which_company:a2', 'which_company:a3'])
    expect((resolve.mock.calls[0] as unknown[])[1]).toEqual({ action: 'edit', values: { companyId: 'personal' } })
  })

  it('E edits a row that has fields', async () => {
    start(new MockApi(), '#/review')
    await screen.findAllByRole('listitem')
    const doc = document.querySelector<HTMLElement>('[data-review="rv4"]')!
    doc.focus()
    fireEvent.keyDown(doc, { key: 'e' })
    expect(await screen.findByLabelText('Amount')).toBeTruthy()
  })
})

describe('preferences', () => {
  it('review mode toggles and shows Review in the nav', async () => {
    const api = new MockApi()
    api.s.review = []
    start(api, '#/preferences')
    await screen.findByRole('region', { name: 'AI changes' })
    expect(screen.queryByRole('link', { name: /Review/ })).toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: 'AI changes wait for my review' }))
    await screen.findByRole('link', { name: /Review/ })
    expect(api.s.prefs.aiReviewMode).toBe(true)
  })
  it('invite someone with a role preset, then open the full grid', async () => {
    const api = new MockApi()
    start(api, '#/preferences?d=invite')
    const d = await screen.findByRole('dialog')
    typeInto(within(d).getByLabelText('Email'), 'dana@acme.example')
    fireEvent.click(within(d).getByRole('radio', { name: /Finance/ }))
    fireEvent.click(within(d).getByRole('button', { name: 'Send invite' }))
    await screen.findByText('Invite sent to dana@acme.example.')
    const p = api.s.prefs.people.find((x) => x.email === 'dana@acme.example')!
    expect(p.role).toBe('finance')
    expect(p.grid.personal).toBe('none')
  })
  it('add a company from the drawer opens it', async () => {
    start(new MockApi(), '#/?d=company-new')
    const d = await screen.findByRole('dialog')
    typeInto(within(d).getByLabelText('Name'), 'Delta')
    fireEvent.click(within(d).getByRole('button', { name: 'Add company' }))
    await screen.findByRole('heading', { name: 'Delta' })
    expect(await screen.findByText('Nothing here yet')).toBeTruthy()
  })
})

describe('needs onboarding', () => {
  it('a signed-in person without a workspace is sent to the first step, wherever they land', async () => {
    const api = new MockApi({ empty: true })
    start(api, '#/preferences')
    await screen.findByRole('heading', { name: 'What’s your company called?' })
    typeInto(screen.getByLabelText('Company name'), 'Acme')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Connect your money' })
    expect(api.s.entities.map((e) => e.name)).toEqual(['Acme', 'Personal'])
  })
})

describe('first run', () => {
  it('the AI step moves on by itself once the AI is approved', async () => {
    const api = new MockApi()
    start(api, '#/welcome/3')
    await screen.findByRole('heading', { name: 'Connect your AI' })
    api.s.ais.push({ ...api.s.ais[0]!, grantId: 'g_new', client: 'Claude' })
    document.dispatchEvent(new Event('visibilitychange'))
    await screen.findByRole('heading', { name: 'Ask it something' })
  })
  it('the AI step says whether the data is in, which plans work, and offers the demo books where the server has them', async () => {
    const api = new MockApi()
    api.s.me = { ...api.s.me, demoMcpUrl: 'https://app.aggregate.finance/demo/mcp' }
    start(api, '#/welcome/3')
    await screen.findByRole('heading', { name: 'Connect your AI' })
    expect(screen.getByText(/^Your data: /)).toBeTruthy()
    expect(screen.getByText(/Claude works on any plan \(Free allows one custom connector\)/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'OpenAI’s help' }).getAttribute('href')).toMatch(/^https:\/\/help\.openai\.com\//)
    expect(screen.getByText('Try it on the demo books first: add this link the same way. Made-up companies, no sign-in.')).toBeTruthy()
    expect(screen.getByText('https://app.aggregate.finance/demo/mcp')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open Claude ↗' }).getAttribute('href')).toBe('https://claude.ai/customize/connectors')
  })

  it('the AI step can be skipped without claiming it was added: straight to the Workspace', async () => {
    const api = new MockApi()
    const before = api.s.ais.length
    start(api, '#/welcome/3')
    fireEvent.click(await screen.findByRole('button', { name: 'Skip, I’ll ask later' }))
    await screen.findByRole('region', { name: 'Money' })
    expect(api.s.ais).toHaveLength(before)
  })
})
