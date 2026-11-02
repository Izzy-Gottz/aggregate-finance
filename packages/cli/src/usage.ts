// agfn usage [--workspace ID] [--days N] [--json] [--reason WHY]
// Operator view of what each workspace costs to run (same numbers as GET /api/usage), plus instance totals.

import { UsageError, parseArgs, rejectUnknown, type Io } from './io.ts'
import { operatorAccess, recordOperatorAccess } from './operator.ts'
import { bootFromEnv, settleAuth, type BootFn } from './sync.ts'

export async function usageCommand(argv: string[], io: Io, bootFn: BootFn = bootFromEnv): Promise<number> {
  const args = parseArgs(argv, ['json'])
  rejectUnknown(args, ['workspace', 'days', 'json', 'reason'])
  if (args.positionals.length) throw new UsageError('usage: agfn usage [--workspace ID] [--days N] [--json] [--reason WHY]')
  const daysFlag = args.flags.get('days')
  const days = daysFlag === undefined ? 30 : Number(daysFlag)
  if (!Number.isInteger(days) || days < 1 || days > 400) throw new UsageError('--days must be a whole number from 1 to 400')
  const only = args.flags.get('workspace')
  if (only === true) throw new UsageError('--workspace needs an id')
  const access = operatorAccess(args, io)

  const booted = await bootFn(io)
  await settleAuth(booted)
  try {
    const usage = booted.services.usage
    const wss = (await booted.services.db.selectFrom('workspaces').select(['id', 'name']).execute()).filter((w) => !only || w.id === only)
    if (only && !wss.length) throw new UsageError(`no workspace ${only}`)
    await recordOperatorAccess(booted.services.db, access, 'usage', only)
    const rows = []
    for (const w of wss) rows.push({ id: w.id, name: w.name, today: await usage.snapshot(w.id), history: await usage.history(w.id, days) })
    const instance = await usage.instance()
    if (args.flags.has('json')) {
      io.out(JSON.stringify({ instance, workspaces: rows }, null, 2))
      return 0
    }
    const mb = (b: number | null) => (b === null ? '?' : `${(b / 1_048_576).toFixed(1)} MB`)
    io.out(`instance: ${instance.workspaces} workspace(s) · ${instance.emailsSent} email(s) today · database ${mb(instance.dbBytes)}`)
    for (const r of rows) {
      const t = r.today
      const products = Object.entries(t.plaidItems.products).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'
      const conns = Object.entries(t.connections).map(([k, v]) => `${k} ${v.active}/${v.total}`).join(', ') || 'none'
      io.out(
        [
          `${r.name} (${r.id})`,
          `  Plaid Items ${t.plaidItems.active} (${products})`,
          `  connections ${conns}`,
          `  ${t.transactionsStored} transactions · ${t.documents.count} documents (${mb(t.documents.bytes)}) · ~${mb(t.db.estimatedBytes)} of the database`,
          `  today: ${t.syncJobs.count} syncs (p50 ${t.syncJobs.p50Ms ?? '-'} ms, p95 ${t.syncJobs.p95Ms ?? '-'} ms, ${t.syncJobs.failed} failed) · ${t.mcpCalls.total} MCP calls`,
          `  ${r.history.length} daily rollup(s) in the last ${days} days`,
        ].join('\n'),
      )
    }
    return 0
  } finally {
    await booted.shutdown()
  }
}
