// Bundle apps/web with esbuild: dist/index.html + dist/assets/{app.js,app.css,fonts}.
//   node scripts/build.mjs            production build (talks to /api)
//   node scripts/build.mjs --mock     build that runs the demo workspace with no server → dist-mock/ (never dist/, so a
//                                     server can't serve fake companies; it also carries a .mock marker)
//   node scripts/build.mjs --serve    dev server on :5178 with rebuilds; proxies nothing (use ?api=mock, or run apps/server)
import * as esbuild from 'esbuild'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { brotliCompressSync, constants } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const mock = args.has('--mock')
const out = join(root, mock ? 'dist-mock' : 'dist')

const options = {
  entryPoints: { app: join(root, 'src/main.ts') },
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outdir: join(out, 'assets'),
  entryNames: args.has('--serve') ? '[name]' : '[name]-[hash]',
  assetNames: 'fonts/[name]-[hash]',
  // Brand marks (ui/brand) are small: inlined, so no new asset paths (the server serves fonts/ by name).
  loader: { '.woff2': 'file', '.svg': 'dataurl', '.png': 'dataurl' },
  minify: !args.has('--serve'),
  sourcemap: true,
  metafile: true,
  legalComments: 'linked',
  // 'http' (production) leaves the mock API out of the bundle; the dev server ('dev') keeps ?api=mock.
  define: { AGFN_API: JSON.stringify(mock ? 'mock' : args.has('--serve') ? 'dev' : 'http') },
  logLevel: 'info',
}

async function writeHtml(meta) {
  const files = Object.keys(meta.outputs).map((f) => f.replace(/^.*dist(-mock)?\//, ''))
  const js = files.find((f) => /^assets\/app(-\w+)?\.js$/.test(f))
  const css = files.find((f) => /^assets\/app(-\w+)?\.css$/.test(f))
  // The body font is found only after the CSS is parsed: preload it so text settles in its real face sooner.
  const font = files.find((f) => /^assets\/fonts\/geist(-\w+)?\.woff2$/.test(f))
  let html = await readFile(join(root, 'index.html'), 'utf8')
  html = html
    .replace('<script type="module" src="/src/main.ts"></script>', `<script type="module" src="/${js}"></script>`)
    .replace('</head>', `${font ? `    <link rel="preload" href="/${font}" as="font" type="font/woff2" crossorigin />\n` : ''}    <link rel="stylesheet" href="/${css}" />\n  </head>`)
  await writeFile(join(out, 'index.html'), html)
}

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
// The home-screen icon: the Convergence mark from the brand kit (apps/site/brand, meridn-23).
await copyFile(join(root, '../site/brand/app-icons/aggregate-gold-on-black-512.png'), join(out, 'apple-touch-icon.png'))
// The share-preview image (scripts/og.ts makes it from the mark).
await copyFile(join(root, '../site/brand/og/aggregate-og.png'), join(out, 'og.png'))
// The ChatGPT app review's demo video (openai-plugin/plugin.json demo_recording_url; docs/compliance/mcp-directory.md §5).
await mkdir(join(out, 'review'), { recursive: true })
await copyFile(join(root, 'media/chatgpt-review-demo.mp4'), join(out, 'review/chatgpt-demo.mp4'))

if (args.has('--serve')) {
  const ctx = await esbuild.context({
    ...options,
    plugins: [{ name: 'html', setup: (b) => b.onEnd((r) => r.metafile && writeHtml(r.metafile)) }],
  })
  await ctx.watch()
  const { port } = await ctx.serve({ servedir: out, port: 5178, fallback: join(out, 'index.html') })
  console.log(`Aggregate web on http://localhost:${port}/?api=mock`)
} else {
  const r = await esbuild.build(options)
  await writeHtml(r.metafile)
  // Brotli at full strength once, here, instead of the proxy's quicker setting per request (JS ~114 -> ~85 KB).
  // apps/server serves the .br only to browsers that accept it (static.ts).
  for (const f of Object.keys(r.metafile.outputs).filter((f) => /\.(js|css)$/.test(f))) {
    const src = await readFile(f)
    await writeFile(`${f}.br`, brotliCompressSync(src, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: src.length } }))
  }
  if (mock) await writeFile(join(out, '.mock'), 'This build runs the made-up demo workspace in the browser. apps/server refuses to serve it.\n')
  const size = Object.entries(r.metafile.outputs).filter(([f]) => /\.(js|css)$/.test(f)).map(([f, o]) => `${f.replace(/^.*dist(-mock)?\//, '')} ${(o.bytes / 1024).toFixed(1)} KB`)
  console.log(size.join('\n'))
}
