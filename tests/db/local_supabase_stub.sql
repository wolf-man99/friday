-- LOCAL TESTING ONLY — never run this in the Supabase dashboard or against a
-- hosted project. To set up Supabase, run supabase/migrations/*.sql instead.
--
-- A minimal stand-in for the parts of a hosted Supabase database that the
-- migrations rely on, so they can be tested on a plain local PostgreSQL.
-- It mirrors Supabase's roles closely enough that permission problems show up:
--   * friday_owner        plays Supabase's non-superuser "postgres" role, which
--                         runs migrations in the SQL editor and owns public objects
--   * supabase_auth_admin owns auth.users and performs sign-ups, like GoTrue
--   * anon / authenticated / service_role / authenticator as in Supabase

-- Refuse to run inside a real Supabase project (every one has supabase_admin).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    raise exception 'STOP: tests/db/local_supabase_stub.sql is for local testing only. In Supabase, run only supabase/migrations/20261018000000_friday_init.sql.';
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit password 'authenticator';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'friday_owner') then
    create role friday_owner nologin nosuperuser bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin nologin nosuperuser noinherit;
  end if;
end
$$;

do $$
begin
  if not pg_has_role('authenticator', 'anon', 'member') then
    grant anon, authenticated, service_role to authenticator;
  end if;
end
$$;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role, friday_owner, supabase_auth_admin;

create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);
alter table auth.users owner to supabase_auth_admin;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid;
$$;

-- What Supabase lets its postgres role do with auth.users: read it, reference it
-- from foreign keys and attach triggers — but not own or alter it.
grant select, references, trigger on auth.users to friday_owner;
grant execute on function auth.uid() to anon, authenticated, service_role, friday_owner;

-- The migration owner owns the public schema, as postgres does in Supabase,
-- and can create schemas of its own (Supabase's postgres role can).
alter schema public owner to friday_owner;
do $$
begin
  execute format('grant create on database %I to friday_owner', current_database());
end
$$;

-- Supabase's default privileges: API roles get table access, RLS decides rows.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role friday_owner in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role friday_owner in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role friday_owner in schema public grant all on sequences to anon, authenticated, service_role;
