# Weekly runway to Slack (n8n template)

Every Monday at 9:00, n8n reads your books through Aggregate's remote MCP server and posts one Slack digest: each
company's cash, net burn and runway, last week's three biggest money movements, anything large due in the next 14 days,
and how many items wait for review in Aggregate. When a company's runway drops under your threshold, a second message
pings the channel.

Aggregate is the open-source finance MCP (open-sourcing (AGPL) at launch): every bank, card, payment app, invoice and
payroll provider of all your companies, reconciled to the cent, behind one link. Numbers come from fixed definitions,
the same ones the Aggregate app shows, and missing data is reported as unknown, never as zero.

## Nodes

`Every Monday 9:00` (Schedule) → `Settings` (runway alert threshold in months, smallest due amount to list) →
`Get review items` and `Get upcoming` (MCP Client: `list_review_items`, `list_upcoming` with 14 days) → `Runway agent`
(AI Agent; model `Claude Haiku 5.5`; tool `Aggregate MCP`; output checked by `Company numbers (JSON)`) →
`Build digest and alert` (Code) → `Post digest` (Slack), and `Runway under threshold?` (IF) → `Post runway alert` (Slack).

The agent gets four read tools: `whoami`, `get_overview`, `get_metric` and `query_transactions`. It returns cash, net
burn, runway and the top movements per company as JSON. Review counts and due items come from direct MCP calls, not
from the AI, so they can't be miscounted or invented. Nothing in this workflow can record, change or move anything.

## Setup

1. Import `workflow.json` into n8n (tested on n8n 2.42).
2. **Aggregate MCP**: endpoint `https://app.aggregate.finance/mcp` (self-hosted: `https://<your-server>/mcp`), transport
   *HTTP Streamable*, authentication *MCP OAuth2*. In the credential, turn on **Use Dynamic Client Registration**, set
   the server URL to `https://app.aggregate.finance` and click **Connect**. Aggregate asks you to sign in, then shows
   what this connection will be able to see: pick the companies and kinds of data (balances, transactions, invoices and
   bills, payroll). You can pause or revoke the connection any time in **Connect your AI**. The same credential goes in
   `Aggregate MCP`, `Get review items` and `Get upcoming`.
3. **Claude Haiku 5.5** (the Anthropic chat model node): add your Anthropic API key. It runs with *Thinking Mode: Disabled*. Keep thinking
   off: n8n's agent node doesn't carry Claude's thinking blocks between tool calls, so with thinking on, runs fail
   about half the time with `400 … Invalid signature in thinking block`. Claude Sonnet 5.5 can't turn thinking off, so
   it isn't a good fit for this node (tested on n8n 2.42, October 2026). If a run does fail with that error, check
   that thinking is off. Any other chat model node works too if you prefer another provider.
4. **Post digest** and **Post runway alert**: connect Slack and choose the channel (default `#finance`).
5. **Settings**: `runwayAlertMonths` (default 6) and `dueAlertAmount` (default 1000; due items smaller than this are
   left out).
6. Run it once with **Execute workflow**, then activate it.

## Example message

From a run against Aggregate's demo (`npx aggregate-finance demo`), in about 12 seconds (n8n 2.42.7, Claude Haiku 5.5,
three runs with the same result):

> *Weekly cash and runway*
> *Northwind Labs*: cash $622,142.55 · net burn $29,428.50/mo · runway 21.1 months
> • Gusto: -$30,846.06
> • Trailhead Gear: +$1,999.00
> • Quarry Labs: +$1,999.00
> 1 item to review in Aggregate
> *Bluebird Studio*: cash $67,758.26 · net burn $2,966.92/mo · runway 22.8 months
> • Oakline Retail: +$23,700.00
> • Adobe: -$358.93
> Due in the next 14 days: INV-1047 Lumen Health +$23,200.00 (2026-10-15); INV-1049 Lumen Health +$9,100.00 (2026-10-21); INV-1050 Ferris & Co +$17,700.00 (2026-10-23)
> *Harbor Coffee*: cash $164,385.56 · cash growing $19,277.35/mo · runway not burning
> • No payee name: +$17,784.10
> • ADP: -$15,402.54
> • Cash sales: +$1,500.40
> Due in the next 14 days: ADP payroll -$15,402.54 (2026-10-23, estimated)

With the threshold set to 22 months, the alert reads:

> @here Runway under 22 months: *Northwind Labs* 21.1 months (cash $622,142.55, burn $29,428.50/mo)

(The companies and figures are Aggregate's made-up demo data.)

To try it without Slack or your own books, run `npx aggregate-finance demo`, point the three Aggregate nodes at `http://127.0.0.1:<port>/mcp`
with *Bearer Auth* and the key from the `claude mcp add` line the demo prints, and swap the two Slack nodes for HTTP Request or Code nodes.
