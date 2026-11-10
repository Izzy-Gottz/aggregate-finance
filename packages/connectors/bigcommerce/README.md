# @agfn/connector-bigcommerce

Monthly sales reported by a BigCommerce store, as `report.snapshot` only. Nothing posts to the ledger, and core's
`provider_report` check skips it (`bigcommerce` in `NOT_BOOKS`). Shown in one place: the connection drawer's "Sales reported
by the store" line. No MCP tool reads it.

Built from BigCommerce's public API reference and API Terms, read 2026-11-03. Nothing was registered and no live API was
called. **It has never run against a real store. The fixtures are hand-built from the docs, not recorded.**

## Auth

The merchant's own store-level API account, pasted: the API path (or the store hash in it) and the access token, from
Settings > Store-level API accounts. Two scopes, both read-only: Orders (`store_v2_orders_read_only`) and Information &
Settings (`store_v2_information_read_only`, for the time zone and currencies). Every other scope at None.

Or the **single-click app** (`src/app.ts`, server side `apps/server/src/bigcommerce-app.ts`), on when `BIGCOMMERCE_CLIENT_ID`
and `BIGCOMMERCE_CLIENT_SECRET` are set. The app profile asks for the same two read-only scopes. Callbacks:

| Callback | URL | What it does |
|---|---|---|
| Auth | `${BASE_URL}/api/connectors/bigcommerce/auth` | Trades the code for the store's token at login.bigcommerce.com. Refuses any grant with a scope that isn't `*_read_only` (or `users_basic_information`), on the callback and again on the token response. Seals the token in `bigcommerce_pending_installs` and shows a one-time "Connect to Aggregate" link (new tab) |
| Load | `${BASE_URL}/api/connectors/bigcommerce/load` | Verifies `signed_payload_jwt` (HS256 with the client secret; `aud`, `iss: bc`, `exp`, `nbf`, `sub: stores/{hash}`). Says whether the store is connected, with a fresh link while it isn't |
| Uninstall | `${BASE_URL}/api/connectors/bigcommerce/uninstall` | Same check. Every live connection for the store ends with its data deleted (`eraseRevoked`), and a waiting token goes |
| Remove user | `${BASE_URL}/api/connectors/bigcommerce/remove_user` | Same check. Nothing to do: no BigCommerce users are kept |

The link works once, for 15 minutes, and only for an Aggregate person signed in with the installer's BigCommerce email
(from the token response). It survives sign-in in a cookie (`/api/me` → `pendingInstall: 'bigcommerce'`), then
`/api/connectors/bigcommerce/install/resume` makes the connection, or puts the new token into this store's connection if it
needs reconnecting. The pages are framed only by `*.bigcommerce.com` / `*.mybigcommerce.com` and run no script. The app is
behind the same `AGFN_OFFER_BIGCOMMERCE` flag as the pasted token. Disconnecting in Aggregate can't uninstall the app; it
says to uninstall it in Apps → My Apps. Unverified against a real install: the JWT's algorithm (HS256 per BigCommerce's own
SDKs, the docs don't say) and whether the token response always names the installing user.

BigCommerce doesn't report a store-level token's scopes over the API, so a token that can write can't be told apart and
refused. Instead `client.ts` sends GET only (anything else throws before it leaves), and connect returns a warning saying the
scopes weren't checked. Disconnect can't delete the API account; it tells the person where to.

## Rows

Each month on the store's clock (`/v2/store` `timezone.name`), 12 months, recomputed on every run. A missing or unknown time
zone stops the sync and the connect with a message; it is never guessed as UTC:

| Row | Source |
|---|---|
| Orders placed in BigCommerce | `/v2/orders` `total_inc_tax` by `date_created`, statuses 2, 3, 4, 8, 9, 10, 11, 13, 14 |
| Refunds | `/v3/orders/payment_actions/refunds` `total_amount` by `created`, only when the order counts |
| Net sales reported by BigCommerce | The two above. The drawer shows this one |

Left out: statuses 0 Incomplete, 1 Pending, 5 Cancelled, 6 Declined, 7 Awaiting Payment, 12 Manual Verification Required,
orders marked `is_deleted`, and any status id not in BigCommerce's list (counted in a warning). A refunded order still counts
as sold, with its refund off in the refund's own month. Totals include tax, shipping and handling. Disputes aren't taken off.

**No fees, no payouts.** BigCommerce has no payout or fee scope. Order transactions (`/v3/orders/{id}/transactions`) give an
amount, gateway and currency but no fee, so they aren't read. What a payment provider kept is only in that provider. Payouts
reach the bank, which may be connected too, so nothing here is revenue.

Totals only: no buyer names, emails or addresses, no refund reasons, and none of the store owner's details are read into an
event or raw.

## Currency

Each order counts in its `default_currency_code` (the currency the shopper paid in); a refund in its order's. Currencies are
never added together: each gets its own snapshots. An order in a currency the store doesn't list (`/v2/currencies` plus the
store default) stops the sync with a message. A currency reported before that the store no longer lists stops the sync too:
its months are never zeroed or moved to another currency. The message says to disconnect and connect again, which starts a new
connection with no cursor. Amounts must be exact in the currency's minor unit; anything else stops the sync, never $0.

## Before the flag goes on

- **Terms answers.** Our terms questions to BigCommerce (asked 2026-11-02) are unanswered. The API Terms (revised 2025-07-31)
  speak of "your API client" and "Your Users"; whether they bind a merchant's own store-level token used through Aggregate
  isn't said. s.1.3 forbids exceeding reasonable request volumes; s.3.1.1 forbids an API client that "functions substantially
  the same as the APIs". No indemnity clause on that page; it incorporates the Master Services Agreement, not read here.
- **Deletion.** s.2.1: "You must delete all personal data you have collected from Your User through your API client (i) upon
  request from Your User, or (ii) when Your User deauthorizes your application or closes its account with you." `bigcommerce`
  is in `ERASE_ON_DISCONNECT`, and only monthly totals are stored.
- **A real-store test**, checking the unverified points below first.
- Then `AGFN_OFFER_BIGCOMMERCE=1` on hosted. Self-hosted offers it already.

## Unverified

1. Scopes can't be read back. BigCommerce documents no call that names a store-level token's scopes, so a write-capable
   token can't be refused at connect. The docs also say the `default` scope (webhooks) is on every API account and isn't
   read-only, so no token is strictly read-only. GET-only is the guard.
2. `GET /v3/orders/payment_actions/refunds` lists every refund on the store, including ones made in the control panel, under the
   Orders read-only scope (the docs list `store_v2_orders_read_only` among the scopes that reach it). Refunds made before
   that API existed, or outside BigCommerce at the processor, may not be in it. So each Refunded (4) or Partially Refunded
   (14) order placed in the 12 months has its V2 `refunded_amount` checked against its refund records; a mismatch is counted
   in a warning ("N orders are marked refunded in BigCommerce with no matching refund record; their refunds aren't taken
   off"), and only the records come off, since only they say which month a refund fell in. A 4 or 14 order with no
   `refunded_amount` stops the sync.
3. `total_amount` is the whole refund, tax and shipping included, and a refund with a declined payment still has one. Its
   `payments` aren't read.
4. The page size: `limit=250` is asked for on both lists; the docs give the default (50) but no maximum. A run reads until a
   page comes back empty (a 204 with no body is read as empty too; the docs don't say V2 sends one), so a smaller page only means more calls. Whether 250 is refused with a 400 isn't known.
5. The V3 refunds `meta` is documented as empty; no pagination fields are read.
6. `/v2/orders` leaves out archived orders without `is_deleted`; `is_deleted: true` rows are skipped if they come.
7. `min_date_created` and `created:min` take an ISO instant in UTC. Both lists start two days before the first month so every
   time zone's first day is in; rows outside the 12 months are dropped.
8. `date_created` on orders is RFC-2822 UTC, as the docs say. `created` on refunds is RFC 3339.
9. `total_inc_tax` is a decimal string in the order's transactional currency, not the display currency, including for
   multi-currency stores. Its four places are zeros past the currency's own.
10. Which statuses count. The docs mark 11 Awaiting Fulfillment as paid; 2, 3, 8, 9 and 10 come after payment; 13 Disputed is a
    PayPal dispute on a paid order. 7 Awaiting Payment and 12 Manual Verification Required are left out.
11. A refund whose order BigCommerce no longer returns (404) isn't counted, as its sale isn't either.
12. A currency the store deletes stops the sync even though its old orders may still be listed. A disconnect and connect starts fresh.
13. Rate limits are per store and shared by every app (150 per 30 seconds on Growth and Core). A 429 waits
    `X-Rate-Limit-Time-Reset-Ms`.
14. The access token format (alphanumeric, 20 to 64 characters) and store hash format are taken from examples, not a spec.

## Docs read

- [List Orders](https://docs.bigcommerce.com/developer/api-reference/rest/admin/management/orders/get-orders) and
  [Get Order](https://docs.bigcommerce.com/developer/api-reference/rest/admin/management/orders/get-order)
- [List Order Statuses](https://docs.bigcommerce.com/developer/api-reference/rest/admin/management/orders/order-status/get-order-statuses)
  and the [Orders overview](https://docs.bigcommerce.com/developer/docs/admin/checkout-and-cart/orders/overview)
- [List Refunds](https://docs.bigcommerce.com/developer/api-reference/rest/admin/management/order-operations/payment-actions/get-orders-refunds)
- [List Transactions](https://docs.bigcommerce.com/developer/api-reference/rest/admin/management/order-operations/get-order-transactions)
- [Get Store Information](https://docs.bigcommerce.com/developer/api-reference/rest/admin/management/store-information/v2/get-store-information)
- [List Currencies](https://docs.bigcommerce.com/developer/api-reference/rest/admin/management/currencies/get-currencies)
- [API Accounts and OAuth scopes](https://docs.bigcommerce.com/developer/docs/overview/api-fundamentals/api-accounts)
- [Rate limits](https://docs.bigcommerce.com/developer/docs/overview/api-fundamentals/rate-limits)
- [API Terms](https://www.commerce.com/terms/api-terms/)

Tests: `npx vitest run packages/connectors/bigcommerce apps/server/src/store-sales.bigcommerce.test.ts`
