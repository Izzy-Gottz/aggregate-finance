---
description: Add Aggregate to Claude Code, Codex, Gemini CLI, Zed and other command-line tools with one link, then ask about your finances. Read-only.
---

# Connect Claude Code, Codex, Gemini CLI or Zed to Aggregate

**Claude Code:**

```sh
claude mcp add --transport http --scope user aggregate https://app.aggregate.finance/mcp
```

Then run `/mcp` in Claude Code to sign in.

**Everything else (Codex CLI, Gemini CLI, Zed, Cursor, VS Code, Windsurf, opencode):** one command finds each one
installed and shows the change before making it:

```sh
npx aggregate-finance setup          # shows what it would add
npx aggregate-finance setup --yes    # adds it, backing up each file first
```

If you install it instead (`npm i -g aggregate-finance`), the command is `agfn`: `agfn setup`.

Before the CLI is on npm (it's published on launch day), run the same thing from a checkout of Aggregate:
`node packages/cli/src/main.ts setup`.

Codex CLI then needs one sign-in: `codex mcp login aggregate`. The others open Aggregate's sign-in page the first time
they use it. The exact file and entry for each app are in [Connect your AI](../connect-your-ai.md#codex-cursor-vs-code-windsurf-gemini-cli-zed-opencode-and-other-mcp-clients).

Self-hosting? Use `https://<your-server>/mcp` instead; it must be reachable over HTTPS.

**What it can do:** read your cash, runway, transactions, invoices, payroll, cap table and reports, and (only if you
allow it) add records, each one labeled and undoable for 30 days. It can never move money, pay bills or send anything.

Last checked 2026-10-12 against the app's own help pages. All assistants: [Connect your AI](../connect-your-ai.md).
