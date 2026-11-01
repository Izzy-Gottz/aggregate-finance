# Connect bank accounts and cards to Claude

**Short answer:** connect your bank accounts and cards to Aggregate, then add Aggregate to Claude with one link
(`https://app.aggregate.finance/mcp`). Claude can then answer questions about your balances and transactions from checking, savings and credit card accounts, using one ledger that also holds your other
accounts and companies. Aggregate only reads from your bank, it can never move money, and you
choose exactly what Claude can see.

**Status:** Bank connections on the hosted version go through Plaid. You can also upload statement files (CSV, OFX, QFX or QBO, or PDF statements: 11 known bank layouts import automatically when they reconcile, and any other PDF is kept for your AI to read) or connect through SimpleFIN Bridge, a separate paid service that links most US banks.

## Set it up

### 1. Connect your bank accounts and cards to Aggregate
Sign up at [app.aggregate.finance](https://app.aggregate.finance) (free during beta). Open **Workspace → Connections → + More connections**, choose your bank, and sign in to it in Plaid's window. Before connecting any account, Aggregate checks it's you with a passkey or a code sent to your email.

### 2. Add Aggregate to Claude
1. In Claude (claude.ai or Claude Desktop), open **Customize → Connectors** (in some accounts still **Settings →
   Connectors**), choose **Add**, then **Add custom connector**.
2. Name it `Aggregate`, paste `https://app.aggregate.finance/mcp` and click **Continue**. Claude detects the sign-in; click **Add**, then **Connect**.
3. Sign in to Aggregate and choose what Claude can see: which companies, which kinds of data, read only or read and
   add, and when access expires.
4. In a new chat, turn on the Aggregate connector and ask a question.

Using Claude Code instead? Run `claude mcp add --transport http --scope user aggregate https://app.aggregate.finance/mcp`, then `/mcp` to sign in.

## Five questions to try

1. *"How much cash do I have across all my accounts right now?"* (uses `get_overview`)
2. *"What did I spend on restaurants in the last three months?"* (uses `query_transactions`)
3. *"Which subscriptions am I paying for, and did any price go up?"* (uses `list_recurring`)
4. *"When are my credit card payments due, and what are the minimums?"* (uses `get_liabilities`)
5. *"What money is coming in and going out over the next 30 days?"* (uses `list_upcoming`)

Claude answers from Aggregate's ledger, where every payment is counted once (a payout and the bank deposit it becomes are
matched, not added twice) and balances are checked against the source. Each answer can be traced to the records
behind it.

## Questions people ask

**Does Aggregate see my password?** No. You sign in on your bank's own page, inside Plaid's window. Aggregate stores only the access token it gets back,
encrypted with a key kept outside the database.

**Does my data train AI models?** Aggregate never uses your data to train models and doesn't let anyone else. What
Claude reads is covered by Anthropic's own data policy for your plan.

**Can Claude move money or change my bank accounts?** No. Aggregate has no tool that pays, transfers, pays a bill
or sends anything, and it only reads from bank accounts. (Bank connections are read-only.) If you allow it, Claude can add records
*inside Aggregate* (for example a cash expense), and those can be undone for 30 days.

**What does it cost?** The hosted version is free while we're in beta. We may introduce paid plans later, and we'll let you know before anything changes. Self-hosting is free (AGPL-3.0).

**Can I run it myself?** Yes. Aggregate is open source; see [self-hosting](../self-hosting.md). You'll need your own
Plaid account, a SimpleFIN Bridge token, or statement files.

## Related

- [Connect your AI to Aggregate](../connect-your-ai.md): every assistant, plus bots and scripts
- [Prompt recipes](../recipes.md)
- [How Aggregate compares](README.md#comparisons)

*Last checked 2026-10-12.*
