import { describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { boot } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findLegalFonts, renderLegal, renderMarkdown } from './legal.ts'

describe('legal pages', () => {
  it('serve /privacy and /terms publicly, final and indexable (approved 2026-10-11)', async () => {
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: 'http://localhost:8787', WEB_DIST: '/nonexistent' }), runWorker: false }
    const booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => {} } })
    try {
      const app = createApp(booted.services)
      for (const [path, title] of [['/privacy', 'Privacy Policy'], ['/terms', 'Terms of Service']]) {
        const r = await app.request(path!)
        expect(r.status, path).toBe(200)
        expect(r.headers.get('content-type')).toMatch(/text\/html/)
        const html = await r.text()
        expect(html).toMatch(new RegExp(`<h1 id="[a-z-]+">${title}</h1>`))
        expect(html).not.toContain('not yet in effect')
        expect(html).not.toContain('noindex')
      }
      expect(await (await app.request('/privacy')).text()).toContain('<a href="https://plaid.com/legal/#end-user-privacy-policy">')
      // /security is public too; it stays a marked, unindexed draft until it's approved.
      const sec = await app.request('/security')
      expect(sec.status).toBe(200)
      const secHtml = await sec.text()
      expect(secHtml).toMatch(/<h1 id="[a-z-]+">Security<\/h1>/)
      expect(secHtml).toContain('security@aggregate.finance')
      // No certification claims: it says plainly that there isn't one yet.
      expect(secHtml).not.toMatch(/SOC 2 (certified|compliant|type)|we are (fully )?compliant/i)
      expect(secHtml).toMatch(/We don(&#39;|')t hold a SOC 2 report/)
      expect(secHtml).toContain('<a href="/security">Security</a>')
    } finally {
      await booted.shutdown()
    }
  })

  it('shows the draft banner and noindex while status is draft', () => {
    const d = renderLegal('---\ntitle: T\nstatus: draft\n---\n\n# T\n\nx\n')
    expect(d.draft).toBe(true)
  })

  it('drops the banner when the front matter says final, and escapes HTML', () => {
    const p = renderLegal('---\ntitle: T\nstatus: final\n---\n\n# T\n\n<script>alert(1)</script> [x](javascript:alert(1)) **b**\n\n| a | b |\n|---|---|\n| 1 | 2 |\n')
    expect(p.draft).toBe(false)
    expect(p.html).not.toContain('not yet in effect')
    expect(p.html).not.toContain('<script>')
    expect(p.html).not.toContain('href="javascript')
    expect(renderMarkdown('- one\n- two\n\ntext https://a.example/x.')).toBe('<ul><li>one</li><li>two</li></ul>\n<p>text <a href="https://a.example/x">https://a.example/x</a>.</p>')
    expect(p.html).toContain('<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>')
  })

  it('match the app: light only, Geist and Newsreader from the web build', () => {
    const dist = mkdtempSync(join(tmpdir(), 'agfn-web-'))
    try {
      mkdirSync(join(dist, 'assets', 'fonts'), { recursive: true })
      for (const f of ['geist-T72VVCUW.woff2', 'newsreader-J4KAOEDO.woff2', 'other.txt']) writeFileSync(join(dist, 'assets', 'fonts', f), '')
      const fonts = findLegalFonts(dist)
      expect(fonts).toEqual({ geist: '/assets/fonts/geist-T72VVCUW.woff2', newsreader: '/assets/fonts/newsreader-J4KAOEDO.woff2' })
      const { html } = renderLegal('---\ntitle: T\nstatus: final\n---\n\n# T\n', fonts)
      expect(html).toContain("@font-face{font-family:'Geist';src:url('/assets/fonts/geist-T72VVCUW.woff2')")
      expect(html).toContain('font:300 15px/22px var(--sans)')
      expect(html).not.toContain('prefers-color-scheme')
      expect(html).toContain('color-scheme:light')
    } finally {
      rmSync(dist, { recursive: true, force: true })
    }
    // No web build (tests, API-only installs): system fonts, no broken @font-face.
    expect(findLegalFonts('/nonexistent')).toEqual({})
    expect(renderLegal('# T\n').html).not.toContain('@font-face')
  })

  it('render numbered steps, code blocks (also inside a step) and quotes, escaped', () => {
    const html = renderMarkdown('> Claude can **see** <b>x</b>\n\n1. One\n2. Two\n   ```sh\n   AGFN_KEY=<k> npx agfn\n   ```\n3. Three\n\n```sh\nclaude mcp add <x>\n```')
    expect(html).toBe('<blockquote><p>Claude can <strong>see</strong> &lt;b&gt;x&lt;/b&gt;</p></blockquote>\n<ol><li>One</li><li>Two<pre><code>AGFN_KEY=&lt;k&gt; npx agfn</code></pre></li><li>Three</li></ol>\n<pre><code>claude mcp add &lt;x&gt;</code></pre>')
  })

  it('serve docs/connect-your-ai at /docs/connect-your-ai', async () => {
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: 'http://localhost:8787', WEB_DIST: '/nonexistent' }), runWorker: false }
    const booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => {} } })
    try {
      const r = await createApp(booted.services).request('/docs/connect-your-ai')
      expect(r.status).toBe(200)
      const html = await r.text()
      expect(html).toContain('<title>Connect your AI to Aggregate · Aggregate</title>')
      expect(html).toContain('<h1 id="connect-your-ai-to-aggregate">Connect your AI to Aggregate</h1>')
      expect(html).toContain('<pre><code>claude mcp add --transport http --scope user aggregate https://app.aggregate.finance/mcp</code></pre>')
      expect(html).not.toContain('noindex')
      expect(html).not.toContain('```')
    } finally {
      await booted.shutdown()
    }
  })
})
