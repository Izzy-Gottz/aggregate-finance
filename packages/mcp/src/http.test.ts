import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { DEMO } from './fakes/demo-books.ts'
import { makeHarness, READ_ALL, RESOURCE, type Harness } from './fakes/harness.ts'
import { bridgeServer, connectRemote } from './stdio.ts'
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server'
import { ALL_TOOLS } from './service.ts'
import { annotations } from './mcp-server.ts'

let H: Harness
beforeEach(async () => {
  H = await makeHarness()
})
afterEach(async () => {
  await H.close()
})

/** Route a client's HTTP straight into the handler (no sockets). */
const inProcessFetch = (h: Harness): typeof fetch => (async (input: RequestInfo | URL, init?: RequestInit) => h.agfn.fetch(new Request(input, init))) as typeof fetch

async function mcpClient(key: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(RESOURCE), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: inProcessFetch(H) }))
  return client
}

const req = (path: string, init: RequestInit & { key?: string } = {}) => {
  const headers = new Headers(init.headers)
  if (init.key) headers.set('authorization', `Bearer ${init.key}`)
  return H.agfn.fetch(new Request(new URL(path, RESOURCE), { ...init, headers }))
}

describe('MCP over Streamable HTTP', () => {
  it('lists only granted tools and calls them through the official client', async () => {
    const { key } = await H.connectAi({ write: true, entityIds: [DEMO.acme] })
    const client = await mcpClient(key)
    const { tools } = await client.listTools()
    const byName = new Map(tools.map((t) => [t.name, t]))
    expect(byName.has('add_entry')).toBe(true)
    expect(byName.get('void_record')?.annotations).toMatchObject({ destructiveHint: true, openWorldHint: false, readOnlyHint: false })
    expect(byName.get('get_overview')?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false })
    expect(byName.get('add_entry')?.annotations?.destructiveHint).toBe(false)
    expect(byName.get('add_entry')?.description).toContain('The company and whose money are inputs Aggregate never infers')
    const res = await client.callTool({ name: 'get_overview', arguments: {} })
    expect(res.isError).toBeFalsy()
    expect(res.structuredContent).toMatchObject({ companies: [{ company: 'Acme', cash: { amount: '284410.00', currency: 'USD' } }] })
    const bad = await client.callTool({ name: 'get_overview', arguments: { company: 'Northwind' } })
    expect(bad.isError).toBe(true)
    await client.close()
  })

  it('read-only connections see the full list but every write is refused, saying why', async () => {
    const { key } = await H.connectAi({ write: false })
    const client = await mcpClient(key)
    const { tools } = await client.listTools()
    expect(tools.some((t) => t.name === 'add_entry')).toBe(true) // the same list for everyone
    const r = (await client.callTool({ name: 'add_entry', arguments: { company: 'Acme', kind: 'cash_income', amount: { amount: '10.00', currency: 'USD' }, date: '2026-10-01', paid_by: 'Acme', reason: 'test', idempotency_key: 'readonly-check-1' } })) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(r.isError).toBe(true)
    expect(r.content.map((c) => c.text).join(' ')).toMatch(/read-only/)
    await client.close()
  })

  it('an unknown argument comes back as a tool error the model can read (isError), not a protocol error; _meta passes', async () => {
    const { key } = await H.connectAi({ entityIds: [DEMO.acme] })
    const client = await mcpClient(key)
    const r = (await client.callTool({ name: 'query_transactions', arguments: { company: 'Acme', include_paid: true } })) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(r.isError).toBe(true)
    expect(r.content.map((c) => c.text).join(' ')).toMatch(/^Unknown argument: include_paid\. query_transactions takes: /)
    const ok = await client.callTool({ name: 'query_transactions', arguments: { company: 'Acme' }, _meta: { progressToken: 'p1' } })
    expect(ok.isError).toBeFalsy()
    await client.close()
  })

  it('tools/list is exactly what registering the plain zod schemas would publish (the raw-args pass-through changes nothing)', async () => {
    const { key } = await H.connectAi({ write: true })
    const client = await mcpClient(key)
    const ours = await client.listTools()
    await client.close()
    // The SDK's own conversion of each tool's zod schema, as before the pass-through.
    const plain = new McpServer({ name: 'plain', version: '1' }, { capabilities: { tools: {} } })
    for (const t of ALL_TOOLS) plain.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.input, ...(t.output ? { outputSchema: t.output } : {}), annotations: annotations(t) }, async () => ({ content: [] }))
    const [a, b] = InMemoryTransport.createLinkedPair()
    await plain.connect(a)
    const ref = new Client({ name: 'ref', version: '1' })
    await ref.connect(b)
    const expected = new Map((await ref.listTools()).tools.map((t) => [t.name, t]))
    await ref.close()
    expect(ours.tools.length).toBeGreaterThan(30)
    for (const t of ours.tools) expect(JSON.stringify(t), t.name).toBe(JSON.stringify(expected.get(t.name)))
  })

  it('401s with a resource_metadata challenge, and serves RFC 9728 metadata', async () => {
    const r = await req('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })
    expect(r.status).toBe(401)
    expect(r.headers.get('www-authenticate')).toContain('resource_metadata="https://agfn.test/.well-known/oauth-protected-resource/mcp"')
    expect(r.headers.get('www-authenticate')).toContain('scope="finance:read records:write"')
    const bad = await req('/mcp', { method: 'POST', key: 'agfn_live_' + 'x'.repeat(43), headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(bad.status).toBe(401)
    const prm = await (await req('/.well-known/oauth-protected-resource/mcp')).json()
    expect(prm).toMatchObject({ resource: RESOURCE, authorization_servers: ['https://agfn.test'], scopes_supported: ['finance:read', 'records:write'], bearer_methods_supported: ['header'] })
  })

  it('rejects foreign browser origins (DNS rebinding / CSRF)', async () => {
    const { key } = await H.connectAi({})
    const r = await req('/v1/whoami', { key, headers: { origin: 'https://evil.example' } })
    expect(r.status).toBe(403)
    expect((await req('/v1/whoami', { key, headers: { origin: 'https://agfn.test' } })).status).toBe(200)
  })
})

describe('REST', () => {
  it('serves the same operations with OpenAPI', async () => {
    const { key } = await H.connectAi({ write: true })
    const spec = (await (await req('/v1/openapi.json')).json()) as { openapi: string; paths: Record<string, Record<string, { operationId: string }>> }
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.paths['/v1/transactions']?.get?.operationId).toBe('search_transactions')
    expect(spec.paths['/v1/entries']?.post?.operationId).toBe('add_entry')
    expect(spec.paths['/v1/records/{id}/void']?.post?.operationId).toBe('void_record')
    expect(Object.values(spec.paths).flatMap((p) => Object.values(p)).length).toBe(40)

    const list = await req('/v1/transactions?company=Acme&limit=2&min_amount=' + encodeURIComponent('{"amount":"1","currency":"USD"}'), { key })
    expect(list.status).toBe(200)
    const body = (await list.json()) as { transactions: unknown[]; total_count: number }
    expect(body.transactions).toHaveLength(2)
    expect(body.total_count).toBe(3)

    const rec = await req('/v1/records/t_aws', { key })
    expect(((await rec.json()) as { type: string }).type).toBe('transaction')

    const post = () => req('/v1/entries', { method: 'POST', key, headers: { 'content-type': 'application/json', 'idempotency-key': 'rest-entry-0001' }, body: JSON.stringify({ company: 'Acme', kind: 'expense', amount: { amount: '12.40', currency: 'USD' }, date: '2026-10-07', paid_by: 'owner', counterparty: 'Staples' }) })
    const created = await post()
    expect(created.status).toBe(201)
    const again = await post()
    expect(again.status).toBe(200)
    expect(((await again.json()) as { status: string }).status).toBe('duplicate')

    expect((await req('/v1/entries', { method: 'POST', key, headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415)
    expect((await req('/v1/nope', { key })).status).toBe(404)
    expect((await req('/v1/entries', { method: 'POST', key, headers: { 'content-type': 'application/json' }, body: '{"company":"Acme"}' })).status).toBe(400)
  })

  it('maps pause to 423', async () => {
    const { key } = await H.connectAi({})
    await H.agfn.control.pauseAll(H.owner)
    expect((await req('/v1/overview', { key })).status).toBe(423)
  })
})

describe('control routes', () => {
  it('are for signed-in people only, never for AI keys', async () => {
    const { key } = await H.connectAi({})
    expect((await req('/v1/control/grants', { key })).status).toBe(403)
    expect((await req('/v1/control/grants')).status).toBe(401)
    const person = { 'x-test-person': DEMO.owner }
    const grants = (await (await req('/v1/control/grants', { headers: person })).json()) as { grants: Array<{ grant: { id: string }; sentence: { text: string } }> }
    expect(grants.grants).toHaveLength(1)
    const created = await req('/v1/control/keys', { method: 'POST', headers: { ...person, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Script', shape: { entity_ids: [DEMO.acme], data_types: ['balances'], write: false, expires_at: '2026-12-01T00:00:00Z' } }) })
    expect(created.status).toBe(201)
    const k = (await created.json()) as { key: string; sentence: { text: string } }
    expect(k.key).toMatch(/^agfn_live_/)
    expect(k.sentence.text).toBe("Script can see Acme: balances. Can't add or change anything. Expires in 53 days.")
    expect((await req('/v1/control/pause', { method: 'POST', headers: person })).status).toBe(200)
    expect(((await (await req('/v1/control/settings', { headers: person })).json()) as { paused: boolean }).paused).toBe(true)
    expect(((await (await req('/v1/control/activity/verify', { headers: person })).json()) as { ok: boolean }).ok).toBe(true)
    const proposal = (await (await req('/v1/control/grants/propose', { method: 'POST', headers: { ...person, 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'ChatGPT' }) })).json()) as { sentence: { text: string } }
    expect(proposal.sentence.text).toMatch(/^ChatGPT can see all your companies: balances, transactions/)
  })
})

describe('stdio bridge', () => {
  it('proxies tools/list and tools/call to the remote server with the agent key', async () => {
    const { key } = await H.connectAi({ ...READ_ALL, entityIds: [DEMO.bluebird] })
    const remote = await connectRemote({ url: RESOURCE, key, fetch: inProcessFetch(H) })
    const server = bridgeServer(remote)
    const { InMemoryTransport } = await import('@modelcontextprotocol/server')
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const local = new Client({ name: 'desktop', version: '1' })
    await local.connect(b)
    const { tools } = await local.listTools()
    expect(tools.map((t) => t.name)).toContain('get_overview')
    const r = await local.callTool({ name: 'get_overview', arguments: {} })
    expect(r.structuredContent).toMatchObject({ companies: [{ company: 'Bluebird' }] })
    await local.close()
    await remote.close()
  })

  it('refuses plain http to remote hosts', async () => {
    await expect(connectRemote({ url: 'http://agfn.example/mcp', key: 'k' })).rejects.toThrow(/https/)
  })
})
