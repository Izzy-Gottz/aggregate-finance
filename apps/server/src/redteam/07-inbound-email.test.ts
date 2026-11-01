// Threat model #2 (a fake emailed bill becomes a real payable): email-in accepts mail only from the provider (shared
// secret), only when it is authenticated as the From domain, only from senders the owner listed, only at the current
// address, and only real documents. Every spoof below must store nothing.
import { describe, expect, it } from 'vitest'
import { startServer, type Server } from '../scenarios/harness.ts'
import { asTest, PDF, victimWorld } from './world.ts'

const SECRET = 'redteam-inbound-secret-0001'
const basic = (s: string) => `Basic ${Buffer.from(`postmark:${s}`).toString('base64')}`
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
const AR_PASS = 'mx.postmark; spf=pass smtp.mailfrom=billing@acme-vendor.com; dkim=pass header.d=acme-vendor.com; dmarc=pass header.from=acme-vendor.com'

function mail(to: string, o: { from?: string; fromName?: string; ar?: string; spf?: string; attachments?: Array<{ Name: string; ContentType: string; Content: string }> } = {}) {
  return {
    From: `${o.fromName ?? 'Acme Vendor'} <${o.from ?? 'billing@acme-vendor.com'}>`,
    FromFull: { Email: o.from ?? 'billing@acme-vendor.com', Name: o.fromName ?? 'Acme Vendor' },
    ToFull: [{ Email: to }],
    OriginalRecipient: to,
    Subject: 'Invoice 12',
    MessageID: `m-${Math.random()}`,
    Headers: [...(o.spf ? [{ Name: 'Received-SPF', Value: o.spf }] : []), ...(o.ar !== '' ? [{ Name: 'Authentication-Results', Value: o.ar ?? AR_PASS }] : [])],
    Attachments: o.attachments ?? [{ Name: 'invoice-12.pdf', ContentType: 'application/pdf', Content: b64(PDF) }],
  }
}

describe('red team: inbound email spoofing', () => {
  it('stores nothing from forged, unauthenticated, unlisted or disguised mail', async () => {
    const srv = await startServer({ env: { INBOUND_EMAIL_DOMAIN: 'in.example.com', INBOUND_WEBHOOK_SECRET: SECRET } })
    try {
      const v = await victimWorld(srv)
      const ws = (await v.s.get<{ inbound: Array<{ entityId: string; address: string }> }>('/api/workspace')).body
      const address = ws.inbound.find((i) => i.entityId === v.entityId)?.address as string
      const token = address.split('@')[0] as string
      expect((await v.s.send('PUT', `/api/inbound/${v.entityId}`, { allowedSenders: ['@acme-vendor.com'] })).status).toBe(200)
      const docs = async () => (await asTest(() => srv.booted.services.db.selectFrom('documents').select('id').where('workspace_id', '=', v.ws).execute())).length
      const post = async (t: string, body: unknown, auth: Record<string, string> = { authorization: basic(SECRET) }) => {
        const res = await srv.app.request(`/api/inbound/email/${t}`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(body) })
        return { status: res.status, body: (await res.json().catch(() => ({}))) as { accepted?: number; reason?: string } }
      }
      const start = await docs()

      // Not from the provider.
      for (const auth of [{}, { authorization: basic('wrong') }, { authorization: `Bearer ${SECRET}` }, { 'x-agfn-inbound-secret': 'wrong' }] as Array<Record<string, string>>) {
        const r = await post(token, mail(address), auth)
        expect([401, 403], JSON.stringify(auth)).toContain(r.status)
      }

      const spoofs: Array<[string, unknown]> = [
        ['DMARC fail', mail(address, { ar: 'mx.postmark; spf=pass smtp.mailfrom=x@evil.example; dkim=none; dmarc=fail header.from=acme-vendor.com' })],
        ['SPF fail, no DKIM', mail(address, { ar: 'mx.postmark; spf=fail smtp.mailfrom=billing@acme-vendor.com; dkim=none' })],
        ['SPF softfail via Received-SPF, no DKIM', mail(address, { ar: '', spf: 'SoftFail (domain does not designate sender)' })],
        ["someone else's DKIM, no DMARC policy", mail(address, { ar: 'mx.postmark; spf=fail smtp.mailfrom=x@evil.example; dkim=pass header.d=evil.example' })],
        ["SPF pass for the attacker's envelope domain", mail(address, { ar: 'mx.postmark; spf=pass smtp.mailfrom=bounce@evil.example; dkim=none' })],
        ['no authentication at all', mail(address, { ar: '' })],
        ['authenticated, but not on the list', mail(address, { from: 'billing@evil.example', ar: 'mx.postmark; spf=pass smtp.mailfrom=billing@evil.example; dkim=pass header.d=evil.example; dmarc=pass' })],
        ['look-alike: suffix', mail(address, { from: 'billing@acme-vendor.com.evil.example', ar: 'mx; spf=pass smtp.mailfrom=billing@acme-vendor.com.evil.example; dkim=pass header.d=acme-vendor.com.evil.example; dmarc=pass' })],
        ['look-alike: prefix', mail(address, { from: 'billing@evilacme-vendor.com', ar: 'mx; spf=pass smtp.mailfrom=billing@evilacme-vendor.com; dkim=pass header.d=evilacme-vendor.com; dmarc=pass' })],
        ['display name pretends', mail(address, { from: 'billing@evil.example', fromName: 'billing@acme-vendor.com', ar: 'mx; dkim=pass header.d=evil.example; dmarc=pass' })],
      ]
      for (const [label, body] of spoofs) {
        const r = await post(token, body)
        expect(r.body.accepted ?? 0, `${label}: ${JSON.stringify(r.body)}`).toBe(0)
      }
      expect(await docs()).toBe(start)

      // Disguised attachments from a genuine sender: skipped, never stored.
      const disguised = mail(address, {
        attachments: [
          { Name: 'invoice.pdf', ContentType: 'application/pdf', Content: b64(new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0])) },
          { Name: 'invoice.pdf.html', ContentType: 'text/html', Content: b64(new TextEncoder().encode('<script>alert(1)</script>')) },
          { Name: 'statement.svg', ContentType: 'image/svg+xml', Content: b64(new TextEncoder().encode('<svg onload="alert(1)"/>')) },
          { Name: 'statement.csv', ContentType: 'text/csv', Content: b64(new Uint8Array([0x61, 0x00, 0x62])) },
        ],
      })
      expect((await post(token, disguised)).body.accepted ?? 0).toBe(0)
      expect(await docs()).toBe(start)

      // The real thing is accepted (control)...
      expect((await post(token, mail(address, { attachments: [{ Name: 'invoice-12.pdf', ContentType: 'application/pdf', Content: b64(new TextEncoder().encode('%PDF-1.4\n% invoice 12\n%%EOF')) }] }))).body.accepted).toBe(1)
      expect(await docs()).toBe(start + 1)
      // ...but not at an address that was rotated away, nor at a made-up one.
      const rotated = await v.s.post<{ address: string }>(`/api/inbound/${v.entityId}/rotate`, {})
      expect(rotated.body.address).not.toBe(address)
      const old = await post(token, mail(address, { attachments: [{ Name: 'second.pdf', ContentType: 'application/pdf', Content: b64(new TextEncoder().encode('%PDF-1.4\n2 0 obj<<>>endobj\n%%EOF')) }] }))
      expect(old.body.accepted ?? 0).toBe(0)
      expect((await post('acme-0000000000000000', mail(address))).body.accepted ?? 0).toBe(0)
      expect(await docs()).toBe(start + 1)
      // Email-arrived documents are labeled as such (provenance), never as the owner's own upload.
      const arrived = await asTest(() => srv.booted.services.db.selectFrom('documents').selectAll().where('workspace_id', '=', v.ws).execute())
      expect(JSON.stringify(arrived)).toMatch(/email/)
    } finally {
      await srv.close()
    }
  }, 120_000)
})
