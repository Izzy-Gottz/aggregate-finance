import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { boot, type Booted } from '../boot.ts'
import { createApp } from '../app.ts'
import { loadConfig } from '../config.ts'
import { MemoryFileStore } from '@agfn/files'
import { addressOf, authFailed, parseInbound, senderAllowed } from './inbound.ts'

const BASE = 'http://localhost:8787'
const SECRET = 's3cret-inbound-key'
let booted: Booted
let app: ReturnType<typeof createApp>
let outbox: Array<{ to: string; text: string }>

beforeEach(async () => {
  outbox = []
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent', INBOUND_EMAIL_DOMAIN: 'In.Example.com', INBOUND_WEBHOOK_SECRET: SECRET }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), fileStore: new MemoryFileStore(), mailer: { send: async (m) => void outbox.push({ to: m.to, text: m.text }) } })
  app = createApp(booted.services)
})
afterEach(() => booted.shutdown())

async function signIn(email: string): Promise<string> {
  await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
  const link = outbox.filter((m) => m.to === email).at(-1)!.text.match(/https?:\/\/\S+/)![0]
  const res = await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}
const req = (cookie: string, method: string, body?: unknown) => ({ method, headers: { 'content-type': 'application/json', origin: BASE, cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64')
const EXE = Buffer.from([0x4d, 0x5a, 0, 0, 1, 2]).toString('base64')
const basic = (secret: string) => `Basic ${Buffer.from(`postmark:${secret}`).toString('base64')}`

function postmark(from: string, to: string, extra: Record<string, unknown> = {}) {
  return {
    From: `Vendor <${from}>`,
    FromFull: { Email: from, Name: 'Vendor' },
    ToFull: [{ Email: to }],
    OriginalRecipient: to,
    Subject: 'Invoice 77',
    MessageID: 'abc-123',
    Headers: [{ Name: 'Received-SPF', Value: 'Pass (sender SPF authorized)' }, { Name: 'Authentication-Results', Value: 'mx.example; dkim=pass; dmarc=pass' }],
    Attachments: [{ Name: 'invoice-77.pdf', ContentType: 'application/pdf', Content: PDF, ContentLength: 40 }, { Name: 'setup.exe', ContentType: 'application/octet-stream', Content: EXE }],
    ...extra,
  }
}

async function setup() {
  const cookie = await signIn('founder@example.com')
  const { companyId } = (await (await app.request('/api/workspaces', req(cookie, 'POST', { companyName: 'Acme Inc' }))).json()) as { companyId: string }
  const ws = (await (await app.request('/api/workspace', { headers: { cookie } })).json()) as { inbound: Array<{ entityId: string; address: string }> }
  const address = ws.inbound.find((i) => i.entityId === companyId)!.address
  return { cookie, companyId, address, token: address.split('@')[0]! }
}

const hook = (token: string, body: unknown, auth: Record<string, string> = { authorization: basic(SECRET) }) =>
  app.request(`/api/inbound/email/${token}`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(body) })

describe('email-in', () => {
  it('gives each company a secret address and turns allowed mail into unread documents', async () => {
    const { cookie, companyId, address, token } = await setup()
    expect(address).toMatch(/^acmeinc-[a-z2-9]{16}@in\.example\.com$/)

    // Members who can add documents may send; anyone else only once listed.
    const blocked = await hook(token, postmark('billing@vendor.com', address))
    expect(await blocked.json()).toMatchObject({ accepted: 0, reason: 'sender not allowed' })

    expect((await app.request(`/api/inbound/${companyId}`, req(cookie, 'PUT', { allowedSenders: ['@Vendor.com', 'me@example.org'] }))).status).toBe(200)
    const ok = await hook(token, postmark('billing@vendor.com', address))
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { accepted: number; skipped: Array<{ name: string }> }
    expect(body.accepted).toBe(1)
    expect(body.skipped.map((x) => x.name)).toEqual(['setup.exe'])
    const docs = await booted.handle.db.selectFrom('documents').selectAll().where('entity_id', '=', companyId).execute()
    expect(docs).toMatchObject([{ arrived_via: 'email', status: 'unread', original_name: 'invoice-77.pdf' }])

    // The generic (Cloudflare Worker) shape with the header secret.
    const worker = await hook(token, { from: 'me@example.org', to: [address], subject: 'Receipt', attachments: [{ filename: 'r.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.7 other').toString('base64') }], auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass' } }, { 'x-agfn-inbound-secret': SECRET })
    expect(((await worker.json()) as { accepted: number }).accepted).toBe(1)

    // Forged mail from an allowed domain is refused.
    const forged = await hook(token, postmark('billing@vendor.com', address, { Headers: [{ Name: 'Authentication-Results', Value: 'mx; spf=fail; dkim=none; dmarc=fail' }] }))
    expect(await forged.json()).toMatchObject({ accepted: 0, reason: 'DMARC failed' })

    // Activity records every delivery.
    const act = await booted.handle.db.selectFrom('activity_log' as never).selectAll().execute() as Array<{ action: string; status: string }>
    expect(act.filter((a) => a.action === 'email.received').map((a) => a.status)).toEqual(['denied', 'ok', 'ok', 'denied'])
  })

  it('refuses unauthenticated providers, unknown and rotated addresses', async () => {
    const { cookie, companyId, address, token } = await setup()
    expect((await hook(token, postmark('a@b.com', address), { authorization: basic('wrong') })).status).toBe(403)
    expect((await hook(token, postmark('a@b.com', address), {})).status).toBe(403)
    expect((await hook('acme-aaaaaaaaaaaaaaaa', postmark('a@b.com', address))).status).toBe(403)
    expect([403, 404]).toContain((await hook('../../etc', postmark('a@b.com', address))).status)
    const rotated = (await (await app.request(`/api/inbound/${companyId}/rotate`, req(cookie, 'POST', {}))).json()) as { address: string }
    expect(rotated.address).not.toBe(address)
    expect((await hook(token, postmark('a@b.com', address))).status).toBe(403)
    expect((await hook('x', 'not json')).status).toBe(403)
  })

  it('only managers change who may send', async () => {
    const { cookie, companyId } = await setup()
    await app.request('/api/people', req(cookie, 'POST', { email: 'emp@example.com', role: 'employee', entityIds: 'all' }))
    const emp = await signIn('emp@example.com')
    expect((await app.request(`/api/inbound/${companyId}`, req(emp, 'PUT', { allowedSenders: ['@x.com'] }))).status).toBe(403)
    expect((await app.request(`/api/inbound/${companyId}`, req(cookie, 'PUT', { allowedSenders: ['not an email'] }))).status).toBe(400)
  })
})

describe('email size', () => {
  it('accepts emails up to 30 MB, skips files over 8 MB, refuses bigger emails', async () => {
    const { cookie, companyId, address, token } = await setup()
    await app.request(`/api/inbound/${companyId}`, req(cookie, 'PUT', { allowedSenders: ['@vendor.com'] }))
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(9 * 1024 * 1024, 0x20)]).toString('base64')
    const r = await hook(token, postmark('billing@vendor.com', address, { Attachments: [{ Name: 'scan.pdf', ContentType: 'application/pdf', Content: big }, { Name: 'small.pdf', ContentType: 'application/pdf', Content: PDF }] }))
    expect(r.status).toBe(200)
    const body = (await r.json()) as { accepted: number; skipped: Array<{ name: string; reason: string }> }
    expect(body.accepted).toBe(1)
    expect(body.skipped[0]).toMatchObject({ name: 'scan.pdf' })
    expect(body.skipped[0]!.reason).toMatch(/too large/)
    const huge = Buffer.alloc(31 * 1024 * 1024, 0x41).toString('base64')
    expect((await hook(token, postmark('billing@vendor.com', address, { Attachments: [{ Name: 'x.pdf', Content: huge }] }))).status).toBe(413)
    // Other routes keep the 8 MB limit.
    expect((await app.request('/api/preferences', { method: 'PATCH', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify({ theme: 'x'.repeat(9 * 1024 * 1024) }) })).status).toBe(413)
  })
})

describe('parsing', () => {
  it('reads addresses, verdicts and allowlists', () => {
    expect(addressOf('Jane Doe <Jane@Acme.com>')).toBe('jane@acme.com')
    expect(senderAllowed('a@acme.com', ['@acme.com'])).toBe(true)
    expect(senderAllowed('a@acme.com', ['acme.com'])).toBe(true)
    expect(senderAllowed('a@evilacme.com', ['acme.com'])).toBe(false)
    expect(senderAllowed('a@acme.com', ['b@acme.com'])).toBe(false)
    expect(senderAllowed('a@acme.com', [])).toBe(false)
    expect(authFailed({ spf: 'fail', dkim: 'pass' })).toBeNull()
    expect(authFailed({ spf: 'softfail' })).toMatch(/SPF/)
    const m = parseInbound(postmark('x@y.com', 'to@in.example.com'))
    expect(m.auth).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass' })
    expect(() => parseInbound({ from: 'a@b.c', attachments: [{ content: '<script>' }] })).toThrow(/base64/)
  })
})

describe('email-in: members can send without being listed', () => {
  it('accepts the owner’s sign-in address with an empty list, still checks DMARC, and logs refusals', async () => {
    const { cookie, companyId, address, token } = await setup()
    const view = (await (await app.request(`/api/inbound/${companyId}`, { headers: { cookie } })).json()) as { members: Array<{ email: string }>; extra: string[] }
    expect(view.members.map((m) => m.email)).toEqual(['founder@example.com'])
    expect(view.extra).toEqual([])

    const mine = await hook(token, postmark('Founder@Example.com', address))
    expect(((await mine.json()) as { accepted: number }).accepted).toBe(1)
    // Their domain isn't allowed, only their address.
    expect(await (await hook(token, postmark('someone@example.com', address))).json()).toMatchObject({ accepted: 0, reason: 'sender not allowed' })
    // A forged copy of the owner's address is still refused.
    const forged = postmark('founder@example.com', address, { Headers: [{ Name: 'Authentication-Results', Value: 'mx.example; dkim=fail; spf=fail; dmarc=fail' }] })
    expect(((await (await hook(token, forged)).json()) as { accepted: number }).accepted).toBe(0)

    const log = (await booted.handle.db.selectFrom('activity_log' as never).select(['detail' as never, 'status' as never]).where('action' as never, '=', 'email.received' as never).execute()) as Array<{ detail: string; status: string }>
    expect(log.map((l) => l.detail)).toContain('Email from someone@example.com refused: not an allowed sender')
    const again = (await (await app.request(`/api/inbound/${companyId}`, { headers: { cookie } })).json()) as { recentRefused: Array<{ from: string; reason: string }> }
    expect(again.recentRefused[0]).toMatchObject({ from: 'founder@example.com' }) // newest first: the forged one
    expect(again.recentRefused[1]).toMatchObject({ from: 'someone@example.com', reason: 'not an allowed sender' })

    // Unread documents are listed by default.
    const unread = (await (await app.request('/api/documents', { headers: { cookie } })).json()) as Array<{ entityId: string; arrivedVia: string; name: string }>
    expect(unread).toEqual([expect.objectContaining({ entityId: companyId, arrivedVia: 'email', name: 'invoice-77.pdf' })])
    expect((await app.request('/api/documents?state=bogus', { headers: { cookie } })).status).toBe(400)

    // Extra senders are saved under extra (allowedSenders still works).
    const put = (await (await app.request(`/api/inbound/${companyId}`, req(cookie, 'PUT', { extra: ['@vendor.com'] }))).json()) as { extra: string[]; members: unknown[] }
    expect(put).toMatchObject({ extra: ['vendor.com'.replace(/^/, '@')], members: [expect.objectContaining({ email: 'founder@example.com' })] })
  })
})
