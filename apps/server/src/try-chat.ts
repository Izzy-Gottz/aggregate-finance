// "Try it": a no-sign-up chat about the public demo's sample companies (AGFN_TRY_CHAT, approved 2026-11-03).
// Claude answers through the Messages API MCP connector, pointed at the public demo MCP endpoint: demo data only,
// no new tools. The key (ANTHROPIC_TRY_KEY) stays here; the browser only ever sees answers or the paused message.
// Limits: per-IP (hashed) 10 an hour and 30 a day, 6 questions a conversation, a running spend cap, and a hard off date.
// Nothing here logs or stores question text.
import { createHash } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { RateLimiter } from '@agfn/mcp'

export const TRY_OFF_AT = Date.parse('2026-11-13T23:59:00Z')
export const TRY_CAP_USD = 150
export const TRY_MAX_QUESTIONS = 6
const MAX_CHARS = 1_000
const MAX_ANSWER_CHARS = 8_000

/** $ per million tokens: input, output, cache write (5 min), cache read. */
const PRICES: Record<string, [number, number, number, number]> = {
  'claude-haiku-5-5': [0.1, 0.5, 0.125, 0.01],
  'claude-sonnet-5-5': [2, 10, 2.5, 0.2],
}
export const TRY_MODELS = Object.keys(PRICES)

export interface TryUsage { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }

export function costUsd(model: string, u: TryUsage): number {
  const [i, o, w, r] = PRICES[model] ?? PRICES['claude-sonnet-5-5']!
  return ((u.input_tokens ?? 0) * i + (u.output_tokens ?? 0) * o + (u.cache_creation_input_tokens ?? 0) * w + (u.cache_read_input_tokens ?? 0) * r) / 1e6
}

const SYSTEM = `You answer questions on Aggregate's public demo: made-up companies (Northwind Labs, Bluebird Studio, Harbor Coffee) and a Personal set, all sample data. Use the Aggregate tools for every number; never estimate or invent one. Give the figure, the period or date it covers, and a one-line note on how it was counted when that matters. If something is waiting for review (for example a transfer not yet marked as a loan or an investment), say so and say what it would change, instead of picking an answer. Keep answers short and plain, in a few sentences or a small list, with no preamble before using a tool. The page shows plain text: no markdown, so no asterisks, tables or headings; use short lines, or "- " at the start of a line for a list. If a question isn't about these companies' finances, say briefly that this demo only answers questions about the sample companies.`

/** The paused message's words; the page adds the connect links. */
export const PAUSED = 'Demo chat is paused — connect Aggregate to your own AI assistant or agent.'
export const LIMITED = 'That’s the limit for the demo chat for now. Try again later, or connect Aggregate to your own AI assistant or agent.'

export type TryMessage = { role: 'user' | 'assistant'; content: string }
export type TryReply = { answer: string } | { paused: true; message: string } | { limited: true; message: string } | { invalid: true }

export interface TryDeps {
  key: string
  model: string
  demoMcpUrl: string
  db: Kysely<any> // eslint-disable-line @typescript-eslint/no-explicit-any
  limiter: RateLimiter
  fetch?: typeof fetch
  now?: () => number
}

/** One row of rate_limit_counters holds the running spend, in hundredths of a cent. Its window_start is far in the
 *  future, so the limiter's sweep (which drops old windows) never removes it. */
const SPEND_KEY = 'try:spend'
const SPEND_WINDOW = 4_102_444_800_000 // 2100-01-01
const UNIT = 10_000 // per dollar

export async function spentUsd(db: TryDeps['db']): Promise<number> {
  const row = await db.selectFrom('rate_limit_counters').select('count').where('key', '=', SPEND_KEY).where('window_start', '=', SPEND_WINDOW).executeTakeFirst()
  return Number(row?.count ?? 0) / UNIT
}

async function addSpend(db: TryDeps['db'], usd: number): Promise<void> {
  const units = Math.max(1, Math.ceil(usd * UNIT))
  await db
    .insertInto('rate_limit_counters')
    .values({ key: SPEND_KEY, window_start: SPEND_WINDOW, count: units })
    .onConflict((oc) => oc.columns(['key', 'window_start']).doUpdateSet({ count: sql<number>`${sql.ref('rate_limit_counters.count')} + ${units}` }))
    .execute()
}

export function validMessages(body: unknown): TryMessage[] | null {
  const list = (body as { messages?: unknown } | null)?.messages
  if (!Array.isArray(list) || !list.length || list.length > TRY_MAX_QUESTIONS * 2 - 1) return null
  const out: TryMessage[] = []
  for (const [i, m] of list.entries()) {
    const role = i % 2 === 0 ? 'user' : 'assistant'
    const content = (m as { role?: unknown; content?: unknown })?.content
    if ((m as { role?: unknown })?.role !== role || typeof content !== 'string' || !content.trim()) return null
    if (content.length > (role === 'user' ? MAX_CHARS : MAX_ANSWER_CHARS)) return null
    out.push({ role, content })
  }
  return out
}

const ipKey = (ip: string) => createHash('sha256').update(`agfn-try:${ip}`).digest('hex').slice(0, 24)

/** The whole request: checks, limits, one Messages call, spend. Never throws to the caller and never shows an API error. */
export async function tryChat(d: TryDeps, ip: string | undefined, body: unknown): Promise<TryReply> {
  const now = (d.now ?? Date.now)()
  const messages = validMessages(body)
  if (!messages) return { invalid: true }
  try {
    if (now > TRY_OFF_AT || (await spentUsd(d.db)) >= TRY_CAP_USD) return { paused: true, message: PAUSED }
    const who = ipKey(ip ?? 'unknown')
    if ((await d.limiter.hit(`try:h:${who}`, 10, 3_600_000, now)) > 0 || (await d.limiter.hit(`try:d:${who}`, 30, 86_400_000, now)) > 0) return { limited: true, message: LIMITED }
    const haiku = d.model.startsWith('claude-haiku')
    const res = await (d.fetch ?? fetch)('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(90_000),
      headers: { 'content-type': 'application/json', 'x-api-key': d.key, 'anthropic-version': '2026-10-21', 'anthropic-beta': 'mcp-client-2025-11-20' },
      body: JSON.stringify({
        model: d.model,
        max_tokens: 4_000,
        // Thinking off: Haiku takes `disabled`; Sonnet 5.5's thinking-off form is `between_tools`.
        thinking: haiku ? { type: 'disabled' } : { type: 'between_tools' },
        // One breakpoint on the system prompt caches the tool list and the prompt (the prefix) across questions. A
        // top-level breakpoint would also cache-write each question's tool results, which are never read again.
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        mcp_servers: [{ type: 'url', url: d.demoMcpUrl, name: 'aggregate-demo' }],
        tools: [{ type: 'mcp_toolset', mcp_server_name: 'aggregate-demo' }],
        messages,
      }),
    })
    if (!res.ok) {
      console.warn(`[agfn] try chat: Messages API ${res.status}`)
      return { paused: true, message: PAUSED }
    }
    const out = (await res.json()) as { stop_reason?: string; usage?: TryUsage; content?: Array<{ type: string; text?: string }> }
    const usd = costUsd(d.model, out.usage ?? {})
    await addSpend(d.db, usd)
    const u = out.usage ?? {}
    console.log(`[agfn] try chat: 1 question, ${d.model}, $${usd.toFixed(4)} (in ${u.input_tokens ?? 0}, cache read ${u.cache_read_input_tokens ?? 0}, cache write ${u.cache_creation_input_tokens ?? 0}, out ${u.output_tokens ?? 0})`)
    // Only the text after the last tool call: what comes before is preamble ("I'll pull…") or a retry note. The page
    // shows plain text, so bold markers the model adds anyway are dropped.
    const blocks = out.content ?? []
    const last = blocks.findLastIndex((b) => b.type === 'mcp_tool_use' || b.type === 'mcp_tool_result')
    const answer = blocks.slice(last + 1).filter((b) => b.type === 'text').map((b) => (b.text ?? '').trim()).filter(Boolean).join('\n\n').replace(/\*\*(.+?)\*\*/g, '$1')
    if (out.stop_reason === 'refusal' || !answer) return { paused: true, message: PAUSED }
    return { answer: answer.slice(0, MAX_ANSWER_CHARS) }
  } catch (e) {
    console.warn(`[agfn] try chat: ${(e as Error).name}`)
    return { paused: true, message: PAUSED }
  }
}
