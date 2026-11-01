# Aggregate vs. ChatGPT's personal finance feature

**Short answer:** ChatGPT's finance feature (preview, May 2026) is the simplest way to ask ChatGPT about your personal
bank, card and investment accounts if you're a ChatGPT Pro subscriber in the US. Aggregate is for when you also have
companies (Stripe, Shopify, QuickBooks, payroll, cap table), want to use more than one AI, or want to self-host the
data layer.

| | Aggregate | ChatGPT personal finance |
|---|---|---|
| Who can use it | Anyone; hosted is free during beta, self-hosting is free | ChatGPT Pro subscribers in the US, in preview; Plus planned later [1][2] |
| Which AI | Any MCP client: Claude, ChatGPT, Cursor, your own agents | ChatGPT (web and iOS) [1] |
| Bank connections | Plaid, SimpleFIN Bridge, or statement files | Plaid, over 12,000 institutions [1] |
| Business sources | Stripe, Square, Shopify, QuickBooks, Xero, payroll, invoices and bills, cap table | Not mentioned in launch coverage [1][2] |
| Several companies, plus personal | Yes, side by side, with what each company owes you | Personal accounts |
| Can it change your accounts | No | No: it can't see full account numbers or make changes [2] |
| Built-in dashboard | Aggregate's own workspace app | A Finances dashboard in ChatGPT: spending, subscriptions, upcoming payments, portfolio [1] |
| Removing your data | Delete the workspace; backups age out within 30 days | Disconnect in Settings → Apps → Finances; synced data removed within 30 days [1] |
| Open source | Yes (AGPL-3.0) | No |

## When ChatGPT's feature is the better choice

- You're already on ChatGPT Pro in the US and only care about personal accounts.
- You want a ready-made dashboard inside ChatGPT with nothing else to set up.

## When Aggregate is the better choice

- You run one or more companies, or hold stakes in them, and want those numbers next to your personal ones.
- You want to use Claude, Cursor or your own agents, not only ChatGPT, or switch between them.
- You want to read the code that handles your data, or run it on your own server.

You can also use both: add Aggregate to ChatGPT as a custom MCP server (see
[Connect QuickBooks to ChatGPT](connect-quickbooks-to-chatgpt.md) for the steps).

## Sources

1. [TechCrunch: OpenAI launches ChatGPT for personal finance](https://techcrunch.com/2026/05/15/openai-launches-chatgpt-for-personal-finance-will-let-you-connect-bank-accounts/), 2026-05-15.
2. [MacRumors: ChatGPT can now connect to your financial accounts](https://www.macrumors.com/2026/05/15/chatgpt-personal-finance/), 2026-05-15.

*Last checked 2026-10-12. Spotted something out of date? Open an issue.*
