// Builds the npm package `aggregate-finance` (command `agfn`: setup, mcp, and `demo`, which runs a local server with
// sample data) into dist/npm/aggregate-finance, ready for `npm publish`. The web app ships next to agfn.mjs (web/,
// without source maps).
//
//   node scripts/build-cli-package.ts            build, then `npm pack --dry-run` lists exactly what ships
//
// Our own workspace code (@agfn/*) is bundled into one file; everything else stays a normal npm dependency at the
// version installed here, so third-party licences, audits and updates work as usual. Publishing is a separate,
// deliberate step (docs/launch: the launch-day checklist), never done by this script.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist/npm/aggregate-finance')
const cli = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')) as { version: string; license: string }

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

/**
 * Third-party packages are bundled in, so `npx aggregate-finance` installs one dependency instead of thirteen trees (npm's
 * resolution was most of a first run's minute). Kept as real dependencies: PGlite, which loads its wasm files from
 * its own folder, and Kysely, which the compiled migrations share with the bundle. Imports that don't resolve here are optional ones (pg-native) and stay external, not dependencies.
 */
const KEEP = new Set(['@electric-sql/pglite', 'kysely'])
/** A bare import of a package outside this repo that stays a dependency, e.g. "@electric-sql/pglite". */
const external = new Set<string>()
const pkgName = (spec: string) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!)

const result = await build({
  entryPoints: [join(root, 'packages/cli/src/client-main.ts')],
  outfile: join(out, 'agfn.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Bundled CommonJS packages call require() for Node's own modules.
  banner: { js: "import { createRequire as __agfnRequire } from 'node:module'; const require = __agfnRequire(import.meta.url);" },
  // The bundled packages' licenses go in THIRD-PARTY-LICENSES.txt (below).
  legalComments: 'none',
  metafile: true,
  plugins: [
    {
      name: 'externals',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, async (args) => {
          if (args.path.startsWith('node:') || args.path.startsWith('@agfn/') || args.pluginData === 'probe') return undefined
          if (KEEP.has(pkgName(args.path))) {
            external.add(pkgName(args.path))
            return { path: args.path, external: true }
          }
          const found = await b.resolve(args.path, { kind: args.kind, resolveDir: args.resolveDir, importer: args.importer, pluginData: 'probe' })
          return found.errors.length ? { path: args.path, external: true } : undefined
        })
      },
    },
  ],
})

// The database migrations for `agfn demo`, compiled one file each (the runner loads NNNN_name.mjs from migrations/).
const migDir = join(root, 'packages/db/migrations')
const migFiles = readdirSync(migDir).filter((f) => /^\d{4}_[a-z0-9_]+\.ts$/.test(f))
await build({
  entryPoints: migFiles.map((f) => join(migDir, f)),
  outdir: join(out, 'migrations'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'none',
  metafile: true,
  plugins: [
    {
      name: 'externals',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.path.startsWith('node:') || args.path.startsWith('@agfn/')) return undefined
          external.add(pkgName(args.path))
          return { path: args.path, external: true }
        })
      },
    },
  ],
})

// Each external at the version installed here: looked up from the packages that import them (MCP client, server).
const reqs = ['packages/mcp/package.json', 'apps/server/package.json', 'packages/auth/package.json', 'package.json'].filter((p) => existsSync(join(root, p))).map((p) => createRequire(join(root, p)))
const versionOf = (name: string): string => {
  for (const req of reqs) {
    try {
      return (JSON.parse(readFileSync(req.resolve(`${name}/package.json`), 'utf8')) as { version: string }).version
    } catch {
      // Packages whose exports hide package.json: walk up from the resolved entry.
      try {
        let dir = dirname(req.resolve(name))
        const at = (d: string) => (existsSync(join(d, 'package.json')) ? (JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')) as { name?: string; version: string }) : undefined)
        while (at(dir)?.name !== name) {
          if (dirname(dir) === dir) throw new Error('not found')
          dir = dirname(dir)
        }
        return at(dir)!.version
      } catch {
        /* next */
      }
    }
  }
  throw new Error(`can't find ${name}'s package.json`)
}
const dependencies: Record<string, string> = {}
for (const name of [...external].sort()) dependencies[name] = `^${versionOf(name)}`

writeFileSync(
  join(out, 'package.json'),
  `${JSON.stringify(
    {
      // npm refused the name `agfn` (too similar to `ag-fn`); the command it installs is still `agfn`.
      name: 'aggregate-finance',
      version: cli.version,
      // The official MCP Registry checks that this matches server.json's name before it lists the npm package.
      mcpName: 'finance.aggregate/aggregate',
      description: 'Connect Claude, ChatGPT, Cursor and other AI apps to Aggregate, the open-source finance MCP.',
      keywords: ['mcp', 'model-context-protocol', 'finance', 'accounting', 'aggregate'],
      homepage: 'https://aggregate.finance',
      repository: { type: 'git', url: 'git+https://github.com/Izzy-Gottz/aggregate-finance.git', directory: 'packages/cli' },
      bugs: 'https://github.com/Izzy-Gottz/aggregate-finance/issues',
      license: cli.license,
      type: 'module',
      bin: { agfn: './agfn.mjs' },
      files: ['agfn.mjs', 'THIRD-PARTY-LICENSES.txt', 'web', 'migrations', 'README.md', 'LICENSE'],
      // The bundle itself is plain JS, but the README and `agfn doctor` say 22.18+, so the package says the same.
      engines: { node: '>=22.18' },
      dependencies,
    },
    null,
    2,
  )}\n`,
)
copyFileSync(join(root, 'LICENSE'), join(out, 'LICENSE'))
// The web app for `agfn demo`: built here first when it isn't (npm run build -w @agfn/web), source maps left out.
const webDist = join(root, 'apps/web/dist')
if (!existsSync(join(webDist, 'index.html'))) execFileSync('npm', ['run', 'build', '-w', '@agfn/web'], { cwd: root, stdio: 'inherit' })
// Source maps and video (the ChatGPT reviewers' walkthrough, ~2.5 MB) stay out of the package.
cpSync(webDist, join(out, 'web'), { recursive: true, filter: (src) => !/\.(map|mp4|webm|mov)$/i.test(src) })
copyFileSync(join(root, 'packages/cli/NPM-README.md'), join(out, 'README.md'))

// Every bundled package's license text, as their licenses ask when the code is redistributed.
const bundled = new Map<string, string>()
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input)
  if (!m) continue
  const dir = resolve(root, m[1]!)
  const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; version: string; license?: string }
  if (bundled.has(meta.name)) continue
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f))
  bundled.set(meta.name, `${meta.name} ${meta.version} (${meta.license ?? 'see package'})\n\n${file ? readFileSync(join(dir, file), 'utf8').trim() : `License: ${meta.license ?? 'unknown'}`}`)
}
writeFileSync(join(out, 'THIRD-PARTY-LICENSES.txt'), `Third-party packages bundled into agfn.mjs\n\n${[...bundled.keys()].sort().map((k) => bundled.get(k)).join('\n\n' + '-'.repeat(72) + '\n\n')}\n`)

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0)
console.log(`built ${out} (agfn.mjs ${(bytes / 1024).toFixed(0)} KB; dependencies: ${Object.keys(dependencies).join(', ') || 'none'})`)
if (!process.argv.includes('--no-pack')) execFileSync('npm', ['pack', '--dry-run'], { cwd: out, stdio: 'inherit' })
