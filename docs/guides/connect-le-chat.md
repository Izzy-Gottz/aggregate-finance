# Connect Le Chat (Mistral) to Aggregate

Le Chat adds custom MCP servers as **Connectors**. Only an admin can add one; on Free, Pro and Student plans the account owner is the admin.

1. In Le Chat, open **Connectors** and choose **+ Add Connector**.
2. On the **Custom MCP Connector** tab, enter `Aggregate` as the **Connector name** and `https://app.aggregate.finance/mcp` as the **Server URL**.
3. Choose **Connect**. Le Chat detects that Aggregate uses sign-in (OAuth 2.1); sign in to Aggregate and choose what Le Chat can see.
4. In a chat, turn the Aggregate connector on from the tools menu.
5. Try: "Which customers are late paying us?"

Self-hosting? Use `https://<your-server>/mcp` instead; it must be reachable over HTTPS.

**What it can do:** read your cash, runway, transactions, invoices, payroll, cap table and reports, and (only if you
allow it) add records, each one labeled and undoable for 30 days. It can never move money, pay bills or send anything.

Last checked 2026-11-01 against Mistral's own help pages: [MCP connectors in Le Chat](https://docs.mistral.ai/le-chat/knowledge-integrations/connectors/mcp-connectors). All assistants: [Connect your AI](../connect-your-ai.md).
