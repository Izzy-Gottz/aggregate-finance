# @agfn/connector-freshbooks

Read-only FreshBooks connector (OAuth 2.0). Built from FreshBooks' API documentation alone: it has never run on a real
account, and `fixtures/redacted/books.json` is hand-built from the shapes in those docs, not recorded. FreshBooks has no
sandbox we know of (a test account is a real trial account).

Brings in invoices, payments, bills, bill payments, expenses, adjustment journals and the monthly accrual P&L ("Books",
with FreshBooks' totals, which feed the `provider_report` check).

How it's counted:
- Posting books, like QuickBooks and Xero. Invoices keep the gross total and the customer's real name, and payments are
  `payment.applied` with `direction: 'receivable'` named from their invoice, so a sale also in Stripe is proposed once
  in Review (`core/src/matching.ts`) and counts once when confirmed.
- An expense is a paid bill plus its payment (`expense:<id>`), so a bank row of the same money links to it.
- A payment from client credit isn't cash: left out.
- A journal touching a bank-like account, or an account the chart didn't show, is skipped: money at the bank comes only
  from bank feeds. FreshBooks' P&L still counts it, so that month's check can differ by it.
- Disconnect revokes the token at FreshBooks and deletes everything the connection brought (`ERASE_ON_DISCONNECT`).

Left out on purpose:
- **Credit notes**: the docs show creating them, not reading them.
- **Other income**: often store sales (Shopify, Etsy) that a processor connection already counts, and the docs don't say
  whether `amount` includes tax.
Both are named in the P&L check's `notCovered` text.

To confirm on the first real account:
- `amount` on expenses: treated as the full cost, tax included. The docs don't say.
- `amount` on invoices: gross after discount and tax. Worked out from the docs' samples, not stated.
- `business_uuid` in `/users/me`: in the docs' prose, not their sample. Without it the P&L and journals are skipped.
- The token response (no sample in the docs): `expires_in` is read, else the JWT's `exp`.
- The token body: the docs show JSON and name no content type.
- `vendor.vendor_name` under `include[]=vendor`, and `category` under `include[]=category` on expenses: not in the docs'
  samples.
- `search[updated_min]` and `search[vis_state]` on the accounting lists used here, and `search[ids][]` on bills.
- Which scope the chart of accounts needs: its page names none. `user:reports:read` is assumed.
- Whether `user:bill_vendors:read` is needed for the vendor include, and its exact spelling (pattern, not on an endpoint page).
- Whether `total_income` is before or after cost of goods: the docs' sample labels it "Gross Profit" and has no cost of
  goods section. Only net is checked strictly.
- Whether an expense reconciled to a bill (`matched_with_expense` on bill payments) also lists as an expense. If so,
  that money would count twice.
  First real account: one bank-imported expense matched to a bill, and confirm spending counts once. If it counts twice,
  skip those expenses using the field that links them to the bill.
- Also on the first real account: whether an expense's `amount` includes tax, what a negative payment (a refund) or
  negative expense does (today `applications` is empty and there's no `unapplied`), and how `money()` handles a journal
  amount with a real third decimal.
- Kept off the Self-host list in `docs/connectors.md` until one real account passes: unverified sources that post to the
  ledger stay unlisted.
- Where a person removes the app in FreshBooks, for the `notRevoked` text.

Tests: `npx vitest run --maxWorkers=1 packages/connectors/freshbooks apps/server/src/scenarios/19-freshbooks-pnl.test.ts`

## Connection cap

FreshBooks' terms let it limit an app's access at 500 connections. Hosted stops new connections at 450 (`AGFN_FRESHBOOKS_MAX_CONNECTIONS`) and logs a warning from 400. Talk to FreshBooks before then. Self-hosted has no cap unless it's set.
