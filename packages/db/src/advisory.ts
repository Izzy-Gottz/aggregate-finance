// A lock across server instances (live's blue-green switch runs two machines for a minute), for short sections that
// count something and then write it. On Postgres: a session advisory lock, taken and released on one pooled connection
// held for the section. Elsewhere (SQLite, one process) there is nothing to share, so the release is a no-op; callers
// keep their in-process lock for that case.
import { PostgresAdapter, sql, type Kysely } from 'kysely'

/** Advisory lock keys in use (one place, so two features never pick the same number). */
export const ADVISORY_KEYS = { xeroFinish: 7_302_001, finchFinish: 7_302_002, demoFillAdmit: 7_302_003 } as const

/** Takes the lock (waiting for another holder), returns its release. */
export async function advisoryLock(db: Kysely<any>, key: number): Promise<() => Promise<void>> {
  if (!(db.getExecutor().adapter instanceof PostgresAdapter)) return async () => {}
  let release!: () => void
  const released = new Promise<void>((r) => (release = r))
  let done!: Promise<void>
  await new Promise<void>((acquired, failed) => {
    done = db
      .connection()
      .execute(async (conn) => {
        await sql`select pg_advisory_lock(${key})`.execute(conn)
        acquired()
        await released
        await sql`select pg_advisory_unlock(${key})`.execute(conn)
      })
      .catch((err: unknown) => failed(err))
  })
  return async () => {
    release()
    await done
  }
}
