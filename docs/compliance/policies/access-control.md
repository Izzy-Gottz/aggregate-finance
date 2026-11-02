# Access control policy

Status: Approved by the founder 2026-11-01; next review due 2027-11-01.

Owner: the founder. Review date: 2027-11-01.

## Purpose

Make sure only the right people, and the right AI clients, can reach customer financial data. Make sure every
person or system gets only the access it needs.

## Scope

- **Infrastructure access:** the hosting provider, the production database, the master key store, GitHub, the
  Plaid Dashboard and other provider dashboards, the domain registrar and DNS, the email provider, Apple and Google
  developer consoles.
- **Application access:** people inside a customer workspace, and the AI clients and agent keys they connect.

## Policy: infrastructure

1. Only the founder has access to production systems and admin consoles today.
   Confirmed 2026-11-01 for Neon (one member). The other accounts are confirmed at the first quarterly review.
2. Use least privilege. Day-to-day work uses the lowest role that gets the job done. Organization-owner roles are
   used only for account administration.
3. MFA is required on every admin console in scope. Prefer passkeys or hardware security keys. Use TOTP only where
   a console offers nothing stronger. SMS is not accepted where a stronger option exists.
   MFA is turned on for every account in Scope, preferring passkeys; the method per account is recorded in the access-review log.
4. Production secrets (`AUTH_SECRET`, `AGFN_MASTER_KEY`, provider API secrets) live only in the hosting provider's
   secret store and the password manager. They are never in code, chat, email, tickets or logs. The repo enforces
   part of this: `.gitignore` excludes `.env*` and `data/`, and CI runs gitleaks (`.github/workflows/ci.yml`).
5. The master key is kept outside the data directory. The app refuses a key file stored inside it
   (`loadKeyRing` in `packages/security/src/envelope.ts`).
   Planned: hold the hosted master key in a KMS or managed secret store, not a plain
   environment variable. Decision: Fly.io secrets hold the hosted master key (injected at boot, never in the image or repo); `AGFN_MASTER_KEY_COMMAND` allows a cloud KMS later.
6. Commands run from the server on customer data need a name and a reason, and are recorded in the workspace's activity log or `operator_access` (`packages/cli/src/operator.ts`). The founder does not browse customer data for curiosity. He looks at a customer's data only to fix a problem
   the customer reported, to respond to an incident, or when the law requires it. Each such access is noted in the
   access-review log with the date and reason.
7. Adding anyone to any account in scope needs a written note first: who, which account, which role, why, and
   until when. Access is removed the same day it is no longer needed.
8. Database: Neon (managed Postgres). Connections require TLS and a strong, generated password. The production branch is protected.
9. Shared logins are not allowed. Each person, and each automated system, has its own credential.

## Policy: application (built in code)

10. One permission check, `can()`, guards the web app, the REST API and MCP. Roles are owner, admin, finance,
    accountant, investor and employee, plus a per-person grid. A Personal space is visible only to its owner.
    Code: `packages/auth/src/permissions.ts`. Tests try to cross companies: `packages/auth/src/permissions.test.ts`.
11. Only owners and admins can add or remove connections or manage people (`canManageWorkspace`, used in
    `apps/server/src/app.ts` and `apps/server/src/routes/settings.ts`).
12. Connecting a bank requires a sign-in or passkey check within the last 10 minutes (`recentlyVerified` in
    `apps/server/src/app.ts`). Sensitive settings actions require a passkey within that window (`requireRecheck`
    in `apps/server/src/routes/settings.ts`).
    Planned: make the bank-connect, grant and agent-key re-checks passkey-only, and require
    every hosted account to add a passkey after first sign-in.
13. Users sign in with a passkey, Apple, Google or a one-time email link that expires in 10 minutes. There are no
    passwords. Auth endpoints are rate limited. Code: `packages/auth/src/auth.ts`.
14. An AI client gets a grant scoped to companies, data types, read or add, and an expiry. It can never exceed the
    person who connected it. Grants can be paused, revoked, or all paused at once. Revoking deletes the grant's
    OAuth refresh tokens and consent. Code: `packages/mcp/src/grants.ts`, `packages/mcp/src/control.ts`,
    `apps/server/src/routes/ai.ts`, `onGrantRevoked` in `apps/server/src/modules.ts`.
15. Agent keys are shown once and stored only as SHA-256 hashes (`packages/mcp/src/keys.ts`). OAuth tokens are
    stored hashed (`storeTokens: 'hashed'` in `packages/auth/src/auth.ts`).

## How it is checked

- **Quarterly self-review.** Once a quarter the founder goes through every account in Scope and writes one line per
  account in the access-review log: date, who has access, role, MFA method, anything removed or changed. He also
  lists any customer-data access from rule 6. First review: 2026-12-31.
- Application rules 10-15 are covered by automated tests that run before every merge (see
  `change-management.md`).
- Any exception to this policy goes in the exceptions log with a reason and an end date.

## Gaps today

- No access-review log exists yet. The first quarterly review creates it.
- MFA isn't yet recorded per account.
- The master key is a Fly secret. A cloud KMS is planned and approved; the code exists, nothing uses it yet.
- Direct production access by the founder isn't fully recorded yet.
- An inspection role was found to have broader rights than intended. It was removed, and a narrowly scoped replacement is defined for when one is needed.
- The founder uses AI coding sessions with production access, under his accounts. Rules are drafted in `acceptable-use.md` (20 to 26), not adopted yet.
