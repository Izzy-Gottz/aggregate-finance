---
description: Connect QuickBooks Online to ChatGPT through Aggregate. Ask about invoices, bills and profit and loss next to your bank data. Read requests only.
---

# Connect QuickBooks Online to ChatGPT

**Short answer:** connect QuickBooks Online to Aggregate, then add Aggregate to ChatGPT with one link
(`https://app.aggregate.finance/mcp`). ChatGPT can then answer questions about your invoices, bills, payments, customers, vendors and accounts, using one ledger that also holds your other
accounts and companies. Aggregate only reads from QuickBooks, it can never move money, and you
choose exactly what ChatGPT can see.

**Status:** Works on the hosted version today. Self-hosted Aggregate works too, with a free Intuit developer app of your own.

## Set it up

### 1. Connect QuickBooks to Aggregate
Sign up at [app.aggregate.finance](https://app.aggregate.finance) (free during beta). Open **Workspace → Connections → + More connections → QuickBooks**, sign in to Intuit, pick the company, and approve.

### 2. Add Aggregate to ChatGPT
1. Open [ChatGPT Plugins](https://chatgpt.com/plugins), choose **Add** (top right), then **Add custom MCP server**.
2. Name it `Aggregate`. Under **Connection**, keep **Server URL** and paste `https://app.aggregate.finance/mcp`. Authentication: OAuth.
3. Check **I understand and want to continue**, select **Create as a plugin**, then **Connect** in the dialog.
4. Sign in to Aggregate and choose what ChatGPT can see: which companies, which kinds of data, read only or read and
   add, and when access expires.

In a ChatGPT Business or Enterprise workspace, an admin may need to allow custom MCP servers first.

## Five questions to try

1. *"Which invoices are overdue, and who owes us the most?"* (uses `query_invoices`)
2. *"What was our profit and loss last quarter?"* (uses `get_reports`)
3. *"What bills are due in the next 14 days?"* (uses `list_upcoming`)
4. *"How fast does Acme Corp usually pay us?"* (uses `get_counterparty`)
5. *"How much did we spend on software each month this year?"* (uses `query_transactions`)

ChatGPT answers from Aggregate's ledger, where a payout and the bank deposit it becomes are matched, not added twice (a pair
it isn't sure of waits in Review for you), and balances are checked against the source. Each answer can be traced to the records
behind it.

## Questions people ask

**Does Aggregate see my password?** No. You sign in on Intuit's own sign-in page. Aggregate stores only the access token it gets back,
encrypted with a key kept outside the database.

**Does my data train AI models?** Aggregate never uses your data to train models and doesn't let anyone else. What
ChatGPT reads is covered by OpenAI's own data policy for your plan.

**Can ChatGPT move money or change my QuickBooks?** No. Aggregate has no tool that pays, transfers, pays a bill
or sends anything, and it only reads from QuickBooks. (Intuit's permission covers the books as a whole, because Intuit offers no read-only option; Aggregate's QuickBooks connector only makes read requests, plus one call to revoke access when you disconnect.) If you allow it, ChatGPT can add records
*inside Aggregate* (for example a cash expense), and those can be undone for 30 days.

**What does it cost?** The hosted version is free while we're in beta. We may introduce paid plans later, and we'll let you know before anything changes. Self-hosting is free (AGPL-3.0).

**Can I run it myself?** Yes. Aggregate is open source; see [self-hosting](../self-hosting.md). You'll need your own
Intuit developer app (production keys) for real books.

## Related

- [Connect your AI to Aggregate](../connect-your-ai.md): every assistant, plus bots and scripts
- [Prompt recipes](../recipes.md)
- [How Aggregate compares](README.md#comparisons)

*Last checked 2026-10-12.*
