# Connect your bank, Stripe and QuickBooks to Claude

**Short answer:** connect your bank, Stripe and QuickBooks Online to Aggregate, then add Aggregate to Claude as a custom
connector with one link (`https://app.aggregate.finance/mcp`). Claude can then answer questions across all three from
one ledger, where a Stripe payout and the bank deposit it becomes count once. Aggregate only reads from those services
and can never move money. The hosted version is free during beta.

**Status:** works on the hosted version today.

## Set it up

### 1. Connect your sources

Sign up at [app.aggregate.finance](https://app.aggregate.finance), then open **Workspace → Connections → + More
connections**.

- **Bank and cards:** choose your bank and sign in through Plaid. ([Guide](connect-bank-accounts-to-claude.md))
- **Stripe:** sign in to Stripe and approve read access. You can connect more than one account.
- **QuickBooks Online:** sign in to Intuit, pick the company, and approve.
  ([Guide](connect-quickbooks-to-claude.md))

### 2. Add Aggregate to Claude

1. In Claude (claude.ai or Claude Desktop), open **Customize → Connectors** (in some accounts still **Settings →
   Connectors**), choose **Add**, then **Add custom connector**.
2. Name it `Aggregate`, paste `https://app.aggregate.finance/mcp` and click **Continue**. Claude detects the sign-in;
   click **Add**, then **Connect**.
3. Sign in to Aggregate and choose what Claude can see: which companies, which kinds of data, read only or read and
   add, and when access expires.
4. In a new chat, turn on the Aggregate connector and ask a question.

The Claude mobile apps use connectors added on the web or desktop. Using Claude Code instead? Run
`claude mcp add --transport http --scope user aggregate https://app.aggregate.finance/mcp`, then `/mcp` to sign in.

## Questions to try

1. *"How much cash do we have, and how many months of runway?"* (uses `get_metric`)
2. *"Did every Stripe payout this month land in the bank?"* (uses `list_review_items`)
3. *"What is our MRR, and how much came from new customers vs. churn last month?"* (uses `get_mrr_movements`)
4. *"Which invoices are overdue, and who owes us the most?"* (uses `query_invoices`)
5. *"What was our profit and loss last quarter?"* (uses `get_reports`)

## Why not connect each one to Claude separately?

You can. Stripe and QuickBooks both offer their own Claude connectors, and those can also act: create an invoice, or
issue a refund. They're the better choice when you want Claude to do work inside that tool. Each one sees only its own
data, though, so Claude has to join the numbers itself. Aggregate is for the questions that cross your tools. You can
use both; [this comparison](aggregate-vs-provider-mcp-servers.md) goes through the trade-offs.

## Questions people ask

**Does Aggregate see my passwords?** No. You sign in on each provider's own page. Aggregate stores only the access token
it gets back, encrypted with a key kept outside the database.

**Does my data train AI models?** Aggregate never uses your data to train models and doesn't let anyone else. What
Claude reads is covered by Anthropic's own data policy for your plan.

**Can Claude move money or change my books?** No. Aggregate has no tool that pays, transfers, pays a bill or sends
anything, and it only makes read requests to your providers. If you allow it, Claude can add records *inside Aggregate*
(for example a cash expense), and those can be undone for 30 days.

**What does it cost?** The hosted version is free during beta. We may introduce paid plans later, and we'll let you know
before anything changes. Self-hosting is free (AGPL-3.0).

**I use a different bank or accounting app.** See [What Aggregate connects](../connectors.md). If yours isn't there,
statement files from any bank work.

## Related

- [How to connect all your finances to AI](connect-all-your-finances-to-ai.md)
- [The same thing for ChatGPT](connect-finances-to-chatgpt.md)
- [Prompt recipes](../recipes.md)
- [Known limits](limits.md)

*Last checked 2026-11-01.*
