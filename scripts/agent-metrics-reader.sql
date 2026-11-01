-- One-time ops step (hosted only, run by the infra owner as the database owner): the read-only login the owner's
-- private dashboard uses for the funnel counts in schema agent_metrics (migration 0900). It can read that schema's
-- views and nothing else: no base tables, no writes. Set the password from the secret store, never commit it:
--   psql "$OWNER_URL" -v pw="$READER_PW" -f scripts/agent-metrics-reader.sql
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'agent_metrics_reader') then
    create role agent_metrics_reader login nobypassrls;
  end if;
end $$;
alter role agent_metrics_reader with login nobypassrls password :'pw';
alter role agent_metrics_reader set statement_timeout = '15s';
revoke all on schema public from agent_metrics_reader;
grant usage on schema agent_metrics to agent_metrics_reader;
grant select on all tables in schema agent_metrics to agent_metrics_reader;
alter default privileges in schema agent_metrics grant select on tables to agent_metrics_reader;
