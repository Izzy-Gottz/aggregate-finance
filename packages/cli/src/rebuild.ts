// agfn ledger-rebuild [--workspace ID] [--apply --confirm REBUILD]
// Re-posts every workspace's entries from its source records (the ledger engine's rebuild), after a posting-rule change
// such as wages_income. Without --apply it only lists the workspaces. With --apply, per workspace: totals per ledger
// account role before and after, the roles that moved, and a check that each account type's total (asset, liability,
// equity, income, expense) is unchanged, then a second rebuild that must change nothing (idempotent). Run it on the
// machine (fly ssh console … -C "node packages/cli/src/main.ts ledger-rebuild …"), like every agfn command.

import { sql, type Kysely } from 'kysely'
import { UsageError, flagString, parseArgs, rejectUnknown, type Io } from './io.ts'
import { bootFromEnv, settleAuth, type BootFn } from './sync.ts'

const USAGE = 'usage: agfn ledger-rebuild [--workspace ID] [--apply --confirm REBUILD]'

type Totals = Map<string, number>

/** Net base amount (debit − credit) per "type role" across all of a workspace's lines. */
async function totals(db: Kysely<any>, ws: string): Promise<Totals> {
  const rows = await db
    .selectFrom('journal_lines as l')
    .innerJoin('ledger_accounts as a', 'a.id', 'l.ledger_account_id')
    .select(['a.type', 'a.role', sql<string>`sum(l.base_debit_minor - l.base_credit_minor)`.as('net')])
    .where('l.workspace_id', '=', ws)
    .groupBy(['a.type', 'a.role'])
    .execute()
  return new Map(rows.map((r) => [`${r.type} ${r.role}`, Number(r.net)]))
}

function diff(a: Totals, b: Totals): Array<{ key: string; before: number; after: number }> {
  const out: Array<{ key: string; before: number; after: number }> = []
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const before = a.get(key) ?? 0
    const after = b.get(key) ?? 0
    if (before !== after) out.push({ key, before, after })
  }
  return out.sort((x, y) => x.key.localeCompare(y.key))
}

function byType(t: Totals): Totals {
  const out: Totals = new Map()
  for (const [k, v] of t) {
    const type = k.split(' ')[0] as string
    out.set(type, (out.get(type) ?? 0) + v)
  }
  return out
}

export async function rebuildCommand(argv: string[], io: Io, bootFn: BootFn = bootFromEnv): Promise<number> {
  const args = parseArgs(argv, ['apply'])
  rejectUnknown(args, ['workspace', 'apply', 'confirm'])
  if (args.positionals.length) throw new UsageError(USAGE)
  const apply = args.flags.has('apply')
  if (apply && flagString(args, 'confirm') !== 'REBUILD') throw new UsageError('--apply re-posts every entry: add --confirm REBUILD (take a backup first: agfn backup now)')
  const only = flagString(args, 'workspace')

  const booted = await bootFn(io)
  await settleAuth(booted)
  try {
    const s = booted.services
    const engine = s.ledger as { rebuild?: (ws: string) => Promise<void> }
    if (!engine.rebuild) throw new UsageError('this server has no ledger installed')
    const db = s.db as Kysely<any>
    let q = db.selectFrom('workspaces').select(['id', 'name']).orderBy('id')
    if (only) q = q.where('id', '=', only)
    const workspaces = await q.execute()
    if (only && !workspaces.length) throw new UsageError(`no workspace ${only}`)
    if (!apply) {
      for (const w of workspaces) io.out(`  ${w.id}  ${w.name}`)
      io.out(`${workspaces.length} workspaces. Dry run: nothing changed. Run again with --apply --confirm REBUILD.`)
      return 0
    }
    let failed = 0
    let moved = 0
    for (const w of workspaces) {
      try {
        const before = await totals(db, w.id)
        await engine.rebuild(w.id)
        const after = await totals(db, w.id)
        await engine.rebuild(w.id)
        const again = await totals(db, w.id)
        const changes = diff(before, after)
        const typeChanges = diff(byType(before), byType(after))
        const notIdempotent = diff(after, again)
        if (changes.length) moved++
        const status = typeChanges.length || notIdempotent.length ? 'CHECK' : changes.length ? 'moved' : 'same'
        io.out(`${status.padEnd(6)} ${w.id}  ${w.name}`)
        for (const c of changes) io.out(`         ${c.key}: ${c.before} -> ${c.after}`)
        for (const c of typeChanges) io.out(`         TYPE TOTAL CHANGED ${c.key}: ${c.before} -> ${c.after}`)
        for (const c of notIdempotent) io.out(`         NOT IDEMPOTENT ${c.key}: ${c.before} -> ${c.after}`)
        if (status === 'CHECK') failed++
      } catch (err) {
        failed++
        io.err(`failed ${w.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    io.out(`rebuilt ${workspaces.length} workspaces: ${moved} with category moves, ${failed} to check`)
    return failed ? 1 : 0
  } finally {
    await booted.shutdown()
  }
}
