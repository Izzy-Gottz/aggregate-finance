# Aggregate for Zapier

A read-only Zapier integration built on Aggregate's REST API (`/v1`, the same operations as the MCP tools; reference at
[/docs/api](https://app.aggregate.finance/docs/api)). It adds nothing to the server, and it can't record anything or
move money.

| Zapier piece | Type | Calls |
| --- | --- | --- |
| Aggregate key (+ optional server address) | API key auth | `GET /v1/whoami` |
| New Transaction | Polling trigger | `GET /v1/transactions` (newest 100; Zapier deduplicates by id) |
| New Item to Review | Polling trigger | `GET /v1/review` |
| Get Cash and Runway | Search | `GET /v1/overview?company=…` |
| Find Upcoming Payments | Search | `GET /v1/upcoming?days=…` |

Money fields are flattened for Zaps: `amount` is `"1234.56 USD"` and `amount_value` is `"1234.56"` (negative = money
out). Text written by third parties (bank memos, review questions) arrives as plain text.

## Without this integration

"MCP Client by Zapier" can already call `https://app.aggregate.finance/mcp` with an Aggregate key as a bearer token.

## Develop and test

```sh
cd integrations/zapier && npm install
npm test                      # schema check only
# Live checks against a local demo (prints a key):
npx aggregate-finance demo
AGFN_ZAPIER_TEST_KEY=agfn_live_… AGFN_ZAPIER_TEST_URL=http://127.0.0.1:8787 npm test
```

## Publish (Yisrael's Zapier login)

1. `npx zapier-platform-cli login`, then `npx zapier-platform-cli register "Aggregate"` (first time) and
   `npx zapier-platform-cli push`.
2. Publishing needs these, per Zapier's requirements:
   - an admin with an `@aggregate.finance` email;
   - a live, successful test Zap for every trigger and search, against production;
   - a non-expiring reviewer account for integration-testing@zapier.com (a reviewer access link);
   - the public API docs at /docs/api;
   - the product launched, not beta.
3. Listing: description "Aggregate is a read-only finance hub that brings a company's banks, cards, Stripe, books and
   payroll together as one set of numbers." (134 characters); category Accounting; logo: the mark as a 512×512
   transparent PNG.

Details: [docs/compliance/marketplaces.md](../../docs/compliance/marketplaces.md) §4.
