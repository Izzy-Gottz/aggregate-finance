// Guides (docs/guides/*.md at /docs/guides/<slug>) and the hosted sitemap: only files read at boot are served, links are
// rewritten to this site or the public repo, and nothing outside that one directory is reachable.
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { boot } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { GUIDES_REPO_DOCS, faqLd, guideLinks, loadGuides, publicDocLinks, renderDoc, renderLegal } from './legal.ts'

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

  it('real guides carry a description and the date written in the file; a guide with no date shows none', () => {
    const guides = loadGuides()
    for (const [slug, date] of [['definitions', '2026-11-03'], ['how-we-check-our-numbers', '2026-11-02'], ['limits', '2026-11-03'], ['sources-through-another-connection', '2026-11-02']] as const) {
      const g = guides.get(slug)!
      expect(g.updated).toBe(date)
      expect(g.html).toContain(`<time itemprop="dateModified" datetime="${date}">`)
    }
    expect(guides.get('sources-through-another-connection')!.description).toMatch(/^Some services have no Aggregate connector/)
    const dir = mkdtempSync(join(tmpdir(), 'agfn-guides-'))
    writeFileSync(join(dir, 'connect-one.md'), '# Connect one\n\n**Short answer:** it reads only.\n\n- a list\n')
    const g = loadGuides(pathToFileURL(dir + '/')).get('connect-one')!
    expect(g.updated).toBeUndefined()
    expect(g.html).not.toContain('Last updated')
    expect(g.html).not.toContain('modified_time')
    expect(g.description).toBe('Short answer: it reads only.')
  })

  it('every in-app path in the guides, Connect your AI and the READMEs names labels the web app really shows', () => {
    const root = new URL('../../../', import.meta.url)
    const read = (dir: string, keep: (f: string) => boolean): string =>
      (readdirSync(new URL(dir, root), { recursive: true }) as string[])
        .filter(keep)
        .map((f) => readFileSync(new URL(`${dir}${f}`, root), 'utf8'))
        .join('\n')
    const web = read('apps/web/src/', (f) => f.endsWith('.ts') && !f.includes('.test.') && !f.startsWith('api/mock'))
    const names = read('packages/connectors/', (f) => /^[a-z0-9-]+\/src\/connector\.ts$/.test(f))
    // "+ X" is a PlusAction; anything else is a quoted label in the app, or a connector's name in its own row.
    const real = (seg: string) =>
      seg.startsWith('+ ')
        ? web.includes(`>${seg.slice(2)}</\${PlusAction}>`)
        : web.includes(`'${seg}'`) || web.includes(`"${seg}"`) || names.includes(`name: '${seg}'`)
    expect(real('+ More connections')).toBe(false)
    const files = [...readdirSync(new URL('docs/guides/', root)).filter((f) => f.endsWith('.md')).map((f) => `docs/guides/${f}`), 'docs/connect-your-ai.md', 'README.md', 'packages/cli/NPM-README.md']
    const paths = files.flatMap((f) =>
      [...readFileSync(new URL(f, root), 'utf8').matchAll(/\*\*((?:Workspace|Connect your AI|Cap table|Preferences) →[^*]+)\*\*/g)].map((m) => ({ f, path: m[1]!.replace(/\s+/g, ' ').trim() })),
    )
    expect(paths.length).toBeGreaterThanOrEqual(25)
    const wrong = paths.flatMap(({ f, path }) => path.split(' → ').filter((seg) => !/^<.+>$/.test(seg) && !real(seg)).map((seg) => `${f}: "${seg}" in ${path}`))
    expect(wrong).toEqual([])
  })

  it('the FAQ carries FAQPage data made of its own questions and answers, as plain text; other guides carry none', () => {
    const guides = loadGuides()
    const html = guides.get('faq')!.html
    const ld = JSON.parse(/<script type="application\/ld\+json">([^<]*)<\/script>/.exec(html)![1]!)
    const md = readFileSync(new URL('../../../docs/guides/faq.md', import.meta.url), 'utf8')
    const questions = [...md.matchAll(/^\*\*([^*\n]+\?)\*\*$/gm)].map((m) => m[1])
    expect(ld['@type']).toBe('FAQPage')
    expect(ld.mainEntity.map((e: { name: string }) => e.name)).toEqual(questions)
    expect(questions.length).toBeGreaterThanOrEqual(30)
    for (const e of ld.mainEntity) expect(e.acceptedAnswer.text).toMatch(/^[^*[\]`]+$/)
    expect(ld.mainEntity[0].acceptedAnswer.text).toMatch(/^Sign up at app\.aggregate\.finance, connect your sources/)
    expect(guides.get('connect-claude')!.html).not.toContain('application/ld+json')
    const odd = renderDoc('---\ntitle: T\n---\n\n# T\n', {}, '/docs/guides/t', { ld: faqLd('**Is </script> ok?**\nIt is </script><b>.\n')! }).html
    expect(odd).toContain('Is \\u003c/script> ok?')
    expect(odd.match(/<\/script>/g)!.length).toBe(odd.match(/<script/g)!.length)
    expect(faqLd('# No questions here\n\nJust text.\n')).toBeUndefined()
  })

  it('the hosted sitemap lists the demo chat while it is on', async () => {
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: 'https://money.example.com', WEB_DIST: '/nonexistent', AGFN_HOSTED: '1', AGFN_TRY_CHAT: '1', ANTHROPIC_TRY_KEY: 'k', AGFN_PUBLIC_DEMO_URL: 'https://demo.example.com/mcp' }), runWorker: false }
    const booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => {} } })
    try {
      const xml = await (await createApp(booted.services).request('/sitemap.xml')).text()
      expect(xml).toContain('<loc>https://money.example.com/try</loc>')
    } finally {
      await booted.shutdown()
    }
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
      // The demo chat is listed only while it's on.
      expect(xml).not.toContain('/try</loc>')
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

