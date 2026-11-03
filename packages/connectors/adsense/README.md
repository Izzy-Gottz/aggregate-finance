# @agfn/connector-adsense

Monthly AdSense totals per currency, as `report.snapshot` only. Nothing posts to the ledger, and core's `provider_report` check
skips it (`adsense` in `NOT_BOOKS`). Shown in one place: the connection drawer's "Earned on AdSense" line. No MCP tool reads it.

Built from Google's AdSense Management API v2 reference, read 2026-11-02. **It has never run against a real AdSense account.
The fixtures are hand-built from the docs, not recorded.**

## Rows

| Section | Row | Source |
|---|---|---|
| Earnings, by report `MONTH` in the account's time zone | Estimated AdSense earnings | `ESTIMATED_EARNINGS`. An estimate: Google says recent days can change |
| Payments, by the payment's date | Paid by AdSense | `payments.list` entries with a date, AdSense and YouTube together |

The unpaid balance is checked and dropped. The two rows run on different clocks and aren't netted. Months recompute on every
sync. All 12 are sent, zeros included.

## Before the flag goes on

- **Google's terms on stored data.** The Google APIs Terms 5e and 8b limit cached copies, and bar building databases or making
  permanent copies of API content. These snapshots are stored monthly totals. Someone must read those sections against what's
  kept, and against the AdSense program policies, which weren't read, before `AGFN_OFFER_ADSENSE=1`.
- **Google APIs Terms 9c.** A business owes Google an indemnity with no stated cap. Under Yisrael's rule (2026-11-02) that means
  no registration until the LLC exists. The app hasn't been registered.
- **The User Data Policy.** "Limit your use of data to providing or improving user-facing features", and transfers are limited.
  It doesn't mention a person's own AI assistant. This connector sends nothing to an AI today, and that must be rechecked before
  any tool reads these rows.
- **Google's app verification.** Whether `adsense.readonly` counts as sensitive isn't confirmed. Check on the consent screen.

## Registration

Google Cloud project, AdSense Management API, Web OAuth client. Redirect `${BASE_URL}/api/connectors/adsense/callback`. Scope:
`https://www.googleapis.com/auth/adsense.readonly`. Env: `ADSENSE_CLIENT_ID`, `ADSENSE_CLIENT_SECRET`, then
`AGFN_OFFER_ADSENSE=1` on hosted.

## Unverified

1. The token response names the granted scope. If Google omits it, every connect is refused.
2. Query shape for `startDate.year` and friends, and `dimensions` / `metrics` as single values.
3. An end date of today on the account's clock is accepted.
4. Cell values are plain decimals with at most the currency's decimals. A month with more stops the sync; a JPY account may hit this.
5. `totalMatchedRows` counts the same rows returned, with `MONTH` as the only dimension.
6. `totals` holds the metric in the second cell and equals the sum to the cent. A rounded total would stop every sync.
7. An account with no earnings sends no `rows`, and the header still has a currency.
8. `amount` on a payment is `$1,234.57`-shaped. Other locales stop the sync. `payments.list` has no language parameter.
9. `$` means the report's currency. A publisher reporting in EUR and paid in USD stops the sync. Other ambiguous symbols stop too.
10. Payments are in one list with no pages.
11. A date on a paid payment always matches its name, including `youtube-` payments.
12. YouTube payments belong in "Paid by AdSense". Their earnings aren't in this report, so paid can exceed earned.
13. A payment dated in Google's billing zone can land in a different month from the account's clock, near a month's edge.
14. The drawer picks this month in UTC, and the snapshots use the account's clock, so the line can lag for hours at a month's start.
15. `accounts.list` returns closed accounts too. They're connected and show history.
16. `timeZone.id` is always set; UTC is used otherwise.
17. Refresh tokens don't rotate, and `prompt=consent` always returns one.
18. Revoking a refresh token ends the sign-in for all accounts on it.
19. The user can tick the scope off on Google's screen; the error then says to tick it.
20. Rate limits: Google's quota for this API isn't known; 2 requests a second is a guess.

Tests: `npx vitest run packages/connectors/adsense apps/server/src/store-sales.adsense.test.ts`
