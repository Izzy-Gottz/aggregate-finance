# Connect Perplexity to Aggregate

Perplexity adds custom remote MCP servers as **connectors** (Pro, Max and Enterprise).

1. Open **Plugins** in the sidebar (or **Customize → Connectors**), then choose **Add custom → Add MCP connector** and **Remote**.
2. Name it `Aggregate` and paste `https://app.aggregate.finance/mcp` as the **MCP server URL**.
3. Under **Advanced**, choose **OAuth** and leave the client ID and secret empty: Aggregate registers clients automatically.
4. Tick the acknowledgement, choose **Add**, then sign in to Aggregate and choose what Perplexity can see.
5. Try: "Give me last month's profit and loss."

In an organization, an admin adds it under **Organization settings → Connectors → Custom connector**, or turns on **Allow members to add custom connectors** (off by default).

Self-hosting? Use `https://<your-server>/mcp` instead; it must be reachable over HTTPS.

**What it can do:** read your cash, runway, transactions, invoices, payroll, cap table and reports, and (only if you
allow it) add records, each one labeled and undoable for 30 days. It can never move money, pay bills or send anything.

Last checked 2026-11-01 against Perplexity's own help pages: [Adding custom remote connectors](https://www.perplexity.ai/help-center/en/articles/13915507-adding-custom-remote-connectors). All assistants: [Connect your AI](../connect-your-ai.md).
