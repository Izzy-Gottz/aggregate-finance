# @agfn/connector-amazon

Each settlement Amazon has paid a seller, as `processor.balance_txn` rows on an Amazon balance per currency, from the Selling
Partner API's Finances API v0. Rows post to the ledger like Shopify's payout summaries; the payout row is matched to the bank
deposit by core.

Built from Amazon's public docs and its published API models, read 2026-11-05. **It has never run against a real seller
account. The fixtures are hand-built from the model, not recorded.** Amazon is named in text only: no logo, no Appstore badge
(apps/web/src/ui/brand/README.md).

**US store only for now**: the North America endpoint (`sellingpartnerapi-na.amazon.com`), `sellercentral.amazon.com`, and
marketplace `ATVPDKIKX0DER`. `AMAZON_REGION` in `client.ts` is the one place a region changes.

## Auth

Aggregate's registered SP-API app: public, Draft, the **Finance and Accounting** role only, no restricted data (so no
Restricted Data Token and no buyer personal data). Set `AMAZON_SPAPI_APP_ID`, `AMAZON_SPAPI_CLIENT_ID` and
`AMAZON_SPAPI_CLIENT_SECRET`; without all three there's no Amazon connector. Register both of the app's URIs:

- Redirect URI: `${BASE_URL}/api/connectors/amazon/callback`
- Log-in URI: `${BASE_URL}/api/connectors/amazon/login`

Amazon's [website authorization workflow](https://developer-docs.amazon.com/sp-api/docs/website-authorization-workflow):

1. `begin()` sends the person to `https://sellercentral.amazon.com/apps/authorize/consent?application_id=…&state=…&version=beta`.
2. After consent Amazon calls the **log-in URI** with `amazon_callback_uri`, `amazon_state` and `selling_partner_id`. The
   server (app.ts) finds the person's own connect state (started in the last 10 minutes, Amazon's limit for the whole flow)
   and sends the browser back to Amazon's confirm page with `amazon_state`, `state`, `redirect_uri` and `version=beta`
   (`amazonLoginRedirect`; anything but `https://amazon.com/apps/authorize/confirm/…` or Seller Central's host is refused).
3. Amazon calls the callback with `state`, `selling_partner_id` and `spapi_oauth_code`; `connect()` exchanges the code at
   `https://api.amazon.com/auth/o2/token` (form-encoded, client id and secret in the body) within its five minutes, and reads
   one settlement page to prove the role.

The refresh token is long-lived and isn't rotated; the one-hour access token is renewed before a sync and saved. Calls send
`x-amz-access-token`, `x-amz-date` and a `user-agent`; no AWS Signature V4 (Amazon's "Connect to the SP-API" page calls the
API "with a URI and headers but no signing information").

While the app is Draft every hop carries `version=beta` (`AMAZON_SPAPI_DRAFT`, on unless `0`). Set it to `0` once the app is
published.

An Appstore-initiated sign-in (the app isn't listed, so this shouldn't happen) reaches the log-in URI with no connect state;
the person is sent to the app with "Start from Aggregate: Connections → Add → Amazon." Someone not signed in to Aggregate gets
the API's plain "Please sign in."

Read-only by construction: `client.ts` wraps its fetch in `getOnly`, so anything but GET throws before it leaves. The only POST
is the token call, which goes through the SDK's OAuth helper on its own fetch.

Disconnect can't end the authorization (Amazon has no revoke call; only the seller can). It tells the person: "In Seller
Central, open Apps and Services → Manage Your Apps and choose Disable authorization for Aggregate."

## Rows

Per closed settlement (financial event group) with `FundTransferStatus` `Succeeded`, one row per non-zero category, plus the
payout. External ids are `<FinancialEventGroupId>#<category>`; every row has `payoutExternalId` = the group id.

| Row | Kind | What's in it |
|---|---|---|
| `#sales` | charge | Principal, ShippingCharge, Giftwrap, Discount and COD charges on shipments, less their promotions; FBA liquidation proceeds; removal-order revenue |
| `#fees` | fee | Every FeeComponent outside refunds and disputes (referral, FBA, service fees), Sponsored Products, deals, coupons, Early Reviewer, value-added services, capacity reservation, fee corrections |
| `#refunds` | refund | RefundEventList: charge and promotion adjustments as gross; the fee Amazon hands back, less its refund administration fee, as a negative fee |
| `#disputes` | dispute | ChargebackEventList and GuaranteeClaimEventList, the same way |
| `#tax` | adjustment, `salesTax` | Every tax charge with every MarketplaceFacilitator tax withheld, retrocharges, removal-order tax less what Amazon withheld. Where Amazon collects and remits, these net to zero |
| `#adjustments` | adjustment | Everything else that moves the balance: reimbursements, other adjustment events, debt recovery, direct payments, ad hoc disbursements, income tax withheld, other charge types on shipments |
| `#reserve` | adjustment, `other_assets` | AdjustmentEventList `ReserveEvent`: money held back, still the seller's |
| `#loan` | adjustment, `other_liabilities` | LoanServicingEventList |
| `#carried_in` | adjustment, `other_assets` | BeginningBalance, only when needed for the check below |
| `#payout` | payout | net = −OriginalTotal, `at` and `arrivalDate` the FundTransferDate, `linkRefs.trace_id` the TraceId |

Category rows are dated at `FinancialEventGroupEnd`. Each settlement nets to zero on the Amazon balance. No
`balance.snapshot` is sent: the balance is the sum of its rows.

Open settlements send nothing: their rows don't exist yet, and a balance for them would stand against an empty ledger. A
closed settlement whose transfer hasn't succeeded waits, with a warning; it's recorded once it has.

## The accuracy check

A settlement's categories must add up exactly, in minor units, to its `OriginalTotal`. If they don't, the group's
`BeginningBalance` is tried as money carried in (sent as `#carried_in`). Neither: **the sync stops** with "Amazon's
settlement paid on <date> doesn't add up: its events come to X, but Amazon says it paid Y. This sync stopped before recording
it, so nothing from that settlement was recorded, and the settlements before it are unchanged."

Stopping, not an `#unexplained` row: a gap means a category was read wrongly somewhere, so the settlement's revenue, fees and
refunds are all suspect, and a balancing line would let the payout still match the bank and hide it.

Amounts are added as Amazon signs them, never by absolute value, so a misread sign fails the check instead of hiding. An
amount with places its currency doesn't have, an amount in another currency inside a settlement, or an event list this
connector doesn't know stops the sync too.

## Currency

One Amazon balance per currency (`amazon:<sellerId>:<currency>`); currencies are never added together. A settlement's
currency is its `OriginalTotal`'s. `ConvertedTotal` isn't read.

## Cursor

The first run lists settlements that opened in the last 540 days (Amazon keeps a group's events two years). Each later run
lists those that opened since 35 days before the previous run started: settlements close and transfer days after they open.
One page per sync step (100 settlements, then 100 events), the running category totals in the cursor. Settlements already
recorded are listed but not read again; the list of them is kept to the window. 429 waits one request at the rate in
`x-amzn-RateLimit-Limit` (0.5 per second by default); 401 and 403 ask for a new sign-in in words written here.

## Stored

Raw (`amazon.settlement`): the settlement's id, currency, totals, dates and trace id, and its category totals. No order ids,
SKUs, ASINs, product or store names, account tail, or anything about buyers. The Finance and Accounting role carries no buyer
names, emails or addresses to begin with.

`amazon` is in `ERASE_ON_DISCONNECT`: Amazon's [Data Protection Policy](https://sellercentral.amazon.com/mws/static/policy?documentType=DPP&locale=en_US)
s.1.7 requires deleting all Information within 30 days of the earliest of Amazon's notice, the seller revoking
authorization or removing our access, or our access ending.

## Before the flag goes on

- **A real Draft self-authorization test** with a US seller account (Seller Central → Apps and Services → Develop Apps →
  Authorize, or the website flow with `version=beta`): consent, the log-in hop, the callback, one full sync, and every
  settlement passing the check. This needs a seller account; there isn't one yet.
- **Revocation in Seller Central.** A seller who disables authorization there, without disconnecting here, shows as a
  401/403 at the next sync. DPP s.1.7 still wants their data deleted within 30 days; nothing does that automatically yet.
- **Data Protection Policy and Acceptable Use Policy** read in full against hosting (encryption at rest, the 30-day deletion,
  incident contact, the security assessment Amazon may ask for), and the Solution Provider Portal Agreement against the LLC.
- Publish the app, then `AMAZON_SPAPI_DRAFT=0`, then `AGFN_OFFER_AMAZON=1` on hosted.

## Sandbox probe (staging only)

`src/sandbox-probe.ts` checks the plumbing against Amazon's static sandbox: an LWA token from a Sandbox app's refresh
token, then the two Finances calls with the exact parameters the sandbox answers, then the settlement reader on the canned
events. It proves no numbers (the canned settlement and events don't belong together) and creates no connection. It runs
on staging only (`FLY_APP_NAME=aggregate-stg`, or `BASE_URL` is the staging address on any host) and prints statuses and counts, never a token or an amount:

    fly ssh console -a aggregate-stg -C "node packages/connectors/amazon/src/sandbox-probe.ts"

It needs `AMAZON_SPAPI_SANDBOX_CLIENT_ID`, `_CLIENT_SECRET` and `_REFRESH_TOKEN` in aggregate-stg's secrets.

## Unverified

1. `FundTransferStatus` values. The model doesn't enumerate them; its sandbox example says `TRANSFERED` (and
   `ProcessingStatus` `PROCESSED`, against the model's `Open`/`Closed`). Only `Succeeded` is taken as paid, unverified until a real
   seller's settlements confirm it. If they say something else, they wait with the warning, never post.
2. BeginningBalance. The model calls it "the balance at the start of the settlement period" and doesn't say whether
   OriginalTotal includes it. It's used only when the events alone don't match, and read as the last settlement's reserve
   coming back (`other_assets`). A carried negative balance would be filed the same way.
3. Signs not stated in the model: Sponsored Products `transactionValue`, deals, coupons, Early Reviewer, debt recovery,
   ad hoc disbursements, income tax withheld, removal-order adjustments. Taken as signed into the balance; the check catches
   a wrong one. FBA liquidation fees are taken as a cost whichever way they're signed ("the seller receives this amount
   minus LiquidationFeeAmount"); removal-order `TaxWithheld` is subtracted from `TaxAmount`.
4. `ShipmentSettleEventList` is read like shipments. If it repeats ShipmentEventList, the check fails.
5. Amazon Points (`CostOfPointsGranted`/`Returned`, Japan only) are read as a cost and a return.
6. Deferred transactions: the docs say they don't appear in a group's events until released. Whether a closed group's
   OriginalTotal can include events listed elsewhere is unknown; the check would stop on it.
7. Events for a group older than two years come back empty, and its check would fail: the first run's 540 days stays inside.
8. A closed, succeeded settlement is taken as final and never read again. If Amazon reverses a transfer later, it isn't seen.
9. The FundTransferDate is when the transfer started; ACH takes 3 to 5 business days. core looks up to 10 days ahead for a
   deposit whose text names Amazon (`amazon` or `amzn`, scored 0.97 like the other processors) and 7 for one that doesn't
   (0.85). The bank's exact wording for a seller deposit isn't confirmed from a real statement.
10. 403 is treated as "connect again" (`auth`): Amazon's error guide lists an expired or revoked authorization and a missing
    role as its causes.
11. The log-in hop: the docs put it in the website flow (steps 5 to 8). Whether Amazon skips it when an app has no log-in
    URI isn't tested; the callback works either way.
12. Seller ids are taken as 6 to 32 letters and digits, from examples.

## Not built

The Finances API v2024-06-19 (`listTransactions`, `listSummary`) gives per-transaction rows with "related identifiers" and a
settlement summary. v0 gives every category needed here, so it isn't used. No MCP tool, no UI, no setup guide (an SP-API app
needs Amazon's developer approval, which a self-hoster would have to get themselves).

## Docs read

- [Website Authorization Workflow](https://developer-docs.amazon.com/sp-api/docs/website-authorization-workflow)
- [Connect to the SP-API](https://developer-docs.amazon.com/sp-api/docs/connecting-to-the-selling-partner-api)
- [SP-API Endpoints](https://developer-docs.amazon.com/sp-api/docs/sp-api-endpoints)
- [Usage Plans and Rate Limits](https://developer-docs.amazon.com/sp-api/docs/usage-plans-and-rate-limits)
- [Revoke Authorizations](https://developer-docs.amazon.com/sp-api/docs/revoke-authorizations)
- [Finances API](https://developer-docs.amazon.com/sp-api/docs/finances-api),
  [Retrieve the amount and status of a payment](https://developer-docs.amazon.com/sp-api/docs/retrieve-amount-status-payment),
  [Retrieve your current balance](https://developer-docs.amazon.com/sp-api/docs/retrieve-your-current-balance),
  [Retrieve the financial events in a group](https://developer-docs.amazon.com/sp-api/docs/retrieve-financial-events-in-group)
- [Finances v0 reference](https://developer-docs.amazon.com/sp-api/reference/finances-v0) and its model,
  `models/finances-api-model/financesV0.json` in [amzn/selling-partner-api-models](https://github.com/amzn/selling-partner-api-models)
- [Policies and Agreements](https://developer-docs.amazon.com/sp-api/docs/policies-and-agreements): the Data Protection
  Policy and Acceptable Use Policy (US English)

The docs host now redirects to `developer-docs.amazon`; the links above are Amazon's own canonical ones.

Tests: `npx vitest run packages/connectors/amazon packages/connectors/registry apps/server/src/amazon-login.test.ts`
