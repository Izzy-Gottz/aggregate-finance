// The scanner finds real-looking secrets in history (even after deletion), ignores documented fakes, and never prints
// a value. Every planted value is generated here at run time, so this file holds no secret-shaped literal.
import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SCRIPT = resolve(import.meta.dirname, 'secret-scan.ts')
const b62 = (n: number) => randomBytes(n * 2).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, n)
const hex = (n: number) => randomBytes(n).toString('hex').slice(0, n)

describe('secret-scan', () => {
  it('flags planted secrets by name, in history and in the tree, without printing them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agfn-scan-'))
    try {
      const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' })
      git('init', '-q')
      git('config', 'user.email', 't@example.com')
      git('config', 'user.name', 't')
      const planted = {
        stripe: `sk_${'live'}_${b62(28)}`,
        plaid: hex(30),
        resend: `re_${b62(10)}_${b62(20)}`,
        pg: `postgres://neondb_owner:${b62(16)}@ep-${hex(8)}.us-east-2.aws.neon.tech/neondb`,
        auth: randomBytes(32).toString('base64url'),
        pem: randomBytes(48).toString('base64'),
        agent: `agfn_${'live'}_${b62(28)}`,
      }
      writeFileSync(join(dir, 'config.ts'), [
        `export const stripe = '${planted.stripe}'`,
        `const agent = '${planted.agent}'`,
        `const env = { PLAID_SECRET: '${planted.plaid}', RESEND_API_KEY: '${planted.resend}' }`,
        `const url = '${planted.pg}'`,
        `AUTH_SECRET=${planted.auth}`,
        `const key = \`-----BEGIN ${'PRIVATE'} KEY-----`,
        planted.pem,
        '-----END PRIVATE KEY-----`',
      ].join('\n'))
      git('add', 'config.ts')
      git('commit', '-qm', 'oops')
      git('rm', '-q', 'config.ts') // gone from the tree, still in history
      git('commit', '-qm', 'remove')
      writeFileSync(join(dir, '.env'), 'NOTHING=1\n')
      writeFileSync(join(dir, 'ok.ts'), [
        "const local = 'postgres://postgres:postgres@localhost:5432/postgres'",
        "const aws = 'AKIAIOSFODNN7EXAMPLE'",
        "AUTH_SECRET=x".padEnd(50, 'x'),
        `const p = '-----BEGIN ${'PRIVATE'} KEY-----…'`,
        `const t = 'sk_${'live'}_ThisIsAnExampleKeyForDocs123'`,
        `const ok = '${'sk_live_' + b62(28)}' // secret-scan: ignore`,
        `const env = { JUSTWORKS_CLIENT_SECRET: SECRETS.JUSTWORKS_CLIENT_SECRET, X_TOKEN: process.env.X_TOKEN_VALUE_FROM_ENV }`,
        `const forged = 'Bearer agfn_${'live'}_${'0'.repeat(28)}'`,
      ].join('\n'))
      git('add', '.env', 'ok.ts')
      git('commit', '-qm', 'env')

      const run = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' })
      expect(run.status).toBe(1)
      const out = run.stdout
      for (const v of Object.values(planted)) expect(out).not.toContain(v.slice(8, 24))
      const lines = out.split('\n').slice(1).filter(Boolean)
      const names = new Set(lines.map((l) => l.trim().split(' · ')[0]))
      expect([...names].sort()).toEqual(
        ['.env file committed', 'Aggregate agent key', 'Plaid secret', 'Postgres URL with password', 'Resend API key', 'Stripe secret/restricted key', 'named secret (AUTH_SECRET, AGFN_MASTER_KEY, *_CLIENT_SECRET, *_API_KEY, *_TOKEN)', 'private key block'].sort(),
      )
      expect(lines.some((l) => l.includes('working tree'))).toBe(false) // nothing in ok.ts counts
      expect(lines.filter((l) => l.includes('config.ts')).every((l) => /· [0-9a-f]{12}/.test(l))).toBe(true)

      const tree = spawnSync(process.execPath, [SCRIPT, '--tree'], { cwd: dir, encoding: 'utf8' })
      expect(tree.status).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
