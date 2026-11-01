// agfn grant free --workspace <id|owner email> (--months N | --until YYYY-MM-DD) --reason <yc|text> [--by NAME]
// agfn grant list --workspace <id|owner email>
// Free time on a workspace (apps/server free-grants.ts): the YC Deal is `--months 12 --reason yc`. Billing reads these
// when paid plans start; Preferences shows the line. Runbook: docs/ops/yc-deal.md.

import { freeGrants, freeLabel, grantFree, resolveWorkspace, type GrantKind } from '@agfn/server/free-grants'
import { UsageError, flagString, parseArgs, rejectUnknown, type Io } from './io.ts'
import { bootFromEnv, settleAuth, type BootFn } from './sync.ts'

const USAGE = 'usage: agfn grant free --workspace ID|EMAIL (--months N | --until YYYY-MM-DD) --reason yc|TEXT [--by NAME] | agfn grant list --workspace ID|EMAIL'

export async function grantCommand(argv: string[], io: Io, bootFn: BootFn = bootFromEnv): Promise<number> {
  const args = parseArgs(argv)
  rejectUnknown(args, ['workspace', 'months', 'until', 'reason', 'by'])
  const [sub, ...extra] = args.positionals
  const ref = flagString(args, 'workspace')
  if (!sub || extra.length || !['free', 'list'].includes(sub) || !ref) throw new UsageError(USAGE)
  const months = flagString(args, 'months')
  if (months !== undefined && !/^\d+$/.test(months)) throw new UsageError('--months must be a whole number')
  const booted = await bootFn(io)
  await settleAuth(booted)
  try {
    const db = booted.services.db
    const ws = await resolveWorkspace(db, ref).catch((err: Error) => {
      throw new UsageError(err.message)
    })
    if (sub === 'free') {
      const reason = flagString(args, 'reason') ?? ''
      const kind: GrantKind = reason.trim().toLowerCase() === 'yc' ? 'yc' : 'manual'
      const until = flagString(args, 'until')
      await grantFree(db, {
        workspaceId: ws.id,
        kind,
        ...(months !== undefined ? { months: Number(months) } : {}),
        ...(until !== undefined ? { until } : {}),
        reason: kind === 'yc' ? 'YC Deal' : reason,
        grantedBy: flagString(args, 'by') ?? process.env.USER ?? 'ops',
      }).catch((err: Error) => {
        throw new UsageError(err.message)
      })
    }
    const all = await freeGrants(db, ws.id)
    io.out(`${ws.name} (${ws.id}): ${freeLabel(all) ?? 'no free grant'}`)
    for (const g of all) io.out(`  ${g.kind}  ${g.months !== null ? `${g.months} months` : `until ${g.until}`}  ${g.reason}  by ${g.grantedBy} on ${g.at.slice(0, 10)}`)
    return 0
  } finally {
    await booted.shutdown()
  }
}
