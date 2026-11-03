---
description: Connect Shopify to Claude through Aggregate. Ask about Shopify Payments sales, payouts and fees next to your bank data. Read-only.
---

# Connect Shopify to Claude

**Short answer:** connect Shopify to Aggregate, then add Aggregate to Claude with one link
(`https://app.aggregate.finance/mcp`). Claude can then answer questions about your Shopify Payments sales, refunds, fees and payouts (not order details), using one ledger that also holds your other
accounts and companies. Aggregate only reads from Shopify, it can never move money, and you
choose exactly what Claude can see.

**Status:** The Aggregate app is live on the [Shopify App Store](https://apps.shopify.com/aggregate) (approved 2026-10-22).

## Set it up

### 1. Connect Shopify to Aggregate
Install Aggregate from the [Shopify App Store](https://apps.shopify.com/aggregate). Shopify opens Aggregate; sign in with the email you use for the store (free during beta), confirm the workspace, and your payouts start syncing. Self-hosting? Open **Workspace → Connections → + More connections → Shopify Payments** and follow the steps there to use your own Shopify app instead.

### 2. Add Aggregate to Claude
1. In Claude (claude.ai or Claude Desktop), open **Customize → Connectors** (in some accounts still **Settings →
   Connectors**), choose **Add**, then **Add custom connector**.
2. Name it `Aggregate`, paste `https://app.aggregate.finance/mcp` and click **Continue**. Claude detects the sign-in; click **Add**, then **Connect**.
3. Sign in to Aggregate and choose what Claude can see: which companies, which kinds of data, read only or read and
   add, and when access expires.
4. In a new chat, turn on the Aggregate connector and ask a question.

Using Claude Code instead? Run `claude mcp add --transport http --scope user aggregate https://app.aggregate.finance/mcp`, then `/mcp` to sign in.

## Five questions to try

1. *"How much did the store take in last month after refunds and fees?"* (uses `query_transactions`)
2. *"Which Shopify payouts have not reached the bank yet?"* (uses `search_transactions`)
3. *"What is our profit and loss for the store this quarter?"* (uses `get_reports`)
4. *"How do this month's sales compare with last month?"* (uses `query_transactions`)
5. *"How much cash do we have across Shopify and the bank?"* (uses `get_overview`)

Claude answers from Aggregate's ledger, where a payout and the bank deposit it becomes are matched, not added twice (a pair
it isn't sure of waits in Review for you), and balances are checked against the source. Each answer can be traced to the records
behind it.

## Questions people ask

**Does Aggregate see my password?** No. You sign in on Shopify's own admin. Aggregate stores only the access token it gets back,
encrypted with a key kept outside the database.

**Does my data train AI models?** Aggregate never uses your data to train models and doesn't let anyone else. What
Claude reads is covered by Anthropic's own data policy for your plan.

**Can Claude move money or change my Shopify?** No. Aggregate has no tool that pays, transfers, pays a bill
or sends anything, and it only reads from Shopify. (Aggregate asks Shopify only for read access.) If you allow it, Claude can add records
*inside Aggregate* (for example a cash expense), and those can be undone for 30 days.

**What does it cost?** The hosted version is free while we're in beta. We may introduce paid plans later, and we'll let you know before anything changes. Self-hosting is free (AGPL-3.0).

**Can I run it myself?** Yes. Aggregate is open source; see [self-hosting](../self-hosting.md). You'll need your own
Shopify app or a custom app token for your store.

## Related

- [Connect your AI to Aggregate](../connect-your-ai.md): every assistant, plus bots and scripts
- [Connect Shopify to ChatGPT](connect-shopify-to-chatgpt.md)
- [Prompt recipes](../recipes.md)
- [How Aggregate compares](README.md#comparisons)

*Last checked 2026-11-03.*
