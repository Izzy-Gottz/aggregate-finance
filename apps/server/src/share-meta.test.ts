// Link previews: every public page carries a title, description and the quiet preview image at this server's address,
// and the app's HTML is the same fixed text for every URL (never anything from a workspace).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { boot } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'

describe('share previews', () => {
  it('public pages and the app shell carry preview tags pointing at this server, with fixed text only', async () => {
    const web = mkdtempSync(join(tmpdir(), 'agfn-web-'))
    writeFileSync(join(web, 'index.html'), readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8'))
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: 'https://money.example.com', WEB_DIST: web }), runWorker: false }
    const booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => {} } })
    try {
      const app = createApp(booted.services)
      for (const path of ['/privacy', '/terms', '/security', '/docs/connect-your-ai']) {
        const html = await (await app.request(path)).text()
        expect(html, path).toContain('<meta property="og:image" content="https://money.example.com/og.png">')
        expect(html, path).toMatch(/<meta property="og:title" content="[^"]+ · Aggregate">/)
        expect(html, path).toMatch(/<meta name="description" content="[^"]{20,}">/)
        expect(html, path).toContain(`<meta property="og:url" content="https://money.example.com${path}">`)
        expect(html, path).toContain('<meta name="twitter:card" content="summary_large_image">')
        expect(html, path).not.toMatch(/%AGFN_(BASE_URL|PATH)%/)
      }
      // The app shell: identical for every URL, whatever drawer or company the link points at.
      const a = await (await app.request('/')).text()
      const b = await (await app.request('/?d=company:e_secret')).text()
      expect(a).toBe(b)
      expect(a).toContain('<meta property="og:image" content="https://money.example.com/og.png" />')
      expect(a).toContain('<meta property="og:title" content="Aggregate" />')
      expect(a).toContain('<meta property="og:url" content="https://money.example.com/" />')
      expect(a).toContain('<meta name="twitter:card" content="summary_large_image" />')
      expect(a).not.toContain('%AGFN_BASE_URL%')
      // A missing file is a 404, never the app's HTML; a real one is served with its own type.
      for (const p of ['/nope.png', '/robots.txt', '/sitemap.xml', '/x/y.json']) expect((await app.request(p)).status, p).toBe(404)
      writeFileSync(join(web, 'og.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      const og = await app.request('/og.png')
      expect(og.status).toBe(200)
      expect(og.headers.get('content-type')).toBe('image/png')
      // Paths without an extension (OAuth returns, deep links) still get the app.
      expect((await app.request('/connect/plaid/oauth')).headers.get('content-type')).toMatch(/text\/html/)
    } finally {
      await booted.shutdown()
      rmSync(web, { recursive: true, force: true })
    }
  })
})
