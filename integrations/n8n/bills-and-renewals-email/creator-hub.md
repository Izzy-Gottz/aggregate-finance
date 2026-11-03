# n8n Creator Hub submission

Paste-ready copy for creators.n8n.io. Upload `workflow.json` from this folder. It holds no credentials or instance ID.

**Title:** Email upcoming bills, renewals and price changes every week from Aggregate with Claude

**Description** (Markdown):

```markdown
## Who's it for
Founders, finance leads and small-business owners who want a Friday email on what's about to leave the bank, and which recurring charges went up. It works for one company or many.

## How it works
1. Every Friday at 9:00, three direct calls to Aggregate's MCP server read what's due in the next 14 days, recurring charges whose price changed, and each company's cash.
2. A Code node lines them up per company, with a total due against cash.
3. An IF node stops when nothing is due, so there's no email and no AI cost.
4. Claude Haiku 5.5 adds a short note on what deserves attention and returns JSON that a Structured Output Parser checks.
5. A Code node drops the note if it uses a figure that isn't in the data, then one email goes out.

Aggregate is read-only here and can't move money. Nothing gets paid or cancelled. Amounts and dates come from direct calls and code, not the AI, and estimated amounts are marked.

## How to set up
1. **Get upcoming**, **Get price changes** and **Get overview**: create an MCP OAuth2 credential with Dynamic Client Registration on and Server URL `https://app.aggregate.finance`, then Connect and pick the companies and data it may read. Use it in all three.
2. **Claude Haiku 5.5**: add your Anthropic API key. Keep thinking off.
3. **Send email**: add SMTP credentials and set the from and to addresses.
4. **Settings**: days ahead and the smallest amount to list.
5. Run it once, then activate.

## Requirements
An Aggregate account (hosted, or your own server's `/mcp`), an Anthropic API key and an SMTP account.

## How to customize
Change the schedule, the window or the smallest amount. Swap the email node for Slack or Teams. Edit the prompt in Write a note to change what it flags.
```

Notes for the person submitting:
- New creators get one template in review at a time.
- Tested headless on n8n 2.42.7 against the public demo, three runs, 2026-11-02. Email itself was stubbed in the test, so the send step is untested.
