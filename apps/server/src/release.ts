// Release step (Fly `release_command`): bring the database up to date once, before new machines start.
// It runs the same boot the server does (Aggregate migrations, the auth library's tables, row-level security
// policies, one-off data steps), then exits without serving or running jobs. If it fails, the deploy stops and
// the running version keeps serving. Machines still run the same steps at boot, which are then no-ops.

import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.ts'
import { boot } from './boot.ts'
import { loadInstalledModules } from './modules.ts'

export async function release(env: Record<string, string | undefined> = process.env): Promise<void> {
  // Migrations may build indexes on big tables: no statement time limit for the release step (the server keeps 30 s).
  process.env.AGFN_PG_STATEMENT_TIMEOUT_MS ??= '0'
  const config = { ...loadConfig(env), runWorker: false, role: 'web' as const }
  const modules = await loadInstalledModules(env)
  const booted = await boot({ config, env, ...modules })
  await booted.shutdown()
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  release()
    .then(() => {
      console.log('[agfn] release: database is up to date')
      process.exit(0)
    })
    .catch((err: unknown) => {
      console.error('[agfn] release failed:', err instanceof Error ? err.message : err)
      process.exit(1)
    })
}
