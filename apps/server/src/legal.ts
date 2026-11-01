// Public /privacy, /terms and /security: docs/legal/*.md rendered once at boot to quiet HTML. A tiny renderer for the subset those
// files use (front matter, headings, paragraphs, lists, one-level tables, **bold**, `code`, [links](url), bare URLs).
// Everything is HTML-escaped before inline markup is applied, and links must be http(s), mailto or a path on this site.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface LegalPage {
  title: string
  draft: boolean
  html: string
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

function inline(raw: string): string {
  let s = esc(raw)
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\[CONFIRM\]/g, '<mark>[CONFIRM]</mark>')
  // One pass for [text](url) and bare URLs, so a link's own href is never re-scanned (a bare URL inside an href would
  // otherwise get a second <a href="…"> written into the attribute and break out of it). URLs never contain " < >.
  s = s.replace(
    /\[([^\]]+)\]\(((?:https?:\/\/|mailto:|\/(?![/\\]))[^\s)"<>]+)\)|(^|[\s(])(https?:\/\/[^\s<>")]*[^\s<>").,;:])/g,
    (_m, text: string | undefined, url: string | undefined, pre: string | undefined, bare: string | undefined) =>
      text !== undefined ? `<a href="${url}">${text}</a>` : `${pre}<a href="${bare}">${bare}</a>`,
  )
  return s
}

function frontMatter(md: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md)
  if (!m) return { meta: {}, body: md }
  const meta: Record<string, string> = {}
  for (const line of m[1]!.split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return { meta, body: md.slice(m[0].length) }
}

export function renderMarkdown(body: string): string {
  const out: string[] = []
  // CRLF (a file saved on Windows) and stray line separators would otherwise stop a heading matching while the
  // paragraph rule still refuses the line: no progress, and boot hangs.
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) {
      i++
      continue
    }
    const h = /^(#{1,3})\s+(.*)$/s.exec(line)
    if (h) {
      const n = h[1]!.length
      // "## Xero {#xero}" sets the anchor; otherwise it comes from the words ("## Before you start" → #before-you-start).
      const explicit = /\s*\{#([a-z0-9-]+)\}\s*$/.exec(h[2]!)
      const text = explicit ? h[2]!.slice(0, explicit.index) : h[2]!
      const id = explicit ? explicit[1]! : text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      out.push(`<h${n} id="${id}">${inline(text)}</h${n}>`)
      i++
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
        let item = lines[i]!.replace(/^\s*[-*]\s+/, '')
        i++
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !/^\s*[-*]\s+/.test(lines[i]!)) item += ' ' + lines[i++]!.trim()
        items.push(`<li>${inline(item)}</li>`)
      }
      out.push(`<ul>${items.join('')}</ul>`)
      continue
    }
    const fence = /^(\s*)```/.exec(line)
    if (fence) {
      const code: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) code.push(lines[i++]!.slice(fence[1]!.length))
      i++
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`)
      continue
    }
    if (line.startsWith('>')) {
      const quoted: string[] = []
      while (i < lines.length && lines[i]!.startsWith('>')) quoted.push(lines[i++]!.replace(/^>\s?/, ''))
      out.push(`<blockquote>${renderMarkdown(quoted.join('\n'))}</blockquote>`)
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      // Numbered steps; indented lines continue the step, and an indented code block stays inside it.
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        let text = lines[i]!.replace(/^\s*\d+\.\s+/, '')
        let extra = ''
        i++
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !/^\s*\d+\.\s+/.test(lines[i]!)) {
          const f = /^(\s*)```/.exec(lines[i]!)
          if (f) {
            const code: string[] = []
            i++
            while (i < lines.length && !/^\s*```/.test(lines[i]!)) code.push(lines[i++]!.slice(f[1]!.length))
            i++
            extra += `<pre><code>${esc(code.join('\n'))}</code></pre>`
          } else text += ' ' + lines[i++]!.trim()
        }
        items.push(`<li>${inline(text)}${extra}</li>`)
      }
      out.push(`<ol>${items.join('')}</ol>`)
      continue
    }
    if (line.startsWith('|')) {
      const rows: string[][] = []
      while (i < lines.length && lines[i]!.startsWith('|')) {
        const cells = lines[i]!.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
        if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells)
        i++
      }
      const [head, ...rest] = rows
      out.push(`<table><thead><tr>${(head ?? []).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rest.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,3}\s|\s*[-*]\s|\||\s*\d+\.\s|\s*```|>)/.test(lines[i]!)) para.push(lines[i++]!.trim())
    if (!para.length) para.push(lines[i++]!.trim()) // never stall on a line no rule above took
    out.push(`<p>${inline(para.join(' '))}</p>`)
  }
  return out.join('\n')
}

/** Self-hosted fonts from the web build (dist/assets/fonts/<name>-<hash>.woff2), served by the app's static route. */
export interface LegalFonts {
  geist?: string
  newsreader?: string
}

export function findLegalFonts(webDist: string): LegalFonts {
  try {
    const files = readdirSync(join(webDist, 'assets', 'fonts'))
    const pick = (name: string) => files.find((f) => f.startsWith(`${name}-`) && f.endsWith('.woff2'))
    const g = pick('geist')
    const n = pick('newsreader')
    return { ...(g ? { geist: `/assets/fonts/${g}` } : {}), ...(n ? { newsreader: `/assets/fonts/${n}` } : {}) }
  } catch {
    return {}
  }
}

// The app's tokens (apps/web/src/ui/tokens.css): light only, off-white page, near-black ink, hairline rules, a thin
// Geist for text and a light Newsreader for headings, one centered column.
function style(f: LegalFonts): string {
  const face = (family: string, url: string | undefined, weights: string) =>
    url ? `@font-face{font-family:'${family}';src:url('${url}') format('woff2-variations'),url('${url}') format('woff2');font-weight:${weights};font-display:swap}` : ''
  return `
${face('Geist', f.geist, '100 900')}${face('Newsreader', f.newsreader, '200 800')}
:root{--page:#FAF9F7;--ink:#1F1B1C;--grey:#6B6766;--faint:#A8A4A0;--rule:#E7E4E0;--tile:#EFEDE9;--amber:#8A5A00;--serif:'Newsreader',Georgia,'Times New Roman',serif;--sans:'Geist',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color-scheme:light}
*{box-sizing:border-box}
html,body{margin:0;background:var(--page);color:var(--ink)}
body{font:300 15px/22px var(--sans);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
main{max-width:680px;margin:0 auto;padding:48px 40px 96px}
@media (max-width:720px){main{padding:32px 16px 72px}}
.top{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:48px}
.top a{color:var(--ink);text-decoration:none;font:500 22px/28px var(--serif);letter-spacing:-.01em}
.top nav a{font:300 14px var(--sans);color:var(--grey);margin-left:16px}
.top a{position:relative}
.top a::after{content:"";position:absolute;inset:-16px 0 0}
.top nav a::after{inset:-13px -6px}
@media (max-width:720px){.top{flex-wrap:wrap;row-gap:14px}.top nav{width:100%}.top nav a:first-child{margin-left:0}}
h1{font:300 32px/38px var(--serif);letter-spacing:-.01em;margin:0 0 8px}
h2{font:400 22px/28px var(--serif);letter-spacing:-.005em;margin:40px 0 8px}
h3{font:400 15px/22px var(--sans);margin:24px 0 4px}
p,ul,table{margin:0 0 14px}
ul{padding-left:20px}
li{margin:4px 0}
strong{font-weight:500}
a{color:inherit;text-decoration-color:var(--faint);text-underline-offset:2px}
code{font:13px ui-monospace,'SF Mono',Menlo,monospace}
pre{background:var(--tile);border-radius:7px;padding:10px 12px;overflow-x:auto;margin:8px 0 14px}
blockquote{margin:0 0 14px;padding:2px 0 2px 16px;border-left:2px solid var(--rule);color:var(--grey)}
ol{padding-left:22px;margin:0 0 14px}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:8px 8px 8px 0;border-bottom:1px solid var(--rule);vertical-align:top}
th{font-weight:400;color:var(--grey)}
mark{background:none;color:var(--amber);font-weight:500}
.draft{border:1px solid var(--rule);background:var(--tile);border-radius:7px;padding:10px 14px;margin-bottom:32px;font-size:14px}
.updated{color:var(--grey);font-size:14px;margin-bottom:32px}
`
}

/** Where share previews point: replaced with the server's BASE_URL when pages are served (see `withBaseUrl`). */
export const BASE_URL_TOKEN = '%AGFN_BASE_URL%'
/** The page's own path, for og:url. */
export const PATH_TOKEN = '%AGFN_PATH%'

/** Fills the share-preview tokens with this server's public origin (escaped; no trailing slash) and the page's path. */
export function withBaseUrl(html: string, baseUrl: string, path = '/'): string {
  return html.split(BASE_URL_TOKEN).join(esc(baseUrl.replace(/\/+$/, ''))).split(PATH_TOKEN).join(esc(path))
}

/** The first plain paragraph after the heading, for link previews (or the page's `description:` front matter). */
function summary(meta: Record<string, string>, body: string): string {
  if (meta.description) return meta.description
  const para = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .find((p) => p && !/^(#|\||-|\*|>|```|<|\d+\.)/.test(p))
  const text = (para ?? '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim()
  return text.length > 200 ? text.slice(0, 197).replace(/\s+\S*$/, '') + '…' : text || 'Aggregate'
}

/** Title, description and the quiet preview image, so a pasted link looks right. Never anything from a workspace. */
function shareMeta(title: string, description: string): string {
  return [
    `<meta name="description" content="${esc(description)}">`,
    '<meta property="og:type" content="website"><meta property="og:site_name" content="Aggregate">',
    `<meta property="og:url" content="${BASE_URL_TOKEN}${PATH_TOKEN}">`,
    `<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:image" content="${BASE_URL_TOKEN}/og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="Aggregate">`,
    '<meta name="twitter:card" content="summary_large_image">',
  ].join('')
}

export function renderLegal(md: string, fonts: LegalFonts = {}): LegalPage {
  // <!-- notes --> in a doc are for whoever edits it, never shown on the page.
  const { meta, body } = frontMatter(md.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->\n?/g, ''))
  const title = meta.title ?? 'Aggregate'
  const draft = (meta.status ?? '').toLowerCase() === 'draft'
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Aggregate</title><link rel="icon" href="/favicon.ico" sizes="32x32"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="robots" content="${draft ? 'noindex' : 'index'}">${shareMeta(`${title} · Aggregate`, summary(meta, body))}<style>${style(fonts)}</style></head>
<body><main>
<div class="top"><a href="/">Aggregate</a><nav><a href="/docs/connectors">Connectors</a><a href="/docs/connect-your-ai">Connect your AI</a><a href="/security">Security</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav></div>
${draft ? '<div class="draft" role="note"><strong>Draft — not yet in effect.</strong> This page is being reviewed and may change.</div>' : ''}
${meta.updated ? `<div class="updated">Last updated ${esc(meta.updated)}</div>` : ''}
${renderMarkdown(body)}
</main></body></html>`
  return { title, draft, html }
}

/** Read and render both pages. Missing files give a short "not published" page instead of failing boot. */
export function loadLegalPages(dir: URL = new URL('../../../docs/legal/', import.meta.url), fonts: LegalFonts = {}): Record<'privacy' | 'terms' | 'security' | 'support', LegalPage> {
  const load = (name: 'privacy' | 'terms' | 'security' | 'support', title: string) => {
    try {
      return renderLegal(readFileSync(new URL(`${name}.md`, dir), 'utf8'), fonts)
    } catch {
      return renderLegal(`---\ntitle: ${title}\nstatus: draft\n---\n\n# ${title}\n\nNot published yet.\n`, fonts)
    }
  }
  return { privacy: load('privacy', 'Privacy Policy'), terms: load('terms', 'Terms of Service'), security: load('security', 'Security'), support: load('support', 'Support') }
}

/** Public docs served next to the legal pages (no front matter in the file; GitHub shows it too). */
export const PUBLIC_DOCS = {
  'connect-your-ai': { file: 'connect-your-ai.md', title: 'Connect your AI to Aggregate' },
  recipes: { file: 'recipes.md', title: 'Prompt recipes' },
  connectors: { file: 'connectors.md', title: 'What Aggregate connects' },
} as const

/** The page of a doc beside the public docs (docs/<name>.md) if this server serves it, otherwise null. */
function publicDocPath(name: string): string | null {
  return name in PUBLIC_DOCS ? `/docs/${name}` : null
}

/** Links between public docs (`connect-your-ai.md`, `recipes.md#x`) go to their pages; a link to any other repo doc
 *  points at the public repo on GitHub. */
export function publicDocLinks(md: string): string {
  return md.replace(/\]\(([^)\s]+)\)/g, (whole, target: string) => {
    if (/^[a-z]+:|^\/|^#/i.test(target)) return whole
    const [path, frag] = target.split('#') as [string, string | undefined]
    const hash = frag ? `#${frag}` : ''
    const m = /^(?:\.\/)?([a-z0-9][a-z0-9-]*)\.md$/i.exec(path)
    if (!m) return whole
    return `](${publicDocPath(m[1]!.toLowerCase()) ?? `${GUIDES_REPO_DOCS}${m[1]}.md`}${hash})`
  })
}

export function loadPublicDocs(dir: URL = new URL('../../../docs/', import.meta.url), fonts: LegalFonts = {}): Record<keyof typeof PUBLIC_DOCS, LegalPage> {
  const out = {} as Record<keyof typeof PUBLIC_DOCS, LegalPage>
  for (const [slug, d] of Object.entries(PUBLIC_DOCS) as Array<[keyof typeof PUBLIC_DOCS, (typeof PUBLIC_DOCS)[keyof typeof PUBLIC_DOCS]]>) {
    let body: string
    try {
      body = readFileSync(new URL(d.file, dir), 'utf8')
    } catch {
      body = `# ${d.title}\n\nNot published yet.\n`
    }
    out[slug] = renderLegal(`---\ntitle: ${d.title}\nstatus: final\n---\n\n${publicDocLinks(body)}`, fonts)
  }
  return out
}

/**
 * Guides (docs/guides/*.md) at /docs/guides/<slug>: read once at boot, so a request only ever looks a slug up in this map
 * and never touches the filesystem. Files starting with "_" (the generator's template) are skipped; README.md is the
 * index at /docs/guides. Links to other guides become /docs/guides/<slug>, a public doc (../recipes.md) becomes its page,
 * and any other repo doc points at the public repo on GitHub.
 */
export const GUIDES_REPO_DOCS = 'https://github.com/Izzy-Gottz/aggregate-finance/blob/main/docs/'

export function guideLinks(md: string): string {
  return md.replace(/\]\(([^)\s]+)\)/g, (whole, target: string) => {
    if (/^[a-z]+:|^\/|^#/i.test(target)) return whole
    const [path, frag] = target.split('#') as [string, string | undefined]
    const hash = frag ? `#${frag}` : ''
    const m = /^(?:\.\/)?([a-z0-9][a-z0-9-]*|README)\.md$/i.exec(path)
    if (m) return `](/docs/guides${m[1] === 'README' ? '' : `/${m[1]!.toLowerCase()}`}${hash})`
    const up = /^\.\.\/([a-z0-9][a-z0-9/_-]*\.md)$/i.exec(path)
    if (up) return `](${publicDocPath(up[1]!.slice(0, -3).toLowerCase()) ?? GUIDES_REPO_DOCS + up[1]}${hash})`
    return whole
  })
}

export function loadGuides(dir: URL = new URL('../../../docs/guides/', import.meta.url), fonts: LegalFonts = {}): Map<string, LegalPage> {
  const out = new Map<string, LegalPage>()
  let files: string[] = []
  try {
    files = readdirSync(dir)
  } catch {
    return out
  }
  for (const file of files.sort()) {
    const m = /^([a-z0-9][a-z0-9-]*|README)\.md$/.exec(file)
    if (!m) continue
    const md = readFileSync(new URL(file, dir), 'utf8').replace(/\r\n?/g, '\n')
    const title = (/^# (.+)$/m.exec(md)?.[1] ?? 'Guides').trim().replace(/\n/g, ' ').replace(/\s*:\s+/g, ' – ').replace(/:/g, ' ')
    out.set(m[1] === 'README' ? '' : m[1]!, renderLegal(`---\ntitle: ${title}\nstatus: final\n---\n\n${guideLinks(md)}`, fonts))
  }
  return out
}
