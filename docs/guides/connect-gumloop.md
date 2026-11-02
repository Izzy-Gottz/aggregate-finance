---
description: Add Aggregate to Gumloop as an MCP server so your flows can read your real finances. Read-only.
---

# Connect Gumloop to Aggregate

Gumloop adds custom MCP servers as **Connectors**, which its agents can then use.

1. In Gumloop, open **Customize** in the left sidebar, then the **Connectors** tab, and choose **Add Custom MCP**.
2. Paste `https://app.aggregate.finance/mcp` as the **MCP Server URL** and choose **Connect**.
3. Gumloop detects sign-in; choose **Authenticate**, sign in to Aggregate and choose what Gumloop can see.
4. On your agent, open **Connectors**, choose **+ Add**, then **+** next to Aggregate, and **Save**.
5. Ask the agent: "What bills are due in the next two weeks?"

Gumloop runs tools without asking first. To keep it read-only, leave "Can add records" off when you choose what it can see. A key works too: create a key in Aggregate (**Connect your AI → + Connect another AI → Create a key**, with an expiry) and paste it as the **Access Token / API Key**.

Self-hosting? Use `https://<your-server>/mcp` instead; it must be reachable over HTTPS.

**What it can do:** read your cash, runway, transactions, invoices, payroll, cap table and reports, and (only if you
allow it) add records, each one labeled and undoable for 30 days. It can never move money, pay bills or send anything.

Last checked 2026-11-01 against Gumloop's own help pages: [Custom MCP servers](https://docs.gumloop.com/nodes/mcp/custom_mcp_servers). All assistants: [Connect your AI](../connect-your-ai.md).
