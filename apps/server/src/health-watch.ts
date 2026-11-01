import { createServer, type Server } from 'node:http'
import type { Alert } from './alerts.ts'

/**
 * /healthz answers "busy" instead of failing when its database probe is slow (app.ts). That keeps Fly from pulling the
 * only machine, but would hide a stuck database, so each busy answer is logged, counted for the infra page, and a busy
 * streak past BUSY_ALERT_MS alerts through the operator alerter (console, webhook, Telegram).
 */
export const BUSY_ALERT_MS = 120_000
/** A probe still unanswered this long gets its log line anyway (pg's pool wait has no timeout of its own). */
const PROBE_LOG_MAX_MS = 30_000

export type HealthWatch = {
  /** One busy answer; `probe` is the still-running database probe and `started` when it began. */
  busy(probe: Promise<unknown>, started: number): void
  /** A healthy answer: the busy streak ends. */
  ok(): void
  /** Prometheus text for Fly's metrics scrape. */
  metrics(): string
}

export function createHealthWatch(alert?: Alert, now: () => number = Date.now): HealthWatch {
  let busyTotal = 0
  let streakSince: number | null = null
  let alerted = false
  return {
    busy(probe, started) {
      busyTotal++
      streakSince ??= now()
      const streak = now() - streakSince
      if (!alerted && streak >= BUSY_ALERT_MS) {
        alerted = true
        alert?.('error', 'database busy for 2+ minutes (/healthz answering "busy")', { count: busyTotal })
      }
      let logged = false
      const line = (how: string) => {
        if (logged) return
        logged = true
        console.warn(`[agfn] healthz busy: database ${how} after ${now() - started} ms (busy ${busyTotal} times since boot)`)
      }
      const cap = setTimeout(() => line('still waiting'), PROBE_LOG_MAX_MS)
      cap.unref()
      probe.then(
        () => line('answered'),
        () => line('failed'),
      ).finally(() => clearTimeout(cap))
    },
    ok() {
      streakSince = null
      alerted = false
    },
    metrics() {
      const streak = streakSince === null ? 0 : Math.round((now() - streakSince) / 1000)
      return [
        '# HELP agfn_healthz_busy_total /healthz answers where the database probe was still waiting.',
        '# TYPE agfn_healthz_busy_total counter',
        `agfn_healthz_busy_total ${busyTotal}`,
        '# HELP agfn_healthz_busy_streak_seconds How long /healthz has been answering busy without a break (0 when healthy).',
        '# TYPE agfn_healthz_busy_streak_seconds gauge',
        `agfn_healthz_busy_streak_seconds ${streak}`,
        '',
      ].join('\n')
    },
  }
}

/** AGFN_METRICS_PORT: Prometheus text at /metrics for Fly's scrape ([metrics] in fly.*.toml). Not a public service port. */
export function serveMetrics(watch: HealthWatch, port: number): Server {
  const server = createServer((req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(watch.metrics())
  })
  server.listen(port, '::')
  return server
}
