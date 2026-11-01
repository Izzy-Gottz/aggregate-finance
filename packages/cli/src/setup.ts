// agfn setup [--url URL] [--client a,b] [--yes] [--force]
// Finds the AI apps on this machine (Claude Code, Claude Desktop, Codex CLI, Cursor, VS Code, Windsurf, Gemini CLI, Zed,
// opencode; each at its documented user config path) and adds Aggregate as a remote MCP server (streamable HTTP; the app signs in with
// OAuth, so no key is pasted anywhere). Without --yes it only shows what would change. With --yes it backs up each
// file it touches (<file>.agfn-backup-<time>) before writing. An existing "aggregate" entry is left alone unless --force.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { UsageError, flagString, parseArgs, rejectUnknown, type Io } from './io.ts'

export const DEFAULT_MCP_URL = 'https://app.aggregate.finance/mcp'
export const SERVER_NAME = 'aggregate'

export const SETUP_USAGE = 'usage: agfn setup [--url https://you.example/mcp] [--client cursor,vscode,…] [--yes] [--force]'

export interface SetupDeps {
  home: string
  platform: NodeJS.Platform
  /** %APPDATA% on Windows. */
  appData?: string
  exists(path: string): boolean
  read(path: string): string
  write(path: string, text: string): void
  backup(path: string, to: string): void
  /** Path of the `claude` CLI, or null when it isn't installed. */
  which(cmd: string): string | null
  run(cmd: string, args: string[]): void
  now(): Date
}

export const realSetupDeps = (env: NodeJS.ProcessEnv): SetupDeps => ({
  home: homedir(),
  platform: process.platform,
  ...(env.APPDATA ? { appData: env.APPDATA } : {}),
  exists: existsSync,
  read: (p) => readFileSync(p, 'utf8'),
  write: (p, t) => {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, t)
  },
  backup: (p, to) => copyFileSync(p, to),
  which: (cmd) => {
    try {
      return execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' }).split('\n')[0]?.trim() || null
    } catch {
      return null
    }
  },
  run: (cmd, args) => void execFileSync(cmd, args, { stdio: 'ignore' }),
  now: () => new Date(),
})

type Json = Record<string, unknown>

/** One AI app whose MCP settings live in a JSON file. */
interface FileClient {
  key: string
  name: string
  /** Where the app keeps its user-level MCP servers, or null when it isn't installed (its folder doesn't exist). */
  file(d: SetupDeps): string | null
  /** The object holding servers inside that file, e.g. "mcpServers". */
  section: string
  entry(url: string): Json
}

/** %APPDATA% on Windows, else the XDG-style ~/.config (Zed and opencode use it on macOS too). */
const configDir = (d: SetupDeps, app: string, winApp = app): string =>
  d.platform === 'win32' ? join(d.appData ?? join(d.home, 'AppData', 'Roaming'), winApp) : join(d.home, '.config', app)

function vscodeUserDir(d: SetupDeps): string {
  if (d.platform === 'darwin') return join(d.home, 'Library', 'Application Support', 'Code', 'User')
  if (d.platform === 'win32') return join(d.appData ?? join(d.home, 'AppData', 'Roaming'), 'Code', 'User')
  return join(d.home, '.config', 'Code', 'User')
}

const ifDir = (d: SetupDeps, dir: string, file: string): string | null => (d.exists(dir) ? join(dir, file) : null)

export const FILE_CLIENTS: readonly FileClient[] = [
  {
    key: 'cursor',
    name: 'Cursor',
    file: (d) => ifDir(d, join(d.home, '.cursor'), 'mcp.json'),
    section: 'mcpServers',
    entry: (url) => ({ url }),
  },
  {
    key: 'vscode',
    name: 'VS Code',
    file: (d) => ifDir(d, vscodeUserDir(d), 'mcp.json'),
    section: 'servers',
    entry: (url) => ({ type: 'http', url }),
  },
  {
    key: 'windsurf',
    name: 'Windsurf',
    file: (d) => ifDir(d, join(d.home, '.codeium', 'windsurf'), 'mcp_config.json'),
    section: 'mcpServers',
    entry: (url) => ({ serverUrl: url }),
  },
  {
    // https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md: httpUrl is streamable HTTP (url is SSE).
    key: 'gemini',
    name: 'Gemini CLI',
    file: (d) => ifDir(d, join(d.home, '.gemini'), 'settings.json'),
    section: 'mcpServers',
    entry: (url) => ({ httpUrl: url }),
  },
  {
    // https://zed.dev/docs/ai/mcp: a remote server with no Authorization header signs in with OAuth.
    key: 'zed',
    name: 'Zed',
    file: (d) => ifDir(d, configDir(d, 'zed', 'Zed'), 'settings.json'),
    section: 'context_servers',
    entry: (url) => ({ url }),
  },
  {
    // https://opencode.ai/docs/mcp-servers/: remote servers sign in with OAuth on their first 401.
    key: 'opencode',
    name: 'opencode',
    file: (d) => ifDir(d, configDir(d, 'opencode'), 'opencode.json'),
    section: 'mcp',
    entry: (url) => ({ type: 'remote', url }),
  },
]

export const CLIENT_KEYS = ['claude-code', 'claude-desktop', 'codex', ...FILE_CLIENTS.map((c) => c.key)] as const

function claudeDesktopDir(d: SetupDeps): string {
  if (d.platform === 'darwin') return join(d.home, 'Library', 'Application Support', 'Claude')
  if (d.platform === 'win32') return join(d.appData ?? join(d.home, 'AppData', 'Roaming'), 'Claude')
  return join(d.home, '.config', 'Claude')
}

export type Plan =
  | { client: string; name: string; action: 'add' | 'replace'; file: string; before: string; after: string }
  | {
      client: string
      name: string
      action: 'command'
      cmd: string
      args: string[]
      /** Run first, same command (e.g. removing the old entry on --force). */
      pre?: string[]
      /** Printed after it's done: the step only the person can do (a browser sign-in). */
      then?: string
      /** Printed if it fails. */
      hint?: string
    }
  | { client: string; name: string; action: 'same' | 'exists' | 'manual' | 'skip'; note: string }

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function planFile(c: FileClient, d: SetupDeps, url: string, force: boolean): Plan | null {
  const file = c.file(d)
  if (!file) return null
  const before = d.exists(file) ? d.read(file) : ''
  let doc: Json = {}
  if (before.trim()) {
    let parsed: unknown
    try {
      parsed = JSON.parse(before)
    } catch {
      // Comments or trailing commas (VS Code allows them): never rewrite a file we can't read faithfully.
      return { client: c.key, name: c.name, action: 'skip', note: `${file} isn't plain JSON (comments?); add it by hand: ${JSON.stringify({ [SERVER_NAME]: c.entry(url) })}` }
    }
    if (!isObj(parsed)) return { client: c.key, name: c.name, action: 'skip', note: `${file} isn't a JSON object; left alone` }
    doc = parsed
  }
  const servers = doc[c.section]
  if (servers !== undefined && !isObj(servers)) return { client: c.key, name: c.name, action: 'skip', note: `"${c.section}" in ${file} isn't an object; left alone` }
  const want = c.entry(url)
  const have = isObj(servers) ? servers[SERVER_NAME] : undefined
  if (have !== undefined && JSON.stringify(have) === JSON.stringify(want)) return { client: c.key, name: c.name, action: 'same', note: 'already set up' }
  if (have !== undefined && !force) return { client: c.key, name: c.name, action: 'exists', note: `${file} already has a different "${SERVER_NAME}" entry; run with --force to replace it` }
  const after = JSON.stringify({ ...doc, [c.section]: { ...(isObj(servers) ? servers : {}), [SERVER_NAME]: want } }, null, 2) + '\n'
  return { client: c.key, name: c.name, action: have === undefined ? 'add' : 'replace', file, before, after }
}

/**
 * Codex keeps servers in ~/.codex/config.toml; its own CLI writes them (https://developers.openai.com/codex/mcp), so no
 * TOML is edited here. The file is only read to stay idempotent.
 */
function planCodex(d: SetupDeps, url: string, force: boolean): Plan | null {
  if (!d.which('codex')) return null
  const file = join(d.home, '.codex', 'config.toml')
  const toml = d.exists(file) ? d.read(file) : ''
  const table = new RegExp(`^\\[mcp_servers\\.(?:${SERVER_NAME}|"${SERVER_NAME}")\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm').exec(toml)
  const add: Plan = { client: 'codex', name: 'Codex CLI', action: 'command', cmd: 'codex', args: ['mcp', 'add', SERVER_NAME, '--url', url], then: `sign in once: codex mcp login ${SERVER_NAME}`, hint: `if it's already added, remove it first: codex mcp remove ${SERVER_NAME}` }
  if (!table) return add
  const have = /^\s*url\s*=\s*"([^"]*)"/m.exec(table[1] ?? '')?.[1]
  if (have === url) return { client: 'codex', name: 'Codex CLI', action: 'same', note: 'already set up' }
  if (!force) return { client: 'codex', name: 'Codex CLI', action: 'exists', note: `${file} already has a different "${SERVER_NAME}" server; run with --force to replace it` }
  return { ...add, pre: ['mcp', 'remove', SERVER_NAME] }
}

/** Claude Code's user-scope "aggregate" entry (~/.claude.json mcpServers), read only; undefined when absent or unreadable. */
function claudeCodeEntry(d: SetupDeps): unknown {
  const file = join(d.home, '.claude.json')
  if (!d.exists(file)) return undefined
  try {
    const doc: unknown = JSON.parse(d.read(file))
    const servers = isObj(doc) ? doc.mcpServers : undefined
    return isObj(servers) ? servers[SERVER_NAME] : undefined
  } catch {
    return undefined
  }
}

/** What setup would do for each detected app. Pure apart from reading files: nothing is written here. */
export function planSetup(d: SetupDeps, url: string, only: readonly string[] | null, force: boolean): Plan[] {
  const want = (k: string) => only === null || only.includes(k)
  const plans: Plan[] = []
  if (want('claude-code')) {
    // Claude Code keeps user servers in ~/.claude.json, which running sessions rewrite constantly: use its own CLI, and
    // only read the file, to stay idempotent.
    if (d.which('claude')) {
      const add = ['mcp', 'add', '--transport', 'http', '--scope', 'user', SERVER_NAME, url]
      const have = claudeCodeEntry(d)
      if (have === undefined) {
        plans.push({ client: 'claude-code', name: 'Claude Code', action: 'command', cmd: 'claude', args: add, hint: `if it's already added, remove it first: claude mcp remove ${SERVER_NAME} --scope user` })
      } else if (isObj(have) && have.url === url && (have.type === 'http' || have.type === undefined)) {
        plans.push({ client: 'claude-code', name: 'Claude Code', action: 'same', note: 'already set up' })
      } else if (!force) {
        plans.push({ client: 'claude-code', name: 'Claude Code', action: 'exists', note: `already has a different "${SERVER_NAME}" server; run with --force to replace it` })
      } else {
        plans.push({ client: 'claude-code', name: 'Claude Code', action: 'command', cmd: 'claude', args: add, pre: ['mcp', 'remove', SERVER_NAME, '--scope', 'user'] })
      }
    } else if (only !== null) {
      plans.push({ client: 'claude-code', name: 'Claude Code', action: 'skip', note: 'the claude command isn’t installed' })
    }
  }
  if (want('claude-desktop') && d.exists(claudeDesktopDir(d))) {
    // Claude Desktop only adds remote servers through its own screen (it runs the sign-in itself).
    plans.push({ client: 'claude-desktop', name: 'Claude Desktop', action: 'manual', note: `open Settings → Connectors → Add custom connector, name it Aggregate and paste ${url}` })
  }
  if (want('codex')) {
    const p = planCodex(d, url, force)
    if (p) plans.push(p)
    else if (only !== null) plans.push({ client: 'codex', name: 'Codex CLI', action: 'skip', note: 'the codex command isn’t installed' })
  }
  for (const c of FILE_CLIENTS) {
    if (!want(c.key)) continue
    const p = planFile(c, d, url, force)
    if (p) plans.push(p)
    else if (only !== null) plans.push({ client: c.key, name: c.name, action: 'skip', note: `${c.name} doesn’t look installed` })
  }
  return plans
}

/** A small line diff of the server section: enough to see what changes without a diff library. */
export function lineDiff(before: string, after: string): string[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const inA = new Set(a)
  const inB = new Set(b)
  return [...a.filter((l) => l.trim() && !inB.has(l)).map((l) => `- ${l}`), ...b.filter((l) => l.trim() && !inA.has(l)).map((l) => `+ ${l}`)]
}

function resolveUrl(raw: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new UsageError(`not a URL: ${raw}`)
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1'
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new UsageError('the server URL must be https (http is allowed only for localhost)')
  return u.toString()
}

/** Self-hosted: BASE_URL + /mcp. Otherwise the hosted service. */
export function defaultUrl(env: NodeJS.ProcessEnv): string {
  if (env.AGFN_URL) return env.AGFN_URL
  if (env.BASE_URL) return env.BASE_URL.replace(/\/+$/, '') + '/mcp'
  return DEFAULT_MCP_URL
}

export async function setupCommand(argv: string[], io: Io, deps: SetupDeps = realSetupDeps(io.env)): Promise<number> {
  const args = parseArgs(argv, ['yes', 'force'])
  rejectUnknown(args, ['url', 'client', 'yes', 'force'])
  if (args.positionals.length) throw new UsageError(SETUP_USAGE)
  const url = resolveUrl(flagString(args, 'url') ?? defaultUrl(io.env))
  const clientFlag = flagString(args, 'client')
  const only = clientFlag ? clientFlag.split(',').map((s) => s.trim()).filter(Boolean) : null
  for (const k of only ?? []) if (!(CLIENT_KEYS as readonly string[]).includes(k)) throw new UsageError(`unknown client "${k}"; one of ${CLIENT_KEYS.join(', ')}`)
  const yes = args.flags.has('yes')
  const plans = planSetup(deps, url, only, args.flags.has('force'))

  io.out(`Aggregate MCP server: ${url}`)
  if (!plans.length) {
    io.out('No supported AI apps found (Claude Code, Claude Desktop, Codex CLI, Cursor, VS Code, Windsurf, Gemini CLI, Zed, opencode).')
    io.out(`Add this server URL in your app's MCP settings: ${url}`)
    return 1
  }
  let changes = 0
  for (const p of plans) {
    if (p.action === 'add' || p.action === 'replace') {
      changes++
      io.out(`\n${p.name}: ${p.action === 'add' ? 'add' : 'replace'} "${SERVER_NAME}" in ${p.file}`)
      for (const l of lineDiff(p.before, p.after)) io.out(`  ${l}`)
    } else if (p.action === 'command') {
      changes++
      if (p.pre) io.out(`\n${p.name}: run ${p.cmd} ${p.pre.join(' ')}, then ${p.cmd} ${p.args.join(' ')}`)
      else io.out(`\n${p.name}: run ${p.cmd} ${p.args.join(' ')}`)
    } else if ('note' in p) io.out(`\n${p.name}: ${p.note}`)
  }
  if (!changes) return 0
  if (!yes) {
    io.out('\nNothing changed yet. Run again with --yes to apply (each file is backed up first).')
    return 0
  }
  const stamp = deps.now().toISOString().replace(/[:.]/g, '-')
  let failed = 0
  for (const p of plans) {
    try {
      if (p.action === 'add' || p.action === 'replace') {
        if (p.before) deps.backup(p.file, `${p.file}.agfn-backup-${stamp}`)
        deps.write(p.file, p.after)
        io.out(`${p.name}: done${p.before ? ` (backup: ${p.file}.agfn-backup-${stamp})` : ''}`)
      } else if (p.action === 'command') {
        if (p.pre) deps.run(p.cmd, p.pre)
        deps.run(p.cmd, p.args)
        io.out(`${p.name}: done${p.then ? `; ${p.then}` : ''}`)
      }
    } catch (e) {
      failed++
      const hint = p.action === 'command' && p.hint ? ` (${p.hint})` : ''
      io.err(`${p.name}: failed: ${e instanceof Error ? e.message : String(e)}${hint}`)
    }
  }
  io.out('\nRestart the apps you changed. The first time you use Aggregate, the app opens a browser to sign in.')
  return failed ? 1 : 0
}
