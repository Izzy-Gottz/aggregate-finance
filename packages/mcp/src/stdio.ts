// stdio entries for local clients (Claude Desktop, Claude Code, Cursor):
// - serveLocal: this process holds the database (self-host on the same machine); an agent key picks the grant.
// - runBridge: a thin stdio ↔ remote proxy for a Aggregate server elsewhere, authenticated with an agent key.
// Keys come from the AGFN_KEY environment variable, never argv (process lists are world-readable).

import { Server, type CallToolResult, type ListToolsResult } from '@modelcontextprotocol/server'
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { buildMcpServer, SERVER_INFO, SERVER_INSTRUCTIONS, serverInfo } from './mcp-server.ts'
import type { AgfnMcp } from './service.ts'

export const STDIO_RESOURCE = 'stdio:local'

export async function serveLocal(service: AgfnMcp, key: string): Promise<StdioServerHandle> {
  const auth = await service.authenticate(key, { resource: STDIO_RESOURCE, userAgent: 'stdio' })
  if (!auth.ok) throw new Error(`Aggregate: ${auth.description}`)
  const principal = auth.principal
  return serveStdio(async () => buildMcpServer(service, principal, await service.listTools(principal)), { onerror: (e) => process.stderr.write(`agfn: ${e.message}\n`) })
}

export interface BridgeOptions {
  url: string
  key: string
  /** For tests: transport/fetch overrides. */
  fetch?: typeof fetch
}

/** Proxy tools/list and tools/call to a remote Aggregate. Everything is still decided by the remote server. */
export async function connectRemote(opts: BridgeOptions): Promise<Client> {
  const url = new URL(opts.url)
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Aggregate bridge: the server URL must be https (or localhost)')
  const client = new Client({ name: 'agfn-bridge', version: SERVER_INFO.version })
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${opts.key}` } }, ...(opts.fetch ? { fetch: opts.fetch } : {}) })
  await client.connect(transport)
  return client
}

export function bridgeServer(remote: Client): Server {
  const server = new Server(serverInfo(undefined), { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS })
  server.setRequestHandler('tools/list', async (req): Promise<ListToolsResult> => remote.listTools(req.params))
  server.setRequestHandler('tools/call', async (req): Promise<CallToolResult> => remote.callTool(req.params))
  return server
}

export async function runBridge(opts: BridgeOptions): Promise<StdioServerHandle> {
  const remote = await connectRemote(opts)
  return serveStdio(() => bridgeServer(remote), { onerror: (e) => process.stderr.write(`agfn bridge: ${e.message}\n`) })
}
