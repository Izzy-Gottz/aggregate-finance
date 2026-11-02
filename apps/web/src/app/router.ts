// Hash routes, so any static host (and apps/server's SPA fallback) works, and every drawer is a shareable link.
// #/                       Workspace
// #/review                 Review
// #/preferences            Preferences
// #/signin                 Sign in
// #/welcome/2              Onboarding step (1 company · 2 connect · 3 AI link · 4 first question)
// #/connect-ai/consent?…   OAuth consent for an AI (Better Auth redirects here with consent_code, client_id, scope)
// ...?d=company:e_acme/bucket:b_rent   drawer stack (last one is shown, Back pops)

export type Page = 'workspace' | 'review' | 'preferences' | 'signin' | 'welcome' | 'consent'

export type View =
  | { kind: 'company'; id: string }
  | { kind: 'explain'; id: string; metric: 'cash' | 'runway' }
  | { kind: 'txns'; id: string }
  | { kind: 'bucket'; id: string }
  | { kind: 'ai'; id: string }
  | { kind: 'connect-ai' }
  | { kind: 'connection'; id: string }
  | { kind: 'connect'; key?: string; entity?: string }
  | { kind: 'add'; what: 'cash' | 'upload' | 'email' }
  | { kind: 'company-new' }
  | { kind: 'invite' }
  | { kind: 'friend-invite' }
  | { kind: 'person'; id: string }
  | { kind: 'plaid-return' }
  | { kind: 'health' }
  | { kind: 'delete-workspace' }
  | { kind: 'delete-me' }
  | { kind: 'equity' | 'equity-add' | 'equity-round' | 'equity-exit'; id: string }
  | { kind: 'mrr'; id: string }
  | { kind: 'stake-add'; id: string }
  | { kind: 'investments'; id: string }
  | { kind: 'share'; id: string }

export interface Route {
  page: Page
  step: number
  stack: View[]
  /** Raw query params other than the drawer stack (consent_code, client_id, scope…). */
  params: Record<string, string>
}

const PAGES: Page[] = ['workspace', 'review', 'preferences', 'signin', 'welcome', 'consent']
const SAFE = /^[\w.-]{1,80}$/

function parseView(s: string): View | null {
  const [kind = '', a, b] = s.split(':')
  const ok = (x: string | undefined): x is string => !!x && SAFE.test(x)
  switch (kind) {
    case 'company':
    case 'txns':
    case 'bucket':
    case 'ai':
    case 'connection':
    case 'person':
    case 'equity':
    case 'equity-add':
    case 'equity-round':
    case 'equity-exit':
    case 'mrr':
    case 'stake-add':
    case 'investments':
    case 'share':
      return ok(a) ? { kind, id: a } : null
    case 'explain':
      return ok(a) && (b === 'cash' || b === 'runway') ? { kind, id: a, metric: b } : null
    case 'connect':
      return ok(a) ? { kind, key: a, ...(ok(b) ? { entity: b } : {}) } : { kind }
    case 'add':
      return a === 'cash' || a === 'upload' || a === 'email' ? { kind, what: a } : null
    case 'connect-ai':
    case 'company-new':
    case 'invite':
    case 'friend-invite':
    case 'plaid-return':
    case 'health':
    case 'delete-workspace':
    case 'delete-me':
      return { kind }
    default:
      return null
  }
}

export function viewKey(v: View): string {
  switch (v.kind) {
    case 'explain':
      return `explain:${v.id}:${v.metric}`
    case 'add':
      return `add:${v.what}`
    case 'connect':
      return v.key ? `connect:${v.key}${v.entity ? ':' + v.entity : ''}` : 'connect'
    case 'connect-ai':
    case 'company-new':
    case 'invite':
    case 'friend-invite':
    case 'plaid-return':
    case 'health':
    case 'delete-workspace':
    case 'delete-me':
      return v.kind
    default:
      return `${v.kind}:${v.id}`
  }
}

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, '')
  const [path = '', query = ''] = h.split('?')
  const [p = '', s] = path.split('/')
  const page: Page =
    // Better Auth's OAuth login page is #/sign-in?<signed query>: the sign-in page, keeping that query.
    p === 'connect-ai' && s === 'consent' ? 'consent' : p === 'sign-in' ? 'signin' : p === '' ? 'workspace' : PAGES.includes(p as Page) && p !== 'consent' ? (p as Page) : 'workspace'
  const step = page === 'welcome' ? Math.min(4, Math.max(1, Number(s) || 1)) : 0
  const q = new URLSearchParams(query)
  const d = q.get('d') ?? ''
  q.delete('d')
  const stack = d ? d.split('/').map(parseView).filter((v): v is View => v !== null).slice(0, 6) : []
  return { page, step, stack, params: Object.fromEntries(q) }
}

export function formatHash(r: Pick<Route, 'page' | 'step' | 'stack'> & { params?: Record<string, string> }): string {
  const base =
    r.page === 'workspace' ? '#/' : r.page === 'welcome' ? `#/welcome/${r.step || 1}` : r.page === 'consent' ? '#/connect-ai/consent' : `#/${r.page}`
  const q = new URLSearchParams(r.params ?? {})
  const parts = [q.toString(), r.stack.length ? `d=${r.stack.map(viewKey).join('/')}` : ''].filter(Boolean)
  return parts.length ? `${base}?${parts.join('&')}` : base
}

/** Where a connect round trip (OAuth, Plaid OAuth banks) should come back to: this page, without drawers or params.
 *  The server accepts only a plain app path (/^\/[A-Za-z0-9/_-]{0,80}$/); anything else means the overview. */
export function returnPath(r: Pick<Route, 'page' | 'step'>): string {
  const p = formatHash({ page: r.page, step: r.step, stack: [] }).slice(1)
  return /^\/[A-Za-z0-9/_-]{0,80}$/.test(p) ? p : '/'
}
