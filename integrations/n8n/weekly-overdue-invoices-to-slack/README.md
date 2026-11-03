# Weekly overdue invoices to Slack (n8n template)

Every Monday at 9:00, n8n reads your invoices through Aggregate's remote MCP server and posts one Slack message: who
owes each company money past the due date, how much and how late, plus up to three customers to chase first. A quiet
week sends nothing and costs nothing.

Aggregate is the open-source (AGPL-3.0), read-only finance MCP server. It reconciles your banks, cards, payment apps,
books and payroll into one ledger. Nothing in this workflow can change a record, contact a customer or move money.

## Nodes

`Every Monday 9:00` (Schedule) → `Settings` (days overdue, smallest invoice) → `Get overdue invoices` (MCP Client:
`search_invoices`) → `Build overdue list` (Code) → `Anything overdue?` (IF) → `Pick who to chase` (Basic LLM Chain; model
`Claude Haiku 5.5`; output checked by `Chase list (JSON)`) → `Build message` (Code) → `Post to Slack`.

Totals and invoice counts come from the Code node, never the AI. The AI only picks from the finished list, and
`Build message` keeps a pick only if it names a company and customer on that list.

## Setup

1. Import `workflow.json` into n8n (tested on n8n 2.42.7).
2. **Get overdue invoices**: endpoint `https://app.aggregate.finance/mcp` (self-hosted: `https://<your-server>/mcp`),
   transport *HTTP Streamable*, authentication *MCP OAuth2*. In the credential, turn on **Use Dynamic Client
   Registration**, set the server URL to `https://app.aggregate.finance` and click **Connect**. Sign in, then pick the
   companies and data this connection may read. It needs invoices and bills.
3. **Claude Haiku 5.5**: add your Anthropic API key and keep thinking off. Any other chat model node works too.
4. **Post to Slack**: connect Slack and choose the channel (default `#finance`).
5. **Settings**: `minDaysOverdue` (default 1) and `minInvoiceAmount` (default 100).
6. Run it once with **Execute workflow**, then activate it.

## Example message

From three runs against Aggregate's public demo on 2026-11-02 (n8n 2.42.7, Claude Haiku 5.5). The list was the same each
time. The third pick varied between two customers, which is a judgment call, so expect that.

> *Overdue invoices*
> *Bluebird Studio*: $134,950.00 across 11 invoices
> • Oakline Retail: $50,450.00, 4 invoices, oldest 230 days overdue
> • Ferris & Co: $36,000.00, 3 invoices, oldest 304 days overdue
> • Pinecrest Clinic: $24,950.00, 2 invoices, oldest 136 days overdue
> • Atlas Freight: $23,550.00, 2 invoices, oldest 165 days overdue
> *Chase first*
> • Oakline Retail (Bluebird Studio): Largest overdue balance at $50,450.00 with four invoices, oldest 230 days past due.
> • Ferris & Co (Bluebird Studio): Second-largest overdue balance at $36,000.00 with the oldest debt, 304 days past due.
> • Atlas Freight (Bluebird Studio): Overdue $23,550.00 across two invoices, 165 days past due, with a substantial balance and aging.

(The companies and figures are Aggregate's made-up demo data.)

To try it without an account, point `Get overdue invoices` at `https://app.aggregate.finance/demo/mcp` with
authentication *None*, and swap `Post to Slack` for a No Op node.
