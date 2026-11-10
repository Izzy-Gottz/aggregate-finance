// agfn anonymize-deleted [--apply]
// Backfill for accounts deleted before anonymization was reliable: person rows that still carry a real email but
// belong to nobody reachable (no sign-in, no live membership, no company, no AI grant). Dry run by default — it only
// reports counts and email DOMAINS (never the address itself). Add --apply to replace those emails with the tombstone.
// Idempotent: run it again and it finds nothing. Run the dry run first and eyeball the domains before --apply.

import { anonymizeOrphanedDeletedPeople } from '@agfn/server/delete-account'
import { UsageError, parseArgs, rejectUnknown, type Io } from './io.ts'
import { bootFromEnv, settleAuth, type BootFn } from './sync.ts'

export async function anonymizeDeletedCommand(argv: string[], io: Io, bootFn: BootFn = bootFromEnv): Promise<number> {
  const args = parseArgs(argv, ['apply'])
  rejectUnknown(args, ['apply'])
  if (args.positionals.length) throw new UsageError('usage: agfn anonymize-deleted [--apply]')
  const apply = args.flags.get('apply') === true
  const booted = await bootFn(io)
  await settleAuth(booted)
  try {
    const r = await anonymizeOrphanedDeletedPeople(booted.services.db, { apply })
    io.out(`${apply ? 'anonymized' : 'would anonymize'} ${apply ? r.anonymized : r.found} orphaned person row(s) with a lingering email`)
    if (r.samples.length) {
      io.out(`sample (id · email domain · created):`)
      for (const s of r.samples) io.out(`  ${s.id}  ${s.emailDomain}  ${s.createdAt.slice(0, 10)}`)
      if (r.found > r.samples.length) io.out(`  … and ${r.found - r.samples.length} more`)
    }
    if (!apply && r.found) io.out('Dry run only. Re-run with --apply to tombstone these.')
    return 0
  } finally {
    await booted.shutdown()
  }
}
