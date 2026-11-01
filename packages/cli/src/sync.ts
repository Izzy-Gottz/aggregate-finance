// agfn sync <connectionId> | --all
// Runs a sync in this process (same wiring as the server: registry, ledger, encryption), prints the outcome.

import { boot, type Booted } from '@agfn/server/boot'
import { loadConfig } from '@agfn/server/config'
import { loadInstalledModules } from '@agfn/server/modules'
import { UsageError, parseArgs, rejectUnknown, type Io } from './io.ts'

export type BootFn = (io: Io) => Promise<Booted>

export const bootFromEnv: BootFn = async (io) => {
  const config = loadConfig(io.env)
  const modules = await loadInstalledModules(io.env)
  return boot({ config: { ...config, runWorker: false, role: 'web' }, env: io.env, ...modules })
}

export async function settleAuth(booted: Booted): Promise<void> {
  const ctx = (booted.services.auth as { $context?: Promise<unknown> }).$context
  if (ctx) await ctx.catch(() => undefined)
}

export async function syncCommand(argv: string[], io: Io, bootFn: BootFn = bootFromEnv): Promise<number> {
  const args = parseArgs(argv, ['all'])
  rejectUnknown(args, ['all'])
  const all = args.flags.has('all')
  const [id, ...extra] = args.positionals
  if ((!id && !all) || (id && all) || extra.length) throw new UsageError('usage: agfn sync <connectionId> | agfn sync --all')

  const booted = await bootFn(io)
  // The auth library finishes setting itself up in the background (OAuth provider seeding); let it settle before
  // this short-lived process closes the database, or that work fails against a closed connection.
  await settleAuth(booted)
  try {
    const db = booted.services.db
    const ids = all
      ? (await db.selectFrom('connections').select('id').where('status', 'in', ['active', 'error', 'needs_reauth']).execute()).map((r) => r.id)
      : [id as string]
    if (!ids.length) {
      io.out('no connections to sync')
      return 0
    }
    let failed = 0
    for (const cid of ids) {
      const started = Date.now()
      const o = await booted.services.sync.sync(cid)
      const secs = ((Date.now() - started) / 1000).toFixed(1)
      const line = `${cid}: ${o.status} · ${o.events} events, ${o.posted} posted · ${secs}s${o.message ? ' · ' + o.message : ''}`
      if (o.status === 'ok' || o.status === 'partial') io.out(line)
      else {
        failed++
        io.err(line)
      }
    }
    return failed ? 1 : 0
  } finally {
    await booted.shutdown()
  }
}
