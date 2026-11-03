# @agfn/connector-sumup

Monthly SumUp totals per currency, as `report.snapshot` only. Nothing posts to the ledger, and core's `provider_report` check
skips it (`sumup` in `NOT_BOOKS`). Shown in one place: the connection drawer's "Paid out by SumUp" line. No MCP tool reads it.

Built from SumUp's API docs and `https://developer.sumup.com/openapi.json`, read 2026-11-02. **It has never run against a real
SumUp account. The fixtures are hand-built from the docs, not recorded.**

## Rows

| Section | Row | Source |
|---|---|---|
| Sales, by UTC month of `timestamp` | Gross sales through SumUp | history `PAYMENT` that went through, not `CASH` |
| | Cash sales noted in SumUp | history `PAYMENT` with `payment_type` `CASH` |
| | Refunds | history `REFUND`, not `CASH` |
| | Chargebacks | history `CHARGE_BACK` |
| Payouts, by `date` | Paid out by SumUp | payouts `PAYOUT`, `SUCCESSFUL` |
| | Fees on those payouts | `fee` on the same records |
| | Refunds taken from payouts | `REFUND_DEDUCTION` |
| | Chargebacks taken from payouts | `CHARGE_BACK_DEDUCTION` |
| | Other amounts taken from payouts | `DD_RETURN_DEDUCTION`, `BALANCE_DEDUCTION` |

Every row is a positive size and stands alone. The two sections run on different clocks and aren't netted.

## Registration

Redirect `${BASE_URL}/api/connectors/sumup/callback`. Scopes, always sent: `transactions.history user.profile_readonly`.
Env: `SUMUP_CLIENT_ID`, `SUMUP_CLIENT_SECRET`, then `AGFN_OFFER_SUMUP=1` on hosted after a real connect on staging.

## Unverified

Check all of these on a real account before `AGFN_OFFER_SUMUP=1`.

Amounts:

1. Whether a `PAYOUT` record's `amount` is before or after its `fee`. The docs don't say. SumUp's help pages say payouts are
   takings minus fees, so "Paid out" assumes after. If it's before, "Paid out" reads high by the fees.
2. Whether a `PAYOUT` `amount` is already net of the deduction records. They're separate rows here, so nothing is subtracted
   twice either way, but the rows can't be added together until this is known.
3. The sign of deductions, `fee`, and `REFUND` and `CHARGE_BACK` rows. Sizes are kept; both signs on one field stops the sync.
   A record with a negative `PAYOUT` or `PAYMENT` amount stops it too.
4. What a `fee` on a deduction record means. It isn't counted.
5. Whether a `PAYOUT` is one record per sale (`transaction_code` suggests so) or one per transfer. Either adds up the same.
6. Whether a `REFUNDED` sale keeps its original `amount`. Gross sales assumes it does.
7. Whether a refund made before a payout shows as a `REFUND` row, a deduction, or only a smaller payout. The sync stops if
   `refunded_amount` on sales is more than the `REFUND` rows in that currency.
8. Whether chargebacks appear as `CHARGE_BACK` rows at all. `CHARGE_BACK` as a status is in the `statuses[]` filter but not in
   the `TransactionStatus` enum; it's treated as a sale that went through.
9. Whether history covers every employee (`user`) on a merchant. SumUp's dashboard payout report covers main and employee
   profiles; the API's doesn't say.

Calendar:

10. The month of a sale is UTC. SumUp gives no merchant time zone through these calls, so sales late on the last day of a
    month can land in the next one, away from UTC.
11. How far back payouts and history reach. Nothing older is documented or read past 24 months.

API behaviour:

12. Whether `limit=9999` on payouts is honoured, or a lower cap cuts the answer short without saying so. A full answer is
    split by date; a silent lower cap wouldn't be noticed.
13. Whether `transactions/history` accepts `limit=100`. Its maximum isn't documented.
14. Whether `resource.id` on a membership is the merchant code. The docs don't say so outright.
15. Whether `resource.attributes.sandbox=false` filters as described, and whether `attributes.sandbox` is on the response.
16. Whether a merchant member who isn't the owner gets 403 on these reads, and which roles can read them.
17. Rate limits. None are published for these endpoints; the client holds to 5 a second.
18. Whether SumUp grants exactly the scopes asked for. A token listing more is refused at connect, on the example token
    response's `scope` field.
19. Refresh tokens: the docs say a refresh may or may not return a new one. Both are handled, neither has been seen.
20. How a person removes Aggregate's sign-in. SumUp documents no revoke call and no page for it, so disconnect says so.
