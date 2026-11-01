// Live Square SANDBOX test (opt-in: AGFN_LIVE_TESTS=1). The sandbox access token comes from the environment or the main
// checkout's git-ignored .env (SQUARE_SANDBOX_ACCESS_TOKEN); it is never printed.
//   AGFN_LIVE_TESTS=1 npx vitest run packages/connectors/square/src/square.sandbox.test.ts

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AccountUpsert, ConnectionRef } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertValidEvents } from '@agfn/connector-sdk/testing'
import { createSquareConnector } from './index.ts'

const live = process.env.AGFN_LIVE_TESTS === '1'
if (live && !process.env.SQUARE_SANDBOX_ACCESS_TOKEN) {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()
  const envFile = join(dirname(common), '.env')
  if (existsSync(envFile)) process.loadEnvFile(envFile)
}
const token = process.env.SQUARE_SANDBOX_ACCESS_TOKEN

describe.runIf(live && !!token)('square sandbox (live)', () => {
  it('connects with a sandbox access token, reads the merchant, and syncs locations, payouts and invoices', async () => {
    const square = createSquareConnector({ env: 'sandbox' }, { raw: new MemoryRawSink() })
    const { secret, config } = await square.connect({ accessToken: token ?? '', env: 'sandbox' })
    expect(config).toMatchObject({ env: 'sandbox', merchantId: expect.any(String) })
    const conn: ConnectionRef = { id: 'conn_sq_live', workspaceId: 'ws_live', connectorKey: 'square', secret, config }
    expect(await square.health(conn)).toMatchObject({ status: 'ok' })
    const r = await runSync(square, conn, null)
    expect(r.complete).toBe(true)
    assertValidEvents(r.events, { connectionId: conn.id })
    expect(r.events.filter((e): e is AccountUpsert => e.type === 'account.upsert').length).toBeGreaterThan(0)
    // A personal token is the owner's: disconnect never revokes it.
    await square.disconnect?.(conn)
    expect(await square.health(conn)).toMatchObject({ status: 'ok' })
  }, 120_000)
})
