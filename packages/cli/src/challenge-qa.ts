// agfn challenge-qa-player --label "43 dry run" [--days N] | challenge-reset --confirm RESET | challenge-check-flag VALUE
// The challenge's dry run (docs/launch/challenge-ops.md): a player with made-up books and an MCP agent key, so a tester
// plays without GitHub. Refused unless this is the challenge deployment (AGFN_CHALLENGE=1). The key is shown once.

import { mintQaPlayer } from '@agfn/server/challenge/qa-player'
import { checkFlag, resetChallenge } from '@agfn/server/challenge/reset'
import { deleteIfMemberless } from '@agfn/server/orphans'
import { serverDemoBuilder } from '@agfn/server/reviewer'
import { UsageError, flagString, parseArgs, rejectUnknown, type Io } from './io.ts'
import { bootFromEnv, settleAuth, type BootFn } from './sync.ts'

const USAGE = 'usage: agfn challenge-qa-player --label TEXT [--days N]'

export async function challengeQaCommand(argv: string[], io: Io, bootFn: BootFn = bootFromEnv): Promise<number> {
  const args = parseArgs(argv)
  rejectUnknown(args, ['label', 'days'])
  if (args.positionals.length) throw new UsageError(USAGE)
  if (io.env.AGFN_CHALLENGE !== '1') throw new UsageError('QA players exist only on the challenge deployment (AGFN_CHALLENGE=1)')
  const booted = await bootFn(io)
  await settleAuth(booted)
  try {
    const s = booted.services
    if (!s.mcp) throw new UsageError('this server has no MCP service')
    const daysFlag = flagString(args, 'days')
    const p = await mintQaPlayer(
      { db: s.db, buildDemo: serverDemoBuilder(s), control: s.mcp.control },
      { label: flagString(args, 'label') ?? '', challenge: s.config.challenge === true, ...(daysFlag !== undefined ? { days: Number(daysFlag) } : {}) },
    ).catch((err: Error) => {
      throw new UsageError(err.message)
    })
    io.out(`QA player ${p.email}, workspace ${p.workspaceId}`)
    io.out(`MCP: ${s.config.baseUrl.replace(/\/+$/, '')}/mcp  with  Authorization: Bearer <key below>  (until ${p.expiresAt.slice(0, 10)}; the nightly reset revokes it)`)
    io.out(p.key)
    return 0
  } finally {
    await booted.shutdown()
  }
}

/** The nightly reset, now (operators: after a fix, or to test it). Players' books and AI access end; flags change. */
export async function challengeResetCommand(argv: string[], io: Io, bootFn: BootFn = bootFromEnv): Promise<number> {
  const args = parseArgs(argv)
  rejectUnknown(args, ['confirm'])
  if (args.positionals.length) throw new UsageError('usage: agfn challenge-reset --confirm RESET')
  if (io.env.AGFN_CHALLENGE !== '1') throw new UsageError('the reset exists only on the challenge deployment (AGFN_CHALLENGE=1)')
  if (flagString(args, 'confirm') !== 'RESET') throw new UsageError("this wipes every player's books and AI access: add --confirm RESET")
  const booted = await bootFn(io)
  await settleAuth(booted)
  try {
    const s = booted.services
    const r = await resetChallenge({ db: s.db, buildDemo: serverDemoBuilder(s), cleanup: (ids) => deleteIfMemberless({ db: s.db, files: s.files, sync: s.sync }, ids) })
    io.out(`reset: ${r.players} player(s) given fresh books, ${r.archived} activity row(s) archived, new flags planted`)
    return 0
  } finally {
    await booted.shutdown()
  }
}

/** Judging: is this a planted flag of the current reset? Prints vault, neighbor or "not a current flag". */
export async function challengeCheckFlagCommand(argv: string[], io: Io, bootFn: BootFn = bootFromEnv): Promise<number> {
  const args = parseArgs(argv)
  rejectUnknown(args, [])
  const [value, ...extra] = args.positionals
  if (!value || extra.length) throw new UsageError('usage: agfn challenge-check-flag VALUE')
  if (io.env.AGFN_CHALLENGE !== '1') throw new UsageError('flags exist only on the challenge deployment (AGFN_CHALLENGE=1)')
  const booted = await bootFn(io)
  await settleAuth(booted)
  try {
    const name = await checkFlag(booted.services.db, value)
    io.out(name ?? 'not a current flag')
    return name ? 0 : 1
  } finally {
    await booted.shutdown()
  }
}
