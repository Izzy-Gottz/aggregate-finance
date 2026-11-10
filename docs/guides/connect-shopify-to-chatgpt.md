---
description: Connect Shopify to ChatGPT through Aggregate. Ask about Shopify Payments sales, payouts and fees next to your bank data. Read-only.
---

# Connect Shopify to ChatGPT

**Short answer:** connect Shopify to Aggregate, then add Aggregate to ChatGPT with one link
(`https://app.aggregate.finance/mcp`). ChatGPT can then answer questions about your Shopify Payments sales, refunds, fees and payouts (not order details), using one ledger that also holds your other
accounts and companies. Aggregate only reads from Shopify, it can never move money, and you
choose exactly what ChatGPT can see.

**Status:** The Aggregate app is live on the [Shopify App Store](https://apps.shopify.com/aggregate) (approved 2026-10-22).

## Set it up

### 1. Connect Shopify to Aggregate
Install Aggregate from the [Shopify App Store](https://apps.shopify.com/aggregate). Shopify opens Aggregate; sign in with the email you use for the store (free during beta), confirm the workspace, and your payouts start syncing. Self-hosting? Open **Workspace → Connections → + Add a connection → Shopify Payments** and follow the steps there to use your own Shopify app instead.

### 2. Add Aggregate to ChatGPT
1. Open [ChatGPT Plugins](https://chatgpt.com/plugins), choose **Add** (top right), then **Add custom MCP server**.
2. Name it `Aggregate`. Under **Connection**, keep **Server URL** and paste `https://app.aggregate.finance/mcp`. Authentication: OAuth.
3. Check **I understand and want to continue**, select **Create as a plugin**, then **Connect** in the dialog.
4. Sign in to Aggregate and choose what ChatGPT can see: which companies, which kinds of data, read only or read and
   add, and when access expires.

In a ChatGPT Business or Enterprise workspace, an admin may need to allow custom MCP servers first.

## Five questions to try

1. *"How much did the store take in last month after refunds and fees?"* (uses `query_transactions`)
2. *"Which Shopify payouts have not reached the bank yet?"* (uses `search_transactions`)
3. *"What is our profit and loss for the store this quarter?"* (uses `get_reports`)
4. *"How do this month's sales compare with last month?"* (uses `query_transactions`)
5. *"How much cash do we have across Shopify and the bank?"* (uses `get_overview`)

ChatGPT answers from Aggregate's ledger, where a payout and the bank deposit it becomes are matched, not added twice (a pair
it isn't sure of waits in Review for you), and balances are checked against the source. Each answer can be traced to the records
behind it.

## Questions people ask

**Does Aggregate see my password?** No. You sign in on Shopify's own admin. Aggregate stores only the access token it gets back,
encrypted with a key kept outside the database.

**Does my data train AI models?** Aggregate never uses your data to train models and doesn't let anyone else. What
ChatGPT reads is covered by OpenAI's own data policy for your plan.

**Can ChatGPT move money or change my Shopify?** No. Aggregate has no tool that pays, transfers, pays a bill
or sends anything, and it only reads from Shopify. (Aggregate asks Shopify only for read access.) If you allow it, ChatGPT can add records
*inside Aggregate* (for example a cash expense), and those can be undone for 30 days.

**What does it cost?** The hosted version is free while we're in beta. We may introduce paid plans later, and we'll let you know before anything changes. Self-hosting is free (AGPL-3.0).

**Can I run it myself?** Yes. Aggregate is open source; see [self-hosting](../self-hosting.md). You'll need your own
Shopify app or a custom app token for your store.

## Related

- [Connect your AI to Aggregate](../connect-your-ai.md): every assistant, plus bots and scripts
- [Connect Shopify to Claude](connect-shopify-to-claude.md)
- [Prompt recipes](../recipes.md)
- [How Aggregate compares](README.md#comparisons)

*Last checked 2026-10-12.*
