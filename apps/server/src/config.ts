import { isHostedDb } from '@agfn/db'
import { resolve } from 'node:path'

/** Hosted's early-access Plaid cap when AGFN_PLAID_MAX_ITEMS_PER_WORKSPACE isn't set (Yisrael's cost protection). */
export const HOSTED_PLAID_MAX_ITEMS = 25
/** Hosted's Finch caps when unset: one payroll connection per workspace, 15 in all (Finch Starter's limit). */
export const HOSTED_FINCH_MAX_PER_WORKSPACE = 1
export const HOSTED_FINCH_MAX_CONNECTIONS = 15
/** Hosted's FreshBooks cap when unset: FreshBooks' terms let it limit an app's access at 500 connections. */
export const HOSTED_FRESHBOOKS_MAX_CONNECTIONS = 450

export interface ServerConfig {
  port: number
  /** HOST: the address to listen on. Unset = every interface ("::", falling back to 0.0.0.0 without IPv6). */
  host?: string
  /** Public origin, no trailing slash. */
  baseUrl: string
  databaseUrl: string
  dataDir: string
  authSecret: string
  webDist: string
  /** True when running on someone's own machine without a public URL. */
  selfHosted: boolean
  /** Reviewer access links (AGFN_REVIEWER_LINKS=1). Off by default: the route answers 404 and the CLI refuses. */
  reviewerLinks?: boolean
  /** AGFN_CHALLENGE=1: the "Make it move a dollar" deployment (src/challenge): GitHub sign-in only, outbound calls
   *  recorded, nightly reset, planted flags. Boot refuses it with any real provider key (challenge/guard.ts). */
  challenge?: boolean
  /**
   * AGFN_DEMO_EXTRA_CONNECTORS (comma-separated keys, e.g. "wefunder"): real connectors a demo workspace may also link,
   * for recordings that show made-up books plus a provider's sandbox. Test deployments only (staging, or not hosted):
   * ignored where real accounts live, so real and demo data still never mix on live.
   */
  demoExtraConnectors?: string[]
  github?: { clientId: string; clientSecret: string }
  /** AGFN_PUBLIC_DEMO=1: the public no-sign-up demo at /demo/mcp (public-demo.ts). */
  publicDemo?: boolean
  /** AGFN_PUBLIC_DEMO_URL: the demo runs on its own app; this one's /demo/mcp redirects there (308). */
  publicDemoUrl?: string
  /** AGFN_PUBLIC_DEMO_PER_MIN (default 300) and AGFN_PUBLIC_DEMO_MAX_INFLIGHT (default 4): limits for all visitors together. */
  publicDemoPerMinute?: number
  /** AGFN_PUBLIC_DEMO_WEB_PER_MIN (default 12000): the web demo's requests per minute, all visitors together. */
  publicDemoWebPerMinute?: number
  /**
   * Demo keys (AGFN_PUBLIC_DEMO_KEYS: sha256 hex of each key, comma separated): a bearer token at /mcp that reaches the
   * public demo (read-only, synthetic, rebuilt nightly) for a directory's health checks. Removing a hash revokes it.
   */
  publicDemoKeyHashes?: string[]
  publicDemoMaxInFlight?: number
  /**
   * AGFN_READY_GATE=1: /healthz answers 503 until this machine has loaded the stored derived results (overviews) of
   * recently read workspaces, at most READY_GATE_MAX_MS, so Fly sends a new machine no traffic while it would be cold.
   */
  readyGate?: boolean
  /** AGFN_MCP_SHARE=1: the share_answer tool (drafts a share card). Off while a directory review pins the tool set. */
  mcpShare?: boolean
  /** AGFN_INVESTMENTS=1: the app's Investments page and its routes (/api/entities/:id/investments). */
  investments?: boolean
  /** AGFN_TOOL_INVESTMENTS=1: the get_investments MCP tool. Off while a directory review pins the tool set. */
  toolInvestments?: boolean
  /** AGFN_SET_ASIDES=1: `set_aside` on the bucket tools, the available_cash metric, and set-asides in the app. Changes tools/list, so off while a directory review pins it. The ledger and the app don't depend on it. */
  setAsides?: boolean
  /** AGFN_CONNECT_FROM_CHAT=1: the connect_source MCP tool and its confirm pages (connect-source.ts). Adds a tool to tools/list, so off until the directory reviews close and Yisrael says yes; never on the challenge. */
  connectFromChat?: boolean
  /** AGFN_TRY_CHAT=1 with ANTHROPIC_TRY_KEY: the no-sign-up demo chat at /try (try-chat.ts). AGFN_TRY_MODEL picks the model. */
  tryChat?: { key: string; model: string }
  /** AGFN_FRIEND_INVITES=1: "Invite someone" in the app and its API. Off until the privacy policy and the email's postal address are done. */
  friendInvites?: boolean
  /** AGFN_FRIEND_INVITES_PER_DAY: invite emails for everyone, per day (friend-invites.ts). They share the quota with sign-in mail. */
  friendInvitesPerDay?: number
  /** AGFN_MCP_PROMPTS=1: the prompt packs (packages/mcp/src/packs.ts). Off while a directory review pins the prompt list. */
  mcpPrompts?: boolean
  /** AGFN_DOCS_HOST (docs.aggregate.finance): this server also answers for the docs on that host (docs-host.ts). Unset: only /docs. */
  docsHost?: string
  /** AGFN_BADGES=1: "Verified by Aggregate" badges (badge.ts): /b/<id>, its .svg and /how-we-verify. Off by default. */
  badges?: boolean
  /**
   * OpenAI app submission's domain check (AGFN_OPENAI_APPS_CHALLENGE): the token the portal issues, served as plain
   * text at /.well-known/openai-apps-challenge. Public by design; unset, the route is a 404.
   */
  openaiAppsChallenge?: string
  /** AGFN_OAUTH_CIMD=1: AI clients may identify by a Client ID Metadata Document URL as well as by registering. */
  oauthCimd?: boolean
  /**
   * Glama's ownership check (AGFN_GLAMA_CLAIM): one or more claim tokens from Glama's "Claim ownership" panel, comma
   * separated, served at /.well-known/glama.json. Public by design; tokens that aren't glama_claim_… are ignored.
   */
  glamaClaim?: string[]
  google?: { clientId: string; clientSecret: string }
  apple?: { clientId: string; clientSecret: string; appBundleIdentifier?: string }
  smtpUrl?: string
  mailFrom: string
  /** Run the background worker in this process (default true; hosted can split web and worker). */
  runWorker: boolean
  /** demo: only the public demo (its own app, demo.aggregate.finance; public-demo-route.ts). */
  role: 'all' | 'web' | 'worker' | 'demo'
  syncEveryMs: number
  /** Email-in: addresses are <token>@inboundEmailDomain; the provider proves itself with inboundWebhookSecret. */
  inboundEmailDomain?: string
  inboundWebhookSecret?: string
  /** Resend inbound: the webhook's Svix signing secret (whsec_…) and an API key to fetch the email and its files. */
  resendWebhookSecret?: string
  resendApiKey?: string
  /** Where operator alerts go (Slack/Discord/ntfy-style webhook taking { text }). Console only when unset. */
  alertWebhookUrl?: string
  /** Operator alerts to a Telegram chat (ALERT_TELEGRAM_BOT_TOKEN and ALERT_TELEGRAM_CHAT_ID, both needed). */
  alertTelegram?: { botToken: string; chatId: string }
  /** Proxy-set header holding the real client IP (CLIENT_IP_HEADER), e.g. fly-client-ip. */
  clientIpHeader?: string
  /** Sign-in emails per client IP per 15 minutes (AGFN_SIGNIN_IP_LIMIT, default 20). Raised only on staging for load tests. */
  signInIpLimit?: number
  /** In-app intrusion detection (intrusion.ts, AGFN_INTRUSION): detect (default, alerts only), block (adds a 15-minute cool-off) or off. */
  intrusion?: 'block' | 'off'
  /**
   * Most Plaid bank connections (Items not disconnected) one workspace may have (AGFN_PLAID_MAX_ITEMS_PER_WORKSPACE).
   * Hosted (AGFN_HOSTED=1 or a Neon or RDS database) is always capped: 25 unless set to another positive number, so a machine
   * missing its [env] block can't run up an open-ended Plaid bill. Self-hosted: unset = no cap (they pay Plaid themselves).
   */
  plaidMaxItems?: number
  /**
   * Most Xero organisations the server's Xero app may have connected, across every workspace (AGFN_XERO_MAX_CONNECTIONS).
   * Xero caps connections per app by plan (Starter 5, Core 50, Plus 1,000); at the cap, Xero's own consent screen refuses
   * and the person may never come back. Set it to the plan's number and Connect → Xero says so plainly first. Unset = no check.
   */
  xeroMaxConnections?: number
  /**
   * Finch bills per connected company each month, so hosted caps it: payroll connections one workspace may have
   * (AGFN_FINCH_MAX_CONNECTIONS_PER_WORKSPACE, hosted default 1) and across every workspace
   * (AGFN_FINCH_MAX_CONNECTIONS, hosted default 15, Finch Starter's cap). Self-hosted: unset = no cap.
   */
  finchMaxPerWorkspace?: number
  finchMaxConnections?: number
  /**
   * Most FreshBooks connections across every workspace (AGFN_FRESHBOOKS_MAX_CONNECTIONS, hosted default 450). FreshBooks'
   * terms let it limit an app's access at 500, so hosted stops short and warns from 400. Self-hosted: unset = no cap.
   */
  freshbooksMaxConnections?: number
  /** The hosted service (AGFN_HOSTED=1): every connector is configured, so setup guides for missing ones are hidden. */
  hosted?: boolean
  /** Demo fills at once (AGFN_DEMO_FILL_CONCURRENCY; hosted default 3, the rest wait in line). Unset: no limit. */
  demoFillConcurrency?: number
  /** Demos kept filled ahead of time, handed over instantly (AGFN_DEMO_POOL; hosted default 5, 0 = none). Needs the fill limit. */
  demoPool?: number
  /** Hosted connectors not offered for new connections yet (hostedUnlisted); still registered for callbacks and syncs. */
  unlisted?: string[]
  /**
   * Hosted: connectors offered only to the workspaces an operator names (AGFN_ETSY_WORKSPACES for Etsy), on top of their
   * own offer flag. An empty list means nobody. Self-hosted: unset, so no limit.
   */
  onlyWorkspaces?: Record<string, string[]>
  /**
   * Connectors an operator paused for NEW connections (AGFN_HIDE_CONNECTORS=plaid,square): left out of the catalog and
   * refused at start, for everyone. Existing connections keep syncing, reconnecting and receiving webhooks.
   */
  hidden?: string[]
  /** Hosted connectors offered as "beta": built to the provider's docs, not yet connected end to end with an account. */
  beta?: string[]
}

/** AGFN_PUBLIC_DEMO_KEYS: only sha256 hex digests are kept (the keys themselves never sit in config). */
const demoKeyHashes = (raw: string | undefined): string[] =>
  (raw ?? '').split(',').map((t) => t.trim().toLowerCase()).filter((t) => /^[0-9a-f]{64}$/.test(t))

/** AGFN_GLAMA_CLAIM's tokens: comma separated, only Glama's own token shape kept. */
const glamaClaims = (raw: string | undefined): string[] =>
  (raw ?? '').split(',').map((t) => t.trim()).filter((t) => /^glama_claim_[A-Za-z0-9_-]{32}$/.test(t))

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key]
  if (!v) throw new Error(`Missing required setting ${key}. See .env.example.`)
  return v
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORT ?? 8787)
  const baseUrl = (env.BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, '')
  const dataDir = resolve(env.DATA_DIR ?? './data')
  const authSecret = req(env, 'AUTH_SECRET')
  if (authSecret.length < 32) throw new Error('AUTH_SECRET must be at least 32 characters')
  const role = (env.AGFN_ROLE ?? 'all') as ServerConfig['role']
  if (!['all', 'web', 'worker', 'demo'].includes(role)) throw new Error('AGFN_ROLE must be all, web, worker or demo')
  const host = new URL(baseUrl).hostname
  return {
    port,
    ...(env.HOST ? { host: env.HOST } : {}),
    baseUrl,
    databaseUrl: env.DATABASE_URL ?? `sqlite:${resolve(dataDir, 'agfn.db')}`,
    dataDir,
    authSecret,
    webDist: resolve(env.WEB_DIST ?? new URL('../../web/dist', import.meta.url).pathname),
    selfHosted: host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local'),
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } } : {}),
    ...(env.APPLE_CLIENT_ID && env.APPLE_CLIENT_SECRET
      ? { apple: { clientId: env.APPLE_CLIENT_ID, clientSecret: env.APPLE_CLIENT_SECRET, ...(env.APPLE_APP_BUNDLE_ID ? { appBundleIdentifier: env.APPLE_APP_BUNDLE_ID } : {}) } }
      : {}),
    ...(env.SMTP_URL ? { smtpUrl: env.SMTP_URL } : {}),
    mailFrom: env.MAIL_FROM ?? `Aggregate <no-reply@${host}>`,
    runWorker: role !== 'web',
    role,
    syncEveryMs: Number(env.SYNC_EVERY_MINUTES ?? 60) * 60_000,
    ...(env.INBOUND_EMAIL_DOMAIN ? { inboundEmailDomain: env.INBOUND_EMAIL_DOMAIN.toLowerCase() } : {}),
    ...(env.INBOUND_WEBHOOK_SECRET ? { inboundWebhookSecret: env.INBOUND_WEBHOOK_SECRET } : {}),
    ...(env.RESEND_WEBHOOK_SECRET ? { resendWebhookSecret: env.RESEND_WEBHOOK_SECRET } : {}),
    ...(env.RESEND_API_KEY ? { resendApiKey: env.RESEND_API_KEY } : {}),
    ...(env.AGFN_REVIEWER_LINKS === '1' ? { reviewerLinks: true } : {}),
    ...(env.AGFN_CHALLENGE === '1' ? { challenge: true } : {}),
    ...(demoExtraConnectors(env).length ? { demoExtraConnectors: demoExtraConnectors(env) } : {}),
    ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } } : {}),
    // The demo app always serves the demo.
    ...(env.AGFN_PUBLIC_DEMO === '1' || role === 'demo' ? { publicDemo: true } : {}),
    ...(/^https:\/\//.test(env.AGFN_PUBLIC_DEMO_URL ?? '') && role !== 'demo' ? { publicDemoUrl: env.AGFN_PUBLIC_DEMO_URL } : {}),
    ...(/^[1-9]\d*$/.test(env.AGFN_PUBLIC_DEMO_PER_MIN ?? '') ? { publicDemoPerMinute: Number(env.AGFN_PUBLIC_DEMO_PER_MIN) } : {}),
    ...(/^[1-9]\d*$/.test(env.AGFN_PUBLIC_DEMO_WEB_PER_MIN ?? '') ? { publicDemoWebPerMinute: Number(env.AGFN_PUBLIC_DEMO_WEB_PER_MIN) } : {}),
    ...(demoKeyHashes(env.AGFN_PUBLIC_DEMO_KEYS).length ? { publicDemoKeyHashes: demoKeyHashes(env.AGFN_PUBLIC_DEMO_KEYS) } : {}),
    ...(/^[1-9]\d*$/.test(env.AGFN_PUBLIC_DEMO_MAX_INFLIGHT ?? '') ? { publicDemoMaxInFlight: Number(env.AGFN_PUBLIC_DEMO_MAX_INFLIGHT) } : {}),
    ...(env.AGFN_READY_GATE === '1' ? { readyGate: true } : {}),
    ...(env.AGFN_MCP_SHARE === '1' ? { mcpShare: true } : {}),
    ...(env.AGFN_INVESTMENTS === '1' ? { investments: true } : {}),
    ...(env.AGFN_TOOL_INVESTMENTS === '1' ? { toolInvestments: true } : {}),
    ...(env.AGFN_SET_ASIDES === '1' ? { setAsides: true } : {}),
    // Connect-from-chat adds a tool to tools/list, and connecting sources has no place in the challenge sandbox: never on the challenge.
    ...(env.AGFN_CONNECT_FROM_CHAT === '1' && env.AGFN_CHALLENGE !== '1' ? { connectFromChat: true } : {}),
    ...(env.AGFN_FRIEND_INVITES === '1' ? { friendInvites: true } : {}),
    ...(env.AGFN_TRY_CHAT === '1' && env.ANTHROPIC_TRY_KEY ? { tryChat: { key: env.ANTHROPIC_TRY_KEY, model: ['claude-haiku-5-5', 'claude-sonnet-5-5'].includes(env.AGFN_TRY_MODEL ?? '') ? env.AGFN_TRY_MODEL! : 'claude-haiku-5-5' } } : {}),
    ...(Number(env.AGFN_FRIEND_INVITES_PER_DAY) > 0 ? { friendInvitesPerDay: Number(env.AGFN_FRIEND_INVITES_PER_DAY) } : {}),
    ...(env.AGFN_DOCS_HOST ? { docsHost: env.AGFN_DOCS_HOST.trim().toLowerCase() } : {}),
    ...(env.AGFN_MCP_PROMPTS === '1' ? { mcpPrompts: true } : {}),
    ...(env.AGFN_OAUTH_CIMD === '1' ? { oauthCimd: true } : {}),
    ...(env.AGFN_BADGES === '1' ? { badges: true } : {}),
    ...(env.AGFN_OPENAI_APPS_CHALLENGE?.trim() ? { openaiAppsChallenge: env.AGFN_OPENAI_APPS_CHALLENGE.trim() } : {}),
    ...(glamaClaims(env.AGFN_GLAMA_CLAIM).length ? { glamaClaim: glamaClaims(env.AGFN_GLAMA_CLAIM) } : {}),
    ...(env.ALERT_WEBHOOK_URL ? { alertWebhookUrl: env.ALERT_WEBHOOK_URL } : {}),
    ...(env.ALERT_TELEGRAM_BOT_TOKEN?.trim() && env.ALERT_TELEGRAM_CHAT_ID?.trim() ? { alertTelegram: { botToken: env.ALERT_TELEGRAM_BOT_TOKEN.trim(), chatId: env.ALERT_TELEGRAM_CHAT_ID.trim() } } : {}),
    ...(env.CLIENT_IP_HEADER ? { clientIpHeader: env.CLIENT_IP_HEADER } : env.FLY_APP_NAME ? { clientIpHeader: 'fly-client-ip' } : {}),
    ...(/^[1-9]\d*$/.test(env.AGFN_SIGNIN_IP_LIMIT ?? '') ? { signInIpLimit: Number(env.AGFN_SIGNIN_IP_LIMIT) } : {}),
    ...(env.AGFN_INTRUSION === 'block' || env.AGFN_INTRUSION === 'off' ? { intrusion: env.AGFN_INTRUSION } : {}),
    ...(/^[1-9]\d*$/.test(env.AGFN_PLAID_MAX_ITEMS_PER_WORKSPACE ?? '')
      ? { plaidMaxItems: Number(env.AGFN_PLAID_MAX_ITEMS_PER_WORKSPACE) }
      : isHostedDb(env, env.DATABASE_URL ?? '')
        ? { plaidMaxItems: HOSTED_PLAID_MAX_ITEMS }
        : {}),
    ...(/^[1-9]\d*$/.test(env.AGFN_XERO_MAX_CONNECTIONS ?? '') ? { xeroMaxConnections: Number(env.AGFN_XERO_MAX_CONNECTIONS) } : {}),
    ...positiveOrHosted(env, 'finchMaxPerWorkspace', env.AGFN_FINCH_MAX_CONNECTIONS_PER_WORKSPACE, HOSTED_FINCH_MAX_PER_WORKSPACE),
    ...positiveOrHosted(env, 'finchMaxConnections', env.AGFN_FINCH_MAX_CONNECTIONS, HOSTED_FINCH_MAX_CONNECTIONS),
    ...positiveOrHosted(env, 'freshbooksMaxConnections', env.AGFN_FRESHBOOKS_MAX_CONNECTIONS, HOSTED_FRESHBOOKS_MAX_CONNECTIONS),
    ...(env.AGFN_HOSTED === '1' ? { hosted: true } : {}),
    ...(env.AGFN_DEMO_POOL !== undefined && env.AGFN_DEMO_POOL !== '' ? (Number(env.AGFN_DEMO_POOL) > 0 ? { demoPool: Math.floor(Number(env.AGFN_DEMO_POOL)) } : {}) : env.AGFN_HOSTED === '1' ? { demoPool: 5 } : {}),
    ...(Number(env.AGFN_DEMO_FILL_CONCURRENCY) > 0 ? { demoFillConcurrency: Math.floor(Number(env.AGFN_DEMO_FILL_CONCURRENCY)) } : env.AGFN_HOSTED === '1' ? { demoFillConcurrency: 3 } : {}),
    ...(hostedUnlisted(env).length ? { unlisted: hostedUnlisted(env) } : {}),
    ...(hiddenConnectors(env).length ? { hidden: hiddenConnectors(env) } : {}),
    ...(env.AGFN_HOSTED === '1' ? { beta: [...HOSTED_BETA] } : {}),
    // Etsy, if ever offered again, goes only to the small group of sellers we've agreed with Etsy (#28407714).
    ...(env.AGFN_HOSTED === '1' ? { onlyWorkspaces: { etsy: workspaceList(env.AGFN_ETSY_WORKSPACES) } } : {}),
  }
}

/**
 * Connectors built and tested against each provider's documentation that nobody has yet connected with a real or
 * sandbox account. Hosted marks them "beta" in the catalog; take a key out once it's verified end to end (§15 matrix) or approved.
 */
export const HOSTED_BETA = ['mercury', 'brex', 'ramp', 'wise', 'paddle', 'polar', 'appstore', 'googleplay', 'gumroad', 'patreon'] as const

/**
 * Hosted connectors that would connect to something other than what people expect, so they aren't offered yet:
 * Stripe before the Stripe App is approved (only the External test link, which installs in test mode), and Plaid
 * before production (sandbox Plaid shows made-up banks). Staging offers both in test mode (AGFN_OFFER_TEST_CONNECTORS=1);
 * reviewer accounts may always use Plaid (app.ts).
 */
export function hostedUnlisted(env: NodeJS.ProcessEnv): string[] {
  if (env.AGFN_HOSTED !== '1' || env.AGFN_OFFER_TEST_CONNECTORS === '1') return []
  const out: string[] = []
  if (!(env.STRIPE_APP_SECRET_KEY_LIVE || env.STRIPE_APP_SECRET_KEY)) out.push('stripe')
  // The challenge app links Plaid's sandbox bank on purpose (players test against it): offered there.
  if (env.PLAID_ENV !== 'production' && env.AGFN_CHALLENGE !== '1') out.push('plaid')
  // Carta's playground shows fake personas; production needs Carta's app review first.
  if (env.CARTA_CLIENT_ID && env.CARTA_ENV !== 'production') out.push('carta')
  // Chargebee: built and fixture-tested, not yet run against a real Chargebee site. Staging offers it (test
  // connectors above); live waits for AGFN_OFFER_CHARGEBEE=1.
  if (env.AGFN_OFFER_CHARGEBEE !== '1') out.push('chargebee')
  // WooCommerce: built and fixture-tested, not yet run against a real store. Staging offers it (test connectors above);
  // live waits for AGFN_OFFER_WOOCOMMERCE=1.
  if (env.AGFN_OFFER_WOOCOMMERCE !== '1') out.push('woocommerce')
  // BigCommerce: built from its docs, never run on a real store. BigCommerce can't show a token's scopes, so read-only rests
  // on the steps we give and a GET-only client. Live waits for AGFN_OFFER_BIGCOMMERCE=1 (package README).
  if (env.AGFN_OFFER_BIGCOMMERCE !== '1') out.push('bigcommerce')
  // Amazon: built from Amazon's docs, never run on a real seller account, and the app is still Draft (only a self-authorized
  // test seller can sign in). Live waits for AGFN_OFFER_AMAZON=1 after a real Draft test (package README).
  if (env.AMAZON_SPAPI_CLIENT_ID && env.AGFN_OFFER_AMAZON !== '1') out.push('amazon')
  // Etsy: built from Etsy's docs and spec, never run on a real shop, and the ledger_type names aren't documented. Live
  // waits for AGFN_OFFER_ETSY=1 after a real shop syncs cleanly (package README).
  if (env.ETSY_CLIENT_ID && env.AGFN_OFFER_ETSY !== '1') out.push('etsy')
  // RevenueCat: same, built and fixture-tested from its docs only. RevenueCat can't show a key's permissions either, so
  // read-only rests on the steps we give. Live waits for AGFN_OFFER_REVENUECAT=1.
  if (env.AGFN_OFFER_REVENUECAT !== '1') out.push('revenuecat')
  // Zeffy: built from its docs, never run on a real organization. Zeffy has no read-only key, so read-only rests on a
  // GET-only client. Live waits for AGFN_OFFER_ZEFFY=1 (package README).
  if (env.AGFN_OFFER_ZEFFY !== '1') out.push('zeffy')
  // FreshBooks: built and fixture-tested from its docs only, and it posts to the books. Staging tries it first (test
  // connectors above); live waits for AGFN_OFFER_FRESHBOOKS=1 after a real connect there.
  if (env.FRESHBOOKS_CLIENT_ID && env.AGFN_OFFER_FRESHBOOKS !== '1') out.push('freshbooks')
  // Wefunder: until Wefunder approves the app, only Aggregate's own team could authorize it (others see "not reviewed").
  if (env.WEFUNDER_CLIENT_ID && env.WEFUNDER_APPROVED !== '1') out.push('wefunder')
  // Coinbase: sign-in only on hosted (no keys). Once the OAuth client exists, staging tries it first (test connectors
  // above); live waits for AGFN_OFFER_COINBASE=1 after a real connect there.
  if (env.COINBASE_CLIENT_ID && env.AGFN_OFFER_COINBASE !== '1') out.push('coinbase')
  // Harvest: built from its docs, never run on a real account. Sign-in only on hosted. Staging tries Aggregate's app first
  // (test connectors above); live waits for AGFN_OFFER_HARVEST=1 after a real connect there.
  if (env.HARVEST_CLIENT_ID && env.AGFN_OFFER_HARVEST !== '1') out.push('harvest')
  // Lightspeed: built from its docs, never run on a real account. Sign-in only on hosted. Staging tries Aggregate's app first
  // (test connectors above); live waits for AGFN_OFFER_LIGHTSPEED=1 after a real connect there.
  if (env.LIGHTSPEED_CLIENT_ID && env.AGFN_OFFER_LIGHTSPEED !== '1') out.push('lightspeed')
  // SumUp: built from its docs, never run on a real account. Sign-in only on hosted. Staging tries Aggregate's app first
  // (test connectors above); live waits for AGFN_OFFER_SUMUP=1 after a real connect there.
  if (env.SUMUP_CLIENT_ID && env.AGFN_OFFER_SUMUP !== '1') out.push('sumup')
  // AdSense: built from its docs, never run on a real account. Google's API terms need reading against stored snapshots
  // and its uncapped indemnity waits for the company (package README). Live waits for AGFN_OFFER_ADSENSE=1.
  if (env.ADSENSE_CLIENT_ID && env.AGFN_OFFER_ADSENSE !== '1') out.push('adsense')
  // YouTube: built from its docs, never run on a real account. Verification, who may see the data and its uncapped
  // indemnity come first (package README). Live waits for AGFN_OFFER_YOUTUBE=1.
  if (env.YOUTUBE_CLIENT_ID && env.AGFN_OFFER_YOUTUBE !== '1') out.push('youtube')
  // Pinterest: built from its docs, never run on a real account. App review, its uncapped indemnity and the MCP clause come
  // first (package README). Live waits for AGFN_OFFER_PINTEREST=1.
  if (env.PINTEREST_CLIENT_ID && env.AGFN_OFFER_PINTEREST !== '1') out.push('pinterest')
  // Squarespace: built from its docs, never run on a real site. s.7.4.6 needs a written answer, the app needs production
  // review, and its uncapped indemnity waits for the company (package README). Live waits for AGFN_OFFER_SQUARESPACE=1.
  if (env.SQUARESPACE_CLIENT_ID && env.AGFN_OFFER_SQUARESPACE !== '1') out.push('squarespace')
  // OwnerRez: built from its docs, never run on a real account. Other hosts' accounts need a partnership agreement with
  // OwnerRez first (package README). Live waits for AGFN_OFFER_OWNERREZ=1.
  if (env.OWNERREZ_CLIENT_ID && env.AGFN_OFFER_OWNERREZ !== '1') out.push('ownerrez')
  // Whop: built from its docs, never run on a real business. Its Developer API Terms carry an uncapped indemnity, so no app
  // is registered until the LLC, insurance quotes and 34's confirmation (package README). Live waits for AGFN_OFFER_WHOP=1.
  if (env.WHOP_CLIENT_ID && env.AGFN_OFFER_WHOP !== '1') out.push('whop')
  // Mollie: built from its docs, never run on a real account. Its User Agreement carries an uncapped indemnity, so no app is
  // registered until the LLC, insurance quotes and 34's confirmation (package README). Live waits for AGFN_OFFER_MOLLIE=1.
  if (env.MOLLIE_CLIENT_ID && env.AGFN_OFFER_MOLLIE !== '1') out.push('mollie')
  // Wix: built from its docs, never run on a real site. It needs App Market review or Wix's written approval, and its uncapped
  // indemnities wait for the company's insurance (package README). Live waits for AGFN_OFFER_WIX=1.
  if (env.WIX_CLIENT_ID && env.AGFN_OFFER_WIX !== '1') out.push('wix')
  // Gumroad: sign-in only on hosted. Staging tries Aggregate's app first (test connectors above); live waits for
  // AGFN_OFFER_GUMROAD=1 after a real connect there.
  if (env.GUMROAD_CLIENT_ID && env.AGFN_OFFER_GUMROAD !== '1') out.push('gumroad')
  // Patreon: the same, sign-in only on hosted. Nothing has run against a real Patreon account yet; live waits for
  // AGFN_OFFER_PATREON=1 after a real connect on staging.
  if (env.PATREON_CLIENT_ID && env.AGFN_OFFER_PATREON !== '1') out.push('patreon')
  return out
}

/** A list of workspace ids, comma or space separated; anything that isn't an id is ignored. */
export function workspaceList(v: string | undefined): string[] {
  return [...new Set((v ?? '').split(/[\s,]+/).filter((id) => /^[0-9A-Za-z_-]{8,64}$/.test(id)))]
}

/** Connectors this workspace isn't on the operator's list for (config.onlyWorkspaces). No workspace: all of them. */
export function notForWorkspace(config: Pick<ServerConfig, 'onlyWorkspaces'>, workspaceId: string | null | undefined): string[] {
  return Object.entries(config.onlyWorkspaces ?? {})
    .filter(([, ids]) => !workspaceId || !ids.includes(workspaceId))
    .map(([key]) => key)
}

/** AGFN_HIDE_CONNECTORS: connector keys, comma or space separated (the operator's pause, e.g. a Plaid rollback). */
export function hiddenConnectors(env: NodeJS.ProcessEnv): string[] {
  return [...new Set((env.AGFN_HIDE_CONNECTORS ?? '').toLowerCase().split(/[\s,]+/).filter((k) => /^[a-z0-9_-]+$/.test(k)))]
}

/** Browsers allow passkeys only on https or localhost (an IP address can't be a passkey's site either). */
export function passkeysPossible(baseUrl: string): boolean {
  const u = new URL(baseUrl)
  return u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname.endsWith('.localhost')
}

/** This process's release for the job queue's release guard (jobs.ts): AGFN_RELEASE, else Fly's FLY_IMAGE_REF. */
export const releaseOf = (env: Record<string, string | undefined>): string | undefined => env.AGFN_RELEASE?.trim() || env.FLY_IMAGE_REF?.trim() || undefined

/**
 * Settings hosted Aggregate depends on to protect its users, checked at boot. "Hosted" is AGFN_HOSTED=1 or a Neon
 * database (rls.ts isHostedDb): a machine started without its fly.toml [env] block has no AGFN_HOSTED but still has
 * the database secret, and must refuse to start rather than run without these. Empty when all is well.
 */
export function hostedConfigProblems(env: Record<string, string | undefined>, config: Pick<ServerConfig, 'databaseUrl' | 'baseUrl' | 'smtpUrl' | 'clientIpHeader'> & Partial<Pick<ServerConfig, 'runWorker'>>): string[] {
  if (!isHostedDb(env, config.databaseUrl)) return []
  const out: string[] = []
  const base = new URL(config.baseUrl)
  if (base.protocol !== 'https:' || base.hostname === 'localhost' || base.hostname.endsWith('.localhost')) out.push(`BASE_URL must be the public https address (got ${base.origin}): sign-in links and AI callbacks are built from it`)
  // No email and no uploads by design: the challenge deployment (GitHub sign-in, made-up data; challenge/guard.ts refuses
  // mail keys outright) and the demo app (AGFN_ROLE=demo, the read-only public demo only).
  const noMail = env.AGFN_CHALLENGE === '1' || env.AGFN_ROLE === 'demo'
  if (!noMail && !config.smtpUrl) out.push('SMTP_URL is not set: sign-in links would go to the server log instead of people')
  if (!noMail && !env.MAIL_FROM?.trim()) out.push('MAIL_FROM is not set: emails would come from an unverified address and not arrive')
  // Every per-IP limit (sign-in codes, referrals, the demo gate) and the intrusion guard need the client's IP from the
  // one header the proxy in front sets. Fly sets fly-client-ip (picked automatically when FLY_APP_NAME is set). Anywhere
  // else, CLIENT_IP_HEADER must name the header the proxy overwrites (x-real-ip from Caddy): without it the limits
  // would quietly stop working.
  if (!config.clientIpHeader) out.push('CLIENT_IP_HEADER is not set: per-IP sign-in limits and the intrusion guard would be off. Set it to the header your proxy overwrites with the real client IP (x-real-ip from Caddy; fly-client-ip is automatic on Fly)')
  // The release guard (jobs.ts) keeps an old release's worker from claiming jobs during a deploy's overlap, and is off
  // without a release id. Fly sets FLY_IMAGE_REF on every machine; anywhere else the deploy must set AGFN_RELEASE (a
  // fresh value per deploy, scripts/deploy-aws.sh), or the old and new workers would both claim jobs.
  if (config.runWorker !== false && !releaseOf(env)) out.push('AGFN_RELEASE is not set: the job release guard would be off, so an old release could run jobs during a deploy. Set it to a fresh id per deploy (FLY_IMAGE_REF is automatic on Fly)')
  if (!env.AGFN_PG_RLS_ROLE && !env.AGFN_PG_APP_URL) out.push("AGFN_PG_RLS_ROLE (or AGFN_PG_APP_URL) is not set: the database's login role owns the tables (and on Neon bypasses row-level security), so the policies would not apply")
  // Staging keeps test uploads on its scratch disk on purpose: AGFN_FILES_LOCAL=1 lives in fly.staging.toml's [env], so a
  // machine started without that block still refuses.
  if (!noMail && !env.FILES_S3_BUCKET && env.AGFN_FILES_LOCAL !== '1') out.push("FILES_S3_BUCKET is not set: uploaded documents would land on this machine's scratch disk")
  return out
}

/** A positive whole number from the env; else the hosted default on a hosted database; else nothing (no cap). */
function positiveOrHosted<K extends string>(env: Record<string, string | undefined>, key: K, raw: string | undefined, hostedDefault: number): Partial<Record<K, number>> {
  if (/^[1-9]\d*$/.test(raw ?? '')) return { [key]: Number(raw) } as Record<K, number>
  return isHostedDb(env, env.DATABASE_URL ?? '') ? ({ [key]: hostedDefault } as Record<K, number>) : {}
}

/** AGFN_DEMO_EXTRA_CONNECTORS, honored only on test deployments (AGFN_OFFER_TEST_CONNECTORS=1, or not hosted). */
export function demoExtraConnectors(env: Record<string, string | undefined>): string[] {
  if (env.AGFN_HOSTED === '1' && env.AGFN_OFFER_TEST_CONNECTORS !== '1') return []
  return (env.AGFN_DEMO_EXTRA_CONNECTORS ?? '').split(',').map((k) => k.trim()).filter((k) => /^[a-z0-9_-]+$/.test(k))
}

