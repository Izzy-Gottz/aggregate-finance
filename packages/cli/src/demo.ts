// agfn demo --email you@example.com [--days 365] [--leave]
//          [--profiles harbor,personal] [--seed S] [--start YYYY-MM-DD] [--glass YYYY-MM-DD]   (benchmark and Glass runs)
// Builds (or refreshes) the demo workspace for someone who has signed in once, syncing it in this process so it's
// ready to click around and to connect an AI to. --leave removes it from their account.

import type { Kysely } from 'kysely'
import type { LedgerEngine } from '@agfn/core'
import { createDemoWorkspace, leaveDemoWorkspace } from '@agfn/demo'
import { PROFILE_KEYS, type ProfileKey } from '@agfn/demo'
import { equityFor } from '@agfn/server/equity'
import { demoDocuments } from '@agfn/server/reviewer'
import { deleteIfMemberless, workspacesOf } from '@agfn/server/orphans'
import { UsageError, flagString, parseArgs, rejectUnknown, type Io } from './io.ts'
import { bootFromEnv, settleAuth, type BootFn } from './sync.ts'

export async function demoCommand(argv: string[], io: Io, bootFn: BootFn = bootFromEnv): Promise<number> {
  const args = parseArgs(argv, ['leave'])
  rejectUnknown(args, ['email', 'leave', 'days', 'profiles', 'seed', 'start', 'glass'])
  const daysFlag = flagString(args, 'days')
  const historyDays = daysFlag === undefined ? undefined : Number(daysFlag)
  if (historyDays !== undefined && !(Number.isInteger(historyDays) && historyDays >= 7 && historyDays <= 365)) throw new UsageError('--days must be a whole number from 7 to 365')
  const day = (name: string) => {
    const v = flagString(args, name)
    if (v !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new UsageError(`--${name} must be a date like 2024-10-01`)
    return v
  }
  const start = day('start')
  const glass = day('glass')
  const seed = flagString(args, 'seed')
  const profilesFlag = flagString(args, 'profiles')
  const profiles = profilesFlag?.split(',').map((p) => p.trim()).filter(Boolean)
  if (profiles && (!profiles.length || profiles.some((p) => !(PROFILE_KEYS as readonly string[]).includes(p)) || !profiles.some((p) => p !== 'personal'))) {
    throw new UsageError(`--profiles takes at least one company from ${PROFILE_KEYS.join(', ')}`)
  }
  const email = flagString(args, 'email')?.trim().toLowerCase()
  if (!email) throw new UsageError('usage: agfn demo --email you@example.com [--leave]   (sign in once first)')

  const booted = await bootFn(io)
  await settleAuth(booted)
  try {
    const s = booted.services
    const db = s.db as unknown as Kysely<{ people: { id: string; email: string } }>
    const person = await db.selectFrom('people').select('id').where('email', '=', email).executeTakeFirst()
    if (!person) throw new UsageError(`no one has signed in as ${email} yet. Open the app, sign in once, then run this again.`)
    if (args.flags.has('leave')) {
      const mine = await workspacesOf(s.db, person.id)
      if (!(await leaveDemoWorkspace(s.db, person.id))) {
        io.out('no demo workspace to leave')
        return 0
      }
      await deleteIfMemberless({ db: s.db, files: s.files, sync: s.sync }, mine)
      io.out('left the demo workspace')
      return 0
    }
    const ledger = s.ledger as Partial<Pick<LedgerEngine, 'createBucket' | 'createRule'>>
    const started = Date.now()
    const demo = await createDemoWorkspace(
      {
        db: s.db,
        keys: s.keys,
        sync: s.sync,
        extras: { ...(ledger.createBucket && ledger.createRule ? { buckets: s.ledger as unknown as Pick<LedgerEngine, 'createBucket' | 'createRule'> } : {}), equity: equityFor(s), documents: demoDocuments(s) },
      },
      { personId: person.id, ...(historyDays ? { historyDays } : {}), ...(start ? { start } : {}), ...(glass ? { glass } : {}), ...(seed ? { seed } : {}), ...(profiles ? { profiles: profiles as ProfileKey[] } : {}) },
    )
    if (!demo.created) for (const id of demo.connections) await s.sync.sync(id)
    io.out(`${demo.created ? 'created' : 'refreshed'} the demo workspace (${demo.entities.map((e) => e.name).join(', ')}) in ${((Date.now() - started) / 1000).toFixed(0)}s`)
    io.out('open the app to look around, or connect your AI: agfn mcp --print-config --url <your server>/mcp')
    return 0
  } finally {
    await booted.shutdown()
  }
}
