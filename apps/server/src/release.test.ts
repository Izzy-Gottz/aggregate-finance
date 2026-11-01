import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { connect, type CoreTables } from '@agfn/db'
import { generateMasterKey } from '@agfn/security'
import { release } from './release.ts'

describe('release step', () => {
  it('migrates everything (ours and the auth tables) and exits; running it again is a no-op', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agfn-release-'))
    const env = { AUTH_SECRET: 'x'.repeat(40), AGFN_MASTER_KEY: generateMasterKey(), DATABASE_URL: `sqlite:${join(dir, 'db.sqlite')}`, BASE_URL: 'https://app.example.com', WEB_DIST: '/nonexistent', DATA_DIR: dir }
    try {
      await release(env)
      await release(env)
      const h = connect<CoreTables>(env.DATABASE_URL)
      const tables = (await h.db.introspection.getTables()).map((t) => t.name)
      await h.close()
      expect(tables).toEqual(expect.arrayContaining(['workspaces', 'auth_user', 'grants', 'usage_daily', 'oauth_pending_grants']))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
