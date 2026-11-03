# aggregate-finance

Connect your AI apps to [Aggregate](https://aggregate.finance), the open-source finance MCP: every bank, card,
payment app, accounting file and payroll provider of all your companies, reconciled to the cent, behind one link.

```sh
npx aggregate-finance setup    # add Aggregate to the AI apps on this machine
```

It finds Claude Code, Codex CLI, Cursor, VS Code, Windsurf, Gemini CLI, Zed and opencode, shows each change first,
and applies it with `--yes` (backing up each file it edits). Running your own server? Pass `--url https://<your-server>/mcp`.
Installed globally (`npm i -g aggregate-finance`), the command is `agfn`.

## Add it by hand

Most AI apps can use the hosted server directly. You sign in with OAuth, and no key is needed:

```sh
claude mcp add --transport http aggregate https://app.aggregate.finance/mcp
```

The local `npx aggregate-finance mcp` bridge is only for clients that can't use a remote server, and it **needs an
agent key** in `AGFN_KEY`. Without one it fails to sign in. See [Bots and scripts](#bots-and-scripts) below.

## Try it with sample data

```sh
npx aggregate-finance demo
```

Starts Aggregate on this machine with a made-up, reconciled sample business: no account, keys or bank needed. It
prints the `claude mcp add …` line to connect Claude Code and a link that signs you in to the web app. Data stays in
`~/.agfn/demo`; `--fresh` starts over, `--port N` picks the port. The demo's AI key can read everything and add
records, so your AI may add entries to the sample data (undo them in the app, or start over with `--fresh`).

## Bots and scripts

Clients that can only start a local command can bridge over stdio with an agent key (`agfn_live_…`, made in
**Connect your AI → A bot or script**):

```sh
npx aggregate-finance mcp --print-config --url https://app.aggregate.finance/mcp
```

That prints the JSON to paste into your client. Put the key in its `env` block as `AGFN_KEY`, never on the command
line.

Needs Node 22.18 or later. Source, self-hosting and docs: <https://github.com/Izzy-Gottz/aggregate-finance>.
License: AGPL-3.0-only.
