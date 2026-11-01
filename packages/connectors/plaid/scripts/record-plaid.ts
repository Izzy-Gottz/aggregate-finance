// Record a fresh Plaid Sandbox fixture. Sandbox only (refuses production), reads keys from env, never prints them.
//   PLAID_CLIENT_ID=... PLAID_SECRET=<sandbox secret> node packages/connectors/plaid/scripts/record-plaid.ts
// Writes packages/connectors/plaid/fixtures/raw/sandbox-recording.json (git-ignored). Review it, run it through
// redact(), confirm assertRedacted passes, then copy what the tests need into fixtures/redacted/.

import { mkdirSync, writeFileSync } from 'node:fs'
import { MemoryRawSink, type FetchLike } from '@agfn/connector-sdk'
import { DEFAULT_REDACT_KEYS, assertRedacted, redact } from '@agfn/connector-sdk/testing'
import { createPlaidConnector } from '../src/index.ts'

const clientId = process.env.PLAID_CLIENT_ID
const secret = process.env.PLAID_SECRET
if (!clientId || !secret) throw new Error('set PLAID_CLIENT_ID and PLAID_SECRET (sandbox) in the environment')
if (process.env.PLAID_ENV && process.env.PLAID_ENV !== 'sandbox') throw new Error('sandbox only')

const exchanges: Array<{ path: string; response: unknown }> = []
const recordingFetch: FetchLike = async (input, init) => {
  const res = await fetch(input, init)
  const copy = res.clone()
  exchanges.push({ path: new URL(input).pathname, response: await copy.json().catch(() => null) })
  return res
}

const raw = new MemoryRawSink()
const plaid = createPlaidConnector({ clientId, secret, env: 'sandbox' }, { raw, fetch: recordingFetch })
const publicToken = await plaid.sandboxPublicToken('ins_109508', ['transactions', 'liabilities', 'investments'])
const { secret: itemSecret, config } = await plaid.connect({ publicToken })
const conn = { id: 'conn_record', workspaceId: 'ws_record', connectorKey: 'plaid', secret: itemSecret, config }

// Sandbox transactions take a few seconds to be ready: run whole sync cycles until some arrive.
let cursor: string | null = null
let gotTxns = false
for (let cycle = 0; cycle < 20 && !gotTxns; cycle++) {
  for (let i = 0; i < 50; i++) {
    const page = await plaid.sync(conn, cursor)
    cursor = page.cursor
    if (page.events.some((e) => e.type === 'txn.upsert')) gotTxns = true
    if (!page.hasMore) break
  }
  if (!gotTxns) await new Promise((r) => setTimeout(r, 3000))
}
await plaid.removeItem(conn)

const scrubbed = redact(exchanges, [...DEFAULT_REDACT_KEYS, 'access_token', 'public_token', 'link_token', 'request_id', 'secret', 'client_id', 'item_id', 'property_address', 'payment_reference_number', 'guarantor'])
// fixtures/raw is git-ignored: write first, then report anything that still looks sensitive (by JSON path).
mkdirSync(new URL('../fixtures/raw/', import.meta.url), { recursive: true })
writeFileSync(new URL('../fixtures/raw/sandbox-recording.json', import.meta.url), JSON.stringify(scrubbed, null, 2))
console.log(`recorded ${exchanges.length} responses → fixtures/raw/sandbox-recording.json`)
const flagged: string[] = []
const walk = (v: unknown, path: string): void => {
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`)
  else {
    try {
      assertRedacted(v, [/^access-sandbox/])
    } catch {
      flagged.push(path.replace(/\[\d+\]/g, '[]'))
    }
  }
}
walk(scrubbed, '$')
if (flagged.length) console.log('still needs redaction before copying to fixtures/redacted:', [...new Set(flagged)].join(', '))
