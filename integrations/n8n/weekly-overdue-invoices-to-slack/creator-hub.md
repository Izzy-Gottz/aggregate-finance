# n8n Creator Hub submission

Paste-ready copy for creators.n8n.io. Upload `workflow.json` from this folder. It holds no credentials or instance ID.

**Title:** Send weekly overdue invoices and who to chase first to Slack from Aggregate with Claude

**Description** (Markdown):

```markdown
## Who's it for
Founders, finance leads and bookkeepers who want one Monday message on who owes them money, without opening the books. It works for one company or many.

## How it works
1. Every Monday at 9:00, **Get overdue invoices** calls Aggregate's MCP server directly for invoices past due.
2. A Code node groups them by company and customer, with totals, invoice numbers and the oldest days overdue.
3. An IF node stops on a clean week, so there's no message and no AI cost.
4. Claude Haiku 5.5 picks up to three customers to chase first and returns JSON that a Structured Output Parser checks.
5. A Code node keeps only picks that name a customer on the list, and Slack gets one message.

Aggregate is read-only here and can't move money. Nothing goes to your customers. Totals come from direct calls and code, not the AI.

## How to set up
1. **Get overdue invoices**: create an MCP OAuth2 credential with Dynamic Client Registration on and Server URL `https://app.aggregate.finance`, then Connect and pick the companies and data it may read.
2. **Claude Haiku 5.5**: add your Anthropic API key. Keep thinking off.
3. **Post to Slack**: connect Slack and pick the channel.
4. **Settings**: days overdue and the smallest invoice to list.
5. Run it once, then activate.

## Requirements
An Aggregate account (hosted, or your own server's `/mcp`), an Anthropic API key and Slack.

## How to customize
Change the schedule, the thresholds or the channel. Swap Slack for an email node to send it by email. Edit the prompt in Pick who to chase to change how customers are ranked.
```

Notes for the person submitting:
- New creators get one template in review at a time.
- Tested headless on n8n 2.42.7 against the public demo, three runs, 2026-11-02. Slack itself was stubbed in the test, so the post step is untested.
