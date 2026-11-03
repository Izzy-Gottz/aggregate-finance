// Setup guides for connectors that need an app of your own on this server (Plaid, QuickBooks, Xero, Finch,
// Justworks). When their keys are missing the registry leaves them out; these guides let a self-hosted server still
// show them, with what to register and set. One source for GET /api/connectors, `agfn doctor` and the docs.

import type { ConnectorDescription, ConnectorSetup } from '@agfn/contracts'
import { redirectUriFor, type Env } from './index.ts'
import { DEFAULT_SCOPES as FRESHBOOKS_SCOPES } from '@agfn/connector-freshbooks'

const base = (env: Env) => (env.BASE_URL ?? `http://localhost:${env.PORT ?? 8787}`).replace(/\/+$/, '')
const restart = 'Restart Aggregate after setting them.'

type Guide = Omit<ConnectorDescription, 'setup'> & { setup: Omit<ConnectorSetup, 'configured'> }

function guides(env: Env): Guide[] {
  return ([
    {
      key: 'plaid',
      name: 'Bank or card (Plaid)',
      group: 'banks',
      provides: ['balances', 'transactions'],
      freshness: 'updates every few hours',
      auth: 'link_widget',
      setup: {
        kind: 'app',
        register: { name: 'Plaid Dashboard', url: 'https://dashboard.plaid.com/signup' },
        // Plaid sends OAuth banks (Chase, Bank of America…) back to this page, not to an API callback.
        redirectUri: `${base(env)}/connect/plaid/oauth`,
        // PLAID_LINK_REDIRECT_URI isn't required: only OAuth banks (Chase, Bank of America…) need it, and sandbox's test
        // banks work without it. `agfn doctor` warns when production is set without it.
        env: ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_ENV'],
        steps: [
          'Create a Plaid account and open Developers → Keys in the Plaid Dashboard.',
          'Set PLAID_CLIENT_ID and PLAID_SECRET from there, with PLAID_ENV=sandbox to try it with test banks first.',
          'Before connecting a bank that signs in on its own site (Chase, Bank of America…): under Developers → API → Allowed redirect URIs add the address shown here, and set PLAID_LINK_REDIRECT_URI to it. Sandbox test banks don’t need it.',
          'For your real banks, ask Plaid for Production access, then use the production secret and PLAID_ENV=production. Plaid bills your account per connected bank.',
          restart,
        ],
      },
    },
    {
      key: 'quickbooks',
      name: 'QuickBooks',
      group: 'accounting',
      provides: ['invoices', 'bills', 'reports'],
      freshness: 'syncs every few hours',
      auth: 'oauth',
      setup: {
        kind: 'app',
        register: { name: 'Intuit Developer', url: 'https://developer.intuit.com/app/developer/dashboard' },
        redirectUri: redirectUriFor(env, 'quickbooks'),
        env: ['QUICKBOOKS_CLIENT_ID', 'QUICKBOOKS_CLIENT_SECRET', 'QUICKBOOKS_ENV'],
        steps: [
          'Sign in to Intuit Developer and create an app with the Accounting scope.',
          'Under Keys & credentials, add the redirect URI shown here.',
          'Set QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET from that page.',
          'Development keys only reach sandbox companies: for your real books use the production keys and set QUICKBOOKS_ENV=production.',
          restart,
        ],
      },
    },
    {
      key: 'freshbooks',
      name: 'FreshBooks',
      group: 'accounting',
      provides: ['invoices', 'bills', 'reports'],
      freshness: 'syncs every few hours',
      auth: 'oauth',
      setup: {
        kind: 'app',
        register: { name: 'FreshBooks Developers', url: 'https://my.freshbooks.com/#/developer' },
        redirectUri: redirectUriFor(env, 'freshbooks'),
        env: ['FRESHBOOKS_CLIENT_ID', 'FRESHBOOKS_CLIENT_SECRET'],
        steps: [
          'Sign in to FreshBooks, open the developer page and create an app.',
          'Use the redirect URI shown here. FreshBooks requires https and no query string, so a server on http can’t use it.',
          `Tick these scopes on the app: ${FRESHBOOKS_SCOPES.join(', ')}.`,
          'Set FRESHBOOKS_CLIENT_ID and FRESHBOOKS_CLIENT_SECRET from the app.',
          restart,
        ],
      },
    },
    {
      key: 'xero',
      name: 'Xero',
      group: 'accounting',
      provides: ['invoices', 'bills', 'reports'],
      freshness: 'syncs every few hours',
      auth: 'oauth',
      setup: {
        kind: 'app',
        register: { name: 'Xero Developer', url: 'https://developer.xero.com/app/manage' },
        redirectUri: redirectUriFor(env, 'xero'),
        env: ['XERO_CLIENT_ID', 'XERO_CLIENT_SECRET'],
        steps: [
          'Sign in to Xero Developer and create a new app of type Web app.',
          'Use the redirect URI shown here as the app’s redirect URI.',
          'Set XERO_CLIENT_ID from the app, and XERO_CLIENT_SECRET from a secret you generate there.',
          restart,
        ],
      },
    },
    {
      key: 'finch',
      name: 'Payroll via Finch',
      group: 'payroll',
      provides: ['payroll'],
      freshness: 'updates daily for most payroll systems',
      auth: 'oauth',
      setup: {
        kind: 'app',
        register: { name: 'Finch Dashboard', url: 'https://dashboard.tryfinch.com/' },
        redirectUri: redirectUriFor(env, 'finch'),
        env: ['FINCH_CLIENT_ID', 'FINCH_CLIENT_SECRET'],
        steps: [
          'Create a Finch developer account and an application in the Finch Dashboard.',
          'Add the redirect URI shown here to the application.',
          'Set FINCH_CLIENT_ID and FINCH_CLIENT_SECRET; add FINCH_SANDBOX=1 to try Finch’s test payroll systems first.',
          restart,
        ],
      },
    },
    {
      key: 'justworks',
      name: 'Justworks',
      group: 'payroll',
      provides: ['payroll'],
      freshness: 'syncs daily (needs Justworks partner access)',
      auth: 'oauth',
      setup: {
        kind: 'app',
        register: { name: 'Justworks partner program', url: 'https://www.justworks.com/partners' },
        redirectUri: redirectUriFor(env, 'justworks'),
        env: ['JUSTWORKS_CLIENT_ID', 'JUSTWORKS_CLIENT_SECRET'],
        steps: [
          'Justworks gives API access to approved partners: apply through its partner program.',
          'Once approved, register the redirect URI shown here with Justworks.',
          'Set JUSTWORKS_CLIENT_ID and JUSTWORKS_CLIENT_SECRET from the credentials Justworks sends.',
          restart,
        ],
      },
    },
  ] as Guide[]).map((g) => withDocs(env, g))
}

/** Where the docs page lives on this server: one section per connector, anchored by its key. */
export const SETUP_DOCS_PATH = '/docs/connector-setup'
const withDocs = <G extends { key: string; setup: object }>(env: Env, g: G): G => ({ ...g, setup: { ...g.setup, docsUrl: `${base(env)}${SETUP_DOCS_PATH}#${g.key}` } })

/**
 * Optional apps: these connectors already work with a token pasted per connection; registering an app of your own adds
 * one-click sign-in. Shown in the docs and `agfn doctor`, never as "needs setup" in the app.
 */
function optionalApps(env: Env): Array<{ key: string; name: string; setup: Omit<ConnectorSetup, 'configured'> }> {
  return [
    {
      key: 'stripe',
      name: 'Stripe (one-click sign-in)',
      setup: {
        kind: 'key' as const,
        register: { name: 'Stripe Apps', url: 'https://dashboard.stripe.com/apps' },
        redirectUri: redirectUriFor(env, 'stripe'),
        env: ['STRIPE_APP_CLIENT_ID', 'STRIPE_APP_SECRET_KEY_LIVE', 'STRIPE_APP_SECRET_KEY_TEST'],
        steps: [
          'Without these, people paste a restricted Stripe key, which works fine.',
          'For one-click sign-in, upload a Stripe App with OAuth install (integrations/stripe-app in this repo: put the redirect URI shown here in allowed_redirect_uris, then `stripe apps upload`).',
          'Set STRIPE_APP_CLIENT_ID to the app’s client id (ca_…), STRIPE_APP_SECRET_KEY_LIVE to the live secret key (sk_live_…) of the Stripe account that owns the app, and STRIPE_APP_SECRET_KEY_TEST to its test key (sk_test_…) for test-mode installs. Either key alone works for installs in that mode; the older STRIPE_APP_SECRET_KEY still counts as the live key.',
          restart,
        ],
      },
    },
    {
      key: 'square',
      name: 'Square (one-click sign-in)',
      setup: {
        kind: 'key' as const,
        register: { name: 'Square Developer', url: 'https://developer.squareup.com/apps' },
        redirectUri: redirectUriFor(env, 'square'),
        env: ['SQUARE_CLIENT_ID', 'SQUARE_CLIENT_SECRET', 'SQUARE_ENV'],
        steps: [
          'Without these, people paste a Square access token, which works fine.',
          'For one-click sign-in, create an application in Square Developer and, under OAuth, add the redirect URI shown here.',
          'Set SQUARE_CLIENT_ID (the application ID) and SQUARE_CLIENT_SECRET (the OAuth secret); SQUARE_ENV=sandbox uses Square’s sandbox.',
          restart,
        ],
      },
    },
    {
      key: 'shopify',
      name: 'Shopify (one-click install)',
      setup: {
        kind: 'key' as const,
        register: { name: 'Shopify Partners', url: 'https://partners.shopify.com/' },
        redirectUri: redirectUriFor(env, 'shopify'),
        env: ['SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET'],
        steps: [
          'Without these, each store owner creates an app for their own store in the Shopify Dev Dashboard and pastes its client ID and secret, which works fine.',
          'For one-click install, create an app in Shopify Partners: set its App URL to this server’s /api/connectors/shopify/install and add the redirect URI shown here as an allowed redirection URL.',
          'Point the app’s privacy webhooks (customers/data_request, customers/redact, shop/redact) and app/uninstalled at this server’s /api/webhooks/shopify. Public distribution needs Shopify’s app review.',
          'Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET from the app’s client credentials.',
          restart,
        ],
      },
    },
    {
      key: 'coinbase',
      name: 'Coinbase (one-click sign-in)',
      setup: {
        kind: 'key' as const,
        register: { name: 'Coinbase Developer Platform', url: 'https://portal.cdp.coinbase.com/' },
        redirectUri: redirectUriFor(env, 'coinbase'),
        env: ['COINBASE_CLIENT_ID', 'COINBASE_CLIENT_SECRET'],
        steps: [
          'Without these, people paste a Coinbase Developer Platform API key with only the View permission, which works fine.',
          'For one-click sign-in, create an OAuth client in the Coinbase Developer Platform (API Keys → OAuth; Coinbase currently gives these to approved partners) and add the redirect URI shown here.',
          'Set COINBASE_CLIENT_ID and COINBASE_CLIENT_SECRET from the OAuth client.',
          restart,
        ],
      },
    },
    {
      key: 'polar',
      name: 'Polar (one-click sign-in)',
      setup: {
        kind: 'key' as const,
        register: { name: 'Polar', url: 'https://polar.sh/dashboard' },
        redirectUri: redirectUriFor(env, 'polar'),
        env: ['POLAR_CLIENT_ID', 'POLAR_CLIENT_SECRET'],
        steps: [
          'Without these, people paste a Polar organization access token with read scopes, which works fine.',
          'For one-click sign-in, create an OAuth application in Polar (Settings → Developers), add the redirect URI shown here and allow the read scopes organizations, orders, refunds, disputes, subscriptions and discounts. Set POLAR_ENV=sandbox for an app made on sandbox.polar.sh.',
          'Set POLAR_CLIENT_ID and POLAR_CLIENT_SECRET from the application.',
          restart,
        ],
      },
    },
    {
      key: 'squarespace',
      name: 'Squarespace',
      setup: {
        kind: 'key' as const,
        register: { name: 'Squarespace Developers', url: 'https://developers.squarespace.com' },
        redirectUri: redirectUriFor(env, 'squarespace'),
        env: ['SQUARESPACE_CLIENT_ID', 'SQUARESPACE_CLIENT_SECRET'],
        steps: [
          'In Squarespace, open Developer Apps and create an OAuth app. New apps start in Demo Mode.',
          'Add the redirect URI shown here.',
          'Set SQUARESPACE_CLIENT_ID and SQUARESPACE_CLIENT_SECRET from the app.',
          restart,
        ],
      },
    },
    {
      key: 'wix',
      name: 'Wix',
      setup: {
        kind: 'key' as const,
        register: { name: 'Wix Dev Center', url: 'https://dev.wix.com' },
        redirectUri: redirectUriFor(env, 'wix'),
        env: ['WIX_CLIENT_ID', 'WIX_CLIENT_SECRET'],
        steps: [
          'In the Wix Dev Center, create an app. Under Permissions add Read Orders and nothing else.',
          'Use the redirect URI shown here as the app’s install redirect.',
          'Set WIX_CLIENT_ID to the app ID and WIX_CLIENT_SECRET to the app secret.',
          restart,
        ],
      },
    },
    {
      key: 'pinterest',
      name: 'Pinterest Ads',
      setup: {
        kind: 'key' as const,
        register: { name: 'Pinterest Developers', url: 'https://developers.pinterest.com/apps/' },
        redirectUri: redirectUriFor(env, 'pinterest'),
        env: ['PINTEREST_CLIENT_ID', 'PINTEREST_CLIENT_SECRET'],
        steps: [
          'In Pinterest Developers, create an app and get it approved for access.',
          'Add the redirect URI shown here. Aggregate asks for the ads:read scope only.',
          'Set PINTEREST_CLIENT_ID and PINTEREST_CLIENT_SECRET from the app.',
          restart,
        ],
      },
    },
    {
      key: 'adsense',
      name: 'Google AdSense',
      setup: {
        kind: 'key' as const,
        register: { name: 'Google Cloud Credentials', url: 'https://console.cloud.google.com/apis/credentials' },
        redirectUri: redirectUriFor(env, 'adsense'),
        env: ['ADSENSE_CLIENT_ID', 'ADSENSE_CLIENT_SECRET'],
        steps: [
          'In Google Cloud, enable the AdSense Management API and create an OAuth client of type Web application.',
          'Add the redirect URI shown here, and the adsense.readonly scope on the consent screen.',
          'Set ADSENSE_CLIENT_ID and ADSENSE_CLIENT_SECRET from the client.',
          restart,
        ],
      },
    },
    {
      key: 'youtube',
      name: 'YouTube',
      setup: {
        kind: 'key' as const,
        register: { name: 'Google Cloud Credentials', url: 'https://console.cloud.google.com/apis/credentials' },
        redirectUri: redirectUriFor(env, 'youtube'),
        env: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET'],
        steps: [
          'In Google Cloud, enable the YouTube Data API v3 and YouTube Analytics API, and create an OAuth client of type Web application.',
          'Add the redirect URI shown here, and the youtube.readonly and yt-analytics-monetary.readonly scopes on the consent screen.',
          'Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET from the client.',
          restart,
        ],
      },
    },
    {
      key: 'patreon',
      name: 'Patreon (one-click sign-in)',
      setup: {
        kind: 'key' as const,
        register: { name: 'Patreon Clients & API Keys', url: 'https://www.patreon.com/portal/registration/register-clients' },
        redirectUri: redirectUriFor(env, 'patreon'),
        env: ['PATREON_CLIENT_ID', 'PATREON_CLIENT_SECRET'],
        steps: [
          'Without these, a creator pastes their own Creator’s Access Token, which works until it expires.',
          'For one-click sign-in, create a client on Patreon’s Clients & API Keys page with API version 2, and add the redirect URI shown here.',
          'Set PATREON_CLIENT_ID and PATREON_CLIENT_SECRET from the client.',
          restart,
        ],
      },
    },
  ].map((g) => withDocs(env, g))
}

/** Guides for app-based connectors this server is NOT configured for (installed ones are left out). */
export function unconfiguredConnectors(env: Env, installedKeys: readonly string[]): ConnectorDescription[] {
  return guides(env)
    .filter((g) => !installedKeys.includes(g.key))
    .map((g) => ({ ...g, setup: { ...g.setup, configured: false } }))
}

/** The setup guide for one connector key, configured or not (for `agfn doctor` and docs). */
export function setupGuide(env: Env, key: string): ConnectorSetup | undefined {
  const g = guides(env).find((x) => x.key === key)
  return g ? { ...g.setup, configured: false } : undefined
}

const ENV_SET = (env: Env, names: readonly string[] | undefined) => {
  // The *_ENV / *_REDIRECT_URI style names are optional; configured means the id and secret are there.
  const needed = (names ?? []).filter((n) => /_(CLIENT_ID|CLIENT_SECRET|SECRET|SECRET_KEY)$/.test(n))
  // Per-mode keys (Stripe's *_SECRET_KEY_LIVE / _TEST): either one is enough, and the unsuffixed name counts as live.
  const modeKeys = (names ?? []).filter((n) => /_SECRET_KEY_(LIVE|TEST)$/.test(n))
  const anyModeKey = modeKeys.length === 0 || modeKeys.some((n) => Boolean(env[n] || env[n.replace(/_(LIVE|TEST)$/, '')]))
  return needed.length > 0 && needed.every((n) => Boolean(env[n])) && anyModeKey
}

/**
 * The docs page (GET /docs/connector-setup): every guide, in the same words as the app and `agfn doctor`. With
 * `baseUrl` null (the hosted site) redirect URIs show a placeholder for your own server's address.
 */
export function setupMarkdown(env: Env, opts: { showStatus?: boolean } = {}): string {
  const shown = env.BASE_URL ? env : { ...env, BASE_URL: 'https://your-server.example' }
  const section = (g: { key: string; name: string; setup: Omit<ConnectorSetup, 'configured'> }) => {
    const st = g.setup
    const lines = [`## ${g.name} {#${g.key}}`, '']
    if (opts.showStatus) lines.push(ENV_SET(env, st.env) ? '**Set up on this server.**' : '**Not set up on this server yet.**', '')
    if (st.register) lines.push(`Register at [${st.register.name}](${st.register.url}).`, '')
    if (st.redirectUri) lines.push('Redirect URI:', '', '```', st.redirectUri, '```', '')
    st.steps?.forEach((step, i) => lines.push(`${i + 1}. ${step}`))
    if (st.env?.length) lines.push('', 'Environment variables:', '', '```', ...st.env.map((n) => `${n}=…`), '```')
    return lines.join('\n')
  }
  return [
    '# Set up connections on your own server',
    '',
    'Hosted Aggregate has all of these ready. On a server you run yourself, connections that sign in with an app (banks through Plaid, QuickBooks, Xero, payroll) need an app of your own with that provider. Each takes a few minutes: register the app, copy two values into your environment, restart. Values go in your environment or secret store, never in this page or in git.',
    '',
    'Without Plaid you can still add banks through SimpleFIN Bridge or by uploading statements.',
    '',
    ...guides(shown).map(section).flatMap((s) => [s, '']),
    '# Optional: one-click sign-in',
    '',
    'These work without anything on this page (people paste a token when they connect). An app of your own replaces the paste with a sign-in button.',
    '',
    ...optionalApps(shown).map(section).flatMap((s) => [s, '']),
  ].join('\n')
}

/** Every guide with whether this server has its keys (for `agfn doctor`). */
export function allSetupGuides(env: Env): Array<{ key: string; name: string; optional: boolean; setup: ConnectorSetup }> {
  return [
    ...guides(env).map((g) => ({ key: g.key, name: g.name, optional: false, setup: { ...g.setup, configured: ENV_SET(env, g.setup.env) } })),
    ...optionalApps(env).map((g) => ({ key: g.key, name: g.name, optional: true, setup: { ...g.setup, configured: ENV_SET(env, g.setup.env) } })),
  ]
}
