# Vendor management policy

Status: DRAFT, pending founder approval.

Owner: the founder. Review date: 2027-04-10.

## Purpose

Know which outside companies touch customer data or can affect the service, and check them before relying on them.

## Scope

Any vendor that stores, processes or can reach customer data, holds a production secret, or could take the service
down. It also covers vendors that hold the company's own critical accounts (code, domain, email).

Not in scope: the AI client a customer chooses to connect (Claude, ChatGPT, a script). The customer picks it, grants
it access under their own control, and has their own agreement with that provider. We do not send data to it unless
the customer's grant allows it. Aggregate has no AI model of its own.

## Policy

1. Keep a vendor register. One row per vendor: name, what it does for us, what data it touches, where that data
   lives, its security report (SOC 2, ISO 27001) or why there is none, the contract or terms we accepted, the
   account owner, MFA on, and the date last reviewed.
2. Before adding a vendor that will touch customer data, the founder:
   - Reads its security page and gets its SOC 2 report or equivalent where one exists.
   - Checks it supports MFA for our account, encryption in transit and at rest, and data deletion when we leave.
   - Reads its data-processing terms, including where data is stored and whether it uses our data for its own
     purposes, such as training models.
   - Adds it to the register before any customer data flows to it.
3. Prefer vendors with an independent security report. If a vendor has none, write down why it is still acceptable.
4. Give each vendor the least data and least access it needs. For example, sign-in email only needs the address and
   the link.
5. When we stop using a vendor, remove our data and credentials from it, and mark the row as closed with a date.
6. If a vendor reports a breach that affects us, follow `incident-response.md`.

## Vendor register (starting list)

This is the starting list from the code and plans. The full register, with account details, lives with the other
private records (see `README.md`).

| Vendor | Purpose | Customer data it touches | Status |
|---|---|---|---|
| Plaid | Bank and card connections (`packages/connectors/plaid`) | Account details, balances, transactions, holdings, liabilities | In use. Approved for production (2026-10-12) |
| Hosting provider | Runs the app container (`Dockerfile`; `fly.toml` and `railway.json` are ready) | All of it, on the server and volume | Fly.io (in use) |
| Managed Postgres | Hosted database | All of it | Neon (in use) |
| Object storage | Uploaded documents when S3-compatible storage is used (`packages/files/src/s3.ts`) | Documents (receipts, invoices) | Cloudflare R2 (in use) |
| Email provider | Sign-in links and invites (`SMTP_URL`) | Email addresses, sign-in links | Resend (in use) |
| KMS / secret manager | Holds the hosted master key | None directly; protects the key that unlocks provider tokens | Fly.io secrets (planned) |
| Monitoring and error tracking | Alerts (see `incident-response.md`) | Possibly request details in error reports | Fly.io health checks + Better Stack uptime alerts (planned); request-body capture off |
| GitHub | Source code, CI (`.github/workflows/ci.yml`) | None (fixtures are redacted, secrets are scanned) | In use |
| Google, Apple | Sign in with Google / Apple (`packages/auth/src/auth.ts`) | Name and email at sign-in | Wired in code |
| Domain registrar and DNS | aggregate.finance | None, but controls where traffic goes | Cloudflare Registrar (MFA required on the Cloudflare account) |
| Other connectors (Stripe, QuickBooks, Mercury and others) | Data from those providers, read-only | Their data for that customer | Add each one before it is enabled on hosted |

## How it is checked

- The founder reviews the whole register every 6 months, at the policy review. For each vendor he confirms it is
  still used, still needed, MFA is still on, and its security report is not out of date.
- No customer data flows to a vendor that is not in the register. The quarterly access review
  (`access-control.md`) cross-checks the accounts list against the register.

## Gaps today

- The register has not been filled in with account details or security reports.
- The host, database, storage, email, KMS and monitoring vendors are not chosen.
