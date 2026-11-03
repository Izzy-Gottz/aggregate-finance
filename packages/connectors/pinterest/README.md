# @agfn/connector-pinterest

Monthly Pinterest ad spend for one ad account, as `report.snapshot` only. Nothing posts to the ledger, and core's `provider_report`
check skips it (`pinterest` in `NOT_BOOKS`), because the same money shows up as card or bank spend. Shown in one place: the
connection drawer's "Spent on Pinterest ads" line, not counted as an expense. No MCP tool reads it.

Built from Pinterest's public OpenAPI description (v5.28.0, github.com/pinterest/api-description), read 2026-11-02, and its
developer guidelines and API terms (`~/aggregate-drafts/connector-batch-2-terms.md`). The human docs site wasn't readable.
**It has never run against a real Pinterest account. The fixtures are hand-built from the OpenAPI description, not recorded.**

## What it reads

`GET /ad_accounts` and `GET /ad_accounts/{id}/analytics` with `SPEND_IN_MICRO_DOLLAR`, `granularity=DAY`, UTC days, account-wide.
Whole micro-units add up by month and round once, half up, to the currency's smallest unit. Only `ads:read`. No POST at all.

**About 90 days, not 12 months.** The GET report reaches 90 days back. Going further needs `POST .../reports` and a file download,
which this connector leaves out. So a first connect shows two or three months; a sync sends each whole month inside the window
plus this month so far; older months stay from earlier syncs. A partly visible month is never sent.

**No answer is not $0.** 403, 429, 5xx and anything unreadable end the sync with no snapshots. A 403 says the spend is unknown and
doesn't ask for a new sign-in. A day with no spend figure stops the sync. A month with no days sends nothing.

## Before the flag goes on

Everything here needs doing or answering before `AGFN_OFFER_PINTEREST=1`.

- **Registration and review.** Pinterest reviews apps before distribution or use: Trial, then Standard access (with a video). Not
  registered. Register under AGGREGATE FINANCE LLC: the terms aren't assignable, so a personal registration won't move.
- **Uncapped indemnity (s.7).** Build-only until the LLC's insurance quotes are in hand and 34 confirms.
- **MCP "Intermediary Tools" clause.** Third parties must agree to terms at least as protective. No MCP tool may read these rows
  until a lawyer answers it.
- **Third-party sharing** against a person's own AI assistant. Unresolved. This connector sends nothing to an AI today.
- **"Advertising service" purpose clause and the Ad Data Terms.** The terms' purpose clause needs reading against a finance tool,
  and the Ad Data Terms were not read.
- **AGPL and the open-source clause.** Needs checking against the public repo.
- **Deletion.** Data goes within 30 days of a revoke or a customer leaving, with certification if asked. `pinterest` is in
  `ERASE_ON_DISCONNECT`, which covers a disconnect here. Whether a revoke on Pinterest's side is ever seen isn't known: there's no
  webhook, so it depends on what a dead token's sync reports, and needs a real check.
- **Publicity and brand.** Publicity needs Pinterest's permission. Letter tile only until the Brand guidelines are read.
- **A real connect on staging**, then every point below.

## Registration

Pinterest developer app. Redirect `${BASE_URL}/api/connectors/pinterest/callback`. Scope: `ads:read`. Env: `PINTEREST_CLIENT_ID`,
`PINTEREST_CLIENT_SECRET`, then `AGFN_OFFER_PINTEREST=1` on hosted.

## Unverified

1. The token response names the scope, and in what separator. Absent is allowed, because the docs make it optional; any other grant
   is refused. An app can't pick up extra scopes this way, but that's untested.
2. `refresh_token` always comes back. Apps created on or after 2025-09-25 need no `continuous_refresh`; registering later keeps that true.
3. `SPEND_IN_MICRO_DOLLAR` arrives as a whole JSON number. A fraction or string stops every sync.
4. Whether quiet days come back as 0, come back without the column, or are left out. Without the column stops every sync, which would
   need changing for that account shape if it happens. Left out is summed as nothing for that day.
5. An account with no spend sends `[]`. It then shows no line, not $0.
6. Whether `SPEND_IN_MICRO_DOLLAR` includes ad credits and bonus spend. If it does, the line can exceed what the card was charged
   (`ADS_CREDIT_SPEND_IN_MICRO_DOLLAR` and `BONUS_SPEND_IN_MICRO_DOLLAR` exist).
7. Days are UTC as the spec says for the dates, not the ad account's time zone. Month edges won't line up with a card statement either way.
8. Recent days change, or attribution-window settings affect spend. Spend shouldn't depend on attribution, but it isn't stated.
9. The window: 89 days back is accepted, and an end date of today.
10. `include_shared_accounts` default brings in shared accounts, and every role listed can read analytics. A role that can't gets the 403 message.
11. Micro-units for non-USD accounts follow the spec's wording; no JPY or KWD sample was seen.
12. Refresh calls behave with Basic auth at the token URL (the spec names Basic).
13. How a removed app shows up: 401 is assumed. Where a person removes an app in Pinterest's settings is worded loosely in `NOT_REVOKED`.
14. Rate limits: 2 calls a second is a guess inside the published analytics limit.
