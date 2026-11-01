import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_MCP_URL, defaultUrl, setupCommand, type SetupDeps } from './setup.ts'
import type { Io } from './io.ts'

const HOME = '/home/alex'

function fakeDeps(files: Record<string, string>, dirs: string[], opts: { claude?: boolean; codex?: boolean } = {}) {
  const fs = new Map(Object.entries(files))
  const ran: string[][] = []
  const backups: Array<[string, string]> = []
  const deps: SetupDeps = {
    home: HOME,
    platform: 'linux',
    exists: (p) => fs.has(p) || dirs.includes(p),
    read: (p) => fs.get(p) ?? '',
    write: (p, t) => void fs.set(p, t),
    backup: (p, to) => {
      backups.push([p, to])
      fs.set(to, fs.get(p) ?? '')
    },
    which: (c) => ((c === 'claude' && opts.claude) || (c === 'codex' && opts.codex) ? `/usr/local/bin/${c}` : null),
    run: (cmd, args) => void ran.push([cmd, ...args]),
    now: () => new Date('2026-10-11T00:00:00Z'),
  }
  return { deps, fs, ran, backups }
}

function io(env: NodeJS.ProcessEnv = {}): Io & { lines: string[]; errors: string[] } {
  const lines: string[] = []
  const errors: string[] = []
  return { env, cwd: HOME, lines, errors, out: (l) => void lines.push(l), err: (l) => void errors.push(l) }
}

const cursorDir = join(HOME, '.cursor')
const cursorFile = join(cursorDir, 'mcp.json')
const vscodeDir = join(HOME, '.config', 'Code', 'User')
const vscodeFile = join(vscodeDir, 'mcp.json')

describe('agfn setup', () => {
  it('shows the change and writes nothing without --yes', async () => {
    const f = fakeDeps({ [cursorFile]: JSON.stringify({ mcpServers: { other: { url: 'https://other.example/mcp' } } }) }, [cursorDir])
    const o = io()
    expect(await setupCommand([], o, f.deps)).toBe(0)
    expect(o.lines.join('\n')).toContain(`Cursor: add "aggregate" in ${cursorFile}`)
    expect(o.lines.join('\n')).toContain(`+ `)
    expect(o.lines.join('\n')).toMatch(/--yes/)
    expect(JSON.parse(f.fs.get(cursorFile) ?? '')).toEqual({ mcpServers: { other: { url: 'https://other.example/mcp' } } })
    expect(f.backups).toEqual([])
  })

  it('with --yes backs up, keeps other servers and adds the remote entry per app format', async () => {
    const f = fakeDeps({ [cursorFile]: JSON.stringify({ mcpServers: { other: { url: 'https://other.example/mcp' } }, theme: 'dark' }) }, [cursorDir, vscodeDir], { claude: true })
    const o = io()
    expect(await setupCommand(['--yes'], o, f.deps)).toBe(0)
    expect(JSON.parse(f.fs.get(cursorFile) ?? '')).toEqual({
      mcpServers: { other: { url: 'https://other.example/mcp' }, aggregate: { url: DEFAULT_MCP_URL } },
      theme: 'dark',
    })
    expect(f.backups).toEqual([[cursorFile, `${cursorFile}.agfn-backup-2026-10-11T00-00-00-000Z`]])
    // VS Code had no mcp.json yet: created, nothing to back up.
    expect(JSON.parse(f.fs.get(vscodeFile) ?? '')).toEqual({ servers: { aggregate: { type: 'http', url: DEFAULT_MCP_URL } } })
    expect(f.ran).toEqual([['claude', 'mcp', 'add', '--transport', 'http', '--scope', 'user', 'aggregate', DEFAULT_MCP_URL]])
  })

  it('leaves a different existing entry alone unless --force; identical is a no-op', async () => {
    const mine = JSON.stringify({ mcpServers: { aggregate: { url: 'https://self.example/mcp' } } })
    const f = fakeDeps({ [cursorFile]: mine }, [cursorDir])
    const o = io()
    expect(await setupCommand(['--yes'], o, f.deps)).toBe(0)
    expect(f.fs.get(cursorFile)).toBe(mine)
    expect(o.lines.join('\n')).toMatch(/--force/)

    expect(await setupCommand(['--yes', '--force'], io(), f.deps)).toBe(0)
    expect(JSON.parse(f.fs.get(cursorFile) ?? '').mcpServers.aggregate).toEqual({ url: DEFAULT_MCP_URL })

    const again = io()
    expect(await setupCommand(['--yes'], again, f.deps)).toBe(0)
    expect(again.lines.join('\n')).toContain('already set up')
    expect(f.backups).toHaveLength(1)
  })

  it('never rewrites a file with comments', async () => {
    const jsonc = '{\n  // mine\n  "servers": {}\n}\n'
    const f = fakeDeps({ [vscodeFile]: jsonc }, [vscodeDir])
    const o = io()
    await setupCommand(['--yes'], o, f.deps)
    expect(f.fs.get(vscodeFile)).toBe(jsonc)
    expect(o.lines.join('\n')).toMatch(/isn't plain JSON.*add it by hand/)
  })

  it('Claude Desktop gets instructions, not a file edit', async () => {
    const f = fakeDeps({}, [join(HOME, '.config', 'Claude')])
    const o = io()
    expect(await setupCommand(['--yes'], o, f.deps)).toBe(0)
    expect(o.lines.join('\n')).toMatch(/Claude Desktop: open Settings → Connectors → Add custom connector/)
  })

  it('self-hosted URL, client filter and bad input', async () => {
    expect(defaultUrl({ BASE_URL: 'https://books.example.com/' })).toBe('https://books.example.com/mcp')
    expect(defaultUrl({})).toBe(DEFAULT_MCP_URL)
    const f = fakeDeps({}, [cursorDir, vscodeDir])
    await setupCommand(['--yes', '--client', 'vscode', '--url', 'http://localhost:8787/mcp'], io(), f.deps)
    expect(f.fs.has(cursorFile)).toBe(false)
    expect(JSON.parse(f.fs.get(vscodeFile) ?? '').servers.aggregate.url).toBe('http://localhost:8787/mcp')
    await expect(setupCommand(['--url', 'http://evil.example/mcp'], io(), f.deps)).rejects.toThrow(/https/)
    await expect(setupCommand(['--client', 'emacs'], io(), f.deps)).rejects.toThrow(/unknown client/)
  })

  it('says so when no app is found', async () => {
    const o = io()
    expect(await setupCommand([], o, fakeDeps({}, []).deps)).toBe(1)
    expect(o.lines.join('\n')).toMatch(/No supported AI apps found/)
  })

  it('Gemini CLI, Zed and opencode each get their own format at their documented path', async () => {
    const gemini = join(HOME, '.gemini')
    const zed = join(HOME, '.config', 'zed')
    const opencode = join(HOME, '.config', 'opencode')
    const f = fakeDeps({ [join(gemini, 'settings.json')]: JSON.stringify({ theme: 'GitHub', mcpServers: { other: { command: 'x' } } }) }, [gemini, zed, opencode])
    expect(await setupCommand(['--yes'], io(), f.deps)).toBe(0)
    expect(JSON.parse(f.fs.get(join(gemini, 'settings.json'))!)).toEqual({ theme: 'GitHub', mcpServers: { other: { command: 'x' }, aggregate: { httpUrl: DEFAULT_MCP_URL } } })
    expect(JSON.parse(f.fs.get(join(zed, 'settings.json'))!)).toEqual({ context_servers: { aggregate: { url: DEFAULT_MCP_URL } } })
    expect(JSON.parse(f.fs.get(join(opencode, 'opencode.json'))!)).toEqual({ mcp: { aggregate: { type: 'remote', url: DEFAULT_MCP_URL } } })
    expect(f.backups.map(([p]) => p)).toEqual([join(gemini, 'settings.json')])
    // Run again: nothing to do.
    const again = io()
    expect(await setupCommand(['--yes'], again, f.deps)).toBe(0)
    expect(again.lines.filter((l) => l.includes('already set up'))).toHaveLength(3)
  })

  it('Zed settings with comments (its default file has them) get instructions, not a rewrite', async () => {
    const zed = join(HOME, '.config', 'zed')
    const text = '// Zed settings\n{\n  "theme": "One Dark"\n}\n'
    const f = fakeDeps({ [join(zed, 'settings.json')]: text }, [zed])
    const o = io()
    expect(await setupCommand(['--yes', '--client', 'zed'], o, f.deps)).toBe(0)
    expect(f.fs.get(join(zed, 'settings.json'))).toBe(text)
    expect(o.lines.join('\n')).toContain('"aggregate":{"url":"https://app.aggregate.finance/mcp"}')
  })

  it('Codex CLI is added through its own command, once, with the sign-in step printed', async () => {
    const f = fakeDeps({}, [], { codex: true })
    const o = io()
    expect(await setupCommand(['--yes', '--client', 'codex'], o, f.deps)).toBe(0)
    expect(f.ran).toEqual([['codex', 'mcp', 'add', 'aggregate', '--url', DEFAULT_MCP_URL]])
    expect(o.lines.join('\n')).toContain('codex mcp login aggregate')

    const toml = join(HOME, '.codex', 'config.toml')
    f.fs.set(toml, `model = "x"\n\n[mcp_servers.aggregate]\nurl = "${DEFAULT_MCP_URL}"\n\n[mcp_servers.other]\nurl = "https://other.example/mcp"\n`)
    f.ran.length = 0
    const same = io()
    expect(await setupCommand(['--yes', '--client', 'codex'], same, f.deps)).toBe(0)
    expect(f.ran).toEqual([])
    expect(same.lines.join('\n')).toContain('already set up')

    const url = 'https://books.example.com/mcp'
    const other = io()
    expect(await setupCommand(['--yes', '--client', 'codex', '--url', url], other, f.deps)).toBe(0)
    expect(f.ran).toEqual([])
    expect(other.lines.join('\n')).toContain('--force')
    expect(await setupCommand(['--yes', '--client', 'codex', '--url', url, '--force'], io(), f.deps)).toBe(0)
    expect(f.ran).toEqual([
      ['codex', 'mcp', 'remove', 'aggregate'],
      ['codex', 'mcp', 'add', 'aggregate', '--url', url],
    ])
  })

  it('Codex CLI not installed: skipped only when asked for by name', async () => {
    const o = io()
    await setupCommand(['--client', 'codex'], o, fakeDeps({}, []).deps)
    expect(o.lines.join('\n')).toContain('codex command isn’t installed')
  })

  it('Claude Code: added once, then "already set up"; a different entry needs --force (remove, then add)', async () => {
    const cfg = join(HOME, '.claude.json')
    const f = fakeDeps({}, [], { claude: true })
    expect(await setupCommand(['--yes', '--client', 'claude-code'], io(), f.deps)).toBe(0)
    expect(f.ran).toEqual([['claude', 'mcp', 'add', '--transport', 'http', '--scope', 'user', 'aggregate', DEFAULT_MCP_URL]])
    f.fs.set(cfg, JSON.stringify({ numStartups: 3, mcpServers: { aggregate: { type: 'http', url: DEFAULT_MCP_URL } } }))
    f.ran.length = 0
    const again = io()
    expect(await setupCommand(['--yes', '--client', 'claude-code'], again, f.deps)).toBe(0)
    expect(f.ran).toEqual([])
    expect(again.lines.join('\n')).toContain('already set up')
    const url = 'https://books.example.com/mcp'
    const other = io()
    expect(await setupCommand(['--yes', '--client', 'claude-code', '--url', url], other, f.deps)).toBe(0)
    expect(f.ran).toEqual([])
    expect(other.lines.join('\n')).toContain('--force')
    expect(await setupCommand(['--yes', '--client', 'claude-code', '--url', url, '--force'], io(), f.deps)).toBe(0)
    expect(f.ran).toEqual([
      ['claude', 'mcp', 'remove', 'aggregate', '--scope', 'user'],
      ['claude', 'mcp', 'add', '--transport', 'http', '--scope', 'user', 'aggregate', url],
    ])
    // The config file is only ever read.
    expect(JSON.parse(f.fs.get(cfg)!).numStartups).toBe(3)
  })
})
