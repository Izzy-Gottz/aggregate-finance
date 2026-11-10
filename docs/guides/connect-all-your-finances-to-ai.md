---
description: How to connect all your finances to AI: link your banks, cards, Stripe, books and payroll to one read-only service, then add it to Claude or ChatGPT.
---

# How to connect all your finances to AI

**Short answer:** connect your accounts to one read-only service, then add that service to your AI with one link.
Aggregate does this: it brings your banks, cards, payment apps, books, payroll and investments into one ledger, and
Claude, ChatGPT, Perplexity or any other app that supports MCP can read it from `https://app.aggregate.finance/mcp`.
It can never move money. The hosted version is free during beta, and the code is open source.

We make Aggregate, so read this page with that in mind. [Best finance MCP servers](best-finance-mcp-server.md) lists
the alternatives, including when they're the better pick.

**Try it first:** [app.aggregate.finance/demo](https://app.aggregate.finance/demo) runs on sample data, with no signup.

## Why one connection instead of many

You can connect some of your tools to your AI one at a time. Stripe, Mercury, Brex, Ramp, Gusto and QuickBooks each
offer their own connection. Each one knows only its own data, so your AI has to add them up, and it can count the same
money twice: a Stripe payout is also a bank deposit, and a credit card payment isn't new spending.

Aggregate counts first and lets the AI reason afterwards. A payout and the deposit it becomes are matched as one event,
balances are checked against the source, and a number it doesn't know is reported as unknown, never as zero.

## Set it up

1. **Sign up** at [app.aggregate.finance](https://app.aggregate.finance).
2. **Connect your sources.** Open **Workspace → Connections → + Add a connection**. You sign in on each provider's own
   page, and Aggregate never sees your bank password.
3. **Add Aggregate to your AI** with the link above: [Claude](connect-claude.md), [ChatGPT](connect-chatgpt.md),
   [Perplexity](connect-perplexity.md), [Cursor](connect-cursor.md), [Claude Code and other command-line
   tools](connect-cli.md), or [any other app](../connect-your-ai.md).
4. **Choose what it can see.** Aggregate shows one sentence you can edit: which companies, which kinds of data, and
   when access expires. You can revoke it at any time, and every question is logged.

## What you can connect

| Kind | Live on the hosted app |
|---|---|
| Banks and cards | Plaid (9,600+ US institutions), SimpleFIN Bridge |
| Payments and sales | Stripe, Square, Shopify |
| Accounting and bills | QuickBooks Online, Xero (limited availability), BILL |
| Payroll | Payroll runs spotted in your bank data from any provider. Deel opens once Deel's marketplace review finishes |
| Investments and equity | Wefunder, investment holdings through Plaid, a built-in cap table |
| Everything else | Statement files from any bank, receipts and bills you upload |

Mercury, Brex, Ramp, Wise, Paddle, Polar, Gumroad, the App Store and Google Play are in beta on the hosted app. The full
list, with what each one brings in, is on [What Aggregate connects](../connectors.md).

Using something that isn't listed? Upload its statements, or ask your AI to add a record. Money that goes through Stripe
or your bank is already covered, so a newsletter paid through your own Stripe account shows up once Stripe is connected.

## What you can ask

- *"How much cash do I have across all my accounts and companies?"*
- *"How many months of runway do we have?"*
- *"Why was September's spending higher than August's?"*
- *"What bills are due in the next 14 days?"*
- *"Did every Stripe payout this month land in the bank?"*

More are in the [prompt recipes](../recipes.md).

## Questions people ask

**Is it safe to connect my bank to AI?** Aggregate only reads from your providers and has no tool that pays, transfers
or sends anything. What your AI reads is covered by that AI company's own data policy for your plan, so check it before
you connect. Aggregate never uses your data to train models.

**Does it work for personal finances, or only companies?** Both. You can hold several companies side by side, plus a
private Personal space.

**What if my bank is outside the US?** Plaid connections are for US banks and brokerages. Elsewhere, connect Wise or
upload statements from any bank. See [known limits](limits.md).

**What does it cost?** The hosted version is free during beta. We may introduce paid plans later, and we'll let you know
before anything changes. Self-hosting is free (AGPL-3.0); see [self-hosting](../self-hosting.md).

**What can't it do?** Quite a few things, and [known limits](limits.md) lists them.

## Related

- [Connect your bank, Stripe and QuickBooks to Claude](connect-finances-to-claude.md)
- [Connect your bank, Stripe and QuickBooks to ChatGPT](connect-finances-to-chatgpt.md)
- [AI CFO for startups: what works today](ai-cfo-for-startups.md)
- [Best finance MCP servers](best-finance-mcp-server.md)

*Last checked 2026-11-01.*
