// agfn mcp --url https://you.example/mcp          (key from AGFN_KEY, or --key-file)
// agfn mcp --print-config --url https://you.example/mcp
// Bridges a stdio MCP client (Claude Desktop/Code, Cursor, VS Code) to a remote Aggregate server.
// The key never goes on the command line: argv lands in shell history, process lists and shared config snippets.

import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// Narrow entries, not the package index: the npm build bundles only the bridge, not the server.
import { looksLikeAgentKey } from '@agfn/mcp/keys'
import { runBridge } from '@agfn/mcp/stdio'
import { UsageError, flagString, parseArgs, rejectUnknown, type Io } from './io.ts'

export const MCP_USAGE = 'usage: agfn mcp --url https://you.example/mcp   (key in AGFN_KEY, or --key-file <path>)'

export interface McpDeps {
  bridge: (opts: { url: string; key: string }) => Promise<unknown>
  /** How an AI client should start this CLI. Default: this Node and this checkout's entry; from npm: npx. */
  launcher?: Launcher
}

/** The command an AI client runs to start `agfn mcp` (before the subcommand's own arguments). */
export interface Launcher {
  command: string
  args: string[]
}

/** The published package (`npx aggregate-finance`, command `agfn`) starts itself through npx, so it works on any machine with Node. */
export const NPX_LAUNCHER: Launcher = { command: 'npx', args: ['-y', 'aggregate-finance'] }

export function readKeyFile(path: string): string {
  let st
  try {
    st = statSync(path)
  } catch {
    throw new UsageError(`can't read key file ${path}`)
  }
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    throw new UsageError(`key file ${path} is readable by other users; run: chmod 600 ${path}`)
  }
  return readFileSync(path, 'utf8').trim()
}

/**
 * From a checkout, `agfn` is usually not on PATH: point the AI client at this Node and this checkout's CLI entry by
 * absolute path, which works from any directory. The npm package passes NPX_LAUNCHER instead.
 */
export function mcpConfigSnippet(url: string, launcher: Launcher = { command: process.execPath, args: [fileURLToPath(new URL('./main.ts', import.meta.url))] }): string {
  return JSON.stringify({ mcpServers: { aggregate: { command: launcher.command, args: [...launcher.args, 'mcp', '--url', url], env: { AGFN_KEY: 'agfn_live_…' } } } }, null, 2)
}

export async function mcpCommand(argv: string[], io: Io, deps: McpDeps = { bridge: runBridge }): Promise<number> {
  if (argv.some((a) => a.startsWith('agfn_live_') || a.startsWith('agfn_test_') || a.includes('=agfn_live_'))) {
    throw new UsageError('never put the key on the command line; set AGFN_KEY in your MCP client\'s "env" block (or use --key-file)')
  }
  if (argv.includes('--key') || argv.some((a) => a.startsWith('--key='))) {
    throw new UsageError('--key is not supported (argv is visible to other programs); set AGFN_KEY or use --key-file <path>')
  }
  const args = parseArgs(argv, ['print-config'])
  rejectUnknown(args, ['url', 'key-file', 'print-config'])
  const url = flagString(args, 'url') ?? io.env.AGFN_URL
  if (!url) throw new UsageError(MCP_USAGE)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new UsageError(`not a URL: ${url}`)
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1'
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
    throw new UsageError('the server URL must be https (http is allowed only for localhost)')
  }
  if (args.flags.has('print-config')) {
    io.out(mcpConfigSnippet(parsed.toString(), deps.launcher))
    return 0
  }
  const keyFile = flagString(args, 'key-file')
  const key = keyFile ? readKeyFile(resolve(io.cwd, keyFile)) : io.env.AGFN_KEY?.trim()
  if (!key) throw new UsageError(MCP_USAGE)
  if (!looksLikeAgentKey(key)) throw new UsageError('that does not look like an Aggregate agent key (agfn_live_…)')
  await deps.bridge({ url: parsed.toString(), key })
  return 0
}
