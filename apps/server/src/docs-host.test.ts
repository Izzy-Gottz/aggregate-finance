// docs.aggregate.finance: clean paths on the host, the same pages, no /docs/docs, old URLs moved for good.
import { describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { boot } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { docsPath, forDocsHost } from './docs-host.ts'

const HOST = 'docs.money.example.com'
const BASE = 'https://money.example.com'

async function withApp(env: Record<string, string>, run: (app: ReturnType<typeof createApp>) => Promise<void>) {
  const config = loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent', AGFN_HOSTED: '1', ...env })
  const booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => {} } })
  try {
    await run(createApp(booted.services))
  } finally {
    await booted.shutdown()
  }
}
const on = (app: ReturnType<typeof createApp>, path: string, init: RequestInit = {}) => app.request(`http://${HOST}${path}`, { ...init, redirect: 'manual', headers: { host: HOST } })

describe('forDocsHost', () => {
  it('turns app links into the host’s own, and the canonical into the host', () => {
    const html = forDocsHost(`<link rel="canonical" href="${BASE}/docs/recipes"><a href="/">Aggregate</a><a href="/docs/connectors">c</a><a href="/docs/guides/x#y">g</a><a href="/docs/guides">a</a><a href="/privacy">p</a><link rel="icon" href="/favicon.ico">`, BASE, HOST)
    expect(html).toContain(`<link rel="canonical" href="https://${HOST}/recipes">`)
    expect(html).toContain('<a href="/connectors">')
    expect(html).toContain('<a href="/guides/x#y">')
    expect(html).toContain('<a href="/guides">')
    expect(html).toContain(`<a href="${BASE}/privacy">`)
    expect(html).toContain(`<a href="${BASE}/">Aggregate</a>`)
    expect(html).toContain('href="/favicon.ico"')
    expect(html).not.toContain('/docs/')
  })
  it('maps paths', () => {
    expect(docsPath('/')).toBe('/docs/guides')
    expect(docsPath('/guides/connect-claude')).toBe('/docs/guides/connect-claude')
  })
})

describe('the docs host', () => {
  it('serves clean paths from the same pages, with no way back to /docs on the page', async () => {
    await withApp({ AGFN_DOCS_HOST: HOST }, async (app) => {
      for (const p of ['/', '/connectors', '/recipes', '/connect-your-ai', '/guides', '/guides/connect-claude', '/api']) {
        const r = await on(app, p)
        expect(r.status, p).toBe(200)
        const html = await r.text()
        expect(html, p).not.toMatch(/href="\/docs/)
        expect(html, p).not.toContain(`${BASE}/docs`)
      }
      expect(await (await on(app, '/connectors')).text()).toContain(`https://${HOST}/connectors`)
    })
  })

  it('a /docs path on the host moves to the clean one; an unknown path is a 404; app pages go to the app', async () => {
    await withApp({ AGFN_DOCS_HOST: HOST }, async (app) => {
      const old = await on(app, '/docs/guides/connect-claude')
      expect(old.status).toBe(301)
      expect(old.headers.get('location')).toBe('/guides/connect-claude')
      expect((await on(app, '/no-such-page')).status).toBe(404)
      expect((await on(app, '/api/workspace')).status).toBe(404)
      expect((await on(app, '/mcp', { method: 'POST' })).status).toBe(404)
      const p = await on(app, '/privacy')
      expect(p.status).toBe(301)
      expect(p.headers.get('location')).toBe(`${BASE}/privacy`)
    })
  })

  it('the app’s /docs moves there for good, query kept; the app’s own pages and API stay; each host has its sitemap', async () => {
    await withApp({ AGFN_DOCS_HOST: HOST }, async (app) => {
      const r = await app.request(`${BASE}/docs/guides/connect-claude?x=1`, { redirect: 'manual' })
      expect(r.status).toBe(301)
      expect(r.headers.get('location')).toBe(`https://${HOST}/guides/connect-claude?x=1`)
      const root = await app.request(`${BASE}/docs/guides`, { redirect: 'manual' })
      expect(root.headers.get('location')).toBe(`https://${HOST}/guides`)
      expect((await app.request(`${BASE}/privacy`)).status).toBe(200)
      const appMap = await (await app.request(`${BASE}/sitemap.xml`)).text()
      expect(appMap).toContain(`${BASE}/privacy`)
      expect(appMap).not.toContain('/docs/')
      const docsMap = await (await on(app, '/sitemap.xml')).text()
      expect(docsMap).toContain(`<loc>https://${HOST}/connectors</loc>`)
      expect(docsMap).toContain(`<loc>https://${HOST}/guides/connect-claude</loc>`)
      expect(docsMap).not.toContain('/docs/')
    })
  })

  it('unset, nothing changes', async () => {
    await withApp({}, async (app) => {
      expect((await app.request(`${BASE}/docs/connectors`)).status).toBe(200)
      expect(await (await app.request(`${BASE}/sitemap.xml`)).text()).toContain(`${BASE}/docs/connectors`)
    })
  })
})
