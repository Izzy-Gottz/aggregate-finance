# Aggregate vs. Copilot Money's MCP

**Short answer:** if you already use Copilot Money for your personal budget, its MCP (in beta) lets Claude or ChatGPT
read the categories, budgets and spending you've set up there. Aggregate is a separate, open-source data layer that
also covers companies (payments, accounting, payroll, cap table) and works without a budgeting app.

| | Aggregate | Copilot Money MCP |
|---|---|---|
| Status | Beta (hosted), open source | Beta, by waitlist, announced 2026-05-15 [1][2] |
| What it's for | Personal and business finances in one ledger | Your Copilot Money data: categories, transactions, monthly spend and income, recurrings, tags [1] |
| Which AI | Any MCP client | Tested with Claude, ChatGPT and Codex CLI [1] |
| Read or write | Reads only at every source; can add records inside Aggregate if you allow it, undoable for 30 days | Read-only to start [1] |
| Business sources | Stripe, Square, Shopify, QuickBooks, Xero, payroll, invoices and bills, cap table | Not described [1] |
| Needs another app | No | A Copilot Money account |
| Open source, self-hostable | Yes (AGPL-3.0) | No |

## When Copilot Money's MCP is the better choice

- You already budget in Copilot Money and want your AI to see the same categories and budgets you curate there.
- You only care about personal finances.

## When Aggregate is the better choice

- You have companies, or invest in them, and want those numbers with your personal ones.
- You want to see and run the code yourself.
- You want a permission per AI that you can read as one sentence, and a log of every question it asks.

A note on names: community projects named "copilot-money-mcp" also exist and are not made by Copilot Money.

## Sources

1. [Copilot Money: Dispatch](https://www.copilot.money/dispatch), read 2026-10-12 (entries of 2026-05-15 and 2026-08-12).
2. [Copilot Money on Threads](https://www.threads.com/@copilotmoney/post/DYXZsYpjnQr), 2026-05-15.

*Last checked 2026-10-12. Spotted something out of date? Open an issue.*
