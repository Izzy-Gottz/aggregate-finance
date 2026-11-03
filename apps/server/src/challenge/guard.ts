// The challenge deployment (AGFN_CHALLENGE=1) is open to anyone trying to break it, so it must never hold a key that
// can touch real money or real data. Boot refuses to start unless that holds; the same check runs in CI against
// fly.challenge.toml (guard.test.ts).

/** Provider prefixes whose keys may never be present on the challenge server. Plaid is allowed in sandbox only. */
export const CHALLENGE_FORBIDDEN_PREFIXES = [
  'STRIPE', 'SQUARE', 'QUICKBOOKS', 'XERO', 'PAYPAL', 'WISE', 'MERCURY', 'RAMP', 'BREX', 'FINCH', 'JUSTWORKS', 'SHOPIFY',
  'BILL', 'DEEL', 'PADDLE', 'POLAR', 'LEMONSQUEEZY', 'RIPPLING', 'APPSTORE', 'GOOGLEPLAY', 'GUMROAD', 'LIGHTSPEED', 'SUMUP', 'ADSENSE', 'YOUTUBE', 'PINTEREST', 'SQUARESPACE', 'WIX', 'SIMPLEFIN', 'CARTA', 'GOOGLE', 'APPLE', 'FRESHBOOKS', 'PATREON', 'HARVEST',
  'RESEND', 'SMTP', 'BACKUP_S3', 'AGFN_OPENAI_APPS_CHALLENGE', 'AGFN_REVIEWER_LINKS',
] as const

/** Hosts the challenge may never serve as (the real service). */
const REAL_HOSTS = ['app.aggregate.finance', 'aggregate.finance', 'staging.aggregate.finance']

export function challengeConfigProblems(env: Record<string, string | undefined>): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(env)) {
    if (!v) continue
    if (CHALLENGE_FORBIDDEN_PREFIXES.some((p) => k === p || k.startsWith(`${p}_`))) out.push(`${k} is set: the challenge server may hold no keys but Plaid sandbox and GitHub sign-in`)
  }
  if ((env.PLAID_CLIENT_ID || env.PLAID_SECRET) && env.PLAID_ENV !== 'sandbox') out.push(`PLAID_ENV must be "sandbox" on the challenge server (got "${env.PLAID_ENV ?? ''}")`)
  try {
    const host = new URL(env.BASE_URL ?? '').hostname
    if (REAL_HOSTS.includes(host)) out.push(`BASE_URL is the real service (${host}): the challenge runs only on its own domain`)
  } catch {
    out.push('BASE_URL must be set to the challenge domain')
  }
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) out.push('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required: players sign in with GitHub')
  return out
}
