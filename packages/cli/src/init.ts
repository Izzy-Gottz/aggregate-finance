// agfn init [--dir .] [--base-url URL] [--database-url URL] [--force] [--no-migrate]
// Writes a .env with fresh secrets (mode 600, never printed) and brings the database up to date.
// agfn migrate: just the database part, using the current environment.

import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { connect, migrateToLatest } from '@agfn/db'
import { UsageError, flagString, parseArgs, rejectUnknown, type Io } from './io.ts'

/** Used when there's no .env.example next to the target (e.g. running from an installed package). */
const FALLBACK_TEMPLATE = `# Aggregate settings. Never commit this file.
BASE_URL=http://localhost:8787
PORT=8787
# sqlite:/absolute/path.db (default ./data/agfn.db) or postgres://user:pass@host/db
# DATABASE_URL=
DATA_DIR=./data
# 32+ random characters; signs sessions
AUTH_SECRET=
# Master encryption key for provider secrets. Keep it OUTSIDE DATA_DIR and out of backups.
AGFN_MASTER_KEY=
# Connectors (each appears only when its keys are set)
# PLAID_CLIENT_ID=
# PLAID_SECRET=
# PLAID_ENV=sandbox
SYNC_EVERY_MINUTES=60
AGFN_ROLE=all
`

/** Fill `KEY=` lines (empty or commented-out) with values. Lines that already have a value are left alone. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  const done = new Set<string>()
  const lines = template.replace(/\n+$/, '').split('\n').map((line) => {
    const m = /^#?\s*([A-Z0-9_]+)=(.*)$/.exec(line)
    if (!m) return line
    const [, key = '', current = ''] = m
    const v = values[key]
    if (v === undefined || done.has(key)) return line
    if (!line.startsWith('#') && current.trim() !== '') return line
    done.add(key)
    return `${key}=${v}`
  })
  const missing = Object.keys(values).filter((k) => !done.has(k) && !lines.some((l) => l.startsWith(k + '=')))
  return [...lines, ...missing.map((k) => `${k}=${values[k]}`)].join('\n').replace(/\n*$/, '\n')
}

export function databaseUrlFor(env: Record<string, string | undefined>, dir: string): string {
  if (env.DATABASE_URL) return env.DATABASE_URL
  return `sqlite:${resolve(dir, env.DATA_DIR ?? './data', 'agfn.db')}`
}

export async function migrate(databaseUrl: string, dir: string, io: Io): Promise<number> {
  if (databaseUrl.startsWith('sqlite:') && !databaseUrl.includes(':memory:')) {
    mkdirSync(resolve(dir, databaseUrl.slice('sqlite:'.length), '..'), { recursive: true })
  }
  const h = connect(databaseUrl)
  try {
    const res = await migrateToLatest(h.db)
    const ran = (res.results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName)
    io.out(ran.length ? `database: applied ${ran.length} migration${ran.length === 1 ? '' : 's'} (${ran.join(', ')})` : 'database: up to date')
    return ran.length
  } finally {
    await h.close()
  }
}

export async function initCommand(argv: string[], io: Io): Promise<number> {
  const args = parseArgs(argv, ['force', 'no-migrate'])
  rejectUnknown(args, ['dir', 'base-url', 'database-url', 'force', 'no-migrate'])
  const dir = resolve(io.cwd, flagString(args, 'dir') ?? '.')
  const envPath = join(dir, '.env')
  if (existsSync(envPath) && !args.flags.has('force')) {
    throw new UsageError(`${envPath} already exists. Run \`agfn doctor\` to check it, or pass --force to replace it (the old one is kept as a backup).`)
  }
  const baseUrl = flagString(args, 'base-url')
  const databaseUrl = flagString(args, 'database-url')
  if (baseUrl) {
    try {
      new URL(baseUrl)
    } catch {
      throw new UsageError(`not a URL: ${baseUrl}`)
    }
  }
  const examplePath = join(dir, '.env.example')
  const template = existsSync(examplePath) ? readFileSync(examplePath, 'utf8') : FALLBACK_TEMPLATE
  const values: Record<string, string> = {
    AUTH_SECRET: randomBytes(32).toString('base64url'),
    AGFN_MASTER_KEY: randomBytes(32).toString('base64'),
    ...(baseUrl ? { BASE_URL: baseUrl.replace(/\/+$/, '') } : {}),
    ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
  }
  let text = fillTemplate(template, values)
  if (baseUrl) text = text.replace(/^BASE_URL=.*$/m, `BASE_URL=${values.BASE_URL}`)
  if (databaseUrl) text = text.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${databaseUrl}`)

  mkdirSync(dir, { recursive: true })
  if (existsSync(envPath)) {
    const backup = `${envPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    copyFileSync(envPath, backup)
    io.out(`kept the old settings in ${backup}`)
  }
  writeFileSync(envPath, text, { mode: 0o600 })
  io.out(`wrote ${envPath} with a new AUTH_SECRET and AGFN_MASTER_KEY (mode 600). Back up AGFN_MASTER_KEY somewhere safe: without it, saved connections can't be decrypted.`)

  if (!args.flags.has('no-migrate')) {
    const env = parseEnv(text) as Record<string, string | undefined>
    await migrate(databaseUrlFor(env, dir), dir, io)
  }
  io.out('next: `agfn doctor`, then `npm start` (or `node --env-file=.env apps/server/src/main.ts`)')
  return 0
}

export async function migrateCommand(argv: string[], io: Io): Promise<number> {
  const args = parseArgs(argv)
  rejectUnknown(args, ['database-url'])
  await migrate(flagString(args, 'database-url') ?? databaseUrlFor(io.env, io.cwd), io.cwd, io)
  return 0
}
