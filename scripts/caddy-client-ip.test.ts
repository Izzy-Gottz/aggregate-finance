// Red-team for the client IP on AWS: the real deploy/aws/Caddyfile in front of the app's own clientIp(). Every per-IP
// limit (sign-in codes, referrals, the demo gate) and the intrusion tag read that IP, so a client must never choose it.
//
// The file checks always run. The live part runs the actual Caddy binary (pinned 2.11.7, scripts/install-caddy.sh) and
// forges X-Real-IP, cf-connecting-ip and fly-client-ip. It skips without Caddy only when nobody requires it: CI and the
// merge gate set AGFN_REQUIRE_CADDY=1, so there a missing or different Caddy fails instead of skipping.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createServer as netServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clientIp } from '../apps/server/src/security.ts'

const CADDYFILE = new URL('../deploy/aws/Caddyfile', import.meta.url).pathname
const HEADER = 'x-real-ip'

describe('deploy/aws/Caddyfile', () => {
  it('overwrites X-Real-IP with the TCP peer and drops the headers a client could forge', () => {
    const text = readFileSync(CADDYFILE, 'utf8')
    expect(text).toMatch(/^\s*header_up X-Real-IP \{remote_host\}\s*$/m)
    expect(text).toMatch(/^\s*header_up -Cf-Connecting-Ip\s*$/m)
    expect(text).toMatch(/^\s*header_up -Fly-Client-Ip\s*$/m)
    // Never the client's own forwarded chain.
    expect(text).not.toMatch(/X-Forwarded-For|\{http\.request\.header/i)
  })
})

const hasCaddy = (() => {
  try {
    execFileSync('caddy', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = netServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })

const CADDY_VERSION = 'v2.11.7'
const caddyVersion = hasCaddy ? execFileSync('caddy', ['version']).toString().trim() : ''

describe.runIf(process.env.AGFN_REQUIRE_CADDY === '1')('Caddy is required here (CI, merge gate)', () => {
  it(`the pinned Caddy ${CADDY_VERSION} is on PATH (sh scripts/install-caddy.sh), so the red-team below runs`, () => {
    expect(hasCaddy, 'caddy is not on PATH').toBe(true)
    expect(caddyVersion.split(' ')[0]).toBe(CADDY_VERSION)
  })
})

describe.skipIf(!hasCaddy)('the real Caddy in front of clientIp()', () => {
  let app: Server
  let caddy: ChildProcess
  let dir: string
  let site: string

  beforeAll(async () => {
    // The app side: exactly what the server does with each request (CLIENT_IP_HEADER=x-real-ip).
    app = createServer((req, res) => {
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
      else if (Array.isArray(v)) for (const x of v) headers.append(k, x)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ip: clientIp(headers, HEADER) ?? null, cf: req.headers['cf-connecting-ip'] ?? null, fly: req.headers['fly-client-ip'] ?? null }))
    })
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()))
    const appPort = (app.address() as { port: number }).port
    const [caddyPort, adminPort] = [await freePort(), await freePort()]
    dir = mkdtempSync(join(tmpdir(), 'agfn-caddy-'))
    writeFileSync(join(dir, 'upstream.caddy'), `to 127.0.0.1:${appPort}\n`)
    site = `http://127.0.0.1:${caddyPort}`
    caddy = spawn('caddy', ['run', '--config', CADDYFILE, '--adapter', 'caddyfile'], {
      env: { PATH: process.env.PATH ?? '', HOME: dir, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir, AGFN_SITE: site, AGFN_CADDY_DIR: dir, CADDY_ADMIN: `127.0.0.1:${adminPort}` },
      stdio: 'ignore',
    })
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(site)).ok) return
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error('caddy did not start')
  })

  afterAll(async () => {
    caddy?.kill('SIGTERM')
    await new Promise<void>((r) => (app ? app.close(() => r()) : r()))
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const seen = async (headers: Record<string, string>) => (await (await fetch(site, { headers })).json()) as { ip: string | null; cf: string | null; fly: string | null }

  it('a plain request gets the peer address', async () => {
    expect((await seen({})).ip).toBe('127.0.0.1')
  })

  it('a forged X-Real-IP is replaced with the peer', async () => {
    expect((await seen({ 'X-Real-IP': '203.0.113.9' })).ip).toBe('127.0.0.1')
    expect((await seen({ 'X-Real-IP': '203.0.113.9, 198.51.100.1' })).ip).toBe('127.0.0.1')
  })

  it('a forged cf-connecting-ip or fly-client-ip never reaches the app, even next to a Cloudflare-looking X-Real-IP', async () => {
    // 104.16.0.1 is in Cloudflare's published ranges: if it survived as X-Real-IP, the app would trust cf-connecting-ip.
    const r = await seen({ 'X-Real-IP': '104.16.0.1', 'CF-Connecting-IP': '203.0.113.66', 'Fly-Client-IP': '203.0.113.77' })
    expect(r).toEqual({ ip: '127.0.0.1', cf: null, fly: null })
  })

  it('X-Forwarded-For from the client changes nothing', async () => {
    expect((await seen({ 'X-Forwarded-For': '203.0.113.5' })).ip).toBe('127.0.0.1')
  })
})
