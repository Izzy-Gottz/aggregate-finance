import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { drainServer } from './drain.ts'

const listen = (handler: Parameters<typeof createServer>[1]) =>
  new Promise<{ server: ReturnType<typeof createServer>; url: string }>((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }))
  })

describe('drainServer', () => {
  it('lets a running request finish before it resolves', async () => {
    const order: string[] = []
    const { server, url } = await listen((_req, res) => setTimeout(() => { order.push('responded'); res.end('ok') }, 300))
    const pending = fetch(url).then((r) => r.text())
    await new Promise((r) => setTimeout(r, 50))
    const how = await drainServer(server, 5_000).then((h) => { order.push('drained'); return h })
    expect(how).toBe('drained')
    expect(await pending).toBe('ok')
    expect(order).toEqual(['responded', 'drained'])
  })

  it('cuts requests still running after the grace period', async () => {
    const { server, url } = await listen(() => undefined)
    const pending = fetch(url).catch(() => 'cut')
    await new Promise((r) => setTimeout(r, 50))
    expect(await drainServer(server, 200)).toBe('timeout')
    expect(await pending).toBe('cut')
  })
})
