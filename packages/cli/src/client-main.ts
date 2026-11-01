#!/usr/bin/env node
// Entry of the npm package `agfn`. Unlike the checkout's main.ts it never reads a .env: run from any directory, it
// must not pick up someone else's settings.
import { runClient } from './client.ts'
import { processIo } from './io.ts'

const code = await runClient(process.argv.slice(2), processIo())
if (code !== null) process.exit(code)
