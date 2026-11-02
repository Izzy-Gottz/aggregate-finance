// The docs on their own host (docs.aggregate.finance/connectors, /guides/connect-claude), from the same pages the app
// serves at /docs. Pages are written once, with /docs links and this server's address; on the docs host those become the
// host's own clean paths. The app's old /docs URLs move there for good. Off unless AGFN_DOCS_HOST is set.
import type { Context, Next } from 'hono'

/** What the page itself needs on this host: fonts, icons; and security.txt. Everything else there is a doc, or a 404. */
const ASSET = /^\/(assets\/|favicon\.|apple-touch-icon|\.well-known\/security\.txt$)/
/** Pages that belong to the app, reached from a doc's header. */
const APP_PAGES = new Set(['/privacy', '/terms', '/security', '/support'])

export const docsPath = (path: string): string => (path === '/' ? '/docs' : `/docs${path}`)

/** A page written for the app, as it reads on the docs host. */
export function forDocsHost(html: string, baseUrl: string, host: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const origin = `https://${host}`
  return html
    .split(`${base}/docs`)
    .join(origin)
    .replace(/(href=")\/docs\/?(?=["#/a-z])/g, '$1/')
    .replace(/href="\/(privacy|terms|security|support)"/g, `href="${base}/$1"`)
    .replace(/<a href="\/">Aggregate<\/a>/, `<a href="${base}/">Aggregate</a>`)
}

/** `render`: the same request, as the app would answer it at /docs. */
export function docsHost(o: { host: string; baseUrl: string; isDoc: (appPath: string) => boolean; sitemap: () => string; text: (path: string) => string | null; render: (appPath: string, c: Context) => Promise<Response> }) {
  const app = o.baseUrl.replace(/\/+$/, '')
  const moved = (path: string, search: string) => `https://${o.host}${path}${search}`
  return async (c: Context, next: Next) => {
    if (c.env?.docsInner) return next()
    const url = new URL(c.req.url)
    const here = (c.req.header('host') ?? '').split(':')[0]!.toLowerCase()
    const reading = c.req.method === 'GET' || c.req.method === 'HEAD'
    if (here !== o.host) {
      // Old links, in-app ones included, land on the same page there.
      if (!reading || !(url.pathname === '/docs' || url.pathname.startsWith('/docs/'))) return next()
      return c.redirect(moved(url.pathname.replace(/^\/docs\/?/, '/').replace(/\/$/, '') || '/', url.search), 301)
    }
    if (!reading) return c.notFound()
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname
    if (ASSET.test(path)) return next()
    const text = o.text(path)
    if (text !== null) return c.text(text, 200, { 'cache-control': 'public, max-age=3600' })
    if (path === '/sitemap.xml') return c.body(o.sitemap(), 200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' })
    if (path === '/docs' || path.startsWith('/docs/')) return c.redirect(path.replace(/^\/docs\/?/, '/') + url.search, 301)
    if (APP_PAGES.has(path)) return c.redirect(`${app}${path}`, 301)
    if (!o.isDoc(docsPath(path))) return c.text('Not found', 404)
    const res = await o.render(docsPath(path), c)
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/html')) return res
    return new Response(forDocsHost(await res.text(), o.baseUrl, o.host), { status: res.status, headers: res.headers })
  }
}
