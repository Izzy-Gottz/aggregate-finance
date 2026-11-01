// Public pages rendered from markdown: /privacy, /terms, /docs/connect-your-ai. Their source is docs/**/*.md that we
// ship (read once at boot; no route parameter, query, workspace or person text ever reaches the renderer), but legal
// text gets edited, so the renderer itself must be safe on hostile input: raw HTML is text, only http(s)/mailto become
// links, nothing can break out of an attribute, odd line endings can't hang boot, and the pages carry strict headers.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { boot } from '../boot.ts'
import { createApp } from '../app.ts'
import { loadConfig } from '../config.ts'
import { renderLegal, renderMarkdown } from '../legal.ts'

const TAG = /^(?:\/?(?:p|h[123]|ul|ol|li|strong|code|pre|mark|blockquote|table|thead|tbody|tr|th|td|a)|a href="(?:https?:\/\/|mailto:)[^"<>]*"|h[123] id="[a-z0-9-]*")>/

/** Every tag in the rendered body is one the renderer writes itself; text between tags holds no < > or ". */
function stray(html: string): string[] {
  const bad: string[] = []
  const [first, ...rest] = html.split('<')
  if (/[>"]/.test(first!)) bad.push(first!)
  for (const seg of rest) {
    const m = TAG.exec(seg)
    if (!m || /[>"]/.test(seg.slice(m[0].length))) bad.push(`<${seg}`)
  }
  return bad
}
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!)

const HTML = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<iframe src="https://evil.example"></iframe>',
  '<svg onload=alert(1)>',
  '<p style="position:fixed;inset:0">x</p>',
  '<a href="javascript:alert(1)">x</a>',
  '"><script>alert(1)</script>',
  "'><img src=x onerror=alert(1)>",
  '&lt;script&gt;alert(1)&lt;/script&gt;', // pre-escaped text stays text (double-escaped), never decoded
  '<!-- x --><style>body{display:none}</style>',
  'x {#a"><script>alert(1)</script>}', // a heading anchor that isn't a plain slug is just text
]

const SCHEMES = [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  ' javascript:alert(1)',
  '\tjavascript:alert(1)',
  'java\tscript:alert(1)',
  'java\nscript:alert(1)',
  '&#106;avascript:alert(1)',
  '&#x6A;avascript:alert(1)',
  'javascript&colon;alert(1)',
  '%6Aavascript:alert(1)',
  'vbscript:msgbox(1)',
  'VBScript:msgbox(1)',
  'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'data:image/svg+xml,<svg onload=alert(1)>',
  '//evil.example/x',
  'https://ok.example" onmouseover="alert(1)',
  "https://ok.example' onmouseover='alert(1)",
  'https://ok.example/"><script>alert(1)</script>',
]

/** Wraps a payload in every block the renderer knows. */
function everywhere(p: string): string {
  return [`# ${p}`, `## ${p}`, p, `- ${p}`, `1. ${p}`, `| ${p} | b |\n|---|---|\n| ${p} | ${p} |`, `> ${p}`, `**${p}**`, `\`${p}\``, '```', p, '```'].join('\n\n')
}

describe('red team: markdown-rendered public pages', () => {
  it('raw HTML in the source is shown as text in every block, never rendered', () => {
    for (const p of HTML) {
      const html = renderMarkdown(everywhere(p))
      expect(stray(html), p).toEqual([])
      expect(html, p).not.toMatch(/<(?:script|img|iframe|svg|style|!--)/i)
      expect(html, p).not.toMatch(/<[^>]*\s(?:on\w+|style|src)=/i)
    }
  })

  it('only http(s) and mailto become hrefs, however the scheme is disguised', () => {
    for (const p of SCHEMES) {
      for (const md of [`[click](${p})`, `see ${p} here`, `(${p})`, `[click](${p}) and https://ok.example`]) {
        const html = renderMarkdown(md)
        expect(stray(html), JSON.stringify(md)).toEqual([])
        for (const h of hrefs(html)) expect(h, JSON.stringify(md)).toMatch(/^(?:https?:\/\/|mailto:)[^\s"'<>]*$/)
        expect(html.toLowerCase(), JSON.stringify(md)).not.toMatch(/href="\s*(?:javascript|vbscript|data|&#)/)
      }
    }
    expect(renderMarkdown('[mail](mailto:privacy@aggregate.finance)')).toBe('<p><a href="mailto:privacy@aggregate.finance">mail</a></p>')
  })

  it("a bare URL inside a link's URL or text can't write a second tag into the href (attribute breakout)", () => {
    // Before the fix, the autolink pass re-scanned the finished <a href="…"> and wrote <a href="…"> into the
    // attribute: the outer href closed early and `onmouseover` landed as a live attribute.
    for (const md of [
      '[x](https://a.example/(https://b.example/x/onmouseover=alert`1`//)',
      '[x](https://a.example/(https://b.example/x/onmouseover=location=name//)',
      '[x](https://a.example/(https://b.example/style=position:fixed;inset:0//)',
      '[see https://e.example](https://b.example)',
      '[x](https://a.example/**b**)',
    ]) {
      const html = renderMarkdown(md)
      expect(stray(html), md).toEqual([])
      expect(html, md).not.toMatch(/<a [^>]*<a /)
      expect(html.match(/<a /g)?.length ?? 0, md).toBeLessThanOrEqual(1)
    }
    expect(renderMarkdown('[see https://e.example](https://b.example)')).toBe('<p><a href="https://b.example">see https://e.example</a></p>')
    expect(renderMarkdown('(https://a.example/x) and https://b.example.')).toBe('<p>(<a href="https://a.example/x">https://a.example/x</a>) and <a href="https://b.example">https://b.example</a>.</p>')
  })

  it("CRLF files and stray line separators render instead of hanging boot", () => {
    // Before the fix `# Title\r` matched the paragraph guard but not the heading rule: an endless loop at boot.
    // Run in a child process so a regression fails on a timeout instead of freezing the test runner.
    const legal = fileURLToPath(new URL('../legal.ts', import.meta.url))
    const script = `import { renderLegal } from ${JSON.stringify(legal)}
const out = [
  renderLegal('---\\r\\ntitle: T\\r\\nstatus: final\\r\\n---\\r\\n\\r\\n# Title\\r\\n\\r\\nBody https://a.example\\r\\n- one\\r\\n'),
  renderLegal('# a\\u2028b\\n\\n## c\\u2029d\\n\\ntext\\rmore\\n'),
]
process.stdout.write(JSON.stringify(out))`
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 15_000, encoding: 'utf8' })
    expect(r.error?.message ?? r.stderr.slice(0, 500), 'renderer hung or crashed').toBe('')
    const [crlf, seps] = JSON.parse(r.stdout) as Array<{ title: string; draft: boolean; html: string }>
    expect(crlf!.title).toBe('T')
    expect(crlf!.html).toMatch(/<h1 id="title">Title<\/h1>/)
    expect(crlf!.html).toContain('<a href="https://a.example">https://a.example</a>')
    expect(crlf!.html).not.toContain('\r')
    expect(seps!.html).toMatch(/<h1 id="[a-z0-9-]*">a\u2028b<\/h1>/)
  })

  it('front matter (title, updated) is escaped into <title> and the page', () => {
    const p = renderLegal('---\ntitle: </title><script>alert(1)</script>"\nupdated: <img src=x onerror=alert(1)>\nstatus: final\n---\n\n# T\n')
    expect(p.html).toContain('<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;&quot; · Aggregate</title>')
    expect(p.html).toContain('Last updated &lt;img src=x onerror=alert(1)&gt;')
    expect(p.html).not.toMatch(/<script|<img/i)
  })

  it('the docs we ship render to the safe tag set only', () => {
    for (const f of ['../../../../docs/legal/privacy.md', '../../../../docs/legal/terms.md', '../../../../docs/connect-your-ai.md']) {
      const md = readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '')
      expect(stray(renderMarkdown(md)), f).toEqual([])
    }
  })

  it('served with strict headers; query strings and odd paths are never reflected', async () => {
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: 'https://app.aggregate.finance', WEB_DIST: '/nonexistent' }), runWorker: false }
    const booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => {} } })
    try {
      const app = createApp(booted.services)
      const X = '"><script>alert(1)</script>'
      for (const path of ['/privacy', '/terms', '/docs/connect-your-ai']) {
        const plain = await app.request(path)
        expect(plain.status, path).toBe(200)
        const h = plain.headers
        expect(h.get('content-type'), path).toMatch(/^text\/html; charset=utf-8$/i)
        expect(h.get('x-content-type-options'), path).toBe('nosniff')
        expect(h.get('x-frame-options'), path).toBe('DENY')
        expect(h.get('strict-transport-security'), path).toMatch(/max-age=\d+/)
        const csp = h.get('content-security-policy') ?? ''
        expect(csp, path).toContain("frame-ancestors 'none'")
        expect(csp, path).toContain("object-src 'none'")
        expect(csp, path).toContain("base-uri 'none'")
        // Inline style is allowed (the page's own <style>); inline script never is, so even a broken-out
        // attribute handler could not run.
        expect(/script-src ([^;]*)/.exec(csp)?.[1] ?? '', path).not.toMatch(/unsafe-inline|unsafe-eval|\*(?!\.)/)
        const body = await plain.text()
        expect(body, path).not.toMatch(/<script|\son\w+=|javascript:/i)
        // Rendered once at boot: the query string can't change a byte.
        const q = await app.request(`${path}?title=${encodeURIComponent(X)}&q=${encodeURIComponent(X)}`)
        expect(await q.text(), path).toBe(body)
      }
      for (const path of [`/docs/${encodeURIComponent(X)}`, `/docs/connect-your-ai/${encodeURIComponent(X)}`, `/privacy/${encodeURIComponent(X)}`]) {
        const r = await app.request(path)
        const text = await r.text()
        expect(text, path).not.toContain('<script>alert(1)')
        expect(r.headers.get('x-content-type-options'), path).toBe('nosniff')
      }
    } finally {
      await booted.shutdown()
    }
  })
})
