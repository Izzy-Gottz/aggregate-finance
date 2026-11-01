// Finance Agent Benchmark: one chat loop per provider (Anthropic, OpenAI, Google), plain fetch, no SDKs.
// Every arm and every model gets the same system prompt, the same question text, the model's default sampling (Claude 5.5 models don't accept a temperature) and the same tool list
// (arm B). Arm A's exports go in a cached prefix so 100 questions don't pay for them 100 times.

export type Provider = 'anthropic' | 'openai' | 'google'
export interface ModelSpec { provider: Provider; model: string }
export interface Tool { name: string; description: string; inputSchema: Record<string, unknown> }
export interface Usage { input: number; cachedInput: number; cacheWrite: number; output: number }
export interface Turn { role: 'assistant' | 'tool'; text?: string; calls?: Array<{ id: string; name: string; args: unknown }>; results?: Array<{ id: string; name: string; output: string }> }
export interface ChatResult { finalText: string; turns: Turn[]; usage: Usage; error?: string }

export interface ChatInput {
  spec: ModelSpec
  system: string
  /** Large, identical-across-questions context (arm A exports). Sent first and cached. */
  context?: string
  question: string
  tools?: Tool[]
  callTool?: (name: string, args: unknown) => Promise<string>
  maxTurns?: number
  maxOutput?: number
}

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is not set (see docs/benchmark/method.md)`); return v }
const zero = (): Usage => ({ input: 0, cachedInput: 0, cacheWrite: 0, output: 0 })

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    if (r.ok) return r.json()
    const text = await r.text()
    // Rate limits and overloads are retried with backoff; anything else is a harness error, recorded as such.
    if ((r.status === 429 || r.status >= 500) && attempt < 6) { await new Promise((s) => setTimeout(s, 2000 * 2 ** attempt)); continue }
    throw new Error(`${r.status} ${text.slice(0, 300)}`)
  }
}

export async function chat(input: ChatInput): Promise<ChatResult> {
  const fn = { anthropic: anthropicChat, openai: openaiChat, google: googleChat }[input.spec.provider]
  try { return await fn(input) } catch (e) { return { finalText: '', turns: [], usage: zero(), error: (e as Error).message } }
}

async function runTool(input: ChatInput, name: string, args: unknown): Promise<string> {
  if (!input.callTool) return 'No tools in this arm.'
  try { return await input.callTool(name, args) } catch (e) { return `Tool error: ${(e as Error).message}` }
}

async function anthropicChat(input: ChatInput): Promise<ChatResult> {
  const usage = zero(), turns: Turn[] = []
  const user: any[] = []
  if (input.context) user.push({ type: 'text', text: input.context, cache_control: { type: 'ephemeral' } })
  user.push({ type: 'text', text: input.question })
  const messages: any[] = [{ role: 'user', content: user }]
  const tools = input.tools?.map((t, i, a) => ({ name: t.name, description: t.description, input_schema: t.inputSchema, ...(i === a.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}) }))
  for (let i = 0; i < (input.maxTurns ?? 12); i++) {
    const r = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': env('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' }, {
      model: input.spec.model, max_tokens: input.maxOutput ?? 4096, system: input.system, messages, ...(tools?.length ? { tools } : {}),
    })
    usage.input += r.usage?.input_tokens ?? 0; usage.cachedInput += r.usage?.cache_read_input_tokens ?? 0; usage.cacheWrite += r.usage?.cache_creation_input_tokens ?? 0; usage.output += r.usage?.output_tokens ?? 0
    const text = r.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
    const calls = r.content.filter((c: any) => c.type === 'tool_use').map((c: any) => ({ id: c.id, name: c.name, args: c.input }))
    turns.push({ role: 'assistant', text, calls })
    messages.push({ role: 'assistant', content: r.content })
    if (!calls.length) return { finalText: text, turns, usage }
    const results = await Promise.all(calls.map(async (c: any) => ({ id: c.id, name: c.name, output: await runTool(input, c.name, c.args) })))
    turns.push({ role: 'tool', results })
    messages.push({ role: 'user', content: results.map((x) => ({ type: 'tool_result', tool_use_id: x.id, content: x.output })) })
  }
  return { finalText: '', turns, usage, error: 'turn limit' }
}

async function openaiChat(input: ChatInput): Promise<ChatResult> {
  const usage = zero(), turns: Turn[] = []
  // Responses API. OpenAI caches identical prefixes automatically (system, then context, then the question).
  const inputItems: any[] = [{ role: 'user', content: [...(input.context ? [{ type: 'input_text', text: input.context }] : []), { type: 'input_text', text: input.question }] }]
  const tools = input.tools?.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema, strict: false }))
  for (let i = 0; i < (input.maxTurns ?? 12); i++) {
    const r = await post('https://api.openai.com/v1/responses', { authorization: `Bearer ${env('OPENAI_API_KEY')}` }, {
      model: input.spec.model, instructions: input.system, input: inputItems, max_output_tokens: input.maxOutput ?? 4096, store: false, include: ['reasoning.encrypted_content'],
      ...(supportsTemperature(input.spec.model) ? { temperature: 0 } : {}), ...(tools?.length ? { tools } : {}),
    })
    const cached = r.usage?.input_tokens_details?.cached_tokens ?? 0
    usage.input += (r.usage?.input_tokens ?? 0) - cached; usage.cachedInput += cached; usage.output += r.usage?.output_tokens ?? 0
    const out: any[] = r.output ?? []
    const text = out.filter((o) => o.type === 'message').flatMap((o) => o.content).filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('\n')
    const calls = out.filter((o) => o.type === 'function_call').map((o) => ({ id: o.call_id, name: o.name, args: safeJson(o.arguments) }))
    turns.push({ role: 'assistant', text, calls })
    // Reasoning items (encrypted, since store is off) go back with the calls, as the API requires.
    inputItems.push(...out)
    if (!calls.length) return { finalText: text, turns, usage }
    const results = await Promise.all(calls.map(async (c) => ({ id: c.id, name: c.name, output: await runTool(input, c.name, c.args) })))
    turns.push({ role: 'tool', results })
    inputItems.push(...results.map((x) => ({ type: 'function_call_output', call_id: x.id, output: x.output })))
  }
  return { finalText: '', turns, usage, error: 'turn limit' }
}

/** Reasoning models reject `temperature`; they run at their fixed default (noted in method.md). */
function supportsTemperature(model: string): boolean { return !/^(o\d|gpt-5)/.test(model) }

async function googleChat(input: ChatInput): Promise<ChatResult> {
  const usage = zero(), turns: Turn[] = []
  // Gemini caches identical prefixes implicitly on 2.5+ models; the context goes first for that reason.
  const contents: any[] = [{ role: 'user', parts: [...(input.context ? [{ text: input.context }] : []), { text: input.question }] }]
  const tools = input.tools?.length ? [{ functionDeclarations: input.tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.inputSchema) })) }] : undefined
  for (let i = 0; i < (input.maxTurns ?? 12); i++) {
    const r = await post(`https://generativelanguage.googleapis.com/v1beta/models/${input.spec.model}:generateContent`, { 'x-goog-api-key': env('GEMINI_API_KEY') }, {
      systemInstruction: { parts: [{ text: input.system }] }, contents, generationConfig: { temperature: 0, maxOutputTokens: input.maxOutput ?? 4096 }, ...(tools ? { tools } : {}),
    })
    const cached = r.usageMetadata?.cachedContentTokenCount ?? 0
    usage.input += (r.usageMetadata?.promptTokenCount ?? 0) - cached; usage.cachedInput += cached
    usage.output += (r.usageMetadata?.candidatesTokenCount ?? 0) + (r.usageMetadata?.thoughtsTokenCount ?? 0)
    const parts: any[] = r.candidates?.[0]?.content?.parts ?? []
    const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('\n')
    const calls = parts.filter((p) => p.functionCall).map((p, k) => ({ id: `${i}-${k}`, name: p.functionCall.name, args: p.functionCall.args ?? {} }))
    turns.push({ role: 'assistant', text, calls })
    contents.push({ role: 'model', parts })
    if (!calls.length) return { finalText: text, turns, usage }
    const results = await Promise.all(calls.map(async (c) => ({ id: c.id, name: c.name, output: await runTool(input, c.name, c.args) })))
    turns.push({ role: 'tool', results })
    contents.push({ role: 'user', parts: results.map((x) => ({ functionResponse: { name: x.name, response: { content: x.output } } })) })
  }
  return { finalText: '', turns, usage, error: 'turn limit' }
}

/** Gemini's function schema is an OpenAPI subset: drop the JSON Schema keywords it rejects. */
function geminiSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(geminiSchema)
  if (!s || typeof s !== 'object') return s
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(s)) {
    if (['$schema', 'additionalProperties', '$ref', 'definitions', '$defs', 'default', 'examples', 'const', 'exclusiveMinimum', 'exclusiveMaximum', 'pattern'].includes(k)) continue
    out[k] = geminiSchema(v)
  }
  return out
}

function safeJson(s: string): unknown { try { return JSON.parse(s) } catch { return {} } }
