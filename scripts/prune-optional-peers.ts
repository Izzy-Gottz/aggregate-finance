// Docker prod-deps stage: npm installs *optional* peer dependencies even with --omit=dev (better-auth lists vitest as
// one, which drags in vite, esbuild, happy-dom...). Walk the lockfile from the workspaces without optional peers and
// delete installed top-level packages nothing else needs. Usage: node scripts/prune-optional-peers.ts [--dry-run]

import { existsSync, readFileSync, rmSync } from 'node:fs'

interface LockEntry {
  link?: boolean
  resolved?: string
  dev?: boolean
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

const packages = (JSON.parse(readFileSync('package-lock.json', 'utf8')) as { packages: Record<string, LockEntry> }).packages

function resolve(from: string, name: string): string | undefined {
  let dir = from
  for (;;) {
    const candidate = `${dir ? dir + '/' : ''}node_modules/${name}`
    if (candidate in packages) return candidate
    if (!dir) return undefined
    const i = dir.lastIndexOf('/node_modules/')
    dir = i >= 0 ? dir.slice(0, i) : ''
  }
}

function reachable(withOptionalPeers: boolean): Set<string> {
  const seen = new Set<string>()
  const stack = Object.keys(packages).filter((p) => p !== '' && !p.includes('node_modules/'))
  while (stack.length) {
    const p = stack.pop()!
    if (seen.has(p)) continue
    seen.add(p)
    const e = packages[p]
    if (!e) continue
    if (e.link && e.resolved) {
      stack.push(e.resolved)
      continue
    }
    const names = new Set([...Object.keys(e.dependencies ?? {}), ...Object.keys(e.optionalDependencies ?? {})])
    for (const n of Object.keys(e.peerDependencies ?? {})) if (withOptionalPeers || !e.peerDependenciesMeta?.[n]?.optional) names.add(n)
    for (const n of names) {
      const r = resolve(p, n)
      if (r) stack.push(r)
    }
  }
  return seen
}

const needed = reachable(false)
const extra = [...reachable(true)].filter((p) => !needed.has(p) && p.startsWith('node_modules/') && existsSync(p))
const dryRun = process.argv.includes('--dry-run')
for (const p of extra) if (!dryRun) rmSync(p, { recursive: true, force: true })
console.log(`${dryRun ? 'would remove' : 'removed'} ${extra.length} packages only needed by optional peers`)
