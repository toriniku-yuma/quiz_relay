begin;
-- Run only in a dedicated development project, using the migration administrator.
-- Set the quiz_probe login password separately; do not save it in SQL history/source.
create role quiz_probe login nosuperuser nocreatedb nocreaterole noinherit;
create schema quiz_probe;
revoke all on schema quiz_probe from public, anon, authenticated;
grant usage on schema quiz_probe to quiz_probe;
create table quiz_probe.runs (
  id uuid primary key,
  created_at timestamptz not null default now()
);
alter table quiz_probe.runs enable row level security;
revoke all on quiz_probe.runs from public, anon, authenticated;
grant select, insert, delete on quiz_probe.runs to quiz_probe;
create policy probe_access on quiz_probe.runs for all to quiz_probe using (true) with check (true);
commit;
