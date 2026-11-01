import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { SqliteDialect, type SqliteDatabase, type SqliteStatement } from 'kysely'

/**
 * Adapts Node's built-in node:sqlite to the better-sqlite3-shaped interface Kysely's SqliteDialect expects.
 * No native addon to compile, which keeps the self-host Docker image small and installs reliable.
 */
function wrap(db: DatabaseSync): SqliteDatabase {
  return {
    close: () => db.close(),
    prepare(sql: string): SqliteStatement {
      const stmt = db.prepare(sql)
      stmt.setReadBigInts(false)
      const reader = stmt.columns().length > 0
      return {
        reader,
        all: (params: ReadonlyArray<unknown>) => stmt.all(...(params as SQLInputValue[])) as unknown[],
        run: (params: ReadonlyArray<unknown>) => {
          const r = stmt.run(...(params as SQLInputValue[]))
          return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }
        },
        iterate: (params: ReadonlyArray<unknown>) =>
          stmt.iterate(...(params as SQLInputValue[])) as IterableIterator<unknown>,
      }
    },
  }
}

export function openSqlite(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA synchronous = NORMAL')
  return db
}

export function nodeSqliteDialect(path: string): SqliteDialect {
  return new SqliteDialect({ database: () => Promise.resolve(wrap(openSqlite(path))) })
}
