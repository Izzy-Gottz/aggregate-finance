---
description: Add Aggregate to Dust as a remote MCP server so your agents can answer questions about your real finances. Read-only.
---

# Connect Dust to Aggregate

In Dust, a workspace admin adds Aggregate once as a remote MCP server; agents then use it as a tool.

1. As a Dust admin, open **Spaces > Tools** and choose **Add Tool**, then **Add MCP Server**.
2. Paste `https://app.aggregate.finance/mcp` and keep authentication on **Automatic**. Dust starts a sign-in; sign in to Aggregate and choose what Dust can see.
3. Add the new Aggregate tool to the agents that should use it.
4. Ask an agent: "What's our runway?"

Dust also takes a bearer token, but it ties the connection to one Aggregate account for the whole workspace, so sign-in (Automatic) is better for teams.

Self-hosting? Use `https://<your-server>/mcp` instead; it must be reachable over HTTPS.

**What it can do:** read your cash, runway, transactions, invoices, payroll, cap table and reports, and (only if you
allow it) add records, each one labeled and undoable for 30 days. It can never move money, pay bills or send anything.

Last checked 2026-11-01 against Dust's own help pages: [Adding an MCP server](https://docs.dust.tt/docs/user-documentation/admins/tools-management/adding-an-mcp-server). All assistants: [Connect your AI](../connect-your-ai.md).
