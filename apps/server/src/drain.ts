import type { Server } from 'node:net'

type HttpServer = Server & { closeIdleConnections?(): void; closeAllConnections?(): void }

/**
 * Stop taking requests and wait for the ones already running to finish (at most `graceMs`; then the rest are cut), so
 * the database closes only after them. Without this a deploy's SIGTERM closed the pool under every in-flight request:
 * each failed with "driver has already been destroyed" (staging load test, 2026-10-13).
 */
export function drainServer(server: HttpServer, graceMs: number): Promise<'drained' | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      server.closeAllConnections?.()
      resolve('timeout')
    }, graceMs)
    timer.unref()
    server.close(() => {
      clearTimeout(timer)
      resolve('drained')
    })
    // Kept-alive sockets with no request running would otherwise hold close() open until they time out.
    server.closeIdleConnections?.()
  })
}
