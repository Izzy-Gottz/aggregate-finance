---
description: What an AI CFO can do for a startup today: cash, burn, runway and investor updates from real numbers, what still needs a person, and your options.
---

# AI CFO for startups: what works today

**Short answer:** an AI can do a useful share of a startup CFO's reporting today if it's working from reconciled numbers:
cash, burn, runway, MRR, who owes you, and what's due. It can't replace judgment on fundraising or sign anything, and an
AI working from a pasted spreadsheet will make arithmetic mistakes. The cheapest setup is the AI you already use plus a
read-only connection to your banks, Stripe, books and payroll, which is what Aggregate provides, free during beta.

We make Aggregate, so read this page with that in mind. It isn't a CFO, and neither is the AI you connect to it.

## What an AI can do well

With your real numbers connected, it can:

- Report cash, net burn and runway on demand, for one company or several.
- Run a what-if: *"How many months of runway if we hire two engineers at $15,000 a month starting in March?"*
- Explain a change: *"Why was September's spending higher than August's?"*
- Find waste: subscriptions nobody uses, or a vendor whose price went up.
- Draft a monthly investor update from the actual figures.
- Flag what's due and what's late: bills, overdue invoices, payouts that never reached the bank.

## What still needs a person

- Decisions on fundraising, pricing and hiring. An AI can lay out the numbers, and you make the call.
- Tax filings, audits and anything you have to sign.
- Your books. Aggregate reads them and doesn't close them for you; a bookkeeper or accountant still owns them.
- Projections. Aggregate supplies the baseline, and a what-if on top is your AI's arithmetic. Ask it to show its working.

## Your options

| Option | Good for | Watch out for |
|---|---|---|
| Your AI plus Aggregate | Founders who want answers from real numbers in Claude or ChatGPT, across banks, Stripe, books and payroll | Early product. It reads only: no bookkeeping, no payments. See [known limits](limits.md) |
| Your AI plus each provider's own connection | One main tool, or when you want the AI to act inside it | Each one sees only its own data, and some can change things. See [this comparison](aggregate-vs-provider-mcp-servers.md) |
| AI-assisted accounting or a bookkeeping service | Companies that want the books done for them | You're choosing an accounting provider, which is a bigger switch. Prices vary, so check each vendor |
| Planning software | Teams that build detailed forecasts and board models | More setup, and usually a paid plan from the start |
| Fractional CFO | Fundraising, board work, and judgment calls | Costs more than software, and it works well alongside any of the above |

## Set it up

1. Try the [demo](https://app.aggregate.finance/demo) on sample data. No signup.
2. [Sign up](https://app.aggregate.finance) and connect your bank, Stripe and books.
3. Add Aggregate to [Claude](connect-claude.md) or [ChatGPT](connect-chatgpt.md).
4. Ask: *"Give me a one-page summary of our cash, burn, runway and anything that needs attention."*

The [prompt recipes](../recipes.md) cover runway with a hiring plan, spending changes, zombie subscriptions and more.

## How the numbers are counted

Cash, burn, runway and MRR have fixed definitions, so the same question gets the same answer whichever AI asks. Runway is
months until cash runs out at the last three months' net burn. [Definitions](definitions.md) spells out each one.

## Questions people ask

**Can the AI move money?** Not through Aggregate. It has no tool that pays, transfers or sends anything.

**Will my investors see this?** Only if you share it. You choose what each AI can see, and you can revoke access at any
time.

**What does it cost?** Aggregate's hosted version is free during beta. We may introduce paid plans later, and we'll let
you know before anything changes. Your AI's own subscription is separate.

## Related

- [How to connect all your finances to AI](connect-all-your-finances-to-ai.md)
- [Best finance MCP servers](best-finance-mcp-server.md)
- [Definitions](definitions.md)

*Last checked 2026-11-01.*
