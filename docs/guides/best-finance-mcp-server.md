# Best finance MCP servers: an honest comparison

**Short answer:** it depends on what you need, and we make one of the options, so weigh this page accordingly. For one
tool where you want the AI to act, use that provider's own server (Stripe, Mercury, Brex, Ramp, Gusto, QuickBooks). For
personal budgets you already keep in an app, use that app's MCP. For questions that cross banks, payments, books and
payroll, read-only and in one ledger, Aggregate is built for that.

MCP (Model Context Protocol) is the standard way to connect an AI app to outside data. There are many finance servers
and no neutral ranking we know of, so this page sorts them by what they're for and gives its sources.

## At a glance

As of 2026-11-01.

| Server | Covers | Runs | Can it change things? | Cost |
|---|---|---|---|---|
| **Aggregate** (ours) | Banks, cards, payments, books, payroll, cap table, in one ledger | Hosted, or self-host (AGPL-3.0) | Never at your providers. Can add records inside Aggregate if you allow it | Free during beta; self-hosting is free |
| Stripe [1] | Your Stripe accounts | Hosted | Yes, including refunds. Sending money is in public preview. Some actions need a person to confirm | Check Stripe |
| Mercury [2] | Your Mercury accounts | Hosted, beta | Reads by default. Added scopes can create payment requests, which still need approval in Mercury | Check Mercury |
| Brex [3] | Your Brex expenses, cards, banking, bills and travel data | Hosted, beta | Depends on the tool and your access. Approvals and card management aren't available yet | Check Brex |
| Ramp [4] | Your Ramp cards, bills, expenses and travel | Hosted | Yes, including approving transactions and reimbursements | Check Ramp |
| Gusto [5] | Your Gusto payroll and HR | Hosted | Yes, including running payroll | Check Gusto |
| QuickBooks connector [6] | Your QuickBooks company | Hosted, US only | Yes, including creating invoices | Check Intuit |
| BankSync [7] | Bank and investment accounts | Hosted | Not stated on its pricing page | From $6 a month, billed yearly |
| Copilot Money [8] | Your Copilot Money budget data | Hosted, open to everyone since October 2026 | Read-only | Needs a Copilot Money account |
| personal-finance-mcp [9] | Personal accounts through your own Plaid keys | Self-hosted, community project | Read-only, per its listing | Free software; you bring Plaid access |

ChatGPT also has a built-in personal finance feature, which isn't an MCP server.
[Here's how it compares](aggregate-vs-chatgpt-finances.md).

## How to choose

**You want the AI to do things in one tool.** Use the provider's server. It knows that tool deeply, and Aggregate won't
create an invoice or issue a refund. Keep its confirmations on.

**You want one answer across several tools.** Each provider's server sees only its own data, so your AI has to add them
up, and it can count a Stripe payout twice: once at Stripe and again as a bank deposit. Aggregate matches those first. It
also connects Mercury, Brex and Ramp (in beta), so you can use their data there too.

**You only care about a personal budget.** If you already keep one in an app with an MCP, start there. Your categories
and budgets are already in it.

**You want to run everything yourself.** Aggregate and the community servers can both be self-hosted. Community projects
vary in upkeep, so check when one was last updated before you give it real accounts.

## Where Aggregate falls short

- It's early, and some connections are still in beta. [What Aggregate connects](../connectors.md) marks each one.
- It reads only. If you want your AI to act in a tool, you'll need that tool's own server too.
- Bank connections through Plaid are US only. Elsewhere it's Wise or statement files.
- It has no combined group report, and more limits are listed in [known limits](limits.md).

## Before you connect any finance server

- Check what it can change, and whether the AI can do that without asking you.
- Be careful mixing servers in one chat. Stripe warns about prompt injection when its server runs alongside others, and
  Gusto advises using its server on its own [1][5].
- Find out where your data goes and what your AI's plan does with it.

## Sources

Vendor pages, read 2026-11-01 unless noted. These products change often. If something here is out of date, tell us at
support@aggregate.finance and we'll fix it.

1. [Stripe docs: Model Context Protocol](https://docs.stripe.com/mcp)
2. [Mercury: What is Mercury MCP?](https://docs.mercury.com/docs/what-is-mercury-mcp) and
   [Connecting Mercury MCP](https://docs.mercury.com/docs/connecting-mercury-mcp)
3. [Brex MCP developer docs](https://developer.brex.com/docs/mcp)
4. [Ramp Help Center: Ramp MCP](https://support.ramp.com/hc/en-us/articles/45516494479891-Ramp-MCP)
5. [Gusto docs: MCP](https://docs.gusto.com/app-integrations/docs/mcp)
6. [QuickBooks: use the QuickBooks connector in Claude](https://quickbooks.intuit.com/learn-support/en-us/help-article/accounting-bookkeeping/use-quickbooks-connector-claude/L3YBlo6Ht_US_en_US)
7. [BankSync pricing](https://banksync.io/pricing)
8. [Copilot Money: MCP](https://www.copilot.money/mcp) and [Dispatch](https://www.copilot.money/dispatch)
9. [personal-finance-mcp on Glama](https://glama.ai/mcp/servers/JosueM1109/personal-finance-mcp), a directory listing

*Last checked 2026-11-01.*
