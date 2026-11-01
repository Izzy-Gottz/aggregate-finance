import { readdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import type { Kysely } from 'kysely'
import { Migrator, type Migration, type MigrationProvider, type MigrationResultSet } from 'kysely/migration'

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url))

/** The migrations folder: AGFN_MIGRATIONS_DIR when set (the npm package ships them compiled next to its bundle). */
export function migrationsDir(): string {
  return process.env.AGFN_MIGRATIONS_DIR || MIGRATIONS_DIR
}

/**
 * Loads every NNNN_name.ts file in the migrations folder (or NNNN_name.mjs, as the npm package ships them). All
 * slices add files here in their own number range.
 */
class FolderProvider implements MigrationProvider {
  private dir: string
  constructor(dir: string) {
    this.dir = dir
  }
  async getMigrations(): Promise<Record<string, Migration>> {
    const files = (await readdir(this.dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.(ts|mjs)$/.test(f)).sort()
    const out: Record<string, Migration> = {}
    for (const f of files) {
      const name = f.replace(/\.(ts|mjs)$/, '')
      if (out[name]) continue
      const mod = (await import(pathToFileURL(join(this.dir, f)).href)) as Migration
      out[name] = { up: mod.up, down: mod.down }
    }
    return out
  }
}

export async function migrateToLatest(db: Kysely<any>, dir: string = migrationsDir()): Promise<MigrationResultSet> {
  // Slices merge at different times, so a lower-numbered file can arrive after a higher one already ran.
  const migrator = new Migrator({ db, provider: new FolderProvider(dir), allowUnorderedMigrations: true })
  const result = await migrator.migrateToLatest()
  if (result.error) throw result.error
  return result
}
