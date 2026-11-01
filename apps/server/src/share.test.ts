// Share cards: drafts aren't public, publishing freezes ratios only (no amounts, no name) unless turned on, revoking
// answers 410, other workspaces can't touch a card, and creation is rate-limited per workspace.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { createDemoConnector } from '@agfn/connector-demo'
import { MemoryFileStore } from '@agfn/files'
import { createDemoWorkspace } from '@agfn/demo'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { loadInstalledModules } from './modules.ts'
import { cardWords, compactMoney, makeSharePort, SHARE_LIMIT, type ShareSnapshot } from './share.ts'

const BASE = 'http://localhost:8787'
let booted: Booted
let app: ReturnType<typeof createApp>
const outbox: string[] = []
let ws = ''
let company = ''
let cookie = ''

async function signIn(email: string): Promise<string> {
  await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
  const link = outbox.at(-1)!.match(/https?:\/\/\S+/)![0]
  const res = await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}
const headers = (ck: string, w = ws) => ({ 'content-type': 'application/json', origin: BASE, cookie: ck, 'x-agfn-workspace': w })
const post = (path: string, body: unknown = {}, ck = cookie, w = ws) => app.request(path, { method: 'POST', headers: headers(ck, w), body: JSON.stringify(body) })
const get = (path: string, ck = cookie, w = ws) => app.request(path, { headers: headers(ck, w) })

beforeAll(async () => {
  const modules = await loadInstalledModules({})
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push(m.text) }, ledger: modules.ledger, mcp: modules.mcp, connectors: [(d) => createDemoConnector(d)], fileStore: new MemoryFileStore() })
  app = createApp(booted.services)
  const s = booted.services
  cookie = await signIn('owner@example.com')
  const person = await s.db.selectFrom('people').select('id').where('email', '=', 'owner@example.com').executeTakeFirstOrThrow()
  const demo = await createDemoWorkspace({ db: s.db, keys: s.keys }, { personId: person.id, historyDays: 120 })
  ws = demo.workspaceId
  for (const id of demo.connections) {
    await s.sync.sync(id)
    await s.db.deleteFrom('jobs').where('workspace_id', '=', ws).execute()
  }
  company = demo.entities.find((e) => e.name === 'Northwind Labs')!.id
}, 120_000)
afterAll(() => booted?.shutdown())

describe('share cards', () => {
  it('a draft is private; publishing freezes ratios only; the page and images are public until revoked', async () => {
    const made = await post('/api/share', { entityId: company, kind: 'runway' })
    expect(made.status).toBe(200)
    const { id } = (await made.json()) as { id: string }
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    // Nothing public before the person publishes.
    expect((await app.request(`/a/${id}`)).status).toBe(404)
    expect((await app.request(`/a/${id}/og.png`)).status).toBe(404)

    // The confirm sheet: what it would show, and the image.
    const pv = (await (await post(`/api/share/${id}/preview`, {})).json()) as { card: ShareSnapshot; words: { big: string } }
    expect(pv.card.kind).toBe('runway')
    expect(pv.card).not.toHaveProperty('cash')
    expect(pv.card).not.toHaveProperty('company')
    const img = await get(`/api/share/${id}/preview.png`)
    expect(img.headers.get('content-type')).toBe('image/png')
    expect(img.headers.get('cache-control')).toContain('no-store')

    const pub = (await (await post(`/api/share/${id}/publish`, {})).json()) as { url: string; card: ShareSnapshot }
    expect(pub.url).toBe(`${BASE}/a/${id}`)
    const stored = await booted.services.db.selectFrom('share_cards' as never).selectAll().where('id' as never, '=', id as never).executeTakeFirstOrThrow() as { snapshot: string; workspace_id: string; created_by: string }
    expect(stored.workspace_id).toBe(ws)
    expect(stored.created_by).toBeTruthy()
    expect(stored.snapshot).not.toMatch(/\$|Northwind/)

    const page = await app.request(`/a/${id}`)
    expect(page.status).toBe(200)
    expect(page.headers.get('cache-control')).toBe('public, max-age=300')
    expect(page.headers.get('x-robots-tag')).toContain('noindex')
    const html = await page.text()
    expect(html).toContain(`<meta property="og:image" content="${BASE}/a/${id}/og.png">`)
    expect(html).toContain('<meta name="robots" content="noindex,nofollow">')
    // On a phone the page shows the square image, whose words are big enough to read there.
    expect(html).toContain(`<source media="(max-width: 600px)" srcset="/a/${id}/card.png"`)
    expect(html).toContain('Ask your AI about your own finances →')
    expect(html).toContain('A company')
    expect(html).not.toMatch(/\$|Northwind/)
    for (const f of ['og.png', 'card.png']) {
      const png = await app.request(`/a/${id}/${f}`)
      expect(png.status, f).toBe(200)
      expect([...new Uint8Array(await png.arrayBuffer()).slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    }
    // Published once; listed for Settings → Shared links.
    expect((await post(`/api/share/${id}/publish`, {})).status).toBe(409)
    const list = (await (await get('/api/share')).json()) as { cards: Array<{ id: string; status: string; url: string | null; company: string }> }
    expect(list.cards.find((c) => c.id === id)).toMatchObject({ status: 'live', url: `${BASE}/a/${id}`, company: 'Northwind Labs' })

    // Revoke: 410 at once, images too, and gone from the list.
    expect((await post(`/api/share/${id}/revoke`)).status).toBe(200)
    expect((await app.request(`/a/${id}`)).status).toBe(410)
    expect((await app.request(`/a/${id}/og.png`)).status).toBe(410)
    expect(((await (await get('/api/share')).json()) as { cards: Array<{ id: string }> }).cards.map((c) => c.id)).not.toContain(id)
  }, 60_000)

  it('amounts and the name appear only when turned on', async () => {
    const { id } = (await (await post('/api/share', { entityId: company, kind: 'cash_trend' })).json()) as { id: string }
    const pub = (await (await post(`/api/share/${id}/publish`, { amounts: true, name: true })).json()) as { card: ShareSnapshot }
    expect(pub.card.company).toBe('Northwind Labs')
    expect(pub.card.cash).toMatch(/^\$/)
    expect(pub.card.points).toHaveLength(12)
    for (const p of pub.card.points!) expect(p >= 0 && p <= 1).toBe(true)
    const html = await (await app.request(`/a/${id}`)).text()
    expect(html).toContain('Northwind Labs')
  }, 60_000)

  it('another workspace can neither see nor touch a card, and a draft from an AI goes through the same publish', async () => {
    const { id } = (await (await post('/api/share', { entityId: company, kind: 'runway' })).json()) as { id: string }
    const other = await signIn('other@example.com')
    const otherWs = ((await (await app.request('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie: other }, body: JSON.stringify({ companyName: 'Other Co' }) })).json()) as { workspaceId?: string; id?: string })
    const ow = otherWs.workspaceId ?? otherWs.id ?? ''
    expect((await post(`/api/share/${id}/publish`, {}, other, ow)).status).toBe(404)
    expect((await post(`/api/share/${id}/revoke`, {}, other, ow)).status).toBe(404)
    expect((await post('/api/share', { entityId: company, kind: 'runway' }, other, ow)).status).toBe(404)
    // A random id is a plain 404.
    expect((await app.request('/a/AAAAAAAAAAAAAAAAAAAAAA')).status).toBe(404)
    expect((await app.request('/a/not-an-id')).status).toBe(404)

    const person = await booted.services.db.selectFrom('people').select('id').where('email', '=', 'owner@example.com').executeTakeFirstOrThrow()
    const draft = await makeSharePort(booted.services, BASE).draft({ workspaceId: ws, personId: person.id, entityId: company, kind: 'runway', source: 'Claude' })
    expect(draft.reviewUrl).toBe(`${BASE}/#/?d=share:${draft.id}`)
    expect((await app.request(`/a/${draft.id}`)).status).toBe(404)
    const list = (await (await get('/api/share')).json()) as { cards: Array<{ id: string; status: string; source: string }> }
    expect(list.cards.find((c) => c.id === draft.id)).toMatchObject({ status: 'draft', source: 'Claude' })
    // Revoking a draft deletes it.
    await post(`/api/share/${draft.id}/revoke`)
    expect(((await (await get('/api/share')).json()) as { cards: Array<{ id: string }> }).cards.map((c) => c.id)).not.toContain(draft.id)
  }, 60_000)

  it('creation is limited per workspace per day', async () => {
    let last = 200
    for (let i = 0; i < SHARE_LIMIT.count + 1 && last !== 429; i++) last = (await post('/api/share', { entityId: company, kind: 'runway' })).status
    expect(last).toBe(429)
  }, 60_000)
})

describe('card words', () => {
  const base: ShareSnapshot = { kind: 'runway', asOf: '2026-10-11', reconciled: true, months: 18 }
  it('says months, not burning, and a hidden name', () => {
    expect(cardWords(base)).toMatchObject({ big: '18', unit: 'months of runway', line: 'A company · as of Oct 11, 2026' })
    expect(cardWords({ ...base, months: 1 }).unit).toBe('month of runway')
    expect(cardWords({ ...base, months: null }).big).toBe('Not burning')
    expect(cardWords({ kind: 'cash_trend', asOf: '2026-10-11', reconciled: false, points: [0, 1], changePct: 34 }).big).toBe('+34%')
    expect(cardWords({ kind: 'cash_trend', asOf: '2026-10-11', reconciled: false, points: [0, 1], changePct: -5, cash: '$1.2M', company: 'Acme' })).toMatchObject({ big: '$1.2M', line: 'Acme · as of Oct 11, 2026 · −5% over 12 months' })
  })
  it('compacts money', () => {
    expect(compactMoney({ minor: 123_456_700, currency: 'USD' })).toBe('$1.2M')
    expect(compactMoney({ minor: 8_000_000, currency: 'USD' })).toBe('$80K')
    expect(compactMoney({ minor: 950_00, currency: 'USD' })).toBe('$950')
    expect(compactMoney({ minor: 2_500_000_000_00, currency: 'EUR' })).toBe('€2.5B')
  })
})
