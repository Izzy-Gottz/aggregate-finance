// Screenshots of every screen for review: docs/screens/<name>[-dark|-phone].png.
// Builds the demo bundle, serves it, and drives the installed Chrome in headless mode (no extra packages).
//   node scripts/screens.mjs            all screens
//   node scripts/screens.mjs workspace  only names that include "workspace"
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist-mock')
const outDir = join(root, '../../docs/screens')
const CHROME = process.env.CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync)
if (!CHROME) throw new Error('Set CHROME to a Chrome/Chromium binary.')

await run(process.execPath, [join(root, 'scripts/build.mjs'), '--mock'])

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.map': 'application/json' }
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
  const file = join(dist, path === '/' ? 'index.html' : path)
  try {
    const body = await readFile(file.startsWith(dist) ? file : join(dist, 'index.html'))
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(await readFile(join(dist, 'index.html')))
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

// name, query, hash, height
const SHOTS = [
  ['01-signin', 'signedout', '#/signin', 900],
  ['02-onboarding-company', 'empty', '#/welcome/1', 900],
  ['03-onboarding-connect', 'empty', '#/welcome/2', 900],
  ['04-onboarding-ai', '', '#/welcome/3', 1000],
  ['05-onboarding-first-question', '', '#/welcome/4', 900],
  ['10-workspace', '', '#/', 1400],
  ['11-company-drawer', '', '#/?d=company:e_acme', 2400],
  ['11b-personal-drawer', '', '#/?d=company:e_personal', 1400],
  ['11c-add-stake', '', '#/?d=company:e_personal/stake-add:e_personal', 1000],
  ['12-how-cash-is-worked-out', '', '#/?d=company:e_acme/explain:e_acme:cash', 1000],
  ['13-bucket', '', '#/?d=company:e_acme/bucket:b_rent', 1300],
  ['14-company-sparse', '', '#/?d=company:e_cla', 900],
  ['20-ai-drawer', '', '#/?d=ai:g_claude', 1100],
  ['21-connect-another-ai', '', '#/?d=connect-ai', 1300],
  ['22-ai-consent', '', '#/connect-ai/consent?client_id=claude&scope=read%20write&consent_code=demo', 900],
  ['30-connection', '', '#/?d=connection:c_mercury', 900],
  ['31-more-connections', '', '#/?d=connect', 1900],
  ['32-connect-bank', '', '#/?d=connect/connect:plaid', 900],
  ['40-add-cash', '', '#/?d=add:cash', 1100],
  ['41-upload', '', '#/?d=add:upload', 900],
  ['42-email-in', '', '#/?d=add:email', 900],
  ['50-review', '', '#/review', 1100],
  ['51-search', 'palette', '#/', 900],
  ['60-preferences', '', '#/preferences', 2300],
  ['61-invite', '', '#/preferences?d=invite', 1200],
]
const filter = process.argv[2]
await mkdir(outDir, { recursive: true })

// Headless Chrome won't make a window narrower than ~500px, so phone shots render the app in a 390px iframe.
await writeFile(join(dist, 'phone.html'), '<!doctype html><meta charset=utf-8><style>html,body{margin:0;background:#FAF9F7}iframe{border:0;width:390px;height:100vh;display:block}</style><iframe id=f></iframe><script>f.src=decodeURIComponent(location.hash.slice(1))</script>')

async function shot(name, query, hash, width, height, theme) {
  const q = new URLSearchParams({ api: 'mock' })
  for (const k of query.split('&').filter(Boolean)) q.set(k, '')
  q.set('theme', theme ?? 'light')
  const app = `http://127.0.0.1:${port}/?${q}${hash}`
  const phone = width < 500
  const url = phone ? `http://127.0.0.1:${port}/phone.html#${encodeURIComponent(app)}` : app
  const file = join(outDir, `${name}.png`)
  await run(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${join(dist, '.chrome')}`, `--window-size=${phone ? 390 : width},${height}`, '--force-device-scale-factor=2',
    '--virtual-time-budget=4000', `--screenshot=${file}`, url,
  ], { timeout: 60_000 })
  return file
}

const done = []
for (const [name, query, hash, height] of SHOTS) {
  if (filter && !name.includes(filter)) continue
  done.push(await shot(name, query, hash, 1280, height))
}
// Dark mode and phone width for the main surfaces.
for (const [name, query, hash, height] of SHOTS.filter(([n]) => ['10-workspace', '11-company-drawer', '20-ai-drawer', '50-review'].includes(n))) {
  if (filter && !name.includes(filter)) continue
  done.push(await shot(name + '-dark', query, hash, 1280, height, 'dark'))
}
for (const [name, query, hash, height] of SHOTS.filter(([n]) => ['01-signin', '10-workspace', '11-company-drawer', '20-ai-drawer', '40-add-cash'].includes(n))) {
  if (filter && !name.includes(filter)) continue
  done.push(await shot(name + '-phone', query, hash, 390, Math.max(844, height), undefined))
}
server.close()
console.log(done.map((f) => f.replace(/^.*docs\//, 'docs/')).join('\n'))
