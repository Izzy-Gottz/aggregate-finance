// agfn keys reseal [--apply --confirm RESEAL] [--reason WHY]
// Key rotation: moves every stored secret to the current master key. Dry run by default, resumable, and it prints only
// counts and key ids. A row that fails stays on its old key and doesn't stop the rest; backups aren't touched (they age out).

import { SECRET_PURPOSE } from '@agfn/sync'
import { reseal, sealedKeyId, type EncryptionContext, type KeyRing } from '@agfn/security'
import type { Kysely } from 'kysely'
import { UsageError, flagString, parseArgs, rejectUnknown, type Io } from './io.ts'
import { operatorAccess, recordOperatorAccess } from './operator.ts'
import { bootFromEnv, settleAuth, type BootFn } from './sync.ts'

const BATCH = 200

interface Sealed {
  table: 'connections' | 'shopify_pending_installs'
  id: 'id' | 'shop'
  columns: readonly string[]
  context: (row: Record<string, string>) => EncryptionContext
}

// Every place a secret is stored with seal(). A new one belongs here, or rotation leaves it behind.
const SEALED: readonly Sealed[] = [
  { table: 'connections', id: 'id', columns: ['id', 'workspace_id', 'secret_enc'], context: (r) => ({ workspaceId: r.workspace_id as string, recordId: r.id as string, purpose: SECRET_PURPOSE }) },
  { table: 'shopify_pending_installs', id: 'shop', columns: ['shop', 'secret_enc'], context: (r) => ({ workspaceId: 'shopify-pending', recordId: r.shop as string, purpose: 'shopify_pending_install' }) },
]

interface Tally {
  perKey: Map<string, number>
  moved: number
  changed: number
  failed: number
}

async function walk(db: Kysely<any>, keys: KeyRing, t: Sealed, apply: boolean, tally: Tally): Promise<void> {
  let after: string | null = null
  for (;;) {
    let q = db.selectFrom(t.table).select([...t.columns]).where('secret_enc', 'is not', null).orderBy(t.id).limit(BATCH)
    if (after !== null) q = q.where(t.id, '>', after)
    const rows = (await q.execute()) as Array<Record<string, string>>
    if (!rows.length) return
    for (const row of rows) {
      const sealed = row.secret_enc as string
      const id = sealedKeyId(sealed) ?? 'unrecognized'
      tally.perKey.set(id, (tally.perKey.get(id) ?? 0) + 1)
      if (!apply || id === keys.current.id) continue
      try {
        const fresh = reseal(keys, sealed, t.context(row))
        // Only over the value we read: a sync that just stored a newer token wins.
        const done = await db.updateTable(t.table).set({ secret_enc: fresh }).where(t.id, '=', row[t.id] as string).where('secret_enc', '=', sealed).executeTakeFirst()
        if (done.numUpdatedRows > 0n) tally.moved++
        else tally.changed++
      } catch {
        tally.failed++
      }
    }
    after = rows[rows.length - 1]?.[t.id] as string
  }
}

export async function keysCommand(argv: string[], io: Io, bootFn: BootFn = bootFromEnv): Promise<number> {
  const args = parseArgs(argv, ['apply'])
  rejectUnknown(args, ['apply', 'confirm', 'reason'])
  if (args.positionals[0] !== 'reseal' || args.positionals.length > 1) throw new UsageError('usage: agfn keys reseal [--apply --confirm RESEAL] [--reason WHY]')
  const apply = args.flags.has('apply')
  if (apply && flagString(args, 'confirm') !== 'RESEAL') throw new UsageError('--apply needs --confirm RESEAL')
  const access = operatorAccess(args, io)

  const booted = await bootFn(io)
  await settleAuth(booted)
  try {
    const { db, keys } = booted.services
    await recordOperatorAccess(db, access, apply ? 'keys reseal --apply' : 'keys reseal')
    const tally: Tally = { perKey: new Map(), moved: 0, changed: 0, failed: 0 }
    for (const t of SEALED) await walk(db as unknown as Kysely<any>, keys, t, apply, tally)
    io.out(`current key ${keys.current.id}`)
    for (const [id, count] of [...tally.perKey].sort()) io.out(`  ${id}: ${count} row(s)${id === keys.current.id ? '' : apply ? ' before this run' : ' to move'}`)
    if (!apply) {
      io.out('Dry run: nothing changed. Add --apply --confirm RESEAL to move them.')
      return 0
    }
    io.out(`moved ${tally.moved}, changed by a sync meanwhile ${tally.changed}, failed ${tally.failed}`)
    if (tally.failed || tally.changed) io.out('Run it again: it only touches what is left.')
    return tally.failed ? 1 : 0
  } finally {
    await booted.shutdown()
  }
}
