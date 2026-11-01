// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { MockApi } from '../api/mock.ts'
import { Root } from '../app/app.ts'
import '../test/setup.ts'
import { html } from '../ui/html.ts'

/** The mock's person, as an owner of its workspace (who may share cards). */
function asOwner(api: MockApi): MockApi {
  api.s.me = { ...api.s.me, workspaces: [{ id: api.s.me.workspaceId, name: 'Demo', role: 'owner' }] }
  return api
}

const start = (api: MockApi, hash: string) => {
  location.hash = hash
  return render(html`<${Root} api=${api} />`)
}

describe('Share as a card', () => {
  it('drafts from the runway explanation, publishes with amounts and the name off, then lists and revokes', async () => {
    const api = asOwner(new MockApi())
    let published: { amounts: boolean; name: boolean; vendors?: boolean } | null = null
    const publish = api.sharePublish.bind(api)
    api.sharePublish = async (id, opts) => ((published = opts), publish(id, opts))
    start(api, '#/?d=company:e_acme/explain:e_acme:runway')
    fireEvent.click(await screen.findByRole('button', { name: 'Share as a card' }))
    await screen.findByRole('heading', { name: 'Publish this card?' })
    expect(location.hash).toMatch(/explain:e_acme:runway\/share:/)
    expect(screen.getByRole('switch', { name: 'Show amounts' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('switch', { name: 'Show company name' }).getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    await screen.findByRole('heading', { name: 'Card is live' })
    expect(published).toEqual({ amounts: false, name: false, vendors: false })
    expect(screen.getByText(/Copies already shared elsewhere may linger briefly/)).toBeTruthy()

    location.hash = '#/preferences'
    await screen.findByRole('heading', { name: 'Shared links' })
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Shared links' })).toBeNull())
  })

  it('says the server’s reason when a card can’t be made (the daily limit)', async () => {
    const api = asOwner(new MockApi())
    api.shareDraft = async () => {
      throw new Error('That’s a lot of cards for one day. Try again tomorrow.')
    }
    start(api, '#/?d=company:e_acme/explain:e_acme:cash')
    fireEvent.click(await screen.findByRole('button', { name: 'Share as a card' }))
    await screen.findByText('That’s a lot of cards for one day. Try again tomorrow.')
  })

  it('is not offered to people who don’t manage the workspace, or on Personal', async () => {
    const api = new MockApi()
    api.s.me = { ...api.s.me, workspaces: [{ id: api.s.me.workspaceId, name: 'Demo', role: 'finance' }] }
    start(api, '#/?d=company:e_acme/explain:e_acme:runway')
    await screen.findByRole('heading', { name: 'How this is worked out' })
    expect(screen.queryByRole('button', { name: 'Share as a card' })).toBeNull()
  })

  it('roast: from the company drawer, vendor names off, no amounts offered; a refusal says why and offers only Discard', async () => {
    const api = asOwner(new MockApi())
    start(api, '#/?d=company:e_acme')
    fireEvent.click(await screen.findByRole('button', { name: 'Roast these books' }))
    await screen.findByRole('heading', { name: 'Publish this card?' })
    expect(screen.getByRole('switch', { name: 'Show vendor names' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByRole('switch', { name: 'Show amounts' })).toBeNull()
    api.sharePreview = async () => {
      throw new Error('Your books are too honest to roast today: a few things still need a look.')
    }
    location.hash = '#/?d=company:e_acme'
    fireEvent.click(await screen.findByRole('button', { name: 'Hype these books' }))
    await screen.findByText('Your books are too honest to roast today: a few things still need a look.')
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeTruthy()
  })

  it('a draft made here and closed unpublished is discarded; an AI’s draft is kept', async () => {
    const api = asOwner(new MockApi())
    start(api, '#/?d=company:e_acme/explain:e_acme:runway')
    fireEvent.click(await screen.findByRole('button', { name: 'Share as a card' }))
    await screen.findByRole('heading', { name: 'Publish this card?' })
    fireEvent.click(screen.getAllByRole('button', { name: /^Back|^Acme|How this is worked out/ })[0]!)
    await waitFor(async () => expect(await api.shareCards()).toHaveLength(0))
    const ai = await api.shareDraft('e_acme', 'runway')
    api.shares[0]!.source = 'Claude'
    location.hash = `#/?d=share:${ai.id}`
    await screen.findByRole('heading', { name: 'Publish this card?' })
    location.hash = '#/'
    await screen.findByRole('region', { name: 'Money' })
    expect((await api.shareCards()).map((c) => c.id)).toEqual([ai.id])
  })

  it('badge: only where badges are on; every figure off until turned on; live with the code to paste', async () => {
    const off = asOwner(new MockApi())
    start(off, '#/?d=company:e_acme')
    await screen.findByRole('button', { name: 'Roast these books' })
    expect(screen.queryByRole('button', { name: 'Get a verified badge' })).toBeNull()
    document.body.innerHTML = ''

    const api = asOwner(new MockApi())
    api.s.me = { ...api.s.me, badges: true }
    let published: unknown = null
    const publish = api.sharePublish.bind(api)
    api.sharePublish = async (id, opts) => ((published = opts), publish(id, opts))
    start(api, '#/?d=company:e_acme')
    fireEvent.click(await screen.findByRole('button', { name: 'Get a verified badge' }))
    await screen.findByRole('heading', { name: 'Publish this badge?' })
    for (const name of ['Show MRR', 'Show growth', 'Show runway', 'Show company name']) expect(screen.getByRole('switch', { name }).getAttribute('aria-checked')).toBe('false')
    expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('switch', { name: 'Show runway' }))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    await screen.findByRole('heading', { name: 'Badge is live' })
    expect(published).toEqual({ amounts: false, name: false, fields: ['runway'] })
    expect(screen.getByText('For a README')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'How we verify' })).toBeTruthy()
  })

  it('a phone’s share sheet: one "Share" button on a live card when the browser has one, never otherwise', async () => {
    const shared: ShareData[] = []
    const had = Object.getOwnPropertyDescriptor(navigator, 'share')
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (d: ShareData) => void shared.push(d) })
    // No image server here: the sheet gets the link alone, as on a browser that can't share files.
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch
    try {
      const api = asOwner(new MockApi())
      start(api, '#/?d=company:e_acme/explain:e_acme:runway')
      fireEvent.click(await screen.findByRole('button', { name: 'Share as a card' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Publish' }))
      await screen.findByRole('heading', { name: 'Card is live' })
      fireEvent.click(screen.getByRole('button', { name: 'Share' }))
      await waitFor(() => expect(shared).toHaveLength(1))
      expect(shared[0]).toMatchObject({ title: 'Runway', url: expect.stringMatching(/\/a\//) })
    } finally {
      globalThis.fetch = realFetch
      if (had) Object.defineProperty(navigator, 'share', had)
      else delete (navigator as { share?: unknown }).share
    }
    document.body.innerHTML = ''
    const api = asOwner(new MockApi())
    start(api, '#/?d=company:e_acme/explain:e_acme:runway')
    fireEvent.click(await screen.findByRole('button', { name: 'Share as a card' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }))
    await screen.findByRole('heading', { name: 'Card is live' })
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull()
  })
})

