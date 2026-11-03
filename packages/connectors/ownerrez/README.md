# @agfn/connector-ownerrez

Monthly payments collected in OwnerRez, as `report.snapshot` only. Nothing posts to the ledger, and core's `provider_report`
check skips it (`ownerrez` in `NOT_BOOKS`). Shown in one place: the connection drawer's "Collected in OwnerRez" line. No MCP
tool reads it.

Built from OwnerRez's API v2 reference, OpenAPI file and OAuth guide, read 2026-11-03. **It has never run against a real
account. The fixtures are hand-built from the docs, not recorded.**

## Rows

Each month on the account's clock (`users/me` `time_zone`), 12 months, recomputed on every run. A missing or unknown time
zone stops the sync and the connect with a message; it is never guessed as UTC:

| Row | Source |
|---|---|
| Payments collected in OwnerRez | `payments[].amount` by `collected_utc`, chargebacks left out |
| Refunds paid | `refunds[].amount` by `paid_utc`, size only |
| Chargebacks | payments of type `chargeback`, size only |
| Net collected in OwnerRez | The three above. The drawer shows this one |
| Processing fees on those payments | `payments[].total_fees`, outside the net |

Totals only: no guest, booking or property names are read or kept. This is money OwnerRez recorded, not booked revenue: OTA
payouts and card deposits reach the bank, which may be connected too.

## Currency

Payments and refunds carry no currency. It comes from the properties (`/v2/calendar` `currency_code`). One currency across
every property is reported; more than one, or a property without one, stops the sync with a message. It never reads as $0.
A currency reported before that the properties no longer use stops the sync too: its months are never zeroed or moved to
the new currency. The message says to disconnect and connect again, which starts a new connection with no cursor.

## Before the flag goes on

- **Partnership agreement.** OwnerRez's API docs say an app needs one before it reads other users' accounts. Asking needs
  Yisrael's yes, as Aggregate Finance LLC.
- **Terms.** Read 2026-11-03: no indemnity clause, Wyoming law, no AI clause. s.5.3 allows access only through what OwnerRez
  provides, which the API and a registered app are. Recheck when the agreement arrives: it may add its own.
- **A real-account test**, checking the unverified points below first.
- Not in `ERASE_ON_DISCONNECT`: no deletion clause was found in the terms (read 2026-11-03) or the OAuth app docs (rechecked
  2026-11-03, which cover revoke and the `application_authorization_revoked` webhook only). Revisit with the agreement.

## Registration

OwnerRez Developer/API Settings, OAuth app, scope Read (fixed at creation). Redirect
`${BASE_URL}/api/connectors/ownerrez/callback`. Env: `OWNERREZ_CLIENT_ID`, `OWNERREZ_CLIENT_SECRET`, then
`AGFN_OFFER_OWNERREZ=1` on hosted.

## Unverified

1. Payments include OTA (Airbnb, Vrbo) channel collections, or only ones OwnerRez processed. If they include channel payouts, the line can double a bank deposit's meaning; it's still only a report.
2. A chargeback's `amount` sign. Its size is used.
3. A refund's `amount` sign. Its size is used.
4. A negative payment that isn't a chargeback doesn't happen. If one comes, the sync stops.
5. `collected_utc` is null on an uncollected payment. Those are skipped.
6. `/v2/calendar` lists inactive properties by default. If not, a closed property in another currency is missed.
7. Security deposits aren't a payment type here. If they are, collected reads high.
8. `total_fees` is what the processor kept, in the same currency, positive.
9. `since_utc` filters by when a payment was created or changed. The run reads from 12 months before the first reported month, so a payment collected in the window but created earlier than that is missed; each one read counts in the month it was collected, and months outside the 12 are dropped.
10. The token response's `scope` is the literal `read`. Anything else is refused at connect.
11. Revoke is `DELETE /oauth/access_token/{token}` with Basic client credentials. The docs describe it for one token and don't say
    whether revoking the access token ends its refresh token, so disconnect revokes both; a 404 on the refresh token is read as
    already ended. Any other failure tells the person how to remove the app.
12. 300 requests per 5 minutes is per IP, so every hosted connection shares it.
13. Refresh tokens: access tokens last 30 days; renewal is attempted a day early.

Tests: `npx vitest run packages/connectors/ownerrez apps/server/src/store-sales.ownerrez.test.ts`
