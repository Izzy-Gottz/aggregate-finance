// agfn creator-link create --label "Jane's channel" [--code jane] [--cap 100] [--expires 2026-12-31] | list
// Creator sign-up links (apps/server creator-links.ts): <BASE_URL>/r/<code> remembers the code, and a sign-up through it
// records one attribution (3 months free once pricing starts, up to the link's cap). `list` shows used/cap per link.

import { createCreatorLink, listCreatorLinks } from '@agfn/server/creator-links'
import { UsageError, flagString, parseArgs, rejectUnknown, type Io } from './io.ts'
import { bootFromEnv, settleAuth, type BootFn } from './sync.ts'

const USAGE = 'usage: agfn creator-link create --label TEXT [--code C] [--cap N] [--expires YYYY-MM-DD] | agfn creator-link list'

export async function creatorCommand(argv: string[], io: Io, bootFn: BootFn = bootFromEnv): Promise<number> {
  const args = parseArgs(argv)
  rejectUnknown(args, ['label', 'code', 'cap', 'expires'])
  const [sub, ...extra] = args.positionals
  if (!sub || extra.length || !['create', 'list'].includes(sub)) throw new UsageError(USAGE)
  const capFlag = flagString(args, 'cap')
  if (capFlag !== undefined && !/^\d+$/.test(capFlag)) throw new UsageError('--cap must be a whole number')
  const booted = await bootFn(io)
  await settleAuth(booted)
  try {
    const s = booted.services
    if (sub === 'list') {
      const all = await listCreatorLinks(s.db)
      if (!all.length) io.out('no creator links')
      const now = new Date().toISOString()
      for (const l of all) io.out(`${l.code}  ${l.used}/${l.cap}  ${l.expiresAt < now ? 'expired' : `until ${l.expiresAt.slice(0, 10)}`}  ${l.label}`)
      return 0
    }
    const expires = flagString(args, 'expires')
    const link = await createCreatorLink(s.db, {
      label: flagString(args, 'label') ?? '',
      ...(flagString(args, 'code') ? { code: flagString(args, 'code')! } : {}),
      ...(capFlag !== undefined ? { cap: Number(capFlag) } : {}),
      ...(expires ? { expiresAt: /^\d{4}-\d{2}-\d{2}$/.test(expires) ? `${expires}T23:59:59.000Z` : expires } : {}),
    }).catch((err: Error) => {
      throw new UsageError(err.message)
    })
    io.out(`${s.config.baseUrl.replace(/\/+$/, '')}/r/${link.code}`)
    io.out(`first ${link.cap} sign-ups, valid until ${link.expiresAt.slice(0, 10)}; count with: agfn creator-link list`)
    return 0
  } finally {
    await booted.shutdown()
  }
}
