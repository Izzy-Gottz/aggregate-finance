// Guides (docs/guides/*.md at /docs/guides/<slug>) and the hosted sitemap: only files read at boot are served, links are
// rewritten to this site or the public repo, and nothing outside that one directory is reachable.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { boot } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { GUIDES_REPO_DOCS, guideLinks, loadGuides, publicDocLinks, renderLegal } from './legal.ts'

describe('guides', () => {
  it('rewrites links to other guides, public docs and repo docs; leaves the rest alone', () => {
    const md = [
      '[a](connect-xero-to-claude.md)',
      '[b](README.md#comparisons)',
      '[c](../connect-your-ai.md)',
      '[d](../self-hosting.md#fly)',
      '[r](../recipes.md#1-runway)',
      '[e](https://example.com/x.md)',
      '[f](../../etc/passwd.md)',
      '[g](#top)',
    ].join('\n')
    expect(guideLinks(md).split('\n')).toEqual([
      '[a](/docs/guides/connect-xero-to-claude)',
      '[b](/docs/guides#comparisons)',
      '[c](/docs/connect-your-ai)',
      `[d](${GUIDES_REPO_DOCS}self-hosting.md#fly)`,
      '[r](/docs/recipes#1-runway)',
      '[e](https://example.com/x.md)',
      '[f](../../etc/passwd.md)',
      '[g](#top)',
    ])
  })

  it('links public docs to each other, and other repo docs to GitHub', () => {
    expect(publicDocLinks('[a](connect-your-ai.md) [b](./recipes.md#x) [c](self-hosting.md) [e](https://x.example)')).toBe(
      `[a](/docs/connect-your-ai) [b](/docs/recipes#x) [c](${GUIDES_REPO_DOCS}self-hosting.md) [e](https://x.example)`,
    )
  })

  it('never shows <!-- editor notes --> on a page', () => {
    const html = renderLegal('---\ntitle: T\n---\n\nAlpha\n\n<!-- Code: `fn` in\npackages/core/src/x.ts. -->\n\nBeta').html
    expect(html).toContain('Alpha')
    expect(html).toContain('Beta')
    expect(html).not.toContain('packages/core')
    expect(html).not.toContain('&lt;!--')
  })

  it('renders paths on this site as links, never protocol-relative or javascript ones', () => {
    const html = renderLegal('---\ntitle: T\n---\n\n[ok](/docs/guides/x) [evil](//evil.example) [js](javascript:alert(1))').html
    expect(html).toContain('<a href="/docs/guides/x">ok</a>')
    expect(html).not.toContain('href="//evil.example"')
    expect(html).not.toContain('href="javascript:')
  })

  it('loads only plain slugs from the one directory: README is the index, _template and others are skipped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agfn-guides-'))
    writeFileSync(join(dir, 'README.md'), '# Guides\n\nSee [one](connect-one.md).\n')
    writeFileSync(join(dir, 'connect-one.md'), '# Connect one to Claude\n\nBody.\n')
    writeFileSync(join(dir, '_template.md'), '# Template\n')
    writeFileSync(join(dir, 'Notes.txt'), 'x')
    writeFileSync(join(dir, '.gitkeep'), '')
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'hidden.md'), '# Hidden\n')
    const guides = loadGuides(pathToFileURL(dir + '/'))
    expect([...guides.keys()].sort()).toEqual(['', 'connect-one'])
    expect(guides.get('connect-one')!.title).toBe('Connect one to Claude')
    expect(guides.get('')!.html).toContain('<a href="/docs/guides/connect-one">one</a>')
    expect(loadGuides(pathToFileURL(join(dir, 'missing') + '/')).size).toBe(0)
  })

  it('serves no path outside the guide map, and the hosted sitemap lists the public pages', async () => {
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: 'https://money.example.com', WEB_DIST: '/nonexistent', AGFN_HOSTED: '1' }), runWorker: false }
    const booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => {} } })
    try {
      const app = createApp(booted.services)
      // An unknown slug is a 404; anything the slug pattern refuses falls through to the app shell (503 here: no web
      // build), never to a file read.
      expect((await app.request('/docs/guides/no-such-guide')).status).toBe(404)
      for (const p of ['/docs/guides/_template', '/docs/guides/..%2Flegal%2Fprivacy', '/docs/guides/README']) {
        const r = await app.request(p)
        expect(r.status, p).not.toBe(200)
        expect(await r.text(), p).not.toMatch(/Privacy|Template/)
      }
      const sm = await app.request('/sitemap.xml')
      expect(sm.status).toBe(200)
      expect(sm.headers.get('content-type')).toContain('application/xml')
      const xml = await sm.text()
      expect(xml).toContain('<loc>https://money.example.com/privacy</loc>')
      expect(xml).toContain('<loc>https://money.example.com/docs/connect-your-ai</loc>')
      expect(xml).toContain('<loc>https://money.example.com/docs/recipes</loc>')
      expect(xml).toContain('<loc>https://money.example.com/docs/connectors</loc>')
      expect((await app.request('/docs/connectors')).status).toBe(200)
      const recipes = await app.request('/docs/recipes')
      expect(recipes.status).toBe(200)
      expect(await recipes.text()).toContain('<a href="/docs/connect-your-ai">')
      // Every public page renders, and none shows an editor note.
      for (const loc of xml.match(/<loc>[^<]+<\/loc>/g)!) {
        const path = loc.slice('<loc>https://money.example.com'.length, -'</loc>'.length) || '/'
        if (path === '/') continue
        const r = await app.request(path)
        expect(r.status, path).toBe(200)
        expect(await r.text(), path).not.toContain('&lt;!--')
      }
    } finally {
      await booted.shutdown()
    }
  })

  it('the Disconnect URL pages for QuickBooks and Xero say what happened and how to reconnect; other providers have none', async () => {
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: 'https://money.example.com', WEB_DIST: '/nonexistent', AGFN_HOSTED: '1' }), runWorker: false }
    const booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => {} } })
    try {
      const app = createApp(booted.services)
      for (const [key, name] of [['quickbooks', 'QuickBooks'], ['xero', 'Xero']]) {
        const r = await app.request(`/disconnected/${key}`)
        expect(r.status).toBe(200)
        const text = await r.text()
        expect(text).toContain(`Aggregate is disconnected from ${name}`)
        expect(text).toContain(`Connect to ${name}`)
        expect(text).toContain('support@aggregate.finance')
        expect(text).toMatch(key === 'quickbooks' ? /deletes everything it brought in from QuickBooks/ : /Disconnect and delete its data/)
      }
      expect((await app.request('/disconnected/stripe')).status).not.toBe(200)
    } finally {
      await booted.shutdown()
    }
  })
})

