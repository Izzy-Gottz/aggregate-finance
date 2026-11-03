# Connect your AI to Aggregate

Your Aggregate link is shown under **Connect your AI**. Hosted: `https://app.aggregate.finance/mcp`.
Self-hosted: `https://<your-server>/mcp` (it must be reachable over HTTPS for claude.ai and ChatGPT; for apps on the same
computer, use the local bridge below).

When you connect, Aggregate asks you to sign in and then shows one sentence you can edit, for example:

> Claude can see **Acme and Bluebird**: **balances, transactions and invoices**. **Can add records.** Changes apply
> **immediately**. Expires in **90 days**.
>
> Can't ever: move money, pay bills, send invoices or emails.

You can change, pause or revoke this any time from the AI's row in **Connect your AI**. Every question it asks is logged.

## Claude (claude.ai, Claude Desktop, mobile)
1. In Claude, open **Customize → Connectors** (in some accounts still **Settings → Connectors**), choose **Add**, then
   **Add custom connector**.
2. Name: `Aggregate`. URL: your Aggregate link. Click **Continue**.
3. Claude detects that Aggregate uses sign-in (**Sign in now**). Click **Add**, then **Connect** on the connector's page.
4. Sign in to Aggregate, choose what Claude can see, and confirm.
5. Try: "How much cash do I have across all my companies?"

The Claude mobile apps use connectors added on the web or desktop.

## ChatGPT
1. Open [ChatGPT Plugins](https://chatgpt.com/plugins), choose **Add** (top right), then **Add custom MCP server**.
2. Name it "Aggregate" and add a short description.
3. Under **Connection**, keep **Server URL** and paste your Aggregate link (ending in `/mcp`). Authentication: OAuth.
4. Check **I understand and want to continue**, then select **Create as a plugin**.
5. In the **Connect Aggregate** dialog, choose **Connect**, sign in to Aggregate and choose what ChatGPT can see.
6. Try: "Give me my profit and loss for last month."

In a ChatGPT Business or Enterprise workspace, an admin may need to allow custom MCP servers first.

## Claude Code
```sh
claude mcp add --transport http --scope user aggregate https://app.aggregate.finance/mcp
```
Then run `/mcp` in Claude Code to sign in.

## Codex, Cursor, VS Code, Windsurf, Gemini CLI, Zed, opencode and other MCP clients
Add a remote (Streamable HTTP) server named `aggregate` with your Aggregate link. Clients that support OAuth will open
the sign-in page automatically (Codex CLI: run `codex mcp login aggregate` once). Where setup writes each one:

| App | File (user level) | Entry |
| --- | --- | --- |
| Codex CLI | `~/.codex/config.toml`, via `codex mcp add aggregate --url …` | `[mcp_servers.aggregate] url` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers.aggregate.url` |
| VS Code | `<user settings folder>/mcp.json` | `servers.aggregate` (`type: http`) |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers.aggregate.serverUrl` |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers.aggregate.httpUrl` |
| Zed | `~/.config/zed/settings.json` | `context_servers.aggregate.url` |
| opencode | `~/.config/opencode/opencode.json` | `mcp.aggregate` (`type: remote`) |

A file with comments (Zed's usually has them) is never rewritten: setup prints the entry to paste instead. From a checkout of Aggregate, `node packages/cli/src/main.ts setup` shows the change for
each client it finds and applies it with `--yes` (backing up each file first); once the CLI is on npm this is
`npx aggregate-finance setup`.

## Bots and scripts (no browser sign-in)
For a WhatsApp/iMessage bot, a scheduled script or your own agent:
1. In **Connect your AI**, choose **+ Connect another AI → Create a key**, pick what it can see, and copy the key
   (`agfn_live_…`). It's shown once and must have an expiry.
2. Give it to your bot as the environment variable `AGFN_KEY`. Never paste keys into a chat.
3. Remote MCP: send `Authorization: Bearer $AGFN_KEY` to your Aggregate link. Local stdio bridge:
   ```sh
   AGFN_KEY=agfn_live_… npx aggregate-finance mcp --url https://app.aggregate.finance/mcp
   ```
4. REST instead of MCP: the same operations live under `/v1/*`, described at `/v1/openapi.json`.

## Ready-made workflows
- **n8n: weekly cash and runway summary to Slack.** [The template](https://n8n.io/workflows/20881) posts a digest each Monday and sends an alert if runway drops below your limit. You need an Anthropic API key and Slack.

## What your AI can do
- **Read:** cash and runway per company, accounts, transactions, who owes you, what you owe soon, payroll, cap table,
  buckets (like Rent or Loans), reports, documents waiting to be read.
- **Add (if you allow it):** cash you received or spent, an invoice or bill from a photo or PDF, a payment against an
  invoice, a bucket and its rules, an equity event, and undo for anything it added (30 days).
- **Never:** move money, pay bills, send invoices, emails or messages.
