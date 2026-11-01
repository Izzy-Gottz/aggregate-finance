# Connect Cursor or VS Code to Aggregate

**One click:** [Add Aggregate to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=aggregate&config=eyJ1cmwiOiJodHRwczovL2FwcC5hZ2dyZWdhdGUuZmluYW5jZS9tY3AifQ==) or [Add Aggregate to VS Code](vscode:mcp/install?%7B%22name%22%3A%22aggregate%22%2C%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fapp.aggregate.finance%2Fmcp%22%7D) (opens the app and asks you to confirm).
The app then opens Aggregate's sign-in page. If a link doesn't open (some sites don't allow app links), paste it into
your browser:

```
cursor://anysphere.cursor-deeplink/mcp/install?name=aggregate&config=eyJ1cmwiOiJodHRwczovL2FwcC5hZ2dyZWdhdGUuZmluYW5jZS9tY3AifQ==
vscode:mcp/install?%7B%22name%22%3A%22aggregate%22%2C%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fapp.aggregate.finance%2Fmcp%22%7D
```

Cursor's `config` part is `{"url":"https://app.aggregate.finance/mcp"}`, base64-encoded; VS Code's link carries
`{"name":"aggregate","type":"http","url":"https://app.aggregate.finance/mcp"}`, URL-encoded.

**By hand:** add this to `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "aggregate": { "url": "https://app.aggregate.finance/mcp" } } }
```

Then open **Cursor Settings → MCP**, find `aggregate`, and sign in when asked. Try in Agent chat: "What's our runway?"

In VS Code by hand: run **MCP: Add Server…**, choose HTTP, paste `https://app.aggregate.finance/mcp` and name it
`aggregate`; or add `"servers": { "aggregate": { "type": "http", "url": "https://app.aggregate.finance/mcp" } }` to your
user `mcp.json`. Sign in when Copilot Chat (agent mode) first uses it.

Self-hosting? Use `https://<your-server>/mcp` instead; it must be reachable over HTTPS.

**What it can do:** read your cash, runway, transactions, invoices, payroll, cap table and reports, and (only if you
allow it) add records, each one labeled and undoable for 30 days. It can never move money, pay bills or send anything.

Last checked 2026-10-13 against the app's own help pages. All assistants: [Connect your AI](../connect-your-ai.md).
