import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import type { Handler } from 'hono'
import { withBaseUrl } from './legal.ts'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4',
}

/** True when an Accept-Encoding header allows brotli ("br", not "br;q=0"). */
export function acceptsBrotli(header: string | undefined): boolean {
  return (header ?? '').split(',').some((part) => {
    const [name, ...params] = part.trim().toLowerCase().split(';')
    const q = params.map((x) => x.trim()).find((x) => x.startsWith('q='))
    return name === 'br' && (q === undefined || Number(q.slice(2)) > 0)
  })
}

/** Serves the built web app with an SPA fallback to index.html (routing is hash-based). */
export function serveWeb(root: string, baseUrl = ''): Handler {
  const base = normalize(root) + sep
  // A mock build runs made-up companies in the browser; served by a real server it would hide real data behind fakes.
  const mock = existsSync(join(root, '.mock'))
  if (mock) console.error(`[agfn] ${root} is a mock (demo-only) web build. Run \`npm run build -w @agfn/web\` for the real app.`)
  return async (c) => {
    if (mock) return c.text('This server has the demo-only web build. Run `npm run build -w @agfn/web` and restart.', 503)
    // A malformed percent-escape (scanners send /%E0%A4%A) is a 404, not a thrown URIError and a 500 with a stack.
    let rel: string
    try {
      rel = decodeURIComponent(new URL(c.req.url).pathname).replace(/^\/+/, '')
    } catch {
      return c.notFound()
    }
    let file = normalize(join(root, rel || 'index.html'))
    if (!file.startsWith(base) && file !== normalize(join(root, 'index.html'))) return c.notFound()
    let info = await stat(file).catch(() => null)
    if (!info || info.isDirectory()) {
      // A missing hashed bundle (a tab from before a deploy) must 404, not get index.html as JavaScript.
      if (rel.startsWith('assets/')) return c.notFound()
      // Anything that looks like a file (og.png, robots.txt, sitemap.xml…) and isn't there is a 404, never the app's HTML:
      // crawlers and scanners must not get a web page for an image. App routes are hash-based, so they have no extension.
      if (/\.[a-z0-9]{1,8}$/i.test(rel)) return c.notFound()
      file = join(root, 'index.html')
      info = await stat(file).catch(() => null)
      if (!info) return c.text('The web app has not been built. Run `npm run build -w @agfn/web`.', 503)
    }
    const type = TYPES[extname(file)] ?? 'application/octet-stream'
    // index.html carries share-preview tags pointing at this server (static text only; no workspace data).
    const body = file === join(root, 'index.html') ? withBaseUrl(await readFile(file, 'utf8'), baseUrl) : await readFile(file)
    const immutable = /\/assets\//.test(file)
    const headers: Record<string, string> = { 'content-type': type, 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' }
    // Hashed JS/CSS come with a build-time .br (full-strength brotli): served only to browsers that accept br, same
    // type and caching; Vary keeps shared caches from handing it to one that doesn't.
    if (immutable && (await stat(`${file}.br`).catch(() => null))) {
      headers.vary = 'Accept-Encoding'
      if (acceptsBrotli(c.req.header('accept-encoding'))) {
        headers['content-encoding'] = 'br'
        return c.body(await readFile(`${file}.br`), 200, headers)
      }
    }
    return c.body(body, 200, headers)
  }
}
