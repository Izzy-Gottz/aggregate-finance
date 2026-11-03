---
description: What Aggregate doesn't do yet, what happens instead, and what's coming: crypto, non-US banks, PDF statements, cap tables, currencies and more.
---

# Known limits: what Aggregate doesn't do yet, and what happens instead

**Short answer:** Aggregate is early. This page lists what it doesn't do, or does imperfectly, today. For each one it
says what happens instead, so nothing is quietly wrong, and what's coming where something is planned. For how each
number is counted, see [Definitions](definitions.md).

<!-- Keep this page true: change it in the same commit as the code it describes. "Coming" only for planned work. -->

## Crypto

**Today:** Coinbase connects read-only on a self-hosted server, with a Coinbase Developer Platform API key that has
only the View permission (a key that can trade or move money is refused). The hosted app doesn't offer Coinbase yet:
it needs Coinbase sign-in, which Coinbase gives to approved partners. Other exchanges and wallet addresses don't
connect. A crypto account that a bank connection reports shows up as a crypto account.

**What happens instead:**
- Each Coinbase crypto wallet shows how much you hold (to the last decimal Coinbase gives) and its dollar value at
  Coinbase's price when it synced. Crypto isn't money in the books: it's never posted, never converted and never cash.
- A Coinbase cash wallet (USD and the like) is money: its rows are booked and its balance checks against Coinbase's.
  Buying crypto from it counts as Other assets at what you paid, and selling counts back at what you got. So the books
  show what you put into crypto, not a gain or loss; there's no cost basis or tax lot.
- Crypto-side rows (sends, receives, staking rewards paid in crypto) aren't brought in; the wallet's quantity is.
- Crypto accounts are never counted in cash. Cash only counts bank accounts, cash on hand and processor balances,
  unless you choose to count an account yourself.

**Coming:** Coinbase sign-in on the hosted app, once Coinbase approves Aggregate's OAuth client.

## Banks outside the US

**Today:** bank connections through Plaid are for US banks and brokerages. Outside the US, Wise is the one account you can
connect directly.

**What happens instead:** upload statements. Aggregate imports CSV (comma decimals and day-first dates included; when
the date order is ambiguous it asks instead of guessing), OFX, QFX, QBO and ISO 20022 (camt.053 and camt.052) files from
any bank.

**Coming:** no date yet for a direct non-US bank connection.

## Cash sales in Square

**Today:** Square payments taken in cash, or with an "other" tender such as a check, are imported into a **Square cash
drawer** account for each location (cash on hand). They count as sales when they're rung up, and a refund paid back in
cash comes out of the drawer and lowers sales.

**When you deposit the cash:** the bank deposit is matched to the drawer's sales it adds up to, oldest first, and less
any cash refunds. You confirm the match in Review, and the drawer goes back to zero.

**Still a limit:** the drawer only knows what went through Square. Cash taken without ringing it up, change kept in the
drawer, or a deposit that mixes takings from several days in a different order may need a word in Review.

## PDF bank statements

**Today:** PDF statements import automatically for 11 statement layouts:
- Chase checking and credit card
- Bank of America checking and credit card
- American Express
- Wells Fargo checking
- Citi credit card
- Capital One credit card
- U.S. Bank checking
- PNC checking
- Mercury

A PDF is imported only if its rows add up exactly to its opening and closing balances.

**What happens instead:** any other PDF is saved as a document and nothing is imported from it. That covers another
bank's layout, a scan, a statement whose rows don't add up, or a file over 60 pages. Your AI can read it and add what it
finds, or you can upload the bank's CSV. Password-protected PDFs are refused.

**Coming:** more layouts.

## CSV statement uploads

**Today:** a bank's CSV export doesn't include the card or account number. Two cards from the same bank uploaded as CSV
(for example two Chase cards) go into one account.

**What happens instead:** OFX, QFX and QBO downloads include the number, so they stay separate. Upload those, or
choose the account when Aggregate asks "Which account is this statement for?".

## Cap tables

**Today:** cap tables import from Pulley's cap-table workbook, Carta's and Mantle's OCX export (`.xlsx`), CSV ledgers
and Open Cap Table Format (OCF) JSON. Old `.xls` and password-protected files aren't read. There's no live connection to
Pulley or Carta.

**What happens instead:** an OCX file, or a workbook with only a summary tab, is a snapshot. It imports each holder's
holdings on one date, with no issue prices, vesting or grant history, and its options come in as NSOs. The import says
so. A snapshot is never stacked on holdings that are already there, so nothing is counted twice. See
[Moving off Pulley? Bring your cap table](import-pulley-carta.md).

**Coming:** no date yet for a direct Carta connection.

## Two places where money is counted differently

**Today:** two exceptions in [Definitions](definitions.md):
- **Payouts:** a processor payout (Stripe, Square or Shopify to your bank) is normally not revenue, because the sale was
  counted when the customer paid. If the processor isn't connected, the deposit waits in Review as money nobody has
  explained, so it isn't revenue yet. Revenue reads low and net burn high until you answer. If you say it's revenue, it
  counts net of fees Aggregate can't see.
- **Card payments:** paying off a credit card is normally not spending, because the purchases were counted when you
  swiped. But if the card isn't connected, the payment is the only sign of that spending, so it counts as spending, in
  one lump instead of purchase by purchase.

**What happens instead:** connect the processor or the card, and both are counted the normal way.

## Money a processor holds

**Today:** cash counts a processor's whole balance, including funds still pending. On Stripe it also counts funds
reserved for connected accounts. So part of it may not be spendable yet. `list_accounts` shows each account's available
amount next to its balance.

**What happens instead:**
- Funds held in a reserve leave cash and sit in Other assets until they're released. They aren't spending.
- A processor advance or loan is money owed (Other liabilities). Repayments lower what's owed and aren't spending. The
  interest or fee inside a repayment isn't split out.
- A payout that has left the processor and hasn't reached the bank is in neither account until it lands. Cash says how
  much is in transit like this, so you can add it back if you're sure it will arrive.
- Stripe Connect transfers to your sellers stay in transit, and aren't spending. A warning appears after a week.

## A sale in both a processor and your accounting books

**Today:** if a customer's payment shows in Stripe and also in QuickBooks, Xero or FreshBooks, it counts in both until
you say they're the same.

**What happens instead:** when the amount and customer name agree, Aggregate asks in Review. Once you confirm, it counts
once. If the names differ, it doesn't ask, so the sale stays counted twice. The revenue check against your accounting
books won't catch this.

## Loan payments

**Today:** Aggregate doesn't split a loan payment into principal and interest. What happens depends on what your lender
sends:

- **Balances and transactions:** once you confirm the match, the payment comes off the loan in full, so burn can read
  low by the interest. Burn and runway say how much in payments this covers.
- **Balances only:** the bank payment counts as spending in full, so burn can read high by the principal.

A loan's balance isn't checked against its rows, because interest raises it with no row behind it.

## Several companies added together

**Today:** reports (profit and loss, balance sheet, cash flow) are per company; there is no combined report for a
group. Figures asked for several companies at once (cash, burn, revenue) add the companies up. Money moved between
your companies is booked as owed between them once matched (Aggregate suggests the match in Review when it sees both
sides), not as sales or spending, so combined cash and net burn come out right.
But an invoice or bill between two of your own companies counts as revenue in one and spending in the other, so
combined revenue and gross burn include it twice (net burn is unaffected: the two cancel).

**What happens instead:** read revenue and gross burn per company, or leave invoices between your own companies out
of the connected books.

## Currencies

**Today:** each company keeps its books in one currency, which you choose when you create it. It can't be changed once
the company has accounts. Other currencies are converted at the European Central Bank's daily reference rates (through
Frankfurter), on the date of each figure. On days without a rate, the most recent one from the 7 days before is used.

**What happens instead:**
- A currency the European Central Bank doesn't publish can't be converted. Importing that account stops with an error
  that names the missing rate, rather than guessing one.
- Xero documents in a foreign currency use the market rate, not the rate Xero recorded.

**Coming:** no date yet for currencies outside the ECB's list.

## How stale data is shown

**Today:** a source that hasn't synced in over a day is called stale. Every figure is as of the oldest successful sync
among the sources behind it.

**What happens instead:** stale data is never quietly mixed in.
- A stale source is named next to the figures that use it, and the Workspace counts it ("1 connection not syncing").
- An account that has never reported anything makes its figures *unknown*, never zero.
- MRR movements for a month are unknown until every subscription source has synced past the end of that month.

## Self-hosting on SQLite

**Today:** hosted Aggregate runs on Postgres with row-level security. Every query is limited to one workspace by the
database itself, beneath the app's own permission checks. A self-hosted install on SQLite (the default for `npm start`
and `npx aggregate-finance demo`) doesn't have that second layer. It relies on the app's checks alone.

**What happens instead:** run self-hosted Aggregate on Postgres (`DATABASE_URL=postgres://…`) to get row-level
security. A self-hosted database usually holds just one person's workspace anyway. The numbers are the same on both: a
test compares SQLite and Postgres figure by figure.

## Providers not live on the hosted version yet

**Today:** some providers are waiting for the provider's own approval, or for keys:
- **Xero** connects up to 5 organizations across all of hosted Aggregate, because Aggregate is not a certified Xero app.
- **Finch and Rippling** are built and being tested with real accounts. On hosted, they also need production keys
  from each provider.
- **Justworks** has no direct connection on hosted: Justworks didn't approve a partner key.
- **FreshBooks** is built from FreshBooks' documentation and not yet checked on a real account, so it isn't listed as
  supported yet. It doesn't read credit notes or other income, so the P&L check says so when those make the two differ.
- **Expensify** is self-hosted only, in beta. Its credentials can't be limited to reading, and hosted Aggregate
  only takes read-only access. It's built from Expensify's documentation and not yet checked on a real account.

**What happens instead:**
- **Stripe:** self-hosted Aggregate works with Stripe today, using a restricted read-only key.
- **Shopify:** connect your store with your own Shopify app.
- **Xero:** if the cap is reached, self-host with your own Xero app, or upload statements.
- **Payroll (Justworks, Gusto and others):** payroll is spotted in your bank data today. Finch will bring in the
  payroll records themselves once it's live on hosted.
- **Rippling:** self-hosters can use it now.
- **Expensify:** self-hosters can paste Expensify's partner credentials. Company-card expenses then give the card's rows
  their Expensify category, and an approved out-of-pocket report becomes a bill owed to the employee, settled by the
  reimbursement from the bank. A refund on the card is asked about as usual. On hosted, the card and bank rows are
  there without Expensify's categories.

**Coming:** each opens on hosted as soon as its provider approves it.
