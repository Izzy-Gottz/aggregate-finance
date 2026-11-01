// agfn glass-ledger create --from YYYY-MM-DD
// The Glass Ledger's own workspace (apps/server glass-ledger.ts): one persistent synthetic Harbor Coffee whose weekly
// activity (and the agents' actions on it) the public log is drawn from. Run once, with the launch week's Monday;
// running it again prints the same workspace.

import { createGlassLedger, GLASS_NAME } from '@agfn/server/glass-ledger'
import { UsageError, flagString, parseArgs, rejectUnknown, type Io } from './io.ts'
import { bootFromEnv, settleAuth, type BootFn } from './sync.ts'

const USAGE = 'usage: agfn glass-ledger create --from YYYY-MM-DD'

export async function glassCommand(argv: string[], io: Io, bootFn: BootFn = bootFromEnv): Promise<number> {
  const args = parseArgs(argv)
  rejectUnknown(args, ['from'])
  const [sub, ...extra] = args.positionals
  const from = flagString(args, 'from')
  if (sub !== 'create' || extra.length || !from) throw new UsageError(USAGE)
  const booted = await bootFn(io)
  await settleAuth(booted)
  try {
    const r = await createGlassLedger(booted.services, from).catch((err: Error) => {
      throw new UsageError(err.message)
    })
    io.out(`${r.created ? 'created' : 'already there'}: ${GLASS_NAME} (workspace ${r.workspaceId}), weeks from ${r.from}`)
    return 0
  } finally {
    await booted.shutdown()
  }
}
