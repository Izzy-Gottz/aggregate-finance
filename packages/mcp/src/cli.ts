#!/usr/bin/env node
// agfn-mcp bridge --url https://you.example/mcp     (AGFN_KEY=agfn_live_… in the environment)
// The local mode (same machine as the database) is started by apps/server, which owns the wiring.

import { runBridge } from './stdio.ts'

const USAGE = 'usage: AGFN_KEY=agfn_live_… agfn-mcp bridge --url https://you.example/mcp'

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv
  if (cmd !== 'bridge') {
    process.stderr.write(USAGE + '\n')
    process.exit(2)
  }
  const i = rest.indexOf('--url')
  const url = i >= 0 ? rest[i + 1] : process.env.AGFN_URL
  const key = process.env.AGFN_KEY
  if (!url || !key) {
    process.stderr.write(USAGE + '\n')
    process.exit(2)
  }
  if (rest.some((a) => a.startsWith('agfn_'))) {
    process.stderr.write('agfn-mcp: pass the key in AGFN_KEY, not on the command line\n')
    process.exit(2)
  }
  await runBridge({ url, key })
}

main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`agfn-mcp: ${(err as Error)?.message ?? String(err)}\n`)
  process.exit(1)
})
