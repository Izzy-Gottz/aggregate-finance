// agfn export --format beancount|hledger [--workspace ID] [--company ID]... [--basis cash|accrual] [--out FILE]
// The books as a plain-text journal for Fava or hledger-web. Companies only (Personal spaces stay private).

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { plainTextExport } from '@agfn/server/plaintext'
import { UsageError, parseArgs, rejectUnknown, type Io } from './io.ts'
import { bootFromEnv, settleAuth, type BootFn } from './sync.ts'

const USAGE = 'usage: agfn export --format beancount|hledger [--workspace ID] [--company ID,ID] [--basis cash|accrual] [--out FILE]'

export async function exportCommand(argv: string[], io: Io, bootFn: BootFn = bootFromEnv): Promise<number> {
  const args = parseArgs(argv)
  rejectUnknown(args, ['format', 'workspace', 'company', 'basis', 'out'])
  if (args.positionals.length) throw new UsageError(USAGE)
  const format = args.flags.get('format')
  if (format !== 'beancount' && format !== 'hledger') throw new UsageError(`--format must be beancount or hledger. ${USAGE}`)
  const basis = args.flags.get('basis') ?? 'accrual'
  if (basis !== 'cash' && basis !== 'accrual') throw new UsageError('--basis must be cash or accrual')
  const company = args.flags.get('company')
  if (company === true) throw new UsageError('--company needs one or more ids')
  const out = args.flags.get('out')
  if (out === true) throw new UsageError('--out needs a file name')
  const only = args.flags.get('workspace')
  if (only === true) throw new UsageError('--workspace needs an id')

  const booted = await bootFn(io)
  await settleAuth(booted)
  try {
    const wss = await booted.services.db.selectFrom('workspaces').select(['id', 'name']).execute()
    const ws = only ? wss.find((w) => w.id === only) : wss.length === 1 ? wss[0] : undefined
    if (!ws) throw new UsageError(only ? `no workspace ${only}` : `${wss.length} workspaces here: pick one with --workspace (${wss.map((w) => `${w.id} ${w.name}`).join('; ')})`)
    const text = await plainTextExport(booted.services, ws.id, { format, basis, ...(company ? { entityIds: company.split(',').map((x) => x.trim()).filter(Boolean) } : {}) })
    if (out) {
      const file = resolve(io.cwd, out)
      writeFileSync(file, text, { mode: 0o600 })
      io.err(`wrote ${file} (${format}, ${basis} basis)`)
    } else io.out(text)
    return 0
  } finally {
    await booted.shutdown()
  }
}
