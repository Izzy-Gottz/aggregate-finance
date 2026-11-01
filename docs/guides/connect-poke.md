# Connect Poke to Aggregate

Poke adds custom MCP servers as **Integrations**, from the web or the command line.

1. Open [poke.com/integrations/new](https://poke.com/integrations/new).
2. Name it `Aggregate` and paste `https://app.aggregate.finance/mcp` as the **MCP Server URL**. Leave the API key empty.
3. Choose **Create Integration**. Poke registers itself with Aggregate automatically; sign in to Aggregate and choose what Poke can see.
4. Text Poke: "How much cash do we have?"

From a terminal: `npx poke@latest mcp add https://app.aggregate.finance/mcp`. If you'd rather not sign in, create a key in Aggregate (**Connect your AI → + Connect another AI → Create a key**, with an expiry) and paste it as the API key.

Self-hosting? Use `https://<your-server>/mcp` instead; it must be reachable over HTTPS.

**What it can do:** read your cash, runway, transactions, invoices, payroll, cap table and reports, and (only if you
allow it) add records, each one labeled and undoable for 30 days. It can never move money, pay bills or send anything.

Last checked 2026-11-01 against Poke's own help pages: [MCP servers in Poke](https://poke.com/docs/mcp-servers). All assistants: [Connect your AI](../connect-your-ai.md).
