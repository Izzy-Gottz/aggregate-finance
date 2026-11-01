// Threat model #7 (CSRF / clickjacking): a page on another site makes the signed-in person's browser send writes.
// Every state-changing session route refuses requests without our Origin (or with Sec-Fetch-Site: cross-site), cookies
// are HttpOnly + SameSite, nothing can be framed, OAuth callbacks need their state, and /mcp never trusts cookies or
// grants credentialed CORS.
import { describe, expect, it } from 'vitest'
import { BASE, startServer } from '../scenarios/harness.ts'
import { asTest, victimWorld } from './world.ts'

const BLOCKED = /another site/

describe('red team: CSRF, origin and framing', () => {
  it('cross-site writes are refused on every session route; same-origin ones get through', async () => {
    const srv = await startServer()
    try {
      const v = await victimWorld(srv)
      const writes: Array<[string, string]> = [
        ['POST', '/api/workspaces'],
        ['POST', '/api/entities'],
        ['DELETE', '/api/workspace'],
        ['POST', '/api/demo'],
        ['DELETE', '/api/demo'],
        ['POST', '/api/accounts/assign'],
        ['POST', `/api/connections/${v.bankId}/sync`],
        ['POST', `/api/connections/${v.bankId}/disconnect`],
        ['POST', '/api/connectors/plaid/start'],
        ['POST', '/api/connectors/plaid/finish'],
        ['POST', '/api/documents'],
        ['POST', '/api/ai/keys'],
        ['POST', '/api/ai/pause-all'],
        ['PATCH', `/api/ai/${v.grantId}`],
        ['POST', `/api/ai/${v.grantId}/pause`],
        ['POST', `/api/ai/${v.grantId}/revoke`],
        ['POST', '/api/ai/consent'],
        ['POST', `/api/review/${v.reviewId}`],
        ['POST', '/api/entries/cash'],
        ['POST', `/api/records/${v.txnId}/undo`],
        ['PATCH', `/api/buckets/${v.bucketId}`],
        ['PATCH', '/api/preferences'],
        ['POST', '/api/people'],
        ['PATCH', `/api/people/${v.s.personId}`],
        ['POST', '/api/export'],
        ['PUT', `/api/inbound/${v.entityId}`],
        ['POST', `/api/inbound/${v.entityId}/rotate`],
        ['POST', `/api/entities/${v.entityId}/payroll-register`],
        ['POST', `/api/entities/${v.entityId}/equity/events`],
        ['POST', `/api/entities/${v.entityId}/equity/import`],
      ]
      const variants: Array<[string, Record<string, string>]> = [
        ['no origin', {}],
        ['evil origin', { origin: 'https://evil.example' }],
        ['look-alike origin', { origin: `${BASE}.evil.example` }],
        ['other port', { origin: BASE.replace('8787', '8788') }],
        ['null origin', { origin: 'null' }],
        ['cross-site fetch', { origin: BASE, 'sec-fetch-site': 'cross-site' }],
        ['same-site but not same-origin, no origin', { 'sec-fetch-site': 'same-site' }],
      ]
      for (const [method, path] of writes) {
        for (const [label, h] of variants) {
          const res = await srv.app.request(path, { method, headers: { cookie: v.s.cookie(), 'content-type': 'application/json', ...h }, body: '{}' })
          const text = await res.text()
          expect(res.status, `${method} ${path} (${label})`).toBe(403)
          expect(text, `${method} ${path} (${label})`).toMatch(BLOCKED)
        }
      }
      // Control: same-origin requests are not blocked by the CSRF check (harmless routes only; they may fail validation).
      for (const [method, path] of [['PATCH', '/api/preferences'], ['POST', '/api/entities'], ['POST', '/api/accounts/assign']]) {
        const ok = await srv.app.request(path as string, { method, headers: { cookie: v.s.cookie(), 'content-type': 'application/json', origin: BASE }, body: '{}' })
        expect(await ok.text(), `${method} ${path} (same origin)`).not.toMatch(BLOCKED)
      }
      // The victim's workspace survived all of it.
      expect((await v.s.get<{ entities: unknown[] }>('/api/workspace')).status).toBe(200)
      expect((await v.ai.try('get_metric', { metric: 'cash', company: 'Victim Co' })).isError).toBe(false)
    } finally {
      await srv.close()
    }
  }, 120_000)

  it('cookies, framing, auth endpoints, OAuth state and /mcp CORS', async () => {
    const srv = await startServer()
    try {
      // Session cookies: HttpOnly and SameSite.
      await srv.app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: 'c@csrf.example', callbackURL: '/' }) })
      const link = srv.outbox.at(-1)?.match(/https?:\/\/\S+/)?.[0] as string
      const res = await srv.app.request(link.replace(BASE, ''), { headers: { origin: BASE } })
      const cookies = res.headers.getSetCookie().filter((c) => /session/i.test(c) && !/=;/.test(c))
      expect(cookies.length).toBeGreaterThan(0)
      for (const c of cookies) {
        expect(c, c).toMatch(/HttpOnly/i)
        expect(c, c).toMatch(/SameSite=(Lax|Strict)/i)
      }
      // Open redirect: anyone can ask us to email a sign-in link to someone, but the link must never send them on to
      // another site after they click it — not when requested, and not when a crafted link is opened.
      const before = srv.outbox.length
      for (const cb of ['https://evil.example/steal', '//evil.example/steal', '/\\evil.example', 'javascript:alert(1)', `${BASE}.evil.example/x`]) {
        for (const origin of [BASE, 'https://evil.example']) {
          const r = await srv.app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ email: 'c@csrf.example', callbackURL: cb }) })
          expect(r.status, `${cb} from ${origin}`).toBe(400)
        }
        const token = new URL(link).searchParams.get('token') ?? 'x'
        const crafted = await srv.app.request(`/api/auth/magic-link/verify?token=${token}&callbackURL=${encodeURIComponent(cb)}`)
        expect(crafted.headers.get('location') ?? '', cb).not.toMatch(/evil|javascript/)
      }
      // The same through a form body (Better Auth's parser accepts forms), multipart, and a non-string value.
      const form = new URLSearchParams({ email: 'c@csrf.example', callbackURL: 'https://evil.example/steal' })
      const asForm = await srv.app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE }, body: form.toString() })
      expect(asForm.status).toBe(400)
      const multi = new FormData()
      multi.set('email', 'c@csrf.example')
      multi.set('callbackURL', 'https://evil.example/steal')
      expect((await srv.app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { origin: BASE }, body: multi })).status).toBe(400)
      const arr = await srv.app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: 'c@csrf.example', callbackURL: ['https://evil.example/steal'] }) })
      expect(arr.status).toBe(400)
      expect(srv.outbox.length).toBe(before)
      // Same-site paths are still fine.
      const fine = await srv.app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: 'c@csrf.example', callbackURL: '/settings' }) })
      expect(fine.status).toBe(200)

      // Nothing is frameable; every response carries the strict headers.
      for (const path of ['/', '/api/me', '/healthz', '/mcp']) {
        const r = await srv.app.request(path)
        await r.text()
        expect(r.headers.get('x-frame-options'), path).toBe('DENY')
        expect(r.headers.get('content-security-policy') ?? '', path).toMatch(/frame-ancestors 'none'|sandbox/)
        expect(r.headers.get('x-content-type-options'), path).toBe('nosniff')
      }

      // OAuth callbacks are GETs: without a state we issued, they do nothing.
      for (const q of ['', '?code=abc', '?code=abc&state=forged', '?state=forged&public_token=public-sandbox-x']) {
        const r = await srv.app.request(`/api/connectors/quickbooks/callback${q}`, { headers: { cookie: '' } })
        const text = await r.text()
        expect(r.status, q).not.toBe(200)
        expect(text, q).not.toMatch(/connected/i)
      }
      expect(await asTest(() => srv.booted.services.db.selectFrom('connections').select('id').execute())).toEqual([])

      // /mcp: no credentialed CORS for arbitrary sites.
      const pre = await srv.app.request('/mcp', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' } })
      await pre.text()
      const acao = pre.headers.get('access-control-allow-origin')
      expect(acao === 'https://evil.example' && pre.headers.get('access-control-allow-credentials') === 'true').toBe(false)
    } finally {
      await srv.close()
    }
  }, 120_000)
})
