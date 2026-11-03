---
description: Put your company's accounts and your personal accounts, including your mortgage, in one read-only ledger, then ask your AI about both.
updated: 2026-11-02
---

# Your company and personal finances in one AI

**Short answer:** connect your business accounts and your personal accounts to Aggregate, then add Aggregate to your AI
with one link (`https://app.aggregate.finance/mcp`). Your company and your personal money sit side by side as separate
companies in one ledger, so you can ask one question that covers both. Aggregate only reads. It can never move money.

**Status:** Live on the hosted version, free during beta. Plaid banks are US only.

## Set it up

1. Sign up at [app.aggregate.finance](https://app.aggregate.finance).
2. Connect your company's sources: banks and cards, plus Stripe, Square, Shopify, QuickBooks Online, BILL or payroll if you
   use them. [What Aggregate connects](../connectors.md) marks each one Live or Beta.
3. Connect your personal accounts under **Personal**. Through Plaid that covers checking, savings, cards, brokerage
   accounts and loans, including mortgages.
4. [Add Aggregate to your AI](../connect-your-ai.md), and choose which companies it can see. To ask across both, give it
   your company and Personal.

## Questions to try

1. *"What's my net worth, and what's the company's runway?"*
2. *"How much is in my personal accounts, what do I owe on my cards, and what bills are due in the next two weeks?"*
3. *"What's left on my mortgage, what's the rate, and when is the next payment due?"*
4. *"What does the company owe me, from loans, money I put in and expenses I paid on my own card?"*
5. *"If the company's costs rose by $5,000 a month, how would runway change?"*

Runway is worked out from your connected accounts, using complete months only. Net worth isn't a number Aggregate
stores: your AI adds it up from your balances, holdings and loans, and it can show you what it counted.

## What it leaves out

- **Your home's value.** A mortgage shows what you owe, not what the house is worth. Any net worth answer leaves the home
  out unless you tell your AI a value to use in that chat.
- **The value of your company.** Your stake has no price in Aggregate, so give your AI a figure if you want it counted.
- **Most crypto.** Coinbase isn't on the hosted version yet, and other exchanges and wallets don't connect. See
  [known limits](limits.md).
- **Anything your bank doesn't report.** Loan terms appear as the bank last reported them, and missing fields are left out.

Balances are as of the last sync.

## Questions people ask

**Will my personal spending get mixed into the company's numbers?** No. Personal is kept apart from your company, and
burn and runway count the company's accounts. If you pay a business expense on a personal card, it can be recorded as money
the company owes you.

**Can I keep my personal accounts away from an AI?** Yes. Each AI gets its own access, and you choose which companies it
can see. Leave Personal out and it can't read those accounts.

**Can a co-founder or accountant see my personal accounts?** Not by default. Your Personal space is private to you
unless you choose to share it. People in your workspace see only the companies and data their role allows.

**Does Aggregate see my bank password?** No. You sign in on your bank's own page through Plaid.

**What does it cost?** Aggregate is free while we're in beta. We may introduce paid plans later, and we'll let you know
before anything changes.

## Related

- [AI CFO for startups: what works today](ai-cfo-for-startups.md)
- [How to connect all your finances to AI](connect-all-your-finances-to-ai.md)
- [Prompt recipes](../recipes.md)
- [Known limits](limits.md)

*Last checked 2026-11-02.*
