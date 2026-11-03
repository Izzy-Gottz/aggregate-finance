---
description: Upload CSV, OFX, QFX or PDF bank statements to Aggregate and ask ChatGPT about them. No bank connection needed. Read-only, and free during beta.
---

# Connect bank statements to ChatGPT

**Short answer:** connect bank statements (CSV, OFX or PDF) to Aggregate, then add Aggregate to ChatGPT with one link
(`https://app.aggregate.finance/mcp`). ChatGPT can then answer questions about your transactions and balances from statement files you upload, plus PDFs and photos of receipts and bills, using one ledger that also holds your other
accounts and companies. Aggregate only reads from your files, it can never move money, and you
choose exactly what ChatGPT can see.

**Status:** Live on the hosted version and when self-hosted. No bank connection needed.

## Set it up

### 1. Connect bank statements (CSV, OFX or PDF) to Aggregate
Sign up at [app.aggregate.finance](https://app.aggregate.finance) (free during beta). Open **Workspace → Add anything → Upload a file**, choose the company, and upload CSV, OFX, QFX, QBO or camt.053 files. PDF statements in 11 known bank layouts import automatically when their rows reconcile to the opening and closing balances; any other PDF, and photos, are kept as documents your AI can read and record. See [Known limits](limits.md).

### 2. Add Aggregate to ChatGPT
1. Open [ChatGPT Plugins](https://chatgpt.com/plugins), choose **Add** (top right), then **Add custom MCP server**.
2. Name it `Aggregate`. Under **Connection**, keep **Server URL** and paste `https://app.aggregate.finance/mcp`. Authentication: OAuth.
3. Check **I understand and want to continue**, select **Create as a plugin**, then **Connect** in the dialog.
4. Sign in to Aggregate and choose what ChatGPT can see: which companies, which kinds of data, read only or read and
   add, and when access expires.

In a ChatGPT Business or Enterprise workspace, an admin may need to allow custom MCP servers first.

## Five questions to try

1. *"How much did I spend each month this year, by category?"* (uses `query_transactions`)
2. *"Which months of each account are missing statements, or don't add up?"* (uses `get_coverage`)
3. *"Which accounts haven't been updated in the last month?"* (uses `list_accounts`)
4. *"Read the receipts I uploaded and tell me which ones aren't recorded yet."* (uses `list_documents`)
5. *"Who were the five payees I spent the most with last quarter?"* (uses `query_transactions`)

ChatGPT answers from Aggregate's ledger, where a payout and the bank deposit it becomes are matched, not added twice (a pair
it isn't sure of waits in Review for you), and balances are checked against the source. Each answer can be traced to the records
behind it.

## Questions people ask

**Does Aggregate see my password?** No. There's nothing to sign in to: you upload files you already have.

**Does my data train AI models?** Aggregate never uses your data to train models and doesn't let anyone else. What
ChatGPT reads is covered by OpenAI's own data policy for your plan.

**Can ChatGPT move money or change my files?** No. Aggregate has no tool that pays, transfers, pays a bill
or sends anything, and it only reads from files. If you allow it, ChatGPT can add records
*inside Aggregate* (for example a cash expense), and those can be undone for 30 days.

**What does it cost?** The hosted version is free while we're in beta. We may introduce paid plans later, and we'll let you know before anything changes. Self-hosting is free (AGPL-3.0).

**Can I run it myself?** Yes. Aggregate is open source; see [self-hosting](../self-hosting.md). You'll need your own
statement files.

## Related

- [Connect your AI to Aggregate](../connect-your-ai.md): every assistant, plus bots and scripts
- [Connect bank statements to Claude](connect-bank-statements-to-claude.md)
- [Prompt recipes](../recipes.md)
- [How Aggregate compares](README.md#comparisons)

*Last checked 2026-11-03.*
