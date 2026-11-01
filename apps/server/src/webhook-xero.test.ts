import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { installedConnectors } from '@agfn/connector-registry'
import { MemoryFileStore } from '@agfn/files'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'

const BASE = 'http://localhost:3000'
const KEY = 'xero-webhook-key-test'
let booted: Booted
let app: ReturnType<typeof createApp>

async function start(env: Record<string, string>) {
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => undefined }, connectors: installedConnectors({ XERO_CLIENT_ID: 'id', XERO_CLIENT_SECRET: 'secret', BASE_URL: BASE, ...env }), fileStore: new MemoryFileStore() })
  app = createApp(booted.services)
}
const deliver = (body: string, sig: string) => app.request('/api/webhooks/xero', { method: 'POST', headers: { 'x-xero-signature': sig, 'content-type': 'application/json' }, body })
const sign = (body: string, key = KEY) => createHmac('sha256', key).update(body).digest('base64')

describe("Xero webhooks: the intent-to-receive check", () => {
  afterEach(() => booted.shutdown())

  describe('with XERO_WEBHOOK_KEY set', () => {
    beforeEach(() => start({ XERO_WEBHOOK_KEY: KEY }))

    it('a correctly signed delivery gets 200 with an empty body; a wrong signature gets 401', async () => {
      const body = JSON.stringify({ events: [], firstEventSequence: 0, lastEventSequence: 0, entropy: 'ABCDEFGHIJ' })
      const ok = await deliver(body, sign(body))
      expect(ok.status).toBe(200)
      expect(await ok.text()).toBe('')
      expect((await deliver(body, sign(body, 'some-other-key'))).status).toBe(401)
      expect((await deliver(body, '')).status).toBe(401)
    })

    it('a signed change notice for an organisation no connection has is accepted and does nothing', async () => {
      const body = JSON.stringify({ events: [{ tenantId: 'aaaaaaaa-0000-4000-8000-00000000000a', eventCategory: 'INVOICE', eventType: 'UPDATE', resourceId: 'r1' }], firstEventSequence: 1, lastEventSequence: 1, entropy: 'X' })
      const res = await deliver(body, sign(body))
      expect(res.status).toBe(200)
      expect(await booted.handle.db.selectFrom('jobs').select('id').execute()).toEqual([])
    })
  })

  it('without a key the endpoint is off', async () => {
    await start({})
    expect((await deliver('{}', sign('{}'))).status).toBe(404)
  })
})
