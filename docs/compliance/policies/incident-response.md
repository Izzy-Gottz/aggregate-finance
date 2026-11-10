# Incident response policy

Status: Approved by the founder 2026-11-01; reviewed every 6 months; next review due 2027-05-04.

Owner: the founder. Review date: 2027-05-04.

## Purpose

Say what the founder does when something goes wrong with security, so the response is fast and the right people
are told on time.

## Scope

Any event that could expose, change or destroy customer data, or that gives someone access they should not have.
Examples: a leaked secret, a stolen laptop, unauthorized access to a cloud account, a bug that shows one
workspace's data to another, a suspicious AI write, a vulnerability report through `SECURITY.md`, or a security
notice from a vendor such as Plaid or the host.

## Roles

Amazon and other partners ask for defined incident-response roles. Today the founder holds all of them; this is stated
honestly, and the roles will be split as the team grows. Agent sessions (the AI operators) assist under the founder's
direction — they investigate, draft, and prepare changes — but they do not decide severity, notify anyone, or take
production action on their own.

- **Incident lead:** the founder. Declares the incident, sets severity, and owns the response end to end.
- **Technical responder:** the founder, assisted by agent sessions under his direction. Investigates, contains and
  fixes (the Contain, Preserve and Recover steps).
- **Communications:** the founder. Every outside notice — to customers, and to partners and regulators (Amazon, Plaid,
  the host, others) — is sent or approved by him.
- **Recorder:** the founder. Keeps the incident log: timestamped notes from detection to close.

**Who decides on customer notice:** the founder, and only the founder, decides whether and when customers are told, on
a lawyer's advice once one is engaged. An agent session may draft the notice; it never sends it.

**If the founder is unreachable:** there is no second responder yet (see Gaps), and the founder accepts that risk. Until
a backup is named, the standing rule is — whoever notices (an agent session or anyone else) opens an incident-log entry
with everything known and keeps trying every channel to reach the founder (phone, email, messaging). No customer,
partner or regulator notice goes out, and no irreversible production action is taken, without him. Containment that only
reduces harm and is reversible — pausing an AI grant, disconnecting a provider — may proceed, and is logged. Naming a
backup contact is the top gap to close.

## Severity

| Level | Meaning | Example |
|---|---|---|
| High | Customer data exposed or changed, or a production secret is known to be leaked | Master key or Plaid secret leaked; cross-workspace data leak |
| Medium | Possible exposure, not yet confirmed; or a working vulnerability with no sign of use | Suspicious login on an admin console; credible vulnerability report |
| Low | No customer data at risk | A failed phishing attempt; a dev-only secret committed and caught |

## Policy

1. **Detect.** Signals today:
   - Vulnerability reports to security@aggregate.finance (`SECURITY.md`).
     Forwarded by Cloudflare Email Routing to the founder's inbox.
   - Health checks on `/healthz` (`Dockerfile`, `fly.toml`, `railway.json`).
   - The hash-chained activity log. `verifyChain()` finds edited or deleted rows (`packages/mcp/src/activity.ts`).
   - Operator alerts to Telegram (`apps/server/src/alerts.ts`), with secrets and amounts scrubbed.
   - Better Stack checks `/healthz` every few minutes.
   - Security emails from vendors and GitHub.

   Planned: uptime monitoring and error tracking that alert the founder's phone, and alerts
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
   - Rotate the master key, in this order. Rehearsed on staging 2026-11-04 (incident log): 500 secrets moved in about
     6 seconds, 0 failed.
     1. **Save the current key first,** to a mode-600 file somewhere safe (never printed, never in the repo). Older
        backups and database snapshots need it to restore, and Fly can't give back a secret once it's unset. Keep it
        until every older backup and snapshot has aged out.
     2. Take a database snapshot.
     3. Load the new key as `AGFN_MASTER_KEY` and the current one as `AGFN_OLD_MASTER_KEYS`, in one restart.
     4. `AGFN_OPERATOR=<you> agfn keys reseal --reason "<why>"` (dry run), then the same with
        `--apply --confirm RESEAL`, then the dry run again: every row on the new key.
     5. `AGFN_OPERATOR=<you> sh scripts/unset-old-master-key.sh <app> <saved key file>`. It refuses unless the file is
        mode 600 and holds every loaded old key (checked by key id), and no row is left on an old key. Then sync one
        connection.
   - Rotate `AUTH_SECRET` to end all sessions, and rotate any provider API secret (Plaid and others) in that
     provider's dashboard.
     Before rotating it, plan a re-key: `AUTH_SECRET` also signs invite opt-out and stop links and keys the
     opt-out hashes, so rotating it voids them and breaks the "no more invites" promise unless they are re-keyed first.
   - Revoke the founder's sessions and tokens on any account that may be compromised, and change its credentials.
   - Take the service offline at the host if data is actively leaking.
5. **Preserve evidence.** Before wiping anything, save the relevant logs, the activity log rows and the cloud
   provider's audit log, if any.
6. **Notify.** Target timelines for High, and Medium once confirmed. When a partner's data is involved, that partner's
   notice window governs if it is shorter than ours (Amazon: 24 hours).
   - **Plaid:** email security@plaid.com promptly, as the Plaid Developer Policy requires, for any incident that
     involves Plaid data or Plaid credentials. Target: within 24 hours of confirming it.
     Within 24 hours, or sooner if the Plaid agreement requires.
   - **Amazon:** for any incident involving Amazon Information (data from the Selling Partner API), email
     security@amazon.com within 24 hours of detecting it, as Amazon's Data Protection Policy requires.
   - **Providers whose terms require incident notice:** within the deadline in that provider's terms, 30 days at
     the latest.
   - **Other providers** whose data or credentials are involved: as their terms require.
   - **Affected customers:** by email, in plain words: what happened, what data, what we did, what they should do.
     Promptly, and as the law requires. That is the public wording on /security and /privacy (approved 2026-11-01). Internal aim: 72 hours from confirming it.
   - **Regulators and others** (for example under the FTC Safeguards Rule or state breach laws): as the law requires.
     To be confirmed with a lawyer soon. If the Safeguards Rule applies, an event affecting 500 or more consumers goes to the FTC within 30 days of discovery (16 CFR 314.4(j)); we plan as if it does.
7. **Recover.** Fix the cause, deploy through the normal change process (`change-management.md`) unless that would
   prolong the harm, and confirm the fix.
8. **Learn.** Within 2 weeks of closing a High or Medium incident, write a short note in the incident log: cause,
   impact, timeline, what changes. Add a test when the cause was a code bug.
9. **Reporters.** Acknowledge vulnerability reports within 2 business days, as `SECURITY.md` promises.

## How it is checked

- A paper tabletop of both "the master key leaked" and "Plaid notifies us of suspicious access" was run 2026-11-03 and
  recorded in the incident log, pending the founder's sign-off. The master-key reseal it surfaced as never done was
  rehearsed live on staging 2026-11-04 (incident log).
- One tabletop a year after that, recorded in the incident log.
- This policy is reviewed every 6 months, at the dates on the Status line.
- Every incident and near miss is in the incident log. An empty log at review time is fine; a known incident
  missing from it is not.

## Gaps today

- The incident log was started 2026-11-02.
- No backup contact named.
- Paper tabletop done 2026-11-03 and master-key reseal rehearsed on staging 2026-11-04 (incident log). Not yet run on live.
- Legal notification duties haven't been reviewed by a lawyer.
- The security inbox isn't on a dedicated company mail system yet.
- Live logs aren't shipped anywhere and auth routes aren't logged, so a sign-in investigation can have no record (seen 2026-11-01).
