// Leaving the demo: the made-up companies go; back to their own company, or setup starts at "What's your company called?".
import type { App } from '../app/context.ts'

/** Whether to offer the way out: a demo someone chose, not the app-store reviewer demo (which has no way out). */
export const inDemo = (app: Pick<App, 'ws' | 'me'>, reviewer: boolean): boolean => !!app.ws?.me.demo && !reviewer && !app.me?.publicDemo

// The no-sign-up demo (app.aggregate.finance/demo → #/?demo=1): the dashboard, read-only, on the public demo's books.
// Remembered for this tab only; the server decides (a signed-in person always gets their own books).
const PUBLIC_KEY = 'agfn.publicDemo'
const asked = () => /[?&]demo=1(&|$)/.test(globalThis.location?.hash ?? '')
export function publicDemoOn(): boolean {
  try {
    if (asked()) sessionStorage.setItem(PUBLIC_KEY, '1')
    return sessionStorage.getItem(PUBLIC_KEY) === '1'
  } catch {
    return asked()
  }
}
export function endPublicDemo(): void {
  try {
    sessionStorage.removeItem(PUBLIC_KEY)
  } catch {
    // Storage off: nothing was remembered.
  }
}
export const isPublicDemo = (app: Pick<App, 'me'>): boolean => !!app.me?.publicDemo

/** Drawers that change something: in the public demo they open "This is a read-only demo" instead. */
export const DEMO_WRITE_VIEWS = new Set(['add', 'connect', 'connect-ai', 'company-new', 'invite', 'person', 'plaid-return', 'delete-workspace', 'delete-me', 'equity-add', 'equity-round', 'equity-exit', 'stake-add', 'share', 'ai'])

/** Leave the demo for sign-up. */
export function signUpFromDemo(app: Pick<App, 'go'>): void {
  endPublicDemo()
  location.hash = '#/signin'
  location.reload()
}

export async function leaveDemo(app: Pick<App, 'api' | 'reload' | 'go' | 'toast'>): Promise<void> {
  try {
    await app.api.leaveDemo()
    await app.reload()
    // Back to their own company if they'd named one before looking around; otherwise setup starts over.
    const me = await app.api.me().catch(() => null)
    app.go(me && !me.needsOnboarding ? { page: 'workspace', step: 0, stack: [] } : { page: 'welcome', step: 1, stack: [] })
  } catch (e) {
    app.toast({ text: e instanceof Error ? e.message : 'That didn’t work. Try again.' })
  }
}
