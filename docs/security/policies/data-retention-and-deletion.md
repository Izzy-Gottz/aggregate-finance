# Data retention and deletion policy

Status: DRAFT, pending founder approval.

Owner: the founder. Review date: 2027-04-10.

## Purpose

Say what customer data we keep, for how long, and what happens when a customer disconnects a provider or deletes
their workspace. Keep only what the product needs.

## Scope

All customer data held by the hosted service: the database, uploaded documents, logs and backups. Self-hosters
hold their own data; the code behaviour described here applies to them too, but their retention is their choice.

## What we keep today, and for how long

| Data | Where | Kept today | Code |
|---|---|---|---|
| Provider secrets (bank tokens, API keys) | `connections.secret_enc`, envelope-encrypted | Until disconnect, then wiped | `packages/sync/src/engine.ts`, `packages/security/src/envelope.ts` |
| Raw provider payloads | `raw_records.payload_json`, plain text in the database | Until "delete data" on that connection, or 30 days after disconnect | `packages/sync/src/raw-sink.ts` |
| Ledger: accounts, transactions, journal entries, invoices, payroll, equity | Database | While the workspace exists. Migrations never cascade-delete money data | `packages/db/migrations/` |
| Documents (receipts, invoices, uploads) | Local volume under `DATA_DIR`, or S3-compatible storage | While the workspace exists | `packages/files/src/index.ts`, `packages/files/src/s3.ts` |
| Activity log (append-only, hash-chained) | `activity_log` | While the workspace exists. No purge | `packages/mcp/src/activity.ts` |
| AI write requests (provenance, undo) | `write_requests` | While the workspace exists. Undo window is 30 days | `packages/mcp/src/writes.ts` |
| Agent keys, OAuth tokens | Hashed only | Until revoked or expired. Revoking a grant deletes its refresh tokens and consent | `packages/mcp/src/keys.ts`, `apps/server/src/modules.ts` |
| Workspace exports | File store under `exports/` | Link expires after 1 hour. The file is deleted at the workspace's next export | `apps/server/src/routes/settings.ts` |
| Server logs (stdout) | The host's log view | Whatever the host keeps | Fly.io's log view (short retention). Target before hosted launch: logs shipped to a log service and kept 90 days, with request bodies and secrets never logged. |

Plaid transactions are requested with up to 24 months of history (`days_requested: 730` in
`packages/connectors/plaid/src/connector.ts`). Decision: keep 24 months. It supports year-over-year reports and runway, and the history is deleted with the connection or workspace like everything else.

## Policy

1. We collect only the data a connector needs for the ledger and reports. Connectors are read-only. No connector
   requests a product that moves money.
2. Provider secrets are always envelope-encrypted at rest, with the master key kept outside the data directory.
3. **Disconnect** (owner or admin only, `POST /api/connections/:id/disconnect` in `apps/server/src/app.ts`). True today:
   - Access is revoked at the provider when the connector supports it. For Plaid this calls `/item/remove`
     (`disconnect` in `packages/connectors/plaid/src/connector.ts`).
   - The stored secret is wiped (`secret_enc` set to null) and syncing stops, even if the provider call fails. A
     failure is logged. Code: `SyncEngine.disconnect` in `packages/sync/src/engine.ts`; tests in
     `packages/sync/src/disconnect.test.ts`.
   - Raw payloads and ledger history are **kept**, so the customer's books stay complete.
4. **Disconnect with "delete data".** True today: everything in rule 3, plus raw payloads for that connection are
   deleted and its accounts are closed and left out of cash. Transactions and journal entries from that connection
   are kept today.
   Target, before hosted launch: offer a full erase of that connection's transactions and journal entries too.
5. **Provider-side revocation.** When Plaid tells us the user revoked access (webhook), the connection is marked
   disconnected, syncing stops and the sealed token is wiped, the same way as rule 3
   (`apps/server/src/app.ts`, webhook handler).
6. **Workspace deletion** (`DELETE /api/workspace`, `apps/server/src/delete-workspace.ts`):
   - Only an owner can do it, after a fresh passkey re-check, typing DELETE to confirm.
   - It disconnects every connection first, so provider access is revoked and secrets are wiped (rule 3).
   - It then deletes the workspace's documents from file storage and every row that belongs to it from the
     database. Sign-in accounts stay, so people in other workspaces keep working. It is safe to run again if it
     stops halfway.

   Target: deletion from live systems within 30 days of the request (today it is immediate; backups are covered below). Confirmed: 30 days.
7. **Account deletion** (a person leaving Aggregate entirely: `DELETE /api/me`, `apps/server/src/delete-account.ts`).
   True today:
   - It needs a fresh passkey re-check and DELETE typed to confirm.
   - A person who is the only owner of a workspace is refused: "Make someone else an owner or delete the workspace first."
   - Otherwise, in every workspace:
     - AI access they created is revoked: grants, agent keys, OAuth tokens and consent.
     - Their Personal space's own bank connections are disconnected (rule 3), and Personal documents are deleted from storage.
     - Their memberships are removed.
   - Their sign-in records are deleted: the login, sessions, passkeys, linked Google/Apple accounts and re-check history.
   - The person row stays so history still resolves, but the name becomes "Former member" and the email an unusable placeholder.
   - Personal ledger rows are kept, visible to nobody: entries in a company's books can point at them (an owner paying a company bill), and deleting them would unbalance that company.
     [CONFIRM] Keep this, or erase Personal ledger rows that no company entry references?
8. **Raw payload limit.** True today: raw payloads of a disconnected connection are deleted 30 days after disconnect,
   by the daily `retention.purge` worker job (`apps/server/src/retention.ts`; `connections.disconnected_at` is
   set on every disconnect). Connections disconnected before that column existed start their 30 days at the first run.
9. **Logs.** Target, before hosted launch: server logs are kept 1 year, then deleted. Logs never contain secrets.
   Amounts are redacted in logged AI arguments (`redactArgs` in `packages/mcp/src/activity.ts`).
10. **Export before leaving.** An owner or admin can export the workspace's data at any time, after a passkey
    re-check (`POST /api/export`, `apps/server/src/routes/settings.ts`). Secrets and other people's Personal
    spaces are left out.
11. **Legal holds.** If the law requires us to keep something longer, we keep only that, only as long as required,
    and note it in the exceptions log.

## Backups

- Self-host guidance today: back up `DATA_DIR`, or use the usual Postgres dumps. The master key is never in a
  backup, by design (`docs/self-hosting.md`, `loadKeyRing` in `packages/security/src/envelope.ts`). So a stolen
  backup cannot decrypt provider secrets.
- Hosted: Neon point-in-time restore (history window per Neon plan, at least 7 days), plus the built-in nightly
  encrypted backup to Cloudflare R2, kept 25 days. That backup runs as the `backup.nightly` worker job when `BACKUP_S3_*` is set
  (`apps/server/src/backup.ts`):
  - Postgres gets a logical dump made by the app; SQLite gets `VACUUM INTO`.
  - It is gzipped and envelope-encrypted with the master key (purpose `backup`).
  - Older backups are deleted automatically.

  Restore drill: `docs/self-hosting.md` § Restore drill, using `agfn backup restore`.
- True today: backups are encrypted at rest, and deleted data ages out of the R2 backups within 26 days (Neon's history
  window is shorter). Target, before hosted launch: one restore is tested and recorded before launch, then once a year.

## How it is checked

- At each policy review, the founder compares this table with the database schema
  (`packages/db/migrations/`) and adds any new table that holds customer data.
- Disconnect behaviour is covered by `packages/sync/src/disconnect.test.ts`. Workspace deletion has its own tests
  next to `apps/server/src/delete-workspace.ts`.
- Once purges exist, the founder checks once a quarter that they ran.

## Gaps today

- Transactions stay after "delete data". Raw payloads of a live connection have no time limit.
- No log retention decided. The first restore drill is not yet recorded.
