# What Aggregate connects

Aggregate brings your money into one ledger: banks and cards, payment apps, accounting, payroll and investments,
for several companies side by side plus a private Personal space. Your AI then reads it through one link.
Aggregate only ever reads from your providers and has no way to move money.

**Live** means you can connect it on [app.aggregate.finance](https://app.aggregate.finance) today. **Beta** means
it's offered on the hosted app and built to the provider's documentation, but still being checked with real
accounts. **Self-host** means it works when you run Aggregate yourself
([source on GitHub](https://github.com/Izzy-Gottz/aggregate-finance)) and isn't offered on the hosted app yet.

## Banks and cards

| Connection | What it brings in | Hosted |
|---|---|---|
| Plaid | 9,600+ US banks, credit unions, brokerages and card issuers: accounts, balances, transactions, investment holdings, and loans and cards (mortgages, student, auto and personal loans, card APRs and due dates) | Live |
| SimpleFIN Bridge | Bank accounts and transactions through your own SimpleFIN Bridge token | Live |
| Mercury | Accounts, balances and transactions | Beta |
| Brex | Cards, accounts and spending | Beta |
| Ramp | Cards and spending | Beta |
| Wise | Balances in every currency and transactions | Beta |

## Payments and sales

| Connection | What it brings in | Hosted |
|---|---|---|
| Stripe | Payments, payouts, fees and subscriptions (MRR), across several Stripe accounts | Live |
| Square | Sales, payouts and fees | Live |
| Shopify | Orders, payouts and fees | Live |
| Paddle | Sales and subscriptions | Beta |
| Polar | Sales and subscriptions | Beta |
| Gumroad | Sales | Beta |
| App Store | App sales and subscriptions | Beta |
| Google Play | App sales and subscriptions | Beta |
| PayPal, Lemon Squeezy, Chargebee | Sales and payouts | Self-host |
| Patreon | Memberships and MRR | Self-host |
| WooCommerce | Monthly sales reported by the store, with refunds, shipping and sales tax apart. Not booked revenue: the money arrives through Stripe, PayPal or your bank | Self-host |
| Lightspeed Retail (X-Series) | Monthly sales reported by the store, with refunds and sales tax apart. Totals only, no item-level data. Not booked revenue: the money arrives through your bank or processor | Self-host |
| Mollie | Mollie's own monthly balance report per currency: payments, refunds, chargebacks, Mollie fees and their net, other balance moves, payouts to your bank, and the balance at month end. Each month is checked from opening to closing balance. Totals only, no customer details. Months on Amsterdam time | Self-host |
| Whop | Whop's own monthly income statement per currency: payments, refunds, disputes, fees and the other families Whop groups its ledger into, and their net. Totals only, no buyer details. Not posted: payouts reach your bank | Self-host |
| OwnerRez | Monthly payments collected, refunds, chargebacks and processing fees, each on its own line. Totals only, no guest or booking details. One currency per account: an account with properties in more than one currency isn't reported. Not booked revenue: the money arrives through Airbnb, Vrbo, your processor or your bank | Self-host |
| Squarespace | Monthly store sales less refunds, in each currency. Totals only, no customer details. Includes tax, shipping and donations. Refunds made outside Squarespace aren't seen. Not booked revenue: the money arrives through your payment processor | Self-host |
| YouTube | A channel's monthly estimated revenue from YouTube Analytics, in US dollars. Channel totals only, no video detail. Estimates can change. Not booked revenue: the money arrives through AdSense and your bank | Self-host |
| Pinterest Ads | An ad account's monthly ad spend in its own currency, about the last 90 days and kept from then on. Account totals only, no campaign or ad detail. Not a booked expense: the money shows up as card or bank spend | Self-host |
| Wix | Monthly store sales less refunds, in each currency, by UTC month. Totals only, no customer details. Includes tax and shipping. Chargebacks aren't taken off. Not booked revenue: the money arrives through your payment processor | Self-host |
| Google AdSense | Monthly estimated earnings and payments received in each currency, each on its own line. Totals only, no site or ad unit detail. Estimates can change, and the unpaid balance is left out. Not booked revenue: the money arrives through your bank | Self-host |
| SumUp | Monthly gross sales, cash sales, refunds and chargebacks, and payouts, fees and deductions in each currency, each on its own line. Totals only, no customer or card details. Not booked revenue: the money arrives through your bank | Self-host |
| RevenueCat | MRR and churn for app subscriptions | Self-host |

## Accounting and bills

| Connection | What it brings in | Hosted |
|---|---|---|
| QuickBooks Online | Invoices, bills, accounts and reports from your books (read endpoints only) | Live |
| Xero | Invoices, bills, accounts and reports from your books | Live, limited availability |
| BILL | Bills you owe and invoices you've sent | Live |
| Expensify | Expense reports | Self-host |
| Harvest | Monthly invoiced and paid totals in each currency, with tax apart. Not booked revenue: the same invoices may be in your books, and the money arrives through your bank. Paid totals miss payments on invoices issued more than 12 months before the first month shown | Self-host |

## Payroll

| Connection | What it brings in | Hosted |
|---|---|---|
| Deel | Payroll and contractor payments, through Deel's sign-in (open to other organizations once Deel's marketplace review finishes) | Coming soon |
| Any payroll provider | Payroll runs spotted in your bank data | Live |
| Justworks (direct), Rippling | Payroll runs | Self-host |
| Finch | Payroll from many providers | Coming soon |

## Investments and equity

| Connection | What it brings in | Hosted |
|---|---|---|
| Wefunder | The companies you've invested in through Wefunder | Live |
| Cap table | Built in: shareholders, SAFEs and option pools. Imports Pulley, Carta and Mantle exports, CSV and Open Cap Table Format | Live |
| Carta (direct), Coinbase | Cap table; crypto balances | Self-host |

## Everything else

| Connection | What it brings in | Hosted |
|---|---|---|
| Statements | CSV, OFX, QFX and QBO files from any bank | Live |
| Receipts and bills | PDFs and photos you upload | Live |
| Receipts by email | Bills and receipts forwarded to your own inbox address | Self-host |
| Your AI | Cash you received or spent, an invoice from a photo: anything a connection can't see, labeled and undoable for 30 days | Live |

Missing something you use? Tell us at support@aggregate.finance.

Next: [Connect your AI](connect-your-ai.md) · [Prompt recipes](recipes.md) · [Guides](/docs/guides)
