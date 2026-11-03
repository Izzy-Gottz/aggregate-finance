import { describe, expect, it } from 'vitest'
import { MemoryRawSink } from '@agfn/connector-sdk'
import { fakeClock, fixtureFetch } from '@agfn/connector-sdk/testing'
import type { ConnectBegin, Connector } from '@agfn/contracts'
import { installedConnectorList, installedConnectors, redirectUriFor, stripeFromEnv } from './index.ts'
import { allSetupGuides } from './setup.ts'

const deps = { raw: new MemoryRawSink() }

describe('connector registry', () => {
  it('skips connectors whose app credentials are missing', () => {
    const keys = installedConnectorList({}).map((c) => c.key)
    expect(keys).not.toContain('plaid')
    expect(keys).not.toContain('files')
    expect(keys).toEqual(expect.arrayContaining(['stripe', 'mercury', 'brex', 'ramp', 'wise', 'paypal', 'square', 'shopify', 'paddle', 'polar', 'lemonsqueezy', 'chargebee', 'revenuecat', 'woocommerce', 'appstore', 'googleplay']))
  })

  it('WooCommerce is installed on hosted too, where it refuses a key that can write; config.ts holds it back', async () => {
    expect(installedConnectorList({ AGFN_HOSTED: '1' }).map((c) => c.key)).toContain('woocommerce')
    const c = installedConnectors({ AGFN_HOSTED: '1' }).find((f) => f(deps).describe().key === 'woocommerce')!(deps)
    expect(c.describe()).toMatchObject({ name: 'WooCommerce', provides: ['reports'], auth: 'api_key' })
  })

  it('FreshBooks appears only with its OAuth app keys', () => {
    expect(installedConnectorList({}).map((c) => c.key)).not.toContain('freshbooks')
    expect(installedConnectorList({ FRESHBOOKS_CLIENT_ID: 'c', FRESHBOOKS_CLIENT_SECRET: 's' }).map((c) => c.key)).toContain('freshbooks')
  })

  it("hides Rippling on the hosted service (its terms forbid using a customer's token for them); self-hosters keep it", () => {
    expect(installedConnectorList({}).map((c) => c.key)).toContain('rippling')
    expect(installedConnectorList({ AGFN_HOSTED: '1' }).map((c) => c.key)).not.toContain('rippling')
  })

  it('hosted offers only read-only access: no Lemon Squeezy (keys can write), PayPal only through partner sign-in', () => {
    const hosted = (extra: Record<string, string> = {}) => installedConnectorList({ AGFN_HOSTED: '1', ...extra }).map((c) => c.key)
    expect(hosted()).not.toContain('lemonsqueezy')
    expect(hosted()).not.toContain('paypal')
    expect(hosted({ PAYPAL_CLIENT_ID: 'x', PAYPAL_CLIENT_SECRET: 'y', PAYPAL_PARTNER_MERCHANT_ID: 'z' })).toContain('paypal')
    expect(installedConnectorList({}).map((c) => c.key)).toEqual(expect.arrayContaining(['lemonsqueezy', 'paypal']))
  })

  it('Gumroad: self-hosters paste a generated token; hosted has none until Aggregate’s app is set, then read-only sign-in', async () => {
    expect(installedConnectorList({}).map((c) => c.key)).toContain('gumroad')
    expect(installedConnectorList({ AGFN_HOSTED: '1' }).map((c) => c.key)).not.toContain('gumroad')
    expect((await begin({}, 'gumroad')).kind).toBe('api_key')
    const hosted = { AGFN_HOSTED: '1', GUMROAD_CLIENT_ID: 'c', GUMROAD_CLIENT_SECRET: 's', BASE_URL: 'https://app.example.com' }
    const b = (await begin(hosted, 'gumroad')) as { kind: string; url: string }
    expect(b.kind).toBe('oauth')
    const u = new URL(b.url)
    expect(u.searchParams.get('scope')).toBe('view_sales view_payouts')
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/connectors/gumroad/callback')
  })

  it('Harvest: self-hosters paste a token; hosted has none until Aggregate’s app is set, then sign-in', async () => {
    expect(installedConnectorList({}).map((c) => c.key)).toContain('harvest')
    expect(installedConnectorList({ AGFN_HOSTED: '1' }).map((c) => c.key)).not.toContain('harvest')
    expect((await begin({}, 'harvest')).kind).toBe('api_key')
    const hosted = { AGFN_HOSTED: '1', HARVEST_CLIENT_ID: 'c', HARVEST_CLIENT_SECRET: 's', BASE_URL: 'https://app.example.com' }
    const b = (await begin(hosted, 'harvest')) as { kind: string; url: string }
    expect(b.kind).toBe('oauth')
    const u = new URL(b.url)
    expect(u.searchParams.get('scope')).toBeNull()
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/connectors/harvest/callback')
  })

  it('Patreon: self-hosters paste a Creator’s Access Token; hosted has none until Aggregate’s client is set, then sign-in with only the three scopes', async () => {
    expect(installedConnectorList({}).map((c) => c.key)).toContain('patreon')
    expect(installedConnectorList({ AGFN_HOSTED: '1' }).map((c) => c.key)).not.toContain('patreon')
    expect((await begin({}, 'patreon')).kind).toBe('api_key')
    const hosted = { AGFN_HOSTED: '1', PATREON_CLIENT_ID: 'c', PATREON_CLIENT_SECRET: 's', BASE_URL: 'https://app.example.com' }
    const b = (await begin(hosted, 'patreon')) as { kind: string; url: string }
    expect(b.kind).toBe('oauth')
    const u = new URL(b.url)
    expect(u.searchParams.get('scope')).toBe('identity campaigns campaigns.members')
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/connectors/patreon/callback')
  })

  it('Mollie: no app, no connector; with one, sign-in with only the two balance-read scopes', async () => {
    expect(installedConnectorList({}).map((c) => c.key)).not.toContain('mollie')
    const env = { MOLLIE_CLIENT_ID: 'app_c', MOLLIE_CLIENT_SECRET: 's', BASE_URL: 'https://app.example.com' }
    const b = (await begin(env, 'mollie')) as { kind: string; url: string }
    expect(b.kind).toBe('oauth')
    const u = new URL(b.url)
    expect(u.searchParams.get('scope')).toBe('balances.read balance-reports.read')
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/connectors/mollie/callback')
  })

  it('Whop: no app, no connector; with one, PKCE sign-in with only the balance-read scope', async () => {
    expect(installedConnectorList({}).map((c) => c.key)).not.toContain('whop')
    const env = { WHOP_CLIENT_ID: 'app_c', WHOP_CLIENT_SECRET: 's', BASE_URL: 'https://app.example.com' }
    const b = (await begin(env, 'whop')) as { kind: string; url: string }
    expect(b.kind).toBe('oauth')
    const u = new URL(b.url)
    expect(u.searchParams.get('scope')).toBe('company:balance:read')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/connectors/whop/callback')
  })

  it('OwnerRez: no app, no connector; with one, sign-in with only the read scope', async () => {
    expect(installedConnectorList({}).map((c) => c.key)).not.toContain('ownerrez')
    const env = { OWNERREZ_CLIENT_ID: 'c', OWNERREZ_CLIENT_SECRET: 's', BASE_URL: 'https://app.example.com' }
    const b = (await begin(env, 'ownerrez')) as { kind: string; url: string }
    expect(b.kind).toBe('oauth')
    const u = new URL(b.url)
    expect(u.searchParams.get('scope')).toBe('read')
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/connectors/ownerrez/callback')
  })

  it('Squarespace: no app, no connector; with one, sign-in with only the read permission', async () => {
    expect(installedConnectorList({}).map((c) => c.key)).not.toContain('squarespace')
    const env = { SQUARESPACE_CLIENT_ID: 'c', SQUARESPACE_CLIENT_SECRET: 's', BASE_URL: 'https://app.example.com' }
    const b = (await begin(env, 'squarespace')) as { kind: string; url: string }
    expect(b.kind).toBe('oauth')
    const u = new URL(b.url)
    expect(u.searchParams.get('scope')).toBe('website.transactions.read')
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/connectors/squarespace/callback')
  })

  it('Wix: no app, no connector; with one, the install link for that app, back to the callback', async () => {
    expect(installedConnectorList({}).map((c) => c.key)).not.toContain('wix')
    const env = { WIX_CLIENT_ID: 'c', WIX_CLIENT_SECRET: 's', BASE_URL: 'https://app.example.com' }
    const b = (await begin(env, 'wix')) as { kind: string; url: string }
    expect(b.kind).toBe('oauth')
    const u = new URL(b.url)
    expect(u.searchParams.get('appId')).toBe('c')
    expect(u.searchParams.get('postInstallationUrl')).toMatch(/^https:\/\/app\.example\.com\/api\/connectors\/wix\/callback\?state=/)
  })

  it('YouTube: no app, no connector; with one, sign-in with only the two read-only scopes', async () => {
    expect(installedConnectorList({}).map((c) => c.key)).not.toContain('youtube')
    const env = { YOUTUBE_CLIENT_ID: 'c', YOUTUBE_CLIENT_SECRET: 's', BASE_URL: 'https://app.example.com' }
    const b = (await begin(env, 'youtube')) as { kind: string; url: string }
    expect(b.kind).toBe('oauth')
    const u = new URL(b.url)
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics-monetary.readonly')
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/connectors/youtube/callback')
  })

  it('Pinterest: no app, no connector; with one, sign-in with only the read-only scope', async () => {
    expect(installedConnectorList({}).map((c) => c.key)).not.toContain('pinterest')
    const env = { PINTEREST_CLIENT_ID: 'c', PINTEREST_CLIENT_SECRET: 's', BASE_URL: 'https://app.example.com' }
    const b = (await begin(env, 'pinterest')) as { kind: string; url: string }
    expect(b.kind).toBe('oauth')
    const u = new URL(b.url)
    expect(u.searchParams.get('scope')).toBe('ads:read')
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/connectors/pinterest/callback')
  })
  it('AdSense: no app, no connector; with one, sign-in with only the read-only scope', async () => {
    expect(installedConnectorList({}).map((c) => c.key)).not.toContain('adsense')
    const env = { ADSENSE_CLIENT_ID: 'c', ADSENSE_CLIENT_SECRET: 's', BASE_URL: 'https://app.example.com' }
    const b = (await begin(env, 'adsense')) as { kind: string; url: string }
    expect(b.kind).toBe('oauth')
    const u = new URL(b.url)
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/adsense.readonly')
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/connectors/adsense/callback')
  })

  it('SumUp: self-hosters paste a key; hosted has none until Aggregate’s app is set, then sign-in with only the read scopes', async () => {
    expect(installedConnectorList({}).map((c) => c.key)).toContain('sumup')
    expect(installedConnectorList({ AGFN_HOSTED: '1' }).map((c) => c.key)).not.toContain('sumup')
    expect((await begin({}, 'sumup')).kind).toBe('api_key')
    const hosted = { AGFN_HOSTED: '1', SUMUP_CLIENT_ID: 'c', SUMUP_CLIENT_SECRET: 's', BASE_URL: 'https://app.example.com' }
    const b = (await begin(hosted, 'sumup')) as { kind: string; url: string }
    expect(b.kind).toBe('oauth')
    const u = new URL(b.url)
    expect(u.searchParams.get('scope')).toBe('transactions.history user.profile_readonly')
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/connectors/sumup/callback')
  })

  it('Lightspeed: self-hosters paste a token; hosted has none until Aggregate’s app is set, then sign-in', async () => {
    expect(installedConnectorList({}).map((c) => c.key)).toContain('lightspeed')
    expect(installedConnectorList({ AGFN_HOSTED: '1' }).map((c) => c.key)).not.toContain('lightspeed')
    expect((await begin({}, 'lightspeed')).kind).toBe('api_key')
    const hosted = { AGFN_HOSTED: '1', LIGHTSPEED_CLIENT_ID: 'c', LIGHTSPEED_CLIENT_SECRET: 's', BASE_URL: 'https://app.example.com' }
    const b = (await begin(hosted, 'lightspeed')) as { kind: string; url: string }
    expect(b.kind).toBe('oauth')
    const u = new URL(b.url)
    expect(u.searchParams.get('scope')).toBe('sales:read retailer:read payment_types:read')
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/connectors/lightspeed/callback')
  })

  it('hides BILL on the hosted service until it has a partner key (then shows it); Deel (live-checked) is offered on both', () => {
    expect(installedConnectorList({}).map((c) => c.key)).toEqual(expect.arrayContaining(['billcom', 'deel']))
    expect(installedConnectorList({ AGFN_HOSTED: '1' }).map((c) => c.key)).not.toContain('billcom')
    // Staging: BILL's sandbox partner key, stored as BILL_DEV_KEY with BILL_ENV=sandbox.
    expect(installedConnectorList({ AGFN_HOSTED: '1', BILL_DEV_KEY: 'p', BILL_ENV: 'sandbox' }).map((c) => c.key)).toContain('billcom')
    expect(installedConnectorList({ AGFN_HOSTED: '1' }).map((c) => c.key)).toContain('deel')
  })

  it('Expensify: self-hosted only (its credentials can write); the form asks for exactly what connect() reads', async () => {
    expect(installedConnectorList({}).map((c) => c.key)).toContain('expensify')
    expect(installedConnectorList({ AGFN_HOSTED: '1' }).map((c) => c.key)).not.toContain('expensify')
    expect(((await begin({}, 'expensify')) as { fields: Array<{ name: string }> }).fields.map((f) => f.name)).toEqual(['partnerUserID', 'partnerUserSecret'])
  })

  it('Coinbase: self-hosters paste a View-only key; hosted has no Coinbase until its OAuth client is set, then sign-in only', async () => {
    expect(installedConnectorList({}).map((c) => c.key)).toContain('coinbase')
    expect(installedConnectorList({ AGFN_HOSTED: '1' }).map((c) => c.key)).not.toContain('coinbase')
    expect(((await begin({}, 'coinbase')) as { fields: Array<{ name: string }> }).fields.map((f) => f.name)).toEqual(['keyName', 'privateKey'])
    const hosted = { AGFN_HOSTED: '1', COINBASE_CLIENT_ID: 'c', COINBASE_CLIENT_SECRET: 's', BASE_URL: 'https://app.example.com' }
    const b = (await begin(hosted, 'coinbase')) as { kind: string; url: string }
    expect(b.kind).toBe('oauth')
    expect(new URL(b.url).searchParams.get('redirect_uri')).toBe('https://app.example.com/api/connectors/coinbase/callback')
  })

  it('Polar: self-hosters paste an organization token; hosted has no Polar until its OAuth app is set, then sign-in only', async () => {
    expect(installedConnectorList({}).map((c) => c.key)).toContain('polar')
    expect(installedConnectorList({ AGFN_HOSTED: '1' }).map((c) => c.key)).not.toContain('polar')
    const hosted = { AGFN_HOSTED: '1', POLAR_CLIENT_ID: 'c', POLAR_CLIENT_SECRET: 's', BASE_URL: 'https://app.example.com' }
    const polar = installedConnectorList(hosted).find((c) => c.key === 'polar')!.factory(deps)
    const begin = (await polar.begin!({ state: 'st', workspaceId: 'w', redirectUri: '', userRef: 'u' })) as Extract<ConnectBegin, { kind: 'oauth' }>
    const u = new URL(begin.url)
    expect([u.origin + u.pathname, u.searchParams.get('redirect_uri'), u.searchParams.get('state')]).toEqual(['https://polar.sh/oauth2/authorize', 'https://app.example.com/api/connectors/polar/callback', 'st'])
    await expect(polar.connect({ token: 'polar_oat_x_000000' })).rejects.toMatchObject({ kind: 'invalid_input' })
  })

  it('Mercury: production OAuth by default; MERCURY_OAUTH_BASE points sign-in at the sandbox', async () => {
    const hosted = { MERCURY_CLIENT_ID: 'c', MERCURY_CLIENT_SECRET: 's', BASE_URL: 'https://app.example.com' }
    const authorize = async (env: Record<string, string>) => {
      const m = installedConnectorList(env).find((c) => c.key === 'mercury')!.factory(deps)
      const b = (await m.begin!({ state: 'st', workspaceId: 'w', redirectUri: 'https://app.example.com/api/connectors/mercury/callback', userRef: 'u' })) as Extract<ConnectBegin, { kind: 'oauth' }>
      const u = new URL(b.url)
      return u.origin + u.pathname
    }
    expect(await authorize(hosted)).toBe('https://oauth2.mercury.com/oauth2/auth')
    expect(await authorize({ ...hosted, MERCURY_OAUTH_BASE: 'https://oauth2-sandbox.mercury.com', MERCURY_API_BASE: 'https://api-sandbox.mercury.com/api/v1' })).toBe('https://oauth2-sandbox.mercury.com/oauth2/auth')
  })

  it('adds Plaid from env and Files when a FileSource is provided', () => {
    const env = { PLAID_CLIENT_ID: 'cid', PLAID_SECRET: 's', PLAID_ENV: 'sandbox' }
    const list = installedConnectorList(env, { fileSource: { list: async () => [] } })
    expect(list.map((c) => c.key)).toEqual(expect.arrayContaining(['plaid', 'files']))
  })

  it('every factory builds a connector whose key matches', () => {
    const env = { PLAID_CLIENT_ID: 'cid', PLAID_SECRET: 's', STRIPE_WEBHOOK_SECRET: 'whsec_a,whsec_b' }
    for (const { key, factory } of installedConnectorList(env, { fileSource: { list: async () => [] } })) {
      const c = factory(deps)
      expect(c.describe().key).toBe(key)
      expect(typeof c.sync).toBe('function')
    }
    expect(installedConnectors(env).length).toBe(installedConnectorList(env).length)
  })

  it('wires webhooks only when their secret is configured', () => {
    const stripe = (env: Record<string, string>) => installedConnectorList(env).find((c) => c.key === 'stripe')!.factory(deps) as { webhook?: unknown }
    expect(stripe({}).webhook).toBeUndefined()
    expect(stripe({ STRIPE_WEBHOOK_SECRET: 'whsec_a' }).webhook).toBeDefined()
  })

  it('Stripe sign-in reads a live and a test key, with STRIPE_APP_SECRET_KEY as the older live name', async () => {
    const basic = (k: string) => `Basic ${Buffer.from(`${k}:`).toString('base64')}`
    /** Which of our keys authenticates the code exchange, given the env. */
    const exchangeKeys = async (env: Record<string, string>) => {
      const f = fixtureFetch([
        { match: '/v1/oauth/token', respond: { status: 400, json: { error: 'invalid_grant', error_description: 'wrong mode' } } },
      ])
      const c = stripeFromEnv(env)({ raw: new MemoryRawSink(), fetch: f.fetch, clock: fakeClock() })
      await c.connect({ code: 'ac_code' }).catch(() => undefined)
      return { auth: c.describe().auth, keys: f.calls.map((x) => x.headers.authorization) }
    }
    const id = { STRIPE_APP_CLIENT_ID: 'ca_example' }
    expect(await exchangeKeys({ ...id, STRIPE_APP_SECRET_KEY_LIVE: 'sk_live_a', STRIPE_APP_SECRET_KEY_TEST: 'sk_test_b' })).toEqual({ auth: 'oauth', keys: [basic('sk_live_a'), basic('sk_test_b')] })
    expect(await exchangeKeys({ ...id, STRIPE_APP_SECRET_KEY: 'sk_live_old' })).toEqual({ auth: 'oauth', keys: [basic('sk_live_old')] })
    expect(await exchangeKeys({ ...id, STRIPE_APP_SECRET_KEY: 'sk_live_old', STRIPE_APP_SECRET_KEY_LIVE: 'sk_live_new' })).toMatchObject({ keys: [basic('sk_live_new')] })
    expect(await exchangeKeys({ ...id, STRIPE_APP_SECRET_KEY_TEST: 'sk_test_b' })).toEqual({ auth: 'oauth', keys: [basic('sk_test_b')] })
    expect((await exchangeKeys(id)).auth).toBe('api_key')
    // The setup guide counts either key (or the older name) as configured.
    const configured = (env: Record<string, string>) => allSetupGuides(env).find((g) => g.key === 'stripe')!.setup.configured
    expect(configured(id)).toBe(false)
    expect(configured({ ...id, STRIPE_APP_SECRET_KEY_TEST: 'sk_test_b' })).toBe(true)
    expect(configured({ ...id, STRIPE_APP_SECRET_KEY: 'sk_live_old' })).toBe(true)
  })

  it('offers QuickBooks, Xero, Finch and Justworks only when their OAuth app keys are set', () => {
    const keys = installedConnectorList({}).map((c) => c.key)
    for (const k of ['quickbooks', 'xero', 'finch', 'justworks']) expect(keys).not.toContain(k)
    const env = { QUICKBOOKS_CLIENT_ID: 'q', QUICKBOOKS_CLIENT_SECRET: 'qs', XERO_CLIENT_ID: 'x', XERO_CLIENT_SECRET: 'xs', FINCH_CLIENT_ID: 'f', FINCH_CLIENT_SECRET: 'fs', JUSTWORKS_CLIENT_ID: 'j', JUSTWORKS_CLIENT_SECRET: 'js' }
    expect(installedConnectorList(env).map((c) => c.key)).toEqual(expect.arrayContaining(['quickbooks', 'xero', 'finch', 'justworks']))
    // Half-configured apps stay hidden.
    expect(installedConnectorList({ XERO_CLIENT_ID: 'x' }).map((c) => c.key)).not.toContain('xero')
  })

  it('always offers Deel, BILL and Rippling (per-company keys the person pastes)', () => {
    expect(installedConnectorList({}).map((c) => c.key)).toEqual(expect.arrayContaining(['deel', 'billcom', 'rippling', 'simplefin']))
  })

  const begin = async (env: Record<string, string>, key: string, state = 'st_123'): Promise<ConnectBegin> => {
    const c = installedConnectorList(env).find((x) => x.key === key)!.factory(deps) as Connector
    expect(c.begin, key).toBeDefined()
    return c.begin!({ workspaceId: 'ws', redirectUri: 'ignored', state, userRef: 'person' })
  }

  it('OAuth connectors send the browser to the provider with the state and the callback the server serves', async () => {
    const env = { BASE_URL: 'https://app.aggregate.finance/', QUICKBOOKS_CLIENT_ID: 'q', QUICKBOOKS_CLIENT_SECRET: 'qs', XERO_CLIENT_ID: 'x', XERO_CLIENT_SECRET: 'xs', FINCH_CLIENT_ID: 'f', FINCH_CLIENT_SECRET: 'fs', FINCH_SANDBOX: '1', JUSTWORKS_CLIENT_ID: 'j', JUSTWORKS_CLIENT_SECRET: 'js' }
    const hosts = { quickbooks: 'appcenter.intuit.com', xero: 'login.xero.com', justworks: '' }
    for (const [key, host] of Object.entries(hosts)) {
      const b = await begin(env, key)
      expect(b.kind, key).toBe('oauth')
      const url = new URL((b as { url: string }).url)
      if (host) expect(url.host, key).toBe(host)
      expect(url.searchParams.get('state'), key).toBe('st_123')
      expect(url.searchParams.get('redirect_uri'), key).toBe(`https://app.aggregate.finance/api/connectors/${key}/callback`)
      expect(url.searchParams.get('client_id'), key).toBe(env[`${key.toUpperCase()}_CLIENT_ID` as keyof typeof env])
    }
    // New Xero apps only get granular scopes: ask for exactly what the sync reads.
    const xero = new URL(((await begin(env, 'xero')) as { url: string }).url)
    expect(xero.searchParams.get('scope')!.split(' ').sort()).toEqual(['accounting.banktransactions.read', 'accounting.invoices.read', 'accounting.manualjournals.read', 'accounting.payments.read', 'accounting.reports.profitandloss.read', 'accounting.settings.read', 'offline_access', 'openid'])
    const legacy = new URL(((await begin({ ...env, XERO_SCOPES: 'openid,offline_access accounting.transactions.read' }, 'xero')) as { url: string }).url)
    expect(legacy.searchParams.get('scope')).toBe('openid offline_access accounting.transactions.read')
    expect(redirectUriFor({}, 'xero')).toBe('http://localhost:8787/api/connectors/xero/callback')
  })

  it('Finch: a Connect session made with the app keys, state on the connect_url, sandbox when asked', async () => {
    const calls: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = []
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return new Response(JSON.stringify({ session_id: 'sess_1', connect_url: 'https://connect.tryfinch.com/authorize?session=sess_1' }), { status: 201, headers: { 'content-type': 'application/json' } })
    }) as typeof globalThis.fetch
    const env = { BASE_URL: 'https://app.aggregate.finance', FINCH_CLIENT_ID: 'fid', FINCH_CLIENT_SECRET: 'fsec', FINCH_SANDBOX: '1' }
    const c = installedConnectorList(env).find((x) => x.key === 'finch')!.factory({ ...deps, fetch }) as Connector
    const b = (await c.begin!({ workspaceId: 'ws_1', redirectUri: 'ignored', state: 'st_abcdefghijklmnop', userRef: 'p' })) as { kind: string; url: string }
    expect(b.kind).toBe('oauth')
    const url = new URL(b.url)
    expect([url.host, url.searchParams.get('session'), url.searchParams.get('state')]).toEqual(['connect.tryfinch.com', 'sess_1', 'st_abcdefghijklmnop'])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.tryfinch.com/connect/sessions')
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from('fid:fsec').toString('base64')}`)
    expect(calls[0]!.body).toMatchObject({ customer_id: 'ws_1-st_abcdefghi', products: ['company', 'directory', 'payment', 'pay_statement'], redirect_uri: 'https://app.aggregate.finance/api/connectors/finch/callback', sandbox: 'finch' })
    const live = installedConnectorList({ FINCH_CLIENT_ID: 'fid', FINCH_CLIENT_SECRET: 'fsec' }).find((x) => x.key === 'finch')!.factory({ ...deps, fetch }) as Connector
    await live.begin!({ workspaceId: 'ws_1', redirectUri: 'x', state: 's', userRef: 'p' })
    expect(calls[1]!.body.sandbox).toBeUndefined()
  })

  it('QuickBooks connects to sandbox companies unless QUICKBOOKS_ENV=production', async () => {
    const seen: string[] = []
    const fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input))
      const u = String(input)
      if (u.includes('oauth2')) return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'bearer' }), { headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ Preferences: {}, CompanyInfo: { CompanyName: 'Sandbox Co' } }), { headers: { 'content-type': 'application/json' } })
    }) as typeof globalThis.fetch
    for (const [qbEnv, host] of [[undefined, 'sandbox-quickbooks.api.intuit.com'], ['production', 'quickbooks.api.intuit.com']] as const) {
      seen.length = 0
      const env = { QUICKBOOKS_CLIENT_ID: 'q', QUICKBOOKS_CLIENT_SECRET: 'qs', ...(qbEnv ? { QUICKBOOKS_ENV: qbEnv } : {}) }
      const c = installedConnectorList(env).find((x) => x.key === 'quickbooks')!.factory({ ...deps, fetch }) as Connector
      const r = await c.connect({ code: 'c', realmId: '123' })
      expect(r.config.environment).toBe(qbEnv ?? 'sandbox')
      expect(seen.some((u) => new URL(u).host === host)).toBe(true)
    }
  })

  it('pasted-key connectors ask for exactly the fields their connect() reads', async () => {
    const fields = async (key: string, env: Record<string, string> = {}) => ((await begin(env, key)) as { fields: Array<{ name: string; options?: string[] }> }).fields
    expect((await fields('deel')).map((f) => f.name)).toEqual(['token', 'environment'])
    // Aggregate's Deel app set but one-click held back (AGFN_DEEL_TOKEN_ONLY=1): still the pasted token.
    expect((await fields('deel', { DEEL_CLIENT_ID: 'd', DEEL_CLIENT_SECRET: 'ds', AGFN_DEEL_TOKEN_ONLY: '1' })).map((f) => f.name)).toEqual(['token', 'environment'])
    expect(await begin({ DEEL_CLIENT_ID: 'd', DEEL_CLIENT_SECRET: 'ds' }, 'deel')).toMatchObject({ kind: 'oauth' })
    // Hosted: only production (no sandbox for real users), unless the operator runs Deel's sandbox (staging).
    expect((await fields('deel', { AGFN_HOSTED: '1' })).at(-1)!.options).toEqual(['production'])
    expect((await fields('deel', { AGFN_HOSTED: '1', DEEL_ENV: 'sandbox' })).at(-1)!.options).toEqual(['sandbox', 'production'])
    expect((await fields('deel')).at(-1)!.options).toEqual(['production', 'sandbox'])
    expect((await fields('billcom')).map((f) => f.name)).toEqual(['devKey', 'organizationId', 'username', 'password', 'environment'])
    expect((await fields('rippling')).map((f) => f.name)).toEqual(['apiToken'])
    expect((await fields('billcom', { BILL_ENV: 'sandbox' })).at(-1)!.options![0]).toBe('sandbox')
    // With Aggregate's BILL app-partner key: a sync token, offered only for environments that have a partner key.
    expect((await fields('billcom', { BILL_DEV_KEY: 'p' })).map((f) => f.name)).toEqual(['username', 'password', 'organizationId', 'environment'])
    expect((await fields('billcom', { BILL_DEV_KEY: 'p' })).at(-1)!.options).toEqual(['production'])
    expect((await fields('billcom', { BILL_DEV_KEY: 'p', BILL_ENV: 'sandbox' })).at(-1)!.options).toEqual(['sandbox'])
    expect((await fields('billcom', { BILL_DEV_KEY: 'p', BILL_SANDBOX_DEV_KEY: 's', BILL_ENV: 'sandbox' })).at(-1)!.options).toEqual(['sandbox', 'production'])
    expect((await fields('billcom')).at(-1)!.options![0]).toBe('production')
  })
})
