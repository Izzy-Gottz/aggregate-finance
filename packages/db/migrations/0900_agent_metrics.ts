import { sql, type Kysely } from 'kysely'

// Postgres only (a no-op on SQLite): the hosted funnel as aggregate counts, in its own schema `agent_metrics`, for the
// owner's private dashboard. Same shape the owner's other products expose:
//   agent_metrics.daily(day, metric, value)   one count per metric per UTC day
//   agent_metrics.totals(metric, value)       all-time and "now" counts
// Counts only: no ids, emails, names or workspace names leave these views. Base-table access stays with the owner role
// the views run as; the read-only login (scripts/agent-metrics-reader.sql, run once by ops) gets SELECT on this schema
// and nothing else.
//
// Who counts: people who signed in (auth_user_id set), minus system accounts (public demo, app reviewers, challenge
// bots all use @*.invalid addresses). Demo workspaces (settings key 'demo') never count toward activation, AI or
// activity. Activated = first connection or uploaded document the person created; AI connected = first grant to a
// real client (not the demo or preview clients); active = any person or agent action in the activity log that day.

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

export async function up(db: Kysely<any>): Promise<void> {
  if (!(await onPostgres(db))) return
  await sql`create schema if not exists agent_metrics`.execute(db)
  await sql`
    create or replace view agent_metrics.daily as
    with ${FUNNEL}
    select day, metric, value from (
      select substr(created_at, 1, 10)::date as day, 'signups' as metric, count(*)::bigint as value from real_people group by 1
      union all
      select substr(at, 1, 10)::date, 'activated', count(*) from activated group by 1
      union all
      select substr(at, 1, 10)::date, 'ai_connected', count(*) from ai_connected group by 1
      union all
      select d::date, 'active_people', count(*) from active group by 1
    ) t`.execute(db)
  await sql`
    create or replace view agent_metrics.totals as
    with ${FUNNEL}
    select 'signups' as metric, (select count(*) from real_people)::bigint as value
    union all select 'activated', (select count(*) from activated)
    union all select 'ai_connected', (select count(*) from ai_connected)
    union all select 'weekly_active', (select count(distinct person_id) from active where d >= to_char(current_date - 6, 'YYYY-MM-DD'))
    union all select 'paid', 0`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  if (!(await onPostgres(db))) return
  await sql`drop schema if exists agent_metrics cascade`.execute(db)
}
