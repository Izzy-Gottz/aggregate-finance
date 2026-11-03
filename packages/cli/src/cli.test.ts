import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { fillTemplate, mcpCommand, parseArgs, run, type Io } from './index.ts'

const dirs: string[] = []
afterEach(() => {
  dirs.length = 0
})

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'agfn-cli-'))
  dirs.push(d)
  return d
}

function io(cwd: string, env: NodeJS.ProcessEnv = {}): Io & { lines: string[]; errors: string[] } {
  const lines: string[] = []
  const errors: string[] = []
  return { env, cwd, lines, errors, out: (l) => void lines.push(l), err: (l) => void errors.push(l) }
}

const envOf = (dir: string) => parseEnv(readFileSync(join(dir, '.env'), 'utf8')) as Record<string, string>

describe('args', () => {
  it('parses flags, values and positionals', () => {
    const a = parseArgs(['sync', 'c1', '--all', '--url=https://x', '--dir', 'd', '--', '--raw'], ['all'])
    expect(a.positionals).toEqual(['sync', 'c1', '--raw'])
    expect(a.flags.get('all')).toBe(true)
    expect(a.flags.get('url')).toBe('https://x')
    expect(a.flags.get('dir')).toBe('d')
  })
})

describe('agfn init', () => {
  it('writes a private .env with fresh secrets and migrates the database', async () => {
    const d = tmp()
    const t = io(d)
    expect(await run(['init'], t)).toBe(0)
    expect(statSync(join(d, '.env')).mode & 0o777).toBe(0o600)
    const env = envOf(d)
    expect(env.AUTH_SECRET?.length).toBeGreaterThanOrEqual(32)
    expect(Buffer.from(env.AGFN_MASTER_KEY ?? '', 'base64')).toHaveLength(32)
    expect(t.lines.join('\n')).toMatch(/applied \d+ migrations? \(0001_core/)
    expect(t.lines.join('\n')).not.toContain(env.AUTH_SECRET)
    expect(t.lines.join('\n')).not.toContain(env.AGFN_MASTER_KEY)
    expect(existsSync(join(d, 'data', 'agfn.db'))).toBe(true)
  })

  it('refuses to overwrite, and --force keeps a backup with new secrets', async () => {
    const d = tmp()
    expect(await run(['init', '--no-migrate'], io(d))).toBe(0)
    const first = envOf(d)
    const t = io(d)
    expect(await run(['init', '--no-migrate'], t)).toBe(2)
    expect(t.errors[0]).toMatch(/already exists/)
    expect(await run(['init', '--no-migrate', '--force', '--base-url', 'https://app.example.com/'], io(d))).toBe(0)
    const second = envOf(d)
    expect(second.AGFN_MASTER_KEY).not.toBe(first.AGFN_MASTER_KEY)
    expect(second.BASE_URL).toBe('https://app.example.com')
    expect(readdirSync(d).some((f) => f.startsWith('.env.bak-'))).toBe(true)
  })

  it('uses .env.example when present and only fills empty or commented keys', () => {
    const out = fillTemplate('A=1\nAUTH_SECRET=\n# AGFN_MASTER_KEY=\n# PLAID_SECRET=\n', { AUTH_SECRET: 's', AGFN_MASTER_KEY: 'k', A: 'x', NEW: 'n' })
    expect(out).toBe('A=1\nAUTH_SECRET=s\nAGFN_MASTER_KEY=k\n# PLAID_SECRET=\nNEW=n\n')
  })

  it('rejects unknown options and bad URLs', async () => {
    const d = tmp()
    expect(await run(['init', '--nope'], io(d))).toBe(2)
    expect(await run(['init', '--base-url', 'not a url'], io(d))).toBe(2)
  })
})

describe('agfn doctor', () => {
  it('passes on a fresh init and reports what is off', async () => {
    const d = tmp()
    await run(['init'], io(d))
    const t = io(d, { ...envOf(d) })
    expect(await run(['doctor'], t)).toBe(0)
    const text = t.lines.join('\n')
    expect(text).toMatch(/✓ master key/)
    expect(text).toMatch(/✓ migrations/)
    expect(text).toMatch(/! plaid/)
    expect(text).not.toContain(envOf(d).AGFN_MASTER_KEY)
  })

  it('fails when more than one master key source is set, without printing either', async () => {
    const d = tmp()
    const key = randomBytes(32).toString('base64')
    const t = io(d, { AUTH_SECRET: 'x'.repeat(40), AGFN_MASTER_KEY: key, AGFN_MASTER_KEY_FILE: join(d, 'master.key') })
    expect(await run(['doctor'], t)).toBe(1)
    const text = t.lines.join('\n')
    expect(text).toMatch(/✗ master key.*only one master key source/)
    expect(text).not.toContain(key)
  })

  it('fails without secrets and with pending migrations', async () => {
    const d = tmp()
    const t = io(d, { AUTH_SECRET: 'short' })
    expect(await run(['doctor'], t)).toBe(1)
    const text = t.lines.join('\n')
    expect(text).toMatch(/✗ AUTH_SECRET/)
    expect(text).toMatch(/✗ master key/)
    expect(text).toMatch(/✗ migrations .* pending/)
  })

  it('--online checks Plaid keys with one read call', async () => {
    const d = tmp()
    await run(['init'], io(d))
    const calls: string[] = []
    const { doctorCommand } = await import('./doctor.ts')
    const t = io(d, { ...envOf(d), PLAID_CLIENT_ID: 'cid', PLAID_SECRET: 'bad', PLAID_ENV: 'sandbox' })
    const code = await doctorCommand(['--online'], t, {
      fetch: async (url) => {
        calls.push(new URL(url).pathname)
        return new Response(JSON.stringify({ error_type: 'INVALID_INPUT', error_code: 'INVALID_API_KEYS', error_message: 'invalid client_id or secret provided' }), { status: 400 })
      },
    })
    expect(code).toBe(1)
    expect(calls).toEqual(['/institutions/get_by_id'])
    expect(t.lines.join('\n')).toMatch(/✗ plaid keys .*rejected/)
    expect(t.lines.join('\n')).not.toContain('bad')
  })
})

describe('agfn mcp', () => {
  const bridged: Array<{ url: string; key: string }> = []
  const deps = { bridge: async (o: { url: string; key: string }) => void bridged.push(o) }
  const key = 'agfn_live_' + 'a'.repeat(43)

  it('never accepts the key on the command line', async () => {
    const t = io(tmp())
    await expect(mcpCommand(['--url', 'https://x.example/mcp', '--key', key], t, deps)).rejects.toThrow(/command line/)
    await expect(mcpCommand(['--url', 'https://x.example/mcp', '--key', 'k'], t, deps)).rejects.toThrow(/--key is not supported/)
    await expect(mcpCommand(['--url', 'https://x.example/mcp', key], t, deps)).rejects.toThrow(/command line/)
  })

  it('reads AGFN_KEY or a private --key-file, validates shape and URL', async () => {
    const d = tmp()
    const { looksLikeAgentKey } = await import('@agfn/mcp')
    expect(looksLikeAgentKey(key)).toBe(true)
    await mcpCommand(['--url', 'https://x.example/mcp'], io(d, { AGFN_KEY: key }), deps)
    expect(bridged.at(-1)).toEqual({ url: 'https://x.example/mcp', key })
    writeFileSync(join(d, 'k'), key + '\n', { mode: 0o600 })
    await mcpCommand(['--url', 'http://localhost:8787/mcp', '--key-file', 'k'], io(d), deps)
    expect(bridged.at(-1)?.key).toBe(key)
    chmodSync(join(d, 'k'), 0o644)
    await expect(mcpCommand(['--url', 'https://x.example/mcp', '--key-file', 'k'], io(d), deps)).rejects.toThrow(/readable by other users/)
    await expect(mcpCommand(['--url', 'http://x.example/mcp'], io(d, { AGFN_KEY: key }), deps)).rejects.toThrow(/https/)
    await expect(mcpCommand(['--url', 'https://x.example/mcp'], io(d, { AGFN_KEY: 'nope' }), deps)).rejects.toThrow(/agent key/)
    const noKey = mcpCommand(['--url', 'https://x.example/mcp'], io(d), deps)
    await expect(noKey).rejects.toThrow(/usage/)
    await expect(noKey).rejects.toThrow('https://app.aggregate.finance/mcp as a connector')
    await expect(noKey).rejects.toThrow('npx aggregate-finance setup')
    await expect(mcpCommand([], io(d), deps)).rejects.toThrow('as a connector')
  })

  it('prints a client config snippet without a real key', async () => {
    const t = io(tmp())
    expect(await run(['mcp', '--print-config', '--url', 'https://app.aggregate.finance/mcp'], t)).toBe(0)
    // Absolute paths (the CLI isn't on PATH): this Node, and this checkout's CLI entry.
    const main = new URL('./main.ts', import.meta.url).pathname
    expect(JSON.parse(t.lines.join('\n'))).toEqual({
      mcpServers: { aggregate: { command: process.execPath, args: [main, 'mcp', '--url', 'https://app.aggregate.finance/mcp'], env: { AGFN_KEY: 'agfn_live_…' } } },
    })
  })
})

describe('agfn sync', () => {
  it('boots like the server and reports an unknown connection as a failure', async () => {
    const d = tmp()
    await run(['init'], io(d))
    const env = { ...envOf(d), DATABASE_URL: `sqlite:${join(d, 'data', 'agfn.db')}`, DATA_DIR: join(d, 'data') }
    const t = io(d, env)
    expect(await run(['sync', 'conn_missing'], t)).toBe(1)
    expect(t.errors.join('\n')).toMatch(/conn_missing: error .*connection not found/)
    const t2 = io(d, env)
    expect(await run(['sync', '--all'], t2)).toBe(0)
    expect(t2.lines).toContain('no connections to sync')
  })

  it('validates usage', async () => {
    const t = io(tmp())
    expect(await run(['sync'], t)).toBe(2)
    expect(await run(['sync', 'a', '--all'], t)).toBe(2)
    expect(await run(['bogus'], t)).toBe(2)
  })
})

describe('agfn demo', () => {
  it('fills a demo workspace for someone who signed in, refreshes it, and can leave it', async () => {
    const d = tmp()
    await run(['init'], io(d))
    const env = { ...envOf(d), DATABASE_URL: `sqlite:${join(d, 'data', 'agfn.db')}`, DATA_DIR: join(d, 'data') }
    const t0 = io(d, env)
    expect(await run(['demo', '--email', 'nobody@example.com', '--days', '30'], t0)).toBe(2)
    expect(t0.errors.join('\n')).toMatch(/signed in/)

    const { connect } = await import('@agfn/db')
    const h = connect(env.DATABASE_URL)
    await (h.db as never as import('kysely').Kysely<{ people: { id: string; auth_user_id: string | null; name: string; email: string; created_at: string } }>)
      .insertInto('people')
      .values({ id: 'p_demo', auth_user_id: null, name: 'Demo', email: 'demo@example.com', created_at: new Date().toISOString() })
      .execute()
    await h.close()

    const t = io(d, env)
    expect(await run(['demo', '--email', 'Demo@Example.com', '--days', '30'], t)).toBe(0)
    expect(t.lines.join('\n')).toMatch(/created the demo workspace \(Northwind Labs, Bluebird Studio, Harbor Coffee, Personal\)/)
    const t2 = io(d, env)
    expect(await run(['demo', '--email', 'demo@example.com'], t2)).toBe(0)
    expect(t2.lines.join('\n')).toMatch(/refreshed/)
    // ledger-rebuild on the demo books: dry run lists, apply re-posts with type totals unchanged and a no-op second pass.
    const r0 = io(d, env)
    expect(await run(['ledger-rebuild'], r0)).toBe(0)
    expect(r0.lines.join('\n')).toMatch(/Dry run: nothing changed/)
    expect(await run(['ledger-rebuild', '--apply'], io(d, env))).toBe(2)
    const r1 = io(d, env)
    expect(await run(['ledger-rebuild', '--apply', '--confirm', 'REBUILD'], r1)).toBe(0)
    expect(r1.lines.join('\n')).toMatch(/rebuilt 1 workspaces: \d+ with category moves, 0 to check/)
    expect(r1.lines.join('\n')).not.toMatch(/TYPE TOTAL CHANGED|NOT IDEMPOTENT/)
    const t3 = io(d, env)
    expect(await run(['demo', '--email', 'demo@example.com', '--leave'], t3)).toBe(0)
    expect(t3.lines).toContain('left the demo workspace')
    expect(await run(['demo', '--email', 'demo@example.com', '--days', '3'], io(d, env))).toBe(2)
  }, 300_000)
})

describe('agfn grant', () => {
  it('validates usage and says when an email owns no workspace', async () => {
    const d = tmp()
    await run(['init'], io(d))
    const env = { ...envOf(d), DATABASE_URL: `sqlite:${join(d, 'data', 'agfn.db')}`, DATA_DIR: join(d, 'data') }
    expect(await run(['grant'], io(d, env))).toBe(2)
    expect(await run(['grant', 'free', '--months', '12', '--reason', 'yc'], io(d, env))).toBe(2)
    expect(await run(['grant', 'free', '--workspace', 'a@b.co', '--months', 'twelve', '--reason', 'yc'], io(d, env))).toBe(2)
    const t = io(d, env)
    expect(await run(['grant', 'free', '--workspace', 'founder@example.com', '--months', '12', '--reason', 'yc'], t)).toBe(2)
    expect(t.errors.join('\n')).toMatch(/owns no workspace/)
  }, 120_000)
})

describe('doctor connector checks', () => {
  it('does not flag built-in sources (uploads, added by hand, cap table) as missing connectors', async () => {
    const { connectorChecks } = await import('./doctor.ts')
    const checks = connectorChecks({}, ['manual', 'equity', 'files'])
    expect(checks.filter((c) => c.status === 'fail')).toEqual([])
    expect(connectorChecks({}, ['quickbooks-unknown']).some((c) => c.status === 'fail')).toBe(true)
  })

  it('says what to set for app-based connectors that aren’t set up, with the redirect URI to register', async () => {
    const { connectorChecks } = await import('./doctor.ts')
    const checks = connectorChecks({ BASE_URL: 'https://books.example.com' }, [])
    expect(checks.find((c) => c.name === 'plaid')).toMatchObject({ status: 'warn', detail: expect.stringContaining('PLAID_CLIENT_ID') })
    expect(checks.find((c) => c.name === 'quickbooks')?.detail).toContain('https://books.example.com/api/connectors/quickbooks/callback')
    // Sandbox keys don't need the redirect URI; production without it warns.
    expect(checks.find((c) => c.name === 'plaid')?.detail).not.toMatch(/set [^;]*PLAID_LINK_REDIRECT_URI/)
    expect(connectorChecks({ PLAID_CLIENT_ID: 'c', PLAID_SECRET: 's', PLAID_ENV: 'sandbox' }, []).some((c) => c.name === 'plaid')).toBe(false)
    expect(connectorChecks({ PLAID_CLIENT_ID: 'c', PLAID_SECRET: 's', PLAID_ENV: 'production', BASE_URL: 'https://books.example.com' }, []).find((c) => c.name === 'plaid')).toMatchObject({ status: 'warn', detail: expect.stringContaining('https://books.example.com/connect/plaid/oauth') })
    // Optional and not set up is neither a pass nor a problem.
    expect(checks.find((c) => c.name === 'quickbooks')?.status).toBe('off')
  })

  it.skipIf(process.platform === 'win32')('warns when DATA_DIR can be read by other users', async () => {
    const { dataDirCheck } = await import('./doctor.ts')
    const { chmodSync, mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const d = mkdtempSync(join(tmpdir(), 'agfn-perm-'))
    try {
      chmodSync(d, 0o755)
      expect(dataDirCheck(d)[0]).toMatchObject({ status: 'warn', detail: expect.stringContaining('chmod -R go-rwx') })
      chmodSync(d, 0o700)
      expect(dataDirCheck(d)[0]?.status).toBe('ok')
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })
})

describe('the npm package (aggregate-finance): client commands only', () => {
  const capture = () => {
    const lines: string[] = []
    return { cwd: process.cwd(), env: {}, out: (s: string) => void lines.push(s), err: (s: string) => void lines.push(s), lines } as never as import('./io.ts').Io & { lines: string[] }
  }
  it('prints an npx config, points server commands at the checkout, and never takes a key on argv', async () => {
    const { runClient } = await import('./client.ts')
    const a = capture()
    expect(await runClient(['mcp', '--print-config', '--url', 'https://app.example.com/mcp'], a)).toBe(0)
    expect(JSON.parse(a.lines.join('\n')).mcpServers.aggregate).toMatchObject({ command: 'npx', args: ['-y', 'aggregate-finance', 'mcp', '--url', 'https://app.example.com/mcp'] })
    const b = capture()
    expect(await runClient(['doctor'], b)).toBe(2)
    expect(b.lines[0]).toMatch(/runs on the server.*npm run -s agfn -- doctor/)
    const c = capture()
    expect(await runClient(['mcp', '--url', 'https://app.example.com/mcp', 'agfn_live_x'], c)).toBe(2)
  })
})
