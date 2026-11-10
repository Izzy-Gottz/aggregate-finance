import { afterEach, describe, expect, it } from 'vitest'
import { connect, migrateToLatest, type CoreTables, type DbHandle } from '@agfn/db'
import { DbRateLimiter, MemoryRateLimiter } from '@agfn/mcp'
import { costUsd, LIMITED, PAUSED, spentUsd, TRY_CAP_USD, TRY_OFF_AT, tryChat, validMessages, type TryDeps } from './try-chat.ts'
import { renderTryPage, TRY_FEATURED, TRY_IDEAS, TRY_JS } from './try-page.ts'

let h: DbHandle<CoreTables> | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

const NOW = Date.parse('2026-11-05T12:00:00Z')
const ask = (q = 'What’s Northwind’s cash runway?') => ({ messages: [{ role: 'user', content: q }] })
const usage = { input_tokens: 2_000, output_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 30_000 }

async function deps(reply: () => Response | Promise<Response>, o: Partial<TryDeps> = {}) {
  h = connect<CoreTables>('sqlite::memory:')
  await migrateToLatest(h.db)
  const calls: Array<{ url: string; init: RequestInit }> = []
  const d: TryDeps = {
    key: 'sk-test-placeholder',
    model: 'claude-haiku-5-5',
    demoMcpUrl: 'https://demo.example.test/mcp',
    db: h.db,
    limiter: new DbRateLimiter(h.db),
    now: () => NOW,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return reply()
    }) as typeof fetch,
    ...o,
  }
  return { d, calls }
}
const ok = (text: string, extra: object = {}) => () => new Response(JSON.stringify({ stop_reason: 'end_turn', usage, content: [{ type: 'mcp_tool_use' }, { type: 'text', text }], ...extra }), { status: 200 })

describe('try chat', () => {
  it('asks the Messages API with the demo MCP server only, and returns the text', async () => {
    const { d, calls } = await deps(ok('About 30.3 months.'))
    expect(await tryChat(d, '203.0.113.9', ask())).toEqual({ answer: 'About 30.3 months.' })
    const sent = JSON.parse(String(calls[0]!.init.body))
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages')
    expect((calls[0]!.init.headers as Record<string, string>)['anthropic-beta']).toBe('mcp-client-2025-11-20')
    expect(sent.mcp_servers).toEqual([{ type: 'url', url: 'https://demo.example.test/mcp', name: 'aggregate-demo' }])
    expect(sent.tools).toEqual([{ type: 'mcp_toolset', mcp_server_name: 'aggregate-demo' }])
    expect(sent.thinking).toEqual({ type: 'disabled' })
    expect(sent.cache_control).toBeUndefined()
    expect(sent.system[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(sent).not.toHaveProperty('temperature')
  })

  it('shows only the text after the last tool call', async () => {
    const content = [
      { type: 'text', text: 'I’ll pull the revenue.' },
      { type: 'mcp_tool_use' },
      { type: 'mcp_tool_result' },
      { type: 'text', text: 'Retrying with that name.' },
      { type: 'mcp_tool_use' },
      { type: 'mcp_tool_result' },
      { type: 'text', text: 'Revenue was **$51,966.00**.' },
      { type: 'text', text: 'One item is in review.' },
    ]
    const { d } = await deps(() => new Response(JSON.stringify({ stop_reason: 'end_turn', usage, content }), { status: 200 }))
    expect(await tryChat(d, '203.0.113.9', ask())).toEqual({ answer: 'Revenue was $51,966.00.\n\nOne item is in review.' })
  })

  it('keeps a running spend and pauses at the cap', async () => {
    const { d } = await deps(ok('Fine.'))
    await tryChat(d, '203.0.113.9', ask())
    const one = costUsd('claude-haiku-5-5', usage)
    expect(await spentUsd(d.db)).toBeCloseTo(Math.ceil(one * 10_000) / 10_000, 6)
    await d.db.updateTable('rate_limit_counters').set({ count: TRY_CAP_USD * 10_000 }).where('key', '=', 'try:spend').execute()
    expect(await tryChat(d, '203.0.113.10', ask())).toEqual({ paused: true, message: PAUSED })
  })

  it('pauses after the off date', async () => {
    const { d, calls } = await deps(ok('x'), { now: () => TRY_OFF_AT + 1 })
    expect(await tryChat(d, '203.0.113.9', ask())).toEqual({ paused: true, message: PAUSED })
    expect(calls).toHaveLength(0)
  })

  it('limits each IP to 10 an hour', async () => {
    const { d } = await deps(ok('x'), { limiter: new MemoryRateLimiter() })
    for (let i = 0; i < 10; i++) expect(await tryChat(d, '203.0.113.9', ask())).toEqual({ answer: 'x' })
    expect(await tryChat(d, '203.0.113.9', ask())).toEqual({ limited: true, message: LIMITED })
    expect(await tryChat(d, '198.51.100.4', ask())).toEqual({ answer: 'x' })
  })

  it('never shows an API error, a refusal or a failure as anything but the paused message', async () => {
    for (const reply of [() => new Response('{"error":{"message":"overloaded"}}', { status: 529 }), ok('', { stop_reason: 'refusal' }), () => Promise.reject(new TypeError('network'))]) {
      const { d } = await deps(reply)
      expect(await tryChat(d, '203.0.113.9', ask())).toEqual({ paused: true, message: PAUSED })
      await h?.close()
      h = undefined
    }
  })

  it('takes at most 6 questions, alternating, short ones', () => {
    const turn = (n: number) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'q' }))
    expect(validMessages({ messages: turn(11) })).toHaveLength(11)
    expect(validMessages({ messages: turn(13) })).toBeNull()
    expect(validMessages({ messages: [{ role: 'assistant', content: 'q' }] })).toBeNull()
    expect(validMessages({ messages: [{ role: 'user', content: 'x'.repeat(1_001) }] })).toBeNull()
    expect(validMessages(null)).toBeNull()
  })

  it('prices Sonnet and Haiku, cache reads at a tenth', () => {
    expect(costUsd('claude-sonnet-5-5', { input_tokens: 1e6 })).toBe(2)
    expect(costUsd('claude-sonnet-5-5', { cache_read_input_tokens: 1e6, output_tokens: 1e6 })).toBeCloseTo(10.2)
    expect(costUsd('claude-haiku-5-5', { input_tokens: 1e6, output_tokens: 1e6 })).toBeCloseTo(0.6)
  })

  it('the page says sample data, free during beta, and makes no claims', () => {
    const html = renderTryPage({}).html
    expect(html).toContain('Demo data only, nothing real')
    expect(html).toContain('free during beta')
    expect(html).not.toMatch(/certified|compliant|official|free forever/i)
    expect(TRY_JS).toContain('textContent=j.answer')
    expect(TRY_JS).not.toContain('innerHTML')
    expect(html).toContain('.tchat [hidden]{display:none}')
    // Stop messages name no one AI; the setup links below them still do.
    for (const t of [PAUSED, LIMITED, TRY_JS]) expect(t).not.toContain('own Claude or ChatGPT')
    expect(PAUSED).toContain('your own AI assistant or agent')
    expect(html).toContain('Connect to Claude</a> · <a href="/docs/guides/connect-chatgpt">Connect to ChatGPT')
  })

  it('a chat box: example questions by topic, the cap in words, Enter sends', () => {
    const html = renderTryPage({}).html
    const asks = TRY_IDEAS.flatMap((g) => g.asks)
    expect(TRY_IDEAS.map((g) => g.topic)).toEqual(['Cash and runway', 'Revenue and sales', 'Spending and burn', 'Payroll', 'Invoices and AR', 'Reconciliation and review', 'Investments'])
    expect(asks.length).toBeGreaterThanOrEqual(20)
    expect(asks.length).toBeLessThanOrEqual(30)
    expect(new Set(asks).size).toBe(asks.length)
    expect(html).toContain('6 of 6 questions left')
    expect(html).toContain('aria-label="Example questions"')
    // A page of its own: no docs sidebar or search, a few questions shown and the rest behind "More questions".
    expect(html).not.toContain('class="dnav')
    expect(html).not.toContain('Search the docs')
    expect(html).toContain('>Sign in</a>')
    expect(TRY_FEATURED.length).toBeLessThanOrEqual(4)
    for (const q of TRY_FEATURED) expect(asks).toContain(q)
    expect(html).toContain('More questions')
    expect(html).toContain('class="tfine"')
    expect(TRY_JS).toContain("e.key==='Enter'&&!e.shiftKey")
    expect(() => new Function(TRY_JS)).not.toThrow()
    // A script focus after an answer mustn't resize the box on phones: only a shrunk visible area does.
    expect(TRY_JS).toContain('vv.height>window.innerHeight-120')
    expect(TRY_JS).toContain('!form.hidden&&!touch')
    // With the keyboard open the box ends at the visible bottom, not where the layout viewport ends.
    expect(TRY_JS).toContain('vv.offsetTop+vv.height-chat.getBoundingClientRect().top-8')
  })
})
