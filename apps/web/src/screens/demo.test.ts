// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { HttpApi, HttpError } from '../api/http.ts'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'

const start = (api: MockApi, hash: string) => {
  location.hash = hash
  return render(html`<${Root} api=${api} />`)
}

describe('Demo mode', () => {
  it('onboarding offers made-up companies; leaving the demo starts onboarding fresh', async () => {
    start(new MockApi({ empty: true }), '#/welcome/1')
    fireEvent.click(await screen.findByRole('button', { name: 'Or look around with made-up companies first' }))
    await screen.findByRole('region', { name: 'Money' })
    expect(screen.getByText(/You’re looking at a demo/)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /Bluebird Studio/ }).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Start with your own companies →' }))
    await screen.findByRole('heading', { name: 'What’s your company called?' })
    await waitFor(() => expect(location.hash).toBe('#/welcome/1'))
  })

  it('the way out is on every screen: a bar, the menu and the palette', async () => {
    const demo = () => (api => (Object.assign(api.s.me, { demo: true }), api))(new MockApi())
    const v = start(demo(), '#/preferences')
    await screen.findByRole('region', { name: 'Sign-in' })
    expect(screen.getByRole('button', { name: 'Start with your own companies →' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Leave the demo' })).toBeTruthy()
    v.unmount()
    start(demo(), '#/review')
    await screen.findByRole('heading', { name: 'Review' })
    fireEvent.keyDown(document, { key: 'k', metaKey: true })
    fireEvent.click(await screen.findByText('Leave the demo and start with your own companies'))
    await screen.findByRole('heading', { name: 'What’s your company called?' })
  })

  it('connecting in a real demo offers the way out instead of refusing', async () => {
    const api = new MockApi()
    Object.assign(api.s.me, { demo: true })
    Object.defineProperty(api, 'simulated', { value: false })
    start(api, '#/?d=connect:plaid')
    fireEvent.click(await screen.findByRole('button', { name: 'Leave the demo and connect for real' }))
    await screen.findByRole('heading', { name: 'What’s your company called?' })
  })

  it('a connector this server allows in a demo (the challenge\'s sandbox Plaid) connects instead', async () => {
    const api = new MockApi()
    Object.assign(api.s.me, { demo: true })
    Object.defineProperty(api, 'simulated', { value: false })
    const list = api.connectors.bind(api)
    api.connectors = async () => (await list()).map((c) => (c.key === 'plaid' ? { ...c, demoAllowed: true } : c))
    start(api, '#/?d=connect:plaid')
    expect(await screen.findByRole('button', { name: 'Choose your bank' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Leave the demo and connect for real' })).toBeNull()
  })

  it('Done on the accounts step shows a failure instead of silently doing nothing', async () => {
    const api = new MockApi()
    let calls = 0
    api.assignAccounts = async () => {
      calls++
      throw new HttpError(500, 'Something went wrong on our side. Try again in a moment.')
    }
    start(api, '#/?d=connect:plaid')
    fireEvent.click(await screen.findByRole('button', { name: 'Choose your bank' }))
    await screen.findByRole('heading', { name: 'Which company is each account?' })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Something went wrong on our side')
    // Still there, and Done works again.
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy()
    expect(calls).toBe(1)
  })

  it('a server demo refusal (409 demo) turns into the same offer', async () => {
    const api = new MockApi()
    api.startConnect = async () => { throw new HttpError(409, 'Real connectors can’t be added to the demo.', 'demo') }
    start(api, '#/?d=connect:plaid')
    fireEvent.click(await screen.findByRole('button', { name: 'Choose your bank' }))
    expect(await screen.findByRole('button', { name: 'Leave the demo and connect for real' })).toBeTruthy()
  })

  it('HTTP: POST /api/demo pins the workspace; DELETE /api/demo forgets it', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const bodies = [{ workspaceId: 'ws_demo', created: true, entities: [] }, { id: 'b' }, { ok: true }, { id: 'b' }]
    const f = (async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response(JSON.stringify(bodies.shift())))) as unknown as typeof fetch
    const api = new HttpApi({ fetch: f })
    await api.startDemo()
    expect(calls[0]).toMatchObject({ url: '/api/demo', init: { method: 'POST' } })
    await api.bucket('b')
    expect((calls[1]!.init.headers as Record<string, string>)['x-agfn-workspace']).toBe('ws_demo')
    await api.leaveDemo()
    expect(calls[2]!.init.method).toBe('DELETE')
    await api.bucket('b')
    expect((calls[3]!.init.headers as Record<string, string>)['x-agfn-workspace']).toBeUndefined()
  })
})

describe('Delete workspace', () => {
  it('owner only, typed DELETE, then onboarding', async () => {
    const api = new MockApi()
    ;(api.s.me as { demo: boolean }).demo = false
    start(api, '#/preferences')
    fireEvent.click(await screen.findByRole('button', { name: 'Delete workspace' }))
    await screen.findByRole('heading', { name: 'Delete workspace' })
    const box = screen.getByLabelText('Type DELETE to confirm')
    fireEvent.input(box, { target: { value: 'delete' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete workspace' }).at(-1)!)
    expect((await screen.findByRole('alert')).textContent).toBe('Type DELETE to confirm.')
    fireEvent.input(box, { target: { value: 'DELETE' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete workspace' }).at(-1)!)
    await screen.findByRole('heading', { name: 'What’s your company called?' })
  })

  it('names the workspace, and with another one left, opens that instead of onboarding', async () => {
    const api = new MockApi()
    ;(api.s.me as { demo: boolean }).demo = false
    api.s.me.workspaces = [
      { id: api.s.me.workspaceId, name: 'Test workspace' },
      { id: 'ws_agfn', name: 'AGFN' },
    ]
    // The server keeps the person's other workspace: same companies stay, now as AGFN.
    api.deleteWorkspace = async () => {
      api.s.me = { ...api.s.me, workspaceId: 'ws_agfn', workspaces: [{ id: 'ws_agfn', name: 'AGFN' }] }
      return { ok: true }
    }
    start(api, '#/preferences')
    fireEvent.click(await screen.findByRole('button', { name: 'Delete workspace' }))
    await screen.findByRole('heading', { name: 'Delete Test workspace' })
    fireEvent.input(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } })
    fireEvent.click(screen.getAllByRole('button', { name: /^Delete/ }).at(-1)!)
    await screen.findByText('Test workspace and everything in it is deleted. Your banks aren’t affected.')
    await screen.findByRole('region', { name: 'Money' })
    expect(screen.queryByRole('heading', { name: 'What’s your company called?' })).toBeNull()
  })

  it('is not offered in the demo', async () => {
    start(new MockApi(), '#/preferences')
    await screen.findByRole('button', { name: 'Export everything' })
    expect(screen.queryByRole('button', { name: 'Delete workspace' })).toBeNull()
  })
})

describe('Legal and invites', () => {
  it('sign-in shows Privacy · Terms; the bank connect drawer names both privacy policies', async () => {
    const v = start(new MockApi({ signedIn: false } as never), '#/signin')
    expect((await screen.findByRole('link', { name: 'Privacy' })).getAttribute('href')).toBe('/privacy')
    expect(screen.getByRole('link', { name: 'Terms' }).getAttribute('href')).toBe('/terms')
    // Only the sign-in methods this server has (the mock offers passkey, Apple and email, not Google).
    await screen.findByRole('button', { name: 'Continue with Apple' })
    expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull()
    v.unmount()
    start(new MockApi(), '#/?d=connect:plaid')
    expect((await screen.findByRole('link', { name: 'End User Privacy Policy' })).getAttribute('href')).toBe('https://plaid.com/legal/#end-user-privacy-policy')
  })

  it('arriving from an invite greets them and tidies the URL', async () => {
    history.replaceState(null, '', '/?invite=abcdefghijklmnopqrst#/')
    render(html`<${Root} api=${new MockApi()} />`)
    expect((await screen.findByRole('status')).textContent).toContain('Sam Lee invited you to Acme. Welcome.')
    expect(location.search).toBe('')
  })
})

describe('Passkey before connecting', () => {
  it('without a passkey: explains first, adds it from the click, then continues', async () => {
    const api = new MockApi()
    api.s.prefs.signIn.passkeys = []
    let prepared = 0
    const prep = api.preparePasskey.bind(api)
    api.preparePasskey = async () => (prepared++, prep())
    start(api, '#/?d=connect:stripe')
    expect(await screen.findByText('Connecting accounts needs a quick check that it’s you. A passkey makes it one tap with Face ID, a fingerprint or your device PIN.')).toBeTruthy()
    const add = await screen.findByRole('button', { name: 'Add passkey' })
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false))
    expect(prepared).toBe(1)
    fireEvent.click(add)
    await waitFor(() => expect(api.s.prefs.signIn.passkeys).toHaveLength(1))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Add passkey' })).toBeNull())
  })

  it('without a passkey, by email instead: the drawer says what happens next and has a way on (a passkey is only a suggestion)', async () => {
    const api = new MockApi()
    api.s.prefs.signIn.passkeys = []
    start(api, '#/?d=connect:stripe')
    fireEvent.click(await screen.findByRole('button', { name: 'Use email instead' }))
    expect(await screen.findByText(/Check your email at dana@example\.com for the code/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add passkey' })).toBeNull()
    // Not confirmed yet: "Continue to Stripe" is there but off. A link opened on another device goes on once the server agrees.
    expect((screen.getByRole('button', { name: 'Continue to Stripe' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('For which company?'), { target: { value: 'e_acme' } })
    fireEvent.click(screen.getByRole('button', { name: 'I opened the link on another device' }))
    await waitFor(() => expect(screen.queryByText(/Check your email at/)).toBeNull())
  })

  it('by email, continuing before the link is opened or the code typed stays on that step and says so (43)', async () => {
    const api = new MockApi()
    api.s.prefs.signIn.passkeys = []
    api.startConnect = async () => {
      throw new HttpError(403, 'Confirm it’s you: we’ll email you a link.', 'recheck')
    }
    start(api, '#/?d=connect:stripe')
    fireEvent.click(await screen.findByRole('button', { name: 'Use email instead' }))
    await screen.findByText(/Check your email at/)
    fireEvent.change(screen.getByLabelText('For which company?'), { target: { value: 'e_acme' } })
    fireEvent.click(screen.getByRole('button', { name: 'I opened the link on another device' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Not confirmed yet\. Open the link in the email, or type its code above\./)
    expect(screen.getByText(/Check your email at/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Continue to Stripe' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('by email, the code typed here confirms it (for a link opened on another device)', async () => {
    const api = new MockApi()
    api.s.prefs.signIn.passkeys = []
    start(api, '#/?d=connect:stripe')
    fireEvent.click(await screen.findByRole('button', { name: 'Use email instead' }))
    fireEvent.input(await screen.findByLabelText('Or type the code from the email'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use code' }))
    // Check your email → Confirmed → "Continue to Stripe" on.
    await screen.findByText('Confirmed. It’s you.')
    fireEvent.change(screen.getByLabelText('For which company?'), { target: { value: 'e_acme' } })
    const go = screen.getByRole('button', { name: 'Continue to Stripe' }) as HTMLButtonElement
    expect(go.disabled).toBe(false)
    fireEvent.click(go)
    await waitFor(() => expect(screen.queryByText('Confirmed. It’s you.')).toBeNull())
  })

  it('with a passkey: no extra step', async () => {
    start(new MockApi(), '#/?d=connect:stripe')
    await screen.findByRole('button', { name: /Continue to Stripe/ })
    expect(screen.queryByText(/quick check that it’s you/)).toBeNull()
  })
})

describe('Delete my account', () => {
  it('typed DELETE, then the sign-in page with a quiet note', async () => {
    const api = new MockApi()
    ;(api.s.me as { demo: boolean }).demo = false
    start(api, '#/preferences')
    fireEvent.click(await screen.findByRole('button', { name: 'Delete my account' }))
    await screen.findByRole('heading', { name: 'Delete my account' })
    fireEvent.input(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete my account' }).at(-1)!)
    await screen.findByRole('heading', { name: 'Sign in' })
    expect(await screen.findByText(/Your account and its data are deleted/)).toBeTruthy()
  })

  it('confirm by email code inside the drawer: "Use code" only checks the code; Delete then finishes (43, live)', async () => {
    const api = new MockApi()
    ;(api.s.me as { demo: boolean }).demo = false
    let checked = false
    const deletes: boolean[] = []
    const base = api.deleteMe.bind(api)
    const code = api.recheckCode.bind(api)
    api.recheckCode = async (c: string) => {
      const r = await code(c)
      checked = true
      return r
    }
    api.deleteMe = async (confirm: string) => {
      deletes.push(checked)
      if (!checked) throw new HttpError(403, 'Confirm it’s you: we’ll email you a link.', 'recheck', { fallback: 'email' })
      return base(confirm)
    }
    start(api, '#/preferences?d=delete-me')
    await screen.findByRole('heading', { name: 'Delete my account' })
    fireEvent.input(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete my account' }).at(-1)!)
    fireEvent.click(await screen.findByRole('button', { name: 'Email me a link' }))
    fireEvent.input(await screen.findByLabelText('Or type the code from the email'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use code' }))
    await screen.findByText('Confirmed. Press Delete my account to finish.')
    expect(deletes).toEqual([false])
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete my account' }).at(-1)!)
    await screen.findByRole('heading', { name: 'Sign in' })
    expect(deletes).toEqual([false, true])
  })

  it('sole owner: shows the reason and the ways forward', async () => {
    const api = new MockApi()
    ;(api.s.me as { demo: boolean }).demo = false
    api.deleteMe = async () => {
      throw new HttpError(409, 'Make someone else an owner or delete the workspace first.', 'sole_owner')
    }
    start(api, '#/preferences?d=delete-me')
    await screen.findByRole('heading', { name: 'Delete my account' })
    fireEvent.input(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete my account' }).at(-1)!)
    expect((await screen.findByRole('alert')).textContent).toBe('Make someone else an owner or delete the workspace first.')
    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace' }))
    await screen.findByRole('heading', { name: 'Delete workspace' })
  })
})

describe('AI consent page', () => {
  it('marks the name unverified and says where approving sends you', async () => {
    const { redirectPlace } = await import('./ai.ts')
    expect(redirectPlace('https://claude.ai/api/mcp/auth_callback')).toBe('claude.ai')
    expect(redirectPlace('http://127.0.0.1:53682/callback')).toBe('an app on this computer')
    expect(redirectPlace('http://localhost:3000/cb')).toBe('an app on this computer')
    expect(redirectPlace('http://[::1]:8080/cb')).toBe('an app on this computer')
    expect(redirectPlace('com.example.app:/oauth')).toBe('com.example.app')
    start(new MockApi(), '#/connect-ai/consent?client_id=claude&client_name=Claude&scope=finance%3Aread&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&consent_code=x')
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Connect “Claude”? · unverified name')
    expect(screen.getByText('Sends you back to claude.ai')).toBeTruthy()
  })
})

describe('Time zone', () => {
  it('Preferences shows the workspace time zone and saves a change', async () => {
    const api = new MockApi()
    start(api, '#/preferences')
    const tz = (await screen.findByLabelText('Time zone')) as HTMLSelectElement
    expect(tz.value).toBe('America/New_York')
    fireEvent.change(tz, { target: { value: 'Europe/London' } })
    await waitFor(() => expect(api.s.prefs.timeZone).toBe('Europe/London'))
  })

  it('signup sends the device time zone', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const f = (async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response(JSON.stringify({ workspaceId: 'w', companyId: 'c', personalId: 'p' })))) as unknown as typeof fetch
    await new HttpApi({ fetch: f }).createWorkspace('Acme')
    expect(JSON.parse(String(calls[0]!.init.body)).timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  })
})

describe('Reviewer demo', () => {
  const reviewer = () => {
    const api = new MockApi()
    Object.assign(api.s.me, { demo: true, reviewerDemo: true })
    return api
  }
  it('shows one quiet banner and hides what the server refuses; AI and reading stay', async () => {
    const v = start(reviewer(), '#/')
    expect(await screen.findByText('Reviewer demo · made-up companies · resets nightly')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Leave the demo' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start with your own companies →' })).toBeNull()
    for (const name of ['Add a company', 'More connections', 'Invite someone']) expect(screen.queryByRole('button', { name })).toBeNull()
    expect(screen.getByRole('button', { name: 'Connect another AI' })).toBeTruthy()
    v.unmount()
    const p = start(reviewer(), '#/preferences')
    await screen.findByRole('region', { name: 'Sign-in' })
    for (const name of ['Add a passkey', 'Pause all AI', 'Invite someone', 'Delete my account', 'Delete workspace', 'Remove']) expect(screen.queryByRole('button', { name })).toBeNull()
    p.unmount()
    start(reviewer(), '#/?d=connection:c_mercury')
    await screen.findByRole('button', { name: 'Sync now' })
    for (const name of ['Reconnect', 'Disconnect', 'Refresh balance', 'Move to another company']) expect(screen.queryByRole('button', { name })).toBeNull()
  })
})

describe('Filling the demo', () => {
  it('demo hides every figure while a connection syncs, then shows them all at once', async () => {
    const api = new MockApi()
    api.s.me.demo = true
    const c = api.s.connections.find((x) => x.entityNames.length)!
    c.status = 'syncing'
    start(api, '#/')
    expect(await screen.findByText(/^Filling the demo/)).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Companies' })).toBeNull()
    c.status = 'ok'
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(screen.queryByText(/^Filling the demo/)).toBeNull())
    expect(screen.getAllByRole('button', { name: /Open details/ }).length).toBeGreaterThan(0)
  })

  it('a real workspace keeps its numbers and marks the company that is updating', async () => {
    const api = new MockApi()
    api.s.me.demo = false
    const c = api.s.connections.find((x) => x.entityNames.length)!
    c.status = 'syncing'
    start(api, '#/')
    expect(await screen.findByRole('button', { name: new RegExp(`^${c.entityNames[0]}, .*, updating\\. Open details`) })).toBeTruthy()
    expect(screen.queryByText(/^Filling the demo/)).toBeNull()
  })
})

describe('Calm failures', () => {
  it('server down on first load: one line and Try again, never the sign-in page', async () => {
    const api = new MockApi()
    const me = api.me.bind(api)
    let up = false
    api.me = async () => {
      if (!up) throw new HttpError(0, 'Can’t reach Aggregate right now.', 'offline')
      return me()
    }
    start(api, '#/')
    expect((await screen.findByRole('alert')).textContent).toBe('Can’t reach Aggregate right now.')
    expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull()
    up = true
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByRole('region', { name: 'Money' })
  })

  it('HTTP: a network failure is a plain sentence', async () => {
    const f = (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    await expect(new HttpApi({ fetch: f }).workspace()).rejects.toMatchObject({ code: 'offline', message: 'Can’t reach Aggregate right now. Check your connection and try again.' })
  })

  it('session expired mid-drawer: sign in again, then back to the same drawer', async () => {
    start(new MockApi(), '#/?d=company:e_acme')
    await screen.findByRole('dialog')
    dispatchEvent(new Event('agfn:signed-out'))
    expect(await screen.findByText('You were signed out. Sign in to pick up where you left off.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with a passkey' }))
    await waitFor(() => expect(location.hash).toBe('#/?d=company:e_acme'))
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('Acme'))
  })

  it('cancelling at the provider is said calmly', async () => {
    start(new MockApi(), '#/?connect_error=access_denied')
    expect(await screen.findByText('Nothing was connected. You can try again anytime.')).toBeTruthy()
  })

  it('a connection with no data yet says so in one line', async () => {
    const api = new MockApi()
    api.s.connections.push({ id: 'c_new', connectorKey: 'paypal', name: 'PayPal', entityNames: ['Acme'], status: 'ok', lastSyncAt: null, accountCount: 0 })
    start(api, '#/?d=connection:c_new')
    expect(await screen.findByText('No data yet. Sync now to check again.')).toBeTruthy()
  })
})

describe('Shopify install resume', () => {
  it('a pending Shopify install sends the page to the resume URL once', async () => {
    const api = new MockApi()
    Object.assign(api.s.me, { pendingInstall: 'shopify' })
    const went: string[] = []
    const assign = location.assign
    Object.defineProperty(location, 'assign', { value: (u: string) => went.push(u), configurable: true })
    try {
      start(api, '#/')
      await waitFor(() => expect(went).toEqual(['/api/connectors/shopify/install/resume']))
    } finally {
      Object.defineProperty(location, 'assign', { value: assign, configurable: true })
    }
  })
})

describe('Plaid early-access limit', () => {
  it('says the server’s words in grey, with no red error and no second try', async () => {
    const api = new MockApi()
    const msg = 'You’ve connected 25 banks — the most during early access. Disconnect one to add another.'
    api.startConnect = async () => {
      throw new HttpError(409, msg, 'plaid_limit', { limit: 25 })
    }
    start(api, '#/?d=connect:plaid')
    fireEvent.click(await screen.findByRole('button', { name: 'Choose your bank' }))
    expect((await screen.findByRole('status')).textContent).toBe(msg)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Choose your bank' })).toBeNull()
  })
})

describe('Self-hosted connectors', () => {
  it('an app connector without keys says what it needs and shows the steps, never a dead Connect', async () => {
    start(new MockApi({ selfHost: true }), '#/?d=connect')
    expect(await screen.findByText('Needs your own QuickBooks app')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Connect QuickBooks' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Connect Stripe' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Set up QuickBooks' }))
    expect(await screen.findByRole('heading', { name: 'Set up QuickBooks' })).toBeTruthy()
    expect(screen.getByText('https://money.example.com/api/connectors/quickbooks/callback')).toBeTruthy()
    expect(screen.getByText(/QUICKBOOKS_CLIENT_ID=…/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Intuit Developer ↗' }).getAttribute('href')).toBe('https://developer.intuit.com/app/developer/dashboard')
    expect(screen.getByRole('link', { name: 'Full guide ↗' })).toBeTruthy()
  })

  it('a bank without Plaid keys: upload first, Plaid with your own account last', async () => {
    start(new MockApi({ selfHost: true }), '#/?d=connect:plaid')
    expect(await screen.findByRole('heading', { name: 'Connect a bank or card' })).toBeTruthy()
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label')).filter((x) => x === 'Connect SimpleFIN Bridge' || x === 'Upload a statement' || x === 'Set up Plaid')
    expect(names).toEqual(['Connect SimpleFIN Bridge', 'Upload a statement', 'Set up Plaid'])
    fireEvent.click(screen.getByRole('button', { name: 'Set up Plaid' }))
    expect(await screen.findByRole('heading', { name: 'Use your own Plaid account' })).toBeTruthy()
    expect(screen.getByText(/PLAID_CLIENT_ID=…/)).toBeTruthy()
  })

  it('hosted is unchanged: one-click Connect everywhere', async () => {
    start(new MockApi(), '#/?d=connect')
    expect(await screen.findByRole('button', { name: 'Connect QuickBooks' })).toBeTruthy()
    expect(screen.queryByText(/Needs your own/)).toBeNull()
  })
})

describe('Unfamiliar CSV', () => {
  it('asks one question at a time with a preview, then imports', async () => {
    start(new MockApi(), '#/?d=add:upload')
    const input = (await screen.findByLabelText('Choose files to upload')) as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'bank-export.csv', { type: 'text/csv' })] } })
    expect(await screen.findByText('Which column is the date?')).toBeTruthy()
    expect(screen.getByRole('region', { name: 'First rows of bank-export.csv' }).textContent).toContain('Client payment')
    fireEvent.change(screen.getByLabelText('Which column is the date?'), { target: { value: 'Posted' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('Which column is the amount?')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Which column is the amount?'), { target: { value: 'Value' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'March 4' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Money I spent' }))
    expect(await screen.findByText('Imported 3 rows.')).toBeTruthy()
  })
})

describe('Filling the demo: counts held too', () => {
  it('no Review count or "things need a look" until the server says ready and nothing is syncing', async () => {
    const api = new MockApi()
    Object.assign(api.s.me, { demo: true, demoReady: false })
    start(api, '#/')
    expect(await screen.findByText(/^Filling the demo/)).toBeTruthy()
    expect(screen.queryByLabelText(/waiting$/)).toBeNull()
    expect(screen.queryByText(/need(s)? a look/)).toBeNull()
    Object.assign(api.s.me, { demoReady: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(screen.queryByText(/^Filling the demo/)).toBeNull())
    expect(screen.getAllByLabelText(/waiting$/).length).toBeGreaterThan(0)
  })

  it('on http://<LAN IP> (no secure context) sign-in offers only the email link, not a passkey', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true })
    try {
      start(new MockApi({ signedIn: false }), '#/sign-in')
      await screen.findByRole('button', { name: /email/i })
      expect(screen.queryByRole('button', { name: 'Sign in with a passkey' })).toBeNull()
    } finally {
      Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
    }
  })
})

describe('Fresh eyes (2026-10-11)', () => {
  it('a first visit never says "You were signed out"', async () => {
    const api = new MockApi({ signedIn: false })
    start(api, '#/')
    await screen.findByRole('heading', { name: 'Sign in' })
    dispatchEvent(new Event('agfn:signed-out')) // a 401 from the first "who am I?" check
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByText(/You were signed out/)).toBeNull()
    expect(screen.getByText(/New here\? Enter your email/)).toBeTruthy()
  })

  it('with no email sign-in (passkey and GitHub only), it doesn’t ask for an email', async () => {
    const api = new MockApi({ signedIn: false })
    api.signInMethods = async () => ['passkey', 'github']
    start(api, '#/signin')
    await screen.findByRole('button', { name: 'Continue with GitHub' })
    expect(screen.getByText(/New here\? Sign in any way below and we’ll set you up\./)).toBeTruthy()
    expect(screen.queryByText(/Enter your email/)).toBeNull()
  })

  it('the first-question examples name your own company', async () => {
    start(new MockApi(), '#/?d=connect-ai')
    expect(await screen.findByText(/Add it to Acme\.”/)).toBeTruthy()
    expect(screen.queryByText(/my company/)).toBeNull()
  })

  it('Preferences lists only the sign-in methods this server offers, and the demo can delete the account', async () => {
    const api = new MockApi()
    Object.assign(api.s.me, { demo: true, signInMethods: ['passkey', 'email'] })
    api.s.prefs.signIn.apple = false
    api.s.prefs.signIn.google = false
    start(api, '#/preferences')
    expect(await screen.findByRole('button', { name: 'Delete my account' })).toBeTruthy()
    expect(screen.queryByText('Sign in with Apple')).toBeNull()
    expect(screen.queryByText('Sign in with Google')).toBeNull()
  })
})

describe('Delete without a passkey', () => {
  it('asks for an emailed link first, then the delete goes through', async () => {
    const api = new MockApi()
    api.needsEmailRecheck = true
    start(api, '#/preferences?d=delete-me')
    const box = await screen.findByLabelText('Type DELETE to confirm')
    fireEvent.input(box, { target: { value: 'DELETE' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Email me a link' }))
    expect(await screen.findByText(/Check your email at dana@example\.com\. Open the link on any device/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }))
    await screen.findByRole('heading', { name: 'Sign in' })
  })

  it('HTTP: a recheck by email is not sent to the passkey prompt', async () => {
    let asked = 0
    const f = (async () => new Response(JSON.stringify({ error: 'recheck', method: 'email', message: 'Confirm it’s you first.' }), { status: 403 })) as unknown as typeof fetch
    const api = new HttpApi({ fetch: f, recheck: async () => (asked++, true) })
    await expect(api.deleteMe('DELETE')).rejects.toMatchObject({ code: 'recheck', data: { method: 'email' } })
    expect(asked).toBe(0)
  })
})

describe('Leaving and coming back', () => {
  it('after deleting the account, sign-in says so (not "You were signed out")', async () => {
    start(new MockApi(), '#/preferences?d=delete-me')
    fireEvent.input(await screen.findByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }))
    expect(await screen.findByText(/Your account and its data are deleted/)).toBeTruthy()
    expect(screen.queryByText(/You were signed out/)).toBeNull()
  })

  it('an OAuth attempt that expired reopens the same connector with one calm line', async () => {
    start(new MockApi(), '#/?connect_error=This%20connection%20attempt%20expired.%20Start%20again.&connector=xero')
    expect(await screen.findByText('That took too long. Try again.')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Connect Xero' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect to Xero' })).toBeTruthy()
  })

  it('the note is shown once: it leaves the address, so a later connect (even after a success) never repeats it', async () => {
    start(new MockApi(), '#/?connect_error=This%20connection%20attempt%20expired.%20Start%20again.&connector=xero')
    await screen.findByText('That took too long. Try again.')
    await waitFor(() => expect(location.hash).not.toContain('connect_note'))
    location.hash = '#/?d=connect:plaid'
    dispatchEvent(new HashChangeEvent('hashchange'))
    await screen.findByRole('heading', { name: /bank/i })
    expect(screen.queryByText('That took too long. Try again.')).toBeNull()
  })
})

describe('Use email instead (every passkey prompt)', () => {
  it('a passkey check that did not happen offers the email link, anywhere', async () => {
    start(new MockApi(), '#/')
    await screen.findByRole('region', { name: 'Money' })
    dispatchEvent(new Event('agfn:recheck-needed'))
    fireEvent.click(await screen.findByRole('button', { name: 'Use email instead' }))
    expect(await screen.findByText(/Check your email at dana@example\.com and open the link on any device\. Then come back and try again\./)).toBeTruthy()
  })

  it('back from the link: confirmed, and DELETE is still typed', async () => {
    start(new MockApi(), '#/preferences?d=delete-me&typed=1&rechecked=1')
    expect(((await screen.findByLabelText('Type DELETE to confirm')) as HTMLInputElement).value).toBe('DELETE')
    expect(await screen.findByText('Confirmed. You can continue.')).toBeTruthy()
  })

  it('the delete dialog says sole-member workspaces, the demo included, go too', async () => {
    start(new MockApi(), '#/preferences?d=delete-me')
    expect(await screen.findByText(/only member, including the demo, are deleted with all their data/)).toBeTruthy()
  })
})
