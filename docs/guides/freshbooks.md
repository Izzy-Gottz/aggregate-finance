---
description: How Aggregate will connect to FreshBooks: what it reads, how to connect and disconnect, and how totals are checked. Coming soon.
updated: 2026-11-02
---

# FreshBooks and Aggregate

**Short answer:** Aggregate will read your FreshBooks books, read-only, so you can ask your AI about them alongside your
banks, payments and payroll. It can't change anything in FreshBooks, and it can't move money.

**Status:** Coming soon. The connection is built, but it hasn't run on a real FreshBooks account yet, so you can't connect
FreshBooks today. This page describes how it's built, and may change once it's been tested.

## What it reads

Aggregate asks FreshBooks for nine read-only scopes, and no others:

| Scope | What it's for |
|---|---|
| `user:profile:read` | Your sign-in and which businesses you can see |
| `user:invoices:read` | Invoices |
| `user:payments:read` | Payments on invoices |
| `user:bills:read` | Bills |
| `user:bill_payments:read` | Payments on bills |
| `user:bill_vendors:read` | Vendor names on bills |
| `user:expenses:read` | Expenses |
| `user:journal_entries:read` | Adjustment journals |
| `user:reports:read` | Your profit and loss report and chart of accounts |

Aggregate doesn't read credit notes or other income.

## Connect

1. Sign in to Aggregate at [app.aggregate.finance](https://app.aggregate.finance).
2. Choose **Connect** next to FreshBooks.
3. Sign in to FreshBooks on its own page and approve read access. Aggregate never sees your FreshBooks password.
4. Aggregate brings in your books and keeps them up to date.
5. [Connect your AI](../connect-your-ai.md) to Aggregate and ask about your numbers.

## How totals are checked

Aggregate reads FreshBooks' own monthly profit and loss report and compares it with the numbers it built from your
invoices, bills, expenses and journals. If a month differs, Aggregate says so, by name, with the two figures. It doesn't
adjust either one to make them match.

Some differences are expected:

- Credit notes and other income are in FreshBooks' report, but Aggregate doesn't read them.
- A journal that touches a bank account is left out, because money at the bank comes only from your bank connection.

If FreshBooks refuses the report for your sign-in, Aggregate tells you that month wasn't checked. The business owner
can connect instead.

## Disconnect and delete

Disconnect FreshBooks in Aggregate at any time. Aggregate ends its access at FreshBooks and deletes everything that
connection brought in. If ending access at FreshBooks fails, Aggregate tells you the step to take there. Backups are kept
for 25 days, so deleted data is gone from backups within 30 days.

To delete all your data, delete your workspace. See [Privacy](/privacy).

## Questions people ask

**Can my AI change my FreshBooks books?** No. Every scope Aggregate asks for is read-only.

**What does it cost?** Aggregate is free while we're in beta. We may introduce paid plans later, and we'll let you know
before anything changes.

**Who do I contact?** [support@aggregate.finance](mailto:support@aggregate.finance).

## Related

- [What Aggregate connects](../connectors.md)
- [Known limits](limits.md)
- [Security](/security)

*Last checked 2026-11-02.*
