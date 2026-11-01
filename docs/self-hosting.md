# Self-hosting Aggregate

Everything in the hosted version is in this repository. Running it yourself is free; you bring your own provider keys.

## Requirements
- Node 22.18+ (or Docker). 1 CPU and 512 MB RAM is plenty for one person with a few companies. On Alpine, install
  git first (`apk add git`); the official `node:22` (Debian) image has everything.
- A database: SQLite (default, one file under `DATA_DIR`) or Postgres (`DATABASE_URL=postgres://…`).
- For claude.ai and ChatGPT to reach you: a public HTTPS URL (Fly.io, Railway, a VPS with Caddy, or a tunnel).

## Secrets
`npm run -s keygen > .env` writes two values to `.env` (never commit it). Keep the `-s`: without it npm adds its own
lines to the file and Docker refuses to read it. Without Node (Docker only), this makes the same two values:
```sh
(umask 077; printf 'AUTH_SECRET=%s\nAGFN_MASTER_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -base64 32)" > .env)
```
The server won't start without them, and it never makes a master key for you.
- `AUTH_SECRET` signs sessions.
- `AGFN_MASTER_KEY` encrypts every bank token and API key Aggregate stores, and every backup. **Keep it outside
  `DATA_DIR` and out of backups of your data, and keep a copy off this machine** (a password manager). If you lose
  it, stored connections can't be decrypted and must be reconnected, and backups can't be restored. To rotate,
  set a new `AGFN_MASTER_KEY` and put the old one in `AGFN_OLD_MASTER_KEYS` until connections re-sync.

### Keeping the master key in a KMS or password manager
Set exactly one of these. The server refuses to start if it finds more than one:

| Variable | Where the key lives |
|---|---|
| `AGFN_MASTER_KEY` | in the variable itself (your host's secret store) |
| `AGFN_MASTER_KEY_FILE` | in a file outside `DATA_DIR` (Docker/Kubernetes secrets) |
| `AGFN_MASTER_KEY_COMMAND` | printed by a command run once at boot |

The command runs without a shell, so pipes, `$VARS` and `~` don't work. Quote arguments that contain spaces. It must
print the base64 key (whitespace around it is fine) within 10 seconds. Its output is never logged. Point it at a small
script if you need a pipe.

First encrypt the key once, from a machine that has it (`npm run keygen` makes one).

**AWS KMS.** Encrypt with `aws kms encrypt --key-id alias/agfn --plaintext fileb://<(printf %s "$KEY" | base64 -d) --query CiphertextBlob --output text | base64 -d > /etc/agfn/master.enc`.
The `aws kms decrypt --output text --query Plaintext` command prints the key in base64, which is exactly what's needed:
```sh
AGFN_MASTER_KEY_COMMAND='aws kms decrypt --ciphertext-blob fileb:///etc/agfn/master.enc --query Plaintext --output text'
```
Give the server's instance role `kms:Decrypt` on that key only.

**Google Cloud KMS.** Encrypt with `printf %s "$KEY" | gcloud kms encrypt --location global --keyring agfn --key master --plaintext-file - --ciphertext-file /etc/agfn/master.enc`
(this stores the base64 text itself):
```sh
AGFN_MASTER_KEY_COMMAND='gcloud kms decrypt --location global --keyring agfn --key master --ciphertext-file /etc/agfn/master.enc --plaintext-file -'
```
Grant the server's service account `roles/cloudkms.cryptoKeyDecrypter` on that key.

**1Password.** Store the base64 key in an item, give the server a service account token (`OP_SERVICE_ACCOUNT_TOKEN`)
with read access to that vault only, and set:
```sh
AGFN_MASTER_KEY_COMMAND='op read "op://Production/Aggregate/master key"'
```

Anything else (HashiCorp Vault, `pass`, a sealed TPM blob) works the same way, as long as it prints the key and exits 0.

## Database-level isolation (Postgres)
If you run Postgres and host more than one workspace (a firm serving several clients, say), set `AGFN_PG_RLS=1` and restart.
Every table with a `workspace_id` column then gets a Postgres row-level security policy. The database itself returns
only the current workspace's rows and refuses writes into any other. Anything that runs with no workspace sees
nothing. New tables are covered automatically at the next boot.

What it protects against: an application bug, such as a query that forgets its workspace filter or uses another
workspace's id, can't leak or change another workspace's data. The app's own permission checks still apply on top.
What it doesn't protect against yet: SQL injection, or anyone who can run SQL as the app's database user. Phase 1 uses
one database login, and that login can switch the protection off for the few jobs that legitimately span workspaces.
Separate logins (phase 2) come later. Details: `docs/security/rls.md`.

To roll back, set `AGFN_PG_RLS=off` and restart: boot turns the policies off again. (Just unsetting it makes the server refuse to start while the policies are on, so one machine with missing config can't turn isolation off for every server on the database.) No data changes either way. If
your connection user is a superuser, which ignores row-level security, create a normal role, grant it access and set
`AGFN_PG_RLS_ROLE` to it. SQLite has nothing to set: one SQLite database usually holds one workspace.

## Email
Set `SMTP_URL` (e.g. `smtps://user:pass@smtp.example.com:465`) and `MAIL_FROM` so sign-in links are emailed. Without it,
links print to the server console (fine on your own laptop).

**Resend:** `SMTP_URL=smtps://resend:<RESEND_API_KEY>@smtp.resend.com:465` (implicit TLS; the user name is literally
`resend`) and `MAIL_FROM="Aggregate <no-reply@yourdomain.com>"`, on a domain verified in Resend. A sending-only API key
is enough for this. Email-in through Resend is in `docs/email-in.md`.

## Connectors
Connections that sign in with an app of your own (Plaid, QuickBooks, Xero, Finch, Justworks) show in **Connections**
as "Needs your own app" until their keys are set, with the steps, the exact redirect URI for your server and the
variable names. The same guide is at `https://<your-server>/docs/connector-setup` and in `agfn doctor`. Bank and card data comes from Plaid with your own developer
keys (`PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`). Plaid's free Trial plan covers a handful of real accounts; the
sandbox uses test banks. Stripe, Square, Mercury, Brex, Wise and others need nothing in `.env`: each person pastes a
read-only key when connecting, and the drawer says where to make it. QuickBooks and Xero need you to register a (free)
developer app and set its client id and secret. See `.env.example` for the full list.

**Trying it with test data first:**
- **Plaid:** your sandbox keys with `PLAID_ENV=sandbox`. In Link, pick any bank and sign in with `user_good` /
  `pass_good`.
- **Stripe:** paste a test-mode key (`rk_test_…`, or `sk_test_…`) from Stripe's test mode. You'll see your test
  balance and charges.
- **Square:** paste the sandbox access token from your app's Credentials page in the Square Developer Console (the
  Sandbox tab). It's recognized as a sandbox token on its own. Square's sandbox has no payouts, so only sales and
  refunds appear.

Port 8787 already taken? Set `PORT` and `BASE_URL` together in `.env` (for example `PORT=8899` and
`BASE_URL=http://localhost:8899`).

Rippling and Justworks are available here but are **fixture-tested, not yet live-verified**: they are built against
each provider's documented API and recorded responses, not yet checked against a real account. BILL and Deel were
checked live on 2026-10-11. Hosted offers both.

## Run
```sh
npm install && npm run build -w @agfn/web && npm start
```
Node 22 prints `ExperimentalWarning: SQLite is an experimental feature` at start. It's harmless: Node's built-in
SQLite is what Aggregate uses.

Docker: `docker compose up -d`. Compose publishes port 8787 on `127.0.0.1` only; put a reverse proxy with HTTPS in
front for remote access. The image is Alpine and Node only (about 325 MB, with no npm inside). Run the CLI in it with
`docker compose exec agfn node packages/cli/src/main.ts doctor`. In a checkout, the CLI is `npm run -s agfn -- doctor`
(written `agfn doctor` in these docs). It has no KMS or password-manager tools, so with Docker use
`AGFN_MASTER_KEY_FILE` (a Docker secret) or build your own image on top of it that adds the CLI your
`AGFN_MASTER_KEY_COMMAND` needs.
Roles: `AGFN_ROLE=all` (default) runs web and background sync in one process; split `web` and `worker` when scaling.

### Who can reach it
`npm start` listens on every interface (IPv6 and IPv4), so other machines on your network can open the sign-in page.
They can't get in without a sign-in link, and without email set up those only print to your console. To keep the
server to this machine, set `HOST=127.0.0.1`. The SQLite database and document files under `DATA_DIR` are readable
only by the user running the server (`agfn doctor` warns if an older install's directory isn't).

### On your network over plain http
Browsers only allow passkeys on https or `localhost`. If you open the server at `http://192.168.x.x:8787`, set
`BASE_URL` to that address. Sign in with an email link there: the passkey button is hidden. Connecting an account
normally asks for your passkey. Here it asks instead for a sign-in within the last 10 minutes, so if it says "Sign
in again", sign out and use a fresh link. For anything beyond your own network, use https.

### Production on Fly.io + Neon + R2 + Resend
`fly.production.toml` is the hosted setup; its comments list every secret to set. In short:
- **Migrations** run once per deploy in `release_command` (`node apps/server/src/release.ts`): the same boot the server does (Aggregate's migrations, the auth tables, row-level security policies), then it exits. A failing release stops the deploy while the old version keeps serving. Machines repeat those steps at boot as no-ops, so several machines never race on schema changes.
- **One process** serves the web and runs the worker (`AGFN_ROLE=all`), so `min_machines_running = 1` and `auto_stop_machines = "off"`. Recurring jobs are de-duplicated in the database, so a second machine doesn't double-run them.
- **No volume:** data is in Neon, files and backups in R2 (two buckets with separate tokens), email through Resend.
- **Health check:** `/healthz` answers only when the database does.

`fly.toml` stays the simple self-host deploy (SQLite on a Fly volume).

### Staging before production (the hosted service)
Aggregate's own hosted service tests every release on a separate app before it reaches customers:
- **staging.aggregate.finance** is a separate Fly app: its own secrets (a different `AUTH_SECRET` and master key), its
  own database (a Neon branch), and sandbox or test keys for every provider. Its machine stops when idle. Files stay on
  the machine and there are no backups: staging data is disposable and never real.
- **app.aggregate.finance** is the live app (`fly.production.toml`).
- A release reaches live only after the same commit has passed staging and its `/healthz`.
- Each provider needs staging's callback URL registered in its sandbox or development app (for example
  `https://staging.aggregate.finance/connect/plaid/oauth` for Plaid), next to the live one.

If you run your own copy, the same pattern works: a second app, a database branch, and sandbox keys.

## Alerts
Problems (a connection failing for a reason other than "sign in again", a background job failing) are logged to the
console. Set `ALERT_WEBHOOK_URL` to also receive them in Slack, Discord, ntfy or any endpoint that accepts
`{"text": "..."}`, or set `ALERT_TELEGRAM_BOT_TOKEN` and `ALERT_TELEGRAM_CHAT_ID` to get them in a Telegram chat. The same alert is sent at most every 10 minutes, and alerts never include secrets or amounts.

## Backups
SQLite: back up `DATA_DIR` (the database file and `files/`). Litestream works well for continuous backups. Postgres:
your provider's point-in-time restore (Neon keeps at least 7 days) or your usual dumps. The master key is never in a
backup, by design.

### Nightly encrypted off-site backup (built in)
Set these and the worker uploads a backup every 24 hours, keeping 25 days:
```sh
BACKUP_S3_BUCKET=agfn-backups
BACKUP_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # R2, S3, MinIO, Backblaze B2…
BACKUP_S3_ACCESS_KEY_ID=…
BACKUP_S3_SECRET_ACCESS_KEY=…
# BACKUP_S3_REGION=auto   BACKUP_S3_PREFIX=prod/
```
Use a separate bucket (or at least separate keys) from `FILES_S3_*`, so a leaked file-storage key can't delete
backups.

What gets backed up:
- **SQLite:** a consistent copy made with `VACUUM INTO` while the server runs.
- **Postgres:** a logical dump made by the app: every table as rows, plus the schema version. No `pg_dump` binary to keep in step with the server's version, and no extra machine.

Each backup is gzipped, then encrypted with your master key (AES-256-GCM, a fresh data key per backup, purpose
`backup`), so the bucket holds nothing readable. The flip side: **a backup restores only with the same master key.**
Keep a copy of it somewhere other than the server; after a rotation, put old keys in `AGFN_OLD_MASTER_KEYS`.
Document files (receipts, statements) are included, so one backup restores everything. Versioning on the `FILES_S3_*` bucket is still a good second copy.

`agfn backup now` makes one immediately. `agfn backup list` shows what's there.

### Restore drill (do it once before launch, then once a year)
The steps, what a lost master key means, and what the automated drill checks are in
[backup-restore](security/backup-restore.md). In short: `agfn backup list`, then restore into a fresh
`DATA_DIR` with `DATA_DIR=/new/dir agfn backup restore <key>`. It asks you to type `restore`; add `--yes` when no one
is at a terminal. The database and the document files both land in that directory, and a database that already
holds data is never overwritten. (`--to /path/new.db` restores the database to another file; the document files
still go to the `DATA_DIR` the command runs with.) Start a second server on it, with `BACKUP_S3_*` unset so it doesn't
add its own backups to the bucket, and check the books, a receipt and a sync.

## Updating
`git pull && npm install && npm run build -w @agfn/web` and restart. Migrations run automatically on start.
