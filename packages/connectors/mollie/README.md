# @agfn/connector-mollie

Mollie's own monthly balance report per currency, as `report.snapshot` only. Nothing posts to the ledger, and core's
`provider_report` check skips it (`mollie` in `NOT_BOOKS`). Shown in one place: the connection drawer's "Net from sales in
Mollie" line. No MCP tool reads it.

Built from Mollie's OAuth guide, permissions page and OpenAPI reference, read 2026-11-03. **It has never run against a real
account. The fixtures are hand-built from the docs, not recorded.**

## Rows

`GET /v2/balances/{id}/report?grouping=transaction-categories`, one call per balance per month, 12 months on Amsterdam's
clock (the only zone Mollie's reports use). Each kind is its `pending` plus `immediatelyAvailable` amount; `movedToAvailable`
moves money already counted, so it's left out.

| Row | Mollie kind |
|---|---|
| Payments, Refunds, Chargebacks, Mollie fees | `payments`, `refunds`, `chargebacks`, `fee-prepayments` |
| Net from sales, after Mollie fees | Those four. The drawer shows this one |
| Corrections, Mollie Capital, Top-ups | `corrections`, `capital`, `topups` |
| Paid out to your bank | `transfers` |
| Mollie balance at month end | `close`, pending plus available |

Checks, each of which stops the sync with a message rather than show a number: opening balance plus every kind must equal
the closing balance to the cent; a kind not in the docs' list; an amount in a currency other than the balance's, or with more
decimals than the currency; a missing opening or closing balance; a 403 or 404; a currency reported before with no balance
now (its months are never rewritten as zero; the message says to disconnect and connect again, which starts a new
connection with no cursor).

Balances that share a currency are added together. `testmode` is never sent, so test data never reaches a live connection.

## Before the flag goes on

- **Uncapped indemnity.** User Agreement art. 8.2. Build-only until the LLC, insurance quotes and 34's confirmation. No app
  has been registered. Creating the app needs a Mollie account, which means accepting that agreement: Yisrael's step.
- **Partner Terms** (2026-09-07) only if Aggregate joins the Partner Programme: art. 5 non-solicit, art. 6 no gateway fees.
- A real-account test, checking the unverified points below first.
- Not in `ERASE_ON_DISCONNECT`: no deletion clause was found for OAuth apps.

## Registration

Mollie Developers, Your apps, Create application. Redirect `${BASE_URL}/api/connectors/mollie/callback`. Scopes are asked for
in the authorize URL: `balances.read balance-reports.read`. Env: `MOLLIE_CLIENT_ID` (`app_…`), `MOLLIE_CLIENT_SECRET`, then
`AGFN_OFFER_MOLLIE=1` on hosted.

## Unverified

1. A kind's month is `pending` plus `immediatelyAvailable`. The docs' third example reconciles this way to the cent; their first example is off by €0.30, which this rule would stop on. If real reports are like the first, every sync stops. Check this first.
2. `until` for the current month may be tomorrow (exclusive). If Mollie refuses a date past today, the current month fails.
3. The token response's `scope` lists exactly what was granted. If it's missing, a wider grant can't be refused; only two scopes are asked for.
4. Refresh tokens don't rotate; if they do, the new one is saved anyway.
5. `balance-reports.read` reaches the reports of every balance `balances.read` lists.
6. Amounts are decimal strings with the currency's places, and every amount in a balance's report is in that balance's currency.
7. `fee-prepayments` are Mollie's fees taken from the balance before its invoice; fees invoiced separately wouldn't show here.
8. A month with no movement still returns `open` and `close`.
9. Disconnect revokes with `DELETE /oauth2/tokens`, Basic credentials and a JSON body; the access token lapses within the hour.
10. Rate limits aren't documented here; 2 a second is assumed. Twelve months for each balance is 12 calls per balance per run.

Tests: `npx vitest run packages/connectors/mollie apps/server/src/store-sales.mollie.test.ts`
