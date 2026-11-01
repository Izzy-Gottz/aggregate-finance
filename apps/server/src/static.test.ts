import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'
import { acceptsBrotli, serveWeb } from './static.ts'

let dir: string
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('serveWeb', () => {
  it('serves a real build, and refuses a mock (demo-only) build', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agfn-web-'))
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>Aggregate</title>')
    const app = new Hono()
    app.get('*', serveWeb(dir))
    expect((await app.request('/')).status).toBe(200)
    expect((await app.request('/#/review')).status).toBe(200)
    expect((await app.request('/some/route')).status).toBe(200)
    // A stale hashed bundle 404s instead of returning index.html as JavaScript.
    expect((await app.request('/assets/main-OLDHASH.js')).status).toBe(404)
    // Malformed percent-escapes are 404s, never a URIError (500).
    for (const p of ['/%E0%A4%A', '/assets/%ZZ', '/docs/%']) expect((await app.request(p)).status, p).toBe(404)

    await writeFile(join(dir, '.mock'), 'mock')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const mock = new Hono()
    mock.get('*', serveWeb(dir))
    const r = await mock.request('/')
    expect(r.status).toBe(503)
    expect(await r.text()).toMatch(/demo-only web build/)
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('serves the build-time .br of a hashed asset only to browsers that accept br, same type and caching', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agfn-web-'))
    await writeFile(join(dir, 'index.html'), '<!doctype html>')
    await mkdir(join(dir, 'assets'))
    const js = 'console.log("aggregate")'.repeat(50)
    await writeFile(join(dir, 'assets/app-ABC.js'), js)
    await writeFile(join(dir, 'assets/app-ABC.js.br'), brotliCompressSync(js))
    await writeFile(join(dir, 'assets/app-ABC.css'), 'body{}')
    const app = new Hono()
    app.get('*', serveWeb(dir))

    const br = await app.request('/assets/app-ABC.js', { headers: { 'accept-encoding': 'gzip, deflate, br' } })
    expect(br.headers.get('content-encoding')).toBe('br')
    expect(br.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(br.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(br.headers.get('vary')).toBe('Accept-Encoding')
    expect(brotliDecompressSync(Buffer.from(await br.arrayBuffer())).toString()).toBe(js)

    for (const ae of ['gzip', 'br;q=0, gzip', '']) {
      const plain = await app.request('/assets/app-ABC.js', { headers: { 'accept-encoding': ae } })
      expect(plain.headers.get('content-encoding')).toBeNull()
      expect(plain.headers.get('vary')).toBe('Accept-Encoding')
      expect(await plain.text()).toBe(js)
    }
    // No .br beside it (or not a hashed asset): served as before, no Vary.
    const css = await app.request('/assets/app-ABC.css', { headers: { 'accept-encoding': 'br' } })
    expect(css.headers.get('content-encoding')).toBeNull()
    expect(css.headers.get('vary')).toBeNull()
    const html = await app.request('/', { headers: { 'accept-encoding': 'br' } })
    expect(html.headers.get('content-encoding')).toBeNull()
  })

  it('reads Accept-Encoding the way browsers send it', () => {
    expect(acceptsBrotli('gzip, deflate, br, zstd')).toBe(true)
    expect(acceptsBrotli('br;q=0.5')).toBe(true)
    expect(acceptsBrotli('br;q=0')).toBe(false)
    expect(acceptsBrotli('gzip')).toBe(false)
    expect(acceptsBrotli(undefined)).toBe(false)
  })
})
