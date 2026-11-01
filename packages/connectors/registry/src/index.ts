// Which connectors this install offers, built from environment configuration. Returns factories (not instances)
// because the RawSink is per workspace and per sync; the sync engine calls factory(deps) for each run.
// A connector that needs app-level credentials (Plaid, OAuth apps) is skipped when they're missing.

import type { ConnectBegin, ConnectField, Connector } from '@agfn/contracts'
import type { ConnectorDeps } from '@agfn/connector-sdk'
import { createPlaidConnector, type PlaidExtraProduct } from '@agfn/connector-plaid'
import { createStripeConnector } from '@agfn/connector-stripe'
import { createMercuryConnector } from '@agfn/connector-mercury'
import { createBrexConnector } from '@agfn/connector-brex'
import { createRampConnector } from '@agfn/connector-ramp'
import { createWiseConnector } from '@agfn/connector-wise'
import { createFilesConnector, type FileSource } from '@agfn/connector-files'
import { createPayPalConnector } from '@agfn/connector-paypal'
import { createSquareConnector } from '@agfn/connector-square'
import { createShopifyConnector } from '@agfn/connector-shopify'
import { createPaddleConnector } from '@agfn/connector-paddle'
import { createPolarConnector } from '@agfn/connector-polar'
import { createLemonSqueezyConnector } from '@agfn/connector-lemonsqueezy'
import { createChargebeeConnector } from '@agfn/connector-chargebee'
import { createAppStoreConnector } from '@agfn/connector-appstore'
import { createGooglePlayConnector } from '@agfn/connector-googleplay'
import { createGumroadConnector } from '@agfn/connector-gumroad'
import { createDemoConnector } from '@agfn/connector-demo'
import { createQuickBooksConnector } from '@agfn/connector-quickbooks'
import { createXeroConnector } from '@agfn/connector-xero'
import { createCartaConnector } from '@agfn/connector-carta'
import { createWefunderConnector } from '@agfn/connector-wefunder'
import { createCoinbaseConnector } from '@agfn/connector-coinbase'
import { createExpensifyConnector } from '@agfn/connector-expensify'
import { createFinchConnector } from '@agfn/connector-finch'
import { createJustworksConnector } from '@agfn/connector-justworks'
import { createDeelConnector } from '@agfn/connector-deel'
import { createSimplefinConnector } from '@agfn/connector-simplefin'
import { createBillConnector } from '@agfn/connector-billcom'
import { createRipplingConnector } from '@agfn/connector-rippling'

export type Env = Record<string, string | undefined>
export type ConnectorFactory = (deps: ConnectorDeps) => Connector

export interface InstalledConnector {
  key: string
  factory: ConnectorFactory
}

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)

export function plaidFromEnv(env: Env): ConnectorFactory | undefined {
  const clientId = env.PLAID_CLIENT_ID
  const secret = env.PLAID_SECRET
  if (!clientId || !secret) return undefined
  const plaidEnv = env.PLAID_ENV === 'production' ? 'production' : 'sandbox'
  // Investments and Liabilities are consented in Link but billed only once read (Plaid's recommended pattern).
  // PLAID_PRODUCTS narrows that list; PLAID_PRODUCTS=none offers Transactions only.
  const consentedProducts: PlaidExtraProduct[] = env.PLAID_PRODUCTS === undefined ? ['investments', 'liabilities'] : list(env.PLAID_PRODUCTS).filter((p): p is PlaidExtraProduct => p === 'liabilities' || p === 'investments')
  return (deps) =>
    createPlaidConnector(
      {
        clientId,
        secret,
        env: plaidEnv,
        consentedProducts,
        ...(env.PLAID_WEBHOOK_URL ? { webhookUrl: env.PLAID_WEBHOOK_URL } : {}),
        ...(env.PLAID_LINK_REDIRECT_URI ? { linkRedirectUri: env.PLAID_LINK_REDIRECT_URI } : {}),
        ...(env.PLAID_COUNTRY_CODES ? { countryCodes: list(env.PLAID_COUNTRY_CODES) } : {}),
        ...(env.AGFN_APP_NAME ? { clientName: env.AGFN_APP_NAME } : {}),
      },
      deps,
    )
}

export function stripeFromEnv(env: Env): ConnectorFactory {
  const secrets = list(env.STRIPE_WEBHOOK_SECRET)
  // Stripe Apps exchanges and refreshes install tokens only with our key for the install's mode. STRIPE_APP_SECRET_KEY
  // is the older single-key name, read as the live key so existing servers keep working.
  const liveKey = env.STRIPE_APP_SECRET_KEY_LIVE || env.STRIPE_APP_SECRET_KEY
  const testKey = env.STRIPE_APP_SECRET_KEY_TEST
  const app =
    env.STRIPE_APP_CLIENT_ID && (liveKey || testKey)
      ? {
          appClientId: env.STRIPE_APP_CLIENT_ID,
          ...(liveKey ? { appSecretKey: liveKey } : {}),
          ...(testKey ? { appTestSecretKey: testKey } : {}),
          // Before the app is published: the External test tab's install link.
          ...(env.STRIPE_APP_AUTHORIZE_URL ? { appAuthorizeUrl: env.STRIPE_APP_AUTHORIZE_URL } : {}),
        }
      : {}
  return (deps) =>
    createStripeConnector(
      {
        ...(secrets.length ? { webhookSecret: secrets } : {}),
        ...(env.STRIPE_WEBHOOK_ACCOUNT_ID ? { webhookAccountId: env.STRIPE_WEBHOOK_ACCOUNT_ID } : {}),
        // Hosted one-click sign-in (Stripe Apps): the app's client id and Aggregate's own Stripe secret keys.
        ...app,
        // Hosted accepts only read-only access (no sk_ keys).
        ...(env.AGFN_HOSTED === '1' ? { hosted: true } : {}),
      },
      deps,
    )
}

/**
 * Where an OAuth provider sends the browser back: `${BASE_URL}/api/connectors/<key>/callback` (the server's callback
 * route builds the same address). Register exactly this URL in the provider's developer console.
 */
export function redirectUriFor(env: Env, key: string): string {
  const base = (env.BASE_URL ?? `http://localhost:${env.PORT ?? 8787}`).replace(/\/+$/, '')
  return `${base}/api/connectors/${key}/callback`
}

/** Gives a connector the server's connect step: an OAuth redirect, or the fields a person pastes. */
function withBegin<C extends Connector>(c: C, begin: (state: string) => ConnectBegin): C {
  return Object.assign(Object.create(Object.getPrototypeOf(c) as object) as C, c, { begin: async (ctx: { state: string }) => begin(ctx.state) })
}

const pasted = (label: string, helpUrl: string, fields: ConnectField[]): ConnectBegin => ({ kind: 'api_key', label, helpUrl, placeholder: '', fields })
const environments = (sandboxFirst: boolean): ConnectField => ({ name: 'environment', label: 'Environment', options: sandboxFirst ? ['sandbox', 'production'] : ['production', 'sandbox'] })
/** Deel's token form: hosted offers only production (a real user picking sandbox would get an empty account), unless
 *  the operator runs Deel's sandbox (DEEL_ENV=sandbox, staging). Self-hosters keep both. */
const deelEnvironment = (env: Env): ConnectField =>
  env.AGFN_HOSTED === '1' && env.DEEL_ENV !== 'sandbox' ? { name: 'environment', label: 'Environment', options: ['production'] } : environments(env.DEEL_ENV === 'sandbox')

export { FINCH_PRODUCTS } from '@agfn/connector-finch'

/** QuickBooks, Xero, Finch, Justworks and Carta: each appears only when its OAuth app keys are set. */
function oauthConnectors(env: Env): Array<[string, ConnectorFactory | undefined]> {
  const qb = env.QUICKBOOKS_CLIENT_ID && env.QUICKBOOKS_CLIENT_SECRET ? { clientId: env.QUICKBOOKS_CLIENT_ID, clientSecret: env.QUICKBOOKS_CLIENT_SECRET, redirectUri: redirectUriFor(env, 'quickbooks') } : undefined
  // Intuit's development keys only work against sandbox companies, so production must be asked for by name.
  const qbEnv = env.QUICKBOOKS_ENV === 'production' ? 'production' : 'sandbox'
  const xero = env.XERO_CLIENT_ID && env.XERO_CLIENT_SECRET
    ? { clientId: env.XERO_CLIENT_ID, clientSecret: env.XERO_CLIENT_SECRET, redirectUri: redirectUriFor(env, 'xero'), ...(env.XERO_SCOPES ? { scopes: env.XERO_SCOPES.split(/[\s,]+/).filter(Boolean) } : {}) }
    : undefined
  const finch = env.FINCH_CLIENT_ID && env.FINCH_CLIENT_SECRET ? { clientId: env.FINCH_CLIENT_ID, clientSecret: env.FINCH_CLIENT_SECRET, redirectUri: redirectUriFor(env, 'finch') } : undefined
  const carta = env.CARTA_CLIENT_ID && env.CARTA_CLIENT_SECRET ? { clientId: env.CARTA_CLIENT_ID, clientSecret: env.CARTA_CLIENT_SECRET, redirectUri: redirectUriFor(env, 'carta') } : undefined
  const wefunder = env.WEFUNDER_CLIENT_ID && env.WEFUNDER_CLIENT_SECRET ? { clientId: env.WEFUNDER_CLIENT_ID, clientSecret: env.WEFUNDER_CLIENT_SECRET, redirectUri: redirectUriFor(env, 'wefunder') } : undefined
  const jw = env.JUSTWORKS_CLIENT_ID && env.JUSTWORKS_CLIENT_SECRET ? { clientId: env.JUSTWORKS_CLIENT_ID, clientSecret: env.JUSTWORKS_CLIENT_SECRET, redirectUri: redirectUriFor(env, 'justworks') } : undefined
  return [
    [
      'quickbooks',
      qb &&
        ((deps) => {
          const c = createQuickBooksConnector({ deps, oauth: qb, ...(env.QUICKBOOKS_WEBHOOK_VERIFIER ? { webhookVerifier: env.QUICKBOOKS_WEBHOOK_VERIFIER } : {}) })
          const connect = c.connect.bind(c)
          return Object.assign(withBegin(c, (state) => ({ kind: 'oauth', url: c.authorizationUrl(state) })), { connect: (input: Record<string, unknown>) => connect({ environment: qbEnv, ...input }) })
        }),
    ],
    ['xero', xero && ((deps) => {
      const c = createXeroConnector({ deps, oauth: xero, ...(env.XERO_WEBHOOK_KEY ? { webhookKey: env.XERO_WEBHOOK_KEY } : {}) })
      return withBegin(c, (state) => ({ kind: 'oauth', url: c.authorizationUrl(state) }))
    })],
    // Finch Connect sessions (the connector's begin); FINCH_SANDBOX=1 opens Finch's own test payroll systems.
    ['finch', finch && ((deps) => createFinchConnector({ deps, oauth: finch, ...(env.FINCH_SANDBOX === '1' ? { sandbox: 'finch' as const } : {}) }))],
    ['justworks', jw && ((deps) => {
      const c = createJustworksConnector({ deps, oauth: jw })
      return withBegin(c, (state) => ({ kind: 'oauth', url: c.authorizationUrl(state) }))
    })],
    // Carta Portfolio API (read-only): CARTA_ENV=playground uses Carta's playground hosts and its fake personas.
    ['carta', carta && ((deps) => {
      const c = createCartaConnector({ deps, oauth: carta, ...(env.CARTA_ENV === 'playground' ? { env: 'playground' as const } : {}) })
      return withBegin(c, (state) => ({ kind: 'oauth', url: c.authorizationUrl(state) }))
    })],
    // Wefunder investor portfolio (read:investments, PKCE). A pk_test_ client id uses Wefunder's sandbox realm.
    ['wefunder', wefunder && ((deps) => {
      const c = createWefunderConnector({ deps, oauth: wefunder })
      return withBegin(c, (state) => ({ kind: 'oauth', url: c.authorizationUrl(state) }))
    })],
  ]
}

/** Platform services some connectors need (the file importer reads uploads through FileSource). */
export interface RegistryServices {
  fileSource?: FileSource
}

const pem = (v: string | undefined) => (v ? v.replace(/\\n/g, '\n') : undefined)

export function installedConnectorList(env: Env, services: RegistryServices = {}): InstalledConnector[] {
  const out: InstalledConnector[] = []
  const add = (key: string, f: ConnectorFactory | undefined) => {
    if (f) out.push({ key, factory: f })
  }
  add('plaid', plaidFromEnv(env))
  add('stripe', stripeFromEnv(env))
  add('mercury', (deps) =>
    createMercuryConnector(
      {
        ...(env.MERCURY_WEBHOOK_SECRET ? { webhookSecret: env.MERCURY_WEBHOOK_SECRET } : {}),
        ...(env.MERCURY_CLIENT_ID && env.MERCURY_CLIENT_SECRET ? { oauthClientId: env.MERCURY_CLIENT_ID, oauthClientSecret: env.MERCURY_CLIENT_SECRET } : {}),
        // Mercury's sandbox (staging): https://oauth2-sandbox.mercury.com and https://api-sandbox.mercury.com/api/v1. Default: production.
        ...(env.MERCURY_OAUTH_BASE ? { oauthBase: env.MERCURY_OAUTH_BASE } : {}),
        ...(env.MERCURY_API_BASE ? { baseUrl: env.MERCURY_API_BASE } : {}),
      },
      deps,
    ),
  )
  add('brex', (deps) => {
    const secrets = list(env.BREX_WEBHOOK_SECRET)
    return createBrexConnector(
      {
        ...(secrets.length ? { webhookSecrets: secrets } : {}),
        ...(env.BREX_CLIENT_ID && env.BREX_CLIENT_SECRET ? { oauthClientId: env.BREX_CLIENT_ID, oauthClientSecret: env.BREX_CLIENT_SECRET } : {}),
        ...(env.BREX_OAUTH_BASE ? { oauthBase: env.BREX_OAUTH_BASE } : {}),
      },
      deps,
    )
  })
  add('ramp', (deps) =>
    createRampConnector(
      {
        ...(env.RAMP_ENV === 'sandbox' ? { env: 'sandbox' as const } : {}),
        ...(env.RAMP_WEBHOOK_SECRET ? { webhookSecret: env.RAMP_WEBHOOK_SECRET } : {}),
        ...(env.RAMP_CLIENT_ID && env.RAMP_CLIENT_SECRET ? { oauthClientId: env.RAMP_CLIENT_ID, oauthClientSecret: env.RAMP_CLIENT_SECRET } : {}),
      },
      deps,
    ),
  )
  add('wise', (deps) => {
    const sca = pem(env.WISE_SCA_PRIVATE_KEY)
    const pub = pem(env.WISE_WEBHOOK_PUBLIC_KEY)
    return createWiseConnector(
      {
        ...(env.WISE_ENV === 'sandbox' ? { env: 'sandbox' as const } : {}),
        ...(sca ? { scaPrivateKey: sca } : {}),
        ...(pub ? { webhookPublicKey: pub } : {}),
      },
      deps,
    )
  })
  // Hosted promises read-only access at the source. Pasted PayPal REST-app credentials carry whatever that app may do,
  // so hosted offers PayPal only through Aggregate's partner sign-in (read-only consent).
  if (env.AGFN_HOSTED !== '1' || (env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET && env.PAYPAL_PARTNER_MERCHANT_ID)) add('paypal', (deps) => {
    const id = env.PAYPAL_WEBHOOK_APP_CLIENT_ID
    const secret = env.PAYPAL_WEBHOOK_APP_CLIENT_SECRET
    // Partner mode (hosted one-click): Aggregate's approved partner app; without it people paste their own REST app.
    const partner =
      env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET && env.PAYPAL_PARTNER_MERCHANT_ID
        ? {
            partner: {
              clientId: env.PAYPAL_CLIENT_ID,
              clientSecret: env.PAYPAL_CLIENT_SECRET,
              merchantId: env.PAYPAL_PARTNER_MERCHANT_ID,
              env: env.PAYPAL_ENV === 'sandbox' ? ('sandbox' as const) : ('live' as const),
              ...(env.PAYPAL_BN_CODE ? { bnCode: env.PAYPAL_BN_CODE } : {}),
            },
          }
        : {}
    return createPayPalConnector(
      {
        ...(env.PAYPAL_WEBHOOK_ID && id && secret
          ? { webhookId: env.PAYPAL_WEBHOOK_ID, webhookApp: { clientId: id, clientSecret: secret, env: env.PAYPAL_WEBHOOK_APP_ENV === 'sandbox' ? ('sandbox' as const) : ('live' as const) } }
          : {}),
        ...partner,
      },
      deps,
    )
  })
  // Square and Shopify work with a pasted token without app credentials; OAuth is enabled when the app is configured.
  add('square', (deps) =>
    createSquareConnector(
      {
        ...(env.SQUARE_ENV === 'sandbox' ? { env: 'sandbox' as const } : {}),
        ...(env.SQUARE_CLIENT_ID && env.SQUARE_CLIENT_SECRET ? { clientId: env.SQUARE_CLIENT_ID, clientSecret: env.SQUARE_CLIENT_SECRET } : {}),
        // Hosted: Square sign-in only (read-only scopes), never a full-access personal token.
        ...(env.AGFN_HOSTED === '1' ? { hosted: true } : {}),
        ...(env.SQUARE_WEBHOOK_SIGNATURE_KEY && env.SQUARE_WEBHOOK_URL
          ? { webhookSignatureKey: env.SQUARE_WEBHOOK_SIGNATURE_KEY, webhookUrl: env.SQUARE_WEBHOOK_URL }
          : {}),
      },
      deps,
    ),
  )
  add('shopify', (deps) =>
    createShopifyConnector(
      {
        ...(env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET ? { clientId: env.SHOPIFY_CLIENT_ID, clientSecret: env.SHOPIFY_CLIENT_SECRET } : {}),
        ...(env.SHOPIFY_WEBHOOK_SECRET ? { webhookSecret: env.SHOPIFY_WEBHOOK_SECRET } : {}),
        ...(env.AGFN_HOSTED === '1' ? { hosted: true } : {}),
      },
      deps,
    ),
  )
  add('paddle', (deps) => createPaddleConnector(env.PADDLE_WEBHOOK_SECRET ? { webhookSecret: env.PADDLE_WEBHOOK_SECRET } : {}, deps))
  // Polar: self-hosters paste an organization access token with read scopes; with Aggregate's Polar app
  // (POLAR_CLIENT_ID/SECRET; POLAR_ENV=sandbox for an app made on sandbox.polar.sh) it's one-click sign-in. Hosted offers
  // it only with the app, sign-in only.
  const polarApp = env.POLAR_CLIENT_ID && env.POLAR_CLIENT_SECRET
    ? { clientId: env.POLAR_CLIENT_ID, clientSecret: env.POLAR_CLIENT_SECRET, redirectUri: redirectUriFor(env, 'polar'), environment: env.POLAR_ENV === 'sandbox' ? ('sandbox' as const) : ('production' as const) }
    : undefined
  if (env.AGFN_HOSTED !== '1' || polarApp) {
    add('polar', (deps) => createPolarConnector({ ...(polarApp ? { oauth: polarApp } : {}), ...(env.AGFN_HOSTED === '1' ? { hosted: true } : {}) }, deps))
  }
  // Chargebee: a read-only key (subscriptions only, for MRR). Hosted holds it back until it's run on a real site (config.ts).
  add('chargebee', (deps) => createChargebeeConnector({}, deps))
  // Expensify's partner credentials act as the person with the whole API (writes included): self-hosted only, like
  // Lemon Squeezy. Beta: built against Expensify's docs, not yet run on a real account.
  if (env.AGFN_HOSTED !== '1') add('expensify', (deps) => createExpensifyConnector({ deps }))
  // Lemon Squeezy API keys can't be limited to reading, so hosted (read-only at the source) doesn't offer it yet.
  if (env.AGFN_HOSTED !== '1') {
    add('lemonsqueezy', (deps) =>
      createLemonSqueezyConnector(env.LEMONSQUEEZY_WEBHOOK_SECRET ? { webhookSecret: env.LEMONSQUEEZY_WEBHOOK_SECRET } : {}, deps),
    )
  }
  for (const [key, f] of oauthConnectors(env)) add(key, f)
  // Banks through SimpleFIN Bridge (the person pays SimpleFIN, no developer app): always installed. Self-hosters running
  // their own SimpleFIN server set SIMPLEFIN_ALLOW_ANY_HOST=1 to accept tokens from it.
  add('simplefin', (deps) => createSimplefinConnector(env.SIMPLEFIN_ALLOW_ANY_HOST === '1' ? { allowAnyHost: true } : {}, deps))
  // Deel: each company's own organization token (scope accounting:read). Checked live against Deel's API sandbox on
  // 2026-10-11 (docs/qa/bill-deel-live-2026-10-11.md), so hosted offers it too. With Aggregate's Deel app
  // (DEEL_CLIENT_ID/SECRET; DEEL_ENV=sandbox for an app made in Deel's sandbox) it's one-click sign-in instead, and
  // connections made with a pasted token keep syncing.
  // AGFN_DEEL_TOKEN_ONLY=1 offers only the pasted token while the app awaits Deel's App Store review (one-click would
  // fail for other orgs); the app's keys stay set, so connections made with one-click keep renewing.
  const deelApp = env.DEEL_CLIENT_ID && env.DEEL_CLIENT_SECRET
    ? { clientId: env.DEEL_CLIENT_ID, clientSecret: env.DEEL_CLIENT_SECRET, redirectUri: redirectUriFor(env, 'deel'), environment: env.DEEL_ENV === 'sandbox' ? ('sandbox' as const) : ('production' as const) }
    : undefined
  add('deel', (deps) => {
    const c = createDeelConnector({ deps, ...(deelApp ? { oauth: deelApp } : {}) })
    return withBegin(c, (state) =>
      c.authorizationUrl && env.AGFN_DEEL_TOKEN_ONLY !== '1'
        ? { kind: 'oauth', url: c.authorizationUrl(state) }
        : pasted('Deel organization token', 'https://developer.deel.com/docs/api-tokens-1', [{ name: 'token', label: 'Organization token', secret: true }, deelEnvironment(env)]),
    )
  })
  // BILL: with Aggregate's app-partner key (BILL_DEV_KEY: production, or sandbox when BILL_ENV=sandbox and there's no
  // BILL_SANDBOX_DEV_KEY) people paste an AP/AR sync token; without one, their own developer key and a user login.
  // Hosted offers it only with a partner key (staging has the sandbox one; live waits for production).
  const devKeyIsSandbox = env.BILL_ENV === 'sandbox' && !env.BILL_SANDBOX_DEV_KEY
  const billPartner = {
    ...(env.BILL_DEV_KEY ? { [devKeyIsSandbox ? 'sandbox' : 'production']: env.BILL_DEV_KEY } : {}),
    ...(env.BILL_SANDBOX_DEV_KEY ? { sandbox: env.BILL_SANDBOX_DEV_KEY } : {}),
  } as Partial<Record<'production' | 'sandbox', string>>
  const billEnvs = Object.keys(billPartner) as Array<'production' | 'sandbox'>
  if (env.AGFN_HOSTED !== '1' || billEnvs.length) {
    add('billcom', (deps) =>
      withBegin(createBillConnector({ deps, ...(billEnvs.length ? { partnerDevKeys: billPartner } : {}) }), () =>
        billEnvs.length
          ? pasted('BILL sync token', '', [
              { name: 'username', label: 'Sync token name' },
              { name: 'password', label: 'Sync token', secret: true },
              { name: 'organizationId', label: 'Organization ID' },
              { name: 'environment', label: 'Environment', options: env.BILL_ENV === 'sandbox' ? [...billEnvs].sort().reverse() : [...billEnvs].sort() },
            ])
          : pasted('BILL developer key and a user login', '', [
              { name: 'devKey', label: 'Developer key', secret: true },
              { name: 'organizationId', label: 'Organization ID' },
              { name: 'username', label: 'User email' },
              { name: 'password', label: 'Password', secret: true },
              environments(env.BILL_ENV === 'sandbox'),
            ]),
      ),
    )
  }
  // Rippling: using an API token "on behalf of another organization" breaks Rippling's terms; hosted apps must be an
  // App Shop OAuth partner. So only self-hosters (their own organisation's token) get it until we are one.
  if (env.AGFN_HOSTED !== '1') {
    add('rippling', (deps) =>
      withBegin(createRipplingConnector({ deps }), () => pasted('Rippling API token', '', [{ name: 'apiToken', label: 'API token', secret: true }])),
    )
  }
  // Coinbase: one-click sign-in once Aggregate's OAuth client exists (Coinbase issues them to approved partners).
  // Self-hosters can paste a View-only API key instead; hosted takes sign-in only, so it stays hidden there until then.
  const coinbaseOAuth = env.COINBASE_CLIENT_ID && env.COINBASE_CLIENT_SECRET ? { clientId: env.COINBASE_CLIENT_ID, clientSecret: env.COINBASE_CLIENT_SECRET, redirectUri: redirectUriFor(env, 'coinbase') } : undefined
  if (coinbaseOAuth || env.AGFN_HOSTED !== '1') {
    add('coinbase', (deps) => createCoinbaseConnector({ deps, ...(coinbaseOAuth ? { oauth: coinbaseOAuth } : {}), ...(env.AGFN_HOSTED === '1' ? { hosted: true } : {}) }))
  }
  // Gumroad: sign-in with Aggregate's Gumroad app (view_sales + view_payouts, read-only). A token generated on the
  // seller's own Gumroad application carries every scope, so only self-hosters get that, and hosted waits for the app.
  const gumroadOAuth = env.GUMROAD_CLIENT_ID && env.GUMROAD_CLIENT_SECRET ? { clientId: env.GUMROAD_CLIENT_ID, clientSecret: env.GUMROAD_CLIENT_SECRET, redirectUri: redirectUriFor(env, 'gumroad') } : undefined
  if (gumroadOAuth || env.AGFN_HOSTED !== '1') {
    add('gumroad', (deps) => createGumroadConnector({ deps, ...(gumroadOAuth ? { oauth: gumroadOAuth } : {}), ...(env.AGFN_HOSTED === '1' ? { hosted: true } : {}) }))
  }
  add('appstore', (deps) => createAppStoreConnector({}, deps))
  add('googleplay', (deps) => createGooglePlayConnector({}, deps))
  // Demo data: always installed so a demo workspace can sync; the server refuses it outside demo workspaces.
  add('demo', (deps) => createDemoConnector(deps))
  const source = services.fileSource
  if (source) add('files', (deps) => createFilesConnector({ source }, deps))
  return out
}

/** The integrator's entry point: one factory per connector available in this install. */
export function installedConnectors(env: Env, services: RegistryServices = {}): ConnectorFactory[] {
  return installedConnectorList(env, services).map((c) => c.factory)
}
export { findDuplicatePlaidItem, type PlaidLinkedSummary } from '@agfn/connector-plaid'
export { allSetupGuides, SETUP_DOCS_PATH, setupGuide, setupMarkdown, unconfiguredConnectors } from './setup.ts'
