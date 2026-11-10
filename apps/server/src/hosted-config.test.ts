// Hosted Aggregate refuses to start with a user-protecting setting missing. "Hosted" includes a Neon database, so a
// machine started without its fly.toml [env] block (the 2026-10-11 staging incident) can't run half-configured.
import { describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { boot } from './boot.ts'
import { hostedConfigProblems, loadConfig } from './config.ts'

const NEON = 'postgres://u:p@ep-x-pooler.us-east-2.aws.neon.tech/aggregate?sslmode=require'
const FULL = {
  AUTH_SECRET: 'x'.repeat(40),
  DATABASE_URL: NEON,
  BASE_URL: 'https://app.aggregate.finance',
  SMTP_URL: 'smtp://resend:key@smtp.resend.com:465',
  MAIL_FROM: 'Aggregate <no-reply@aggregate.finance>',
  AGFN_PG_RLS_ROLE: 'agfn_app',
  FILES_S3_BUCKET: 'aggregate-files',
  // Fly sets this on every machine, which picks fly-client-ip as the client-IP header.
  FLY_APP_NAME: 'aggregate-finance',
  // Fly sets this per image too: the job release guard's id (config.ts releaseOf).
  FLY_IMAGE_REF: 'registry.fly.io/aggregate-finance:deployment-01',
}
const problems = (env: Record<string, string | undefined>) => hostedConfigProblems(env, loadConfig(env))

describe('hosted config', () => {
  it('a fully configured hosted server has no problems; self-hosted is never checked', () => {
    expect(problems(FULL)).toEqual([])
    expect(problems({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgres://u:p@localhost/agfn' })).toEqual([])
    expect(problems({ AUTH_SECRET: 'x'.repeat(40) })).toEqual([])
  })

  it('off Fly, a hosted worker refuses to start without AGFN_RELEASE: the job release guard would be off', () => {
    const offFly = { ...FULL, FLY_APP_NAME: undefined, FLY_IMAGE_REF: undefined, CLIENT_IP_HEADER: 'x-real-ip' }
    expect(problems(offFly).join()).toMatch(/AGFN_RELEASE is not set/)
    expect(problems({ ...offFly, AGFN_RELEASE: '  ' }).join()).toMatch(/AGFN_RELEASE is not set/)
    expect(problems({ ...offFly, AGFN_RELEASE: 'aws-20261110-1' })).toEqual([])
    // A web-only process claims no jobs, so it needs no release id.
    expect(hostedConfigProblems(offFly, { ...loadConfig(offFly), runWorker: false })).toEqual([])
    // On Fly nothing changes: FLY_IMAGE_REF is the release.
    expect(problems(FULL)).toEqual([])
    // Self-hosted is never checked.
    expect(problems({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgres://u:p@localhost/agfn' })).toEqual([])
  })

  it('off Fly, hosted refuses to start without CLIENT_IP_HEADER: the per-IP limits would quietly be off', () => {
    const offFly = { ...FULL, FLY_APP_NAME: undefined }
    expect(problems(offFly).join()).toMatch(/CLIENT_IP_HEADER is not set/)
    expect(problems({ ...offFly, AGFN_HOSTED: '1', DATABASE_URL: 'postgres://u:p@db.abc.us-east-1.rds.amazonaws.com/agfn' }).join()).toMatch(/CLIENT_IP_HEADER/)
    // Caddy on AWS overwrites X-Real-IP with the peer: naming it is enough.
    expect(problems({ ...offFly, CLIENT_IP_HEADER: 'x-real-ip' })).toEqual([])
    expect(loadConfig({ ...offFly, CLIENT_IP_HEADER: 'x-real-ip' }).clientIpHeader).toBe('x-real-ip')
    // On Fly nothing changes: fly-client-ip is still chosen without the setting.
    expect(loadConfig(FULL).clientIpHeader).toBe('fly-client-ip')
    // Self-hosted is still only warned at boot, never refused.
    expect(problems({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgres://u:p@localhost/agfn' })).toEqual([])
  })

  it('each missing setting is named, on a Neon database even without AGFN_HOSTED', () => {
    const without = (k: keyof typeof FULL) => problems({ ...FULL, [k]: undefined })
    expect(without('SMTP_URL').join()).toMatch(/SMTP_URL/)
    expect(without('MAIL_FROM').join()).toMatch(/MAIL_FROM/)
    expect(without('AGFN_PG_RLS_ROLE').join()).toMatch(/AGFN_PG_RLS_ROLE/)
    expect(problems({ ...FULL, AGFN_PG_RLS_ROLE: undefined, AGFN_PG_APP_URL: NEON })).toEqual([])
    expect(without('FILES_S3_BUCKET').join()).toMatch(/FILES_S3_BUCKET/)
    // Staging's explicit choice (fly.staging.toml): scratch-disk uploads, nothing else relaxed.
    expect(problems({ ...FULL, FILES_S3_BUCKET: undefined, AGFN_FILES_LOCAL: '1' })).toEqual([])
    expect(problems({ ...FULL, FILES_S3_BUCKET: undefined, MAIL_FROM: undefined, AGFN_FILES_LOCAL: '1' }).join()).toMatch(/MAIL_FROM/)
    expect(without('BASE_URL').join()).toMatch(/BASE_URL/)
    expect(problems({ ...FULL, BASE_URL: 'http://app.aggregate.finance' }).join()).toMatch(/BASE_URL/)
    // AGFN_HOSTED=1 on any database counts as hosted too.
    expect(problems({ AUTH_SECRET: 'x'.repeat(40), AGFN_HOSTED: '1' }).length).toBe(7)
  })

  it('boot refuses the incident shape: only the secrets (Neon URL), no [env] block', async () => {
    const env = { AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: NEON, SMTP_URL: FULL.SMTP_URL }
    // Never reaches the database: it refuses first.
    await expect(boot({ config: loadConfig(env), env, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }) })).rejects.toThrow(/Refusing to start[\s\S]*MAIL_FROM[\s\S]*AGFN_PG_RLS_ROLE[\s\S]*FILES_S3_BUCKET/)
  })
})

describe('AGFN_DEMO_EXTRA_CONNECTORS', () => {
  it('lets named sandbox connectors join a demo on test deployments only, never where real accounts live', async () => {
    const { demoExtraConnectors } = await import('./config.ts')
    expect(demoExtraConnectors({ AGFN_HOSTED: '1', AGFN_OFFER_TEST_CONNECTORS: '1', AGFN_DEMO_EXTRA_CONNECTORS: 'wefunder, plaid' })).toEqual(['wefunder', 'plaid'])
    expect(demoExtraConnectors({ AGFN_DEMO_EXTRA_CONNECTORS: 'wefunder' })).toEqual(['wefunder'])
    // Live (hosted, no test connectors): ignored.
    expect(demoExtraConnectors({ AGFN_HOSTED: '1', AGFN_DEMO_EXTRA_CONNECTORS: 'wefunder' })).toEqual([])
    expect(demoExtraConnectors({ AGFN_HOSTED: '1', AGFN_OFFER_TEST_CONNECTORS: '1', AGFN_DEMO_EXTRA_CONNECTORS: 'bad key!,' })).toEqual([])
  })
})
