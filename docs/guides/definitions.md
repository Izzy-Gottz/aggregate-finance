---
description: How Aggregate counts cash, burn, runway, MRR and reports: fixed definitions, where each number comes from, and what counts as reconciled.
---

# Definitions: how Aggregate counts cash, burn, runway, MRR and the rest

**Short answer:** every number Aggregate gives you or your AI uses one fixed definition, written down here and in the
code linked under each one. The AI doesn't do the arithmetic. It asks Aggregate, which computes the figure the same way
every time from one double-entry ledger and says how. When Aggregate can't know a figure (a source hasn't synced, a
month is missing), it says *unknown* and why. It never shows a zero it can't vouch for.

What Aggregate doesn't do yet, and what happens instead, is on [Known limits](limits.md).

Each answer also carries its own one-line formula, the accounts it counted and left out, and the rows behind it, so an
AI can show its work.

<!-- Keep in step with the code: each definition names the function that computes it. -->

## Cash

**The sum of the latest balance each bank reports for the accounts counted as cash: bank accounts, cash on hand and
processor balances (Stripe, Square, Shopify…).** It uses the *current* balance, not the *available* one, so a processor's pending
funds count. Accounts in other currencies are converted at the rate on the as-of date.

- **Card debt is not subtracted.** *Net cash* is cash minus what's owed on credit cards.
- **Not cash:** loans, investment and retirement accounts (listed separately, never added to cash), accounts you set to
  "don't count as cash", accounts not assigned to a company yet, and an account connected twice (counted once).
- If an account has never reported a balance, Aggregate uses its ledger balance instead and names the account in the answer.
- An account that has told Aggregate nothing yet (no balance and no transactions) makes cash *unknown* rather than
  counting it as zero.

Code: `balanceMetric` and `computeCashFigures` in
[packages/core/src/metrics.ts](https://github.com/Izzy-Gottz/aggregate-finance/blob/main/packages/core/src/metrics.ts).

## Burn

**Gross burn** is everything spent in the period, cash basis: every expense account (card purchases on the day of the
swipe, as your bank or card reports the date, payroll, fees, taxes, software, rent…) plus refunds paid to customers.

**Net burn** is gross burn minus operating money in: revenue, interest and other income. Positive means the company is
burning cash; zero or below means it isn't burning ("not burning").

Never in burn, either way: transfers between your own accounts, credit card payments (the purchases were already counted
when you swiped), processor payouts, owner money, investor money, loan principal and sales tax paid over to the state.

The overview shows net burn as a **monthly average over the last three complete months**. If your records start part-way through a month, that month is left out of the average. If one account's records start later than the rest, the answer says so. The month you're in isn't
counted, because a half month would understate it.

Code: `burnMetric` and `flows` in
[packages/core/src/metrics.ts](https://github.com/Izzy-Gottz/aggregate-finance/blob/main/packages/core/src/metrics.ts).

## Runway

**Cash ÷ average monthly net burn over the last three complete months**, cash basis. Shown in months, to one decimal,
with the approximate date the cash would run out.

- **Partial first month:** a first month that starts after the 1st is left out, as it is for burn.
- **Not enough history:** with fewer than two complete months of transactions, runway is "not enough history", not a
  guess.
- **Not burning:** if average net burn is zero or less, runway is "not burning", not infinity.
- **Combined runway (several companies):** total cash of all of them ÷ their total net burn. It is never the sum of
  each company's runway. A profitable company's surplus offsets the others' burn in that total, so a combined runway is
  only meaningful when every company in it is burning cash. The overview gives runway per company for that reason.

Code: `runwayMetric` in
[packages/core/src/metrics.ts](https://github.com/Izzy-Gottz/aggregate-finance/blob/main/packages/core/src/metrics.ts).

## Revenue

**Cash basis:** money in from customers in the period. Processor charges count at the gross amount the customer paid,
minus refunds, and a charge with no invoice can include the sales tax in it, because the processor's row doesn't split it out. Bank deposits count when they're categorized as revenue. Processor fees are a separate expense
("Processor fees"), so revenue is *gross* of fees. That's why it adds up to more than the payouts you see at the bank.

**Accrual basis:** invoiced revenue recognized by issue date, minus credit notes and refunds, net of sales tax. It's
only as complete as the invoicing tools you've connected.

Code: `revenueMetric` in
[packages/core/src/metrics.ts](https://github.com/Izzy-Gottz/aggregate-finance/blob/main/packages/core/src/metrics.ts).

## What never counts as revenue

- **Transfers between your own accounts**, including between your companies and you.
- **Credit card payments.**
- **Processor payouts** (Stripe, Square, Shopify to your bank). The sale was already counted when the customer was
  charged; the payout only moves it. *The one exception:* if the processor isn't connected, the deposit waits in
  Review as unexplained money. Once you say it's revenue, it counts net of the fees you can't see.
- **Owner money:** a founder putting money in is a loan to the company or an owner contribution, never revenue. Until
  you say which, it's kept as "owner money, not yet specified".
- **Investor money:** SAFEs, convertible notes and share purchases go to equity (SAFEs, convertible notes, paid-in
  capital) and wait in "investment money in transit" until the wire is seen at the bank.
- **Refunds:** a refund you *receive* from a vendor reduces that expense. A refund you *give* a customer reduces revenue.
- **Sales tax collected:** owed to the state, not yours. One exception: tax inside a Shopify, Stripe, Square or Gumroad sale with no invoice stays in revenue, because those rows don't split it out, and the answer says how many sales that covers.
- **Interest and other income:** counted as money in for net burn, but not as revenue.
- **Money nobody has explained yet:** a deposit Aggregate can't place is held as "What is this money?" and asked about.
  It isn't guessed into revenue.

Code: `classifyTxn` and `roleForKind` in
[packages/core/src/posting.ts](https://github.com/Izzy-Gottz/aggregate-finance/blob/main/packages/core/src/posting.ts).

## MRR and its movements

**MRR** uses Stripe's definition: the monthly value of active and past-due subscriptions, after discounts, without tax,
trials or metered usage. Yearly plans count as a twelfth per month. Other currencies are converted at the as-of rate.
**ARR** is MRR × 12.
For a past date, MRR counts what was live that day, from each subscription's own history.

**Movements**, month by month and **per customer**, the way ChartMogul and Baremetrics count them:

| Movement | When |
|---|---|
| New | A customer with no MRR at the start of the month has some at the end, and has never paid before |
| Reactivation | The same, but the customer had paid at some point before |
| Expansion | A customer's MRR went up |
| Contraction | A customer's MRR went down, but not to zero |
| Churn | A customer's MRR went to zero |

Counting per customer means a customer who swaps one plan for another is an expansion or contraction, not churn plus a
new customer. Start + new + expansion + reactivation − contraction − churn = end, exactly.

- **Net new MRR** is that month's change: new + expansion + reactivation − contraction − churn.
- **MRR churn rate** is (churn + contraction) ÷ MRR at the start of the month, for the last complete month.
- Both are *unknown*, never zero, when no subscription source is connected, or a source hadn't synced past the end of
  the month. A quiet month and a missing one would look the same otherwise.

Code: `mrrMetric` and `mrrMovementMetric` in
[packages/core/src/metrics.ts](https://github.com/Izzy-Gottz/aggregate-finance/blob/main/packages/core/src/metrics.ts) and
`mrrMovements` in [packages/core/src/mrr.ts](https://github.com/Izzy-Gottz/aggregate-finance/blob/main/packages/core/src/mrr.ts).

## Money owed to you and bills due (AR and AP)

- **Owed to you:** what's still owed on receivable invoices that are open, partly paid or disputed (total − paid −
  credited). Drafts, voided, paid and written-off invoices are left out.
- **Overdue:** the part of that with a due date before today.
- **Bills due:** open bills that are overdue or due in the next 30 days.

**Aging** puts each open invoice or bill by days past its due date:

| Bucket | Days past due |
|---|---|
| Current | not due yet (or no due date) |
| 1–30 | 1 to 30 |
| 31–60 | 31 to 60 |
| 61–90 | 61 to 90 |
| 90+ | over 90 |

Code: `openItemsMetric` in
[packages/core/src/metrics.ts](https://github.com/Izzy-Gottz/aggregate-finance/blob/main/packages/core/src/metrics.ts) and the
aging in `searchInvoices`,
[packages/core/src/finance-reader.ts](https://github.com/Izzy-Gottz/aggregate-finance/blob/main/packages/core/src/finance-reader.ts).

## "All reconciled"

The Workspace shows **All reconciled** only when nothing below is outstanding. Otherwise it counts what is, for example
"3 things need a look: 2 to review, 1 balance doesn't match". An account with one balance or none has nothing to compare
yet, so the line says "Reconciled except 1 account not tied out yet" until a second balance or a statement arrives.

- **Every balance matches.** For each bank, card and processor account, the change in the bank's reported balance between two days equals the
  sum of the transactions posted between them, to the cent. The newest day can lag a day while the bank settles; that
  only warns.
- **The ledger balances.** Every journal entry's debits equal its credits.
- **Processors add up.** For each processor: gross − fees − refunds = payouts + change in balance.
- **Invoices and bills match their accounts.** Open invoices and bills add up to the accounts receivable and accounts
  payable in the ledger.
- **Companies agree with each other.** What one company says another owes it matches what the other says it owes.
- **Your books agree.** Aggregate's profit and loss matches QuickBooks' or Xero's own report, where connected, and no
  source is connected twice.
- **Nothing is in transit for more than a week.** No transfer, payout or investor wire has gone unseen at the other end
  for over seven days.
- **Nothing is waiting for review.** Every suggested match, unexplained deposit and question has been answered.
- **Every connection is syncing** (one that hasn't synced in over a day doesn't count), and every account has reported
  a balance.
- **No month is missing** in the last three complete months: no account without a statement or transactions where some
  were expected.

Code: `dataHealth` in
[packages/core/src/health.ts](https://github.com/Izzy-Gottz/aggregate-finance/blob/main/packages/core/src/health.ts) and the
checks in [packages/core/src/checks.ts](https://github.com/Izzy-Gottz/aggregate-finance/blob/main/packages/core/src/checks.ts).

## How fresh a figure is

Every figure is *as of* the oldest successful sync among the sources behind it. A source that hasn't synced in over a
day is named as stale next to the figure, never quietly mixed in. A figure asked for a past date is as of the end of
that day.

Code: `answerAsOf` and `staleSources` in
[packages/core/src/metrics.ts](https://github.com/Izzy-Gottz/aggregate-finance/blob/main/packages/core/src/metrics.ts).
