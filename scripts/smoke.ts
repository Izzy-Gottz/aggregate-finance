// Smoke test: boots the real server as a separate process (the same `node apps/server/src/main.ts` that `npm start`
// runs, serving the built apps/web/dist) and drives the main flows through the web app's own HttpApi client, a real
// OAuth client and a real MCP session. It catches what in-process tests can't: a mock web build being served, the
// browser client and the server disagreeing about a flow (the Connect-your-AI consent loop), numbers that differ
// between the UI and MCP.
//
//   node scripts/smoke.ts              # needs `npm run build -w @agfn/web` first; ~1-2 min
//   node scripts/smoke.ts --keep       # keep the temp data dir and print where it is
//   DATABASE_URL=postgres://… AGFN_PG_RLS=1 node scripts/smoke.ts   # same flows on Postgres with RLS on
//
// No external services: it uses the built-in demo connector. Throwaway secrets and a temp DATA_DIR; nothing touches
// ~/meridn/data or .env. Steps that need a passkey re-check (export, delete workspace) are checked to be guarded.
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpApi, HttpError } from '../apps/web/src/api/http.ts'

const root = new URL('..', import.meta.url).pathname
const keep = process.argv.includes('--keep')
const results: Array<{ step: string; ok: boolean; detail?: string }> = []
let server: ChildProcess | undefined
let dataDir: string | undefined
let out = ''

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now()
  try {
    const v = await fn()
    results.push({ step: name, ok: true })
    console.log(`✓ ${name} (${Date.now() - t} ms)`)
    return v
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    results.push({ step: name, ok: false, detail })
    console.log(`✗ ${name}: ${detail}`)
    throw e
  }
}

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

const freePort = () =>
  new Promise<number>((res) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => res(p))
    })
  })

const waitFor = async <T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 180_000): Promise<T> => {
  const until = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

/** fetch with a cookie jar, like a browser tab on the server's origin. */
function browser(base: string) {
  const jar = new Map<string, string>()
  const f = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input), base)
    const headers = new Headers(init.headers)
    if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '))
    headers.set('origin', base)
    const r = await fetch(url, { ...init, headers, redirect: 'manual' })
    for (const c of r.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const i = pair!.indexOf('=')
      const [k, v] = [pair!.slice(0, i), pair!.slice(i + 1)]
      if (v === '' || /max-age=0/i.test(c)) jar.delete(k)
      else jar.set(k, v)
    }
    return r
  }
  return f as typeof fetch
}

async function signIn(base: string, email: string): Promise<typeof fetch> {
  const f = browser(base)
  const before = out.length
  const r = await f('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, callbackURL: '/#/' }) })
  check(r.ok, `magic link request: HTTP ${r.status}`)
  const link = await waitFor('the magic link in the server log', async () => out.slice(before).match(/http\S+\/api\/auth\/magic-link\/verify\?\S+/)?.[0])
  const v = await f(link)
  check(v.status === 302 || v.ok, `magic link verify: HTTP ${v.status}`)
  return f
}

async function mcp(base: string, token: string) {
  let sid: string | undefined
  let id = 0
  const rpc = async (method: string, params: unknown) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    })
    sid ??= r.headers.get('mcp-session-id') ?? undefined
    const t = await r.text()
    const m = t.match(/^data: (.*)$/m)
    const j = JSON.parse(m ? m[1]! : t) as { result?: Record<string, unknown>; error?: { message: string } | string }
    if (!r.ok || j.error) throw new Error(`${method}: HTTP ${r.status} ${typeof j.error === 'string' ? j.error : (j.error?.message ?? '')} ${r.headers.get('www-authenticate') ?? ''}`.trim())
    return j.result!
  }
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agfn-smoke', version: '1' } })
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await rpc('tools/call', { name, arguments: args })) as { structuredContent?: unknown; content?: Array<{ text: string }>; isError?: boolean }
    if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text ?? 'tool error'}`)
    return (r.structuredContent ?? JSON.parse(r.content?.[0]?.text ?? 'null')) as Record<string, unknown>
  }
  return { rpc, call }
}

async function main() {
  const dist = join(root, 'apps/web/dist')
  await step('web build is the real app (not --mock)', async () => {
    check(existsSync(join(dist, 'index.html')), 'apps/web/dist/index.html missing: run npm run build -w @agfn/web')
    check(!existsSync(join(dist, '.mock')), 'apps/web/dist is a mock build')
    const js = readFileSync(join(dist, 'index.html'), 'utf8').match(/src="\/(assets\/app-[^"]+\.js)"/)?.[1]
    check(js && existsSync(join(dist, js)), 'index.html points at a missing bundle')
  })

  const port = await freePort()
  const base = `http://localhost:${port}`
  dataDir = mkdtempSync(join(tmpdir(), 'agfn-smoke-'))
  await step('server boots', async () => {
    server = spawn(process.execPath, ['apps/server/src/main.ts'], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '',
        PORT: String(port),
        HOST: '127.0.0.1',
        BASE_URL: base,
        DATA_DIR: dataDir!,
        AUTH_SECRET: randomBytes(32).toString('base64url'),
        AGFN_MASTER_KEY: randomBytes(32).toString('base64'),
        SYNC_EVERY_MINUTES: '60',
        // Optional: run the same flows on Postgres, with row-level security (DATABASE_URL=postgres://… AGFN_PG_RLS=1).
        ...Object.fromEntries(['DATABASE_URL', 'AGFN_PG_RLS', 'AGFN_PG_RLS_ROLE'].filter((k) => process.env[k]).map((k) => [k, process.env[k]!])),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stdout!.on('data', (d: Buffer) => (out += d.toString()))
    server.stderr!.on('data', (d: Buffer) => (out += d.toString()))
    await waitFor('the server to listen', async () => out.includes('listening on'), 60_000)
    const home = await fetch(base + '/')
    check(home.ok && (await home.text()).includes('/assets/app-'), `GET / served HTTP ${home.status} without the app`)
  })

  // ---- A person signs in and opens the demo, exactly as the web app does ----
  const f = await step('magic-link sign-in', () => signIn(base, 'smoke@example.test'))
  const api = new HttpApi({ origin: base, fetch: f })
  const ws = await step('demo workspace fills with data', async () => {
    await api.startDemo()
    await waitFor('demo cash in every company', async () => {
      const w = await api.workspace()
      const companies = w.entities.filter((e) => e.kind === 'company')
      return companies.length >= 3 && companies.every((e) => (e.cash?.minor ?? 0) > 0) ? w : null
    })
    // Then wait for demoReady: every demo connection caught up to today (numbers move while history imports).
    let settled = await api.workspace()
    await waitFor('demo ready', async () => {
      settled = await api.workspace()
      if (!settled.me.demoReady) await new Promise((r) => setTimeout(r, 1000))
      return settled.me.demoReady === true
    })
    return settled
  })
  const companies = ws.entities.filter((e) => e.kind === 'company')

  // ---- Connect your AI: dynamic registration → authorize → our consent page's calls → token ----
  const token = await step('Connect your AI: OAuth through the web client consent', async () => {
    const redirect = 'http://127.0.0.1:9/callback'
    const reg = (await (await fetch(`${base}/api/auth/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Smoke client', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], application_type: 'native' }),
    })).json()) as { client_id?: string; error_description?: string }
    check(reg.client_id, `registration failed: ${reg.error_description}`)
    const verifier = randomBytes(32).toString('base64url')
    const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, scope: 'finance:read records:write offline_access', state: 'smoke', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: `${base}/mcp` })
    // A browser navigation gets a 302; a fetch gets 200 {redirect, url}. Accept either.
    const az = await f(`/api/auth/oauth2/authorize?${q}`, { headers: { accept: 'text/html' } })
    const loc = az.headers.get('location') ?? ((await az.json().catch(() => ({}))) as { url?: string }).url ?? ''
    check(loc.includes('/connect-ai/consent'), `authorize should send the person to our consent page, got HTTP ${az.status} → ${loc.slice(0, 60)}`)
    const oauthQuery = loc.slice(loc.indexOf('?') + 1)
    const info = await api.consentInfo({ clientId: reg.client_id, scope: q.get('scope')! })
    const { redirectTo } = await api.consent({ clientId: reg.client_id, clientName: info.clientName, shape: { ...info.shape, write: true }, oauthQuery })
    check(redirectTo && redirectTo.startsWith(redirect), `consent should end at the AI's redirect with a code, got ${redirectTo?.slice(0, 60) ?? 'nothing'}`)
    const code = new URL(redirectTo).searchParams.get('code')
    check(code, 'no code in the redirect')
    const t = (await (await fetch(`${base}/api/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: reg.client_id, code_verifier: verifier, resource: `${base}/mcp` }),
    })).json()) as { access_token?: string; error?: string }
    check(t.access_token, `token exchange failed: ${t.error}`)
    return t.access_token
  })

  await step('Connect your AI: "Don’t allow" tells the AI no and makes no grant', async () => {
    const redirect = 'http://127.0.0.1:9/declined'
    const reg = (await (await fetch(`${base}/api/auth/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Declined client', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'], application_type: 'native' }),
    })).json()) as { client_id?: string; error_description?: string }
    check(reg.client_id, `registration failed: ${reg.error_description}`)
    const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, scope: 'finance:read', state: 'no', code_challenge: createHash('sha256').update('x'.repeat(43)).digest('base64url'), code_challenge_method: 'S256', resource: `${base}/mcp` })
    const az = await f(`/api/auth/oauth2/authorize?${q}`, { headers: { accept: 'text/html' } })
    const loc = az.headers.get('location') ?? ((await az.json().catch(() => ({}))) as { url?: string }).url ?? ''
    check(loc.includes('/connect-ai/consent'), `authorize should send the person to our consent page, got ${loc.slice(0, 60)}`)
    const before = (await api.workspace()).ais.length
    const { redirectTo } = await api.decline({ oauthQuery: loc.slice(loc.indexOf('?') + 1) })
    check(redirectTo && redirectTo.startsWith(redirect) && new URL(redirectTo).searchParams.get('error') === 'access_denied', `decline should send the AI access_denied, got ${redirectTo?.slice(0, 80) ?? 'nothing'}`)
    check((await api.workspace()).ais.length === before, 'declining must not create a grant')
  })

  const ai = await step('MCP session lists the core tools', async () => {
    const m = await mcp(base, token)
    const tools = ((await m.rpc('tools/list', {})) as { tools: Array<{ name: string }> }).tools.map((t) => t.name)
    for (const need of ['whoami', 'get_overview', 'get_metric', 'search_transactions', 'add_entry']) check(tools.includes(need), `missing tool ${need}`)
    return m
  })

  await step('MCP cash equals the Workspace page, to the cent, per company', async () => {
    for (const c of companies) {
      const r = await ai.call('get_metric', { metric: 'cash', company: c.name })
      const v = (r.value as { amount: string; currency: string })
      const minor = Math.round(Number(v.amount) * 100)
      check(minor === c.cash!.minor, `${c.name}: MCP says ${v.amount}, Workspace says ${c.cash!.minor / 100}`)
    }
  })

  await step('AI write: add_entry lands once (idempotent) and moves cash by exactly its amount', async () => {
    const c = companies[0]!
    const args = { kind: 'cash_income', amount: { amount: '1234.56', currency: 'USD' }, date: new Date().toISOString().slice(0, 10), company: c.name, paid_by: c.name, counterparty: 'Smoke Customer', category: 'revenue', description: 'smoke test', idempotency_key: 'smoke-entry-1' }
    const first = await ai.call('add_entry', args)
    const again = await ai.call('add_entry', args)
    check(JSON.stringify(again).includes('duplicate'), `replaying the same idempotency_key should be a duplicate, got ${JSON.stringify(again).slice(0, 120)}`)
    check(JSON.stringify(first).length > 2, 'empty add_entry result')
    const after = (await api.workspace()).entities.find((e) => e.id === c.id)!
    check(after.cash!.minor - c.cash!.minor === 123_456, `cash moved by ${(after.cash!.minor - c.cash!.minor) / 100}, expected 1234.56`)
  })

  await step('upload a CSV statement', async () => {
    const csv = 'Date,Description,Amount\n2026-01-05,Smoke Hardware,-42.17\n'
    const r = await api.upload(companies[0]!.id, new File([csv], 'smoke.csv', { type: 'text/csv' }))
    check(r && typeof r === 'object', 'no upload result')
  })

  // A fresh sign-in counts as the re-check for people without a passkey on http, so these run for real here.
  await step('export everything downloads every table and no secrets', async () => {
    const { url } = await api.exportAll()
    const r = await f(url)
    check(r.ok, `export download: HTTP ${r.status}`)
    const text = await r.text()
    const j = JSON.parse(text) as { tables?: Record<string, unknown[]> }
    for (const t of ['entities', 'accounts', 'ledger_records', 'journal_lines', 'grants']) check((j.tables?.[t]?.length ?? 0) > 0, `export has no ${t}`)
    check(!/secret_enc|access_token|"key_hash"/.test(text), 'export contains secret-looking fields')
  })

  await step('server log has no errors', async () => {
    const bad = out.split('\n').filter((l) => /\b(ERROR|Unhandled|TypeError|ReferenceError)\b/.test(l) && !/magic-link/.test(l))
    check(bad.length === 0, bad.slice(0, 3).join(' | '))
  })

  await step('delete workspace (last step)', async () => {
    await api.leaveDemo().catch(() => undefined)
    const fresh = await api.createWorkspace('Smoke Co')
    check(fresh.workspaceId, 'no workspace created')
    await api.deleteWorkspace('DELETE')
    const after = await api.workspace().then(() => 'still there', (e: unknown) => (e instanceof HttpError ? e.status : 'error'))
    check(after === 409 || after === 404, `workspace should be gone after delete, got ${after}`)
  })

}

try {
  await main()
} catch {
  // Recorded by step().
} finally {
  server?.kill('SIGTERM')
  const failed = results.filter((r) => !r.ok)
  console.log(failed.length ? `\nSMOKE FAILED (${failed.length} of ${results.length} steps)` : `\nSMOKE OK (${results.length} steps)`)
  if (failed.length && out) console.log('\nLast server output:\n' + out.split('\n').filter((l) => !/token=|verify\?/.test(l)).slice(-25).join('\n'))
  if (dataDir && !keep) rmSync(dataDir, { recursive: true, force: true })
  else if (dataDir) console.log(`data kept in ${dataDir}`)
  process.exitCode = failed.length ? 1 : 0
}
