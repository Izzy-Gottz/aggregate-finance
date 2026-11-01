import { createContext, type ComponentChildren } from 'preact'
import { useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks'
import type { Me, AgfnApi, Workspace } from '../api/types.ts'
import type { Route, View } from './router.ts'

export interface Toast {
  text: string
  undo?: () => void
}

export interface App {
  api: AgfnApi
  me: Me | null
  ws: Workspace | null
  reload: () => Promise<void>
  route: Route
  go: (r: Partial<Route>) => void
  open: (v: View) => void
  push: (v: View) => void
  back: () => void
  close: () => void
  /** "All companies" (null) or one entity id. */
  scope: string | null
  setScope: (id: string | null) => void
  toast: (t: Toast) => void
  /** Signed out on purpose (account deleted): sign-in shows `note`, not "You were signed out". */
  leave: (note: string) => void
  now: () => number
}

export const AppCtx = createContext<App | null>(null)

/** Reviewer demo: hide what the server refuses (accounts, people, connections, sign-in), keep reading, AI and Review. */
/**
 * An owner or admin of the workspace in view: the only ones the server lets add or disconnect connections, add companies
 * or invite. Everyone else doesn't see those actions (they used to, and the server refused). Unknown role: shown, as before.
 */
export const isManager = (app: Pick<App, 'me'>): boolean => {
  const role = app.me?.workspaces?.find((w) => w.id === app.me?.workspaceId)?.role
  return role === undefined || role === 'owner' || role === 'admin'
}
/** An owner of the workspace in view: deleting a company is theirs alone. */
export const isOwnerHere = (app: Pick<App, 'me'>): boolean => {
  const role = app.me?.workspaces?.find((w) => w.id === app.me?.workspaceId)?.role
  return role === undefined || role === 'owner'
}

export const isReviewer = (app: Pick<App, 'me' | 'ws'>): boolean => !!(app.me?.reviewerDemo || (app.ws?.me as { reviewerDemo?: boolean } | undefined)?.reviewerDemo)

/**
 * Demo still loading its made-up history: figures and counts (cash, Review, "N things need a look") stay hidden until
 * the server says the demo is ready AND no connection is still syncing, then appear at once.
 */
export const isFilling = (ws: Workspace | null | undefined): boolean =>
  !!ws?.me.demo && (ws.me.demoReady === false || ws.connections.some((c) => c.status === 'syncing'))

/** A company whose connection is syncing right now (real workspaces show its figures with a quiet "updating"). */
export const isUpdating = (ws: Workspace | null | undefined, companyName: string): boolean => !!ws?.connections.some((c) => c.status === 'syncing' && c.entityNames.includes(companyName))

export function useApp(): App {
  const a = useContext(AppCtx)
  if (!a) throw new Error('useApp outside <AppCtx.Provider>')
  return a
}

export interface Loaded<T> {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
}

/** Load something from the API; re-runs when deps change. Errors become plain sentences. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): Loaded<T> {
  const [state, set] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true })
  const seq = useRef(0)
  const run = useCallback(() => {
    const n = ++seq.current
    set((s) => ({ ...s, loading: true, error: null }))
    fn().then(
      (data) => n === seq.current && set({ data, error: null, loading: false }),
      (e: unknown) => n === seq.current && set({ data: null, error: e instanceof Error ? e.message : 'Something went wrong.', loading: false }),
    )
  }, deps)
  useEffect(run, [run])
  return { ...state, reload: run }
}

export type { ComponentChildren }
