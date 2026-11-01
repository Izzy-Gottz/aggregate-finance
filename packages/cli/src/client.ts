// The npm package `aggregate-finance` (npx aggregate-finance …; installed, the command is `agfn`): the commands for the machine where your AI apps run. They connect to an
// Aggregate server; they never open a database. Server commands (doctor, backup, migrate…) run in a server checkout.
import { NPX_LAUNCHER, mcpCommand } from './mcp.ts'
import { setupCommand } from './setup.ts'
import { demoLocalCommand } from './demo-local.ts'
import { UsageError, type Io } from './io.ts'
import { runBridge } from '@agfn/mcp/stdio'

export const CLIENT_HELP = `agfn: connect your AI apps to Aggregate, the open-source finance MCP

  agfn demo [--port N] [--fresh]
                               Try it with no keys: a local server with a made-up sample business, plus the
                               line that connects Claude Code. Data in ~/.agfn/demo.
  agfn setup [--url URL] [--client cursor,vscode,…] [--yes] [--force]
                               Add Aggregate to the AI apps on this machine (Claude Code, Codex CLI, Cursor,
                               VS Code, Windsurf, Gemini CLI, Zed, opencode; Claude Desktop gets the steps).
                               Shows the change; --yes applies it.
  agfn mcp --url URL           Bridge an MCP client (stdio) to an Aggregate server.
                               Key from AGFN_KEY or --key-file; never on the command line.
  agfn mcp --print-config --url URL
                               Print the JSON to paste into Claude, Cursor or VS Code.

Running your own server? Its commands (doctor, backup, migrate, sync…) run in its checkout:
  npm run -s agfn -- doctor
Docs: https://github.com/Izzy-Gottz/aggregate-finance
`

const SERVER_COMMANDS = new Set(['init', 'migrate', 'doctor', 'sync', 'backup', 'usage', 'export', 'reviewer-link', 'prelaunch-wipe', 'ledger-rebuild'])

/** Returns the exit code, or null while the bridge keeps serving stdio. */
export async function runClient(argv: string[], io: Io): Promise<number | null> {
  const [cmd, ...rest] = argv
  try {
    switch (cmd) {
      case 'setup':
        return await setupCommand(rest, io)
      case 'demo':
        // The checkout's `agfn demo --email` adds the demo to a signed-in account on a real server.
        if (rest.includes('--email')) throw new UsageError('"demo --email" runs on the server, in its checkout: npm run -s agfn -- demo --email you@example.com')
        return await demoLocalCommand(rest, io)
      case 'mcp': {
        const printOnly = rest.includes('--print-config')
        const code = await mcpCommand(rest, io, { bridge: runBridge, launcher: NPX_LAUNCHER })
        return printOnly || code !== 0 ? code : null
      }
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.out(CLIENT_HELP)
        return cmd === undefined ? 2 : 0
      default:
        if (SERVER_COMMANDS.has(cmd)) throw new UsageError(`"${cmd}" runs on the server, in its checkout: npm run -s agfn -- ${cmd}`)
        throw new UsageError(`unknown command "${cmd}". Run \`agfn help\`.`)
    }
  } catch (e) {
    io.err(`agfn: ${e instanceof Error ? e.message : String(e)}`)
    return e instanceof UsageError ? 2 : 1
  }
}
