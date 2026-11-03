---
description: Connect your bank accounts and cards to ChatGPT through Aggregate, read-only, with one link. Ask about balances, spending and cash. It can't move money.
---

# Connect bank accounts and cards to ChatGPT

**Short answer:** connect your bank accounts and cards to Aggregate, then add Aggregate to ChatGPT with one link
(`https://app.aggregate.finance/mcp`). ChatGPT can then answer questions about your balances and transactions from checking, savings and credit card accounts, using one ledger that also holds your other
accounts and companies. Aggregate only reads from your bank, it can never move money, and you
choose exactly what ChatGPT can see.

**Status:** Bank connections on the hosted version go through Plaid. You can also upload statement files (CSV, OFX, QFX or QBO, or PDF statements: 11 known bank layouts import automatically when they reconcile, and any other PDF is kept for your AI to read) or connect through SimpleFIN Bridge, a separate paid service that links many US banks.

Mortgages, student, auto and personal loans, and card APRs and due dates come through Plaid too. If you linked a bank earlier and don't see these, disconnect it, then connect it again.

## Set it up

### 1. Connect your bank accounts and cards to Aggregate
Sign up at [app.aggregate.finance](https://app.aggregate.finance) (free during beta). Open **Workspace → Connections → + More connections**, choose your bank, and sign in to it in Plaid's window. Before connecting any account, Aggregate checks it's you with a passkey or a code sent to your email.

### 2. Add Aggregate to ChatGPT
1. Open [ChatGPT Plugins](https://chatgpt.com/plugins), choose **Add** (top right), then **Add custom MCP server**.
2. Name it `Aggregate`. Under **Connection**, keep **Server URL** and paste `https://app.aggregate.finance/mcp`. Authentication: OAuth.
3. Check **I understand and want to continue**, select **Create as a plugin**, then **Connect** in the dialog.
4. Sign in to Aggregate and choose what ChatGPT can see: which companies, which kinds of data, read only or read and
   add, and when access expires.

In a ChatGPT Business or Enterprise workspace, an admin may need to allow custom MCP servers first.

## Five questions to try

1. *"How much cash do I have across all my accounts right now?"* (uses `get_overview`)
2. *"What did I spend on restaurants in the last three months?"* (uses `query_transactions`)
3. *"Which subscriptions am I paying for, and did any price go up?"* (uses `list_recurring`)
4. *"When are my credit card payments due, and what are the minimums?"* (uses `get_liabilities`)
5. *"What money is coming in and going out over the next 30 days?"* (uses `list_upcoming`)

ChatGPT answers from Aggregate's ledger, where a payout and the bank deposit it becomes are matched, not added twice (a pair
it isn't sure of waits in Review for you), and balances are checked against the source. Each answer can be traced to the records
behind it.

## Questions people ask

**Does Aggregate see my password?** No. You sign in on your bank's own page, inside Plaid's window. Aggregate stores only the access token it gets back,
encrypted with a key kept outside the database.

**Does my data train AI models?** Aggregate never uses your data to train models and doesn't let anyone else. What
ChatGPT reads is covered by OpenAI's own data policy for your plan.

**Can ChatGPT move money or change my bank accounts?** No. Aggregate has no tool that pays, transfers, pays a bill
or sends anything, and it only reads from bank accounts. (Bank connections are read-only.) If you allow it, ChatGPT can add records
*inside Aggregate* (for example a cash expense), and those can be undone for 30 days.

**What does it cost?** The hosted version is free while we're in beta. We may introduce paid plans later, and we'll let you know before anything changes. Self-hosting is free (AGPL-3.0).

**Can I run it myself?** Yes. Aggregate is open source; see [self-hosting](../self-hosting.md). You'll need your own
Plaid account, a SimpleFIN Bridge token, or statement files.

## Related

- [Connect your AI to Aggregate](../connect-your-ai.md): every assistant, plus bots and scripts
- [Connect bank accounts and cards to Claude](connect-bank-accounts-to-claude.md)
- [Prompt recipes](../recipes.md)
- [How Aggregate compares](README.md#comparisons)

*Last checked 2026-11-03.*
