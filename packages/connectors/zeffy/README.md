# @agfn/connector-zeffy

Monthly payments a nonprofit received online through Zeffy, as `report.snapshot` only. Nothing posts to the ledger, and core's
`provider_report` check skips it (`zeffy` in `NOT_BOOKS`). Shown in one place: the connection drawer's "Received online
through Zeffy" line. No MCP tool reads it.

Built from Zeffy's public API reference (https://www.zeffy.com/api/docs, OpenAPI 3.1, v1.0), read 2026-11-03 in the browser;
the OpenAPI file wasn't downloaded. Nothing was registered and no live API was called. **It has never run against a real
organization. The fixture is hand-built from the docs, not recorded.**

## Auth

The organization owner's API key, pasted, from Settings → Integrations ("organization owner only"), sent as `Authorization:
Bearer`. Plus the organization's time zone, picked from a list at connect: Zeffy's API gives none (see Months).

A Zeffy key can also record payments (`POST /payments`, once the organization has passed Stripe verification) and delete
them (`DELETE /payments/{id}`), and the docs name no scopes or read-only key. So `client.ts` sends GET only (anything else
throws before it leaves), and connect returns a warning saying the key could write. Disconnect can't remove the key; it tells
the person where to.

## Rows

Each month on the organization's clock, 12 months, recomputed on every run:

| Row | Source |
|---|---|
| Online payments through Zeffy | `GET /api/v1/payments` `amount` (cents) by `created`, `status` succeeded and `type` online |
| Refunds | each payment's `refunds[]` `amount` by its own `created`, `status` succeeded |
| Net received online through Zeffy | The two above. The drawer shows this one |

Left out: `failed` and `pending` payments; `manual` payments (cash, cheques, in-kind recorded in Zeffy, money that didn't move
through Zeffy and may already be in the bank) and `imported` ones (a past platform's history); disputes; pending, failed or
cancelled refunds. A refunded payment still counts as received, with its refund off in the refund's own month.

**No fees, no payouts.** Zeffy charges organizations nothing, and the API has no payout endpoint. Payouts reach the bank,
which may be connected too, so nothing here is revenue.

Totals only. The payment object carries the buyer's name, email and address, the card's brand and last four, form answers,
tributes and receipt links: none is read into an event or raw.

## Months

Zeffy is for organizations in Canada and the US, and its API shows no organization time zone. Filing by UTC would move a
payment made on a month's last evening into the next month, so the person picks one at connect: Eastern, Central, Mountain,
Pacific, Atlantic, Newfoundland, Saskatchewan, Arizona, Alaska or Hawaii (each one IANA zone, `TIME_ZONES`). An IANA name sent
directly is taken too. It's kept with the key; changing it means connecting again.

## Currency

`cad` or `usd`, the only two the docs list; anything else stops the sync. Each gets its own snapshots, never added together.
A refund in a currency other than its payment's stops the sync. A currency reported before keeps its months, as zeros, when
it goes quiet. Amounts must be whole, non-negative cents; anything else stops the sync, never $0.

## Before the flag goes on

- **Terms.** Zeffy publishes no API terms that we found, and its general Terms weren't read for API use. Zeffy also offers
  its own "Connect Zeffy to Claude or ChatGPT". We wrote to contact@zeffy.com on 2026-11-03 (Send log); no reply yet.
- **A real-organization test**, checking the unverified points below first.
- Then `AGFN_OFFER_ZEFFY=1` on hosted. Self-hosted offers it already.

## Unverified

1. No read-only key. The docs describe one key per organization, made by the owner, with no scopes. GET-only is the guard.
2. Refunds are only listed on their payment. A run reads payments created from a year before the first reported month
   (`REFUND_LOOKBACK_MONTHS`), so a refund on an older payment isn't taken off. How late Zeffy allows a refund isn't said.
3. Whether `amount` includes a donor's optional contribution to Zeffy (a "tip" is named in the webhook docs, not on the
   payment). The example shows `amount` equal to its one item's, so it's read as the organization's.
4. Refund `status` values. The docs show only `succeeded`; `pending`, `failed`, `canceled` and `requires_action` (Stripe's)
   aren't counted, and anything else stops the sync.
5. Order and cursor. Payments are read with `created[gte]`, `limit=100` and `starting_after` = the last page's
   `next_cursor`, until `has_more` is false. The docs don't say the order; a `has_more` page with no new cursor stops the sync.
6. `created` is unix seconds, on payments and refunds.
7. A deleted payment (`payment.deleted` exists) drops out of the next run's months.
8. The API key format isn't documented; anything 16 to 512 characters with no spaces is tried.
9. Rate limits are per organization: 100 a minute and 20 a second, shared by every key. The client asks one a second; a 429
   waits `Retry-After`.

Tests: `npx vitest run packages/connectors/zeffy apps/server/src/store-sales.zeffy.test.ts apps/web/src/screens/zeffy-line.test.ts`
