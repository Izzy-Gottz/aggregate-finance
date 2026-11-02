---
description: Add Aggregate to Grok as a custom connector, then ask Grok about your real finances. Read-only.
---

# Connect Grok to Aggregate

Grok adds custom MCP servers as **Connectors** on grok.com.

1. Go to [grok.com/connectors](https://grok.com/connectors).
2. Choose **New Connector**, then **Custom**.
3. Paste `https://app.aggregate.finance/mcp` as the server URL.
4. Sign in to Aggregate when Grok asks, and choose what Grok can see.
5. Try: "Is anything in my books counted twice?"

For Grok Business and Enterprise, a team admin provisions the connector first (xAI's connector management console),
then members can use it. xAI's guide: [Grok connectors](https://docs.x.ai/grok/connectors).

Self-hosting? Use `https://<your-server>/mcp` instead; it must be reachable over HTTPS.

**What it can do:** read your cash, runway, transactions, invoices, payroll, cap table and reports, and (only if you
allow it) add records, each one labeled and undoable for 30 days. It can never move money, pay bills or send anything.

Last checked 2026-10-12 against the app's own help pages. All assistants: [Connect your AI](../connect-your-ai.md).
