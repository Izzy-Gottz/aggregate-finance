// Arm B's Aggregate: a fresh local server (its own data dir, port 8890, clock at the benchmark's sync time) holding only
// Harbor Coffee, built by `agfn demo` with the benchmark's exact settings (docs/benchmark/events.ts → BENCHMARK), and a
// read-only agent key for it. Writes { url, key } to BENCH_KEY_FILE (0600); the key is never printed.
//
//   node scripts/benchmark/serve.ts            (then run.ts with BENCH_KEY_FILE)
//
// Steps: start the server and sign in once (the CLI needs an account), stop it, run `agfn demo` against the same data
// dir, start it again, wait until the import has settled, confirm by email, and make the key.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { HttpApi } from '../../apps/web/src/api/http.ts'
import { BENCHMARK } from '../../docs/benchmark/events.ts'

const ROOT = new URL('../../', import.meta.url).pathname
const PORT = Number(process.env.BENCH_PORT ?? 8890), base = `http://localhost:${PORT}`
const dataDir = process.env.BENCH_DATA_DIR ?? join(tmpdir(), `agfn-bench-${Date.now()}`)
const keyFile = process.env.BENCH_KEY_FILE ?? join(dataDir, 'bench-key.json')
const log = join(dataDir, 'server.log')
mkdirSync(dataDir, { recursive: true })
const env = {
  ...process.env,
  AUTH_SECRET: process.env.AUTH_SECRET ?? randomBytes(32).toString('base64url'),
  AGFN_MASTER_KEY: process.env.AGFN_MASTER_KEY ?? randomBytes(32).toString('base64'),
  BENCH_NOW: BENCHMARK.clock, AGFN_LOG_TEST_LINKS: '1', DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: String(PORT), BASE_URL: base,
}
const clock = join(ROOT, 'scripts/benchmark/clock.mjs')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function startServer(): Promise<ChildProcess> {
  const server = spawn(process.execPath, ['--import', clock, join(ROOT, 'apps/server/src/main.ts')], { cwd: ROOT, detached: true, stdio: ['ignore', openSync(log, 'a'), openSync(log, 'a')], env })
  server.unref()
  writeFileSync(join(dataDir, 'server.pid'), String(server.pid))
  for (let i = 0; ; i++) { try { if ((await fetch(base + '/api/sign-in-methods')).ok) return server } catch {} if (i > 240) throw new Error(`server did not start (see ${log})`); await sleep(500) }
}
async function stopServer(server: ChildProcess) {
  server.kill('SIGTERM')
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/sign-in-methods') } catch { return } await sleep(500) }
  server.kill('SIGKILL')
}

const jar = new Map<string, string>()
const f = (async (input: any, init: RequestInit = {}) => {
  const h = new Headers(init.headers); if (jar.size) h.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; ')); h.set('origin', base)
  const r = await fetch(new URL(String(input), base), { ...init, headers: h, redirect: 'manual' })
  for (const c of r.headers.getSetCookie()) { const [p] = c.split(';'); const i = p!.indexOf('='); jar.set(p!.slice(0, i), p!.slice(i + 1)) }
  return r
}) as typeof fetch
async function linkAfter(re: RegExp, trigger: () => Promise<unknown>) {
  const before = readFileSync(log, 'utf8').length
  await trigger()
  for (let i = 0; i < 80; i++) { await sleep(250); const m = readFileSync(log, 'utf8').slice(before).match(re)?.[0]; if (m) return m }
  throw new Error(`no link in ${log}`)
}
const signIn = async (email: string) => f(await linkAfter(/http\S+\/api\/auth\/magic-link\/verify\?token=\w+&callbackURL=\S+/, () => f('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, callbackURL: '/#/' }) })))

const email = `bench-${Date.now()}@example.test`
let server = await startServer()
await signIn(email)
await stopServer(server)

const cli = spawnSync(process.execPath, ['--import', clock, join(ROOT, 'packages/cli/src/main.ts'), 'demo', '--email', email, '--profiles', BENCHMARK.profile,
  '--seed', BENCHMARK.seed, '--start', BENCHMARK.start, '--glass', BENCHMARK.glass], { cwd: ROOT, env, encoding: 'utf8' })
if (cli.status !== 0) throw new Error(`agfn demo failed: ${cli.stderr || cli.stdout}`)
console.log(cli.stdout.trim().split('\n')[0])

server = await startServer()
jar.clear(); await signIn(email)
const api = new HttpApi({ origin: base, fetch: f })
for (let i = 0; i < 900; i++) { const w: any = await api.workspace(); if (w.me?.demoReady) break; if (i % 30 === 29) console.log('waiting for the import…'); await sleep(1000) }
await f(await linkAfter(/http\S+\/recheck\/[A-Za-z0-9_-]{43}\S*/, () => api.recheckByEmail('/#/')))
// A ready demo includes "Claude (demo)"'s one write (a $420 farmers-market sale into a new cash account). It isn't one of
// the benchmark's events, so undo it: arm B must hold exactly what arm A's exports hold.
const seeded: any = await api.latestActivity()
if (seeded?.kind === 'write' && seeded.recordId && seeded.status !== 'undone') {
  await api.undo(seeded.recordId)
  if ((await api.latestActivity() as any)?.status === 'applied') throw new Error('the demo AI write was not undone')
}
// The demo's tidy confirms almost every "same money?" match but keeps one for show (a split bill payment). The truth
// assumes every bill payment confirmed, as the owner would: confirm what's left. ("What is this money?" stays: no
// question depends on its category.)
for (const item of await api.review()) if (item.kind === 'match') await api.resolve(item.id, { action: 'confirm' })
if ((await api.review()).some((i) => i.kind === 'match')) throw new Error('a match is still waiting in Review')
const ws: any = await api.workspace()
const company = ws.entities.find((e: any) => e.name === 'Harbor Coffee')
if (!company) throw new Error(`no Harbor Coffee in the workspace (${ws.entities.map((e: any) => e.name).join(', ')})`)
const shape = { entityIds: [company.id], dataTypes: ['balances', 'transactions', 'invoices', 'bills', 'buckets', 'payroll', 'equity', 'documents', 'reports'], write: false, reviewMode: 'instant', expiresAt: new Date(Date.parse(BENCHMARK.clock) + 30 * 864e5).toISOString() }
const { key } = await (api as any).createKey('Finance Agent Benchmark (read-only)', shape)
writeFileSync(keyFile, JSON.stringify({ url: `${base}/mcp`, key })); chmodSync(keyFile, 0o600)
console.log(`ready: ${base}/mcp, entities ${ws.entities.map((e: any) => e.name).join(', ')}, key in ${keyFile}, server pid ${server.pid} (data ${dataDir})`)
process.exit(0)
