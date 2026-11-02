# Postgres row-level security (design + prototype)

Status: **phase 2 is built (2026-10-11, Yisrael's go):** every `workspace_id` table, behind `AGFN_PG_RLS=1` (on in
hosted). The app role can no longer switch the bypass on for itself; requests can run on their own login
(`AGFN_PG_APP_URL`, one operator step below); sync jobs, webhooks, the Shopify admin and account deletion work inside
each workspace; what still crosses workspaces is a short list of named one-step lookups. All scenario stories and the
red-team suite pass with it on (`AGFN_TEST_PG_RLS=1`).

## Why
Today, workspace isolation lives in application code. Every query filters `workspace_id`, and `can()` checks the
person. The threat model calls cross-tenant access the top hosted risk (#6). A forgotten `where('workspace_id', …)` in
one new query would leak another company's data, and only code review stands in the way. Row-level security (RLS)
puts the same rule in the database, so a query that forgets the filter returns nothing instead of everything. It is
**defense in depth beneath `can()`, not a replacement.** `can()` still decides what a person may see inside their own
workspace (companies, data types, Personal).

SQLite (self-host) has no RLS and is unchanged. A self-hosted database usually holds one workspace anyway.

## The rule
On every table with a `workspace_id` column:

```sql
alter table t enable row level security;
alter table t force row level security;          -- applies to the table owner too
create policy agfn_workspace on t
  using      (workspace_id = current_setting('agfn.workspace_id', true) or (current_setting('agfn.rls_bypass', true) = 'on' and current_user = '<owner>'))
  with check (workspace_id = current_setting('agfn.workspace_id', true) or (current_setting('agfn.rls_bypass', true) = 'on' and current_user = '<owner>'));
```

`current_setting(…, true)` returns empty when unset, so **no context means no rows and no writes: fail closed.**
`with check` stops a request in workspace A from inserting or moving rows into workspace B.

## Roles

| Role | RLS | Used for |
|---|---|---|
| owner (`aggregate_app` on Neon) | **never applies**: Neon's owner has `BYPASSRLS` through `neon_superuser`, and that overrides `force` | migrations and everything inside `withBypass` |
| owner on plain Postgres | applies, because of `force`; the `agfn.rls_bypass` setting lets it through | the same |
| `agfn_app` | applies; `nosuperuser nobypassrls` | web requests and MCP calls |
| `agfn_admin` (not built) | a bypass role without `neon_superuser` | bypass work, split from the owner when its password is next rotated |

The policy honours `agfn.rls_bypass` only for the role that created it (the owner). Any session can write that setting, so naming the role is what makes it safe: any other role, including a read-only one, ignores it.

**What this does and doesn't protect.** The workspace scope is enforced against bugs in our code: a forgotten filter or a wrong id returns nothing. It is **not** enforced against SQL injection. `agfn.workspace_id` is a setting that any session can write, so SQL running as `agfn_app` could name another workspace (checked on staging, 2026-11-01). That's accepted for now and will be revisited after launch; the fix would be a signed workspace token checked by the policy. Parameterized queries are the defense against injection. Tables with no `workspace_id` have no policy at all, so grants are what protect them.

Phase 1 (the prototype) used one login. The bypass was a session setting (`agfn.rls_bypass = on`) that the server sets only inside `withBypass(...)`.

Phase 2 is what hosted runs. Requests log in as `agfn_app` through their own pool (`AGFN_PG_APP_URL`), and `withBypass` work uses the owner's pool. `agfn_app` can't bypass RLS, but see the limit above: it can still choose a workspace.

## Tables with no workspace

Tables with no `workspace_id` have no policy, so grants protect them. `ensureAppRole` (run at every boot, after migrations) gives `agfn_app` full rights on tables with `workspace_id`, the short list in `APP_RIGHTS` on the rest, and nothing on anything else, so a new table starts closed.

Sign-in, token and link tables (`auth_*`, `oauth*`, `passkey`, `signin_codes`, `recheck_links`, `reauth_events`, `reviewer_links`, `shopify_pending_installs`) are on the owner's side. Better Auth gets `ownerDb`, and our own code reaches them with `ownerOf(db)`. Neither sets a workspace, and neither may be inside a transaction on the app's connection.

`people` and `workspaces` stay readable and writable by `agfn_app` because requests need them, and they have no policy: SQL running as the app could read names and emails, and an update that forgot its filter would touch every row.

## How a request sets its workspace
`packages/db/src/rls.ts`:
- **Context** lives in `AsyncLocalStorage`: `withWorkspace(ws, fn)` or `withBypass(reason, fn)`. It follows `await`s, timers and promises automatically, so code below the entry point doesn't change.
- **Stamping** happens in `rlsPool(pool)`, a wrapper on the `pg.Pool`. Every checkout runs one statement:
  `select set_config('agfn.workspace_id', $1, false), set_config('agfn.rls_bypass', $2, false)`. The values are
  always overwritten, so a pooled connection never keeps the previous request's workspace. A checkout whose connection
  is already stamped with the same context skips the statement.
- **Transactions** check out one connection, so one stamp covers the whole transaction.

Why stamp each checkout rather than use `set local` in a per-request transaction:
- Kysely checks out a connection per query, so a per-request transaction would hold a pool connection for the whole request, including time spent waiting on Plaid or S3.
- A per-request transaction would also turn every request into a single all-or-nothing transaction.
- With stamping, nothing upstream changes: no request-scoped `Kysely` instance has to be threaded through every function.

Entry points wired in the prototype:

| Entry | Context | Where |
|---|---|---|
| Web API after the session middleware | the selected workspace | `apps/server/src/app.ts` |
| MCP and REST `/v1` tool calls | `principal.workspaceId` | `AgfnMcp.callTool` |
| Email-in webhook, after the address lookup | that address's workspace | `routes/inbound.ts` |
| Worker jobs (`connection.sync`, `sync.all`, `notify.tick`, `usage.rollup`, `jobs.prune`) | bypass, named `worker:<kind>` | `boot.ts` `bypassAll` |
| Migrations, auth migrations and auth seeding | bypass | `boot.ts` |

**Invariant the stamping relies on:** a connection belongs to one checkout until it is released (`pg.Pool`
guarantees this). PGlite's test stand-in shares one client, and an early test caught a context leak under concurrency
because of that. The tests model a real one-connection pool (`exclusive()`).

### Pooling, long requests, MCP streaming
- **Pool size:** unchanged. Stamping holds no connection beyond the query.
- **PgBouncer:** session mode works. **Transaction mode does not**, because session settings don't survive between transactions. If we ever need transaction pooling, switch to `set local` inside explicit transactions for each unit of work.
- **Long requests:** the context is per request, not per connection, so a slow request holds nothing extra.
- **MCP streaming:** the server is stateless Streamable HTTP. Each call is its own request, and `callTool` sets the context for exactly that call. A long-lived stdio bridge goes through the same `callTool`.
- **Background promises** started inside a request inherit that request's workspace (AsyncLocalStorage). Work that should outlive the request or span workspaces has to say so with `withBypass`.

## Code paths that cross workspaces today
Each of these must run under bypass, or be rewritten to find the workspace first and then enter it:

1. **Worker:**
   - `sync.all` lists every active connection.
   - `notify.tick` scans connections and people across workspaces.
   - `usage.rollup` and `jobs.prune` also span workspaces.
   - `connection.sync` jobs carry a `workspace_id` and could enter it instead of bypassing (phase 2).
2. **Auth and sign-in:**
   - Better Auth's tables have no `workspace_id`.
   - `workspacesFor(person)` lists memberships across workspaces before one is chosen.
   - Workspace creation (`POST /api/workspaces`) runs before a workspace exists.
   - The invite lookups (`inviteForLink`, `GET /api/invites/:id`) find `settings` rows by id.
3. **Credential lookups by secret:**
   - agent keys by hash (`findKeyByHash`, `agent_keys`);
   - OAuth tokens mapped to grants;
   - email-in addresses by token (`settings` `inbound_token:*`).

   Each should look up the workspace under a narrow bypass, then enter it. This is the pattern `routes/inbound.ts` now follows.
4. **Provider webhooks:** they find connections by connector key and item id across workspaces (`app.ts` webhook route, `connector_webhook_receipts`).
5. **Admin and CLI:** `agfn sync --all`, `agfn usage`, `agfn demo`, `doctor`, and Delete workspace (deletes every table by introspection).
6. **Tables with no `workspace_id`:** `rate_limit_counters` and the Better Auth tables. They stay outside RLS.

## Migration and rollback
- **Turning it on:** set `AGFN_PG_RLS=1` and restart. Boot runs `enableRls` on the prototype tables inside bypass (idempotent: `enable`, `force`, `drop policy if exists`, `create policy`). No data changes. Set `AGFN_PG_RLS_ROLE=agfn_app`: boot runs `ensureAppRole` (creates the role `nologin nobypassrls`, grants DML and sequences, and grants the login SET on it). This is required on Neon, whose login roles have BYPASSRLS, so without it the policies never apply. Hosted runs this way since 2026-10-11 (checked: the login has BYPASSRLS, `agfn_app` does not, and a wrong workspace sees 0 rows).
- **Rollback (self-hosted only):** set `AGFN_PG_RLS=off` and restart. Boot turns RLS off (`disableRls`), with a log line. No data changes.
- **Boot fails closed (2026-10-11, after a staging machine started without its `[env]` block turned RLS off for the whole database for 14 minutes):** `bootRls` in `packages/db/src/rls.ts`. Hosted (`AGFN_HOSTED=1`, or a Neon `DATABASE_URL`/`AGFN_PG_APP_URL`, which catches a machine missing its config) refuses to start with anything but `AGFN_PG_RLS=1`. Unset on a database where RLS is already on refuses to start rather than turn it off. Any value other than `1`/`off`/`0` refuses. With `AGFN_PG_RLS=1`, boot checks the catalog afterwards (`relrowsecurity` + `relforcerowsecurity` + the policy on every `workspace_id` table) and refuses to start on any gap. The same "hosted" test (AGFN_HOSTED=1 or a Neon database) also makes boot refuse without BASE_URL on https, SMTP_URL, MAIL_FROM, AGFN_PG_RLS_ROLE (or AGFN_PG_APP_URL) and FILES_S3_BUCKET (`hostedConfigProblems`, apps/server/src/config.ts).
- **Rollout:** one table group per release, starting with the leaf tables (documents, activity, usage). The ledger tables come last because the sync worker writes them. Every new table with `workspace_id` gets the policy in its own migration. A test can enumerate `information_schema.columns` and fail if a `workspace_id` table has no policy.
- **Postgres version:** RLS and `force` are available in every supported version. PGlite runs the same SQL.

## Phase 1 (built)
- **Coverage:** every table in the schema with a `workspace_id` column, found from the catalog at boot (`syncRlsPolicies`). A boot only touches tables still missing the policy. `packages/db/src/rls.test.ts` fails if any workspace table is left uncovered, and shows that a table added by a future migration is picked up at the next boot. The server end-to-end test checks the same after a real boot.
- **Named scopes**, all `withBypass('<area>:<what>')` around one step, then `withWorkspace` for the rest:

  | Scope | What crosses workspaces |
  |---|---|
  | `migrate`, `migrate:auth`, `migrate:reassign`, `auth:seed`, `rls` | boot: migrations, auth tables, the 0301 reassignment, policies |
  | `worker:<job kind>` | every worker job |
  | `auth:memberships` | the session's workspace list before one is chosen (web and `/v1/control`) |
  | `auth:invite` | invite lookups by id (the invite email, `GET /api/invites/:id`) |
  | `auth:agent-key` | finding an agent key by its hash; the rest of auth runs in the key's workspace |
  | `inbound:address` | finding an email-in address by its token; delivery runs in that workspace |
  | `webhook:<connector>` | a signature-verified provider delivery finding its connection |
  | `cli:<command>` | operator commands run on the server |

- **Entering a workspace instead of bypassing:**
  - creating a workspace picks the id first and runs inside it;
  - OAuth auth enters the token's workspace;
  - MCP requests (tools/list included) run in the principal's workspace;
  - `/v1/control` runs in the person's workspace.
- **CLI:** `agfn migrate`, `doctor`, `sync`, `usage` and `demo` are operator tools run on the server, and each runs under `cli:<command>`.
- **Red team under RLS:** af's suite (`apps/server/src/redteam`) passes with `AGFN_TEST_PG_RLS=1` and without it. That covers provider webhooks, email-in, export and key paths. `01-cross-workspace` also checks, with the flag on, that inside an attacker's workspace the victim's `ledger_records`, `documents`, `connections`, `accounts` and `entities` return zero rows, and that UPDATE/DELETE on them affect zero rows. That is the second wall behind `can()`.

## Phase 2 (built)

**1. The bypass can't be switched on from inside a request.** The policy is now
`workspace_id = current_setting('agfn.workspace_id') or (current_setting('agfn.rls_bypass') = 'on' and current_user = '<owner>')`.
SQL running as the app role (an injection, a bug) can set `agfn.rls_bypass` on its own connection, and for that role
it now means nothing. Boot replaces older policies automatically (a policy without the `current_user` check counts as
missing). Red team: `packages/db/src/rls.test.ts` sets the setting by hand inside a request and still sees zero
foreign rows and can't insert into another workspace.

**2. A separate login for requests (`AGFN_PG_APP_URL`).** In phase 1 a request switches into `agfn_app` with
`SET ROLE` on the main login, and the main login (Neon's) has BYPASSRLS, so an injection that runs `RESET ROLE` gets
it back. With `AGFN_PG_APP_URL` set, requests check out from a second pool whose login *is* `agfn_app` (nothing to
reset to), and only `withBypass` work uses the owner's pool (`rlsPool(..., { appPool })`). Test: routing in
`rls.test.ts`. **Operator step (hosted, once):**
1. In Neon (SQL editor, as the owner): `alter role agfn_app with login password '<new random password>';`
   (boot already created `agfn_app` NOBYPASSRLS with DML grants).
2. `fly secrets set AGFN_PG_APP_URL='postgres://agfn_app:<password>@<same pooled host>/<db>?sslmode=require'`.
3. Deploy. Check: the boot log has no "phase 1" warning, and `select current_user` from a request path is `agfn_app`.
   Rollback: `fly secrets unset AGFN_PG_APP_URL` (back to SET ROLE, still RLS-on).

**3. Fewer, narrower bypasses.**

| Was | Now |
|---|---|
| `worker:connection.sync` (bypass) | runs inside the job's workspace; a sync job without one is refused |
| `webhook:<connector>` around the whole delivery | `webhook:<c>:receipt` and `webhook:<c>:lookup` (two single queries); every change to a connection runs in its workspace |
| `shopify:embedded` around the admin's reads and disconnects | `shopify:connections` (which connections are this store's); payouts read and disconnects done per workspace |
| `shopify:link` | removed: `shopify_pending_installs` has no `workspace_id` |
| `account:delete` around the whole deletion | `account:workspaces`, `account:owned`, `account:memberships` (single lookups); each workspace's cleanup runs inside it; person-level rows need no bypass |
| `recheck:send`, `recheck:confirm`, `recheck:code`, `signin:code`, `auth:signin-code` | removed (person-level tables); `recheck:memberships` (one lookup) to log the re-check in each workspace |

What still runs under bypass, by design (each is one lookup by a secret or a fan-out, or operator/boot work):
migrations and policies (`migrate*`, `rls`, `auth:seed`); worker jobs that span workspaces (`worker:sync.all`,
`notify.tick`, `usage.rollup`, `retention.purge`, `jobs.prune`, `exports.prune`, `backup.nightly`, `reviewer.reseed`)
and the queue loop (`worker:queue`); lookups by a secret or hash (`auth:agent-key`, `mcp:verify-token`, `auth:invite`,
`inbound:address`, `auth:reviewer`); the session's workspace list (`auth:memberships`, `auth:connect-state`); orphan
cleanup (`orphans:*`); `cli:<command>` and `wipe:*` (operator tools); `demo:*`; `perf:analyze`.

## Prototype results
- **Tables:** `documents`, `activity_log`, `usage_daily`.
- **`packages/db/src/rls.test.ts` (PGlite, the app role is subject to RLS):**
  - With no context, a query returns **zero rows** and an insert is refused ("row-level security").
  - Inside `withWorkspace('w1')`, only w1's rows come back, even for a query that asks for w2's id.
  - Inserting a w2 row is refused, and an update touches only w1 rows.
  - A transaction keeps its context, and two workspaces running concurrently don't mix.
  - Bypass sees everything, and `disableRls` restores normal behavior.
- **`apps/server/src/rls-e2e.test.ts`:** the real server on PGlite with the flag on. Two people create two workspaces, invite someone (which writes `activity_log`) and read `/api/usage`. Each workspace sees only its own rows, and a query outside any context sees none. The first run caught the auth library's own migrations needing bypass, which is now wired.

**Measured overhead** (PGlite in-process, 1,000 queries each, 3 runs, on a laptop that was busy with other work):

| Case | Per query |
|---|---|
| no RLS | 0.31 – 1.31 ms |
| RLS, same workspace, connection already stamped | +0.00 – 0.22 ms (within noise: the policy check itself is cheap) |
| RLS, first checkout or workspace changed | one extra statement, about +0.37 – 0.46 ms in PGlite |

Against a networked Postgres, the extra statement costs one round trip, about 0.2–1 ms in the same region. It is paid
only when a connection changes workspace. With a pool of 10 and steady traffic from many tenants, expect most
checkouts to need it, which adds about one round trip per query. The policy itself adds an `=` on an indexed column
that every query already filters on, so query plans don't change.

## Recommendation (phase 0): go, in two phases
1. **Phase 1 (next):** turn on the prototype tables in staging with `AGFN_PG_RLS=1` and run the full scenario suite (`apps/server/src/scenarios`) on Postgres with the flag on. Fix each fail-closed path it finds by entering a workspace or adding a named bypass. Then extend to every `workspace_id` table, with the "policy on every table" test. Expected cost: about one round trip per query when tenants interleave, which is acceptable at our scale.
2. **Phase 2:** separate logins (`agfn_app` for requests, `agfn_admin` for migrations and the worker, in a second pool) so even injected SQL can't bypass. Make the sync worker enter each job's workspace instead of bypassing. If round trips show up in p95 (`agfn usage` → `syncJobs.p95Ms`), batch the stamp into the first query of each checkout.

**No-go triggers:**
- a hosted Postgres that only offers PgBouncer transaction mode (switch to `set local` first);
- overhead above 2 ms p95 per request in staging;
- a cross-workspace path that can't be expressed as "look up under a narrow bypass, then enter the workspace".
