// agfn prelaunch-wipe [--keep-email a@x,b@y [--allow-missing]] [--apply --confirm WIPE [--branch-copy]]
// The launch-day wipe (apps/server prelaunch-wipe.ts): deletes all test data except reviewer accounts and the
// keep-list. Without --apply it only prints what it would keep and delete. Take a backup first.
// RETIRED on live (2026-11-01): live has real users, so --apply runs only on a database copy (a Neon branch or an RDS
// snapshot restore; --branch-copy); the dry run still lists what it would do.

import { withWorkspace } from '@agfn/db'
import { applyWipe, planWipe, rowsOnly, type WipePlan } from '@agfn/server/prelaunch-wipe'
import { UsageError, flagString, parseArgs, rejectUnknown, type Io } from './io.ts'
import { bootFromEnv, settleAuth, type BootFn } from './sync.ts'

const USAGE = 'usage: agfn prelaunch-wipe [--keep-email EMAIL,EMAIL [--allow-missing]] [--apply --confirm WIPE [--branch-copy]]'

function print(io: Io, plan: WipePlan): void {
  io.out(`keep ${plan.keepPeople.length} people:`)
  for (const p of plan.keepPeople) io.out(`  ${p.id}  ${p.email}  (${p.why})`)
  io.out(`keep ${plan.keepWorkspaces.length} workspaces:`)
  for (const w of plan.keepWorkspaces) io.out(`  ${w.id}  ${w.name}  (${w.why})`)
  io.out(`delete ${plan.deleteWorkspaces.length} workspaces:`)
  for (const w of plan.deleteWorkspaces) io.out(`  ${w.id}  ${w.name}`)
  io.out(`delete ${plan.deletePeople.length} people:`)
  for (const p of plan.deletePeople) io.out(`  ${p.id}  ${p.email}`)
  if (plan.notFound.length) io.out(`not signed up, nothing to keep: ${plan.notFound.join(', ')}`)
  io.out(`delete ${plan.deleteAuthUsers} sign-in accounts, ${plan.pendingMagicLinks} pending sign-in links, ${plan.deadReviewerLinks} revoked or expired reviewer links`)
}

export async function wipeCommand(argv: string[], io: Io, bootFn: BootFn = bootFromEnv): Promise<number> {
  const args = parseArgs(argv, ['apply', 'allow-missing', 'branch-copy'])
  rejectUnknown(args, ['keep-email', 'apply', 'confirm', 'allow-missing', 'branch-copy'])
  if (args.positionals.length) throw new UsageError(USAGE)
  const apply = args.flags.has('apply')
  if (apply && !args.flags.has('branch-copy')) throw new UsageError('Live has real users; the pre-launch wipe is retired. --apply runs only on a database copy (a Neon branch or an RDS snapshot restore; --branch-copy); without --apply it is a dry run.')
  if (apply && flagString(args, 'confirm') !== 'WIPE') throw new UsageError('--apply deletes data for good: add --confirm WIPE (take a backup first: agfn backup now)')
  const keepEmails = (flagString(args, 'keep-email') ?? '').split(',').filter(Boolean)

  const booted = await bootFn(io)
  await settleAuth(booted)
  try {
    const s = booted.services
    const plan = await planWipe(s.db, { keepEmails, allowMissing: args.flags.has('allow-missing') }).catch((err: Error) => {
      throw new UsageError(err.message)
    })
    print(io, plan)
    if (!apply) {
      io.out('dry run: nothing deleted. (--apply runs only on a database copy (a Neon branch or an RDS snapshot restore), with --branch-copy --confirm WIPE.)')
      return 0
    }
    // --branch-copy: a database copy (a Neon branch, or an RDS snapshot restored to a new instance) shares live's provider tokens and file bucket, so there only rows go: no
    // provider is told to revoke anything and no stored file is deleted (both would hit the live service).
    const copy = args.flags.has('branch-copy')
    if (copy) io.out('branch copy: rows only; providers are not contacted and stored files are left alone')
    const deps = {
      db: s.db,
      files: s.files,
      sync: s.sync,
      log: (m: string, f?: Record<string, unknown>) => io.err(`${m} ${f ? JSON.stringify(f) : ''}`),
      ...(s.mcp ? { revokeGrant: (workspaceId: string, personId: string, grantId: string) => withWorkspace(workspaceId, () => s.mcp!.control.revokeGrant({ workspaceId, personId }, grantId)) } : {}),
    }
    const result = await applyWipe(copy ? rowsOnly(deps) : deps, plan)
    io.out(`deleted ${result.workspacesDeleted} workspaces, ${result.peopleDeleted} people, ${result.authUsersDeleted} sign-in accounts`)
    for (const f of result.failures) io.err(`not deleted: ${f}`)
    const after = await planWipe(s.db, { keepEmails, allowMissing: args.flags.has('allow-missing') })
    const left = after.deleteWorkspaces.length + after.deletePeople.length + after.deleteAuthUsers
    io.out(left ? `still left to delete: ${after.deleteWorkspaces.length} workspaces, ${after.deletePeople.length} people, ${after.deleteAuthUsers} sign-in accounts (run again)` : 'check: nothing left to delete')
    return result.failures.length || left ? 1 : 0
  } finally {
    await booted.shutdown()
  }
}
