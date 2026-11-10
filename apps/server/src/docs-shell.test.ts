// The public docs' frame: the connections list, brand rules, the home page, search and the header's script.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { boot } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { connectionsBody, DOCS_JS_PATH, ETSY_TRADEMARK_NOTICE, DOCS_NAV, DOCS_SEARCH_PATH, hostedConnections } from './docs-shell.ts'
import { renderMarkdown } from './legal.ts'

const md = readFileSync(new URL('../../../docs/connectors.md', import.meta.url), 'utf8')
const BASE = 'https://money.example.com'

async function withApp(run: (app: ReturnType<typeof createApp>) => Promise<void>) {
  const config = loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent', AGFN_HOSTED: '1' })
  const booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => {} } })
  try {
    await run(createApp(booted.services))
  } finally {
    await booted.shutdown()
  }
}

describe('the connections page', () => {
  const names = hostedConnections(md).flatMap((s) => s.rows.map((r) => r.name))

  it('lists exactly the 17 hosted connections the homepage counts, never Xero', () => {
    expect(names).toHaveLength(17)
    expect(names).not.toContain('Xero')
    expect(names).toEqual(expect.arrayContaining(['Plaid', 'Stripe', 'QuickBooks Online', 'Wefunder', 'Google Play']))
  })

  it('shows an icon only where given one, a letter otherwise, and the logo notice', () => {
    const html = connectionsBody(md, renderMarkdown, { Plaid: 'data:image/png;base64,AA' })
    expect(html).toContain('<img src="data:image/png;base64,AA"')
    expect(html.match(/<img /g)).toHaveLength(1)
    expect(html).toContain('>S</span><b>Stripe</b>')
    expect(html).toContain('Logos belong to their owners')
    expect(html).not.toMatch(/Xero/)
  })

  it('puts the Stripe Partner badge under the list, and Stripe keeps its letter tile', () => {
    const html = connectionsBody(md, renderMarkdown, { 'Stripe Partner badge': 'data:image/png;base64,BB' })
    expect(html).toContain('Aggregate is a Stripe partner.<img src="data:image/png;base64,BB" alt="Stripe Partner"')
    expect(html).toContain('>S</span><b>Stripe</b>')
    // Our own words never claim to be official or certified. The one exception is Etsy's required trademark notice, word for
    // word (Etsy API Terms), which says the opposite.
    expect(html.replace(ETSY_TRADEMARK_NOTICE, '')).not.toMatch(/official|certified/i)
  })

  it("shows Etsy's trademark notice word for word once Etsy is listed, and only then", () => {
    expect(connectionsBody(md, renderMarkdown, {})).not.toContain('trademark of Etsy')
    const listed = md.replace(/^(\| Etsy \|.*\| )In development( \|)$/m, '$1Beta$2')
    expect(listed).not.toBe(md)
    const html = connectionsBody(listed, renderMarkdown, {})
    expect(html).toContain(`</h1>\n<p class="dnotice">${ETSY_TRADEMARK_NOTICE}</p>`)
    expect(html.replace(ETSY_TRADEMARK_NOTICE, '')).not.toMatch(/official|certified/i)
  })
})

describe('the Etsy page (/docs/etsy)', () => {
  it('says plainly what it reads and keeps, and how fresh it is; docs search finds it', async () => {
    await withApp(async (app) => {
      const r = await app.request(`${BASE}/docs/etsy`)
      expect(r.status).toBe(200)
      const text = (await r.text()).replace(/<[^>]+>/g, ' ').replace(/&#39;|&rsquo;|’/g, "'").replace(/\s+/g, ' ')
      expect(text).toContain(ETSY_TRADEMARK_NOTICE)
      expect(text).toContain("Aggregate doesn't request access to buyer emails and never stores them")
      expect(text).toContain('the database enforces this with row-level security')
      expect(text).toContain('Etsy data refreshes at least every 24 hours')
      expect(text).toContain('left out until the next successful sync')
      expect(text).toContain('Closed past months stay as recorded')
      expect(text).toContain('You can ask your own AI assistant about your own books')
      expect(text).not.toMatch(/aggregat(or|ion)/i)
      // Found by docs search (it isn't on the hosted connections list while Etsy isn't offered).
      expect(JSON.stringify(await (await app.request(`${BASE}${DOCS_SEARCH_PATH}`)).json())).toContain('/docs/etsy')
    })
  })
})

describe('the docs pages', () => {
  it('the home, header and sidebar are on every page; old URLs answer', async () => {
    await withApp(async (app) => {
      for (const p of ['/docs', '/docs/connectors', '/docs/connect-your-ai', '/docs/recipes', '/docs/guides', '/docs/guides/connect-claude', '/docs/api']) {
        const r = await app.request(`${BASE}${p}`)
        expect(r.status, p).toBe(200)
        const html = await r.text()
        expect(html, p).toContain('aria-label="Search the docs"')
        expect(html, p).toContain('<summary>Connect your AI</summary>')
        expect(html, p).toContain(`<script src="${DOCS_JS_PATH}"`)
        expect(html, p).not.toContain('%AGFN_')
      }
    })
  })

  it('every internal sidebar link is a page', async () => {
    await withApp(async (app) => {
      for (const { href } of DOCS_NAV.flatMap((g) => g.items).filter((i) => i.href.startsWith('/'))) expect((await app.request(`${BASE}${href}`)).status, href).toBe(200)
    })
  })

  it('search reads titles and headings; the script is served as a script', async () => {
    await withApp(async (app) => {
      const index = (await (await app.request(`${BASE}${DOCS_SEARCH_PATH}`)).json()) as Array<{ path: string; title: string; headings: Array<{ id: string; text: string }> }>
      expect(index.find((p) => p.path === '/docs/guides/connect-claude')?.headings).toContainEqual({ id: 'desktop-and-web', text: 'Desktop and web' })
      const js = await app.request(`${BASE}${DOCS_JS_PATH}`)
      expect(js.headers.get('content-type')).toContain('javascript')
      // Search results come from page headings: built as text nodes, never parsed as HTML.
      expect(await js.text()).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/)
    })
  })
})
