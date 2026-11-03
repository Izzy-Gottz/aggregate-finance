# Bills and renewals by email (n8n template)

Every Friday at 9:00, n8n reads your books through Aggregate's remote MCP server and emails what's due out of each
company in the next 14 days: bills, payroll, subscriptions, tax and loan payments, set against cash, plus any recurring
charge whose price changed. A quiet fortnight sends nothing and costs nothing.

Aggregate is the open-source (AGPL-3.0), read-only finance MCP server. It reconciles your banks, cards, payment apps,
books and payroll into one ledger. Nothing in this workflow can pay, cancel or change anything.

## Nodes

`Every Friday 9:00` (Schedule) → `Settings` (days ahead, smallest amount) → `Get upcoming`, `Get price changes` and
`Get overview` (MCP Client: `list_upcoming`, `list_recurring`, `get_overview`) → `Build summary` (Code) →
`Anything due?` (IF) → `Write a note` (Basic LLM Chain; model `Claude Haiku 5.5`; output checked by `Note (JSON)`) →
`Build email` (Code) → `Send email`.

Every amount and date comes from direct calls and the Code node. The AI adds a line or two on what deserves attention,
and `Build email` drops that note if it uses a figure that isn't in the data. Amounts Aggregate estimated are marked
`(estimated)`, and any gap Aggregate reports is printed at the bottom of the email.

## Setup

1. Import `workflow.json` into n8n (tested on n8n 2.42.7).
2. **Get upcoming**, **Get price changes** and **Get overview**: endpoint `https://app.aggregate.finance/mcp`
   (self-hosted: `https://<your-server>/mcp`), transport *HTTP Streamable*, authentication *MCP OAuth2*. In the
   credential, turn on **Use Dynamic Client Registration**, set the server URL to `https://app.aggregate.finance` and
   click **Connect**. Sign in, then pick the companies and data this connection may read. Use the same credential in all
   three nodes.
3. **Claude Haiku 5.5**: add your Anthropic API key and keep thinking off. Any other chat model node works too.
4. **Send email**: add SMTP credentials and set the from and to addresses.
5. **Settings**: `days` (default 14) and `minAmount` (default 100).
6. Run it once with **Execute workflow**, then activate it.

## Example email

From three runs against Aggregate's public demo on 2026-11-02 (n8n 2.42.7, Claude Haiku 5.5). The figures were the same
each time.

> Slack's price rose from $160.00 to $200.00 and its next payment of $200.00 is due 2026-11-09 for Northwind Labs. The largest payment is the Gusto payroll of $30,109.62 due 2026-11-16 for Northwind Labs.
>
> Northwind Labs: $30,525.62 due in the next 14 days, cash $748,901.54
>   2026-11-06  Google Workspace  $216.00 (estimated)
>   2026-11-09  Slack  $200.00 (estimated)
>   2026-11-16  Gusto payroll  $30,109.62 (estimated)
>   Price change: Slack is now $200.00, up from $160.00 on 2026-05-09; next charge 2026-11-09
>
> Harbor Coffee: $14,823.32 due in the next 14 days, cash $601,959.43
>   2026-11-13  ADP payroll  $14,823.32 (estimated)
>
> Note from Aggregate: minimum payments are missing for 2 card or loan accounts with no terms on file, so this calendar can be short.
> From your books in Aggregate. Nothing here has been paid; Aggregate can't move money.

(The companies and figures are Aggregate's made-up demo data.)

To try it without an account, point the three Aggregate nodes at `https://app.aggregate.finance/demo/mcp` with
authentication *None*, and swap `Send email` for a No Op node.
