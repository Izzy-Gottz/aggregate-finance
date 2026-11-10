---
description: How Aggregate checks its numbers: what gets reconciled, which checks run, when a figure says unknown, how it's tested, and what can still be wrong.
updated: 2026-11-02
---

# How we check our numbers

**Short answer:** Aggregate works out each figure from one double-entry ledger, using one written definition, and then
checks it against what your banks, processors and books report. When a check fails, the figure says so. When Aggregate
can't know a figure, it says *unknown* and why. It isn't perfect: this page also lists what can still be wrong.

Every number's definition is on [Definitions](definitions.md). Everything Aggregate doesn't do yet is on
[Known limits](limits.md).

<!-- Keep this page true: every claim here needs a test or a check behind it. Change it in the same commit as the code. -->

## Where a number comes from

1. Your connections send their records: bank rows, charges, invoices, payroll.
2. Aggregate posts them to a double-entry ledger. Money is stored as whole cents, and pending transactions aren't posted.
3. A figure such as burn is computed from that ledger, the same way every time. Your AI asks for it and doesn't do the
   arithmetic itself.

Each answer carries its formula, the accounts it counted and left out, and the rows behind it, so you or your AI can
check it.

## What gets checked

These checks run against your own data:

| Check | What it compares |
|---|---|
| Balances | The change in each bank, card and processor account's reported balance against the transactions between those two days, to the cent |
| Ledger | Every journal entry's debits against its credits |
| Processors | Gross, fees, refunds, payouts and the change in balance, for each processor |
| Invoices and bills | Open invoices and bills against accounts receivable and payable |
| Between companies | What one company says it's owed against what the other says it owes |
| Your books | Aggregate's profit and loss against the report from QuickBooks or Xero, where connected |
| Money in transit | Transfers, payouts and wires not seen at the other end within seven days |
| Coverage | Missing months, and sources that haven't synced in over a day |

The app says **All reconciled** only when nothing is outstanding. An account with one balance or none has nothing to
compare yet, so it reads "not tied out yet". The full rules are under
["All reconciled"](definitions.md#all-reconciled).

These checks catch a lot, but not everything. A balance check can't see an error that two sources agree on, and an
account's history before its first balance can't be tied out.

## When a figure says unknown

Aggregate would rather give no number than a wrong one. A figure is unknown, or comes with a warning, when:

- an account has told Aggregate nothing yet
- a month is missing from the last three complete months
- a source has stopped syncing, and the figure names it
- there isn't enough history for runway

A partial first month is left out of burn and runway instead of being counted as a whole month.

## Questions for you, not guesses

When two records may be the same money, Aggregate asks in Review instead of deciding on a weak match. For example:
"Globex paid invoice 1038 ($100.00). Same money as the $100.00 charge in Stripe, $96.30 after fees?" Until you answer,
the figure can count that money twice, and the answer says how much is waiting.

## How we test it

- **Accuracy scenarios.** Five synthetic workspaces are loaded through the real server. Every answer is compared to the
  cent with a separate answer key, worked out from the raw data without using Aggregate's code. They run before each
  change is merged: more than 200 questions across 5 scenarios
  ([current list](https://github.com/Izzy-Gottz/aggregate-finance/blob/main/docs/accuracy/README.md)), all passing. They
  cover a solo founder, an individual, an operator with three companies, a fund, and one payment seen by two sources.
- **Written tests** for the cases that go wrong in practice, such as a transfer that looks like revenue.
- **A benchmark.** On 2026-10-12, the same 100 questions about one synthetic company were answered by an AI model with
  raw exports and Python (98 of 100) and through Aggregate (100 of 100). The method and results are in the
  [benchmark files](https://github.com/Izzy-Gottz/aggregate-finance/tree/main/docs/benchmark). That run predates later
  changes.

This testing uses synthetic data. A test passing doesn't prove your own numbers are right, because real accounts can
behave in ways our scenarios don't. Nobody outside Aggregate has audited these numbers.

## What can still be wrong

- **Sales tax inside processor charges.** Revenue can include sales tax on Stripe charges without an invoice, Shopify
  sales, Square payments and Gumroad sales, because those rows don't always split it out. The answer says so.
- **Refunds paid from a bank.** A customer refund that leaves your bank instead of your processor counts as an expense,
  so revenue stays high until you categorize it.
- **CSV files.** Only layouts Aggregate can read will import, and we haven't tested every provider's export. Dates in a
  format it doesn't know can't be imported. An earnings file with no payout row (from a marketplace or gig platform, for
  example) can overstate cash if your bank is connected too.
- **Unanswered matches.** A possible transfer or duplicate you haven't confirmed can still count in burn or revenue. The
  figure says how much.
- **Entries added by hand on a synced account.** Cash doesn't change until the next sync, and the entry counts twice if
  the real row arrives too. The reply warns you.
- **Loan payments.** Aggregate doesn't split a payment into principal and interest, so burn can read low by the
  interest or high by the principal, depending on what your lender sends. See [Known limits](limits.md#loan-payments).
- **Provider dates.** A Plaid row uses its posted date, which can move a purchase across a month end by a few days.

Found a number that looks wrong? Tell us at support@aggregate.finance.
