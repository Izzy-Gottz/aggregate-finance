import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { mcpTiming, timedMethods } from './mcp-timing.ts'

describe('mcp timing', () => {
  it('finds initialize and tools/list, in one message or a batch', () => {
    expect(timedMethods('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')).toEqual(['tools/list'])
    expect(timedMethods('[{"method":"initialize"},{"method":"notifications/initialized"}]')).toEqual(['initialize'])
    expect(timedMethods('{"method":"tools/call","params":{"name":"get_overview"}}')).toEqual([])
    expect(timedMethods('not json')).toEqual([])
  })

  it('logs method, ms and status only, and leaves the body for the handler', async () => {
    const lines: Array<Record<string, unknown>> = []
    const app = new Hono()
    app.use('/mcp', mcpTiming((_l, f) => lines.push(f)))
    app.post('/mcp', async (c) => c.json({ got: ((await c.req.json()) as { method: string }).method }, 401))
    const post = (body: string) => app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(body.length), authorization: 'Bearer secret-token' }, body })
    const res = await post('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
    expect(await res.json()).toEqual({ got: 'tools/list' })
    expect(lines).toHaveLength(1)
    expect(Object.keys(lines[0]!).sort()).toEqual(['method', 'ms', 'status'])
    expect(lines[0]).toMatchObject({ method: 'tools/list', status: 401 })
    expect(JSON.stringify(lines)).not.toContain('secret')
    await post('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_overview"}}')
    expect(lines).toHaveLength(1)
  })
})
