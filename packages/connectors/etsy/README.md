# @agfn/connector-etsy

Every entry in an Etsy seller's payment account (Etsy Payments), as one `processor.balance_txn` on an Etsy balance per
currency, from the Open API v3 endpoint `getShopPaymentAccountLedgerEntries`. Sales, Etsy's fees, refunds, the sales tax
Etsy collects and remits, and each deposit to the seller's bank, which core matches to the bank deposit.

Built from Etsy's developer docs and its published OpenAPI spec
(`https://www.etsy.com/openapi/generated/oas/3.0.0.json`, "Etsy Open API v3" 3.0.0), read 2026-11-05. **It has never run
against a real shop. The fixtures are hand-built from the spec, not recorded.** Etsy is named in text only: no logo, no
artwork (apps/web/src/ui/brand/README.md), and "Etsy" is never in Aggregate's app or product name.

> The term "Etsy" is a trademark of Etsy, Inc. This application uses the Etsy API but is not endorsed or certified by
> Etsy, Inc.

Etsy's Commercial Access criteria ask for the notice to be shown prominently in the app. It is not on the public
connections page yet: that page's test (apps/server/src/docs-shell.test.ts) refuses the words "official" and "certified"
anywhere on it, so the Stripe partner line can never read as a certification, and Etsy's wording contains "certified".
Where it goes (the connect screen, or that page with the test narrowed) is decided before the flag goes on.

## Auth

Aggregate's Etsy app. Set `ETSY_CLIENT_ID` (the app's keystring, which is also the OAuth client id) and
`ETSY_CLIENT_SECRET` (the shared secret). Without both there's no Etsy connector. Register the redirect URI
`${BASE_URL}/api/connectors/etsy/callback`.

[OAuth 2.0](https://developers.etsy.com/documentation/essentials/authentication), authorization code with PKCE:

1. `begin()` sends the person to `https://www.etsy.com/oauth/connect` with `response_type=code`, `client_id`,
   `redirect_uri`, `scope=transactions_r shops_r`, `state`, `code_challenge` and `code_challenge_method=S256`. The verifier
   is HMAC-SHA256(shared secret, state), 43 base64url characters, so nothing extra is kept between begin and connect
   (Whop and Wefunder do the same). The challenge is its SHA-256, base64url.
2. Etsy sends the browser to the callback with `code` and `state`. `connect()` exchanges the code at
   `https://api.etsy.com/v3/public/oauth/token` (form-encoded, `client_id` and `code_verifier` in the body, no secret, as the
   docs show), through the SDK's OAuth helper.
3. A token response naming scopes other than exactly `transactions_r shops_r` is refused. So is one with no refresh token,
   or an access token whose user-id prefix isn't the signed-in user. Then `getMe` (user id, shop id), `getShop` (only
   `shop_name` and `currency_code` are read) and one ledger page prove the grant reaches the shop's payment account.

Scopes: `transactions_r` (the ledger) and `shops_r` (`getMe`). Never `email_r`, `address_r`, `profile_r` or anything that
writes. Access tokens last an hour and are renewed before a sync and saved; refresh tokens last 90 days.

Every call sends `Authorization: Bearer <user id>.<token>` and `x-api-key: <keystring>:<shared secret>`. Both the spec's
security scheme and the docs' Requests page give the key in that form ("Every request to a v3 API endpoint must include this
data in the format `keystring:shared_secret`").

Read-only by construction: `client.ts` wraps its fetch in `getOnly`, so anything but GET throws before it leaves. The only
POST is the token call, which goes through the SDK's OAuth helper on its own fetch.

Disconnect can't end the grant: Etsy documents no revoke endpoint. It tells the person: "In Etsy, open Shop Manager → Apps
(or Account settings → Apps), find Aggregate and choose Revoke." (Etsy's help article "How to Use Apps to Manage Your
Shop" gives Shop Manager → Apps → Revoke; a copy of it and several app vendors give Account settings → Apps, also reachable at
etsy.com/your/apps.)

## Rows

One row per ledger entry, external id `etsy:<entry_id>`, dated at the entry's `created_timestamp`, on the account
`etsy:<shop_id>:<currency>` ("Etsy (USD)"). A zero amount sends no row (it moves nothing) but is still checked.

| ledger_type | Kind | gross / fee / net |
|---|---|---|
| `PAYMENT_GROSS` | charge | amount / 0 / amount |
| `REFUND` | refund | amount / 0 / amount |
| Etsy's fees: `PAYMENT_PROCESSING_FEE`, `transaction`, `transaction_quantity`, `shipping_transaction`, `gift_wrap_fees`, `listing`, `listing_private`, `renew_expired`, `renew_sold`, `renew_sold_auto`, `auto_renew_expired`, `offsite_ads_fee`, `shipping_labels`, `regulatory_operating_fee`, `DEPOSIT_FEE`, `seller_onboarding_fee`, `vat_on_processing_fees`, `vat_seller_services` | fee | 0 / −amount / amount |
| Fees handed back: `transaction_refund`, `transaction_quantity_refund`, `shipping_transaction_refund`, `listing_refund`, `listing_private_refund`, `renew_sold_auto_refund`, `offsite_ads_fee_refund`, `shipping_label_refund` | fee (negative) | 0 / −amount / amount |
| `sales_tax` | adjustment, `salesTax: true` | amount / 0 / amount |
| `DISBURSE`, `DISBURSE2` | payout, `payoutExternalId` = `etsy:<entry_id>`, `arrivalDate` = the entry's day | amount / 0 / amount |

Names match without regard to case. **Any other ledger_type stops the sync** with "Etsy listed a kind of payment account
entry Aggregate doesn't read yet (<name>)…". No dispute (chargeback, case) or reserve type has been seen yet, so none is
mapped; the first one stops the sync with its name and is added here once it's known what it is.

VAT Etsy charges on its own fees (`vat_seller_services`, `vat_on_processing_fees`) is a cost of selling, so it's a fee,
not sales tax.

After each window, one `balance.snapshot` per ledger it touched: the last entry's `balance`, at its time (external id
`etsy:<shop>:<cur>@<day>`, so a later window the same day replaces it). core takes the first snapshot as where the
ledger starts (its opening balance), so money already in the account before the first entry read isn't counted as income.

## The check

Each entry's `balance` must be the balance before it plus its `amount`, in `sequence_number` order (then entry id), per
ledger, starting from the last entry already recorded. A window is held whole (in the cursor) until every page of it has
been read; only then is it checked and sent. If it doesn't chain, **the sync stops** with "Etsy's payment account entries
between <day> and <day> don't add up…", and nothing from that window is recorded. Windows already recorded stay as they
were. So does:

- an entry already passed (its sequence at or before the last one recorded) that wasn't recorded;
- an entry in another currency than its ledger;
- a second ledger in a currency another ledger already uses (they'd share one balance);
- a currency with no minor unit (JPY and the like), until it's checked how Etsy writes it;
- any amount, balance, id or date that isn't what the spec says.

Amounts are used as Etsy signs them, never by absolute value, so a misread sign fails the check instead of hiding.

## Cursor and windows

`min_created` and `max_created` are required. The first run reads the last 365 days; each later run reads from a day before
the previous run started up to when it starts, so an entry Etsy shows late is still picked up. Entries already recorded are
recognised by the chain (and, for the overlap day, by id) and skipped.

Windows are at most 30 days. One page (100, the spec's maximum `limit`) per sync step, paged by `offset`. A window whose
`count` is over 1,000 entries is halved (down to an hour) before reading, so the cursor holds at most about that many
compact entries; the next window is back to 30 days.

Rate: Etsy's default is 5 requests a second and 5,000 a day **for the whole app**, shared by every connected shop (a rolling
24 hours; `x-remaining-today` reports it). The client stays at 4 a second. A 429 waits Etsy's `retry-after`. A quiet shop
costs about one request per sync; at the server's default of a sync every hour (`SYNC_EVERY_MINUTES`, 60) that's about 24
a day per shop, so roughly 200 shops before the daily limit, less while first runs backfill (13 windows each). Etsy can
raise an app's limits on request.

## Freshness

Etsy's API Terms (as briefed, see Unverified) don't allow Etsy content shown more than 24 hours older than etsy.com. Syncs
are run by the server's `sync.all` job every `SYNC_EVERY_MINUTES` (60 by default; apps/server/src/boot.ts and config.ts),
so an Etsy connection is read about hourly. The scheduler wasn't changed. If `SYNC_EVERY_MINUTES` is ever set above 1,440,
or a connection's syncs keep failing for a day, Etsy data would be older than the Terms allow; nothing enforces that yet.

## Stored

Raw (`etsy.ledger`, one per window): per entry its id, ledger id, sequence number, amount, balance, currency, created time,
ledger_type, and Etsy's `reference_type`, `reference_id` and `parent_entry_id` when present. No `description` (free text;
the spec says it describes the kind of entry, but Etsy's own statements name orders and buyers in theirs), no
`payment_adjustments` (refund objects with a user id and a free-text reason), no Payment objects (they carry the buyer's user
id and address ids). From the shop, only its name (for the connection's label) and currency (config) are read.

`etsy` is in `ERASE_ON_DISCONNECT`: Etsy's API Terms as briefed (s.4 Aggregate acts as the seller's service provider; s.5
store Etsy content no longer than reasonably necessary; s.6 cease use on termination).

## Before the flag goes on

Hosted hides Etsy until `AGFN_OFFER_ETSY=1` (and only once `ETSY_CLIENT_ID` is set). It stays off on live and on the
challenge server (`ETSY` is in `CHALLENGE_FORBIDDEN_PREFIXES`).

On top of the flag, hosted offers Etsy only to the workspaces listed in `AGFN_ETSY_WORKSPACES` (workspace ids, comma or
space separated): the small group of sellers agreed with Etsy (#28407714). Unset or empty means nobody. Every other
workspace doesn't see it in Add a connection, is refused at start, and doesn't get it from connect-from-chat
(`onlyWorkspaces` in apps/server/src/config.ts). Self-hosted servers have no list.

- **A real shop's sync, end to end**: consent, the token exchange (with and without `x-api-key` on the token call), a full
  year's backfill, every window chaining, and every ledger_type it meets mapped. Compare the rows with the shop's monthly
  CSV statement in Shop Manager → Finances.
- **Sales tax**: confirm whether `PAYMENT_GROSS` includes the tax that a following `sales_tax` entry takes back out. If it
  does, revenue still holds that tax and sales tax payable goes the other way by the same amount; the fix is to put the tax
  on the charge as `taxIncluded` (linking by `parent_entry_id` or `reference_id`, once a real shop shows which).
- **Read the live API Terms in full** (etsy.com/legal/api refused automated reads on 2026-11-05) and confirm the section
  numbers cited, the 24-hour rule, the notice wording, and anything on storing or erasing Etsy content.
- **Commercial Access** review for the app (Etsy's personal access is limited to the developer's own shop), with the notice
  shown prominently in the app (see the top of this file for why it isn't on the connections page yet).
- `etsy` in core's processor names (packages/core/src/matching.ts `PROCESSOR_NAMES`), once a real deposit's bank wording is
  known, so a deposit naming Etsy matches at 0.97 instead of 0.85. Not done here: it's a matcher change.

## Unverified

1. **ledger_type names.** The spec doesn't enumerate them ("The original reference type for the ledger entry"), and the
   docs don't list them. The names above are the ones third-party integrations record from Etsy's responses (an accounting
   project's typed list, a seller tool's fee map, an unanswered question on etsy/open-api #1209 showing
   `vat_seller_services`). Their meanings are read from the names. `gift_wrap_fees`, `shipping_transaction`,
   `regulatory_operating_fee`, `DEPOSIT_FEE` and `seller_onboarding_fee` are taken as Etsy's fees; `seller_onboarding_fee_payment`
   and `vat_tax_ep`, seen elsewhere, are left unknown on purpose (the first may be the seller paying a bill into the
   account; the second may be VAT collected from buyers, which would be sales tax).
2. **Disbursements.** `DISBURSE2` is the one name seen; `DISBURSE` is mapped too. A positive one (a returned deposit) would be
   a positive payout row, which core won't match to a deposit; that's taken as right until seen.
3. **x-api-key.** `keystring:shared_secret`, per the spec and the Requests page. Older docs and examples send the keystring
   alone. Whether the token endpoint also wants it isn't documented; it isn't sent there.
4. **Token URL.** The docs give `api.etsy.com/v3/public/oauth/token`; the spec's security scheme gives
   `openapi.etsy.com/v3/public/oauth/token`. The docs' one is used.
5. **Client secret at the token endpoint.** The docs send none (client_id only); none is sent.
6. **Window limit.** Not in the spec or docs. A third-party Etsy integration (PostHog's warehouse source) records that Etsy
   rejects a ledger window wider than 31 days and requires both bounds. 30 is used. Whether `max_created` is inclusive isn't
   stated: windows meet at the same second and the chain skips what it has.
7. **Order.** The tutorial says entries come "in chronological order". They're sorted by `sequence_number` ("The higher the
   sequence, the more recent the entry") and then entry id before checking, so page order doesn't matter within a window.
   Sequence numbers aren't assumed to be consecutive; only the balance has to chain.
8. **Minor units.** `amount` and `balance` are integers; the spec's Payment objects say "USD pennies unless otherwise
   specified". They're taken as the currency's minor units. Currencies with no minor unit stop the sync until checked.
9. **One ledger per currency.** A shop's payment account is taken to be one ledger in one currency. A second one stops the
   sync rather than be merged.
10. **`description`.** The spec says it "details what kind of ledger entry this is"; #1209 shows it repeating the
    ledger_type. It's dropped anyway, in case it ever names a buyer.
11. **Revoke path.** Shop Manager → Apps (Etsy's help) or Account settings → Apps (a copy of it, and app vendors). Both are
    given.
12. **API Terms section numbers** (s.4 service provider, s.5 storage, s.6 termination, and the 24-hour rule) are from the
    brief this was built to; the live Terms page couldn't be read (403 to automated reads). A search summary of Etsy's
    archived API Terms (effective until 2020-10-16) reports a 6-hour limit for listings and 24 hours for other content;
    that page wasn't read directly either.
13. **Trademark notice.** The wording is the one Etsy's developer docs quote for Commercial Access: "The term 'Etsy' is a
    trademark of Etsy, Inc." and "This application uses the Etsy API but is not endorsed or certified by Etsy, Inc."
14. **401 and 403** are both "connect again" (`auth`): an expired or removed grant, or a missing scope. Etsy's error bodies
    (`{ "error": "…" }`) are never shown.
15. **Refresh token rotation.** The docs' refresh example returns a new refresh token; whatever comes back is saved, and the
    old one is kept if none does.

## Not built

No MCP tool, no UI, no setup guide. Payments (`getPaymentAccountLedgerEntryPayments`, `getPayments`) aren't read: they'd
give a sale's gross, fee and net, but carry the buyer's user id and address ids, and the ledger already has every amount.
Receipts aren't read (buyer names and addresses).

## Docs read

- [Authentication](https://developers.etsy.com/documentation/essentials/authentication)
- [Requests](https://developers.etsy.com/documentation/essentials/requests)
- [Rate Limits](https://developers.etsy.com/documentation/essentials/rate-limits)
- [Payments tutorial](https://developers.etsy.com/documentation/tutorials/payments)
- [Documentation home](https://developers.etsy.com/documentation/) (Commercial Access criteria, the notice)
- The OpenAPI spec: `getMe`, `getShop`, `getShopPaymentAccountLedgerEntries`, `getPaymentAccountLedgerEntryPayments`,
  `getPayments`, and the `Self`, `Shop`, `PaymentAccountLedgerEntry`, `Payment` and `PaymentAdjustment` schemas
- [etsy/open-api discussion #1209](https://github.com/etsy/open-api/discussions/1209)
- [How to Use Apps to Manage Your Shop](https://help.etsy.com/hc/articles/360001931728) (revoking an app)

Tests: `npx vitest run packages/connectors/etsy packages/connectors/registry apps/server/src/hosted-unlisted.test.ts`
