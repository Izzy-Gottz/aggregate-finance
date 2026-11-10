// Amazon SP-API sandbox probe, staging only. Proves the plumbing against Amazon's static sandbox: an LWA token from the
// sandbox app's refresh token, the two Finances v0 calls with the exact parameters the sandbox answers, and the settlement
// reader on what comes back. It proves no numbers: the sandbox's canned settlement and its canned events don't belong
// together, so the add-up check isn't run. Never creates a connection or stores anything.
//
//   fly ssh console -a aggregate-stg -C "node packages/connectors/amazon/src/sandbox-probe.ts"
//
// Needs AMAZON_SPAPI_SANDBOX_CLIENT_ID, _CLIENT_SECRET and _REFRESH_TOKEN (a Sandbox app's "View sandbox credentials" and
// "Create Token"). Prints statuses and counts only, never a token or an amount.

import { getOnly, classifyAmazonError, LWA_TOKEN_URL, USER_AGENT } from './client.ts'
import { Tally } from './settle.ts'

export const STAGING_BASE_URL = 'https://staging.aggregate.finance'
export const SANDBOX_ENDPOINT = 'https://sandbox.sellingpartnerapi-na.amazon.com'
/** The parameters Amazon's static sandbox matches (financesV0.json, x-amzn-api-sandbox). Anything else gets a 400. */
export const SANDBOX_CALLS = {
  groups: '/finances/v0/financialEventGroups?MaxResultsPerPage=1&FinancialEventGroupStartedAfter=2019-10-13&FinancialEventGroupStartedBefore=2019-10-31',
  events: '/finances/v0/financialEventGroups/485734534857/financialEvents?MaxResultsPerPage=10',
} as const

type Line = { step: string; ok: boolean; detail: string }

export async function runSandboxProbe(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): Promise<Line[]> {
  const out: Line[] = []
  const say = (step: string, ok: boolean, detail: string) => (out.push({ step, ok, detail }), ok)

  // Staging only: Fly's staging app, or staging by its address (the same check on any host, e.g. AWS).
  const onStaging = env.FLY_APP_NAME === 'aggregate-stg' || env.BASE_URL === STAGING_BASE_URL
  if (!onStaging && env.AGFN_AMAZON_PROBE_LOCAL !== '1') {
    say('staging', false, 'refused: this probe runs on staging only')
    return out
  }
  const { AMAZON_SPAPI_SANDBOX_CLIENT_ID: id, AMAZON_SPAPI_SANDBOX_CLIENT_SECRET: secret, AMAZON_SPAPI_SANDBOX_REFRESH_TOKEN: refresh } = env
  if (!id || !secret || !refresh) {
    say('credentials', false, 'missing AMAZON_SPAPI_SANDBOX_CLIENT_ID, _CLIENT_SECRET or _REFRESH_TOKEN')
    return out
  }

  // The one POST, to LWA (not the SP-API): the same exchange the connector makes on each sync.
  const tok = await fetchImpl(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: id, client_secret: secret }),
  })
  const tokBody = (await tok.json().catch(() => ({}))) as { access_token?: unknown }
  const access = typeof tokBody.access_token === 'string' ? tokBody.access_token : ''
  if (!say('lwa token', tok.ok && !!access, `HTTP ${tok.status}${access ? ', access token received' : ''}`)) return out

  const get = getOnly(fetchImpl)
  const call = async (path: string) => {
    const res = await get(SANDBOX_ENDPOINT + path, { headers: { 'x-amz-access-token': access, 'user-agent': USER_AGENT } })
    const body = (await res.json().catch(() => null)) as { payload?: Record<string, unknown> } | null
    return { res, payload: body?.payload }
  }

  const g = await call(SANDBOX_CALLS.groups)
  const groups = Array.isArray(g.payload?.FinancialEventGroupList) ? (g.payload.FinancialEventGroupList as unknown[]) : null
  if (!say('settlement list', g.res.ok && !!groups, g.res.ok ? `HTTP 200, ${groups?.length ?? 'no'} settlement(s)` : classifyAmazonError(g.res.status).message)) return out

  const e = await call(SANDBOX_CALLS.events)
  const events = e.payload?.FinancialEvents
  if (!say('settlement events', e.res.ok && !!events && typeof events === 'object', e.res.ok ? 'HTTP 200' : classifyAmazonError(e.res.status).message)) return out

  // The reader must know every event list the sandbox sends. Currency: the canned events are USD.
  try {
    const t = new Tally('USD')
    t.addEvents(events as Record<string, unknown>)
    const lists = Object.entries(events as Record<string, unknown>).filter(([, v]) => Array.isArray(v) && v.length).map(([k]) => k)
    say('reader', true, `read ${lists.length} event list(s): ${lists.join(', ') || 'none'}`)
  } catch (err) {
    say('reader', false, err instanceof Error ? err.message : 'failed')
  }
  return out
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const lines = await runSandboxProbe(process.env)
  for (const l of lines) console.log(`${l.ok ? 'ok  ' : 'FAIL'} ${l.step}: ${l.detail}`)
  process.exitCode = lines.every((l) => l.ok) ? 0 : 1
}
