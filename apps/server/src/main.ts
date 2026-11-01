import { serve } from '@hono/node-server'
import type { Server } from 'node:net'
import { loadConfig } from './config.ts'
import { boot, startLoopLagLog, startReadyGate } from './boot.ts'
import { createApp } from './app.ts'
import { loadInstalledModules } from './modules.ts'
import { serveMetrics } from './health-watch.ts'
import { drainServer } from './drain.ts'

// Everything the server writes (the SQLite database, document files) is for this user only.
process.umask(0o077)

const config = loadConfig()
const modules = await loadInstalledModules(process.env)
const booted = await boot({ config, ...modules })
if (config.role !== 'worker') startReadyGate(booted)
startLoopLagLog()
const app = createApp(booted.services)
if (process.env.AGFN_METRICS_PORT && booted.services.health) serveMetrics(booted.services.health, Number(process.env.AGFN_METRICS_PORT))

if (config.role !== 'worker') {
  // No HOST: every interface, IPv6 and IPv4 ("::" is dual-stack), so `localhost` works where it resolves to ::1
  // first. Hosts without IPv6 fall back to 0.0.0.0. Set HOST=127.0.0.1 to keep the server to this machine.
  const listen = (hostname: string) =>
    serve({ fetch: app.fetch, port: config.port, hostname }, (info) => {
      const where = !config.host || config.host === '0.0.0.0' || config.host === '::' ? 'all interfaces' : `${config.host} only`
      console.log(`[agfn] listening on ${config.baseUrl} (port ${info.port}, ${where})`)
    }) as unknown as Server
  let server = listen(config.host ?? '::')
  if (!config.host) {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EAFNOSUPPORT' && err.code !== 'EADDRNOTAVAIL') throw err
      server = listen('0.0.0.0')
    })
  }
  // Requests already running finish before the database closes (drain.ts); under Fly's 30 s kill_timeout.
  const graceMs = Number(process.env.AGFN_SHUTDOWN_GRACE_MS) > 0 ? Number(process.env.AGFN_SHUTDOWN_GRACE_MS) : 15_000
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    const how = await drainServer(server, graceMs)
    if (how === 'timeout') console.warn(`[agfn] shutdown: requests still running after ${graceMs} ms were cut`)
    await booted.shutdown()
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
} else {
  console.log('[agfn] worker running')
  const stop = async () => {
    await booted.shutdown()
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
