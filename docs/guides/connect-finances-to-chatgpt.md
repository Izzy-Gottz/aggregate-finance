---
description: Connect your bank, Stripe and QuickBooks to ChatGPT with one read-only link. Ask about cash, runway and MRR from one ledger. Free during beta.
---

# Connect your bank, Stripe and QuickBooks to ChatGPT

**Short answer:** connect your bank, Stripe and QuickBooks Online to Aggregate, then add Aggregate to ChatGPT as a custom
MCP server with one link (`https://app.aggregate.finance/mcp`). ChatGPT can then answer questions across all three from
one ledger, where a Stripe payout and the bank deposit it becomes count once. Aggregate only reads from those services
and can never move money. The hosted version is free during beta.

**Status:** works on the hosted version today, as a custom MCP server you add on ChatGPT on the web. Which ChatGPT plans
can add one has changed more than once, so if the option is missing, check OpenAI's help page "Developer mode and MCP
apps in ChatGPT".

## Set it up

### 1. Connect your sources

Sign up at [app.aggregate.finance](https://app.aggregate.finance), then open **Workspace → Connections → + More
connections**.

- **Bank and cards:** choose your bank and sign in through Plaid.
- **Stripe:** sign in to Stripe and approve read access. You can connect more than one account.
- **QuickBooks Online:** sign in to Intuit, pick the company, and approve.
  ([Guide](connect-quickbooks-to-chatgpt.md))

### 2. Add Aggregate to ChatGPT

1. Open [ChatGPT Plugins](https://chatgpt.com/plugins), choose **Add** (top right), then **Add custom MCP server**.
2. Name it `Aggregate`. Under **Connection**, keep **Server URL** and paste `https://app.aggregate.finance/mcp`.
   Authentication: OAuth.
3. Check **I understand and want to continue**, select **Create as a plugin**, then **Connect** in the dialog.
4. Sign in to Aggregate and choose what ChatGPT can see: which companies, which kinds of data, read only or read and
   add, and when access expires.

In a ChatGPT Business or Enterprise workspace, an admin may need to allow custom MCP servers first.

## Questions to try

1. *"How much cash do we have, and how many months of runway?"* (uses `get_metric`)
2. *"Did every Stripe payout this month land in the bank?"* (uses `search_transactions`)
3. *"What is our MRR, and how much came from new customers vs. churn last month?"* (uses `get_mrr_movements`)
4. *"Which invoices are overdue, and who owes us the most?"* (uses `query_invoices`)
5. *"What was our profit and loss last quarter?"* (uses `get_reports`)

## Doesn't ChatGPT already connect to banks?

Yes. ChatGPT has its own personal finance feature, and for personal accounts in ChatGPT alone it's the simpler choice.
Stripe and QuickBooks also offer their own ChatGPT connections, which can act inside those tools. Aggregate is for
questions that cross your tools, for company finances, and for using the same data in more than one AI. See
[Aggregate vs. ChatGPT's personal finance feature](aggregate-vs-chatgpt-finances.md).

## Questions people ask

**Does Aggregate see my passwords?** No. You sign in on each provider's own page. Aggregate stores only the access token
it gets back, encrypted with a key kept outside the database.

**Does my data train AI models?** Aggregate never uses your data to train models and doesn't let anyone else. What
ChatGPT reads is covered by OpenAI's own data policy for your plan.

**Can ChatGPT move money or change my books?** No. Aggregate has no tool that pays, transfers, pays a bill or sends
anything, and it only makes read requests to your providers. If you allow it, ChatGPT can add records *inside Aggregate*
(for example a cash expense), and those can be undone for 30 days.

**What does it cost?** The hosted version is free during beta. We may introduce paid plans later, and we'll let you know
before anything changes. Self-hosting is free (AGPL-3.0).

**I use a different bank or accounting app.** See [What Aggregate connects](../connectors.md). If yours isn't there,
statement files from any bank work.

## Related

- [How to connect all your finances to AI](connect-all-your-finances-to-ai.md)
- [The same thing for Claude](connect-finances-to-claude.md)
- [Prompt recipes](../recipes.md)
- [Known limits](limits.md)

*Last checked 2026-11-01.*
