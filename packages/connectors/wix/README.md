# @agfn/connector-wix

Monthly Wix store sales per currency, as `report.snapshot` only. Nothing posts to the ledger, and core's `provider_report` check
skips it (`wix` in `NOT_BOOKS`). Shown in one place: the connection drawer's "Sales reported by the store" line. No MCP tool
reads it.

Built from Wix's eCommerce Orders reference, external install flow and authentication pages, read 2026-11-02. **It has never run
against a real site. The fixtures are hand-built from the docs, not recorded.** Aggregate's Wix app doesn't exist yet.

## Rows

Each month, by `purchasedDate` or else `createdDate` in UTC, 12 months, recomputed on every run:

| Row | Source |
|---|---|
| Sales reported by the store | `balanceSummary.paid`. Approved payments, so tax and shipping are in it |
| Refunds of sales | `balanceSummary.refunded`, taken off the sale's month, not the refund's |
| Net sales reported by the store | The two above. The drawer shows this one |

No order status is filtered on: paid less refunded holds for a cancelled order too, and an unpaid order adds nothing.

## Before the flag goes on

- **The company and the indemnity.** Developer Terms 11.3 and Partner Agreement 12.3 are uncapped, and 11.3 covers an "alleged
  breach". Wix's own liability stops at $100 and USD 50,000. Israeli law, Tel Aviv courts. No registration until the LLC has
  insurance quotes and 34 confirms. Accepting the terms is Yisrael's.
- **App Market review, or Wix's written approval.** A Share URL is for testing, 80 Users at most (4.4). Past that, an unlisted app
  needs prior written approval. A listing means review, including an AI review, which Wix can refuse at its sole discretion (6.4),
  and acknowledging the Partner Agreement at submission.
- **4.3.o and 5.7.** No app whose primary purpose is sharing Users' data with a third party, and no User Data in a third party's
  product without consent. Our reading: this is the owner's data going to the owner's own AI. A lawyer should confirm it.
- **Listing needs.** A demo account kept active, a privacy policy and Terms of Use that name Wix data, and a page users land on
  after install. The install currently lands in the app's connection drawer; check that this counts.
- **Billing.** Apps that collect money must use the Wix Billing System. It applies when Aggregate charges.
- **Security duties.** Tell Wix of a breach within 24 hours (5.5), answer claims within 24 hours (9.2).
- **Deletion.** Neither document requires deletion on uninstall; 5.9 says only as long as necessary. `wix` stays out of
  `ERASE_ON_DISCONNECT`, and only monthly totals are stored.

## Registration

Wix Dev Center, a new app. Under Permissions add **Read Orders and nothing else**: Wix sets permissions here, not in the install
link, so this step is what makes the app read-only at Wix. After OAuth setup, use the app ID as `WIX_CLIENT_ID` and the app secret
as `WIX_CLIENT_SECRET`. Set the install redirect to `${BASE_URL}/api/connectors/wix/callback` if the app asks for one. For an
unlisted test, `WIX_SHARE_URL_ID`. Then `AGFN_OFFER_WIX=1` on hosted.

## Unverified

1. Search Orders works with Read Orders alone, and an app with only that permission can't write. The scope's id isn't confirmed.
2. The redirect carries `instanceId` and `signedInstance`, and keeps `state`, as the install doc says.
3. `signedInstance` is checked with the HMAC the docs call legacy, over the base64 data. `signDate` must exist and be under an hour
   old. If Wix changes this, every connect fails, visibly. Token Info is the replacement and is barely documented.
4. The owner test: `permissions` is "OWNER", or `uid` equals `siteOwnerId`. An owner signed in some other way would be refused.
5. App ID is the OAuth client id, and the app secret is both the client secret and the HMAC key.
6. The token header is bare, as the docs' curl shows. If it needs "Bearer", every read gets 401.
7. Tokens last four hours; `expires_in` isn't read. A refused token is dropped and minted again on the next try.
8. A token mint refused with 400, 401 or 403 means the app was removed, so the person is told to connect again.
9. A cursor request takes no filter or sort. The docs don't say. A stale cursor gives a 400 and the run restarts; anything else
   stops the sync.
10. `archived: {$in: [true, false]}` is accepted and returns both. The docs list `$in` but don't say what a plain search returns.
11. `createdDate` takes the ISO string sent, and ascending sort works with it. It's a listed filter and default sort is DESC.
12. PENDING and REJECTED orders are left out by default, per the docs. Money on one would be missed.
13. `paid` includes later-refunded money, per the docs, and `refunded` is what came back. If `paid` drops on a refund, net reads low.
14. Chargebacks aren't subtracted. `balanceSummary.chargeback` exists, and its meaning next to `refunded` isn't stated. Net can read
    high on a store with chargebacks.
15. A gift card paying for an order may count in `paid`, after its own sale already counted. Net could read high.
16. Amounts are in the order's `currency`. An order with `currencyConversionDetails` may be shown in one currency and paid in
    another. Check this on a multi-currency store.
17. `paymentStatus` values are the 10 listed. A new one stops the sync, which is deliberate. So does `paid` missing on
    PENDING_MERCHANT, whose meaning isn't documented.
18. Months are UTC, because the time zone needs "Manage Your App". A sale near a month's end lands a month away from Wix's reports.
19. `purchasedDate` falls inside the order's window only if it's not later than `createdDate`. An import dated older than 12 months
    is left out, correctly.
20. Where a person removes the app. The disconnect text says the site dashboard's Apps page; no doc states the path.
21. A large store reads every order on each run, 100 a page at 4 pages a second. The limit isn't published.
22. A store with no orders sends no snapshots, since there's no currency to file them under without another permission.
23. A site with more than one store currency, or with non-eCommerce sales such as Bookings, may not all be in Search Orders.

Tests: `npx vitest run packages/connectors/wix apps/server/src/store-sales.wix.test.ts`
