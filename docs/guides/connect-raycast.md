# Connect Raycast to Aggregate

Raycast AI (Pro) adds MCP servers with its **Install MCP Server** command.

1. In Raycast, run **Install MCP Server** (or **Manage MCP Servers → Install New Server**).
2. Name it `Aggregate`, choose **HTTP** as the transport and paste `https://app.aggregate.finance/mcp` as the **URL**.
3. Choose **Install MCP Server** (⌘↵), then **Sign In**. Raycast registers itself with Aggregate; sign in and choose what Raycast can see.
4. Ask Raycast AI: "How much cash do we have?"

Self-hosting? Use `https://<your-server>/mcp` instead; it must be reachable over HTTPS.

**What it can do:** read your cash, runway, transactions, invoices, payroll, cap table and reports, and (only if you
allow it) add records, each one labeled and undoable for 30 days. It can never move money, pay bills or send anything.

Last checked 2026-11-01 against Raycast's own help pages: [Model Context Protocol](https://manual.raycast.com/ai/model-context-protocol). All assistants: [Connect your AI](../connect-your-ai.md).
