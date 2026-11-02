---
description: Connect Deel to Claude through Aggregate with an organization token. Ask about payroll and contractor payments next to your other accounts. Read-only.
---

# Connect Deel to Claude

**Short answer:** connect Deel to Aggregate, then add Aggregate to Claude with one link
(`https://app.aggregate.finance/mcp`). Claude can then answer questions about your what you pay Deel for contractors and EOR employees, split into worker cost and Deel fees, using one ledger that also holds your other
accounts and companies. Aggregate only reads from Deel, it can never move money, and you
choose exactly what Claude can see.

**Status:** Live on the hosted version. You connect with a Deel organization token (scope accounting:read), not a sign-in window.

## Set it up

### 1. Connect Deel to Aggregate
Sign up at [app.aggregate.finance](https://app.aggregate.finance) (free during beta). In Deel, create an organization token with the `accounting:read` scope ([Deel's guide](https://developer.deel.com/docs/api-tokens-1)). Then open **Workspace → Connections → + More connections → Deel** and paste it.

### 2. Add Aggregate to Claude
1. In Claude (claude.ai or Claude Desktop), open **Customize → Connectors** (in some accounts still **Settings →
   Connectors**), choose **Add**, then **Add custom connector**.
2. Name it `Aggregate`, paste `https://app.aggregate.finance/mcp` and click **Continue**. Claude detects the sign-in; click **Add**, then **Connect**.
3. Sign in to Aggregate and choose what Claude can see: which companies, which kinds of data, read only or read and
   add, and when access expires.
4. In a new chat, turn on the Aggregate connector and ask a question.

Using Claude Code instead? Run `claude mcp add --transport http --scope user aggregate https://app.aggregate.finance/mcp`, then `/mcp` to sign in.

## Five questions to try

1. *"How much did we spend on contractors through Deel last quarter?"* (uses `get_payroll`)
2. *"How much did we pay Deel in fees this year?"* (uses `query_transactions`)
3. *"When is the next payroll, and roughly how much will it be?"* (uses `list_upcoming`)
4. *"How did payroll cost change compared with last month?"* (uses `get_payroll`)
5. *"How many months of runway do we have at the current payroll?"* (uses `get_metric`)

Claude answers from Aggregate's ledger, where every payment is counted once (a payout and the bank deposit it becomes are
matched, not added twice) and balances are checked against the source. Each answer can be traced to the records
behind it.

## Questions people ask

**Does Aggregate see my password?** No. You sign in on Deel itself (you create the token there and paste only the token). Aggregate stores only the access token it gets back,
encrypted with a key kept outside the database.

**Does my data train AI models?** Aggregate never uses your data to train models and doesn't let anyone else. What
Claude reads is covered by Anthropic's own data policy for your plan.

**Can Claude move money or change my Deel?** No. Aggregate has no tool that pays, transfers, pays a bill
or sends anything, and it only reads from Deel. (The token has the read-only accounting scope.) If you allow it, Claude can add records
*inside Aggregate* (for example a cash expense), and those can be undone for 30 days.

**What does it cost?** The hosted version is free while we're in beta. We may introduce paid plans later, and we'll let you know before anything changes. Self-hosting is free (AGPL-3.0).

**Can I run it myself?** Yes. Aggregate is open source; see [self-hosting](../self-hosting.md). You'll need your own
Deel organization token.

## Related

- [Connect your AI to Aggregate](../connect-your-ai.md): every assistant, plus bots and scripts
- [Prompt recipes](../recipes.md)
- [How Aggregate compares](README.md#comparisons)

*Last checked 2026-10-12.*
