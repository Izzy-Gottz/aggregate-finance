---
description: Add Aggregate to Lindy through Add MCP so your assistant can read your real finances. Read-only.
---

# Connect Lindy to Aggregate

Lindy adds custom MCP servers from its **Integrations** page.

1. In Lindy, open **Integrations**, choose **+ Add**, then **MCP**.
2. In **Connect MCP server**, paste `https://app.aggregate.finance/mcp` as the **Server URL** and name it `Aggregate`.
3. Choose **Connect**, then sign in to Aggregate and choose what Lindy can see.
4. Under **Availability**, choose who in your Lindy workspace can use it.
5. Try: "What did payroll cost last month?"

Lindy also takes a static key under **Advanced**: create a key in Aggregate (**Connect your AI → + Connect another AI → Create a key**, with an expiry) and send it as the bearer token. Each tool can be set to **Always allow** or **Ask for approval**.

Self-hosting? Use `https://<your-server>/mcp` instead; it must be reachable over HTTPS.

**What it can do:** read your cash, runway, transactions, invoices, payroll, cap table and reports, and (only if you
allow it) add records, each one labeled and undoable for 30 days. It can never move money, pay bills or send anything.

Last checked 2026-11-01 against Lindy's own help pages: [MCP in Lindy](https://docs.lindy.ai/integrations/mcp). All assistants: [Connect your AI](../connect-your-ai.md).
