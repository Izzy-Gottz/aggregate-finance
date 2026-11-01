// agfn backup now | list | restore <key> [--to FILE] [--yes]
// Off-site encrypted backups (BACKUP_S3_*). Restore drill: docs/security/backup-restore.md.

import { rmSync } from 'node:fs'
import { createBackup, readBackup, restoreFiles, restorePostgres, restoreSqliteFile } from '@agfn/server/backup'
import { UsageError, parseArgs, rejectUnknown, type Io } from './io.ts'
import { bootFromEnv, settleAuth, type BootFn } from './sync.ts'

const USAGE = 'usage: agfn backup now | agfn backup list | agfn backup restore <key> [--to FILE] [--yes]'

export async function backupCommand(argv: string[], io: Io, bootFn: BootFn = bootFromEnv): Promise<number> {
  const args = parseArgs(argv)
  rejectUnknown(args, ['to', 'yes'])
  const [sub, key, ...extra] = args.positionals
  if (!sub || extra.length || (sub === 'restore') !== Boolean(key) || !['now', 'list', 'restore'].includes(sub)) throw new UsageError(USAGE)
  const booted = await bootFn(io)
  await settleAuth(booted)
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await booted.shutdown()
  }
  try {
    const target = booted.services.backupTarget
    if (!target) throw new UsageError('backups are off: set BACKUP_S3_BUCKET, BACKUP_S3_ENDPOINT, BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY')
    const { db, keys } = booted.services
    if (sub === 'now') {
      const r = await createBackup({ db, kind: booted.handle.kind, keys, target, files: booted.services.files })
      io.out(`uploaded ${r.key} (${(r.bytes / 1_048_576).toFixed(1)} MB${r.tables ? `, ${r.tables} tables, ${r.rows} rows` : ''}, ${r.files} document file(s)); removed ${r.pruned} older than 25 days`)
      return 0
    }
    if (sub === 'list') {
      const all = (await target.list('backups/')).filter((o) => o.key.endsWith('.agfnbak')).sort((a, b) => a.key.localeCompare(b.key))
      if (!all.length) io.out('no backups yet')
      for (const o of all) io.out(o.key)
      return 0
    }
    const backup = await readBackup(keys, target, key!)
    const flagTo = args.flags.get('to')
    // SQLite without --to: the configured database, but only while it holds nothing (a fresh DATA_DIR, where this
    // command itself just created it). Anything with a workspace in it is never overwritten.
    const configured = booted.services.config.databaseUrl.replace(/^sqlite:/, '')
    let to = typeof flagTo === 'string' ? flagTo : undefined
    let replace = false
    if (backup.header.kind === 'sqlite' && !to) {
      const { n } = await db.selectFrom('workspaces').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()
      if (Number(n) > 0) throw new UsageError(`${configured} already holds data; restore into a new file with --to /path/new.db, or point DATA_DIR at an empty directory`)
      to = configured
      replace = true
    }
    const into = backup.header.kind === 'sqlite' ? (replace ? `the empty database at ${to}` : `the new file ${to}`) : `the database at ${redactUrl(io.env.DATABASE_URL)}`
    const tables = backup.header.tables ? Object.keys(backup.header.tables).length : 0
    io.out(`${key}: made ${backup.header.createdAt}${tables ? `, ${tables} tables` : ''}, ${backup.files.length} document file(s). Restoring into ${into}.`)
    if (!args.flags.has('yes')) {
      if (!io.ask) throw new UsageError('nobody is at a terminal to confirm: add --yes to restore')
      if ((await io.ask('Type "restore" to continue: ')).trim() !== 'restore') {
        io.out('cancelled; nothing changed')
        return 1
      }
    }
    // Document files go to this server's file storage (DATA_DIR/files, or FILES_S3_*).
    const f = await restoreFiles(booted.services.files, backup.files)
    if (backup.header.kind === 'sqlite') {
      if (replace) {
        // The empty database this command opened: close it, then the backup takes its place.
        await close()
        for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${to}${suffix}`, { force: true })
      }
      restoreSqliteFile(backup, to!)
    } else {
      const r = await restorePostgres(db, backup)
      io.out(`database: ${r.tables} tables, ${r.rows} rows`)
    }
    io.out(`documents: ${f.written} file(s) written, ${f.present} already there`)
    if (backup.header.kind !== 'sqlite') io.out('restored. Start the server on this DATABASE_URL and sign in.')
    else if (replace) io.out('restored. Start the server with this DATA_DIR and sign in.')
    else io.out(`restored. Start the server with DATABASE_URL=sqlite:${to}${booted.services.config.databaseUrl.startsWith('sqlite:') ? ` and DATA_DIR=${booted.services.config.dataDir} (where the document files went)` : ''}.`)
    return 0
  } finally {
    await close()
  }
}

/** postgres://user:password@host/db → postgres://user:…@host/db (never print a password). */
function redactUrl(url: string | undefined): string {
  if (!url) return '(DATABASE_URL not set)'
  return url.replace(/(\/\/[^:/@]+):[^@]*@/, '$1:…@')
}
