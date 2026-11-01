import { sql, type Kysely } from 'kysely'

// Postgres only (a no-op on SQLite): two more counts in the owner's dashboard views (34, 2026-10-13, before launch).
//   yc_grants    YC Deal redemptions: workspace_grants of kind 'yc' not revoked, by the day granted.
//   agent_calls  every AI tool call in the activity log, demo workspaces included, plus the copies the challenge's
//                nightly reset keeps in challenge_activity (deduplicated by the original row's id). On
//                challenge.aggregate.finance, where every player works in a demo workspace, these are the attempts.
// The funnel itself is unchanged (copied from 0900, since each migration stands alone). Counts only, as in 0900.

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

// Same columns either way, so `create or replace` works up and down; down is 0900's views exactly.
async function views(db: Kysely<any>, more: boolean): Promise<void> {
  const daily = more ? sql`
      union all
      select substr(at, 1, 10)::date, 'yc_grants', count(*) from yc group by 1
      union all
      select substr(at, 1, 10)::date, 'agent_calls', count(*) from calls where at >= to_char(current_date - 400, 'YYYY-MM-DD') group by 1` : sql``
  const totals = more ? sql`
    union all select 'yc_grants', (select count(*) from yc)
    union all select 'agent_calls', (select count(*) from calls)` : sql``
  const ctes = more ? sql`${FUNNEL}, ${EXTRA}` : FUNNEL
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
  if (await onPostgres(db)) await views(db, true)
}

export async function down(db: Kysely<any>): Promise<void> {
  if (await onPostgres(db)) await views(db, false)
}
