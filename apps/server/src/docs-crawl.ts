// What crawlers and AI assistants read: robots.txt on the app and docs hosts, llms.txt and llms-full.txt on docs.
// Built from the same pages people see, so these never say anything the docs don't.

export interface CrawlPage {
  path: string
  title: string
  description: string
  md: string
}

const BOTS = ['OAI-SearchBot', 'ChatGPT-User', 'GPTBot', 'Claude-SearchBot', 'Claude-User', 'ClaudeBot', 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Bingbot']

/** Signed-in and machine paths on the app host. Everything else there is public or a redirect. */
export const APP_DISALLOW = ['/api/', '/mcp', '/demo/mcp', '/v1/', '/recheck', '/review-access', '/disconnected/']

/** A bot follows only the group that names it, so both groups carry the same rules. */
export function robotsTxt(sitemaps: string[], disallow: string[] = []): string {
  const rules = ['Allow: /', ...disallow.map((p) => `Disallow: ${p}`)].join('\n')
  return `User-agent: *\n${rules}\n\n${BOTS.map((b) => `User-agent: ${b}`).join('\n')}\n${rules}\n\n${sitemaps.map((s) => `Sitemap: ${s}`).join('\n')}\n`
}

const urlOf = (origin: string, path: string) => `${origin}${path.replace(/^\/docs\/?/, '/').replace(/(?<=.)\/$/, '')}`

export function llmsTxt(origin: string, pages: CrawlPage[]): string {
  return `# Aggregate

> Aggregate connects your banks, Stripe, QuickBooks and other financial accounts to the AI you already use, so you can ask about your finances. It can't move money.

## Docs

${pages.map((p) => `- [${p.title}](${urlOf(origin, p.path)}): ${p.description}`).join('\n')}
`
}

export function llmsFullTxt(origin: string, pages: CrawlPage[]): string {
  return pages.map((p) => `Source: ${urlOf(origin, p.path)}\n\n${p.md.trim().replace(/\]\(\/docs\/?/g, `](${origin}/`)}`).join('\n\n---\n\n') + '\n'
}
