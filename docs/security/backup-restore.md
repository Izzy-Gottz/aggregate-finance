# Backups and restoring them

Aggregate keeps two independent copies of your data:

1. **Your database provider's own recovery.** Neon's point-in-time history is 7 days on hosted Aggregate; a SQLite
   install can run Litestream or copy `DATA_DIR`. This is the fastest way back from "I deleted the wrong thing an hour ago".
2. **Aggregate's nightly encrypted backup** to a separate bucket (`BACKUP_S3_*`, set up in
   [self-hosting](../self-hosting.md#nightly-encrypted-off-site-backup-built-in)). One file per night, 25 days kept. It
   holds the whole database **and every document file** (receipts, statements), gzipped and then encrypted with your
   master key. It is the copy that survives losing the provider, the account or the server. It is written as a
   stream (a page of rows at a time, uploaded in parts), so making it needs little memory however large the database
   is; restoring reads the whole file, so restore on a machine with memory to spare.

## The master key is the backup

Each backup is encrypted with `AGFN_MASTER_KEY` (AES-256-GCM, a fresh data key per backup). The key is never inside
a backup, by design: the bucket alone is unreadable.

**If the master key is lost, every backup is unreadable, and so are the bank and app connection secrets inside it.
Nobody, including us, can recover them.** So:

- Keep a copy of the master key outside the server: hosted Aggregate keeps one in Apple Passwords (owner only) and one
  in Fly secrets. A self-hoster should use their password manager or KMS (see
  [self-hosting](../self-hosting.md#keeping-the-master-key-in-a-kms-or-password-manager)).
- After rotating the key, keep the old one in `AGFN_OLD_MASTER_KEYS` until the last backup made with it is older than
  25 days.
- Test that the copy you keep is the right one: the drill below fails at step 3 if it isn't.

## Restore drill (before launch, then once a year, and after any key change)

Takes about 15 minutes. Use a scratch database, never production.

1. **List backups:** `agfn backup list`, then pick the newest.
2. **Make an empty target.**
   - Postgres: create a Neon branch with no data (or any empty database), then run
     `DATABASE_URL=<empty> agfn migrate`. It must be the same Aggregate version as the backup, or the restore refuses.
   - SQLite: an empty directory for the new `DATA_DIR`.
3. **Restore**, with the master key you keep outside the server in `AGFN_MASTER_KEY`:
   - Postgres: `DATABASE_URL=<empty> agfn backup restore backups/agfn-postgres-….agfnbak`
   - SQLite: `DATA_DIR=/tmp/restore-test agfn backup restore backups/agfn-sqlite-….agfnbak` (the database and the
     document files both land in that directory)

   It shows what it will restore and where, then asks you to type `restore` (`--yes` skips the question in scripts).

   **An older backup needs the Aggregate version that made it.** Migrations are applied by name, so if a migration was
   added since the backup, the restore refuses and names the difference. Then: check out the release that made the
   backup (the last one deployed before its timestamp), `agfn migrate` and restore with it, and afterwards run
   `agfn migrate` with the current version to bring the database up to date.
   It refuses a database that already has workspaces, and refuses to overwrite an existing file. Document files go to
   the file storage this environment points at (`FILES_S3_*` or `DATA_DIR/files`). They are stored by content hash, so
   files already there are left alone.
4. **Start a second server** on the restored database (another port; for SQLite `DATA_DIR=/tmp/restore-test`), with
   `BACKUP_S3_*` unset so it doesn't upload backups of its own into the production bucket, and sign in. Check:
   - the companies, cash and last month's profit and loss match production;
   - the latest transactions are there;
   - a receipt opens;
   - a connection still syncs, which proves its encrypted bank token came back intact and opens with this key.
5. **Write it down:** date, backup name, time taken, anything that went wrong. Then delete the scratch database or
   file and the restored files.

## What the automated drill proves

`apps/server/src/restore-drill.test.ts` runs this on every merge, for Postgres and for SQLite. It fills a demo
workspace (three companies, a year of bank history, invoices, payroll, a cap table, a receipt), backs it up, and
restores into a fresh database and an empty file store. Then it checks:

- cash, net cash and a year of profit and loss per company match;
- the connections match, and their bank secrets open with the same master key;
- the receipt comes back byte for byte;
- a different master key opens neither the backup nor a restored secret;
- a second restore into the now non-empty database is refused.

A green test is no substitute for doing step 3 by hand with the key copy you actually keep: the test can't know
whether that copy is right.

## Drill log

| Date | Backup | Where | Result | Time |
| --- | --- | --- | --- | --- |
| 2026-10-11 | `agfn-postgres-2026-10-11T161920Z` (hosted, 63 tables, 80,567 rows, no documents yet) | Neon branch `restore-drill-2026-10-11`, empty database, restored from a laptop with the kept master key; no files bucket, no mail, no worker | Passed after two fixes (below). Counts match production as of the backup; all 14 sealed connection secrets open with the kept key; an existing account signs in and lands in its workspace; 20 OAuth clients, 7 AI grants and 2 reviewer links back | 63 s end to end: 7 s schema at the backup's version, 54 s restore, 2 s upgrade to the current version |
| 2026-11-03 | Neon point-in-time snapshot of production, 10:48 UTC (not the nightly file) | New Neon branch from the snapshot, never made primary; deleted with the snapshot afterwards | Passed. All 86 tables present; row counts for workspaces, people, companies, connections, accounts, ledger and raw records, AI grants and write requests match production exactly; the removed `agfn_inspect` role is absent | About 1 minute from snapshot to readable branch |
| 2026-11-03 | `agfn-postgres-2026-11-03T070001Z` (nightly, made by the live release) | Planned: the same branch, from a throwaway machine with the kept master key | Not completed. The backup was found and listed, but the only way to set the branch's database password prints it, which our rules forbid. Next try: a separate scratch database or the provider API. The last full restore of a nightly file is still 2026-10-11 | |

Found by the 2026-10-11 drill, both fixed:
- OAuth clients, consents and refresh tokens didn't restore: their json columns hold arrays, and the Postgres driver
  sent those as Postgres array literals. Restore now writes json/jsonb values as JSON text. (The automated drill runs
  on PGlite, which doesn't show this, so it only surfaced against Neon.)
- A backup older than the newest migration was refused with a message naming the same migration on both sides. It now
  lists the migrations that differ and says how to restore (the step 3 note above).

## Not covered by the nightly backup

- The master key itself (see above).
- Server configuration and secrets (Fly secrets, `.env`): keep those in your password manager.
- Data exports people downloaded: they're temporary, so make them again.
