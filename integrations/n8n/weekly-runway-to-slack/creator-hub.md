# n8n Creator Hub submission

Paste-ready copy for creators.n8n.io. Upload `workflow.json` from this folder. It holds no credentials or instance ID.

**Title:** Send a weekly cash and runway digest to Slack from Aggregate with Claude

**Description** (Markdown):

```markdown
## Who's it for
Founders, finance leads and fractional CFOs who want one Monday message on every company's cash and runway in Slack, and a ping when runway gets short. It works for one company or many.

## How it works
1. Every Monday at 9:00, **Get review items** and **Get upcoming** call Aggregate's MCP server directly for the review queue and everything due in the next 14 days.
2. An AI agent (Claude Haiku 5.5) reads cash, net burn and runway per company, plus last week's three biggest money movements, and returns JSON that a Structured Output Parser checks.
3. A Code node builds the digest: per company, cash · net burn · runway, the top movements, large items due, and how many items wait for review.
4. Slack gets the digest. An IF node sends a second @here message only when a company's runway is under your threshold.

Aggregate is read-only here and can't move money. Its numbers come from fixed definitions, the same as in the app, so the agent reports them instead of adding rows up, and missing data says unknown, never zero. Counts and due dates come from direct calls, not the AI.

## How to set up
1. **Aggregate MCP**: create an MCP OAuth2 credential with Dynamic Client Registration on and Server URL `https://app.aggregate.finance`, then Connect and pick the companies and data it may read. Use it in Aggregate MCP, Get review items and Get upcoming.
2. **Claude Haiku 5.5**: add your Anthropic API key. Keep thinking off.
3. **Post digest** and **Post runway alert**: connect Slack and pick the channel.
4. **Settings**: runway alert threshold (months) and the smallest due amount to list.
5. Run it once, then activate.

## Requirements
An Aggregate account (hosted, or your own server's `/mcp`), an Anthropic API key and Slack.

## How to customize
Change the schedule, the threshold, the channel, or the digest wording in the Code node. Swap Slack for email or Teams by replacing the two Slack nodes.
```

Notes for the person submitting:
- A Creator account at creators.n8n.io (email, password, public username) is Yisrael's to create. New creators get one template in review at a time.
- Review is an automatic check, then a person (people report up to about 7 days). Replies come from nodes@n8n.io, so check spam.
- The title follows n8n's "verb + thing + from/to + where" rule. The overview sticky is yellow, top-left, with How it works, Setup and Customization sections. Each of the three node groups has a white section sticky.
- History: the first version (agent writes free text, one Slack node) was declined on 2026-10-14 as "too basic" (creators.n8n.io/workflows/20881). This version adds a Settings node, two direct MCP Client calls, a Structured Output Parser, a Code node and a threshold alert with an IF branch. Tested headless on n8n 2.42.7 against the demo, 2026-10-15.
