---
description: Connect Xero to ChatGPT through Aggregate, with limited room on the hosted version. Ask about invoices, bills and reports. Read-only.
---

# Connect Xero to ChatGPT

**Short answer:** connect Xero to Aggregate, then add Aggregate to ChatGPT with one link
(`https://app.aggregate.finance/mcp`). ChatGPT can then answer questions about your invoices, bills, payments, bank transactions and reports, using one ledger that also holds your other
accounts and companies. Aggregate only reads from Xero, it can never move money, and you
choose exactly what ChatGPT can see.

**Status:** Live on the hosted version, with limited room. Aggregate is not a certified Xero app, so hosted Aggregate connects up to 5 Xero organisations in total, across all customers. Each organisation you choose takes one place. If they are all taken, you can [self-host](../self-hosting.md) with your own Xero app, or upload bank statements instead.

## What it brings in

- Your chart of accounts
- Invoices and bills, with their credit notes
- Payments, overpayments and prepayments
- Bank transactions (spend and receive money)
- Manual journals
- Your monthly profit and loss, so Aggregate's totals can be checked against Xero's own

Xero doesn't give apps access to Xero Payroll or expense claims, so wages, payroll tax and claimed expenses in Xero's profit and loss are missing from Aggregate's. Aggregate flags those months and says why. Connect your bank to include them.

## Set it up

### 1. Connect Xero to Aggregate
Sign up at [app.aggregate.finance](https://app.aggregate.finance) (free during beta). Open **Workspace → Connections → + More connections → Xero**, sign in to Xero, choose the organisation, and allow access.

### 2. Add Aggregate to ChatGPT
1. Open [ChatGPT Plugins](https://chatgpt.com/plugins), choose **Add** (top right), then **Add custom MCP server**.
2. Name it `Aggregate`. Under **Connection**, keep **Server URL** and paste `https://app.aggregate.finance/mcp`. Authentication: OAuth.
3. Check **I understand and want to continue**, select **Create as a plugin**, then **Connect** in the dialog.
4. Sign in to Aggregate and choose what ChatGPT can see: which companies, which kinds of data, read only or read and
   add, and when access expires.

In a ChatGPT Business or Enterprise workspace, an admin may need to allow custom MCP servers first.

## Five questions to try

1. *"Which customers owe us money, and how overdue are they?"* (uses `query_invoices`)
2. *"Give me the balance sheet as of the end of last month."* (uses `get_reports`)
3. *"What do we owe suppliers in the next 30 days?"* (uses `list_upcoming`)
4. *"How much did we pay this vendor this year?"* (uses `get_counterparty`)
5. *"Which expense categories grew the most since last quarter?"* (uses `query_transactions`)

ChatGPT answers from Aggregate's ledger, where every payment is counted once (a payout and the bank deposit it becomes are
matched, not added twice) and balances are checked against the source. Each answer can be traced to the records
behind it.

## Questions people ask

**Does Aggregate see my password?** No. You sign in on Xero's own sign-in page. Aggregate stores only the access token it gets back,
encrypted with a key kept outside the database.

**Does my data train AI models?** Aggregate never uses your data to train models and doesn't let anyone else. What
ChatGPT reads is covered by OpenAI's own data policy for your plan.

**Can ChatGPT move money or change my Xero?** No. Aggregate has no tool that pays, transfers, pays a bill
or sends anything, and it only reads from Xero. (Aggregate asks Xero only for read scopes.) If you allow it, ChatGPT can add records
*inside Aggregate* (for example a cash expense), and those can be undone for 30 days.

**What does it cost?** The hosted version is free while we're in beta. We may introduce paid plans later, and we'll let you know before anything changes. Self-hosting is free (AGPL-3.0).

**Can I run it myself?** Yes. Aggregate is open source; see [self-hosting](../self-hosting.md). You'll need your own
Xero developer app.

## Related

- [Connect your AI to Aggregate](../connect-your-ai.md): every assistant, plus bots and scripts
- [Prompt recipes](../recipes.md)
- [How Aggregate compares](README.md#comparisons)

*Last checked 2026-11-01.*
