// agfn connection-requests [--json] [--reason WHY]
// Which apps people asked for under "Don't see your app? Request it +": each app and how many workspaces asked. Totals
// only: no workspace, person or date is printed. Hosted, it's an operator read across workspaces, so it's recorded.

import { requestCounts } from '@agfn/server/connection-requests'
import { UsageError, parseArgs, rejectUnknown, type Io } from './io.ts'
import { operatorAccess, recordOperatorAccess } from './operator.ts'
import { bootFromEnv, settleAuth, type BootFn } from './sync.ts'

export async function connectionRequestsCommand(argv: string[], io: Io, bootFn: BootFn = bootFromEnv): Promise<number> {
  const args = parseArgs(argv, ['json'])
  rejectUnknown(args, ['json', 'reason'])
  if (args.positionals.length) throw new UsageError('usage: agfn connection-requests [--json] [--reason WHY]')
  const access = operatorAccess(args, io)
  const booted = await bootFn(io)
  await settleAuth(booted)
  try {
    await recordOperatorAccess(booted.services.db, access, 'connection-requests')
    const rows = await requestCounts(booted.services.db)
    if (args.flags.has('json')) {
      io.out(JSON.stringify(rows.map((r) => ({ app: r.key, name: r.name, workspaces: r.workspaces })), null, 2))
      return 0
    }
    if (!rows.length) {
      io.out('no connection requests yet')
      return 0
    }
    const width = Math.max(...rows.map((r) => r.name.length))
    for (const r of rows) io.out(`${r.name.padEnd(width)}  ${r.workspaces} workspace${r.workspaces === 1 ? '' : 's'}`)
    return 0
  } finally {
    await booted.shutdown()
  }
}
