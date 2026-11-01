import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectorError } from '@agfn/connector-sdk'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { errorForLog, scrubLogText } from './log-safe.ts'

// A provider error the way libraries build them: the response body and request headers hung on the error.
function providerError(): Error {
  const err = new ConnectorError('permanent', 'Invalid request for alice.smith@example.com, card 4111111111111111', { provider: 'stripe', status: 400, code: 'invalid_request', requestId: 'req_123' })
  Object.assign(err, {
    body: { merchant: 'Blue Bottle Coffee', amount: 1234.56, customer_email: 'alice.smith@example.com' },
    headers: { authorization: 'Bearer sk_live_abcdefghijklmnop' },
    detail: 'Key (email)=(alice.smith@example.com) already exists.',
  })
  return new Error('sync failed', { cause: err })
}

const SECRETS = ['Blue Bottle', '1234.56', 'alice.smith', '4111111111111111', 'sk_live_abcdef', 'Key (email)']

describe('errors in the log', () => {
  it('keeps the name, a scrubbed message, safe ids and frames, never the body or headers', () => {
    const out = JSON.stringify(errorForLog(providerError()))
    for (const s of SECRETS) expect(out).not.toContain(s)
    expect(out).toContain('"provider":"stripe"')
    expect(out).toContain('"requestId":"req_123"')
    expect(out).toContain('a•••@example.com')
    expect(out).toContain('[16 digits]')
  })

  it('scrubs keys, tokens and connection strings in text', () => {
    expect(scrubLogText('use rk_live_abc123 or Bearer abc.def.ghi')).toBe('use rk_*** or Bearer [redacted]')
    expect(scrubLogText('postgres://user:pw@host/db')).toBe('postgres://[redacted]@host/db')
    expect(scrubLogText('access_token=xyz789longtoken')).toBe('access_token=[redacted]')
  })

  describe('through the app', () => {
    let booted: Booted
    beforeEach(async () => {
      const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: 'http://localhost:8787', WEB_DIST: '/nonexistent' }), runWorker: false }
      booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => {} } })
    })
    afterEach(() => booted.shutdown())

    it('an unhandled provider error answers 500 and logs nothing from the provider body', async () => {
      // The health check's hook throws a provider error: nothing in the app catches it, so the app's error handler does.
      const app = createApp({ ...booted.services, health: { ok: () => { throw providerError() }, busy: () => {} } } as unknown as typeof booted.services)
      const lines: string[] = []
      const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')))
      try {
        const res = await app.request('/healthz')
        expect(res.status).toBe(500)
      } finally {
        spy.mockRestore()
      }
      const logged = lines.join('\n')
      expect(logged).toContain('[agfn] unhandled error')
      for (const s of SECRETS) expect(logged).not.toContain(s)
    })
  })
})
