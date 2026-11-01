// The share-preview image (Open Graph, 1200×630): the mark and "Aggregate", black on off-white, nothing else.
// `node apps/web/scripts/og.ts` writes apps/site/brand/og/aggregate-og.png; build.mjs copies it to dist/og.png.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, '../site/brand/og/aggregate-og.png')
const CHROME = process.env.CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync)
if (!CHROME) throw new Error('Set CHROME to a Chrome/Chromium binary.')

const font = (await readFile(join(root, 'src/fonts/newsreader.woff2'))).toString('base64')
const html = `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:N;src:url(data:font/woff2;base64,${font}) format('woff2');font-weight:200 800}
html,body{margin:0;width:1200px;height:630px;background:#FAF9F7;color:#1F1B1C}
body{display:flex;align-items:center;justify-content:center;gap:40px}
svg{width:150px;height:150px}
span{font:300 104px/1 N,Georgia,serif;letter-spacing:-.015em}
</style><body><svg viewBox="0 0 100 100" fill="none" stroke="#1F1B1C" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><path d="M50 12V88M50 12 33 88M50 12 67 88M50 12 16 88M50 12 84 88"/></svg><span>Aggregate</span></body>`
const dir = await mkdtemp(join(tmpdir(), 'agfn-og-'))
try {
  const page = join(dir, 'og.html')
  await writeFile(page, html)
  await promisify(execFile)(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=1200,630', '--blink-settings=preferredColorScheme=1', `--screenshot=${out}`, pathToFileURL(page).href], { timeout: 60_000 }).catch((e: { stderr?: string }) => {
    if (!String(e.stderr ?? '').includes('bytes written to file')) throw e
  })
  console.log(out)
} finally {
  await rm(dir, { recursive: true, force: true })
}
