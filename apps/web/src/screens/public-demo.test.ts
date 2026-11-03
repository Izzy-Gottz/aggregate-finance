// @vitest-environment happy-dom
// The no-sign-up demo in the app: a banner and "Sign up" instead of the account menu, and anything that would change
// something opens "This is a read-only demo". Requests carry the demo header and never name or remember a workspace.
import { render, screen } from '@testing-library/preact'
import { afterEach, describe, expect, it } from 'vitest'
import { HttpApi } from '../api/http.ts'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'
import { endPublicDemo, publicDemoOn } from '../lib/demo.ts'

afterEach(() => endPublicDemo())

const start = (api: MockApi, hash: string) => {
  location.hash = hash
  return render(html`<${Root} api=${api} />`)
}

describe('public demo', () => {
  it('shows the read-only banner, no Preferences or Log out, and a read-only note for writes', async () => {
    const api = new MockApi()
    api.s.me = { ...api.s.me, publicDemo: true }
    start(api, '#/?d=add:cash')
    await screen.findByRole('heading', { name: 'This is a read-only demo' })
    expect(screen.getByText('Demo company · read-only · made-up numbers')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Preferences' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Log out' })).toBeNull()
    expect(screen.getAllByRole('button', { name: /Sign up/ }).length).toBeGreaterThan(0)
    // Reading is fine.
    location.hash = '#/?d=company:e_acme'
    await screen.findByRole('heading', { name: 'Acme' })
  })

  it('asks for no documents, and Personal says it’s made up', async () => {
    const api = new MockApi()
    api.s.me = { ...api.s.me, publicDemo: true }
    let docs = 0
    api.unreadDocuments = async () => (docs++, [])
    api.waitingStatements = async () => (docs++, [])
    start(api, '#/?d=company:e_personal')
    await screen.findByText('Made-up, like the rest of the demo.')
    expect(screen.queryByText('Only you see this.')).toBeNull()
    expect(docs).toBe(0)
  })

  it('#/?demo=1 turns on demo requests for this tab: the header, and no workspace named or remembered', async () => {
    location.hash = '#/?demo=1'
    expect(publicDemoOn()).toBe(true)
    location.hash = '#/'
    expect(publicDemoOn()).toBe(true)
    const seen: Array<Record<string, string>> = []
    const api = new HttpApi({ fetch: async (_url, init) => (seen.push((init?.headers ?? {}) as Record<string, string>), new Response(JSON.stringify({ personId: 'p', name: 'Demo', email: '', workspaceId: 'ws_demo', publicDemo: true, mcpUrl: '', selfHosted: false, demo: true }), { status: 200 })) })
    await api.me()
    await api.me()
    expect(seen[0]!['x-agfn-public-demo']).toBe('1')
    expect(seen[1]!['x-agfn-workspace']).toBeUndefined()
    expect(localStorage.getItem('agfn.workspace')).not.toBe('ws_demo')
    endPublicDemo()
    expect(publicDemoOn()).toBe(false)
  })
})

describe('public demo: AI link and connections', () => {
  it('the home offers the demo’s own AI link (no sign-in), not the one that asks for an account', async () => {
    const api = new MockApi()
    api.s.me = { ...api.s.me, publicDemo: true, demoMcpUrl: 'https://app.example/demo/mcp' }
    start(api, '#/')
    expect(await screen.findByText('https://app.example/demo/mcp')).toBeTruthy()
    expect(screen.getByText('Paste this link into Claude, ChatGPT or any assistant. It reads the demo books, with no sign-in.')).toBeTruthy()
  })

  it('a connection only reads: no Sync now, Disconnect or Move', async () => {
    const api = new MockApi()
    api.s.me = { ...api.s.me, publicDemo: true }
    start(api, '#/?d=connection:c_stripe_nex')
    await screen.findByRole('heading', { name: 'Stripe' })
    for (const name of ['Sync now', 'Disconnect', 'Disconnect and delete its data', 'Move to another company']) expect(screen.queryByRole('button', { name })).toBeNull()
  })

  it('signed in, the home keeps the usual link and Sync now', async () => {
    const api = new MockApi()
    start(api, '#/?d=connection:c_stripe_nex')
    expect(await screen.findByRole('button', { name: 'Sync now' })).toBeTruthy()
  })
})
