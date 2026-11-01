// agfn reviewer-link create --label "Anthropic directory review" [--days 30] | list | revoke <id>
// Demo-only sign-in links for directory reviewers (apps/server reviewer.ts). Off unless AGFN_REVIEWER_LINKS=1.

import { listReviewerLinks, mintReviewerLink, revokeReviewerLink, serverDemoBuilder } from '@agfn/server/reviewer'
import { UsageError, flagString, parseArgs, rejectUnknown, type Io } from './io.ts'
import { bootFromEnv, settleAuth, type BootFn } from './sync.ts'

const USAGE = 'usage: agfn reviewer-link create --label TEXT [--days N] | agfn reviewer-link list | agfn reviewer-link revoke <id>'

export async function reviewerCommand(argv: string[], io: Io, bootFn: BootFn = bootFromEnv): Promise<number> {
  const args = parseArgs(argv)
  rejectUnknown(args, ['label', 'days'])
  const [sub, id, ...extra] = args.positionals
  if (!sub || extra.length || !['create', 'list', 'revoke'].includes(sub) || (sub === 'revoke') !== Boolean(id)) throw new UsageError(USAGE)
  if (io.env.AGFN_REVIEWER_LINKS !== '1') throw new UsageError('reviewer links are off: set AGFN_REVIEWER_LINKS=1 here and on the server')
  const booted = await bootFn(io)
  await settleAuth(booted)
  try {
    const s = booted.services
    if (sub === 'list') {
      const all = await listReviewerLinks(s.db)
      if (!all.length) io.out('no reviewer links')
      for (const l of all) io.out(`${l.id}  ${l.revoked ? 'revoked' : l.expiresAt < new Date().toISOString() ? 'expired' : `until ${l.expiresAt.slice(0, 10)}`}  used ${l.uses}x  ${l.label}`)
      return 0
    }
    if (sub === 'revoke') {
      io.out((await revokeReviewerLink(s.db, id!)) ? 'revoked; its sessions are signed out' : `no reviewer link ${id}`)
      return 0
    }
    const label = flagString(args, 'label') ?? ''
    const daysFlag = flagString(args, 'days')
    const days = daysFlag === undefined ? undefined : Number(daysFlag)
    const link = await mintReviewerLink({ db: s.db, buildDemo: serverDemoBuilder(s) }, { label, ...(days !== undefined ? { days } : {}), baseUrl: s.config.baseUrl }).catch((err: Error) => {
      throw new UsageError(err.message)
    })
    io.out(`reviewer link (shown once; valid until ${link.expiresAt.slice(0, 10)}):`)
    io.out(link.url)
    io.out(`it opens a demo-only account (${link.email}); revoke with: agfn reviewer-link revoke ${link.id}`)
    return 0
  } finally {
    await booted.shutdown()
  }
}
