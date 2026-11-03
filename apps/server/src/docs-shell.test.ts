// The public docs' frame: the connections list, brand rules, the home page, search and the header's script.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { boot } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { connectionsBody, DOCS_JS_PATH, DOCS_NAV, DOCS_SEARCH_PATH, hostedConnections } from './docs-shell.ts'
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
    expect(html).not.toMatch(/official|certified/i)
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
