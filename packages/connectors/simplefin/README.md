# @agfn/connector-simplefin

Read-only bank connections through [SimpleFIN Bridge](https://beta-bridge.simplefin.org/) (protocol:
https://www.simplefin.org/protocol.html). Connect banks through SimpleFIN, about $15/year, paid to them. There's no
developer app or key on our side, so it works the same hosted and self-hosted.

Connecting: the person creates a Setup Token in SimpleFIN Bridge and pastes it. Aggregate claims it once (POST to the
claim URL; never retried, since a second claim is refused) and keeps only the Access URL, encrypted like every other
secret. Credentials go in the Basic auth header, never in a request URL. Claim and access URLs must be https on
`bridge.simplefin.org` or `beta-bridge.simplefin.org`; self-hosters running their own SimpleFIN server set
`SIMPLEFIN_ALLOW_ANY_HOST=1`.

Syncing: `GET /accounts?version=2` in windows of at most 90 days: 365 days on the first sync, then from the last end
minus 5 days. The Bridge allows about 24 requests a day per token and refreshes daily, so a cycle within 4 hours of
the last is skipped, and health checks make no request. Pending rows are skipped (their ids change when they post).
Account ids are `<conn_id>:<id>`; the account type is guessed from its name; cards and loans are owed (negative).
Bank errors from the Bridge become sanitized warnings; `con.auth` asks the person to fix the bank at the Bridge.
A response with more than 500 accounts or 100,000 rows in one window is refused.

Tests: `npx vitest run --maxWorkers=1 packages/connectors/simplefin` (connector contract, windows, token reuse, no
retry on claim, no secrets in config/raw/events, host pinning, oversize responses).
