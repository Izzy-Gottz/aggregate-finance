import type { Kysely } from 'kysely'

// challenge_activity archives each challenge player's AI activity as a JSON blob (row_json) before the nightly reset
// deletes the workspace. Rows archived before challenge/reset.ts started stripping them carry the whole activity_log
// row, including the caller's ip and user_agent — which judging never uses. Drop those two keys from any already-
// archived row. This is challenge-only data (the table is empty on every other deployment, so this is a no-op there),
// and the values can't be recovered, so it rewrites row_json in place rather than tracking which rows changed.
export async function up(db: Kysely<any>): Promise<void> {
  const rows = (await db.selectFrom('challenge_activity').select(['id', 'row_json']).execute()) as Array<{ id: string; row_json: string }>
  for (const r of rows) {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(r.row_json) as Record<string, unknown>
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object' || (!('ip' in parsed) && !('user_agent' in parsed))) continue
    delete parsed.ip
    delete parsed.user_agent
    await db.updateTable('challenge_activity').set({ row_json: JSON.stringify(parsed) }).where('id', '=', r.id).execute()
  }
}

export async function down(): Promise<void> {
  // The dropped ip/user_agent are gone for good; there is nothing to restore.
}
