# @agfn/connector-whop

Whop's own monthly income statement per currency, as `report.snapshot` only. Nothing posts to the ledger, and core's
`provider_report` check skips it (`whop` in `NOT_BOOKS`). Shown in one place: the connection drawer's "Net in Whop" line. No
MCP tool reads it.

Built from Whop's OAuth guide, permissions guide and OpenAPI reference (API version `2026-11-02-1`), read 2026-11-03. **It has
never run against a real business. The fixtures are hand-built from the docs, not recorded.**

## Rows

`GET /financial_reports?report_type=income_statement`, one call per currency over 12 UTC months, `group_by=month`:

| Row | Source |
|---|---|
| Payments, Refunds, Disputes, Fees, ... | Whop's `grouping` families, summed per month, in Whop's sign. Only families seen in the 12 months are shown |
| Net from Whop's income statement | The sum of the families. The drawer shows this one |

Checks, each of which stops the sync with a message rather than show a number: the rows must add up to the report's `total`
to the cent; a family not in the docs' list; an amount with more decimals than its currency; a currency that isn't an
ISO code (crypto balances, `btc` included); USD rows when the currency list doesn't name USD; a missing currency list; a currency reported before that the list no
longer names (its months are never rewritten as zero; the message says to disconnect and connect again, which starts a new
connection with no cursor); a 403 (scope) or 404 (no ledger).

No currency conversion: `in_currency` is never sent. A business with no activity reports nothing, not zeros.

## Before the flag goes on

- **Uncapped indemnity.** Developer API Terms s.16. Build-only until the LLC, insurance quotes and 34's confirmation. No app has
  been registered.
- **s.10 data rules.** Use only to provide the app, no derived data to third parties, delete within 30 days of uninstall:
  `whop` is in `ERASE_ON_DISCONNECT`.
- **s.4.** No replicating Whop. Whop has its own MCP server; a totals report is not that, but worth asking about.
- **Generative-AI review.** If Whop reviews or lists apps, ask how an AI-assistant connector is treated, with Yisrael's yes.
- A real-business test, checking the unverified points below first.

## Registration

Whop Developer Dashboard, create an app, OAuth section: redirect `${BASE_URL}/api/connectors/whop/callback`, scope
`company:balance:read` only. Env: `WHOP_CLIENT_ID` (`app_…`), `WHOP_CLIENT_SECRET`, then `AGFN_OFFER_WHOP=1` on hosted.

## Unverified

1. `company:balance:read` is offered as an OAuth scope. The OAuth guide only shows `openid profile email`, and the dashboard's scope list isn't public. Whop support wrote on 2026-10-15 (thread 1a13d39332ed8c6d) that an app needs no special deal: build it, have the creator authorize with OAuth, and "request read scopes such as stats:read". So permission strings work as OAuth scopes; this exact one still needs checking in the dashboard.
2. The token call takes a JSON body with `client_secret` alongside PKCE. The guide's example sends no secret.
3. The token response names the granted scope. If it doesn't, a wider grant can't be refused; only one scope is asked for.
4. List Accounts on a user token returns only that user's business accounts. More than one is refused for now.
5. The report's `period` is `YYYY-MM` for `group_by=month`, and `from`/`to` as UTC instants bucket by UTC month.
6. `currencies` lists every currency the business has had money in (lifetime), so the USD read finds the rest.
7. A USD report for a business that never had USD returns empty rows, not a 404.
8. Report amounts are JSON numbers with at most the currency's decimals. If Whop sends float noise (0.30000000000000004), the sync stops.
9. `total` is the sum of every row in the window, all periods together.
10. Families' signs: revenue positive, costs and refunds negative, as the example suggests. The net is their sum either way.
11. The income statement leaves out balance moves that aren't P&L (withdrawals, transfers). If they appear, they're shown as their own families.
12. Refresh tokens rotate; the new pair is saved before any read. The refresh call needs no `company_id`, since none is sent at authorize.
13. Revoke takes the refresh token in a JSON body with the client credentials; the access token lapses within the hour.
14. Rate limits for the report endpoint aren't documented; 2 a second is assumed.

Tests: `npx vitest run packages/connectors/whop apps/server/src/store-sales.whop.test.ts`
