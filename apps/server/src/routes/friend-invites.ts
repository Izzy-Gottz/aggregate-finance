// "Invite someone" on the Workspace tab: a friend's own account (friend-invites.ts). Adding a teammate is /api/people.
import { withBypass } from '@agfn/db'
import { Hono, type Context } from 'hono'
import type { RequestPerson } from '../app.ts'
import { isDemoWorkspace } from '@agfn/demo'
import { allowInvites, ALL_PER_DAY, forgetInvite, friendCode, friendLink, inviteFriend, stopInvites, validStop } from '../friend-invites.ts'
import { clientIp } from '../security.ts'
import type { Services } from '../services.ts'

type Env = { Variables: { person: RequestPerson } }

const EMAIL = /^[^\s@<>,;"]{1,64}@[^\s@<>,;"]{1,190}\.[^\s@<>,;"]{2,}$/

export function friendInviteRoutes(s: Pick<Services, 'db' | 'mailer' | 'config'>): Hono<Env> {
  const app = new Hono<Env>()
  const refused = (c: { json: (b: unknown, status: 400 | 403 | 409 | 429 | 502 | 503) => Response }, status: 400 | 403 | 409 | 429 | 502 | 503, message: string) => c.json({ message }, status)

  app.get('/friend-invite', async (c) => {
    const { personId } = c.get('person')
    const code = await withBypass('friend-invite', () => friendCode(s.db, personId))
    return c.json({ link: friendLink(s.config.baseUrl, code) })
  })

  app.post('/friend-invite', async (c) => {
    const p = c.get('person')
    if (p.workspaceId && (await isDemoWorkspace(s.db, p.workspaceId))) return refused(c, 403, 'The demo can’t send invites.')
    if (!s.mailer) return refused(c, 503, 'Email isn’t set up on this server.')
    const { email } = await c.req.json<{ email?: unknown }>().catch(() => ({ email: undefined }))
    if (typeof email !== 'string' || !EMAIL.test(email.trim())) return refused(c, 400, 'That email doesn’t look right.')
    const mailer = s.mailer
    const dailyCap = s.config.friendInvitesPerDay ?? ALL_PER_DAY
    const invite = await withBypass('friend-invite', () => inviteFriend(s.db, { personId: p.personId, email, ip: clientIp(c.req.raw.headers, s.config.clientIpHeader), secret: s.config.authSecret, baseUrl: s.config.baseUrl, dailyCap }))
    // After answering: how long a send takes must not show whether there was one.
    if (invite) {
      setImmediate(() => {
        void mailer.send(invite.mail).catch(async (err: unknown) => {
          console.warn('[agfn] friend invite failed', { error: err instanceof Error ? err.message : 'unknown' })
          await withBypass('friend-invite', () => forgetInvite(s.db, invite.id)).catch(() => undefined)
        })
      })
    }
    return c.json({ ok: true })
  })
  return app
}

const page = (body: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Aggregate</title><body style="font:15px system-ui;margin:48px auto;max-width:420px;padding:0 16px">${body}`
const button = (h: string, s: string, action: 'stop' | 'allow', label: string) => `<form method="post" action="/invites/stop"><input type="hidden" name="h" value="${h}"><input type="hidden" name="s" value="${s}"><input type="hidden" name="action" value="${action}"><button type="submit">${label}</button></form>`

/**
 * The link in an invite email, with no sign-in. Opening it only shows a button: mail scanners follow links, and a GET
 * that wrote would opt people out who never asked. The signature is checked first, and hash and signature are hex only.
 */
export function friendInviteStopRoutes(s: Pick<Services, 'db' | 'config'>): Hono {
  const app = new Hono()
  const noStore = { 'cache-control': 'no-store' }
  const refused = (c: Context) => c.html(page('<p>This link isn’t valid.</p>'), 404, noStore)

  app.get('/invites/stop', (c) => {
    const h = c.req.query('h') ?? ''
    const sig = c.req.query('s') ?? ''
    if (!validStop(s.config.authSecret, h, sig)) return refused(c)
    return c.html(page(`<p>Stop getting invites to Aggregate at this address?</p>${button(h, sig, 'stop', 'Don’t send me invites')}`), 200, noStore)
  })

  app.post('/invites/stop', async (c) => {
    const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>))
    const h = String(form.h ?? '')
    const sig = String(form.s ?? '')
    if (!validStop(s.config.authSecret, h, sig)) return refused(c)
    if (form.action === 'allow') {
      await withBypass('friend-invite', () => allowInvites(s.db, h))
      return c.html(page(`<p>Done. People can invite you again.</p>${button(h, sig, 'stop', 'Don’t send me invites')}`), 200, noStore)
    }
    await withBypass('friend-invite', () => stopInvites(s.db, h))
    return c.html(page(`<p>Done. You won’t get any more invites to Aggregate.</p>${button(h, sig, 'allow', 'Undo')}`), 200, noStore)
  })
  return app
}
