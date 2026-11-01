// Arm B's bridge: a plain MCP client (streamable HTTP, bearer agent key) whose tools are handed to each model as
// function tools. The same bridge serves every provider, so tool access is identical across models.
import type { Tool } from './models.ts'

export interface McpSession { tools: Tool[]; call(name: string, args: unknown): Promise<string> }

export async function connectMcp(url: string, key: string): Promise<McpSession> {
  let sid: string | null = null, id = 1
  const headers = (): Record<string, string> => {
    const h: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` }
    if (sid) h['mcp-session-id'] = sid
    return h
  }
  const rpc = async (method: string, params?: unknown): Promise<any> => {
    const r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, ...(params === undefined ? {} : { params }) }) })
    sid ??= r.headers.get('mcp-session-id')
    const text = await r.text()
    const data = text.match(/^data: (.*)$/m)?.[1] ?? text
    const msg = data ? JSON.parse(data) : {}
    if (msg.error) throw new Error(msg.error.message ?? JSON.stringify(msg.error))
    return msg.result
  }
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agfn-benchmark', version: '1' } })
  await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
  const listed = await rpc('tools/list', {})
  // Only the read-only tools: the key can't write, and the write tools' schemas would cost every model ~13k tokens a turn.
  const tools: Tool[] = listed.tools.filter((t: any) => t.annotations?.readOnlyHint === true).map((t: any) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? { type: 'object', properties: {} } }))
  return {
    tools,
    async call(name, args) {
      const r = await rpc('tools/call', { name, arguments: args ?? {} })
      // Text content is what an MCP client shows a model; structuredContent duplicates it.
      const text = (r.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
      return (r.isError ? 'Error: ' : '') + (text || JSON.stringify(r.structuredContent ?? {}))
    },
  }
}
