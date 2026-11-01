// Badges: off unless AGFN_BADGES; each figure opt-in; MRR only as a band; refused unless Aggregate can vouch for the
// books; live at /b/<id> and checked again once a day, turning "Not current" (with the last verified figures) when
// the books stop checking out; revoke is 410 at once; a card id is never a badge and a badge is never a card.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MetricAnswer } from '@agfn/contracts'
import type { VerifiedBadges } from '@agfn/core'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { createDemoConnector } from '@agfn/connector-demo'
import { MemoryFileStore } from '@agfn/files'
import { createDemoWorkspace } from '@agfn/demo'
import { badgeFigures, badgeSvg, howWeVerifyPage, liveBadge, mrrBand, NOT_AVAILABLE } from './badge.ts'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { loadInstalledModules } from './modules.ts'
import { draftShare, makeSharePort, previewShare, publishShare, revokeShare, ShareError, type ShareRow, type ShareSnapshot } from './share.ts'

describe('badge words', () => {
  it('MRR is a band, never the figure', () => {
    expect(mrrBand(420)).toBe('Under $1K')
    expect(mrrBand(12_480)).toBe('$10K–$25K')
    expect(mrrBand(250_000)).toBe('$250K–$500K')
    expect(mrrBand(3_200_000)).toBe('$1M+')
  })

  const v: VerifiedBadges = {
    workspaceId: 'w' as never,
    entityId: 'e' as never,
    asOf: '2026-09-30',
    verified: true,
    reasons: [],
    badges: [
      { key: 'mrr', label: 'MRR', display: '$12,480', state: 'ok', value: { minor: 12_480_00, currency: 'USD' }, formula: '' },
      { key: 'growth', label: 'MRR growth', display: '+8.2% in 3 months', state: 'ok', value: 0.082, formula: 'MRR on 2026-09-30 ($12,480) ÷ …' },
      { key: 'runway', label: 'Runway', display: '12–24 months', state: 'ok', value: 15.3, band: '12–24 months', formula: '' },
    ],
  }

  it('shows only the figures turned on, in whole percents and bands', () => {
    expect(badgeFigures(v, ['runway'])).toEqual([{ key: 'runway', label: 'Runway', display: '12–24 months' }])
    expect(badgeFigures(v, ['mrr', 'growth', 'runway'])).toEqual([
      { key: 'mrr', label: 'MRR', display: '$10K–$25K' },
      { key: 'growth', label: 'MRR growth', display: '+8% in 3 months' },
      { key: 'runway', label: 'Runway', display: '12–24 months' },
    ])
    // The exact MRR and the growth formula (which names MRR amounts) never reach a badge.
    expect(JSON.stringify(badgeFigures(v, ['mrr', 'growth', 'runway']))).not.toMatch(/12,480|15\.3|formula/)
  })

  it('the embed is an escaped SVG; grey and "Not current" when the books stopped checking out', () => {
    const snap: ShareSnapshot = { kind: 'badge', asOf: '2026-09-30', reconciled: true, company: 'A<b>&Co', badges: badgeFigures(v, ['mrr', 'runway']), current: true }
    const svg = badgeSvg(snap)
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/)
    expect(svg).toContain('Verified by Aggregate')
    expect(svg).toContain('MRR $10K–$25K · Runway 12–24 months')
    expect(svg).not.toContain('<b>')
    expect(svg).not.toMatch(/<script|on\w+=/i)
    const stale = badgeSvg({ ...snap, current: false })
    expect(stale).toContain('Not current')
    expect(stale).toContain('#8C8587')
  })

  it('How we verify says what Verified means and what it doesn’t', () => {
    const page = howWeVerifyPage()
    for (const t of ['every reconciliation check passes', 'nothing is waiting for review', 'no month of statements is missing', 'within the last day', 'more than a week', 'two complete months', 'Not current', 'not an audit', 'never by an AI assistant', 'Not available']) expect(page).toContain(t)
  })
})

const BASE = 'http://localhost:8787'
let booted: Booted
let ws = ''
let company = ''
let personId = ''

/** The engine, with what verifiedBadges reads replaced: a company with $12.5K MRR, growing, 15 months of runway. */
function fakeLedger(state: { failing: boolean; noMrr?: boolean }) {
  const real = booted.services.ledger as unknown as Record<string, unknown>
  const answer = (value: MetricAnswer['value'], extra: Partial<MetricAnswer> = {}) => ({ value, state: 'ok', asOf: '2026-09-30', formula: 'Cash ÷ average net burn.', staleSources: [], ...extra }) as unknown as MetricAnswer
  return {
    ...booted.services,
    ledger: Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      now: () => '2026-10-12T12:00:00.000Z',
      metric: async (name: string, scope: { to?: string }) =>
        name === 'mrr' ? (state.noMrr ? answer({ minor: 0, currency: 'USD' }) : answer({ minor: scope.to === '2026-09-30' ? 12_480_00 : 11_000_00, currency: 'USD' })) : name === 'runway' ? answer(15.3) : answer({ minor: 0, currency: 'USD' }),
      dataHealth: async () => ({ status: state.failing ? 'needs_review' : 'ok', line: '', counts: { failedChecks: state.failing ? 1 : 0 }, items: state.failing ? [{ kind: 'failed_check', entityId: company }] : [] }),
    }),
  } as typeof booted.services
}

beforeAll(async () => {
  const modules = await loadInstalledModules({})
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => {} }, ledger: modules.ledger, mcp: modules.mcp, connectors: [(d) => createDemoConnector(d)], fileStore: new MemoryFileStore() })
  const s = booted.services
  personId = 'p_badge'
  await s.db.insertInto('people').values({ id: personId, auth_user_id: null, name: 'Owner', email: 'owner@example.com', created_at: new Date().toISOString() }).execute()
  const demo = await createDemoWorkspace({ db: s.db, keys: s.keys }, { personId, historyDays: 120 })
  ws = demo.workspaceId
  company = demo.entities.find((e) => e.name === 'Northwind Labs')!.id
}, 120_000)
afterAll(() => booted?.shutdown())

describe('badges, end to end', () => {
  it('each figure is opt-in; refused while the books don’t check out; published at /b/<id>; checked again daily', async () => {
    const health = { failing: false }
    const s = fakeLedger(health)
    const { id } = await draftShare(s, { workspaceId: ws, personId, entityId: company, kind: 'badge', source: 'app' })
    await expect(previewShare(s, ws, personId, id, { amounts: false, name: false })).rejects.toThrow(/at least one figure/)

    health.failing = true
    await expect(previewShare(s, ws, personId, id, { amounts: false, name: false, fields: ['runway'] })).rejects.toThrow(/can’t vouch for these books today: 1 reconciliation check failing/)
    health.failing = false

    const prev = await previewShare(s, ws, personId, id, { amounts: false, name: false, fields: ['mrr', 'runway'] })
    expect(prev.badges).toEqual([
      { key: 'mrr', label: 'MRR', display: '$10K–$25K' },
      { key: 'runway', label: 'Runway', display: '12–24 months' },
    ])
    expect(prev).not.toHaveProperty('company')
    expect(prev).not.toHaveProperty('cash')

    // Nothing public before publishing.
    expect(await liveBadge(s, id)).toBeNull()
    const snap = await publishShare(s, ws, personId, id, { amounts: true, name: true, fields: ['mrr', 'runway'] })
    expect(snap).toMatchObject({ kind: 'badge', company: 'Northwind Labs', current: true, asOf: '2026-09-30' })
    expect(snap).not.toHaveProperty('cash')
    const live = await liveBadge(s, id)
    expect(live).toMatchObject({ status: 'live', snapshot: { current: true } })

    // The next day the books stop checking out: grey, "Not current", the last verified figures kept.
    const row = s.db as unknown as import('kysely').Kysely<{ share_cards: ShareRow }>
    await row.updateTable('share_cards').set({ snapshot: JSON.stringify({ ...snap, checkedAt: '2026-10-01T00:00:00.000Z' }) }).where('id', '=', id).execute()
    health.failing = true
    const stale = await liveBadge(s, id)
    expect(stale).toMatchObject({ status: 'live', snapshot: { current: false, badges: snap.badges } })
    expect((stale as { snapshot: ShareSnapshot }).snapshot.checkedAt!.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10))

    // And when they check out again the next day, it's current again.
    await row.updateTable('share_cards').set({ snapshot: JSON.stringify({ ...(stale as { snapshot: ShareSnapshot }).snapshot, checkedAt: '2026-10-02T00:00:00.000Z' }) }).where('id', '=', id).execute()
    health.failing = false
    expect(await liveBadge(s, id)).toMatchObject({ snapshot: { current: true } })

    await revokeShare(s, ws, id)
    expect(await liveBadge(s, id)).toEqual({ status: 'revoked' })
  }, 60_000)

  it('the routes: off without AGFN_BADGES; with it, /b/<id>, the .svg, How we verify; a card is never a badge', async () => {
    const s = fakeLedger({ failing: false })
    const off = createApp(s)
    // Off, the paths fall through to the web app (503 here, with no web build): never a badge.
    expect((await off.request('/how-we-verify')).status).not.toBe(200)

    const on = createApp({ ...s, config: { ...s.config, badges: true } })
    expect((await on.request('/how-we-verify')).status).toBe(200)
    const { id } = await draftShare(s, { workspaceId: ws, personId, entityId: company, kind: 'badge', source: 'app' })
    expect((await on.request(`/b/${id}`)).status).toBe(404)
    await publishShare(s, ws, personId, id, { amounts: false, name: false, fields: ['runway'] })
    const page = await on.request(`/b/${id}`)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('A company')
    expect(html).toContain('12–24 months')
    expect(html).toContain('href="/how-we-verify"')
    expect(html).not.toContain('Northwind')
    const svg = await on.request(`/b/${id}.svg`)
    expect(svg.status).toBe(200)
    expect(svg.headers.get('content-type')).toBe('image/svg+xml')
    expect(await svg.text()).toContain('Runway 12–24 months')
    // A badge isn't a card, and a card isn't a badge.
    expect((await on.request(`/a/${id}`)).status).toBe(404)
    const card = await draftShare(s, { workspaceId: ws, personId, entityId: company, kind: 'runway', source: 'app' })
    await publishShare(s, ws, personId, card.id, { amounts: false, name: false }).catch(() => {})
    expect((await on.request(`/b/${card.id}`)).status).toBe(404)
    await revokeShare(s, ws, id)
    expect((await on.request(`/b/${id}`)).status).toBe(410)
    expect((await on.request(`/b/${id}.svg`)).status).toBe(410)
  }, 60_000)

  it('an AI can’t draft a badge: it’s the owner’s act in the app', async () => {
    const err = await makeSharePort(fakeLedger({ failing: false }), BASE).draft({ workspaceId: ws, personId, entityId: company, kind: 'badge', source: 'Claude' }).catch((e: Error) => e)
    expect(err).toBeInstanceOf(ShareError)
    expect((err as ShareError).message).toMatch(/in the Aggregate app/)
  })

  it('a figure that isn’t known can’t be published; one that stops being known later shows "Not available" alone', async () => {
    const state = { failing: false, noMrr: true }
    const s = fakeLedger(state)
    const { id } = await draftShare(s, { workspaceId: ws, personId, entityId: company, kind: 'badge', source: 'app' })
    await expect(publishShare(s, ws, personId, id, { amounts: false, name: false, fields: ['mrr', 'runway'] })).rejects.toThrow(/MRR isn’t known yet: .*Turn it off to publish the rest/)
    state.noMrr = false
    const snap = await publishShare(s, ws, personId, id, { amounts: false, name: false, fields: ['mrr', 'runway'] })
    const row = s.db as unknown as import('kysely').Kysely<{ share_cards: ShareRow }>
    await row.updateTable('share_cards').set({ snapshot: JSON.stringify({ ...snap, checkedAt: '2026-10-01T00:00:00.000Z' }) }).where('id', '=', id).execute()
    state.noMrr = true
    const live = (await liveBadge(s, id)) as { snapshot: ShareSnapshot }
    expect(live.snapshot.current).toBe(true)
    expect(live.snapshot.badges).toEqual([
      { key: 'mrr', label: 'MRR', display: NOT_AVAILABLE },
      { key: 'runway', label: 'Runway', display: '12–24 months' },
    ])
    await revokeShare(s, ws, id)
  })
})
