# Vendor management policy

Status: Approved by the founder 2026-11-01; next review due 2027-11-01.

Owner: the founder. Review date: 2027-11-01.

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
| Plaid | Bank and card connections | Account details, balances, transactions, holdings | In use. Approved for production 2026-10-12. DPA open |
| Fly.io | Runs the app; holds production secrets | All of it, in processing | In use. DPA signed 2026-10-28 |
| Neon (Databricks) | Hosted database (AWS us-east-1) | All of it | In use. DPA in effect through its terms |
| Cloudflare | R2 files and encrypted backups, DNS, email routing, site analytics | Documents, encrypted backups; visitors' traffic | In use. DPA in effect through its terms |
| Resend | Sign-in links, invites, notices | Email addresses, links, summary figures in the weekly email | In use. DPA in effect through its terms |
| Better Stack | Uptime checks of `/healthz` | None | In use |
| Telegram | Operator alerts | None by design: alerts are scrubbed | In use |
| Frankfurter | Exchange rates | None: currency codes and dates only | In use |
| Vercel | Marketing site | Visitor traffic only | In use. No DPA action (decided 2026-11-01) |
| GitHub | Source code, CI | None (fixtures are redacted, secrets are scanned) | In use |
| Google, Apple | Sign in with Google / Apple | Name and email at sign-in | In use |
| Other connectors (Stripe, QuickBooks, Mercury and others) | Data from those providers | Their data for that customer | Listed on /privacy as a group. Each is approved per connector |

Plaid's data processing agreement is being confirmed with Plaid.

## How it is checked

- The founder reviews the whole register every 12 months, at the policy review. For each vendor he confirms it is
  still used, still needed, MFA is still on, and its security report is not out of date.
- No customer data flows to a vendor that is not in the register. The quarterly access review
  (`access-control.md`) cross-checks the accounts list against the register.

## Gaps today

- The full register, with security reports and review dates, isn't filled in.
- Plaid's DPA is unconfirmed.
- Vendor security reports (SOC 2 and similar) haven't been collected.
- Support email isn't on a dedicated company mail system yet.
