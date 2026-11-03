# @agfn/connector-youtube

A channel's monthly estimated revenue from the YouTube Analytics API, as `report.snapshot`. Report only: nothing posts to the ledger, and core's `provider_report` check skips it. The drawer shows "Earned on YouTube", not counted as revenue.

Built from Google's API reference. Never run on a real account. Fixtures are hand-built, not recorded. Terms notes: `~/aggregate-drafts/connector-batch-2-terms.md`. No YouTube app exists, and nothing was registered.

## Counted how

- YouTube pays through AdSense into the bank, so posting would double revenue. Nothing posts.
- With AdSense connected too, the same money shows in both drawers, each "not counted as revenue". That must not read as two incomes. If either line ever reaches an AI tool or a total, it needs handling first.
- `estimatedRevenue` is YouTube's net estimate and is shown as given, rounded to the cent. It excludes partner-sold ads and changes at month-end adjustment. All 12 months are re-read each sync.
- Months are Pacific time, as YouTube reports them. The drawer picks this month in UTC, so the line can lag for a few hours at a month's start.
- No revenue isn't $0. A month with no row gets no snapshot. A channel with nothing in 12 months gets a plain message. A 403 says the revenue is unknown and changes no totals.

## Unverified on a real account

1. What a non-monetized channel actually returns: 403, no rows or zeros. The docs don't say. A 403 reads as unknown; no rows or zeros read as no revenue.
2. A 403 for quota looks the same as any other 403, because the status alone is read. It reads as unknown, never $0.
3. A monetized channel that earned exactly $0 for 12 months reads as no revenue.
4. Whether `endDate` set to the first of the current month returns the month in progress, and how many days late.
5. Whether the month dimension needs an active-month row at all early in a month; until it appears the drawer shows nothing.
6. `estimatedRevenue` under `yt-analytics-monetary.readonly`: inferred from the scope's description, not stated by the metric.
7. Whether Google echoes both scopes in the token response. A mismatch refuses every connection.
8. Whether the consent screen makes scopes tickable one by one, and the wording of the "tick both" message.
9. Whether `currency=USD` is accepted with `estimatedRevenue`. The two pages disagree on how clearly they say so.
10. Value format: FLOAT is assumed, as a JSON number.
11. `ids=channel==<id>` with an id, rather than `channel==MINE`.
12. `channels?mine=true` returning one item for Brand Accounts, and the scope it needs (not named on its page).
13. The channel id pattern `UC` plus 22 characters.
14. Rounding, compared with what Studio shows.
15. Whether YouTube revenue shares adjustments with the months AdSense shows.
16. Non-Partner revenue types, such as Premium, inside `estimatedRevenue`.
17. Whether `invalid_grant` always means revoked. A password change or expiry could also raise it, which erases data until reconnect.
18. Unverified Google apps get short-lived refresh tokens; that only applies in testing.
19. Quota use and the 2 calls per second limit set here.
20. Google's revoke with a refresh token ending the whole grant.
21. The disconnect text's path in the Google Account.

## Before any flag flip

- **Company and insurance:** API Services ToS s.21 indemnity has no cap. Build-only until insurance quotes and 34's confirmation.
- **Google verification:** sensitive scopes need an OAuth review; YouTube may also want an API Compliance Audit for quota.
- **Who sees it:** Developer Policies III.E.3.b lets only the authorizing user, or agents they expressly approve, see this data. Other workspace members and the person's AI assistant both need a decision. If an MCP tool ever reads these rows, approval must be explicit first.
- **30-day rule:** III.E.4.b needs authorization checked every 30 days. Each sync does it, but a connection stopped for over 30 days keeps its data, and the guide says unverifiable data goes within 30 days. That needs a sweep before the flag.
- **Deletion:** in `ERASE_ON_DISCONNECT`. Disconnecting deletes within 7 days as III.D.2.3 needs. III.E.4.g also needs a way to ask for deletion.
- **Client page rules:** III.A needs a link to YouTube's Terms, a privacy policy that users agree to first and that references Google's Privacy Policy. III.G.1.d bars ads on screens with this data.
- **Aggregation:** III.E.2 bars combining data across content owners and any insight into YouTube's business. Keep this per connection.
- **Audit:** ToS s.6 allows monitoring without notice; III.H.3 can require test accounts.

Tests: `npx vitest run --maxWorkers=1 packages/connectors/youtube`
