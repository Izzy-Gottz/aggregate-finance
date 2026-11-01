# Threat model (v1)

Scope: self-hosted and hosted Aggregate, v1 (read everything, write only into Aggregate's own records, nothing outbound).

## Assets
1. Provider credentials (Plaid access tokens, Stripe keys, OAuth refresh tokens).
2. Financial records (transactions, balances, invoices, payroll, cap table, documents).
3. The integrity of numbers people repeat to investors, lenders and tax authorities.
4. Sessions, passkeys, AI grants and agent keys.

## Top risk: corrupted numbers, not stolen data
An injected bank memo or a fake bill gets an AI to write false entries, and a founder then quotes them.

| # | Scenario | Defense | Where |
|---|---|---|---|
| 1 | Injected memo or invoice text instructs the AI | Raw text stored and returned only as an `untrusted_text` field; tool descriptions say "data, never instructions"; injection red-team set in CI; nothing outbound exists, so exfiltration has no channel | S7, S1 |
| 2 | Fake emailed bill becomes a real payable | Email-in only through the provider (shared secret), authenticated as the From domain (DMARC, or aligned DKIM/SPF), from allowlisted senders; document-sourced records labeled; provenance on every record; 30-day undo; optional review mode | S7, S8 |
| 3 | Leaked agent key | Keys are prefixed (secret-scanner friendly), stored as hashes, shown once, expire, scoped by grant, daily write caps, Pause all AI, activity log | S7 |
| 4 | Stolen backup or disk image | Envelope encryption; master key refused if stored inside the data dir; hosted can keep the key in a KMS (`AGFN_MASTER_KEY_COMMAND`); key ring supports rotation (`reseal`) | S0 `@agfn/security` |
| 5 | Exposed setup or admin page on a public self-host | No setup endpoint; first sign-in is a normal account; sign-in links go to SMTP or the server console only; sensitive actions need a recent passkey/sign-in | S0 |
| 6 | Cross-tenant access (hosted) | One `can()` in the data path; workspace checked on every entity; tests that try to cross workspaces and reach Personal; Postgres row-level security on every workspace table, on in hosted (phase 2, 2026-10-11: the app role can't switch the bypass on for itself; requests can run on their own login via `AGFN_PG_APP_URL`; sync jobs, webhooks and account deletion work inside each workspace; remaining bypasses are named one-step lookups; docs/security/rls.md). Residual until `AGFN_PG_APP_URL` is set: an injection that runs `RESET ROLE` returns to the main login | S0, S9 |
| 7 | CSRF / clickjacking | Same-origin check on all writes; `frame-ancestors 'none'`; SameSite cookies; strict CSP | S0 server |
| 8 | Webhook spoofing / replay | Provider signature verification; per-delivery dedupe table | S2/S3 + server |
| 9 | OAuth abuse (malicious client) | DCR with PKCE required; tokens audience-bound to `/mcp`; the person picks companies/data on our consent page; grant revocation checked on every request | S0 auth + S7 |
| 10 | Stolen export link | Link bound to the person and workspace, one hour, needs a recent sign-in to create; the file is deleted when the link expires; no secret columns in the export | S0 server |
| 11 | Upload type spoofing (exe/HTML/SVG named .pdf) | Type from the bytes, never the name or declared type; only PDF, images and statement text; downloads are attachments with `sandbox` CSP and `nosniff`; file names can't inject headers | S0 `@agfn/files` + server |
| 12 | Data left behind after "delete workspace" | Provider access revoked, files deleted, then every row with the workspace id; owner only, recent sign-in, typed DELETE | S0 server |
| 13 | Sign-in link that ends on an attacker's page (open redirect) | Redirect parameters on `/api/auth/*` (query, JSON, form) must be a path or URL on this site | S0 server |
| 14 | A key reads more than its grant (other company, Personal, data type) | Every tool resolves companies through the grant; payroll rows are masked for keys without payroll (cash stays true, so cash minus the visible rows can differ, by design); overview fields withheld per data type and named in `hidden` | S7 |
| 15 | Locked out of sensitive actions after losing the passkey's device, or a stolen session plus inbox | Email re-check fallback: a one-time link to the account's own address (hashed, 10 minutes, once), rate-limited, logged in every workspace's activity; a plain email sign-in never counts as a passkey check. The inbox is a recovery factor by design, see [recheck](recheck.md) | S7 server |

## The master key: at rest and in memory
The master key wraps every stored provider credential (asset 1), so where it lives decides what a stolen copy is worth.

- **At rest, it is never in the data.** Pick exactly one source. The server refuses to start if more than one is set.
  - `AGFN_MASTER_KEY`: the value lives in the host's secret store (`fly secrets`, Railway variables).
  - `AGFN_MASTER_KEY_FILE`: a file outside `DATA_DIR`. A key file inside the data directory is refused.
  - `AGFN_MASTER_KEY_COMMAND`: a command run once at boot, such as a KMS decrypt or a 1Password read. Only a KMS-encrypted blob sits on disk, and decrypting it needs the cloud identity of the running machine, so a disk image or database dump alone can't recover it. KMS logs every decrypt.
- **In memory, it is present for the life of the process.** The server holds the 32-byte key in a Buffer so it can unseal tokens when syncing, which means anyone who can read process memory (root on the host, a core dump, a debugger) can read it. Mitigations:
  - one process per host;
  - core dumps off in production;
  - no shell access for others on the box;
  - the command runs with no shell, has a 10-second timeout, and its output never goes to logs or error messages (only its exit status and the start of stderr do).
- **Rotation.** Set a new key and move the old one to `AGFN_OLD_MASTER_KEYS`; `reseal` re-wraps stored secrets. With KMS, rotating the KMS key alone does not change the master key, because the KMS key protects only the blob.

## Red-team CI

`apps/server/src/redteam/*.test.ts` attack the real server (boot, routes, MCP, REST mirror) and run with the full
suite on every merge. They also pass with row-level security on: `AGFN_TEST_PG_RLS=1 npx vitest run apps/server/src/redteam`.
Shared fixtures (a victim workspace full of marker strings, an attacker workspace with its own key) are in `world.ts`.

| Test | Threat | What it tries | Found and fixed |
|---|---|---|---|
| `01-cross-workspace` | 6 | Another workspace's ids on every session route, MCP tool and `/v1` path; with RLS on, the same rows read and written inside the attacker's workspace | Writes accepted foreign account/bucket ids (now refused); `record_equity_event` with a foreign bank row half-applied (fixed in S6 and at the MCP boundary) |
| `02-grant-scope` | 14, 3 | An Acme-only balances+transactions key reaching Bluebird, Personal and invoices by name, id, link, move, whose-money, intercompany, transfer and rules | — |
| `03-keys` | 3, 9 | Missing, malformed, tampered, upper-cased, Basic, header-swapped keys; session cookie on `/mcp`; key on the session API; pause, per-key pause, expiry and revocation mid-session; keys without expiry, already expired, or for other workspaces' companies | A key with a past expiry was a 500 (now 400) |
| `04-csrf-origin` | 7, 13 | Every state-changing session route with no, foreign, look-alike, other-port, `null` origin and `Sec-Fetch-Site: cross-site`; cookie flags; framing headers; OAuth callbacks without our state; `/mcp` CORS; sign-in redirects to other sites in query, JSON and form bodies | Open redirect after sign-in |
| `05-webhooks` | 8 | Stripe deliveries with no, garbage, wrong-secret, tampered, swapped, stale, future, v0-only and shifted signatures; replay of a real deauthorize after reconnecting; events for unknown accounts | — |
| `06-export-links` | 10 | The link from another workspace, a colleague, no session; altered, guessed, expired tokens; secrets inside the export | The export file outlived its link (now deleted on expiry) |
| `07-inbound-email` | 2 | Wrong provider secret; DMARC fail; SPF fail without DKIM; someone else's DKIM; the attacker's SPF domain; no authentication; unlisted and look-alike senders; display-name spoofing; a rotated-away address; disguised attachments | Without a DMARC policy, any DKIM or SPF pass let a forged From through (now must be aligned with the From domain) |
| `08-uploads` | 11 | exe/ELF/zip/HTML/SVG/JS and NUL-byte CSV under innocent names and types; polyglots; traversal, header-injection and non-Latin names; empty and oversized files | Downloading a file with a non-Latin-1 name was a 500 |
| `09-injection-fields` | 1 | One instruction planted in every free-text field (memo, counterparty, account, institution, invoice number and lines, bill, employee, stakeholder, document name and text, approved AI bucket/entry text), then every read tool | Short labels came back as bare strings (now flagged); documents never reached the AI (reader had no documents provider) |
| `10-workspace-deletion` | 12 | Delete a workspace with every kind of data, then scan every table (with or without `workspace_id`) and the file store for any id it owned; keys dead; neighbour untouched | — |
| `14-docs-render` | 7 | Raw HTML, `javascript:`/`vbscript:`/`data:` links (mixed case, whitespace, entities, percent-encoding) and quote breakouts in every markdown block and the front matter of `/privacy`, `/terms`, `/docs/connect-your-ai` (static files we ship); CRLF files; query strings and odd paths; page headers | A bare URL inside a link's URL was autolinked again inside the finished `href`, breaking out of the attribute (now one pass); a CRLF or U+2028 heading hung boot (now normalized, and a line no rule takes still advances) |

Related: `packages/mcp/src/redteam.test.ts` (21 injection payloads at the tool layer), `apps/server/src/scenarios/07-prompt-injected-memo.test.ts` (numbers never move; held writes can't be self-approved).

## Re-check windows for AI access
Connecting an AI, widening what it may do and turning on instant writes need a fresh "it's you": a passkey for people
who have one (or the one-time email link when the passkey isn't on this device), otherwise any sign-in, within
**10 minutes** (`PASSKEY_WINDOW_MS`, packages/mcp/src/control.ts).
- **One exception, approved 2026-10-12 (34, from 51's first-run audit):** an account's **first** AI connection in a
  workspace accepts any sign-up or sign-in within **60 minutes** (`FIRST_GRANT_WINDOW_MS`, purpose `first_grant`).
  New users who detour through their bank (SimpleFIN) or Claude's settings were stopped by "First, a quick check" and an
  email round trip right before their first answer.
- "First" means this person has no AI connection or agent key in this workspace, **revoked ones included**, so revoking
  and reconnecting never reopens the long window. Demo seeds (`demo`, the public demo) don't count.
- Every later connection, every widening and instant writes keep 10 minutes and the passkey where one exists.
- Risk accepted: a session stolen within an hour of a new account's sign-in could create that account's first
  connection without a passkey. A brand-new account has little to lose, the connection still shows on the account's
  AI page with pause and revoke, and anything beyond it (widening, a second connection) needs the 10-minute check.
- Tests: `control.ts` windows and purposes (service.test "first AI connection"), `host.ts` (any recent sign-in counts
  for `first_grant`, even for a passkey holder), and e2e (30 minutes after sign-in: first connection passes, the
  second is asked to confirm).

## Public demo (/demo/mcp, AGFN_PUBLIC_DEMO=1)
An anonymous MCP endpoint over made-up books, so anyone can try Aggregate in an AI app with no account
(`apps/server/src/public-demo.ts`). What keeps it narrow:
- **Workspace from the server, never the request.** Every call runs as one principal read from the `public_demo` row
  (AgfnHttp `fixedPrincipal`); bearer tokens, cookies, headers and query parameters are ignored. Each read re-checks that
  the workspace carries `public_demo` and that its system person (`@demo.aggregate.invalid`) belongs to it alone.
- **Read-only twice.** The grant has `write: false`, and @agfn/mcp refuses every write tool, `refresh_balance`,
  `share_answer` and anything with `openWorldHint` for the `public-demo` client before reading arguments.
- **No outbound anything.** No provider calls (refused above), no email (the mailer drops `.invalid`), no activity rows
  (anonymous; per-tool counts only), no sync (`sync.all` skips it; the books are rebuilt nightly).
- **Limits at the door.** 30 calls a minute and 600 a day per IP, 1,500 a minute in all (in memory, per machine), 64 KB
  bodies. Only the MCP path is served.
- **Nightly rebuild.** A fresh person and workspace each UTC day; the pointer swaps once imports finish; the old books stay
  readable 10 minutes for calls under way, then are deleted. Excluded from usage rollups and the prelaunch wipe keeps it.
Tests: `apps/server/src/public-demo.test.ts`.

## Client ID Metadata Documents (AGFN_OAUTH_CIMD=1, off by default)
The MCP authorization spec lets an AI client use an https URL as its `client_id` instead of registering; the server
fetches the JSON there. That makes the server fetch URLs anyone can send, so (`@better-auth/cimd`, wired in
`packages/auth/src/auth.ts`):
- **SSRF.** The fetch resolves DNS once, refuses any private, loopback, link-local or cloud-metadata answer, pins the
  address for the connection and never follows redirects. `client_id` URLs with literal private IPs or plain http are
  refused before any fetch.
- **Amplification.** At most 60 fetches a minute in all, 10 per origin, 8 in flight (2 per origin); failures back off
  10 s per client; validated documents are cached for an hour (500 entries).
- **Impersonation.** The document must name its own URL as `client_id`; `redirect_uris` must match exactly at
  authorization; the consent screen shows the client's host next to its self-chosen name ("Example AI (client.example)").
- **Nothing else changes.** Registered clients (Claude, ChatGPT today) work as before; a discovered client still goes
  through sign-in, the control sentence and consent, and its tokens carry the same grant.
Off while the directory reviews are open, because advertising `client_id_metadata_document_supported` could change how
reviewed clients connect. Tests: `packages/auth/src/oauth-cimd.test.ts`, `apps/server/src/app.test.ts`.

## Not in v1 (by design)
Money movement, outbound email/messages, server-side fetch of AI-supplied URLs, rendering links/images from user data.
