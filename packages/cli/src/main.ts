#!/usr/bin/env node
// agfn: the Aggregate command line. Loads ./.env when present (never prints it).

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { run } from './index.ts'
import { processIo } from './io.ts'

// Files the CLI writes (.env, a restored database, document files) are for this user only.
process.umask(0o077)

const envFile = resolve(process.cwd(), '.env')
const argv = process.argv.slice(2)
// `agfn init` creates .env; everything else reads it if present (shell env wins over the file).
if (argv[0] !== 'init' && existsSync(envFile)) process.loadEnvFile(envFile)

const code = await run(argv, processIo())
// `agfn mcp` keeps serving stdio until the client disconnects; everything else exits with its code.
if (code !== null) process.exit(code)
