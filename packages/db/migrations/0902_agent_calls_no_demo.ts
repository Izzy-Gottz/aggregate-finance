import { sql, type Kysely } from 'kysely'

// Postgres only: agent_calls (0901) leaves out the demo's own AI. Every demo workspace (a challenge player's, a pooled
// one at its hand-over, the public demo) gets a seeded AI connection that makes two calls (client 'demo', its write keyed
// demo-seed-…); those aren't anyone's attempt (69, 2026-10-13, with the demo pool). The challenge's reset deletes the
// workspaces and keeps only copies of the log, so the seeded grants are found by their demo-seed write, in both the
// live log and the copies. Grants of the demo, public-demo and preview clients are left out as well, as in 0900.
// The funnel and yc_grants are unchanged (copied, since each migration stands alone).

const onPostgres = (db: Kysely<any>) => sql`select current_setting('server_version')`.execute(db).then(() => true, () => false)

const FUNNEL = sql.raw(`
  real_people as (
    select id, created_at from people
    where auth_user_id is not null and email not like '%.invalid'
  ),
  demo_ws as (
    select workspace_id from settings where key = 'demo' and value_json = 'true'
  ),
  activated as (
    select p.id, min(x.at) as at
    from real_people p
    join (
      select created_by as person_id, created_at as at, workspace_id from connections where created_by is not null
      union all
      select created_by, created_at, workspace_id from documents where created_by is not null
    ) x on x.person_id = p.id
    where x.workspace_id not in (select workspace_id from demo_ws)
    group by p.id
  ),
  ai_connected as (
    select g.person_id as id, min(g.created_at) as at
    from grants g join real_people p on p.id = g.person_id
    where g.client_id not in ('demo', 'public-demo', 'preview')
      and g.workspace_id not in (select workspace_id from demo_ws)
    group by g.person_id
  ),
  actions as (
    select substr(a.at, 1, 10) as d, coalesce(a.person_id, g.person_id) as person_id
    from activity_log a left join grants g on g.id = a.grant_id
    where a.actor_kind in ('person', 'agent')
      and a.at >= to_char(current_date - 400, 'YYYY-MM-DD')
      and a.workspace_id not in (select workspace_id from demo_ws)
  ),
  active as (
    select distinct x.d, x.person_id from actions x join real_people p on p.id = x.person_id
  )`)

const EXTRA = sql.raw(`
  yc as (
    select created_at as at from workspace_grants where kind = 'yc' and revoked_at is null
  ),
  calls as (
    select id, at from activity_log where actor_kind = 'agent'
    union
    select row_json::json->>'id', at from challenge_activity where row_json::json->>'actor_kind' = 'agent'
  )`)

const EXTRA_0902 = sql.raw(`
  yc as (
    select created_at as at from workspace_grants where kind = 'yc' and revoked_at is null
  ),
  live_calls as (
    select a.id, a.at, a.grant_id, a.args_json from activity_log a left join grants g on g.id = a.grant_id
    where a.actor_kind = 'agent' and coalesce(g.client_id, '') not in ('demo', 'public-demo', 'preview')
  ),
  kept_calls as (
    select row_json::json->>'id' as id, at, row_json::json->>'grant_id' as grant_id, row_json::json->>'args_json' as args_json
    from challenge_activity where row_json::json->>'actor_kind' = 'agent'
  ),
  seeded as (
    select grant_id from live_calls where grant_id is not null and args_json like '%"idempotency_key":"demo-seed-%'
    union
    select grant_id from kept_calls where grant_id is not null and args_json like '%"idempotency_key":"demo-seed-%'
  ),
  calls as (
    select id, at from live_calls where grant_id is null or grant_id not in (select grant_id from seeded)
    union
    select id, at from kept_calls where grant_id is null or grant_id not in (select grant_id from seeded)
  )`)

// Same views as 0901; only the definition of agent_calls changes (down puts 0901's back).
async function views(db: Kysely<any>, extra: typeof EXTRA): Promise<void> {
  const daily = sql`
      union all
      select substr(at, 1, 10)::date, 'yc_grants', count(*) from yc group by 1
      union all
      select substr(at, 1, 10)::date, 'agent_calls', count(*) from calls where at >= to_char(current_date - 400, 'YYYY-MM-DD') group by 1`
  const totals = sql`
    union all select 'yc_grants', (select count(*) from yc)
    union all select 'agent_calls', (select count(*) from calls)`
  const ctes = sql`${FUNNEL}, ${extra}`
  await sql`
    create or replace view agent_metrics.daily as
    with ${ctes}
    select day, metric, value from (
      select substr(created_at, 1, 10)::date as day, 'signups' as metric, count(*)::bigint as value from real_people group by 1
      union all
      select substr(at, 1, 10)::date, 'activated', count(*) from activated group by 1
      union all
      select substr(at, 1, 10)::date, 'ai_connected', count(*) from ai_connected group by 1
      union all
      select d::date, 'active_people', count(*) from active group by 1${daily}
    ) t`.execute(db)
  await sql`
    create or replace view agent_metrics.totals as
    with ${ctes}
    select 'signups' as metric, (select count(*) from real_people)::bigint as value
    union all select 'activated', (select count(*) from activated)
    union all select 'ai_connected', (select count(*) from ai_connected)
    union all select 'weekly_active', (select count(distinct person_id) from active where d >= to_char(current_date - 6, 'YYYY-MM-DD'))
    union all select 'paid', 0${totals}`.execute(db)
}

export async function up(db: Kysely<any>): Promise<void> {
  if (await onPostgres(db)) await views(db, EXTRA_0902)
}

export async function down(db: Kysely<any>): Promise<void> {
  if (await onPostgres(db)) await views(db, EXTRA)
}
