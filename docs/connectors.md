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
| WooCommerce | Monthly sales reported by the store, with refunds, shipping and sales tax apart. Not booked revenue: the money arrives through Stripe, PayPal or your bank | Self-host |
| RevenueCat | MRR and churn for app subscriptions | Self-host |

## Accounting and bills

| Connection | What it brings in | Hosted |
|---|---|---|
| QuickBooks Online | Invoices, bills, accounts and reports from your books (read endpoints only) | Live |
| Xero | Invoices, bills, accounts and reports from your books | Live, limited availability |
| BILL | Bills you owe and invoices you've sent | Live |
| Expensify | Expense reports | Self-host |

## Payroll

| Connection | What it brings in | Hosted |
|---|---|---|
| Deel | Payroll and contractor payments (connect with an organization token) | Live |
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
