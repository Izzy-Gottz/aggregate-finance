---
description: Connect Stripe to ChatGPT through Aggregate. Ask about MRR, fees and payouts, and whether each payout reached the bank. Read-only.
---

# Connect Stripe to ChatGPT

**Short answer:** connect Stripe to Aggregate, then add Aggregate to ChatGPT with one link
(`https://app.aggregate.finance/mcp`). ChatGPT can then answer questions about your charges, refunds, fees, payouts, invoices and subscription revenue (MRR), using one ledger that also holds your other
accounts and companies. Aggregate only reads from Stripe, it can never move money, and you
choose exactly what ChatGPT can see.

**Status:** Works on the hosted version today, and Aggregate is available on the Stripe App Marketplace. Self-hosted Aggregate works too, with a restricted key with read permissions.

## Set it up

### 1. Connect Stripe to Aggregate
Sign up at [app.aggregate.finance](https://app.aggregate.finance) (free during beta). Open **Workspace → Connections → + Add a connection → Stripe**, sign in to Stripe, and approve read access. You can connect more than one Stripe account.

### 2. Add Aggregate to ChatGPT
1. Open [ChatGPT Plugins](https://chatgpt.com/plugins), choose **Add** (top right), then **Add custom MCP server**.
2. Name it `Aggregate`. Under **Connection**, keep **Server URL** and paste `https://app.aggregate.finance/mcp`. Authentication: OAuth.
3. Check **I understand and want to continue**, select **Create as a plugin**, then **Connect** in the dialog.
4. Sign in to Aggregate and choose what ChatGPT can see: which companies, which kinds of data, read only or read and
   add, and when access expires.

In a ChatGPT Business or Enterprise workspace, an admin may need to allow custom MCP servers first.

## Five questions to try

1. *"What is our MRR, and how much came from new customers vs. churn last month?"* (uses `get_mrr_movements`)
2. *"Did every Stripe payout this month land in the bank?"* (uses `search_transactions`)
3. *"How much did we pay in Stripe fees this quarter?"* (uses `query_transactions`)
4. *"Who are our ten largest customers by revenue this year?"* (uses `query_transactions`)
5. *"Which invoices are past due?"* (uses `query_invoices`)

ChatGPT answers from Aggregate's ledger, where a payout and the bank deposit it becomes are matched, not added twice (a pair
it isn't sure of waits in Review for you), and balances are checked against the source. Each answer can be traced to the records
behind it.

## Questions people ask

**Does Aggregate see my password?** No. You sign in on Stripe's own sign-in page. Aggregate stores only the access token it gets back,
encrypted with a key kept outside the database.

**Does my data train AI models?** Aggregate never uses your data to train models and doesn't let anyone else. What
ChatGPT reads is covered by OpenAI's own data policy for your plan.

**Can ChatGPT move money or change my Stripe?** No. Aggregate has no tool that pays, transfers, pays a bill
or sends anything, and it only reads from Stripe. (Aggregate asks Stripe only for read permissions.) If you allow it, ChatGPT can add records
*inside Aggregate* (for example a cash expense), and those can be undone for 30 days.

**What does it cost?** The hosted version is free while we're in beta. We may introduce paid plans later, and we'll let you know before anything changes. Self-hosting is free (AGPL-3.0).

**Can I run it myself?** Yes. Aggregate is open source; see [self-hosting](../self-hosting.md). You'll need your own
Stripe restricted key with read permissions.

## Related

- [Connect your AI to Aggregate](../connect-your-ai.md): every assistant, plus bots and scripts
- [Connect Stripe to Claude](connect-stripe-to-claude.md)
- [Prompt recipes](../recipes.md)
- [How Aggregate compares](README.md#comparisons)

*Last checked 2026-11-03.*
