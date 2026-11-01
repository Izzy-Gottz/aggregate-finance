// Screenshots from the real server in demo mode: what a new person actually sees after "look around with made-up
// companies". Boots apps/server in-process (SQLite in a temp dir, installed modules, demo connector), signs in with a
// captured magic link per shot (callbackURL = the screen), and drives the installed Chrome headless.
//   node apps/web/scripts/screens-live.ts            all screens → docs/screens/
//   node apps/web/scripts/screens-live.ts company    only names that include "company"
// Heavy: run only when the machine is quiet (uptime load < 12).
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { serve } from '@hono/node-server'
import { loadKeyRing } from '@agfn/security'
import { boot } from '../../server/src/boot.ts'
import { createApp } from '../../server/src/app.ts'
import { loadConfig } from '../../server/src/config.ts'
import { loadInstalledModules } from '../../server/src/modules.ts'

const run = promisify(execFile)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, '../../docs/screens')
const CHROME = process.env.CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync)
if (!CHROME) throw new Error('Set CHROME to a Chrome/Chromium binary.')
const PORT = Number(process.env.SCREENS_PORT ?? 18799)
const BASE = `http://127.0.0.1:${PORT}`
// `npm run screens:live -w @agfn/web -- --audit [name]`: no screenshots; checks every screen at 375px for anything wider
// than the screen and for tap targets under 40px tall (text links inside sentences excepted).
const AUDIT = process.argv.includes('--audit')
// `-- --assets`: store-listing screenshots (docs/launch/assets/screens): the app framed at full size, with this local
// server's address shown as app.aggregate.finance and the demo person given a fictional name. Fictional data only.
const ASSETS = process.argv.includes('--assets')
const filter = process.argv.slice(2).find((a) => !a.startsWith('--'))

await run(process.execPath, [join(root, 'scripts/build.mjs')])
// Headless Chrome won't make a window narrower than ~500px, so phone shots render the app in a 390px iframe.
await writeFile(join(root, 'dist/phone.html'), '<!doctype html><meta charset=utf-8><style>html,body{margin:0;background:#FAF9F7}iframe{border:0;width:390px;height:100vh;display:block}</style><iframe id=f></iframe><script>f.src=decodeURIComponent(location.hash.slice(1))</script>')
// Audit page: the app in a 375px iframe; once settled, it writes what's too wide or too small into <pre id=audit>.
await writeFile(
  join(root, 'dist/audit.html'),
  `<!doctype html><meta charset=utf-8><style>html,body{margin:0}iframe{border:0;width:375px;height:900px;display:block}</style><iframe id=f></iframe><pre id=audit></pre><script>
f.src=decodeURIComponent(location.hash.slice(1))
setTimeout(()=>{const d=f.contentDocument,w=f.contentWindow,W=375,out={wide:[],small:[]}
const name=e=>(e.tagName.toLowerCase()+(e.className&&typeof e.className==='string'?'.'+e.className.trim().split(/\\s+/).join('.'):'')+' “'+(e.getAttribute('aria-label')||e.textContent||'').trim().slice(0,40)+'”')
const clipped=e=>{for(let p=e.parentElement;p;p=p.parentElement){const o=w.getComputedStyle(p).overflowX;if(o==='auto'||o==='scroll'||o==='hidden'&&p!==d.body&&p!==d.documentElement)return true}return false}
for(const e of d.body.querySelectorAll('*')){const r=e.getBoundingClientRect();if(!r.width||e.closest('.sr'))continue
if(r.right>W+0.5&&!clipped(e))out.wide.push(name(e)+' right='+Math.round(r.right))
if(e.matches('button,a[href],select,input:not([type=hidden]),[role=tab],[role=switch]')){const inline=w.getComputedStyle(e).display==='inline'&&e.closest('p,li,span.sub');const labelled=e.matches('input[type=checkbox],input[type=radio]')&&e.closest('label')&&e.closest('label').getBoundingClientRect().height>=40;if(!inline&&!labelled&&r.height<40)out.small.push(name(e)+' '+Math.round(r.width)+'x'+Math.round(r.height))}}
out.wide=out.wide.slice(0,12);out.small=[...new Set(out.small)].slice(0,20);audit.textContent=JSON.stringify(out)},5000)</script>`,
)

// Assets page: the app in a same-origin iframe; once settled, local addresses and the demo login read as the real thing, and the demo banner and self-host note are hidden.
await writeFile(
  join(root, 'dist/asset.html'),
  `<!doctype html><meta charset=utf-8><style>html,body{margin:0;background:#FAF9F7;overflow:hidden}iframe{border:0;width:100vw;height:100vh;display:block}</style><iframe id=f></iframe><script>
f.src=decodeURIComponent(location.hash.slice(1))
const swap=[[location.origin,'https://app.aggregate.finance'],['demo@example.com','alex@example.com']]
setInterval(()=>{const d=f.contentDocument;if(!d||!d.body)return;const w=d.createTreeWalker(d.body,4);let n
while((n=w.nextNode())){let t=n.nodeValue;for(const[a,b]of swap)t=t.split(a).join(b);if(t.trim()==='demo')t=t.replace('demo','Alex Morgan');if(t!==n.nodeValue)n.nodeValue=t}
for(const p of d.querySelectorAll('p'))if(/made-up companies|can’t reach your computer/.test(p.textContent))p.style.display='none'},200)</script>`,
)

const dataDir = await mkdtemp(join(tmpdir(), 'agfn-screens-'))
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BASE_URL: BASE, DATA_DIR: dataDir, AUTH_SECRET: randomBytes(32).toString('base64url'), AGFN_MASTER_KEY: randomBytes(32).toString('base64'), WEB_DIST: join(root, 'dist') }
for (const k of Object.keys(env)) if (/^(PLAID|STRIPE|QUICKBOOKS|XERO|SMTP)_/.test(k)) delete env[k as keyof typeof env] // never a real account
const links: Array<{ to: string; url: string }> = []
const booted = await boot({
  config: loadConfig(env),
  keys: loadKeyRing({ AGFN_MASTER_KEY: env.AGFN_MASTER_KEY }),
  ...(await loadInstalledModules(env)),
  mailer: { send: async (m) => void links.push({ to: m.to, url: m.text.match(/https?:\/\/\S+/)![0] }) },
})
const app = createApp(booted.services)
// Screenshot harness only: phone shots render the app in a same-origin 390px iframe (headless Chrome won't lay out
// narrower than 500px), so let this local server be framed by itself. Production headers are untouched.
const framable = async (req: Request) => {
  const r = await app.fetch(req)
  const csp = r.headers.get('content-security-policy')
  if (!csp && !r.headers.has('x-frame-options')) return r
  const h = new Headers(r.headers)
  // phone.html is this harness's own page (an inline script sets the iframe); it carries no CSP.
  if (['/phone.html', '/audit.html', '/asset.html'].includes(new URL(req.url).pathname)) h.delete('content-security-policy')
  else if (csp) h.set('content-security-policy', csp.replace("frame-ancestors 'none'", "frame-ancestors 'self'"))
  if (h.has('x-frame-options')) h.set('x-frame-options', 'SAMEORIGIN')
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h })
}
const server = serve({ fetch: framable, port: PORT, hostname: '127.0.0.1' })

const json = (cookie: string, method: string, body?: unknown) => ({ method, headers: { 'content-type': 'application/json', origin: BASE, cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

/** A fresh, single-use sign-in link that lands on `callbackURL`. */
async function link(email: string, callbackURL: string): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const r = await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL }) })
    if (r.ok) return links.filter((l) => l.to === email).at(-1)!.url
    if (r.status !== 429) throw new Error(`magic link: ${r.status} ${await r.text()}`)
    await new Promise((res) => setTimeout(res, 15_000))
  }
  throw new Error('magic link: rate limited')
}
async function cookieFor(email: string): Promise<string> {
  const res = await app.request((await link(email, '/')).replace(BASE, ''), { headers: { origin: BASE } })
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}

// The demo person, their demo workspace, and a wait for the background syncs (and the seeded Claude grant).
const DEMO = 'demo@example.com'
const cookie = await cookieFor(DEMO)
const created = await app.request('/api/demo', json(cookie, 'POST', {}))
if (!created.ok) throw new Error(`POST /api/demo: ${created.status} ${await created.text()}`)
type Ws = { entities: Array<{ id: string; name: string; kind: string }>; connections: Array<{ id: string; status: string; name: string }>; ais: Array<{ grantId: string }> }
let ws: Ws
const deadline = Date.now() + 10 * 60_000
for (;;) {
  ws = (await (await app.request('/api/workspace', { headers: { cookie } })).json()) as Ws
  if (ws.ais.length && ws.connections.every((c) => c.status !== 'syncing')) break
  if (Date.now() > deadline) throw new Error('The demo didn’t finish syncing in 10 minutes.')
  await new Promise((res) => setTimeout(res, 3_000))
}
const company = (name: string) => ws.entities.find((e) => e.name.startsWith(name))?.id ?? ws.entities[0]!.id
const saas = company('Northwind')
const sparse = company('Harbor')
const detail = (await (await app.request(`/api/entities/${saas}`, { headers: { cookie } })).json()) as { buckets: Array<{ id: string }> }
const bucket = detail.buckets[0]?.id
const conn = ws.connections[0]?.id
const grant = ws.ais[0]!.grantId

// name, email (null = signed out), hash, height
const SHOTS: Array<[string, string | null, string, number]> = [
  ['01-signin', null, '#/signin', 900],
  ['02-onboarding-company', 'new@example.com', '#/welcome/1', 900],
  ...(conn ? [['03-onboarding-back-from-connect', DEMO, `#/welcome/2?d=connection:${conn}`, 1100] as [string, string, string, number]] : []),
  ['04-onboarding-ai', DEMO, '#/welcome/3', 1000],
  ['05-onboarding-first-question', DEMO, '#/welcome/4', 900],
  ['10-workspace', DEMO, '#/', 1400],
  ['11-company-drawer', DEMO, `#/?d=company:${saas}`, 2400],
  ['12-how-cash-is-worked-out', DEMO, `#/?d=company:${saas}/explain:${saas}:cash`, 1000],
  ...(bucket ? [['13-bucket', DEMO, `#/?d=company:${saas}/bucket:${bucket}`, 1300] as [string, string, string, number]] : []),
  ['14-company-sparse', DEMO, `#/?d=company:${sparse}`, 1400],
  ['15-equity', DEMO, `#/?d=company:${saas}/equity:${saas}`, 1800],
  ['16-equity-next-round', DEMO, `#/?d=company:${saas}/equity:${saas}/equity-round:${saas}`, 1400],
  ['17-health', DEMO, '#/?d=health', 1000],
  ['20-ai-drawer', DEMO, `#/?d=ai:${grant}`, 1100],
  ['21-connect-another-ai', DEMO, '#/?d=connect-ai', 1300],
  ...(conn ? [['30-connection', DEMO, `#/?d=connection:${conn}`, 900] as [string, string, string, number]] : []),
  ['31-more-connections', DEMO, '#/?d=connect', 1900],
  ['32-connect-in-demo', DEMO, '#/?d=connect:simplefin', 1100],
  ['40-add-cash', DEMO, '#/?d=add:cash', 1100],
  ['41-upload', DEMO, '#/?d=add:upload', 900],
  ['42-email-in', DEMO, '#/?d=add:email', 900],
  ['50-review', DEMO, '#/review', 1100],
  ['60-preferences', DEMO, '#/preferences', 2300],
  ['61-invite', DEMO, '#/preferences?d=invite', 1200],
]
const DARK = ['10-workspace', '11-company-drawer', '15-equity', '20-ai-drawer']
const PHONE = ['01-signin', '10-workspace', '11-company-drawer', '15-equity', '20-ai-drawer', '40-add-cash']

await mkdir(outDir, { recursive: true })
// One Chrome profile per person: signed in once with a magic link, then the session cookie carries every later shot
// (magic links are rate-limited, so one per shot is too many). Signed-out shots use their own empty profile.
const profiles = new Map<string, { dir: string; signedIn: boolean }>()
async function profileFor(email: string | null) {
  const k = email ?? '(signed out)'
  let p = profiles.get(k)
  if (!p) profiles.set(k, (p = { dir: await mkdtemp(join(tmpdir(), 'agfn-chrome-')), signedIn: false }))
  return p
}
async function shot(name: string, email: string | null, hash: string, width: number, height: number, theme: 'light' | 'dark') {
  const target = `/?theme=${theme}${hash}`
  const p = await profileFor(email)
  const url = email && !p.signedIn ? await link(email, target) : BASE + target
  if (email) p.signedIn = true
  const phone = width < 500
  const file = join(outDir, `${name}.png`)
  // Headless Chrome on macOS sometimes crashes during teardown after writing the file: that's still a screenshot.
  const chrome = (args: string[]) =>
    run(CHROME!, args, { timeout: 90_000 }).catch((e: { stderr?: string }) => {
      if (!String(e.stderr ?? '').includes('bytes written to file')) throw e
    })
  await chrome([
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${p.dir}`, `--window-size=${phone ? 390 : width},${height}`, '--force-device-scale-factor=2',
    '--virtual-time-budget=6000', `--screenshot=${file}`, phone ? `${BASE}/phone.html#${encodeURIComponent(url)}` : url,
  ])
  return file.replace(/^.*docs\//, 'docs/')
}

/** Which screens become listing assets, and their file names. */
const ASSET_SHOTS: Record<string, string> = { '10-workspace': '1-workspace', '11-company-drawer': '2-company', '21-connect-another-ai': '3-connect-your-ai' }

/** One screen as a 2560×1600 listing screenshot (1280×800 at 2×) and a Square-spec 1500×1000 one. */
async function assetShots(base: string, email: string | null, hash: string): Promise<string[]> {
  const dir = join(outDir, '../launch/assets/screens')
  await mkdir(dir, { recursive: true })
  const target = `/?theme=light${hash}`
  const p = await profileFor(email)
  const url = email && !p.signedIn ? await link(email, target) : BASE + target
  if (email) p.signedIn = true
  const out: string[] = []
  for (const [suffix, w, h, scale] of [['', 1280, 800, 2], ['-square-3x2', 1500, 1000, 1]] as const) {
    const file = join(dir, `${base}${suffix}.png`)
    await run(CHROME!, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${p.dir}`,
      `--window-size=${w},${h}`, `--force-device-scale-factor=${scale}`, '--blink-settings=preferredColorScheme=1',
      '--virtual-time-budget=9000', `--screenshot=${file}`, `${BASE}/asset.html#${encodeURIComponent(url)}`,
    ], { timeout: 90_000 }).catch((e: { stderr?: string }) => {
      if (!String(e.stderr ?? '').includes('bytes written to file')) throw e
    })
    out.push(file.replace(/^.*docs\//, 'docs/'))
  }
  return out
}

/** The audit result for one screen at 375px (see audit.html above). */
async function audit(email: string | null, hash: string): Promise<{ wide: string[]; small: string[] }> {
  const target = `/?theme=light${hash}`
  const p = await profileFor(email)
  const url = email && !p.signedIn ? await link(email, target) : BASE + target
  if (email) p.signedIn = true
  const { stdout } = await run(CHROME!, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${p.dir}`,
    '--window-size=600,900', '--virtual-time-budget=9000', '--dump-dom', `${BASE}/audit.html#${encodeURIComponent(url)}`,
  ], { timeout: 90_000, maxBuffer: 16 << 20 })
  const m = stdout.match(/<pre id="audit">([^<]*)<\/pre>/)
  if (!m?.[1]) return { wide: ['(the audit didn’t finish)'], small: [] }
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))
}

const done: string[] = []
let problems = 0
try {
  for (const [name, email, hash, height] of SHOTS) {
    if (filter && !name.includes(filter)) continue
    if (ASSETS) {
      const pick = ASSET_SHOTS[name]
      if (!pick) continue
      done.push(...(await assetShots(pick, email, hash)))
      continue
    }
    if (AUDIT) {
      const r = await audit(email, hash)
      problems += r.wide.length + r.small.length
      done.push(`${r.wide.length + r.small.length ? '✗' : '✓'} ${name}${r.wide.map((x) => `\n    too wide: ${x}`).join('')}${r.small.map((x) => `\n    small target: ${x}`).join('')}`)
      continue
    }
    done.push(await shot(name, email, hash, 1280, height, 'light'))
    if (DARK.includes(name)) done.push(await shot(`${name}-dark`, email, hash, 1280, height, 'dark'))
    if (PHONE.includes(name)) done.push(await shot(`${name}-phone`, email, hash, 390, Math.max(844, height), 'light'))
  }
} finally {
  server.close()
  await booted.shutdown()
  await rm(dataDir, { recursive: true, force: true })
  for (const p of profiles.values()) await rm(p.dir, { recursive: true, force: true })
}
console.log(done.join('\n'))
process.exit(AUDIT && problems ? 1 : 0)
