import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import nodemailer from 'nodemailer'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { MemoryFileStore } from '@agfn/files'
import { boot, type Booted } from '../boot.ts'
import { createApp } from '../app.ts'
import { loadConfig } from '../config.ts'
import { inboundWebhookRoutes, verifySvix } from './inbound.ts'

const BASE = 'http://localhost:8787'
const WHSEC = 'whsec_' + Buffer.from('resend-test-signing-key-32-bytes!').toString('base64')
let booted: Booted
let app: ReturnType<typeof createApp>
let outbox: Array<{ to: string; text: string }>

beforeEach(async () => {
  outbox = []
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent', INBOUND_EMAIL_DOMAIN: 'in.example.com', RESEND_WEBHOOK_SECRET: WHSEC, RESEND_API_KEY: 're_test' }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), fileStore: new MemoryFileStore(), mailer: { send: async (m) => void outbox.push({ to: m.to, text: m.text }) } })
  app = createApp(booted.services)
})
afterEach(() => booted.shutdown())

function sign(body: string, at = Math.floor(Date.now() / 1000), id = 'msg_1') {
  const sig = createHmac('sha256', Buffer.from(WHSEC.slice(6), 'base64')).update(`${id}.${at}.${body}`).digest('base64')
  return { 'svix-id': id, 'svix-timestamp': String(at), 'svix-signature': `v1,bm9wZQ== v1,${sig}`, 'content-type': 'application/json' }
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF')

/** A fake Resend API: the received email, its attachment list and one download. */
function resendApi(opts: { dmarc?: string; from?: string } = {}) {
  const calls: string[] = []
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(url)
    if (url.startsWith('https://api.resend.com/')) {
      if (new Headers(init?.headers).get('authorization') !== 'Bearer re_test') return new Response('no', { status: 401 })
      if (url.endsWith('/attachments?limit=10'))
        return Response.json({ object: 'list', has_more: false, data: [{ id: 'a1', filename: 'bill.pdf', size: PDF.length, content_type: 'application/pdf', download_url: 'https://files.resend.example/a1' }, { id: 'a2', filename: 'huge.pdf', size: 20 * 1024 * 1024, content_type: 'application/pdf', download_url: 'https://files.resend.example/a2' }] })
      return Response.json({ object: 'email', id: 'em_1', from: opts.from ?? 'billing@vendor.com', to: ['x'], subject: 'Bill', message_id: '<m@x>', authentication: { spf: 'pass', dkim: 'pass', dmarc: opts.dmarc ?? 'pass' } })
    }
    if (url === 'https://files.resend.example/a1') return new Response(PDF)
    return new Response('?', { status: 404 })
  }) as typeof fetch
  return { f, calls }
}

async function setup(cookieEmail = 'founder@example.com') {
  await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: cookieEmail, callbackURL: '/' }) })
  const link = outbox.at(-1)!.text.match(/https?:\/\/\S+/)![0]
  const res = await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  const req = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { 'content-type': 'application/json', origin: BASE, cookie }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const { companyId } = (await (await req('POST', '/api/workspaces', { companyName: 'Acme' })).json()) as { companyId: string }
  const ws = (await (await req('GET', '/api/workspace')).json()) as { inbound: Array<{ entityId: string; address: string }> }
  await req('PUT', `/api/inbound/${companyId}`, { allowedSenders: ['@vendor.com'] })
  return { companyId, address: ws.inbound.find((i) => i.entityId === companyId)!.address }
}

describe('Resend email-in', () => {
  it('verifies the Svix signature, fetches the email and its files, and files allowed mail as documents', async () => {
    const { companyId, address } = await setup()
    const api = resendApi()
    const hook = new Hono().route('/api', inboundWebhookRoutes(booted.services, { fetch: api.f }))
    const event = JSON.stringify({ type: 'email.received', created_at: '2026-10-10T00:00:00Z', data: { email_id: 'em_1', from: 'billing@vendor.com', to: [`Acme Bills <${address}>`], received_for: [address], subject: 'Bill', attachments: [] } })

    // Unsigned, badly signed, or stale: refused before any API call.
    expect((await hook.request('/api/inbound/email/resend', { method: 'POST', body: event })).status).toBe(403)
    expect((await hook.request('/api/inbound/email/resend', { method: 'POST', headers: { ...sign(event), 'svix-signature': 'v1,AAAA' }, body: event })).status).toBe(403)
    expect((await hook.request('/api/inbound/email/resend', { method: 'POST', headers: sign(event, Math.floor(Date.now() / 1000) - 3600), body: event })).status).toBe(403)
    expect(api.calls).toEqual([])

    const r = await hook.request('/api/inbound/email/resend', { method: 'POST', headers: sign(event), body: event })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { accepted: number; skipped: Array<{ name: string; reason: string }> }
    expect(body.accepted).toBe(1)
    expect(body.skipped).toEqual([{ name: 'huge.pdf', reason: 'That file is too large (8 MB max).' }])
    expect(api.calls).not.toContain('https://files.resend.example/a2') // the big one is never downloaded
    const docs = await booted.handle.db.selectFrom('documents').selectAll().where('entity_id', '=', companyId).execute()
    expect(docs).toMatchObject([{ arrived_via: 'email', original_name: 'bill.pdf' }])

    // Other events and other domains are acknowledged and ignored.
    const other = JSON.stringify({ type: 'email.sent', data: {} })
    expect(await (await hook.request('/api/inbound/email/resend', { method: 'POST', headers: sign(other), body: other })).json()).toEqual({ ignored: 'email.sent' })
    const stranger = JSON.stringify({ type: 'email.received', data: { email_id: 'em_2', to: ['someone@else.com'] } })
    expect(await (await hook.request('/api/inbound/email/resend', { method: 'POST', headers: sign(stranger), body: stranger })).json()).toMatchObject({ accepted: 0, reason: 'not one of our addresses' })
  })

  it('refuses forged mail using Resend’s DMARC result', async () => {
    const { address } = await setup()
    const api = resendApi({ dmarc: 'fail' })
    const hook = new Hono().route('/api', inboundWebhookRoutes(booted.services, { fetch: api.f }))
    const event = JSON.stringify({ type: 'email.received', data: { email_id: 'em_1', to: [address] } })
    expect(await (await hook.request('/api/inbound/email/resend', { method: 'POST', headers: sign(event), body: event })).json()).toMatchObject({ accepted: 0, reason: 'DMARC failed' })
  })

  it('verifySvix follows the Svix scheme', () => {
    const body = '{"a":1}'
    const h = new Headers(sign(body, 1_760_000_000))
    expect(verifySvix(h, body, WHSEC, new Date(1_760_000_000_000))).toBe(true)
    expect(verifySvix(h, body + ' ', WHSEC, new Date(1_760_000_000_000))).toBe(false)
    expect(verifySvix(h, body, WHSEC, new Date(1_760_000_000_000 + 301_000))).toBe(false)
  })
})

describe('Resend SMTP', () => {
  it('SMTP_URL in Resend’s form parses to implicit TLS on 465 with the API key as password', () => {
    const t = nodemailer.createTransport('smtps://resend:re_123abc@smtp.resend.com:465') as unknown as { options: { host: string; port: number; secure: boolean; auth: { user: string; pass: string } } }
    expect(t.options).toMatchObject({ host: 'smtp.resend.com', port: 465, secure: true, auth: { user: 'resend', pass: 're_123abc' } })
  })
})
