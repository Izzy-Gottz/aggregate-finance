// Cursor-based sync runner. Calls connector.sync() page by page until hasMore is false, checkpointing after each
// page (the caller persists events + cursor atomically in onPage), so a crash resumes from the last good page.

import type { Connector, ConnectionRef, ConnectorHealth, NormalizedEvent, SyncResult } from '@agfn/contracts'
import { ConnectorError, isConnectorError } from './errors.ts'
import type { Clock, FetchLike } from './http.ts'
import type { RawSink } from './raw.ts'

/** What every connector factory receives. Everything external is injectable for tests. */
export interface ConnectorDeps {
  raw: RawSink
  fetch?: FetchLike
  clock?: Clock
  random?: () => number
  /**
   * Keep a rotated secret now. Connectors whose refresh tokens rotate call this right after a refresh, before any
   * page is fetched: a page that fails afterwards (or a crash) must not leave the stored, already-spent token behind.
   * The sync engine provides it; without it, updatedSecret on the page is the only way the new secret is kept.
   */
  saveSecret?: (connectionId: string, secret: unknown) => Promise<void>
}

/** Kept for callers written before SyncResult.updatedSecret landed in contracts. */
export type SyncResultWithSecret = SyncResult

export interface RunSyncOptions {
  /** Stop after this many pages even if more remain (the caller schedules the rest). Default 1000. */
  maxPages?: number
  /** Persist one page: store events, then the cursor. Throwing aborts the run without advancing. */
  onPage?: (page: SyncResultWithSecret, index: number) => Promise<void>
  /** On cursor_invalid, restart once from null (full re-sync; idempotent ids make this safe). Default true. */
  restartOnInvalidCursor?: boolean
}

export interface RunSyncResult {
  events: NormalizedEvent[]
  cursor: string | null
  pages: number
  complete: boolean
  restarted: boolean
  updatedSecret?: unknown
  /** Shortest SyncResult.syncAgainInMs any page asked for. */
  syncAgainInMs?: number
}

export async function runSync(
  connector: Connector,
  conn: ConnectionRef,
  startCursor: string | null,
  opts: RunSyncOptions = {},
): Promise<RunSyncResult> {
  const maxPages = opts.maxPages ?? 1000
  const events: NormalizedEvent[] = []
  let cursor = startCursor
  let pages = 0
  let restarted = false
  let updatedSecret: unknown
  let syncAgainInMs: number | undefined
  let current = conn

  while (pages < maxPages) {
    let page: SyncResultWithSecret
    try {
      page = await connector.sync(current, cursor)
    } catch (e) {
      if (
        isConnectorError(e) &&
        e.kind === 'cursor_invalid' &&
        (opts.restartOnInvalidCursor ?? true) &&
        !restarted
      ) {
        restarted = true
        cursor = null
        continue
      }
      throw e
    }
    if (page.updatedSecret !== undefined) {
      updatedSecret = page.updatedSecret
      current = { ...current, secret: page.updatedSecret }
    }
    await opts.onPage?.(page, pages)
    if (typeof page.syncAgainInMs === 'number' && page.syncAgainInMs > 0) syncAgainInMs = Math.min(syncAgainInMs ?? Infinity, page.syncAgainInMs)
    pages++
    events.push(...page.events)
    if (page.hasMore && page.cursor === cursor) {
      throw new ConnectorError('permanent', 'connector reported more pages without advancing its cursor', {
        provider: connector.describe().key,
      })
    }
    cursor = page.cursor
    if (!page.hasMore) {
      return { events, cursor, pages, complete: true, restarted, ...(updatedSecret !== undefined ? { updatedSecret } : {}), ...(syncAgainInMs !== undefined ? { syncAgainInMs } : {}) }
    }
  }
  return { events, cursor, pages, complete: false, restarted, ...(updatedSecret !== undefined ? { updatedSecret } : {}), ...(syncAgainInMs !== undefined ? { syncAgainInMs } : {}) }
}

/** Keep the last event per (type, externalId): a page can mention one object twice (added then modified). */
export function dedupeEvents(events: NormalizedEvent[]): NormalizedEvent[] {
  const byKey = new Map<string, NormalizedEvent>()
  for (const e of events) {
    const key = e.type + '\0' + e.externalId
    byKey.delete(key)
    byKey.set(key, e)
  }
  return [...byKey.values()]
}

/** Map any error from a health probe or sync to a ConnectorHealth row. */
export function healthFromError(e: unknown): ConnectorHealth {
  if (isConnectorError(e)) {
    if (e.kind === 'auth') return { status: 'needs_reauth', message: e.message }
    if (e.kind === 'rate_limited') return { status: 'rate_limited', message: e.message }
    return { status: 'error', message: e.message }
  }
  return { status: 'error', message: e instanceof Error ? e.message : 'unknown error' }
}

/** Read a typed secret, failing with invalid_input (not a crash) when it's the wrong shape. */
export function requireSecret<T>(provider: string, secret: unknown, check: (s: unknown) => s is T): T {
  if (!check(secret)) throw new ConnectorError('auth', 'stored credentials are missing or malformed', { provider })
  return secret
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/** ISO date (YYYY-MM-DD) from a timestamp or date string, in UTC unless the provider gives a date already. */
export function isoDate(v: string | number | Date): string {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v
  const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v)
  if (Number.isNaN(d.getTime())) throw new ConnectorError('invalid_input', `bad date: ${String(v).slice(0, 40)}`, { provider: 'sdk' })
  return d.toISOString().slice(0, 10)
}

export function isoTimestamp(v: string | number | Date): string {
  const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v)
  if (Number.isNaN(d.getTime())) throw new ConnectorError('invalid_input', `bad timestamp: ${String(v).slice(0, 40)}`, { provider: 'sdk' })
  return d.toISOString()
}
