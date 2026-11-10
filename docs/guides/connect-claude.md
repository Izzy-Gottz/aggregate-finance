---
description: Add Aggregate to Claude as a custom connector: step-by-step setup for web, desktop and mobile, then ask Claude about your real finances. Read-only.
---

# Connect Claude to Aggregate

Works in claude.ai, the Claude desktop app and the Claude iPhone and Android apps. Custom connectors work on Free,
Pro, Max, Ultra, Team and Enterprise plans; Free allows one ([Anthropic's help page](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp), checked 2026-11-04).

## Desktop and web

1. In Claude, open **Customize → Connectors** (in some accounts still **Settings → Connectors**), choose **Add**, then
   **Add custom connector**.
2. Name: `Aggregate`. URL: `https://app.aggregate.finance/mcp`. Click **Continue**.
3. Claude detects that Aggregate uses sign-in (**Sign in now**). Click **Add**, then **Connect** on the connector's page.
4. Sign in to Aggregate, choose what Claude can see, and confirm.
5. Try: "How much cash do I have across all my companies?"

## iPhone and Android

The Claude mobile apps use the connectors you've added on the web or desktop; you can't add a new one from the phone.
Add Aggregate once using the steps above, then open the Claude app on your phone and ask.

In a Claude Team or Enterprise organization, an owner may need to add the connector for the organization first.

Self-hosting? Use `https://<your-server>/mcp` instead; it must be reachable over HTTPS.

**What it can do:** read your cash, runway, transactions, invoices, payroll, cap table and reports, and (only if you
allow it) add records, each one labeled and undoable for 30 days. It can never move money, pay bills or send anything.

Last checked 2026-10-12 against the app's own help pages. All assistants: [Connect your AI](../connect-your-ai.md).
