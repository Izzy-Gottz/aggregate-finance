// Prompt packs (AGFN_MCP_PROMPTS=1): a stable list, every step names a real tool, off unless turned on, and a creator
// is named only once credited.
import { afterAll, describe, expect, it } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { makeHarness, RESOURCE, type Harness } from './fakes/harness.ts'
import { PACKS, packPrompts } from './packs.ts'
import { PROMPTS, promptsFor, type PromptDef } from './prompts.ts'
import { ALL_TOOLS } from './service.ts'

const TOOL_NAMES = new Set(ALL_TOOLS.map((t) => t.name))
const TODAY = '2026-10-12'
/** Arguments that satisfy each prompt's required fields. */
const ARGS: Record<string, Record<string, string>> = { prepare_for_accountant: { company: 'Acme', period: '2026-Q3' } }

const PACK_NAMES = [
  'close_blockers',
  'accountant_review',
  'runway',
  'spending_change',
  'mrr_bridge',
  'zombie_subscriptions',
  'who_owes_us',
  'cash_this_month',
  'all_companies',
  'which_company_pays',
]

function build(p: PromptDef, has: (t: string) => boolean = () => true): string {
  const args = ARGS[p.name] ?? {}
  expect(p.args.safeParse(args).success, p.name).toBe(true)
  return p.build(args, has, TODAY)
}

describe('prompt packs', () => {
  it('is a stable list: five packs, these prompts in this order, names unique across every prompt', () => {
    expect(PACKS.map((p) => p.id)).toEqual(['close', 'cfo', 'saas', 'small_business', 'multi_company'])
    expect(packPrompts().map((p) => p.name)).toEqual(PACK_NAMES)
    const all = [...PROMPTS, ...packPrompts()].map((p) => p.name)
    expect(new Set(all).size).toBe(all.length)
    for (const n of all) expect(n).toMatch(/^[a-z][a-z0-9_]{1,40}$/)
  })

  it('references only tools that exist: every need, and the tool that starts every step', () => {
    for (const p of [...PROMPTS, ...packPrompts()]) {
      for (const n of p.needs) expect(TOOL_NAMES.has(n), `${p.name} needs ${n}`).toBe(true)
      const text = build(p)
      const used = [...text.matchAll(/^\d+\. ([a-z_]+)/gm)].map((m) => m[1]!)
      expect(used.length, p.name).toBeGreaterThan(0)
      for (const t of used) expect(TOOL_NAMES.has(t), `${p.name} step uses ${t}`).toBe(true)
    }
  })

  it('leaves out steps for tools the connection lacks, and never asks to write without a yes', () => {
    for (const p of packPrompts()) {
      const only = p.needs[0]!
      const text = build(p, (t) => t === only)
      const used = [...text.matchAll(/^\d+\. ([a-z_]+)/gm)].map((m) => m[1])
      expect(new Set(used), p.name).toEqual(new Set([only]))
      expect(text, p.name).toMatch(/dry_run first and wait for my yes/)
    }
  })

  it('never sums runways', () => {
    for (const name of ['runway', 'all_companies']) expect(build(packPrompts().find((p) => p.name === name)!)).toMatch(/never a sum of runways|Never add runways together/)
  })

  it('names no creator until credited', () => {
    expect(PACKS.every((p) => p.credit === undefined)).toBe(true)
    const pack = PACKS[1]!
    pack.credit = { name: 'Test Creator' }
    try {
      const runway = packPrompts().find((p) => p.name === 'runway')!
      expect(runway.description).toMatch(/From Test Creator's Runway and CFO pack\.$/)
      expect(packPrompts().find((p) => p.name === 'mrr_bridge')!.description).not.toMatch(/Test Creator/)
    } finally {
      delete pack.credit
    }
  })

  it('is off unless turned on', () => {
    expect(promptsFor([...ALL_TOOLS]).map((p) => p.name)).toEqual(['monthly_close', 'what_changed', 'prepare_for_accountant'])
    expect(promptsFor([...ALL_TOOLS], { packs: true }).map((p) => p.name)).toEqual(['monthly_close', 'what_changed', 'prepare_for_accountant', ...PACK_NAMES])
  })
})

describe('prompt packs over MCP', () => {
  let H: Harness | undefined
  afterAll(() => H?.close?.())

  it('lists and builds them through prompts/list and prompts/get when turned on', async () => {
    H = await makeHarness({ promptPacks: true })
    const { key } = await H.connectAi({ write: false })
    const fetchIn = (async (input: RequestInfo | URL, init?: RequestInit) => H!.agfn.fetch(new Request(input, init))) as typeof fetch
    const client = new Client({ name: 'packs', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(RESOURCE), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchIn }))
    const { prompts } = await client.listPrompts()
    expect(prompts.map((p) => p.name)).toEqual(expect.arrayContaining(PACK_NAMES))
    const r = await client.getPrompt({ name: 'runway', arguments: { monthly_cost: '12000' } })
    const text = (r.messages[0]!.content as { text: string }).text
    expect(text).toMatch(/grew by 12000 a month/)
    expect(text).toMatch(/^1\. get_overview/m)
    await client.close()
  })
})
