# Incident response policy

Status: DRAFT, pending founder approval.

Owner: the founder. Review date: 2027-04-10.

## Purpose

Say what the founder does when something goes wrong with security, so the response is fast and the right people
are told on time.

## Scope

Any event that could expose, change or destroy customer data, or that gives someone access they should not have.
Examples: a leaked secret, a stolen laptop, unauthorized access to a cloud account, a bug that shows one
workspace's data to another, a suspicious AI write, a vulnerability report through `SECURITY.md`, or a security
notice from a vendor such as Plaid or the host.

## Roles

- **Incident lead:** the founder. He does every step below.
- **Backup contact:** None yet. The founder accepts this risk; a backup contact will be named before hosted launch.

## Severity

| Level | Meaning | Example |
|---|---|---|
| High | Customer data exposed or changed, or a production secret is known to be leaked | Master key or Plaid secret leaked; cross-workspace data leak |
| Medium | Possible exposure, not yet confirmed; or a working vulnerability with no sign of use | Suspicious login on an admin console; credible vulnerability report |
| Low | No customer data at risk | A failed phishing attempt; a dev-only secret committed and caught |

## Policy

1. **Detect.** Signals today:
   - Vulnerability reports to security@aggregate.finance (`SECURITY.md`).
     Being set up with Cloudflare Email Routing to forward to the founder's inbox and phone (October 2026).
   - Health checks on `/healthz` (`Dockerfile`, `fly.toml`, `railway.json`).
   - The hash-chained activity log. `verifyChain()` finds edited or deleted rows (`packages/mcp/src/activity.ts`).
   - Large-cash alerts on AI writes. Today these only go to the server log (`onAlert` in
     `apps/server/src/modules.ts`), so nobody is paged.
   - Security emails from vendors and GitHub.

   Target, before hosted launch: uptime monitoring and error tracking that alert the founder's phone, and alerts
   for `onAlert`, auth-failure spikes, webhook signature failures and `verifyChain` failures.
   Decision: Fly.io health checks, Better Stack uptime monitoring (free tier) alerting the founder's phone, and `ALERT_WEBHOOK_URL` for app alerts.
2. **Log it.** Open an entry in the incident log right away: time found, how it was found, what is known.
   Keep adding timestamped notes until it is closed.
3. **Triage.** Within 1 hour of noticing (during waking hours), decide the severity and whether customer data is
   involved. When unsure, treat it as the higher level.
4. **Contain.** Use the steps that fit. These all exist today:
   - Pause one AI or all AIs (`POST /api/ai/:grantId/pause`, `/api/ai/pause-all`) or revoke a grant
     (`apps/server/src/routes/ai.ts`).
   - Disconnect a provider connection. This revokes access at the provider when the connector supports it, such as
     Plaid `/item/remove`, and wipes the stored secret (`SyncEngine.disconnect` in `packages/sync/src/engine.ts`).
   - Rotate the master key: set the new key, move the old one to `AGFN_OLD_MASTER_KEYS`, and reseal stored secrets
     (`reseal` in `packages/security/src/envelope.ts`).
   - Rotate `AUTH_SECRET` to end all sessions, and rotate any provider API secret (Plaid and others) in that
     provider's dashboard.
   - Revoke the founder's sessions and tokens on any account that may be compromised, and change its credentials.
   - Take the service offline at the host if data is actively leaking.
5. **Preserve evidence.** Before wiping anything, save the relevant logs, the activity log rows and the cloud
   provider's audit log, if any.
6. **Notify.** Target timelines for High, and Medium once confirmed:
   - **Plaid:** email security@plaid.com promptly, as the Plaid Developer Policy requires, for any incident that
     involves Plaid data or Plaid credentials. Target: within 24 hours of confirming it.
     Within 24 hours, or sooner if the Plaid agreement requires.
   - **Other providers** whose data or credentials are involved: as their terms require.
   - **Affected customers:** by email, in plain words: what happened, what data, what we did, what they should do.
     Target: within 72 hours of confirming it.
   - **Regulators and others** (for example under the FTC Safeguards Rule or state breach laws): as the law requires.
     To be confirmed with a lawyer before hosted launch.
7. **Recover.** Fix the cause, deploy through the normal change process (`change-management.md`) unless that would
   prolong the harm, and confirm the fix.
8. **Learn.** Within 2 weeks of closing a High or Medium incident, write a short note in the incident log: cause,
   impact, timeline, what changes. Add a test when the cause was a code bug.
9. **Reporters.** Acknowledge vulnerability reports within 2 business days, as `SECURITY.md` promises.

## How it is checked

- Target, before hosted launch: one tabletop exercise. The founder walks through "the master key leaked" and
  "Plaid notifies us of suspicious access", times each step, and fixes what was missing.
- After that, one tabletop a year, recorded in the incident log.
- Every incident and near miss is in the incident log. An empty log at review time is fine; a known incident
  missing from it is not.

## Gaps today

- No paging or alerting; signals go to the server log.
- No incident log yet.
- No backup contact named.
