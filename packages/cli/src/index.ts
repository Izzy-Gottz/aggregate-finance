import { withBypass } from '@agfn/db'
import { demoCommand } from './demo.ts'
import { creatorCommand } from './creator.ts'
import { glassCommand } from './glass.ts'
import { grantCommand } from './grant.ts'
import { reviewerCommand } from './reviewer.ts'
import { doctorCommand } from './doctor.ts'
import { initCommand, migrateCommand } from './init.ts'
import { UsageError, type Io } from './io.ts'
import { mcpCommand } from './mcp.ts'
import { setupCommand } from './setup.ts'
import { syncCommand } from './sync.ts'
import { keysCommand } from './keys.ts'
import { usageCommand } from './usage.ts'
import { connectionRequestsCommand } from './connection-requests.ts'
import { backupCommand } from './backup.ts'
import { exportCommand } from './export.ts'
import { wipeCommand } from './wipe.ts'
import { challengeCheckFlagCommand, challengeQaCommand, challengeResetCommand } from './challenge-qa.ts'
import { anonymizeDeletedCommand } from './anonymize-deleted.ts'
import { rebuildCommand } from './rebuild.ts'

export { doctorCommand, runChecks, type Check } from './doctor.ts'
export { initCommand, migrateCommand, fillTemplate } from './init.ts'
export { mcpCommand, mcpConfigSnippet } from './mcp.ts'
export { setupCommand, planSetup, DEFAULT_MCP_URL } from './setup.ts'
export { syncCommand } from './sync.ts'
export { demoCommand } from './demo.ts'
export { usageCommand } from './usage.ts'
export { backupCommand } from './backup.ts'
export { exportCommand } from './export.ts'
export { parseArgs, UsageError, type Io } from './io.ts'

export const HELP = `agfn: Aggregate, the open-source finance MCP

  agfn init [--dir .] [--base-url URL] [--database-url URL] [--force] [--no-migrate]
      Write .env with fresh secrets and set up the database.
  agfn migrate                 Apply pending database migrations.
  agfn doctor [--online]       Check settings, master key, database, connectors and connections.
  agfn sync <connectionId>     Sync one connection now (or --all).
  agfn usage [--workspace ID] [--days N] [--json] [--reason WHY]
                               What each workspace costs to run: Plaid Items, syncs, storage, MCP calls.
  agfn connection-requests [--json] [--reason WHY]
                               Apps people asked for in Add a connection, and how many workspaces asked.
  agfn keys reseal [--apply --confirm RESEAL] [--reason WHY]
                               Stored secrets per master key; --apply moves them to the current key (dry run by default).
  agfn backup now | list | restore <key> [--to FILE]
                               Encrypted off-site backups (BACKUP_S3_*). Restore into an empty database.
  agfn export --format beancount|hledger [--workspace ID] [--company ID,ID] [--basis cash|accrual] [--out FILE] [--reason WHY]
                               The books as a plain-text journal, for Fava or hledger-web.
  agfn creator-link create --label TEXT [--code C] [--cap N] [--expires DATE] | list
  agfn glass-ledger create --from YYYY-MM-DD
  agfn grant free --workspace ID|EMAIL --months N --reason yc | list --workspace ID|EMAIL
                               Creator sign-up links (/r/<code>): who signed up through each, up to its cap.
  agfn reviewer-link create --label TEXT [--days N] | list | revoke ID
                               Demo-only sign-in link for app-directory reviewers (needs AGFN_REVIEWER_LINKS=1).
  agfn prelaunch-wipe [--keep-email EMAIL,EMAIL] [--apply --confirm WIPE]
                               Delete all test data except reviewer accounts and the keep-list (dry run by default).
  agfn challenge-qa-player --label TEXT [--days N]
                               Challenge deployment only: a QA player with made-up books and an MCP key (shown once).
  agfn challenge-reset --confirm RESET | challenge-check-flag VALUE
                               Challenge deployment only: run the nightly reset now; check a reported flag.
  agfn ledger-rebuild [--workspace ID] [--apply --confirm REBUILD] [--reason WHY]
                               Re-post every entry from its records after a posting-rule change; checks totals.
  agfn anonymize-deleted [--apply]
                               Tombstone a lingering email on an orphaned deleted-account row (dry run by default).
  agfn demo --email EMAIL      Fill a demo workspace (3 made-up companies + Personal) for someone who signed in.
  agfn setup [--url URL] [--client cursor,vscode,…] [--yes] [--force]
                               Add Aggregate to the AI apps on this machine (Claude Code, Codex CLI, Cursor,
                               VS Code, Windsurf, Gemini CLI, Zed, opencode; Claude Desktop gets the steps).
                               Shows the change; --yes applies it.
  agfn mcp --url URL           Bridge an MCP client (stdio) to an Aggregate server.
                               Key from AGFN_KEY or --key-file; never on the command line.
  agfn mcp --print-config --url URL
                               Print the JSON to paste into Claude, Cursor or VS Code.
`

/**
 * Returns the exit code, or null when the command keeps running (mcp bridge). Operator commands work across
 * workspaces, so each runs under its own named row-level-security scope (a no-op unless AGFN_PG_RLS=1).
 */
export async function run(argv: string[], io: Io): Promise<number | null> {
  const [cmd, ...rest] = argv
  try {
    switch (cmd) {
      case 'init':
        return await initCommand(rest, io)
      case 'migrate':
        return await withBypass('cli:migrate', () => migrateCommand(rest, io))
      case 'doctor':
        return await withBypass('cli:doctor', () => doctorCommand(rest, io))
      case 'sync':
        return await withBypass('cli:sync', () => syncCommand(rest, io))
      case 'backup':
        return await withBypass('cli:backup', () => backupCommand(rest, io))
      case 'keys':
        return await withBypass('cli:keys', () => keysCommand(rest, io))
      case 'usage':
        return await withBypass('cli:usage', () => usageCommand(rest, io))
      case 'connection-requests':
        return await withBypass('cli:connection-requests', () => connectionRequestsCommand(rest, io))
      case 'export':
        return await withBypass('cli:export', () => exportCommand(rest, io))
      case 'demo':
        return await withBypass('cli:demo', () => demoCommand(rest, io))
      case 'setup':
        return await setupCommand(rest, io)
      case 'reviewer-link':
        return await withBypass('cli:reviewer-link', () => reviewerCommand(rest, io))
      case 'creator-link':
        return await withBypass('cli:creator-link', () => creatorCommand(rest, io))
      case 'glass-ledger':
        return await withBypass('cli:glass-ledger', () => glassCommand(rest, io))
      case 'grant':
        return await withBypass('cli:grant', () => grantCommand(rest, io))
      case 'prelaunch-wipe':
        return await wipeCommand(rest, io)
      case 'challenge-qa-player':
        return await withBypass('cli:challenge-qa', () => challengeQaCommand(rest, io))
      case 'challenge-reset':
        return await withBypass('cli:challenge-reset', () => challengeResetCommand(rest, io))
      case 'challenge-check-flag':
        return await withBypass('cli:challenge-flag', () => challengeCheckFlagCommand(rest, io))
      case 'ledger-rebuild':
        return await withBypass('cli:ledger-rebuild', () => rebuildCommand(rest, io))
      case 'anonymize-deleted':
        return await withBypass('cli:anonymize-deleted', () => anonymizeDeletedCommand(rest, io))
      case 'mcp': {
        const printOnly = rest.includes('--print-config')
        const code = await mcpCommand(rest, io)
        return printOnly || code !== 0 ? code : null
      }
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.out(HELP)
        return cmd === undefined ? 2 : 0
      default:
        throw new UsageError(`unknown command "${cmd}". Run \`agfn help\`.`)
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`agfn: ${e.message}`)
      return 2
    }
    io.err(`agfn: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}
