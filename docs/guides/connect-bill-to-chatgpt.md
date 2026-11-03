---
description: Connect BILL (Bill.com) to ChatGPT through Aggregate with a sync token. Ask about bills due and invoices owed next to your bank data. Read requests only.
---

# Connect BILL to ChatGPT

**Short answer:** connect BILL to Aggregate, then add Aggregate to ChatGPT with one link
(`https://app.aggregate.finance/mcp`). ChatGPT can then answer questions about the bills you owe, the invoices you've sent, and the payments made and received against them, using one ledger that also holds your other
accounts and companies. Aggregate only reads from BILL, it can never move money, and you
choose exactly what ChatGPT can see.

**Status:** Live on the hosted version. You connect with a BILL sync token you make in your own BILL account, not a sign-in window.

## Set it up

### 1. Connect BILL to Aggregate
Sign up at [app.aggregate.finance](https://app.aggregate.finance) (free during beta). In BILL, open **Settings → Sync &
Integrations → Tokens**, choose **New**, give the token a name (for example `aggregate`) and save. Then in Aggregate open
**Workspace → Connections → + More connections → BILL** and paste the sync token's name, the sync token, and your BILL
organization ID.

### 2. Add Aggregate to ChatGPT
1. Open [ChatGPT Plugins](https://chatgpt.com/plugins), choose **Add** (top right), then **Add custom MCP server**.
2. Name it `Aggregate`. Under **Connection**, keep **Server URL** and paste `https://app.aggregate.finance/mcp`. Authentication: OAuth.
3. Check **I understand and want to continue**, select **Create as a plugin**, then **Connect** in the dialog.
4. Sign in to Aggregate and choose what ChatGPT can see: which companies, which kinds of data, read only or read and
   add, and when access expires.

In a ChatGPT Business or Enterprise workspace, an admin may need to allow custom MCP servers first.

## Five questions to try

1. *"What bills are due in the next 14 days?"* (uses `list_upcoming`)
2. *"Who owes us the most, and how overdue is it?"* (uses `query_invoices`)
3. *"How much do we owe vendors right now, grouped by how overdue it is?"* (uses `query_invoices`)
4. *"Which unpaid invoices are over $1,000?"* (uses `search_invoices`)
5. *"How fast does Acme Corp usually pay us?"* (uses `get_counterparty`)

ChatGPT answers from Aggregate's ledger, where a payout and the bank deposit it becomes are matched, not added twice (a pair
it isn't sure of waits in Review for you), and balances are checked against the source. Each answer can be traced to the records
behind it.

## Questions people ask

**Does Aggregate see my password?** No. You never give Aggregate your BILL password: you paste a sync token you made in
BILL, and you can archive it there at any time. Aggregate stores the token encrypted with a key kept outside the
database.

**Does my data train AI models?** Aggregate never uses your data to train models and doesn't let anyone else. What
ChatGPT reads is covered by OpenAI's own data policy for your plan.

**Can ChatGPT move money or change my BILL?** No. Aggregate has no tool that pays, transfers, pays a bill
or sends anything, and it only reads from BILL. (BILL offers no read-only token: a sync token can edit records in your BILL account, but can't pay anyone or move money. Aggregate's BILL connector only makes read requests after signing in.) If you allow it, ChatGPT can add records
*inside Aggregate* (for example a cash expense), and those can be undone for 30 days.

**What does it cost?** The hosted version is free while we're in beta. We may introduce paid plans later, and we'll let you know before anything changes. Self-hosting is free (AGPL-3.0).

**Can I run it myself?** Yes. Aggregate is open source; see [self-hosting](../self-hosting.md). You'll need your own
BILL developer key and a BILL user login.

## Related

- [Connect your AI to Aggregate](../connect-your-ai.md): every assistant, plus bots and scripts
- [Connect BILL to Claude](connect-bill-to-claude.md)
- [Prompt recipes](../recipes.md)
- [How Aggregate compares](README.md#comparisons)

*Last checked 2026-11-03.*
