# Aggregate vs. a provider's own MCP server (QuickBooks, Stripe)

**Short answer:** a provider's own MCP server gives your AI deep access to that one provider, including the power to
change things there. Aggregate gives your AI read access to all your sources at once (banks, payments, accounting,
payroll, cap table) in one ledger where nothing is counted twice, and it can never move money. Many people will want
both: the provider's server to *do* things in that tool, Aggregate to *answer* questions across everything.

| | Aggregate | QuickBooks Online MCP server (Intuit's GitHub) | Stripe MCP server |
|---|---|---|---|
| Sources | Banks, cards, Stripe, Square, Shopify, QuickBooks, Xero, payroll, cap table, statements | One QuickBooks company | Your Stripe account(s) |
| Where it runs | Hosted (`app.aggregate.finance/mcp`) or self-hosted | Locally, on your own machine (stdio) [1] | Hosted at `mcp.stripe.com` [2] |
| Can change data at the provider | No. Reads only | Yes: create, update and delete tools; each can be switched off with environment flags [1] | Yes: `stripe_api_write` covers create, update and delete calls, including refunds; Stripe asks a person to confirm some actions, such as refunds and outbound payments [2] |
| Can move money | Never | n/a | Refunds, plus Treasury tools such as `send_money` in private preview [2] |
| Several companies side by side | Yes, plus a private Personal space | One company at a time [1] | Several Stripe accounts can be granted in one OAuth session [2] |
| Payouts matched to bank deposits | Yes | No bank data | No bank data |
| Depth inside that one provider | What the sync reads | ~145 tools across 29 entity types and 11 reports [1] | Most of the Stripe API through `stripe_api_read` / `stripe_api_write` [2] |
| Open source | Yes (AGPL-3.0) | Yes (the repository shows both MIT and Apache-2.0 notices) [1] | The server is hosted by Stripe |

## When the provider's server is the better choice

- You want your AI to **act** in that tool: create an invoice in QuickBooks, issue a refund in Stripe, edit a customer.
- You only use that one provider and want every field it has.
- You're building on Stripe and want its documentation search and implementation tools.

## When Aggregate is the better choice

- Your money lives in more than one place, or more than one company, and you want one answer, not five.
- You want numbers that reconcile: a Stripe payout and the bank deposit it becomes are one event in Aggregate, not
  two, and unknown values never show up as zero.
- You want an AI connection that **cannot** change anything at your bank or provider, with a permission you can read
  as one sentence and a log of every question it asks.

## Using both

You can add Aggregate and a provider's server to the same assistant. Give the provider's server only the permissions
you'd give a person, and keep its write confirmations on.

## Sources

1. [intuit/quickbooks-online-mcp-server on GitHub](https://github.com/intuit/quickbooks-online-mcp-server), read 2026-10-12.
2. [Stripe docs: Model Context Protocol](https://docs.stripe.com/mcp), read 2026-10-12.

*Last checked 2026-10-12. Spotted something out of date? Open an issue.*
