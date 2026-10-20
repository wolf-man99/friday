-- =============================================================================
-- Friday 0004 — Gmail connection foundation
--
-- What a Gmail connection needs before any ingestion exists:
--   * public.source_connections (0003) gains the metadata a person sees:
--     provider, the Gmail address, granted scopes, connected/checked times
--   * friday_private: a schema the API never exposes, holding
--       gmail_oauth_states    one-time OAuth state, bound to the Friday user
--                             and to the browser that started it
--       gmail_pending_grants  a just-authorised grant waiting for the same
--                             signed-in user, in the same browser, to confirm
--                             it (stops a stranger's link from attaching your
--                             Gmail to their account)
--       gmail_credentials     the refresh token, encrypted by the Edge Function
--                             (AES-256-GCM, key held only in function secrets)
--   * service-role-only functions the Edge Functions call; signed-in users and
--     anonymous visitors can't call them or read the private schema at all
--   * Google's revoke ends the whole grant for a Gmail account, so these
--     functions only hand back a token to revoke when no live connection
--     uses that account
--
-- Nothing here reads mail or records transactions. Additive and re-runnable.
-- =============================================================================

create schema if not exists friday_private;
revoke all on schema friday_private from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Connection metadata (visible to its owner through RLS; no secrets)
-- -----------------------------------------------------------------------------

alter table public.source_connections
  add column if not exists provider text,
  add column if not exists account_email text,
  add column if not exists scopes text[] not null default '{}',
  add column if not exists connected_at timestamptz,
  add column if not exists disconnected_at timestamptz,
  add column if not exists last_checked_at timestamptz,
  add column if not exists last_error_code text;

alter table public.source_connections drop constraint if exists source_connections_status_check;
alter table public.source_connections add constraint source_connections_status_check
  check (status in ('active', 'paused', 'needs_reconnect', 'disconnected'));

alter table public.source_connections drop constraint if exists source_connections_provider_check;
alter table public.source_connections add constraint source_connections_provider_check
  check (provider is null or (provider = 'gmail' and source_type = 'email'));

alter table public.source_connections drop constraint if exists source_connections_account_email_check;
alter table public.source_connections add constraint source_connections_account_email_check
  check (account_email is null or (char_length(account_email) <= 320 and account_email like '%_@_%'));

alter table public.source_connections drop constraint if exists source_connections_last_error_check;
alter table public.source_connections add constraint source_connections_last_error_check
  check (last_error_code is null or last_error_code ~ '^[a-z_]{1,40}$');

-- One live Gmail connection per person.
create unique index if not exists source_connections_one_live_gmail
  on public.source_connections (user_id)
  where provider = 'gmail' and status <> 'disconnected';

-- -----------------------------------------------------------------------------
-- Private tables (no API access; RLS on with no policies as a second lock)
-- -----------------------------------------------------------------------------

create table if not exists friday_private.gmail_oauth_states (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  -- SHA-256 of the state sent to Google; the state itself is never stored.
  state_hash    text not null unique check (state_hash ~ '^[0-9a-f]{64}$'),
  -- PKCE verifier (RFC 7636): useless without the code and the client secret.
  code_verifier text not null check (code_verifier ~ '^[A-Za-z0-9._~-]{43,128}$'),
  -- SHA-256 of a key kept by the browser that started: binds the attempt to it.
  browser_hash  text not null check (browser_hash ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  used_at       timestamptz
);
create index if not exists gmail_oauth_states_user_idx on friday_private.gmail_oauth_states (user_id, expires_at);

create table if not exists friday_private.gmail_pending_grants (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  ticket_hash       text not null unique check (ticket_hash ~ '^[0-9a-f]{64}$'),
  account_email     text not null check (char_length(account_email) <= 320),
  scopes            text[] not null,
  refresh_token_enc text not null check (refresh_token_enc like 'v1.%'),
  browser_hash      text not null check (browser_hash ~ '^[0-9a-f]{64}$'),
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null
);
create index if not exists gmail_pending_grants_user_idx on friday_private.gmail_pending_grants (user_id, expires_at);

create table if not exists friday_private.gmail_credentials (
  connection_id     uuid primary key,
  user_id           uuid not null,
  refresh_token_enc text not null check (refresh_token_enc like 'v1.%'),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint gmail_credentials_connection_fk foreign key (connection_id, user_id)
    references public.source_connections (id, user_id) on delete cascade
);

-- browser_hash arrived in a later draft of this file; states and grants live
-- ten minutes, so rows from before it are simply dropped.
do $$
declare
  v_table text;
begin
  foreach v_table in array array['gmail_oauth_states', 'gmail_pending_grants'] loop
    execute format('alter table friday_private.%I add column if not exists browser_hash text', v_table);
    execute format('delete from friday_private.%I where browser_hash is null', v_table);
    execute format('alter table friday_private.%I alter column browser_hash set not null', v_table);
  end loop;
end
$$;

alter table friday_private.gmail_oauth_states enable row level security;
alter table friday_private.gmail_pending_grants enable row level security;
alter table friday_private.gmail_credentials enable row level security;
revoke all on all tables in schema friday_private from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Service-role functions (called by the Edge Functions)
-- -----------------------------------------------------------------------------

-- Refuses any caller but the service role, even if a grant were added by mistake.
create or replace function public.gmail_require_service_role()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') <> 'service_role' then
    raise exception 'Only Friday''s server can do that' using errcode = '42501';
  end if;
end;
$$;

-- Earlier drafts of these functions had other signatures.
drop function if exists public.gmail_oauth_begin(uuid, text, text, integer);
drop function if exists public.gmail_oauth_consume(text);
drop function if exists public.gmail_store_pending_grant(uuid, text, text, text[], text, integer);
drop function if exists public.gmail_complete_grant(uuid, text);
drop function if exists public.gmail_mark_needs_reconnect(uuid, uuid, text);
drop function if exists public.gmail_disconnect(uuid);

-- Is a Gmail account in use by a live Friday connection (anyone's)? Revoking
-- any token with Google ends Friday's whole grant for that account, every
-- token included — so Friday only revokes a token nothing else depends on.
create or replace function friday_private.gmail_account_live(p_account_email text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.source_connections c
    join friday_private.gmail_credentials cr on cr.connection_id = c.id and cr.user_id = c.user_id
    where c.provider = 'gmail' and c.status = 'active' and c.account_email = lower(p_account_email)
  );
$$;
revoke all on function friday_private.gmail_account_live(text) from public;

-- Starts an OAuth attempt for a user: stores the hashed state, the PKCE
-- verifier and the hashed browser key for ten minutes. At most five attempts
-- may be open at once.
create or replace function public.gmail_oauth_begin(
  p_user_id uuid,
  p_state_hash text,
  p_code_verifier text,
  p_browser_hash text,
  p_ttl_seconds integer default 600
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expires timestamptz := now() + make_interval(secs => least(greatest(coalesce(p_ttl_seconds, 600), 60), 900));
begin
  perform public.gmail_require_service_role();
  if p_user_id is null or not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'Unknown user' using errcode = '22023';
  end if;

  delete from friday_private.gmail_oauth_states
  where user_id = p_user_id and (expires_at < now() - interval '1 day' or used_at < now() - interval '1 day');

  if (select count(*) from friday_private.gmail_oauth_states
      where user_id = p_user_id and used_at is null and expires_at > now()) >= 5 then
    raise exception 'Too many Gmail connection attempts in progress. Try again in a few minutes.' using errcode = 'P0001';
  end if;

  insert into friday_private.gmail_oauth_states (user_id, state_hash, code_verifier, browser_hash, expires_at)
  values (p_user_id, p_state_hash, p_code_verifier, p_browser_hash, v_expires);
  return v_expires;
end;
$$;

-- Uses up a state exactly once. outcome: ok | expired | used | unknown.
create or replace function public.gmail_oauth_consume(p_state_hash text)
returns table (outcome text, user_id uuid, code_verifier text, browser_hash text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_state friday_private.gmail_oauth_states%rowtype;
begin
  perform public.gmail_require_service_role();

  update friday_private.gmail_oauth_states s
  set used_at = now()
  where s.state_hash = p_state_hash and s.used_at is null
  returning * into v_state;

  if not found then
    if exists (select 1 from friday_private.gmail_oauth_states s where s.state_hash = p_state_hash) then
      return query select 'used'::text, null::uuid, null::text, null::text;
    else
      return query select 'unknown'::text, null::uuid, null::text, null::text;
    end if;
    return;
  end if;

  if v_state.expires_at <= now() then
    return query select 'expired'::text, v_state.user_id, null::text, null::text;
    return;
  end if;
  return query select 'ok'::text, v_state.user_id, v_state.code_verifier, v_state.browser_hash;
end;
$$;

-- Parks an authorised grant until the same signed-in user, in the same
-- browser, confirms it.
create or replace function public.gmail_store_pending_grant(
  p_user_id uuid,
  p_ticket_hash text,
  p_account_email text,
  p_scopes text[],
  p_refresh_token_enc text,
  p_browser_hash text,
  p_ttl_seconds integer default 600
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.gmail_require_service_role();
  insert into friday_private.gmail_pending_grants (user_id, ticket_hash, account_email, scopes, refresh_token_enc, browser_hash, expires_at)
  values (p_user_id, p_ticket_hash, lower(p_account_email), p_scopes, p_refresh_token_enc, p_browser_hash,
          now() + make_interval(secs => least(greatest(coalesce(p_ttl_seconds, 600), 60), 900)));
end;
$$;

-- Removes a user's expired pending grants. Hands back the tokens that are
-- safe to revoke with Google (no live connection uses that Gmail account).
create or replace function public.gmail_take_expired_grants(p_user_id uuid)
returns table (refresh_token_enc text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform public.gmail_require_service_role();
  return query
  with gone as (
    delete from friday_private.gmail_pending_grants g
    where g.user_id = p_user_id and g.expires_at <= now()
    returning g.refresh_token_enc, g.account_email
  )
  select gone.refresh_token_enc from gone where not friday_private.gmail_account_live(gone.account_email);
end;
$$;

-- The signed-in user confirms a grant from the browser that started it.
-- outcome: ok | wrong_user | wrong_browser | expired | unknown. Only ok
-- activates anything; every other outcome deletes the grant.
--   refresh_token_enc  (not ok) the grant's token, when it's safe to revoke
--   replaced_token_enc (ok) a credential for a different Gmail account that
--                      this replaced, when it's safe to revoke
--   owner_id           whose token refresh_token_enc is (needed to decrypt it)
-- Reconnecting the same Gmail account replaces the stored token without
-- returning the old one: revoking it would end the new one too.
create or replace function public.gmail_complete_grant(p_user_id uuid, p_ticket_hash text, p_browser_hash text)
returns table (
  outcome text,
  connection_id uuid,
  account_email text,
  refresh_token_enc text,
  replaced_token_enc text,
  owner_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_grant friday_private.gmail_pending_grants%rowtype;
  v_live public.source_connections%rowtype;
  v_connection_id uuid;
  v_replaced text;
  v_revocable text;
begin
  perform public.gmail_require_service_role();
  -- The same lock as gmail_disconnect, taken first in both.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('friday:gmail:' || p_user_id::text, 0));

  delete from friday_private.gmail_pending_grants g
  where g.ticket_hash = p_ticket_hash
  returning * into v_grant;

  if not found then
    return query select 'unknown'::text, null::uuid, null::text, null::text, null::text, null::uuid;
    return;
  end if;

  v_revocable := case when friday_private.gmail_account_live(v_grant.account_email) then null else v_grant.refresh_token_enc end;
  if v_grant.user_id is distinct from p_user_id then
    return query select 'wrong_user'::text, null::uuid, null::text, v_revocable, null::text, v_grant.user_id;
    return;
  end if;
  if v_grant.expires_at <= now() then
    return query select 'expired'::text, null::uuid, null::text, v_revocable, null::text, v_grant.user_id;
    return;
  end if;
  if v_grant.browser_hash is distinct from p_browser_hash then
    return query select 'wrong_browser'::text, null::uuid, null::text, v_revocable, null::text, v_grant.user_id;
    return;
  end if;

  select * into v_live from public.source_connections c
  where c.user_id = p_user_id and c.provider = 'gmail' and c.status <> 'disconnected'
  for update;

  if found and v_live.account_email = v_grant.account_email then
    v_connection_id := v_live.id;
    update public.source_connections set
      status = 'active', scopes = v_grant.scopes, connected_at = now(),
      disconnected_at = null, last_error_code = null, label = left(v_grant.account_email, 80)
    where id = v_live.id;
  else
    if found then
      -- A different Gmail account: the old one is disconnected first.
      delete from friday_private.gmail_credentials cr where cr.connection_id = v_live.id
      returning cr.refresh_token_enc into v_replaced;
      update public.source_connections set status = 'disconnected', disconnected_at = now()
      where id = v_live.id;
      if friday_private.gmail_account_live(v_live.account_email) then
        v_replaced := null;
      end if;
    end if;
    insert into public.source_connections (user_id, source_type, label, status, provider, account_email, scopes, connected_at)
    values (p_user_id, 'email', left(v_grant.account_email, 80), 'active', 'gmail', v_grant.account_email, v_grant.scopes, now())
    returning id into v_connection_id;
  end if;

  insert into friday_private.gmail_credentials (connection_id, user_id, refresh_token_enc)
  values (v_connection_id, p_user_id, v_grant.refresh_token_enc)
  on conflict on constraint gmail_credentials_pkey
  do update set refresh_token_enc = excluded.refresh_token_enc, updated_at = now();

  return query select 'ok'::text, v_connection_id, v_grant.account_email, null::text, v_replaced, p_user_id;
end;
$$;

-- The encrypted refresh token of the user's active Gmail connection, if any.
create or replace function public.gmail_get_credentials(p_user_id uuid)
returns table (connection_id uuid, account_email text, refresh_token_enc text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform public.gmail_require_service_role();
  return query
  select c.id, c.account_email, cr.refresh_token_enc
  from public.source_connections c
  join friday_private.gmail_credentials cr on cr.connection_id = c.id and cr.user_id = c.user_id
  where c.user_id = p_user_id and c.provider = 'gmail' and c.status = 'active';
end;
$$;

-- Google refused this refresh token (revoked, expired): it's deleted and the
-- person is asked to reconnect. Only that exact token: if a reconnect stored a
-- newer one meanwhile, nothing changes.
create or replace function public.gmail_mark_needs_reconnect(
  p_user_id uuid,
  p_connection_id uuid,
  p_refresh_token_enc text,
  p_error_code text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.gmail_require_service_role();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('friday:gmail:' || p_user_id::text, 0));
  delete from friday_private.gmail_credentials
  where connection_id = p_connection_id and user_id = p_user_id and refresh_token_enc = p_refresh_token_enc;
  if found then
    update public.source_connections
    set status = 'needs_reconnect', last_error_code = left(p_error_code, 40)
    where id = p_connection_id and user_id = p_user_id and provider = 'gmail' and status <> 'disconnected';
  end if;
end;
$$;

create or replace function public.gmail_record_check(p_user_id uuid, p_connection_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.gmail_require_service_role();
  update public.source_connections
  set last_checked_at = now(), last_error_code = null
  where id = p_connection_id and user_id = p_user_id and provider = 'gmail';
end;
$$;

-- Disconnects Gmail: deletes every stored credential, pending grant and OAuth
-- state for the user. Returns each deleted token with whether it's safe to
-- revoke with Google (not if another live connection uses that Gmail account).
-- Safe to repeat; the connection row stays (as disconnected) for history.
create or replace function public.gmail_disconnect(p_user_id uuid)
returns table (refresh_token_enc text, revocable boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform public.gmail_require_service_role();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('friday:gmail:' || p_user_id::text, 0));

  update public.source_connections
  set status = 'disconnected', disconnected_at = now()
  where user_id = p_user_id and provider = 'gmail' and status <> 'disconnected';

  return query
  with creds as (
    delete from friday_private.gmail_credentials cr
    using public.source_connections c
    where cr.user_id = p_user_id and c.id = cr.connection_id
    returning cr.refresh_token_enc, c.account_email
  ), grants as (
    delete from friday_private.gmail_pending_grants g where g.user_id = p_user_id
    returning g.refresh_token_enc, g.account_email
  ), states as (
    delete from friday_private.gmail_oauth_states s where s.user_id = p_user_id returning 1
  ), gone as (
    select creds.refresh_token_enc, creds.account_email from creds
    union all
    select grants.refresh_token_enc, grants.account_email from grants
  )
  select gone.refresh_token_enc, not friday_private.gmail_account_live(gone.account_email) from gone;
end;
$$;

-- -----------------------------------------------------------------------------
-- Data deletion also removes Gmail secrets (Friday's UI disconnects first so
-- Google revokes access too).
-- -----------------------------------------------------------------------------

create or replace function public.delete_all_my_data()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;

  update public.profiles set default_account_id = null where id = v_uid;
  delete from friday_private.gmail_oauth_states where user_id = v_uid;
  delete from friday_private.gmail_pending_grants where user_id = v_uid;
  delete from friday_private.gmail_credentials where user_id = v_uid;
  delete from public.source_events where user_id = v_uid;
  delete from public.source_connections where user_id = v_uid;
  delete from public.recurring_occurrences where user_id = v_uid;
  delete from public.recurring_rules where user_id = v_uid;
  delete from public.transfers where user_id = v_uid;
  delete from public.transactions where user_id = v_uid;
  delete from public.ledger_audit where user_id = v_uid;
  delete from public.accounts where user_id = v_uid;
  delete from public.categories where user_id = v_uid;
  perform public.seed_default_categories(v_uid);
end;
$$;

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

revoke execute on function
  public.gmail_require_service_role(),
  public.gmail_oauth_begin(uuid, text, text, text, integer),
  public.gmail_oauth_consume(text),
  public.gmail_store_pending_grant(uuid, text, text, text[], text, text, integer),
  public.gmail_take_expired_grants(uuid),
  public.gmail_complete_grant(uuid, text, text),
  public.gmail_get_credentials(uuid),
  public.gmail_mark_needs_reconnect(uuid, uuid, text, text),
  public.gmail_record_check(uuid, uuid),
  public.gmail_disconnect(uuid)
  from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    -- The server reaches the secrets only through the functions below, never directly.
    revoke all on schema friday_private from service_role;
    revoke all on all tables in schema friday_private from service_role;
    grant execute on function
      public.gmail_require_service_role(),
      public.gmail_oauth_begin(uuid, text, text, text, integer),
      public.gmail_oauth_consume(text),
      public.gmail_store_pending_grant(uuid, text, text, text[], text, text, integer),
      public.gmail_take_expired_grants(uuid),
      public.gmail_complete_grant(uuid, text, text),
      public.gmail_get_credentials(uuid),
      public.gmail_mark_needs_reconnect(uuid, uuid, text, text),
      public.gmail_record_check(uuid, uuid),
      public.gmail_disconnect(uuid)
      to service_role;
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Safety checks: fail the migration rather than expose a secret.
-- -----------------------------------------------------------------------------

do $$
declare
  v_fn text;
  v_table text;
begin
  foreach v_fn in array array[
    'public.gmail_oauth_begin(uuid, text, text, text, integer)',
    'public.gmail_oauth_consume(text)',
    'public.gmail_store_pending_grant(uuid, text, text, text[], text, text, integer)',
    'public.gmail_take_expired_grants(uuid)',
    'public.gmail_complete_grant(uuid, text, text)',
    'public.gmail_get_credentials(uuid)',
    'public.gmail_mark_needs_reconnect(uuid, uuid, text, text)',
    'public.gmail_record_check(uuid, uuid)',
    'public.gmail_disconnect(uuid)'
  ] loop
    if has_function_privilege('anon', v_fn, 'execute') or has_function_privilege('authenticated', v_fn, 'execute') then
      raise exception 'Migration check failed: % must not be callable by anon or authenticated', v_fn;
    end if;
  end loop;

  if has_schema_privilege('anon', 'friday_private', 'usage') or has_schema_privilege('authenticated', 'friday_private', 'usage') then
    raise exception 'Migration check failed: friday_private must not be usable by anon or authenticated';
  end if;

  foreach v_table in array array['friday_private.gmail_oauth_states', 'friday_private.gmail_pending_grants', 'friday_private.gmail_credentials'] loop
    if has_table_privilege('anon', v_table, 'select') or has_table_privilege('authenticated', v_table, 'select') then
      raise exception 'Migration check failed: % must not be readable by clients', v_table;
    end if;
  end loop;

  if has_table_privilege('authenticated', 'public.source_connections', 'insert')
     or has_table_privilege('authenticated', 'public.source_connections', 'update') then
    raise exception 'Migration check failed: source_connections must be read-only to clients';
  end if;
end
$$;

notify pgrst, 'reload schema';
