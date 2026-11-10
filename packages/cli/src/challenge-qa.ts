// agfn challenge-qa-player --label "43 dry run" [--days N] [--web [--out FILE]] | challenge-reset --confirm RESET |
//   challenge-check-flag [--stdin | VALUE]
// The challenge's dry run (docs/launch/challenge-ops.md): a player with made-up books and an MCP agent key, so a tester
// plays without GitHub. --web also writes a browser session cookie (0600) for the web routes. Refused unless this is
// the challenge deployment (AGFN_CHALLENGE=1). The key is shown once.

import { chmodSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mintQaPlayer, mintQaWebSession } from '@agfn/server/challenge/qa-player'
import { checkFlag, resetChallenge } from '@agfn/server/challenge/reset'
import { deleteIfMemberless } from '@agfn/server/orphans'
import { serverDemoBuilder } from '@agfn/server/reviewer'
import { UsageError, flagString, parseArgs, rejectUnknown, type Io } from './io.ts'
import { bootFromEnv, settleAuth, type BootFn } from './sync.ts'

const USAGE = 'usage: agfn challenge-qa-player --label TEXT [--days N] [--web [--out FILE]]'

export async function challengeQaCommand(argv: string[], io: Io, bootFn: BootFn = bootFromEnv): Promise<number> {
  const args = parseArgs(argv, ['web'])
  rejectUnknown(args, ['label', 'days', 'web', 'out'])
  if (args.positionals.length) throw new UsageError(USAGE)
  if (io.env.AGFN_CHALLENGE !== '1') throw new UsageError('QA players exist only on the challenge deployment (AGFN_CHALLENGE=1)')
  const web = args.flags.get('web') === true
  const outFlag = flagString(args, 'out')
  if (outFlag !== undefined && !web) throw new UsageError('--out only applies with --web')
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
    if (web) {
      const cookie = await mintQaWebSession({ auth: s.auth, baseUrl: s.config.baseUrl }, p.email).catch((err: Error) => {
        throw new UsageError(err.message)
      })
      // The cookie is a browser credential for this player: write it 0600 and keep it out of the printed output.
      const path = resolve(io.cwd, outFlag ?? `challenge-qa-web-${p.workspaceId}.cookie`)
      writeFileSync(path, cookie + '\n', { mode: 0o600 })
      chmodSync(path, 0o600)
      io.out(`WEB: session cookie written to ${path} (mode 0600). Send it as the Cookie header to ${s.config.baseUrl.replace(/\/+$/, '')}, e.g. curl -H "Cookie: $(cat ${path})" …`)
    }
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
  const args = parseArgs(argv, ['stdin'])
  rejectUnknown(args, ['stdin'])
  const useStdin = args.flags.get('stdin') === true
  let value: string
  if (useStdin) {
    // The judge pipes the reported flag in, so the value is never on the command line (fly's audit, the remote shell
    // history) or in any error below — only the name it matches, or "not a current flag", is ever printed.
    if (args.positionals.length) throw new UsageError('with --stdin the value is read from standard input, not an argument')
    if (!io.readStdin) throw new UsageError('--stdin needs the value piped in, e.g. printf %s "$FLAG" | agfn challenge-check-flag --stdin')
    value = (await io.readStdin()).trim()
    if (!value) throw new UsageError('no value on standard input')
  } else {
    const [v, ...extra] = args.positionals
    if (!v || extra.length) throw new UsageError('usage: agfn challenge-check-flag VALUE  (or --stdin to read the value from standard input)')
    value = v
  }
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
