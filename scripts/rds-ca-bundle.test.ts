// The RDS root bundle the image ships (certs/README.md), and why it's needed: node-postgres with sslmode=require
// verifies the server certificate, so a database whose root isn't in Node's store (RDS's) is refused until
// NODE_EXTRA_CA_CERTS names a bundle with that root. Proven with a stand-in server that speaks Postgres's SSL request
// and a throwaway CA (openssl), the way RDS presents its certificate.
import { execFile, execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TLSSocket } from 'node:tls'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BUNDLE = new URL('../certs/rds-global-bundle.pem', import.meta.url).pathname
const ROOT = new URL('..', import.meta.url).pathname

describe('certs/rds-global-bundle.pem', () => {
  const certs = (readFileSync(BUNDLE, 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map((c) => new X509Certificate(c))

  it('is only Amazon RDS certificate authorities, with no private key, valid well past the move', () => {
    expect(certs.length).toBeGreaterThan(50)
    expect(readFileSync(BUNDLE, 'utf8')).not.toMatch(/PRIVATE KEY/)
    for (const c of certs) {
      expect(c.ca, c.subject).toBe(true)
      expect(c.subject).toMatch(/O=Amazon Web Services, Inc\.|O=Amazon Web Services\\, Inc\./)
      expect(c.subject).toMatch(/OU=Amazon RDS/)
      expect(new Date(c.validTo).getTime()).toBeGreaterThan(Date.parse('2030-01-01'))
    }
  })

  it('has the us-east-1 roots (where the database goes)', () => {
    const east = certs.filter((c) => /CN=Amazon RDS us-east-1 Root CA/.test(c.subject)).map((c) => /CN=([^\n]+)/.exec(c.subject)?.[1])
    expect(east.sort()).toEqual(['Amazon RDS us-east-1 Root CA ECC384 G1', 'Amazon RDS us-east-1 Root CA RSA2048 G1', 'Amazon RDS us-east-1 Root CA RSA4096 G1'])
  })
})

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!hasOpenssl)('sslmode=require verifies the server certificate (why the bundle ships)', () => {
  let dir: string
  let server: Server
  let port: number

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agfn-rds-ca-'))
    const ssl = (...a: string[]) => execFileSync('openssl', a, { cwd: dir, stdio: 'ignore' })
    // A private root (like RDS's: not in Node's store) and a server certificate for localhost signed by it.
    ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Stand-in RDS Root CA')
    ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', '/CN=localhost')
    writeFileSync(join(dir, 'ext.cnf'), 'subjectAltName=DNS:localhost\n')
    ssl('x509', '-req', '-in', 'srv.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'srv.pem', '-days', '2', '-extfile', 'ext.cnf')
    const key = readFileSync(join(dir, 'srv.key'))
    const cert = readFileSync(join(dir, 'srv.pem'))
    // Postgres's SSLRequest (8 bytes) is answered 'S', then TLS; after the handshake the stand-in hangs up, so a client
    // that trusted the certificate fails later with a connection error, not a certificate one.
    server = createServer((sock) => {
      sock.once('data', () => {
        sock.write('S')
        const tls = new TLSSocket(sock, { isServer: true, key, cert })
        tls.on('secure', () => tls.destroy())
        tls.on('error', () => tls.destroy())
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
  })

  afterAll(async () => {
    await new Promise((r) => server?.close(r))
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  // A fresh process each time: NODE_EXTRA_CA_CERTS is read only when Node starts.
  const connect = (extraCa?: string) =>
    new Promise<string>((resolve) => {
      const code = `const pg = (await import('pg')).default; const c = new pg.Client({ connectionString: 'postgres://u:p@localhost:${port}/db?sslmode=require', connectionTimeoutMillis: 5000 }); c.on('error', () => {}); try { await c.connect(); console.log('connected') } catch (e) { console.log(e.code ?? e.message) } finally { await c.end().catch(() => {}) }`
      execFile(process.execPath, ['--input-type=module', '-e', code], { cwd: join(ROOT, 'apps/server'), env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1', ...(extraCa ? { NODE_EXTRA_CA_CERTS: extraCa } : {}) } }, (_e, out) => resolve(out.trim()))
    })

  it("refuses a server whose root isn't trusted", async () => {
    expect(await connect()).toMatch(/UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT/)
  })

  it('trusts it once NODE_EXTRA_CA_CERTS names a bundle with the root (what the RDS bundle does on AWS)', async () => {
    const out = await connect(join(dir, 'ca.pem'))
    expect(out).not.toMatch(/CERT|SIGNATURE|ISSUER/)
    // Past TLS: the stand-in hangs up after the handshake.
    expect(out).toMatch(/terminated|ECONNRESET|closed/i)
  })

  it('the shipped RDS bundle does not trust a different root', async () => {
    expect(await connect(BUNDLE)).toMatch(/UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT/)
  })
})
