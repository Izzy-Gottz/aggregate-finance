import { describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { boot } from './boot.ts'
import { loadConfig } from './config.ts'

describe('AGFN_REQUIRE_SMTP', () => {
  const env = { AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: 'https://app.example.test', WEB_DIST: '/nonexistent' }
  const keys = () => loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() })

  it('refuses to boot without SMTP_URL, so sign-in links never fall back to the log', async () => {
    const config = { ...loadConfig(env), runWorker: false }
    await expect(boot({ config, keys: keys(), env: { ...env, AGFN_REQUIRE_SMTP: '1' } })).rejects.toThrow(/SMTP_URL is required/)
  })

  it('boots when it is unset (self-hosted and staging keep the console fallback)', async () => {
    const config = { ...loadConfig(env), runWorker: false }
    const booted = await boot({ config, keys: keys(), env })
    await booted.shutdown()
  })
})
