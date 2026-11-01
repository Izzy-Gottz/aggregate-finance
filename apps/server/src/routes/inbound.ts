// Email-in (MASTER §2 "Add what can't connect"): each company gets a secret address. Forwarded bills and receipts
// arrive from the email provider's webhook, and their attachments become unread documents for the person's AI.
// Accepts Postmark's inbound JSON and a generic JSON (what a Cloudflare Email Worker posts; see docs below).

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { Kysely } from 'kysely'
import { nowIso, withBypass, withWorkspace, type CoreTables } from '@agfn/db'
import { appendActivity } from '@agfn/mcp'
import type { RequestPerson } from '../app.ts'
import type { Services } from '../services.ts'
import { UploadError } from '../documents.ts'

type Env = { Variables: { person: RequestPerson } }

export interface InboundAddress {
  entityId: string
  address: string
}

interface InboundConfig {
  token: string
  allowedSenders: string[]
}

export interface InboundEmail {
  from: string
  to: string[]
  subject: string
  messageId: string | null
  attachments: Array<{ filename: string; contentType: string; bytes: Uint8Array }>
  /**
   * Provider verdicts. dkimDomains: domains whose DKIM signature passed (header.d); spfDomain: the envelope sender's
   * domain SPF passed for. Absent when the provider doesn't say (its verdict is then taken as is).
   */
  auth: { spf?: string; dkim?: string; dmarc?: string; dkimDomains?: string[]; spfDomain?: string }
}

const MAX_ATTACHMENTS = 10
const MAX_INBOUND_FILE_BYTES = 8 * 1024 * 1024
const TOKEN_RE = /^[a-z0-9]{1,20}-[a-z0-9]{16}$/

function reply(status: number, body: Record<string, unknown>): never {
  throw new HTTPException(status as 400, { res: new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) })
}

const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '')

/** "Jane <jane@acme.com>" → "jane@acme.com". */
export function addressOf(v: string): string {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(v)
  return lower(m ? m[1] : v)
}

function verdict(text: string | undefined, key: 'spf' | 'dkim' | 'dmarc'): string | undefined {
  if (!text) return undefined
  const m = new RegExp(`\\b${key}=(\\w+)`, 'i').exec(text)
  return m?.[1]?.toLowerCase()
}

/** Which domains DKIM passed for (header.d=) and which envelope domain SPF passed for (smtp.mailfrom= / envelope-from=). */
function alignment(authResults: string | undefined, spfHeader: string | undefined): { dkimDomains?: string[]; spfDomain?: string } {
  const out: { dkimDomains?: string[]; spfDomain?: string } = {}
  if (authResults) {
    const parts = authResults.split(';').map((p) => p.trim())
    const dkim = parts.filter((p) => /^dkim=pass\b/i.test(p))
    const domains = dkim.map((p) => /\bheader\.d=([^\s;]+)/i.exec(p)?.[1]?.toLowerCase()).filter((d): d is string => Boolean(d))
    if (dkim.length && domains.length === dkim.length) out.dkimDomains = domains
    const spf = parts.find((p) => /^spf=pass\b/i.test(p))
    const mailfrom = spf && /\bsmtp\.mailfrom=([^\s;]+)/i.exec(spf)?.[1]
    if (mailfrom) out.spfDomain = lower(mailfrom.split('@').pop())
  }
  if (!out.spfDomain && spfHeader && /^pass\b/i.test(spfHeader.trim())) {
    const env = /\benvelope-from=["<]?([^\s;">]+)/i.exec(spfHeader)?.[1]
    if (env) out.spfDomain = lower(env.split('@').pop())
  }
  return out
}

function b64(content: unknown): Uint8Array {
  if (typeof content !== 'string' || !/^[A-Za-z0-9+/=\s]*$/.test(content)) throw new Error('attachment content must be base64')
  return new Uint8Array(Buffer.from(content, 'base64'))
}

/** Postmark inbound webhook JSON, or the generic shape: {from, to, subject, messageId?, attachments:[{filename, contentType, content}], auth?:{spf,dkim,dmarc}}. */
export function parseInbound(body: unknown): InboundEmail {
  if (!body || typeof body !== 'object') throw new Error('expected a JSON object')
  const b = body as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  if ('FromFull' in b || 'Attachments' in b || 'MessageID' in b) {
    const headers = Array.isArray(b.Headers) ? (b.Headers as Array<{ Name?: string; Value?: string }>) : []
    const h = (name: string) => headers.find((x) => lower(x.Name) === name)?.Value
    const authResults = h('authentication-results')
    const spfHeader = h('received-spf')
    return {
      from: addressOf(b.FromFull?.Email ?? b.From ?? ''),
      to: [...(Array.isArray(b.ToFull) ? b.ToFull.map((t: { Email?: string }) => lower(t.Email)) : []), lower(b.OriginalRecipient)].filter(Boolean),
      subject: String(b.Subject ?? '').slice(0, 300),
      messageId: typeof b.MessageID === 'string' ? b.MessageID : null,
      attachments: (Array.isArray(b.Attachments) ? b.Attachments : []).map((a: { Name?: string; ContentType?: string; Content?: string }) => ({ filename: String(a.Name ?? 'attachment'), contentType: String(a.ContentType ?? ''), bytes: b64(a.Content) })),
      auth: { spf: spfHeader ? spfHeader.trim().split(/\s/)[0]?.toLowerCase() : verdict(authResults, 'spf'), dkim: verdict(authResults, 'dkim'), dmarc: verdict(authResults, 'dmarc'), ...alignment(authResults, spfHeader) },
    }
  }
  return {
    from: addressOf(String(b.from ?? '')),
    to: (Array.isArray(b.to) ? b.to : [b.to]).map((t: unknown) => addressOf(String(t ?? ''))).filter(Boolean),
    subject: String(b.subject ?? '').slice(0, 300),
    messageId: typeof b.messageId === 'string' ? b.messageId : null,
    attachments: (Array.isArray(b.attachments) ? b.attachments : []).map((a: { filename?: string; contentType?: string; content?: string }) => ({ filename: String(a.filename ?? 'attachment'), contentType: String(a.contentType ?? ''), bytes: b64(a.content) })),
    auth: { spf: lower(b.auth?.spf) || undefined, dkim: lower(b.auth?.dkim) || undefined, dmarc: lower(b.auth?.dmarc) || undefined },
  }
}

/** Owner's allowlist: exact addresses or whole domains ("@acme.com" or "acme.com"). */
export function senderAllowed(from: string, allowed: string[]): boolean {
  const f = lower(from)
  const domain = f.split('@')[1] ?? ''
  return allowed.some((a) => {
    const x = lower(a)
    if (!x) return false
    if (x.includes('@') && !x.startsWith('@')) return x === f
    return domain === x.replace(/^@/, '')
  })
}

/** Relaxed alignment: the From domain is the authenticated domain or a subdomain of it. */
function aligned(fromDomain: string, d: string): boolean {
  return fromDomain === d || fromDomain.endsWith(`.${d}`)
}

/**
 * Forged mail is refused. DMARC pass is enough and DMARC fail is final. Without a DMARC verdict (the domain has no
 * policy), the mail must still be authenticated *as the From domain*: a DKIM pass for that domain or an SPF pass for
 * it. Someone else's valid signature doesn't count. When the provider doesn't name the domains, its verdict is used.
 */
export function authFailed(auth: InboundEmail['auth'], from = ''): string | null {
  if (auth.dmarc === 'pass') return null
  if (auth.dmarc === 'fail') return 'DMARC failed'
  const fromDomain = lower(from.split('@').pop())
  const dkimOk = auth.dkim === 'pass' && (!auth.dkimDomains || auth.dkimDomains.some((d) => aligned(fromDomain, d)))
  const spfOk = auth.spf === 'pass' && (!auth.spfDomain || aligned(fromDomain, auth.spfDomain))
  if (dkimOk || spfOk) return null
  if (auth.dkim === 'pass' || auth.spf === 'pass') return `signed by another domain, not ${fromDomain}`
  if (auth.spf === 'fail' || auth.spf === 'softfail') return 'SPF failed and no DKIM signature passed'
  return 'not authenticated as the sender'
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** The provider proves itself with the shared secret: Basic auth (Postmark) or x-agfn-inbound-secret (a Worker). */
function providerAuthorized(req: Request, secret: string): boolean {
  const header = req.headers.get('x-agfn-inbound-secret')
  if (header) return safeEqual(header, secret)
  const m = /^Basic\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')
  if (!m) return false
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf8')
  return safeEqual(decoded.slice(decoded.indexOf(':') + 1), secret)
}

async function getSetting<T>(db: Kysely<CoreTables>, ws: string, key: string): Promise<T | null> {
  const r = await db.selectFrom('settings').select('value_json').where('workspace_id', '=', ws).where('key', '=', key).executeTakeFirst()
  return r ? (JSON.parse(r.value_json) as T) : null
}

async function putSetting(db: Kysely<CoreTables>, ws: string, key: string, value: unknown): Promise<void> {
  const v = JSON.stringify(value)
  await db.insertInto('settings').values({ workspace_id: ws, key, value_json: v, updated_at: nowIso() }).onConflict((oc) => oc.columns(['workspace_id', 'key']).doUpdateSet({ value_json: v, updated_at: nowIso() })).execute()
}

function newToken(companyName: string): string {
  const slug = companyName.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '').slice(0, 20) || 'co'
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'
  const rnd = [...randomBytes(16)].map((b) => alphabet[b % alphabet.length]).join('')
  return `${slug}-${rnd}`
}

export function createInbound(s: Services, fetchImpl: typeof fetch = fetch) {
  const db = s.db

  async function configFor(ws: string, entityId: string, create: boolean): Promise<InboundConfig | null> {
    const existing = await getSetting<InboundConfig>(db, ws, `inbound:${entityId}`)
    if (existing || !create) return existing
    const e = await db.selectFrom('entities').select(['name', 'kind']).where('id', '=', entityId).where('workspace_id', '=', ws).executeTakeFirst()
    if (!e || e.kind !== 'company') return null
    const cfg: InboundConfig = { token: newToken(e.name), allowedSenders: [] }
    await putSetting(db, ws, `inbound:${entityId}`, cfg)
    await putSetting(db, ws, `inbound_token:${cfg.token}`, { entityId })
    return cfg
  }

  /**
   * People who may email this company's address without being listed: members (not revoked or expired) who can add
   * documents to it, by their sign-in email. Exact addresses only, never their domain.
   */
  async function memberSenders(ws: string, entityId: string): Promise<Array<{ personId: string; name: string; email: string }>> {
    const now = new Date().toISOString()
    const rows = await db
      .selectFrom('memberships')
      .innerJoin('people', 'people.id', 'memberships.person_id')
      .select(['people.id as personId', 'people.name', 'people.email', 'memberships.expires_at'])
      .where('memberships.workspace_id', '=', ws)
      .where('memberships.revoked_at', 'is', null)
      .execute()
    const out: Array<{ personId: string; name: string; email: string }> = []
    for (const r of rows) {
      if ((r.expires_at && r.expires_at <= now) || !r.email || r.email.endsWith('@invalid')) continue
      if (!(await s.permissions.can({ kind: 'person', personId: r.personId, workspaceId: ws }, 'add', entityId, 'documents'))) continue
      if (!out.some((o) => o.personId === r.personId)) out.push({ personId: r.personId, name: r.name, email: lower(r.email) })
    }
    return out
  }

  /** Workspace.inbound: one address per company the person can add documents to. Empty when email-in isn't configured. */
  async function addresses(ws: string, personId: string): Promise<InboundAddress[]> {
    const domain = s.config.inboundEmailDomain
    if (!domain) return []
    const out: InboundAddress[] = []
    for (const e of await s.permissions.entitiesFor(ws, personId)) {
      if (e.kind !== 'company') continue
      if (!(await s.permissions.can({ kind: 'person', personId, workspaceId: ws }, 'add', e.id, 'documents'))) continue
      const cfg = await configFor(ws, e.id, true)
      if (cfg) out.push({ entityId: e.id, address: `${cfg.token}@${domain}` })
    }
    return out
  }

  async function receive(req: Request, token: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const secret = s.config.inboundWebhookSecret
    if (!secret || !s.config.inboundEmailDomain) return { status: 503, body: { message: 'Email-in is not configured on this server.' } }
    if (!providerAuthorized(req, secret)) return { status: 403, body: { message: 'not authorized' } }
    if (!TOKEN_RE.test(token)) return { status: 403, body: { message: 'unknown address' } }
    // The address names its workspace: find it under a narrow named bypass, then do everything else inside it
    // (row-level security, docs/security/rls.md).
    const hit = await withBypass('inbound:address', () => db.selectFrom('settings').select(['workspace_id', 'value_json']).where('key', '=', `inbound_token:${token}`).executeTakeFirst())
    if (!hit) return { status: 403, body: { message: 'unknown address' } }
    const ws = hit.workspace_id
    const { entityId } = JSON.parse(hit.value_json) as { entityId: string }
    return withWorkspace(ws, async () => {
      const cfg = await configFor(ws, entityId, false)
      if (!cfg || cfg.token !== token) return { status: 403, body: { message: 'unknown address' } }
      return deliver(req, ws, entityId, cfg)
    })
  }

  async function deliver(req: Request, ws: string, entityId: string, cfg: NonNullable<Awaited<ReturnType<typeof configFor>>>): Promise<{ status: number; body: Record<string, unknown> }> {
    let mail: InboundEmail
    try {
      mail = parseInbound(await req.json())
    } catch (err) {
      return { status: 400, body: { message: `unreadable email: ${(err as Error).message}` } }
    }
    return deliverMail(mail, ws, entityId, cfg)
  }

  /** Shared by every provider once the email is in hand: authentication, the sender list, then documents. */
  async function deliverMail(mail: InboundEmail, ws: string, entityId: string, cfg: NonNullable<Awaited<ReturnType<typeof configFor>>>, skippedEarly: Array<{ name: string; reason: string }> = []): Promise<{ status: number; body: Record<string, unknown> }> {
    const log = (status: 'ok' | 'denied', detail: string, reason?: string) =>
      appendActivity(db as never, { workspaceId: ws, actorKind: 'system', actorLabel: 'Email', action: 'email.received', targetType: 'entity', targetId: entityId, entityIds: [entityId], status, detail, ...(reason ? { args: { from: (addressOf(mail.from) || mail.from).slice(0, 200), reason } } : {}) }, new Date())

    // 200 for refusals so providers don't retry mail we will never accept.
    const forged = authFailed(mail.auth, mail.from)
    if (forged) {
      await log('denied', `Email from ${addressOf(mail.from) || mail.from} refused: ${forged}`, forged)
      return { status: 200, body: { accepted: 0, reason: forged } }
    }
    const members = (await memberSenders(ws, entityId)).map((m) => m.email)
    if (!senderAllowed(mail.from, [...members, ...cfg.allowedSenders])) {
      await log('denied', `Email from ${addressOf(mail.from) || mail.from} refused: not an allowed sender`, 'not an allowed sender')
      return { status: 200, body: { accepted: 0, reason: 'sender not allowed' } }
    }
    const accepted: Array<{ documentId: string; name: string }> = []
    const skipped: Array<{ name: string; reason: string }> = [...skippedEarly]
    for (const a of mail.attachments.slice(0, MAX_ATTACHMENTS)) {
      try {
        const r = await s.documents.upload({ workspaceId: ws, entityId, personId: null, filename: a.filename, bytes: a.bytes, arrivedVia: 'email' })
        accepted.push({ documentId: r.documentId, name: r.name })
      } catch (err) {
        if (err instanceof UploadError) skipped.push({ name: a.filename.slice(0, 120), reason: err.message })
        else throw err
      }
    }
    for (const a of mail.attachments.slice(MAX_ATTACHMENTS)) skipped.push({ name: a.filename.slice(0, 120), reason: `only ${MAX_ATTACHMENTS} files per email` })
    if (mail.attachments.length === 0 && !skippedEarly.length) skipped.push({ name: '(email body)', reason: 'no attachments; forward the bill or receipt as a file' })
    await log('ok', `from ${mail.from}: ${accepted.length} file(s) added${skipped.length ? `, ${skipped.length} skipped` : ''}`)
    return { status: 200, body: { accepted: accepted.length, documents: accepted, skipped } }
  }

  /**
   * Resend inbound: one webhook for the whole domain, signed with Svix. The event carries metadata only, so the
   * sender, authentication results and files come from Resend's API with RESEND_API_KEY.
   */
  async function receiveResend(req: Request): Promise<{ status: number; body: Record<string, unknown> }> {
    const domain = s.config.inboundEmailDomain
    const secret = s.config.resendWebhookSecret
    const apiKey = s.config.resendApiKey
    if (!domain || !secret || !apiKey) return { status: 503, body: { message: 'Resend email-in is not configured on this server.' } }
    const raw = await req.text()
    if (!verifySvix(req.headers, raw, secret)) return { status: 403, body: { message: 'not authorized' } }
    let evt: { type?: string; data?: { email_id?: string; to?: string[]; received_for?: string[]; cc?: string[] } }
    try {
      evt = JSON.parse(raw) as typeof evt
    } catch {
      return { status: 400, body: { message: 'unreadable event' } }
    }
    if (evt.type !== 'email.received') return { status: 200, body: { ignored: evt.type ?? 'unknown' } }
    const emailId = evt.data?.email_id ?? ''
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(emailId)) return { status: 400, body: { message: 'missing email id' } }
    const token = [...(evt.data?.received_for ?? []), ...(evt.data?.to ?? []), ...(evt.data?.cc ?? [])]
      .map((a) => addressOf(a))
      .filter((a) => a.endsWith(`@${domain}`))
      .map((a) => a.slice(0, a.indexOf('@')))
      .find((t) => TOKEN_RE.test(t))
    // 200 so Resend doesn't retry mail that isn't for one of our addresses.
    if (!token) return { status: 200, body: { accepted: 0, reason: 'not one of our addresses' } }
    const hit = await withBypass('inbound:address', () => db.selectFrom('settings').select(['workspace_id', 'value_json']).where('key', '=', `inbound_token:${token}`).executeTakeFirst())
    if (!hit) return { status: 200, body: { accepted: 0, reason: 'unknown address' } }
    const ws = hit.workspace_id
    const { entityId } = JSON.parse(hit.value_json) as { entityId: string }
    return withWorkspace(ws, async () => {
      const cfg = await configFor(ws, entityId, false)
      if (!cfg || cfg.token !== token) return { status: 200, body: { accepted: 0, reason: 'unknown address' } }
      const api = async (path: string) => {
        const r = await fetchImpl(`https://api.resend.com${path}`, { headers: { authorization: `Bearer ${apiKey}` } })
        if (!r.ok) throw new Error(`Resend API ${r.status}`)
        return (await r.json()) as Record<string, unknown>
      }
      const email = await api(`/emails/receiving/${emailId}`)
      const auth = (email.authentication ?? {}) as { spf?: string; dkim?: string; dmarc?: string }
      const list = await api(`/emails/receiving/${emailId}/attachments?limit=${MAX_ATTACHMENTS}`)
      const items = (Array.isArray(list.data) ? list.data : []) as Array<{ filename?: string; content_type?: string; size?: number; download_url?: string }>
      const attachments: InboundEmail['attachments'] = []
      const early: Array<{ name: string; reason: string }> = []
      for (const a of items.slice(0, MAX_ATTACHMENTS)) {
        const name = (a.filename ?? 'attachment').slice(0, 200)
        if ((a.size ?? 0) > MAX_INBOUND_FILE_BYTES) {
          early.push({ name: name.slice(0, 120), reason: 'That file is too large (8 MB max).' })
          continue
        }
        if (!a.download_url || !a.download_url.startsWith('https://')) {
          early.push({ name: name.slice(0, 120), reason: 'no download link' })
          continue
        }
        const r = await fetchImpl(a.download_url)
        if (!r.ok) {
          early.push({ name: name.slice(0, 120), reason: `download failed (${r.status})` })
          continue
        }
        attachments.push({ filename: name, contentType: a.content_type ?? 'application/octet-stream', bytes: new Uint8Array(await r.arrayBuffer()) })
      }
      const mail: InboundEmail = {
        from: addressOf(String(email.from ?? '')),
        to: (Array.isArray(email.to) ? email.to : []).map((x) => String(x)),
        subject: String(email.subject ?? '').slice(0, 300),
        messageId: typeof email.message_id === 'string' ? email.message_id : null,
        attachments,
        auth: { ...(auth.spf ? { spf: auth.spf } : {}), ...(auth.dkim ? { dkim: auth.dkim } : {}), ...(auth.dmarc ? { dmarc: auth.dmarc } : {}) },
      }
      return deliverMail(mail, ws, entityId, cfg, early)
    })
  }

  return { configFor, addresses, memberSenders, receive, receiveResend }
}

/**
 * Svix webhook signatures (Resend): HMAC-SHA256 over "<svix-id>.<svix-timestamp>.<raw body>" with the base64 key after
 * "whsec_"; the header lists "v1,<base64>" entries separated by spaces. Timestamps more than 5 minutes off are refused.
 */
export function verifySvix(headers: Headers, body: string, secret: string, now: Date = new Date()): boolean {
  const id = headers.get('svix-id')
  const ts = headers.get('svix-timestamp')
  const sigs = headers.get('svix-signature')
  if (!id || !ts || !sigs || !/^\d{1,12}$/.test(ts)) return false
  if (Math.abs(now.getTime() / 1000 - Number(ts)) > 300) return false
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64')
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')
  return sigs.split(' ').some((s) => {
    const [v, sig] = s.split(',')
    return v === 'v1' && typeof sig === 'string' && safeEqual(sig, expected)
  })
}

/** Provider webhook: mount BEFORE the session middleware (it has no session). */
export function inboundWebhookRoutes(s: Services, opts: { fetch?: typeof fetch } = {}): Hono {
  const app = new Hono()
  const inbound = createInbound(s, opts.fetch)
  // Resend posts every inbound email for the domain here (before :token so the name never reads as a token).
  app.post('/inbound/email/resend', async (c) => {
    const r = await inbound.receiveResend(c.req.raw)
    return c.json(r.body, r.status as 200)
  })
  app.post('/inbound/email/:token', async (c) => {
    const r = await inbound.receive(c.req.raw, c.req.param('token'))
    return c.json(r.body, r.status as 200)
  })
  return app
}

/** Session routes: see and set who may email each company, rotate the address. */
export function inboundRoutes(s: Services): Hono<Env> {
  const app = new Hono<Env>()
  const inbound = createInbound(s)
  const ctx = async (c: Context<Env>, manage: boolean) => {
    const p = c.get('person')
    if (!p.workspaceId) reply(409, { error: 'onboarding', message: 'Create your first company to get started.' })
    const entityId = c.req.param('entityId') ?? ''
    const ok = manage ? await s.permissions.canManageWorkspace(p.workspaceId, p.personId) : await s.permissions.can({ kind: 'person', personId: p.personId, workspaceId: p.workspaceId }, 'add', entityId, 'documents')
    if (!ok) reply(403, { error: 'forbidden', message: manage ? 'Only an owner or admin can change this.' : 'You can’t add documents to this company.' })
    if (!s.config.inboundEmailDomain) reply(503, { message: 'Email-in is not configured on this server.' })
    const cfg = await inbound.configFor(p.workspaceId, entityId, true)
    if (!cfg) reply(404, { message: 'No such company.' })
    return { ws: p.workspaceId, entityId, cfg }
  }
  // Who can email the address: members who can add documents (automatic) plus extra addresses or domains the owner
  // listed. allowedSenders is the same list as extra (older clients).
  const view = async (ws: string, entityId: string, cfg: InboundConfig) => ({
    entityId,
    address: `${cfg.token}@${s.config.inboundEmailDomain}`,
    members: await inbound.memberSenders(ws, entityId),
    extra: cfg.allowedSenders,
    allowedSenders: cfg.allowedSenders,
    recentRefused: await recentRefused(s, ws, entityId),
  })
  app.get('/inbound/:entityId', async (c) => {
    const { ws, entityId, cfg } = await ctx(c, false)
    return c.json(await view(ws, entityId, cfg))
  })
  app.put('/inbound/:entityId', async (c) => {
    const { ws, entityId, cfg } = await ctx(c, true)
    const b = (await c.req.json().catch(() => null)) as { allowedSenders?: unknown; extra?: unknown } | null
    const given = b?.extra ?? b?.allowedSenders
    const list = Array.isArray(given) ? (given as unknown[]).map((x) => lower(x)).filter(Boolean) : null
    if (!list || list.length > 100 || list.some((x) => !/^(@?[a-z0-9.-]+\.[a-z]{2,}|[^\s@]+@[a-z0-9.-]+\.[a-z]{2,})$/.test(x))) reply(400, { message: 'List email addresses or domains (like @acme.com), up to 100.' })
    const next = { ...cfg, allowedSenders: [...new Set(list)] }
    await putSetting(s.db, ws, `inbound:${entityId}`, next)
    return c.json(await view(ws, entityId, next))
  })
  app.post('/inbound/:entityId/rotate', async (c) => {
    const { ws, entityId, cfg } = await ctx(c, true)
    const e = await s.db.selectFrom('entities').select('name').where('id', '=', entityId).executeTakeFirstOrThrow()
    const next = { ...cfg, token: newToken(e.name) }
    await s.db.deleteFrom('settings').where('workspace_id', '=', ws).where('key', '=', `inbound_token:${cfg.token}`).execute()
    await putSetting(s.db, ws, `inbound_token:${next.token}`, { entityId })
    await putSetting(s.db, ws, `inbound:${entityId}`, next)
    return c.json(await view(ws, entityId, next))
  })
  return app
}

/** The last 5 emails to this company's address that were refused (forged or not an allowed sender). */
async function recentRefused(s: Services, ws: string, entityId: string): Promise<Array<{ at: string; from: string; reason: string }>> {
  const anyDb = s.db as unknown as Kysely<Record<string, Record<string, unknown>>>
  const rows = (await anyDb
    .selectFrom('activity_log')
    .select(['at', 'args_json', 'detail'])
    .where('workspace_id', '=', ws)
    .where('action', '=', 'email.received')
    .where('status', '=', 'denied')
    .where('target_id', '=', entityId)
    .orderBy('seq', 'desc')
    .limit(5)
    .execute()
    .catch(() => [])) as Array<{ at: string; args_json: string | null; detail: string | null }>
  return rows.map((r) => {
    const a = r.args_json ? (JSON.parse(r.args_json) as { from?: string; reason?: string }) : {}
    return { at: String(r.at), from: a.from ?? '', reason: a.reason ?? r.detail ?? 'refused' }
  })
}

/** For GET /api/workspace (Workspace.inbound). */
export async function inboundAddresses(s: Services, workspaceId: string, personId: string): Promise<InboundAddress[]> {
  return createInbound(s).addresses(workspaceId, personId)
}
