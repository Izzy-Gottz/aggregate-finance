// Directory review rehearsal (docs/compliance/mcp-directory.md, Launch packet §2–§4): what an Anthropic or OpenAI
// reviewer does, end to end, against a real filled demo workspace. Open a reviewer access link → the AI client
// registers (DCR) → consent with all companies, read and write → token → the listing's test prompts over /mcp.
import { afterEach, describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { loadInstalledModules } from './modules.ts'
import { mintReviewerLink, serverDemoBuilder } from './reviewer.ts'

const BASE = 'http://localhost:8787'
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback'
let booted: Booted | undefined
afterEach(async () => {
  await booted?.shutdown()
  booted = undefined
})

type RpcResult = { result?: { content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean; tools?: Array<{ name: string; annotations?: Record<string, unknown> }> }; error?: { message: string } }

describe('directory review rehearsal', () => {
  it('reviewer link → OAuth with DCR → the listing’s test prompts behave as described', async () => {
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent', AGFN_REVIEWER_LINKS: '1' }), runWorker: false }
    booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => undefined }, ...(await loadInstalledModules({})) }) // wired as in production
    const app = createApp(booted.services)
    const link = await mintReviewerLink({ db: booted.handle.db, buildDemo: serverDemoBuilder(booted.services) }, { label: 'Anthropic directory review', baseUrl: BASE })

    // 1. Open the link: signed in, nothing emailed.
    const r = await app.request(link.url.replace(BASE, ''))
    expect(r.status).toBe(302)
    const verify = await app.request(r.headers.get('location')!.replace(BASE, ''), { headers: { origin: BASE } })
    const cookie = verify.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify(body) })

    // 2. The client registers and starts authorization.
    const client = (await (await app.request('/api/auth/oauth2/register', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'openid offline_access finance:read records:write' }) })).json()) as { client_id: string }
    const verifier = randomBytes(32).toString('base64url')
    const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: CALLBACK, scope: 'openid offline_access finance:read records:write', state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: `${BASE}/mcp` })
    const loc = (await app.request(`/api/auth/oauth2/authorize?${q}`, { headers: { cookie } })).headers.get('location') ?? ''
    expect(loc).toContain('/#/connect-ai/consent')

    // 3. Consent as the reviewer steps say: all companies, read and write, instant.
    const consent = await post('/api/ai/consent', { clientId: client.client_id, clientName: 'Claude', shape: { entityIds: 'all', dataTypes: ['balances', 'transactions', 'invoices', 'bills', 'buckets', 'payroll', 'equity', 'documents', 'reports', 'personal'], write: true, reviewMode: 'instant', expiresAt: null } })
    expect(consent.status, await consent.clone().text()).toBe(200)
    let next = ((await (await post('/api/auth/oauth2/continue', { postLogin: true, oauth_query: loc.slice(loc.indexOf('?') + 1) })).json()) as { url?: string }).url ?? ''
    if (next.includes('/#/connect-ai/consent')) next = ((await (await post('/api/auth/oauth2/consent', { accept: true, oauth_query: next.slice(next.indexOf('?') + 1) })).json()) as { url?: string }).url ?? ''
    const code = new URL(next).searchParams.get('code')!
    const { access_token } = (await (await app.request('/api/auth/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: client.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }) })).json()) as { access_token: string }
    expect(access_token).toBeTruthy()

    // 4. MCP.
    let id = 0
    const rpc = async (method: string, params: unknown): Promise<RpcResult> => {
      const res = await app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${access_token}`, 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })
      const text = await res.text()
      const json = text.startsWith('{') ? text : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).at(-1)!
      return JSON.parse(json) as RpcResult
    }
    const tool = async (name: string, args: Record<string, unknown>) => {
      const res = await rpc('tools/call', { name, arguments: args })
      expect(res.error, `${name}: ${res.error?.message}`).toBeUndefined()
      return { ...res.result!, text: (res.result!.content ?? []).map((c) => c.text ?? '').join('\n'), sc: (res.result!.structuredContent ?? {}) as Record<string, unknown> }
    }
    const init = (await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude', version: '1' } })) as { result?: { serverInfo?: { title?: string; icons?: Array<{ src: string; mimeType: string }> } } }
    // The logo the directory shows: serverInfo.icons, each served by this server as an image.
    expect(init.result?.serverInfo?.title).toBe('Aggregate')
    expect(init.result?.serverInfo?.icons?.length).toBe(4)
    for (const icon of init.result!.serverInfo!.icons!) {
      const got = await app.request(icon.src.replace(BASE, ''))
      expect(got.status, icon.src).toBe(200)
      expect(got.headers.get('content-type')).toBe(icon.mimeType)
    }
    for (const path of ['/favicon.ico', '/apple-touch-icon.png']) expect((await app.request(path)).headers.get('content-type'), path).toMatch(/^image\//)

    // Tools: the full set, every hint an explicit boolean, nothing that pays or contacts anyone (negative cases 1–2).
    const tools = (await rpc('tools/list', {})).result!.tools!
    expect(tools.length).toBe(40)
    for (const t of tools) for (const h of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) expect(typeof t.annotations?.[h], `${t.name}.${h}`).toBe('boolean')
    expect(tools.filter((t) => t.annotations?.destructiveHint === true).map((t) => t.name).sort()).toEqual(['close_period', 'reopen_period', 'resolve_review_item', 'update_bucket', 'update_record', 'void_record'])
    expect(tools.filter((t) => t.annotations?.openWorldHint === true).map((t) => t.name)).toEqual(['refresh_balance'])
    expect(tools.map((t) => t.name).filter((n) => /^(pay|send|email|transfer|wire|move|message|notify)_/.test(n))).toEqual([])

    // Prompt 1: runway across every company.
    const overview = await tool('get_overview', {})
    expect(overview.isError).toBeFalsy()
    expect(overview.text).toMatch(/runway/i)
    // "Runway across every company" is total cash over total net burn, never a sum of runways (ChatGPT summed them in
    // the 2026-10-11 test). The description says so, and on the demo books a summed runway gives a different, wrong number.
    const desc = (tools as Array<{ name: string; description?: string }>).find((t) => t.name === 'get_overview')?.description ?? ''
    expect(desc).toMatch(/combined runway is total cash over total net burn, not a sum/i)
    expect(desc).toMatch(/only meaningful when every company is burning cash/i)
    const cos = ((overview.sc.companies ?? []) as Array<{ cash: { amount: string } | null; net_burn_3mo: { amount: string } | null; runway_months: number | null; runway_state?: string }>).filter((c) => c.runway_months !== undefined)
    const burning = cos.filter((c) => c.cash && c.net_burn_3mo && typeof c.runway_months === 'number' && Number(c.net_burn_3mo.amount) > 0)
    // Which companies burn depends on the demo's dates. With two or more burning, a summed runway is a different, wrong
    // number; with any company not burning, no combined runway is meaningful at all (the description's condition).
    if (burning.length >= 2) {
      const combined = burning.reduce((a, c) => a + Number(c.cash!.amount), 0) / burning.reduce((a, c) => a + Number(c.net_burn_3mo!.amount), 0)
      const summed = burning.reduce((a, c) => a + c.runway_months!, 0)
      expect(Math.abs(summed - combined), `summed ${summed} vs combined ${combined}`).toBeGreaterThan(1)
    }
    if (burning.length < cos.length) expect(cos.some((c) => c.runway_state === 'not_burning' || c.runway_months === null)).toBe(true)

    // Prompt 2: who owes us the most, and how overdue.
    const owed = await tool('query_invoices', { group_by: ['counterparty', 'aging'] })
    expect(owed.isError, owed.text).toBeFalsy()

    // Prompt 3: record $420 cash for Harbor Coffee — dry run first, then applied.
    const today = new Date().toISOString().slice(0, 10)
    const entry = { company: 'Harbor Coffee', kind: 'cash_income', amount: { amount: '420.00', currency: 'USD' }, date: today, paid_by: 'Harbor Coffee', counterparty: 'Farmers market', description: 'Farmers market sales', reason: 'Directory review rehearsal', idempotency_key: 'rehearsal-cash-420' }
    const preview = await tool('add_entry', { ...entry, dry_run: true })
    expect(preview.isError, preview.text).toBeFalsy()
    expect(JSON.stringify(preview.sc)).toContain('would_apply')
    const applied = await tool('add_entry', entry)
    expect(applied.isError, applied.text).toBeFalsy()
    expect(applied.sc).toMatchObject({ status: 'applied', company: 'Harbor Coffee' })
    expect(applied.sc.undo_until).toBeTruthy() // undoable for 30 days
    expect(String(applied.sc.summary).match(/cash income/gi)).toHaveLength(1) // said once

    // Prompt 5: closing books is held for a person, with an approval link.
    const close = await tool('close_period', { company: 'Harbor Coffee', through: `${new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 7)}-01`, reason: 'Directory review rehearsal', idempotency_key: 'rehearsal-close-1' })
    expect(close.isError, close.text).toBeFalsy()
    expect(JSON.stringify(close.sc)).toMatch(/needs_approval|held/)
    expect(JSON.stringify(close.sc)).toContain('/#/review')

    // The AI and the person see the same health number and words for the same workspace.
    const ws = (await (await app.request('/api/workspace', { headers: { cookie } })).json()) as { health: { line: string } | null }
    const health = await tool('get_metric', { metric: 'data_health' })
    expect(ws.health?.line).toBeTruthy()
    expect(health.sc.line).toBe(ws.health!.line)
    expect(health.sc.value).toBe(Number(/^(\d+) thing/.exec(ws.health!.line)?.[1] ?? 0))
    expect(health.text).toContain(ws.health!.line)
    // Money in summaries reads like the app: "$756,470.81"; data keeps the plain decimal.
    expect(overview.text).toMatch(/cash \$[\d,]+\.\d{2}/)

    // Review items say what Confirm does, offer answers that work, and write dates like the app.
    const review = await tool('list_review_items', {})
    const items = (review.sc.items ?? review.sc.review_items ?? Object.values(review.sc).find(Array.isArray)) as Array<{ id: string; kind: string; detail: { text?: string } | string | null; options: string[]; confirm_label?: string; choices?: Array<{ label: string; edits: Record<string, string> }> }>
    for (const it of items.filter((i) => i.options.includes('confirm'))) expect(it.confirm_label, it.kind).toMatch(/^Confirm: /)
    expect(JSON.stringify(items)).not.toMatch(/\b20\d\d-\d\d-\d\d [A-Z]/) // no ISO dates in details
    const whose = items.find((i) => i.choices?.length)
    expect(whose, "the demo has money to explain").toBeDefined()
    if (whose) {
      const pick = whose.choices!.find((c) => c.edits.kind === 'other') ?? whose.choices![0]!
      const done = await tool('resolve_review_item', { id: whose.id, decision: 'edit', edits: pick.edits, reason: 'Directory review rehearsal', idempotency_key: 'rehearsal-review-1' })
      expect(done.isError, done.text).toBeFalsy()
    }

    // The prompts the listing names are offered.
    const prompts = (await rpc('prompts/list', {})) as { result?: { prompts?: Array<{ name: string }> } }
    expect(prompts.result!.prompts!.map((p) => p.name).sort()).toEqual(['monthly_close', 'prepare_for_accountant', 'what_changed'])
  }, 120_000)
})
