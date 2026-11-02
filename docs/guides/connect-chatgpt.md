---
description: Add Aggregate to ChatGPT as a custom MCP server: step-by-step setup, then ask ChatGPT about your real finances. Read-only.
---

# Connect ChatGPT to Aggregate

Custom MCP servers are added on ChatGPT on the web. Which plans can add one has changed more than once; check
OpenAI's help page "Developer mode and MCP apps in ChatGPT" if the option below is missing.

1. Open [ChatGPT Plugins](https://chatgpt.com/plugins), choose **Add** (top right), then **Add custom MCP server**.
2. Name it "Aggregate" and add a short description.
3. Under **Connection**, keep **Server URL** and paste `https://app.aggregate.finance/mcp`. Authentication: OAuth.
4. Check **I understand and want to continue**, then select **Create as a plugin**.
5. In the **Connect Aggregate** dialog, choose **Connect**, sign in to Aggregate and choose what ChatGPT can see.
6. Try: "Give me my profit and loss for last month."

In a ChatGPT Business or Enterprise workspace, an admin may need to allow custom MCP servers first.

Self-hosting? Use `https://<your-server>/mcp` instead; it must be reachable over HTTPS.

**What it can do:** read your cash, runway, transactions, invoices, payroll, cap table and reports, and (only if you
allow it) add records, each one labeled and undoable for 30 days. It can never move money, pay bills or send anything.

Last checked 2026-10-12 against the app's own help pages. All assistants: [Connect your AI](../connect-your-ai.md).
