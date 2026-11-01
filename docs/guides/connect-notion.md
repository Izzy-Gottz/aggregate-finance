# Connect Notion AI to Aggregate

Notion can use custom MCP servers on Business and Enterprise plans, once a workspace admin turns them on.

1. An admin opens **Settings → Connections**, the **Manage** tab, and turns on **Enable custom MCP servers**.
2. For a Custom Agent: open the agent's **Settings → Tools & Access**, choose **Add connection → Custom MCP server**, paste `https://app.aggregate.finance/mcp` and name it `Aggregate`. (For Notion Agent, an admin uses **Settings → Connections → Discover → Add Custom MCP**.)
3. Choose **Connect**, sign in to Aggregate and choose what Notion can see.
4. Ask: "Summarize this month's cash in and out for our weekly notes."

Connections are per user and per agent and don't carry over between Notion Agent and Custom Agents. Not available on mobile. A header key also works: create a key in Aggregate (**Connect your AI → + Connect another AI → Create a key**, with an expiry) and use it as a bearer token.

Self-hosting? Use `https://<your-server>/mcp` instead; it must be reachable over HTTPS.

**What it can do:** read your cash, runway, transactions, invoices, payroll, cap table and reports, and (only if you
allow it) add records, each one labeled and undoable for 30 days. It can never move money, pay bills or send anything.

Last checked 2026-11-01 against Notion's own help pages: [MCP connections for Custom Agents](https://www.notion.com/help/mcp-connections-for-custom-agents). All assistants: [Connect your AI](../connect-your-ai.md).
