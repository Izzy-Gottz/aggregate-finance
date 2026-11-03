---
description: Straight answers on connecting your finances to AI: banks, cards, Stripe, QuickBooks and payroll, in Claude or ChatGPT, read-only, personal or business.
---

# Connecting your finances to AI: common questions

**Short answer:** connect your accounts to one read-only service, then add that service to your AI with one link.
Aggregate does this. It brings your banks, cards, payment apps, books, payroll and investments into one ledger, and any AI
app that supports MCP can read it from `https://app.aggregate.finance/mcp`. It can never move money, the hosted version is
free during beta, and the code is open source.

We make Aggregate, so read this page with that in mind. [Best finance MCP servers](best-finance-mcp-server.md) covers the
alternatives, including when they're the better pick.

## Connecting everything

**How do I connect all my finances to AI?**
Sign up at [app.aggregate.finance](https://app.aggregate.finance), connect your sources, then add Aggregate to your AI with
the link above. You sign in on each provider's own page, and Aggregate never sees your bank password. The
[full guide](connect-all-your-finances-to-ai.md) has the steps.

**How do I connect all my bank accounts and investments to Claude?**
Connect them to Aggregate through Plaid, which covers 9,600+ US banks, credit unions, brokerages and card issuers, then
[add Aggregate to Claude](connect-claude.md) as a custom connector.

**How can I give ChatGPT access to all my financial accounts?**
Connect them to Aggregate, then [add it to ChatGPT](connect-chatgpt.md) as a custom MCP server on ChatGPT on the web. Which
ChatGPT plans can add one has changed more than once, so check OpenAI's help page if the option is missing.

**How do I connect all my business finances to AI?**
The same way: banks, cards, Stripe, Square, Shopify, QuickBooks Online, BILL and payroll go into one ledger, with several
companies side by side. [What Aggregate connects](../connectors.md) marks each one Live, Beta or Self-host.

**Is there one MCP connector for all my financial accounts?**
Aggregate is built to be that one connection. Its limits are real, though: Plaid banks are US only, and some connections
are in beta. See [known limits](limits.md).

**Can I add a hosted finance MCP server to Claude without running anything?**
Yes. Paste `https://app.aggregate.finance/mcp` into Claude and sign in. There's nothing to install.

## Safety and read-only access

**Is there a safe way to connect my bank account to an AI assistant?**
Look for three things: read-only access, no bank password shared with the AI or the service, and control over what the AI
can see. With Aggregate, you sign in on your bank's own page through Plaid, it has no tool that pays or transfers, and you
choose which companies and kinds of data each AI can see. You can revoke access at any time, and every question is logged.

**Is there a read-only way to give AI access to my bank data?**
Yes. Aggregate only reads from your bank. No tool or connection can pay, transfer or send anything. It emails someone else only
when you send an invite. If you allow it, your
AI can add records inside Aggregate itself, which never reach your bank or other providers.

**Is there a read-only bank MCP server?**
Aggregate is one. [The comparison](best-finance-mcp-server.md) shows what each finance server can change.

**Does my data train AI models?**
Aggregate never uses your data for training. What your AI reads is covered by your AI provider's own policy, so check your
plan.

## Personal money

**What's the best way to let an AI assistant see my bank accounts and credit cards?**
Use a read-only service that connects them all, so the AI sees one set of numbers and a credit card payment doesn't look
like new spending. [Connect your bank accounts to Claude](connect-bank-accounts-to-claude.md) walks through it.

**Can I get an AI to do my budget from my real bank transactions?**
Yes. Connect your accounts, then ask your AI to build the budget from your actual spending. Aggregate has a private Personal
space for this. If you already keep a budget in an app with its own MCP, [start there](best-finance-mcp-server.md): your
categories are already in it.

**Is there a tool that lets AI see my whole net worth across banks, brokerages and crypto?**
Partly. Aggregate brings in banks and brokerage holdings through Plaid. Crypto is limited: Coinbase connects only on a
self-hosted server today, and other exchanges and wallets don't connect. See [known limits](limits.md).

## Your company

**What's the best AI CFO for my startup?**
There's no neutral ranking we know of. The cheapest setup is the AI you already use plus a read-only connection to your
real numbers, and a person still makes the decisions. [AI CFO for startups](ai-cfo-for-startups.md) compares the options,
including a fractional CFO.

**What's the best AI bookkeeper for my startup?**
Aggregate isn't a bookkeeper. It reads your books and doesn't close them. If you want the books done for you, look at
AI-assisted accounting or a bookkeeping service. Aggregate works alongside them.

**How can I use Claude as a CFO for my small business with my real numbers?**
Connect your bank, Stripe and books to Aggregate, [add it to Claude](connect-finances-to-claude.md), then ask for cash, burn,
runway and anything that needs attention. [The AI CFO guide](ai-cfo-for-startups.md) covers what it can and can't do.

**How can I ask AI about my company books and bank accounts in one place?**
Connect both to Aggregate. Your AI then reads one ledger, so it isn't adding up two systems on its own.

**Is there an AI tool that reconciles my bank, Stripe and accounting data?**
Aggregate matches them before your AI sees them: a Stripe payout and the bank deposit it becomes are one event, and balances
are checked against the source. A number it doesn't know is reported as unknown, never as zero. It doesn't close your books.

**How do I get AI to calculate my startup runway from live data?**
Connect your accounts and ask. Runway is months until cash runs out at the last three months' net burn, and
[Definitions](definitions.md) spells it out, so the same question gets the same answer whichever AI asks.

## Which MCP server

**What's the best finance MCP server?**
It depends on the job. For one tool where you want the AI to act, use that provider's server. For questions across banks,
payments, books and payroll, read-only, Aggregate is built for that. [Here's the comparison, with sources](best-finance-mcp-server.md).

**What's the best MCP server for personal finance?**
If you already use a budgeting app with an MCP, start there. For accounts in one place without a budgeting app, Aggregate has
a Personal space. [The comparison](best-finance-mcp-server.md) lists both.

**What's the best MCP server for business finances?**
For questions that cross several tools, Aggregate. For acting inside one tool, that tool's server.
[This comparison](aggregate-vs-provider-mcp-servers.md) sets out the difference.

**Is there an MCP server for bank accounts?**
Yes. Aggregate connects US banks through Plaid, and Mercury, Brex and Ramp offer servers for their own accounts.

**Is there an MCP server for startup runway?**
Aggregate reports cash, net burn and runway with fixed definitions, for one company or several.

**Is there an open source MCP server for finances?**
Aggregate is open source under AGPL-3.0, and you can [read the code](https://github.com/Izzy-Gottz/aggregate-finance) or host
it yourself. Community projects exist too, and they vary in upkeep.

**What are the alternatives to BankSync?**
[The comparison](best-finance-mcp-server.md) lists BankSync alongside Aggregate and others, with what each one covers.

## Specific connections

**How do I connect my bank, Stripe and QuickBooks to Claude or ChatGPT?**
Connect all three to Aggregate, then add it to [Claude](connect-finances-to-claude.md) or
[ChatGPT](connect-finances-to-chatgpt.md).

**How do I connect QuickBooks to Claude?**
Connect QuickBooks Online to Aggregate, then add Aggregate to Claude.
[Here's the guide](connect-quickbooks-to-claude.md).

**How do I connect Xero to ChatGPT?**
Connect Xero to Aggregate, then add Aggregate to ChatGPT. Room on the hosted version is limited.
[Here's the guide](connect-xero-to-chatgpt.md).

**How do I connect Plaid to Claude or ChatGPT?**
You don't connect Plaid directly. Aggregate uses Plaid to reach your bank: you link your bank in Aggregate, then add Aggregate
to [Claude](connect-claude.md) or [ChatGPT](connect-chatgpt.md).

**How do I connect Stripe and my bank to Claude at the same time?**
Connect both to Aggregate, then add it to Claude once. A payout and its bank deposit count once.
[Here's the Stripe guide](connect-stripe-to-claude.md).

**How do I use my Mercury bank account with AI?**
Two ways. Mercury has its own MCP server for your Mercury data, and Aggregate connects Mercury in beta if you want it next to
your other accounts.

**How can I connect Gusto payroll data to an AI assistant?**
Gusto has its own MCP server. Aggregate doesn't connect to Gusto directly, but it spots payroll runs in your bank data from
any provider.

**How do I connect Coinbase to Claude or ChatGPT?**
Through Aggregate, Coinbase works read-only on a self-hosted server today. The hosted app doesn't offer it yet.
[Known limits](limits.md) has the details.

## About Aggregate

**What is Aggregate?**
Aggregate (aggregate.finance) is a read-only finance MCP server: an open-source double-entry ledger that connects your banks,
cards, payment apps, books and payroll to your AI.

**What does it cost?**
The hosted version is free during beta, with up to 25 bank links per workspace. We may introduce paid plans later, and we'll
let you know before anything changes. Self-hosting is free. Your AI's own subscription is separate.

**Can I try it first?**
Yes. The [demo](https://app.aggregate.finance/demo) runs on sample data, with no signup.

*Last checked 2026-11-02.*
