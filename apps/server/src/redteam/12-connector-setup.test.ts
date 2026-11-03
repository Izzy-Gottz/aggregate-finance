// Connector setup (self-host guides): a connector whose app keys aren't set answers 409 not_configured on start and
// finish (never a half-working flow), no configured value (client secrets, webhook secrets, API keys, any env value)
// is ever echoed by a guide, an error body, a redirect or a log line, even when a provider reflects the request
// back at us, and the hosted service (AGFN_HOSTED=1) shows no self-host guides at all.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectorDescription } from '@agfn/contracts'
import { installedConnectors, setupGuide, unconfiguredConnectors } from '@agfn/connector-registry'
import { BASE, signIn, startServer, type Server, type Session } from '../scenarios/harness.ts'
import { asTest } from './world.ts'

/** Distinctive fake values: any of these showing up anywhere a person (or a log) can see is a leak. */
const SECRETS: Record<string, string> = {
  AUTH_SECRET: 'FAKEVAL-auth-secret-0123456789abcdefghijklmnop',
  PLAID_SECRET: 'FAKEVAL-plaid-secret-q1w2e3',
  QUICKBOOKS_CLIENT_SECRET: 'FAKEVAL-qbo-secret-r4t5y6',
  XERO_CLIENT_SECRET: 'FAKEVAL-xero-secret-u7i8o9',
  FRESHBOOKS_CLIENT_SECRET: 'FAKEVAL-freshbooks-secret-a1b2c3',
  FINCH_CLIENT_SECRET: 'FAKEVAL-finch-secret-p0a1s2',
  JUSTWORKS_CLIENT_SECRET: 'FAKEVAL-jw-secret-d3f4g5',
  MERCURY_CLIENT_SECRET: 'FAKEVAL-mercury-secret-h6j7',
  MERCURY_WEBHOOK_SECRET: 'FAKEVAL-mercury-hook-k8l9',
  BREX_CLIENT_SECRET: 'FAKEVAL-brex-secret-z0x1',
  BREX_WEBHOOK_SECRET: 'FAKEVAL-brex-hook-c2v3',
  RAMP_CLIENT_SECRET: 'FAKEVAL-ramp-secret-b4n5',
  RAMP_WEBHOOK_SECRET: 'FAKEVAL-ramp-hook-m6q7',
  STRIPE_WEBHOOK_SECRET: 'whsec_FAKEVAL-stripe-hook-w8e9',
  STRIPE_APP_SECRET_KEY: 'sk_test_FAKEVAL-stripe-app-r0t1',
  PAYPAL_CLIENT_SECRET: 'FAKEVAL-paypal-secret-y2u3',
  PAYPAL_WEBHOOK_APP_CLIENT_SECRET: 'FAKEVAL-paypal-hook-secret-i4o5',
  SQUARE_CLIENT_SECRET: 'FAKEVAL-square-secret-p6a7',
  SQUARE_WEBHOOK_SIGNATURE_KEY: 'FAKEVAL-square-hook-s8d9',
  SHOPIFY_CLIENT_SECRET: 'FAKEVAL-shopify-secret-f0g1',
  SHOPIFY_WEBHOOK_SECRET: 'FAKEVAL-shopify-hook-h2j3',
  PADDLE_WEBHOOK_SECRET: 'FAKEVAL-paddle-hook-k4l5',
  LEMONSQUEEZY_WEBHOOK_SECRET: 'FAKEVAL-lemon-hook-z6x7',
  INBOUND_WEBHOOK_SECRET: 'FAKEVAL-inbound-hook-c8v9',
  RESEND_WEBHOOK_SECRET: `whsec_${Buffer.from('FAKEVAL-resend-hook-b0n1').toString('base64')}`,
  RESEND_API_KEY: 're_FAKEVAL-resend-key-m2q3',
  GOOGLE_CLIENT_SECRET: 'FAKEVAL-google-secret-w4e5',
}
/** Client ids are public (they ride in OAuth authorize URLs), but nothing else should repeat them. */
const IDS: Record<string, string> = {
  PLAID_CLIENT_ID: 'FAKEID-plaid-1a2b',
  QUICKBOOKS_CLIENT_ID: 'FAKEID-qbo-3c4d',
  XERO_CLIENT_ID: 'FAKEID-xero-5e6f',
  FRESHBOOKS_CLIENT_ID: 'FAKEID-freshbooks-7a8b',
  FINCH_CLIENT_ID: 'FAKEID-finch-7g8h',
  JUSTWORKS_CLIENT_ID: 'FAKEID-jw-9i0j',
  MERCURY_CLIENT_ID: 'FAKEID-mercury-1k2l',
  BREX_CLIENT_ID: 'FAKEID-brex-3m4n',
  RAMP_CLIENT_ID: 'FAKEID-ramp-5o6p',
  STRIPE_APP_CLIENT_ID: 'FAKEID-stripe-7q8r',
  PAYPAL_CLIENT_ID: 'FAKEID-paypal-9s0t',
  PAYPAL_PARTNER_MERCHANT_ID: 'FAKEID-paypal-merchant-1u2v',
  PAYPAL_WEBHOOK_APP_CLIENT_ID: 'FAKEID-paypal-hook-3w4x',
  PAYPAL_WEBHOOK_ID: 'FAKEID-paypal-webhook-5y6z',
  SQUARE_CLIENT_ID: 'FAKEID-square-7a8b',
  SHOPIFY_CLIENT_ID: 'FAKEID-shopify-9c0d',
  GOOGLE_CLIENT_ID: 'FAKEID-google-1e2f',
}
const ALL = { ...SECRETS, ...IDS }
const SECRET_VALUES = Object.values(SECRETS).map((v) => v.replace(/^whsec_/, '').replace(/^sk_test_/, '').replace(/^re_/, ''))
// The Resend secret is base64: look for its decoded marker too.
SECRET_VALUES.push('FAKEVAL-resend-hook-b0n1', 'FAKEVAL')

const seen: Array<{ where: string; text: string }> = []
let phase = ''
function record(where: string, x: unknown) {
  seen.push({ where: `${phase}${where}`, text: typeof x === 'string' ? x : JSON.stringify(x) ?? '' })
}
/** Every recorded response and log line, checked for any fake value. */
function leaks(opts: { idsAllowedIn?: (where: string, text: string) => boolean } = {}): string[] {
  const out: string[] = []
  for (const { where, text } of seen) {
    for (const v of SECRET_VALUES) if (text.includes(v)) out.push(`${where}: secret ${v}`)
    for (const v of Object.values(IDS)) if (text.includes(v) && !opts.idsAllowedIn?.(where, text)) out.push(`${where}: id ${v}`)
    // Basic-auth headers carry id:secret base64-encoded.
    for (const [k, v] of Object.entries(SECRETS)) {
      const b64 = Buffer.from(v).toString('base64').slice(0, 16)
      if (text.includes(b64)) out.push(`${where}: base64 of ${k}`)
    }
  }
  return out
}

function captureLogs() {
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const orig = console[m].bind(console)
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      record(`console.${m}`, a.map((x) => (x instanceof Error ? `${x.message} ${x.stack ?? ''} ${JSON.stringify((x as { cause?: unknown }).cause ?? '')}` : typeof x === 'string' ? x : JSON.stringify(x, (_k, v) => (v instanceof Error ? `${v.message} ${v.stack}` : v)))).join(' '))
      void orig
    })
  }
  for (const stream of [process.stdout, process.stderr]) {
    const orig = stream.write.bind(stream)
    vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      record('stdio', String(chunk))
      return (orig as (...a: unknown[]) => boolean)(chunk, ...rest)
    }) as never)
  }
}

/**
 * Outbound HTTP: a provider that refuses everything. `reflect` makes it hostile, echoing our request (URL, headers,
 * body) back in its error fields, the worst case for an error message that quotes the provider.
 */
function stubProviders(reflect: boolean) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const body = typeof init?.body === 'string' ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : ''
    const echo = reflect ? `${body} ${headers.get('authorization') ?? ''} ${[...headers].map(([k, v]) => `${k}=${v}`).join(' ')} ${url}` : 'invalid credentials'
    return new Response(JSON.stringify({ error: 'invalid_client', error_description: echo, error_code: 'INVALID_API_KEYS', error_type: 'INVALID_INPUT', error_message: echo, message: echo, detail: echo, request_id: 'req-1' }), { status: 400, headers: { 'content-type': 'application/json' } })
  })
}

async function withPasskey(srv: Server, email: string): Promise<void> {
  const db = srv.booted.services.db
  await asTest(async () => {
    const p = await db.selectFrom('people').select(['id', 'auth_user_id']).where('email', '=', email).executeTakeFirstOrThrow()
    const anyDb = db as unknown as import('kysely').Kysely<Record<string, Record<string, unknown>>>
    await anyDb.insertInto('passkey').values({ id: `pk_${p.id}`, name: 'Mac', publicKey: 'x', userId: p.auth_user_id, credentialID: `cred_${p.id}`, counter: 0, deviceType: 'singleDevice', backedUp: 0, transports: 'internal', createdAt: new Date().toISOString() }).execute()
    await db.insertInto('reauth_events').values({ id: `re_${p.id}`, person_id: p.id, method: 'passkey', at: new Date().toISOString() }).execute()
  })
}

async function owner(srv: Server, email: string): Promise<Session> {
  const s = await signIn(srv, email, 'Setup Co')
  await withPasskey(srv, email)
  return s
}

/** A raw request whose whole response (status, headers, body) is recorded. */
async function hit(srv: Server, s: Session | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await srv.app.request(path, {
    method,
    headers: { origin: BASE, ...(s ? { cookie: s.cookie() } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  record(`${method} ${path} ${res.status}`, `${[...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n')}\n${text}`)
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    /* not json */
  }
  return { status: res.status, body: json, location: res.headers.get('location') ?? '' }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  seen.length = 0
  phase = ''
})

const GUIDED = ['plaid', 'quickbooks', 'xero', 'freshbooks', 'finch', 'justworks']

describe('red team: connector setup', () => {
  it('a connector without keys answers 409 not_configured on start, finish and callback; unknown keys 404', async () => {
    captureLogs()
    // Half-configured on purpose: ids without secrets, so nothing is installed for them. Only the scripted
    // plaid/stripe/quickbooks are; xero, finch and justworks are guided.
    const srv = await startServer({ env: { XERO_CLIENT_ID: IDS.XERO_CLIENT_ID!, FINCH_CLIENT_ID: IDS.FINCH_CLIENT_ID!, JUSTWORKS_CLIENT_SECRET: SECRETS.JUSTWORKS_CLIENT_SECRET! } })
    try {
      const s = await owner(srv, 'setup@a.example')
      const list = await hit(srv, s, 'GET', '/api/connectors')
      const guides = (list.body as unknown as ConnectorDescription[]).filter((d) => d.setup && d.setup.configured === false).map((d) => d.key)
      expect(guides.sort()).toEqual(['finch', 'freshbooks', 'justworks', 'xero'])

      for (const key of ['xero', 'finch', 'justworks']) {
        const start = await hit(srv, s, 'POST', `/api/connectors/${key}/start`, {})
        expect(start.status, key).toBe(409)
        expect(start.body.error, key).toBe('not_configured')
        // Finish answers the same whatever the state: not a 400 that invites retrying.
        for (const state of [undefined, 'made-up-state']) {
          const fin = await hit(srv, s, 'POST', `/api/connectors/${key}/finish`, { ...(state ? { state } : {}), code: 'x' })
          expect(fin.status, `${key} finish ${state}`).toBe(409)
          expect(fin.body.error).toBe('not_configured')
        }
        // A state left over from before the keys were removed is no way in either.
        const leftover = `left-${key}`
        await asTest(() => srv.booted.services.db.insertInto('settings').values({ workspace_id: s.workspaceId, key: `connect_state:${leftover}`, value_json: JSON.stringify({ key, personId: s.personId, entityId: null, at: Date.now() }), updated_at: new Date().toISOString() }).execute())
        const late = await hit(srv, s, 'POST', `/api/connectors/${key}/finish`, { state: leftover, code: 'x' })
        expect(late.status).toBe(409)
        const cb = await hit(srv, s, 'GET', `/api/connectors/${key}/callback?code=x&state=nope`)
        expect(cb.status).toBe(302)
        expect(decodeURIComponent(cb.location)).toContain('needs its own app on this server')
      }
      const rows = await asTest(() => srv.booted.services.db.selectFrom('connections').select('id').where('workspace_id', '=', s.workspaceId).execute())
      expect(rows).toEqual([])

      for (const key of ['nope', '..%2Fplaid', 'PLAID', '__proto__', 'constructor']) {
        expect((await hit(srv, s, 'POST', `/api/connectors/${key}/start`, {})).status, key).toBe(404)
        expect((await hit(srv, s, 'POST', `/api/connectors/${key}/finish`, { state: 'x' })).status, key).toBe(404)
      }
      // A configured connector is unaffected.
      expect((await hit(srv, s, 'POST', '/api/connectors/stripe/start', {})).status).toBe(200)
      expect(leaks()).toEqual([])
    } finally {
      await srv.close()
    }
  }, 60_000)

  it('guides name env vars but never their values, wherever they are rendered', () => {
    // Every value set, but nothing installed: the guides must still only name the settings.
    const env = { ...ALL, BASE_URL: 'https://books.example.com' }
    const all = unconfiguredConnectors(env, [])
    expect(all.map((g) => g.key).sort()).toEqual([...GUIDED].sort())
    record('unconfiguredConnectors', all)
    for (const k of GUIDED) record(`setupGuide ${k}`, setupGuide(env, k))
    for (const g of all) for (const name of g.setup?.env ?? []) expect(name).toMatch(/^[A-Z][A-Z0-9_]+$/)
    expect(leaks()).toEqual([])
  })

  it('no secret or env value is echoed by start, finish, callbacks, webhooks or logs, even from a hostile provider', async () => {
    captureLogs()
    for (const reflect of [false, true]) {
      stubProviders(reflect)
      phase = reflect ? '[hostile] ' : '[refusing] '
      const env = { ...ALL, INBOUND_EMAIL_DOMAIN: 'in.example.com' }
      const srv = await startServer({ env, connectors: installedConnectors({ ...env, BASE_URL: BASE }) })
      try {
        expect(srv.booted.services.config.authSecret).toBe(SECRETS.AUTH_SECRET)
        const s = await owner(srv, `hostile${reflect ? 1 : 0}@a.example`)
        const list = await hit(srv, s, 'GET', '/api/connectors')
        const keys = (list.body as unknown as ConnectorDescription[]).map((d) => d.key)
        expect(keys).toEqual(expect.arrayContaining(GUIDED))
        for (const key of keys) {
          const start = await hit(srv, s, 'POST', `/api/connectors/${key}/start`, {})
          const state = typeof start.body.state === 'string' ? start.body.state : 'none'
          await hit(srv, s, 'POST', `/api/connectors/${key}/finish`, { state, publicToken: 'public-sandbox-x', code: 'c0de', realmId: '1', apiKey: 'k', token: 't', accessUrl: 'https://bridge.example/x', institution: { institution_id: 'ins_1', name: 'B' }, accounts: [{ mask: '0000' }] })
          const st2 = (await hit(srv, s, 'POST', `/api/connectors/${key}/start`, {})).body.state
          await hit(srv, s, 'GET', `/api/connectors/${key}/callback?code=c0de&realmId=1&state=${encodeURIComponent(String(st2 ?? 'x'))}`)
          await hit(srv, s, 'GET', `/api/connectors/${key}/callback?error=access_denied&error_description=nope`)
          await hit(srv, null, 'POST', `/api/webhooks/${key}`, '{"type":"x","id":"evt_1"}', { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=00', 'plaid-verification': 'eyJ.x.y', 'x-signature': '00' })
        }
        await hit(srv, null, 'POST', '/api/inbound/email/sometoken', '{}', { authorization: 'Bearer wrong' })
        await hit(srv, null, 'POST', '/api/inbound/email/resend', '{}', { 'svix-id': 'x', 'svix-timestamp': '1', 'svix-signature': 'v1,AAAA' })
        await hit(srv, s, 'GET', '/api/me')
        await hit(srv, s, 'GET', '/api/workspace')
        await hit(srv, s, 'GET', '/api/connections')
        await hit(srv, null, 'GET', '/.well-known/oauth-authorization-server')
        await hit(srv, null, 'GET', '/healthz')
      } finally {
        await srv.close()
      }
    }
    // Client ids may appear only inside an OAuth authorize URL (where the provider needs them).
    phase = ''
    const found = leaks({ idsAllowedIn: (where, text) => /^\[\w+\] POST \/api\/connectors\/[^/]+\/start 200$/.test(where) || (/callback|install/.test(where) && /location: https:\/\//.test(text)) })
    expect(found).toEqual([])
  }, 120_000)

  it('the hosted service (AGFN_HOSTED=1) shows no self-host guides and says nothing about setup', async () => {
    captureLogs()
    const srv = await startServer({ env: { AGFN_HOSTED: '1', PLAID_ENV: 'production', ...ALL } })
    try {
      expect(srv.booted.services.config.hosted).toBe(true)
      const s = await owner(srv, 'hosted@a.example')
      const list = await hit(srv, s, 'GET', '/api/connectors')
      const descs = list.body as unknown as ConnectorDescription[]
      expect(descs.some((d) => d.setup)).toBe(false)
      expect(descs.map((d) => d.key).sort()).toEqual(['files', 'plaid', 'quickbooks', 'stripe'])
      for (const key of ['xero', 'finch', 'justworks']) {
        const start = await hit(srv, s, 'POST', `/api/connectors/${key}/start`, {})
        expect(start.status).toBe(404)
        expect(start.body.error).toBeUndefined()
        expect((await hit(srv, s, 'POST', `/api/connectors/${key}/finish`, { state: 'x' })).status).toBe(404)
      }
      for (const { text } of seen) expect(text).not.toMatch(/CLIENT_SECRET|_CLIENT_ID|Intuit Developer|redirect URI shown here/)
      expect(leaks()).toEqual([])
    } finally {
      await srv.close()
    }
  }, 60_000)
})
