import { sql, type Kysely } from 'kysely'

// Postgres only: named people can be left out of the funnel (34, 2026-11-01: "outside users" must read true from 0, so
// Yisrael's and the team's own accounts and the partner app reviewers who signed in on real domains don't count). The
// list is a table, not code: the ids are filled in on each database by an operator (insert into metrics_excluded_people),
// never committed, and the dashboard's reader can't see it (it is outside the agent_metrics schema). No workspace_id, so
// RLS doesn't apply. Everything built on real_people follows, as in 0905. Copied from 0905 (each migration stands alone).

const REAL_0905 = "auth_user_id is not null and " + ['invalid', 'test', 'example', 'localhost'].map((t) => `lower(email) not like '%.${t}'`).join(' and ')
const REAL = REAL_0905 + ' and id not in (select person_id from metrics_excluded_people)'

const onPostgres = (db: Kysely<any>) => sql`select current_setting('server_version')`.execute(db).then(() => true, () => false)

const funnel = (people: string) => sql.raw(`
  real_people as (
    select id, created_at from people
    where ${people}
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

const EXTRA_0903 = sql.raw(`
  yc as (
    select created_at as at from workspace_grants where kind = 'yc' and revoked_at is null
  ),
  live_calls as (
    select a.id, a.at, a.grant_id, a.args_json, coalesce(a.person_id, g.person_id) as person_id from activity_log a left join grants g on g.id = a.grant_id
    where a.actor_kind = 'agent' and coalesce(g.client_id, '') not in ('demo', 'public-demo', 'preview')
  ),
  kept_calls as (
    select row_json::json->>'id' as id, at, row_json::json->>'grant_id' as grant_id, row_json::json->>'args_json' as args_json,
      coalesce(row_json::json->>'person_id', row_json::json->>'grant_person_id') as person_id
    from challenge_activity where row_json::json->>'actor_kind' = 'agent'
  ),
  seeded as (
    select grant_id from live_calls where grant_id is not null and args_json like '%"idempotency_key":"demo-seed-%'
    union
    select grant_id from kept_calls where grant_id is not null and args_json like '%"idempotency_key":"demo-seed-%'
  ),
  calls as (
    select id, at from live_calls where (grant_id is null or grant_id not in (select grant_id from seeded)) and person_id in (select id from real_people)
    union
    select id, at from kept_calls where (grant_id is null or grant_id not in (select grant_id from seeded)) and person_id in (select id from real_people)
  )`)

// Same views as 0905; only who is a real person changes (down puts 0905's rule back).
async function views(db: Kysely<any>, people: string): Promise<void> {
  const daily = sql`
      union all
      select substr(at, 1, 10)::date, 'yc_grants', count(*) from yc group by 1
      union all
      select substr(at, 1, 10)::date, 'agent_calls', count(*) from calls where at >= to_char(current_date - 400, 'YYYY-MM-DD') group by 1`
  const totals = sql`
    union all select 'yc_grants', (select count(*) from yc)
    union all select 'agent_calls', (select count(*) from calls)`
  const ctes = sql`${funnel(people)}, ${EXTRA_0903}`
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
  if (!(await onPostgres(db))) return
  await sql`create table if not exists metrics_excluded_people (person_id text primary key, reason text not null, created_at text not null)`.execute(db)
  await views(db, REAL)
}

export async function down(db: Kysely<any>): Promise<void> {
  if (!(await onPostgres(db))) return
  await views(db, REAL_0905)
  await sql`drop table if exists metrics_excluded_people`.execute(db)
}
