// Directory conformance: what the Claude and OpenAI connector reviews check, through the official SDK client over
// Streamable HTTP (docs/compliance/mcp-directory.md).

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { DEMO } from './fakes/demo-books.ts'
import { makeHarness, RESOURCE, type Harness } from './fakes/harness.ts'

let H: Harness
let client: Client
let tools: Awaited<ReturnType<Client['listTools']>>['tools']

beforeAll(async () => {
  H = await makeHarness()
  const { key } = await H.connectAi({ write: true })
  const fetchIn = (async (input: RequestInfo | URL, init?: RequestInit) => H.agfn.fetch(new Request(input, init))) as typeof fetch
  client = new Client({ name: 'conformance', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(RESOURCE), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchIn }))
  tools = (await client.listTools()).tools
})
afterAll(async () => {
  await client.close()
  await H.close()
})

type Schema = { type?: unknown; properties?: Record<string, Schema>; required?: string[]; items?: Schema; anyOf?: Schema[]; enum?: unknown[]; const?: unknown; $ref?: string }
const JSON_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']

/** Structural JSON Schema check (no ajv in the tree): every node is typed, required names exist, nested nodes are valid. */
function schemaProblems(s: Schema, path: string): string[] {
  const out: string[] = []
  const typed = s.type !== undefined || s.anyOf || s.enum || s.const !== undefined || s.$ref
  if (!typed && path !== '$' && Object.keys(s).filter((k) => k !== 'description').length) out.push(`${path}: no type`)
  for (const t of [s.type].flat()) if (t !== undefined && !JSON_TYPES.includes(t as string)) out.push(`${path}: bad type ${String(t)}`)
  for (const r of s.required ?? []) if (!s.properties?.[r]) out.push(`${path}: required "${r}" not in properties`)
  for (const [k, v] of Object.entries(s.properties ?? {})) out.push(...schemaProblems(v, `${path}.${k}`))
  if (s.items) out.push(...schemaProblems(s.items, `${path}[]`))
  for (const [i, v] of (s.anyOf ?? []).entries()) out.push(...schemaProblems(v, `${path}|${i}`))
  return out
}

describe('MCP directory conformance', () => {
  it('initializes as Aggregate with instructions', () => {
    expect(client.getServerVersion()).toMatchObject({ name: 'agfn', title: 'Aggregate' })
    // The mark and website, so clients and directories show our logo rather than a letter.
    const info = client.getServerVersion()!
    expect(info.websiteUrl).toBe('https://aggregate.finance')
    expect(info.icons?.map((i) => i.sizes?.[0])).toEqual(['512x512', '192x192', '64x64', 'any'])
    for (const i of info.icons ?? []) expect(i.src).toMatch(/^https:\/\/.+\/(icon-\d+\.png|favicon\.svg)$/)
    expect(client.getInstructions()).toMatch(/nothing here moves money/)
  })

  it('lists every tool with a title, all four hints as booleans, a short name and valid schemas', () => {
    expect(tools.length).toBe(39)
    for (const t of tools) {
      expect(t.name, t.name).toMatch(/^[a-z][a-z0-9_]{0,63}$/)
      expect(t.title, t.name).toBeTruthy()
      expect(t.annotations?.title, t.name).toBe(t.title)
      for (const h of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) expect(typeof t.annotations?.[h], `${t.name}.${h}`).toBe('boolean')
      expect(t.annotations?.openWorldHint, t.name).toBe(false)
      if (t.annotations?.readOnlyHint) expect(t.annotations.destructiveHint, t.name).toBe(false)
      expect(t.description?.length ?? 0, t.name).toBeGreaterThan(20)
      expect(t.inputSchema.type, t.name).toBe('object')
      expect(schemaProblems(t.inputSchema as Schema, `${t.name}.input`)).toEqual([])
      if (!t.annotations?.readOnlyHint) {
        expect(t.outputSchema?.type, t.name).toBe('object')
        expect(schemaProblems(t.outputSchema as Schema, `${t.name}.output`)).toEqual([])
      }
    }
  })

  it('answers one call per read tool against the demo books', async () => {
    const args: Record<string, Record<string, unknown>> = {
      get_metric: { metric: 'cash' },
      get_record: { id: 't_aws' },
      get_counterparty: { name_or_id: 'Globex' },
      get_bucket: { id: 'k_rent' },
      get_document: { id: 'd_receipt' },
      get_reports: { kind: 'profit_and_loss', company: 'Acme', from: '2026-01-01', to: '2026-09-30' },
    }
    const reads = tools.filter((t) => t.annotations?.readOnlyHint)
    expect(reads.length).toBe(26)
    for (const t of reads) {
      const res = await client.callTool({ name: t.name, arguments: args[t.name] ?? {} })
      expect(res.isError, `${t.name}: ${JSON.stringify(res.content)}`).toBeFalsy()
      expect(res.structuredContent, t.name).toBeTypeOf('object')
      expect((res.content as Array<{ type: string; text: string }>)[0]!.text.length, t.name).toBeGreaterThan(0)
    }
  })

  it('reports bad input and refusals as tool results with a plain sentence, never protocol errors', async () => {
    for (const [name, a] of [
      ['get_record', { id: 'no_such_record' }],
      ['get_overview', { company: 'Nobody Inc' }],
      ['get_reports', { kind: 'profit_and_loss', from: 'yesterday', to: 'today' }],
      ['add_entry', { company: DEMO.acme }],
    ] as const) {
      const res = await client.callTool({ name, arguments: a })
      expect(res.isError, name).toBe(true)
      const text = (res.content as Array<{ type: string; text: string }>)[0]!.text
      expect(text.length, name).toBeGreaterThan(5)
      expect(text, name).not.toMatch(/at \w+ \(|Error: |stack/)
    }
  })

  it('returns structured write results that match the advertised output schema', async () => {
    const res = await client.callTool({ name: 'add_entry', arguments: { company: 'Acme', kind: 'expense', amount: { amount: '12.40', currency: 'USD' }, date: '2026-10-07', paid_by: 'Acme', counterparty: 'Staples', idempotency_key: 'conformance-0001' } })
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy()
    expect(res.structuredContent).toMatchObject({ status: 'applied', company: 'Acme', undo_until: expect.any(String) })
  })
})

describe('prompts (guided workflows)', () => {
  it('lists the three workflows with titles and arguments', async () => {
    const { prompts } = await client.listPrompts()
    expect(prompts.map((p) => p.name).sort()).toEqual(['monthly_close', 'prepare_for_accountant', 'what_changed'])
    for (const p of prompts) expect(p.title, p.name).toBeTruthy()
    expect(prompts.find((p) => p.name === 'prepare_for_accountant')!.arguments).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'company', required: true }), expect.objectContaining({ name: 'period', required: true })]))
  })

  it('builds a visible user message that names only listed tools, and says writes wait for a yes', async () => {
    const listed = new Set(tools.map((t) => t.name))
    for (const [name, args] of [['monthly_close', { month: '2026-09', company: 'Acme' }], ['what_changed', {}], ['prepare_for_accountant', { company: 'Acme', period: '2026-Q3' }]] as const) {
      const r = await client.getPrompt({ name, arguments: args })
      expect(r.messages).toHaveLength(1)
      expect(r.messages[0]!.role).toBe('user')
      const text = (r.messages[0]!.content as { text: string }).text
      const named = [...text.matchAll(/\b([a-z]+(?:_[a-z]+)+)\b/g)].map((m) => m[1]!).filter((w) => /^(get|list|search|query|refresh)_/.test(w))
      expect(named.length, name).toBeGreaterThan(2)
      for (const t of named) expect(listed.has(t), `${name} names ${t}`).toBe(true)
      expect(text).toMatch(/dry_run first and wait for my yes/)
    }
    const close = (await client.getPrompt({ name: 'monthly_close', arguments: { month: '2026-09' } })).messages[0]!.content as { text: string }
    expect(close.text).toContain('get_reports profit_and_loss from 2026-09-01 to 2026-09-30')
    const acct = (await client.getPrompt({ name: 'prepare_for_accountant', arguments: { company: 'Acme', period: '2026-Q3' } })).messages[0]!.content as { text: string }
    expect(acct.text).toContain('(2026-07-01 to 2026-09-30)')
  })
})
