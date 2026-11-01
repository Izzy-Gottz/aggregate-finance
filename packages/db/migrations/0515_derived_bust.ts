import type { Kysely } from 'kysely'

// Once: drop every stored derived result (overview, checks, review, coverage, open). Before 2ce03abb a ledger
// transaction could compute one from its own unfinished writes (the demo tidy, mid-way) and store it under the version
// it then committed, so a stored result could disagree with the books until the next write. It is only a cache: the
// next read recomputes it.

export async function up(db: Kysely<any>): Promise<void> {
  await db.deleteFrom('ledger_derived').execute()
}

export async function down(): Promise<void> {}
