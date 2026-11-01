// Upload type spoofing: the file's name and declared type are attacker-controlled; only its bytes decide what it is.
// Executables, HTML and SVG never get in whatever they're called; what does get in is always served back as a
// sandboxed download with its sniffed type, never rendered, and odd file names can't break or inject headers.
import { describe, expect, it } from 'vitest'
import { startServer } from '../scenarios/harness.ts'
import { upload, victimWorld } from './world.ts'

const enc = (s: string) => new TextEncoder().encode(s)

describe('red team: upload type spoofing', () => {
  it('bytes decide the type; downloads are inert attachments', async () => {
    const srv = await startServer()
    try {
      const v = await victimWorld(srv)
      const refused: Array<[string, Uint8Array, string]> = [
        ['invoice.pdf', new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]), 'application/pdf'], // Windows .exe
        ['invoice.pdf', new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), 'application/pdf'], // ELF
        ['invoice.pdf', enc('<html><script>fetch("/api/export",{method:"POST"})</script></html>'), 'application/pdf'],
        ['receipt.png', enc('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'image/png'],
        ['receipt.svg', enc('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml'],
        ['statement.html', enc('<b>hi</b>'), 'text/html'],
        ['statement.js', enc('alert(1)'), 'text/javascript'],
        ['archive.pdf', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), 'application/pdf'], // zip
        ['statement.csv', new Uint8Array([0x61, 0x2c, 0x62, 0x00, 0x0a]), 'text/csv'], // NUL byte: binary in disguise
        ['empty.pdf', new Uint8Array(0), 'application/pdf'],
        ['big.pdf', new Uint8Array(9 * 1024 * 1024).fill(0x25), 'application/pdf'],
        ['statement.xml', enc('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'application/xml'], // not a bank statement
        ['statement.xml', enc('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>'), 'application/xml'],
        ['big.xml', new Uint8Array(9 * 1024 * 1024).fill(0x20), 'application/xml'],
      ]
      for (const [name, bytes, type] of refused) {
        const r = await upload(v.s, v.entityId, name, bytes, type)
        expect(r.status, `${name} (${type}, ${bytes.byteLength} bytes)`).toBeGreaterThanOrEqual(400)
        expect(r.body.documentId, name).toBeUndefined()
      }

      // Accepted because the bytes are a PDF / CSV — whatever the name or declared type says — and served inert.
      const accepted: Array<[string, Uint8Array, string, string]> = [
        ['looks-like-a-page.html', enc('%PDF-1.4\n<script>alert(1)</script>\n%%EOF'), 'text/html', 'application/pdf'],
        ['statement.csv', enc('date,amount\n2026-10-01,<img src=x onerror=alert(1)>\n'), 'text/html', 'text/csv'],
        ['../../../../etc/passwd.pdf', enc('%PDF-1.4\n% traversal\n%%EOF'), 'application/pdf', 'application/pdf'],
        ['inv"\r\nSet-Cookie: pwned=1; x=".pdf', enc('%PDF-1.4\n% header injection\n%%EOF'), 'application/pdf', 'application/pdf'],
        ['счёт-№12 — 請求書.pdf', enc('%PDF-1.4\n% unicode name\n%%EOF'), 'application/pdf', 'application/pdf'],
      ]
      for (const [name, bytes, type, served] of accepted) {
        const r = await upload(v.s, v.entityId, name, bytes, type)
        expect(r.status, `${JSON.stringify(name)}: ${JSON.stringify(r.body)}`).toBe(201)
        const id = r.body.documentId as string
        const res = await srv.app.request(`/api/documents/${id}/file`, { headers: { cookie: v.s.cookie() } })
        const body = new Uint8Array(await res.arrayBuffer())
        expect(res.status, JSON.stringify(name)).toBe(200)
        expect(res.headers.get('content-type'), JSON.stringify(name)).toBe(served)
        expect(res.headers.get('content-disposition') ?? '', JSON.stringify(name)).toMatch(/^attachment;/)
        expect(res.headers.get('content-disposition') ?? '', JSON.stringify(name)).not.toMatch(/[\r\n]|\.\.\//)
        expect(res.headers.get('content-security-policy') ?? '', JSON.stringify(name)).toMatch(/sandbox/)
        expect(res.headers.get('x-content-type-options')).toBe('nosniff')
        expect(res.headers.getSetCookie().some((c) => /pwned/.test(c)), JSON.stringify(name)).toBe(false)
        expect(Buffer.from(body).equals(Buffer.from(bytes)), JSON.stringify(name)).toBe(true)
        if (/[^\x00-\x7f]/.test(name)) expect(decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? '')).toBe((r.body as { name?: string }).name)
      }
      // Stored keys never follow the file name (no path traversal into other workspaces' files).
      for (const k of srv.files.files.keys()) expect(k, k).not.toMatch(/\.\.|etc\/passwd/)

      // The payroll register route takes CSV only; HTML or binary dressed as CSV is refused.
      for (const body of ['<html><script>alert(1)</script></html>', 'MZ\u0090\u0000\u0003']) {
        const r = await v.s.post(`/api/entities/${v.entityId}/payroll-register`, undefined, { headers: { 'content-type': 'text/csv' }, raw: body })
        expect(r.status, body.slice(0, 10)).toBeGreaterThanOrEqual(400)
      }
    } finally {
      await srv.close()
    }
  }, 120_000)

})
