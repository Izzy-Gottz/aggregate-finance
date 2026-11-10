---
description: Some services have no Aggregate connector because their money runs through one it does connect: Substack, Beehiiv and Ko-fi through Stripe, crypto and investing apps through Plaid, payroll through your bank.
---

# Sources that come in through another connection

**Short answer:** some services have no connector of their own because their money already runs through something Aggregate connects to. Connect that, and the money comes with it. It's only counted once.

## Paid newsletters and tips: connect Stripe

| You use | What to connect | What you'll see |
|---|---|---|
| Substack paid subscriptions | The Stripe account linked to your Substack | Subscription charges, Stripe fees, refunds and payouts |
| Beehiiv paid subscriptions | The Stripe account linked to your Beehiiv | The same |
| Ko-fi | The Stripe account linked to your Ko-fi | The same. Ko-fi payments made through PayPal arrive as PayPal deposits in your bank |

In Aggregate, open **Workspace → Connections → + Add a connection → Stripe**. See [Connect Stripe to Claude](connect-stripe-to-claude.md).

These show up under Stripe's name. Aggregate doesn't read Substack, Beehiiv or Ko-fi themselves, so it doesn't know subscriber lists, open rates or free subscribers. Anything these services take as their own cut shows up only as far as Stripe records it.

## Crypto and investing apps: connect through Plaid

Plaid's coverage list shows Kraken, Gemini, Robinhood, Interactive Brokers and Fundrise, each with Investments support.

1. Open **Workspace → Connections → + Add a connection → Bank, card or brokerage**.
2. Search for the app's name and sign in there.
3. Choose the accounts to share.

Aggregate reads only. We've confirmed these names in Plaid's coverage list and in its test environment, not on real accounts, so what comes through can vary by account. If one doesn't connect, or a balance looks wrong, tell support@aggregate.finance. Plaid's list doesn't promise that a given app works today.

## Payroll: Gusto, ADP and Paychex

Direct payroll records for these come through Finch, which is **coming soon** on the hosted version.

Today, connect the bank account your payroll runs from. Aggregate spots payroll runs in your bank data, so wages still count in your numbers, though you won't see the employee or tax breakdown.

If you self-host, you can connect Finch now with your own Finch keys. See [self-hosting](../self-hosting.md).

## Related

- [What Aggregate connects](../connectors.md)
- [Known limits](limits.md)

*Last checked 2026-11-02.*
