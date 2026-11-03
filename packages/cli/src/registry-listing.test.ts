// server.json (the MCP Registry listing, docs/launch/directories.md) has to agree with what ships: the registry refuses
// an npm package whose mcpName differs from the listing's name, and a version that isn't on npm.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '../../..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

describe('MCP Registry listing (server.json)', () => {
  const listing = JSON.parse(read('server.json')) as {
    name: string
    version: string
    repository?: { url: string; source: string }
    remotes: { type: string; url: string }[]
    packages: { registryType: string; identifier: string; version: string; transport: { type: string }; packageArguments: { value?: string }[]; environmentVariables: { name: string; isSecret?: boolean }[] }[]
  }
  const cli = JSON.parse(read('packages/cli/package.json')) as { version: string }
  const npm = listing.packages.find((p) => p.registryType === 'npm')!

  it('names the npm package the build makes, with the same mcpName', () => {
    expect(npm.identifier).toBe('aggregate-finance')
    expect(read('scripts/build-cli-package.ts')).toContain(`name: '${npm.identifier}'`)
    expect(read('scripts/build-cli-package.ts')).toContain(`mcpName: '${listing.name}'`)
  })

  it('keeps one version: npm package, CLI and the MCP server', () => {
    expect(cli.version).toBe(npm.version)
    expect(read('packages/mcp/src/mcp-server.ts')).toContain(`version: '${npm.version}'`)
  })

  // Published registry versions can't change, so a listing-only update bumps the listing alone.
  it('lists a version at or ahead of the package', () => {
    expect(listing.version.localeCompare(npm.version, undefined, { numeric: true })).toBeGreaterThanOrEqual(0)
  })

  it('runs the stdio bridge to the hosted remote, key from a secret variable', () => {
    const remote = listing.remotes.find((r) => r.type === 'streamable-http')!.url
    expect(remote).toBe('https://app.aggregate.finance/mcp')
    expect(npm.transport.type).toBe('stdio')
    expect(npm.packageArguments.map((a) => a.value)).toEqual(['mcp', remote])
    expect(npm.environmentVariables).toEqual([expect.objectContaining({ name: 'AGFN_KEY', isSecret: true })])
    expect(listing.repository).toEqual({ url: 'https://github.com/Izzy-Gottz/aggregate-finance', source: 'github' })
  })
})
