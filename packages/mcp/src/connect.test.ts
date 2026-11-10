// connect_source and the tools/list freeze. The tool is off unless a ConnectPort is wired AND AGFN_CONNECT_FROM_CHAT
// is on; with it off the published tool set must not change (the directory reviews pin it), and the set-asides flag and
// this flag must compose, not exclude each other.

import { createHash } from 'node:crypto'
import * as z from 'zod/v4'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeHarness, READ_ALL, type Harness } from './fakes/harness.ts'
import { DEMO } from './fakes/demo-books.ts'
import { ConnectMintError, type ConnectOption, type ConnectPort, type SourceEntry, type SourcesPort } from './ports.ts'
import { PUBLIC_DEMO_CLIENT } from './grants.ts'
import type { ToolDef } from './tools/common.ts'

/** A canonical fingerprint of what a connection is offered: names, order, text and input schemas. */
function fingerprint(tools: ToolDef[]): string {
  const canon = tools.map((t) => ({ name: t.name, title: t.title, description: t.description, kind: t.kind, input: z.toJSONSchema(t.input) }))
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex')
}
const names = (tools: ToolDef[]) => tools.map((t) => t.name)

const OPTIONS: ConnectOption[] = [
  { key: 'stripe', name: 'Stripe', group: 'billing', auth: 'oauth', provides: ['invoices'] },
  { key: 'plaid', name: 'Plaid', group: 'bank', auth: 'link_widget', provides: ['balances', 'transactions'] },
  { key: 'ramp', name: 'Ramp', group: 'card', auth: 'api_key', provides: ['transactions'] },
  { key: 'files', name: 'Statement upload', group: 'file', auth: 'file', provides: ['balances'] },
]

class FakeConnect implements ConnectPort {
  minted: Array<{ workspaceId: string; personId: string; grantId: string; provider: string; entityId?: string | null }> = []
  throwOnMint?: ConnectMintError
  optionsResult: ConnectOption[] = OPTIONS
  async options(): Promise<ConnectOption[]> {
    return this.optionsResult
  }
  async mint(i: { workspaceId: string; personId: string; grantId: string; provider: string; entityId?: string | null }) {
    if (this.throwOnMint) throw this.throwOnMint
    this.minted.push(i)
    return { id: `cl_${this.minted.length}`, url: `https://agfn.test/connect/TOKEN-${this.minted.length}-${'x'.repeat(40)}`, expiresAt: '2026-10-09T14:15:00.000Z' }
  }
}

describe('tools/list stays frozen with the flag off, and composes with set-asides', () => {
  // The default (both flags off) tools/list fingerprint — names, order, text and input schemas — pinned as the contract
  // the Claude/ChatGPT/Muse directory reviews snapshot. connect_source must not change it; only turning the flag on may,
  // and only by appending connect_source. If this constant has to change, a directory re-review is due.
  const FROZEN = 'd562d3c2d743999cdc3ab1ac869ddfa620fa9a5c47298df3d894b960c3bbff98'

  it('off: no connect_source, and the fingerprint is exactly the frozen one', async () => {
    const H = await makeHarness()
    const tools = await H.agfn.service.listTools()
    expect(fingerprint(tools)).toBe(FROZEN)
    expect(names(tools)).not.toContain('connect_source')
    await H.close()
  })

  it('all four flag combinations: connect_source appears only when on, and only it is added', async () => {
    const combos = [
      { setAsides: false, connectFromChat: false },
      { setAsides: true, connectFromChat: false },
      { setAsides: false, connectFromChat: true },
      { setAsides: true, connectFromChat: true },
    ]
    for (const combo of combos) {
      const H = await makeHarness({ ...combo, ...(combo.connectFromChat ? { connect: new FakeConnect() } : {}) })
      const got = names(await H.agfn.service.listTools())
      if (combo.connectFromChat) {
        expect(got).toContain('connect_source')
        // Exactly one tool added, at the end, and every other name unchanged from the no-set-asides baseline's peers.
        expect(got.filter((n) => n === 'connect_source')).toHaveLength(1)
        expect(got[got.length - 1]).toBe('connect_source')
        // Removing connect_source gives back exactly the same set this combo has with the flag off.
        const off = await makeHarness({ setAsides: combo.setAsides })
        expect(got.filter((n) => n !== 'connect_source')).toEqual(names(await off.agfn.service.listTools()))
        await off.close()
      } else {
        expect(got).not.toContain('connect_source')
      }
      await H.close()
    }
  })

  it('the public demo never lists connect_source even with the flag on (keeps the /demo/mcp hash stable)', async () => {
    const H = await makeHarness({ connectFromChat: true, connect: new FakeConnect() })
    const { principal } = await H.connectAi(READ_ALL)
    expect(names(await H.agfn.service.listTools(principal))).toContain('connect_source')
    // Same server, but the public-demo principal: connect_source is hidden, so the demo's tools/list stays put.
    const demo = { ...principal, grant: { ...principal.grant, clientId: PUBLIC_DEMO_CLIENT } }
    const demoNames = names(await H.agfn.service.listTools(demo))
    expect(demoNames).not.toContain('connect_source')
    expect(demoNames).toEqual(names(await H.agfn.service.listTools()).filter((n) => n !== 'connect_source'))
    await H.close()
  })

  it('flag on but no ConnectPort wired: the tool is still not offered (fail-closed)', async () => {
    const H = await makeHarness({ connectFromChat: true })
    expect(names(await H.agfn.service.listTools())).not.toContain('connect_source')
    expect(fingerprint(await H.agfn.service.listTools())).toBe('d562d3c2d743999cdc3ab1ac869ddfa620fa9a5c47298df3d894b960c3bbff98')
    await H.close()
  })
})

describe('connect_source', () => {
  let H: Harness
  let connect: FakeConnect
  beforeEach(async () => {
    connect = new FakeConnect()
    H = await makeHarness({ connectFromChat: true, connect })
  })
  afterEach(async () => await H.close())

  const call = async (args: Record<string, unknown>, opts?: { personId?: string }) => {
    const { principal } = await H.connectAi(READ_ALL, opts?.personId ? { personId: opts.personId as never } : undefined)
    return H.agfn.service.callTool(principal, 'connect_source', args)
  }

  it('an owner gets a link, and the token never leaks into the stored args', async () => {
    const r = await call({ provider: 'Stripe' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.output.data.provider).toBe('stripe')
    expect(String(r.output.data.connect_url)).toContain('/connect/TOKEN-1')
    // The summary must carry the "never ask for credentials in chat" instruction to the AI.
    expect(r.output.summary).toMatch(/password.*key.*token|key.*token.*account/i)
    expect(connect.minted).toHaveLength(1)
    // The read's audit row stores the arguments (provider/company), never the returned URL or its token.
    const rows = await H.h.db.selectFrom('activity_log').select(['args_json', 'detail']).where('workspace_id', '=', 'ws_demo').execute()
    for (const row of rows) expect(`${row.args_json ?? ''}${row.detail ?? ''}`).not.toContain('TOKEN-1')
  })

  it('resolves a provider by key too, and binds the company when named', async () => {
    const r = await call({ provider: 'plaid', company: DEMO.acme })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.output.data.provider).toBe('plaid')
    expect(connect.minted[0]?.entityId).toBe(DEMO.acme)
  })

  it('refuses a connection whose person doesn’t manage the workspace', async () => {
    const r = await call({ provider: 'Stripe' }, { personId: DEMO.accountant })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('forbidden')
    expect(connect.minted).toHaveLength(0)
  })

  it('an unknown provider is refused with what is available, not a mint', async () => {
    const r = await call({ provider: 'Quickbooks Online Plus' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('invalid')
    expect(r.error.hint).toMatch(/Stripe|Plaid|Ramp/)
    expect(connect.minted).toHaveLength(0)
  })

  it('surfaces a host rate-limit refusal as a plain error', async () => {
    connect.throwOnMint = new ConnectMintError('Too many connect links were just created. Wait a few minutes and try again.')
    const r = await call({ provider: 'Stripe' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('invalid')
    expect(r.error.message).toMatch(/Too many connect links/)
  })

  it('says so when no sources can be connected (options empty, e.g. reviewer demo)', async () => {
    connect.optionsResult = []
    const r = await call({ provider: 'Stripe' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('unavailable')
  })
})
