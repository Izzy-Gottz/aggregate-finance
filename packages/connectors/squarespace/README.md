# @agfn/connector-squarespace

Monthly Squarespace store sales per currency, as `report.snapshot` only. Nothing posts to the ledger, and core's
`provider_report` check skips it (`squarespace` in `NOT_BOOKS`). Shown in one place: the connection drawer's "Sales reported by
the store" line. No MCP tool reads it.

Built from Squarespace's Commerce API reference, OAuth page and published schema, read 2026-11-02. **It has never run against a
real site. The fixtures are hand-built from the docs, not recorded.**

## Rows

Each month, by the payment's `paidOn` on the site's clock, 12 months, recomputed on every run:

| Row | Source |
|---|---|
| Sales reported by the store | `payments[].amount`. What the customer paid, so tax, shipping and donations are in it |
| Refunds of sales | `payments[].refunds[].amount`, taken off the sale's month, not the refund's |
| Net sales reported by the store | The two above. The drawer shows this one |

Left out: voided Documents, and payments made with a gift card, because the card's own sale already counted. Refunds made outside
Squarespace (in Stripe, say) aren't in the API at all, so net sales can read high. Squarespace says so itself.

## Before the flag goes on

- **Developer Terms s.7.4.6.** Without written authorization, no processing for "profiling or other analysis of Customers".
  Squarespace must clear this in writing. Sending that question needs Yisrael's yes.
- **s.7.4.4**, "substantially replicate or otherwise compete": Squarespace's MCP looks up orders. Worth including in the question.
- **Production review.** New apps start in Demo Mode and going live means requesting a review. Limits and criteria aren't stated.
  s.1.5 means giving a free populated Demo Account on request.
- **The LLC.** s.15 is a broad uncapped indemnity. Under Yisrael's rule (2026-11-02) no registration until the LLC exists. The app
  hasn't been registered.
- **Policy 2.4 and 2.6.** Minimum data, and delete on cancellation. `squarespace` is in `ERASE_ON_DISCONNECT`.

## Registration

Developer Apps tab, OAuth app. Redirect `${BASE_URL}/api/connectors/squarespace/callback`. Permission: `website.transactions.read`.
Env: `SQUARESPACE_CLIENT_ID`, `SQUARESPACE_CLIENT_SECRET`, then `AGFN_OFFER_SQUARESPACE=1` on hosted.

## Unverified

1. The scope string `website.transactions.read` is accepted; it comes from the auth page, not the OAuth page's examples.
2. The token response doesn't name a scope, so a wider grant can't be refused. Only one is asked for.
3. `access_token_expires_at` is epoch seconds as a string. If it isn't a number, 30 minutes is assumed.
4. The token call accepts a form body with Basic credentials, id and secret unescaped.
5. `response_type=code` on the authorize URL is ignored or accepted; the docs don't list it.
6. A site must have an Extension installed by this flow; the docs say Extensions are required for OAuth, on any plan.
7. `modifiedAfter` and `modifiedBefore` work together and take the format sent. Orders docs require both; these docs don't say.
8. A cursor request takes no window. A stale cursor gives a 400 and the run restarts; if it gives something else, the sync stops.
9. `refunds[].amount` sign isn't documented: its size is used.
10. `refundedAmount` equals the sum of `refunds[]`. If a real order differs, every sync of that store stops. Check this first.
11. `voided` means nothing was kept. A voided order with money kept would read low.
12. `paidOn` is null on an unpaid payment, and always set on a paid one.
13. A gift-card payment has `giftCardId`, and the card's sale is a Document of its own. If not, sales read low.
14. `amount` is what the customer paid, before fees. `value` has at most the currency's decimals: more stops the sync.
15. Payments are in the store's currency, and a site's `currency` can change; old ones stay at zero.
16. `paymentGatewayError` is ignored. Its values are about fees and a disconnected gateway; a payment under one could be unreal.
17. Every paid Document was modified inside the window. An imported order could fall outside.
18. A POS sale through Square appears here too, and donations appear as Documents. Both count.
19. Where a person removes the app. The disconnect text says Settings → Extensions; the docs only say "the Squarespace UI".
20. The drawer picks this month in UTC and the snapshots use the site's clock, so the line can lag for hours at a month's start.
21. A large store reads every Document on each run, 50 a page at 240 a minute: 50,000 Documents take over 3 minutes.
22. A connection that goes 7 days without a sync loses its refresh token and must sign in again.

Tests: `npx vitest run packages/connectors/squarespace apps/server/src/store-sales.squarespace.test.ts`
