// Unknown API paths answer a JSON 404, never the web app's index.html with a 200 (scanners read that as a leak).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'

const BASE = 'http://localhost:8787'
let dir = ''
let booted: Booted
let app: ReturnType<typeof createApp>
const outbox: string[] = []

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agfn-web-'))
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Aggregate</title>')
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: dir }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push(m.text) } })
  app = createApp(booted.services)
})
afterAll(async () => {
  await booted?.shutdown()
  await rm(dir, { recursive: true, force: true })
})

describe('unknown API paths', () => {
  it('signed out or in, /api, /v1, /mcp and /.well-known paths that don’t exist are JSON 404s; app pages still load', async () => {
    await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: 'me@acme.example', callbackURL: '/' }) })
    const link = outbox.at(-1)!.match(/https?:\/\/\S+/)![0]
    const cookie = (await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    for (const path of ['/api/nope', '/api/admin/users', '/v1/nope', '/mcp/nope', '/.well-known/nope']) {
      for (const headers of [{}, { cookie }] as Array<Record<string, string>>) {
        const r = await app.request(path, { headers })
        expect(r.status, `${path} ${'cookie' in headers ? 'signed in' : 'signed out'}`).not.toBe(200)
        expect(r.headers.get('content-type') ?? '', path).toMatch(/json/)
        expect(await r.text()).not.toMatch(/<!doctype html>/i)
      }
    }
    const signedIn = await app.request('/api/nope', { headers: { cookie } })
    expect(signedIn.status).toBe(404)
    expect((await app.request('/')).status).toBe(200)
    expect((await app.request('/privacy')).status).toBe(200)
  })
})
