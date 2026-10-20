-- =============================================================================
-- Friday 0004 — Gmail connection foundation
--
-- What a Gmail connection needs before any ingestion exists:
--   * public.source_connections (0003) gains the metadata a person sees:
--     provider, the Gmail address, granted scopes, connected/checked times
--   * friday_private: a schema the API never exposes, holding
--       gmail_oauth_states    one-time OAuth state, bound to the Friday user
--       gmail_pending_grants  a just-authorised grant waiting for the same
--                             signed-in user to confirm it (stops a stranger's
--                             link from attaching your Gmail to their account)
--       gmail_credentials     the refresh token, encrypted by the Edge Function
--                             (AES-256-GCM, key held only in function secrets)
--   * service-role-only functions the Edge Functions call; signed-in users and
--     anonymous visitors can't call them or read the private schema at all
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

-- Starts an OAuth attempt for a user: stores the hashed state and the PKCE
-- verifier for ten minutes. At most five attempts may be open at once.
create or replace function public.gmail_oauth_begin(
  p_user_id uuid,
  p_state_hash text,
  p_code_verifier text,
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

  insert into friday_private.gmail_oauth_states (user_id, state_hash, code_verifier, expires_at)
  values (p_user_id, p_state_hash, p_code_verifier, v_expires);
  return v_expires;
end;
$$;

-- Uses up a state exactly once. outcome: ok | expired | used | unknown.
create or replace function public.gmail_oauth_consume(p_state_hash text)
returns table (outcome text, user_id uuid, code_verifier text)
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
      return query select 'used'::text, null::uuid, null::text;
    else
      return query select 'unknown'::text, null::uuid, null::text;
    end if;
    return;
  end if;

  if v_state.expires_at <= now() then
    return query select 'expired'::text, v_state.user_id, null::text;
    return;
  end if;
  return query select 'ok'::text, v_state.user_id, v_state.code_verifier;
end;
$$;

-- Parks an authorised grant until the same signed-in user confirms it.
create or replace function public.gmail_store_pending_grant(
  p_user_id uuid,
  p_ticket_hash text,
  p_account_email text,
  p_scopes text[],
  p_refresh_token_enc text,
  p_ttl_seconds integer default 600
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.gmail_require_service_role();
  insert into friday_private.gmail_pending_grants (user_id, ticket_hash, account_email, scopes, refresh_token_enc, expires_at)
  values (p_user_id, p_ticket_hash, lower(p_account_email), p_scopes, p_refresh_token_enc,
          now() + make_interval(secs => least(greatest(coalesce(p_ttl_seconds, 600), 60), 900)));
end;
$$;

-- Removes a user's expired pending grants and hands their tokens back so the
-- caller can revoke them with Google.
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
  delete from friday_private.gmail_pending_grants g
  where g.user_id = p_user_id and g.expires_at <= now()
  returning g.refresh_token_enc;
end;
$$;

-- The signed-in user confirms a grant. outcome: ok | wrong_user | expired |
-- unknown. Only ok activates anything; every other outcome deletes the grant
-- and returns its token (and owner, to decrypt it) for revocation.
-- replaced_token_enc is the credential an ok replaced (revoke it too).
drop function if exists public.gmail_complete_grant(uuid, text);
create function public.gmail_complete_grant(p_user_id uuid, p_ticket_hash text)
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
begin
  perform public.gmail_require_service_role();

  delete from friday_private.gmail_pending_grants g
  where g.ticket_hash = p_ticket_hash
  returning * into v_grant;

  if not found then
    return query select 'unknown'::text, null::uuid, null::text, null::text, null::text, null::uuid;
    return;
  end if;
  if v_grant.user_id is distinct from p_user_id then
    return query select 'wrong_user'::text, null::uuid, null::text, v_grant.refresh_token_enc, null::text, v_grant.user_id;
    return;
  end if;
  if v_grant.expires_at <= now() then
    return query select 'expired'::text, null::uuid, null::text, v_grant.refresh_token_enc, null::text, v_grant.user_id;
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('friday:gmail:' || p_user_id::text, 0));

  select * into v_live from public.source_connections c
  where c.user_id = p_user_id and c.provider = 'gmail' and c.status <> 'disconnected'
  for update;

  if found and v_live.account_email = v_grant.account_email then
    v_connection_id := v_live.id;
    select cr.refresh_token_enc into v_replaced from friday_private.gmail_credentials cr where cr.connection_id = v_live.id;
    update public.source_connections set
      status = 'active', scopes = v_grant.scopes, connected_at = now(),
      disconnected_at = null, last_error_code = null, label = v_grant.account_email
    where id = v_live.id;
  else
    if found then
      -- A different Gmail account: the old one is disconnected first.
      delete from friday_private.gmail_credentials cr where cr.connection_id = v_live.id
      returning cr.refresh_token_enc into v_replaced;
      update public.source_connections set status = 'disconnected', disconnected_at = now()
      where id = v_live.id;
    end if;
    insert into public.source_connections (user_id, source_type, label, status, provider, account_email, scopes, connected_at)
    values (p_user_id, 'email', v_grant.account_email, 'active', 'gmail', v_grant.account_email, v_grant.scopes, now())
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

-- Google refused the refresh token (revoked, expired): the stored credential
-- is useless, so it's deleted and the person is asked to reconnect.
create or replace function public.gmail_mark_needs_reconnect(p_user_id uuid, p_connection_id uuid, p_error_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.gmail_require_service_role();
  delete from friday_private.gmail_credentials where connection_id = p_connection_id and user_id = p_user_id;
  update public.source_connections
  set status = 'needs_reconnect', last_error_code = left(p_error_code, 40)
  where id = p_connection_id and user_id = p_user_id and provider = 'gmail' and status <> 'disconnected';
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

-- Disconnects Gmail: deletes every stored credential and pending grant for the
-- user and returns their tokens so the caller can revoke them with Google.
-- Safe to repeat; the connection row stays (as disconnected) for history.
create or replace function public.gmail_disconnect(p_user_id uuid)
returns table (refresh_token_enc text)
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
    delete from friday_private.gmail_credentials cr where cr.user_id = p_user_id returning cr.refresh_token_enc
  ), grants as (
    delete from friday_private.gmail_pending_grants g where g.user_id = p_user_id returning g.refresh_token_enc
  ), states as (
    delete from friday_private.gmail_oauth_states s where s.user_id = p_user_id returning 1
  )
  select creds.refresh_token_enc from creds
  union all
  select grants.refresh_token_enc from grants;
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
  public.gmail_oauth_begin(uuid, text, text, integer),
  public.gmail_oauth_consume(text),
  public.gmail_store_pending_grant(uuid, text, text, text[], text, integer),
  public.gmail_take_expired_grants(uuid),
  public.gmail_complete_grant(uuid, text),
  public.gmail_get_credentials(uuid),
  public.gmail_mark_needs_reconnect(uuid, uuid, text),
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
      public.gmail_oauth_begin(uuid, text, text, integer),
      public.gmail_oauth_consume(text),
      public.gmail_store_pending_grant(uuid, text, text, text[], text, integer),
      public.gmail_take_expired_grants(uuid),
      public.gmail_complete_grant(uuid, text),
      public.gmail_get_credentials(uuid),
      public.gmail_mark_needs_reconnect(uuid, uuid, text),
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
    'public.gmail_oauth_begin(uuid, text, text, integer)',
    'public.gmail_oauth_consume(text)',
    'public.gmail_store_pending_grant(uuid, text, text, text[], text, integer)',
    'public.gmail_take_expired_grants(uuid)',
    'public.gmail_complete_grant(uuid, text)',
    'public.gmail_get_credentials(uuid)',
    'public.gmail_mark_needs_reconnect(uuid, uuid, text)',
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
