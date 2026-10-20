-- LOCAL TESTING ONLY — never run this in the Supabase dashboard or against a
-- hosted project. Runs after ledger_model_test.sql (reuses its helpers).
--
-- Tests for the Gmail connection foundation (migration 0004): who can reach the
-- secrets (nobody but the server), one-time expiring OAuth state, grants that
-- only the user who started them can complete, one live connection per person,
-- reconnect and disconnect, and isolation between users. Two new users: G and H.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    raise exception 'STOP: tests/db/gmail_test.sql is for local testing only. In Supabase, run only supabase/migrations/*.sql.';
  end if;
end
$$;

set client_min_messages = notice;

-- A fake sealed token (the Edge Function's AES-GCM format) and a fake hash.
create function tests.sealed(p_label text) returns text language sql immutable as $$
  select 'v1.' || md5(p_label) || '.' || md5('body:' || p_label);
$$;
create function tests.hash(p_label text) returns text language sql immutable as $$
  select encode(sha256(convert_to(p_label, 'UTF8')), 'hex');
$$;
create function tests.verifier(p_label text) returns text language sql immutable as $$
  select md5(p_label) || md5('pkce:' || p_label);
$$;
-- How many secret rows of any kind a user has.
create function tests.private_rows(p_user uuid) returns bigint language sql stable security definer as $$
  select (select count(*) from friday_private.gmail_oauth_states where user_id = p_user)
       + (select count(*) from friday_private.gmail_pending_grants where user_id = p_user)
       + (select count(*) from friday_private.gmail_credentials where user_id = p_user);
$$;
-- Act as Friday's server (the Edge Functions' service-role client).
create function tests.as_server() returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"service_role"}', false);
$$;

grant execute on all functions in schema tests to anon, authenticated, service_role;
grant insert on tests.ids to service_role;

set role supabase_auth_admin;
insert into auth.users (id, email, raw_user_meta_data) values
  ('f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1', 'gita@example.com', '{}'),
  ('f2f2f2f2-f2f2-f2f2-f2f2-f2f2f2f2f2f2', 'hari@example.com', '{}');
reset role;
insert into tests.ids values
  ('G', 'f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1'),
  ('H', 'f2f2f2f2-f2f2-f2f2-f2f2-f2f2f2f2f2f2');

-- -----------------------------------------------------------------------------
-- Nobody but the server reaches the secrets
-- -----------------------------------------------------------------------------

select tests.eq((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname like 'gmail\_%'
                   and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))),
  0::bigint, 'no gmail_* function is callable by anonymous visitors or signed-in users');
select tests.eq((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname like 'gmail\_%' and not p.prosecdef
                   and p.proname <> 'gmail_require_service_role'),
  0::bigint, 'every gmail_* function runs as its owner (the private schema needs no grants)');
select tests.eq(has_schema_privilege('authenticated', 'friday_private', 'usage') or has_schema_privilege('anon', 'friday_private', 'usage'),
  false, 'the private schema is closed to clients');
select tests.eq(has_schema_privilege('service_role', 'friday_private', 'usage'),
  false, 'even the service role reaches the secrets only through the functions');
select tests.eq((select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'friday_private' and c.relkind = 'r'),
  true, 'row level security is on for every private table (with no policies) as a second lock');
select tests.eq((select count(*) from pg_policies where schemaname = 'friday_private'), 0::bigint,
  'and no policy opens them');

-- What a signed-in user can see about a connection holds no secret.
select tests.eq((select count(*) from information_schema.columns
                 where table_schema = 'public' and table_name = 'source_connections'
                   and (column_name ~ '(token|secret|verifier|state_hash|ticket|_enc$)')),
  0::bigint, 'source_connections (client-readable) has no token, secret or ticket column');
select tests.eq((select count(*) from information_schema.columns
                 where table_schema = 'public' and column_name ~ '(refresh_token|access_token|code_verifier)'),
  0::bigint, 'no client-readable table in public stores tokens or PKCE verifiers');

set role authenticated;
select tests.login(tests.id('G'));
select tests.throws($$select * from friday_private.gmail_credentials$$, 'permission denied',
  'a signed-in user can''t read stored credentials');
select tests.throws($$select * from friday_private.gmail_oauth_states$$, 'permission denied',
  'or OAuth state');
select tests.throws($$select * from friday_private.gmail_pending_grants$$, 'permission denied',
  'or parked grants');
select tests.throws($$select public.gmail_get_credentials(tests.id('G'))$$, 'permission denied',
  'a signed-in user can''t call the credential function, even for themselves');
select tests.throws($$select public.gmail_oauth_begin(tests.id('G'), tests.hash('x'), tests.verifier('x'))$$, 'permission denied',
  'or start an OAuth attempt directly');
select tests.throws($$select public.gmail_disconnect(tests.id('H'))$$, 'permission denied',
  'or disconnect someone else');
select tests.throws($$insert into public.source_connections (user_id, source_type, label, provider, account_email, status)
                      values (tests.id('G'), 'email', 'me@gmail.com', 'gmail', 'me@gmail.com', 'active')$$, 'permission denied',
  'clients can''t create a connection row themselves');
reset role;

set role anon;
select tests.throws($$select * from public.gmail_complete_grant(tests.id('G'), tests.hash('t'))$$, 'permission denied',
  'anonymous visitors can''t complete grants');
reset role;

-- Defence in depth: even with an accidental grant, the functions check the caller.
select tests.login(tests.id('G'));
select tests.throws($$select public.gmail_get_credentials(tests.id('G'))$$, 'Only Friday''s server',
  'the functions refuse a caller that isn''t the service role, whatever the grants say');

-- -----------------------------------------------------------------------------
-- OAuth state: bound to a user, one-time, expiring
-- -----------------------------------------------------------------------------

set role service_role;
select tests.as_server();

select tests.throws($$select public.gmail_oauth_begin('00000000-0000-0000-0000-00000000dead', tests.hash('s0'), tests.verifier('s0'))$$,
  'Unknown user', 'state can only be bound to a real Friday user');
select tests.throws($$select public.gmail_oauth_begin(tests.id('G'), 'not-a-hash', tests.verifier('s0'))$$,
  'check constraint', 'only a SHA-256 hash of the state is stored, never the state itself');
select tests.throws($$select public.gmail_oauth_begin(tests.id('G'), tests.hash('s0'), 'short')$$,
  'check constraint', 'the PKCE verifier must be RFC 7636-shaped');

select tests.eq((select round(extract(epoch from public.gmail_oauth_begin(tests.id('G'), tests.hash('s1'), tests.verifier('s1')) - now()))),
  600::numeric, 'a state lives ten minutes by default');
select tests.eq((select round(extract(epoch from public.gmail_oauth_begin(tests.id('G'), tests.hash('s2'), tests.verifier('s2'), 5) - now()))),
  60::numeric, 'no shorter than a minute');
select tests.eq((select round(extract(epoch from public.gmail_oauth_begin(tests.id('G'), tests.hash('s3'), tests.verifier('s3'), 86400) - now()))),
  900::numeric, 'and never longer than fifteen');

select tests.eq((select row(outcome, user_id, code_verifier)::text from public.gmail_oauth_consume(tests.hash('nobody-made-this'))),
  row('unknown', null::uuid, null::text)::text, 'an unknown state is refused');
select tests.eq((select row(outcome, user_id, code_verifier)::text from public.gmail_oauth_consume(tests.hash('s1'))),
  row('ok', tests.id('G'), tests.verifier('s1'))::text, 'a valid state names the user who started it, with its verifier');
select tests.eq((select row(outcome, user_id, code_verifier)::text from public.gmail_oauth_consume(tests.hash('s1'))),
  row('used', null::uuid, null::text)::text, 'a state works once: replaying it is refused');

reset role;
update friday_private.gmail_oauth_states set expires_at = now() - interval '1 second' where state_hash = tests.hash('s2');
set role service_role;
select tests.eq((select row(outcome, code_verifier)::text from public.gmail_oauth_consume(tests.hash('s2'))),
  row('expired', null::text)::text, 'an expired state is refused (and its verifier isn''t handed out)');
select tests.eq((select outcome from public.gmail_oauth_consume(tests.hash('s2'))), 'used',
  'and it is used up all the same');

-- s3 is still open; four more reach the limit of five open attempts.
select tests.eq((select count(public.gmail_oauth_begin(tests.id('G'), tests.hash('s' || n), tests.verifier('s' || n))) from generate_series(4, 7) n),
  4::bigint, 'four more attempts open');
select tests.throws($$select public.gmail_oauth_begin(tests.id('G'), tests.hash('s8'), tests.verifier('s8'))$$,
  'Too many Gmail connection attempts', 'at most five attempts can be open at once');
select tests.eq((select count(*) from public.gmail_oauth_begin(tests.id('H'), tests.hash('h1'), tests.verifier('h1'))), 1::bigint,
  'the limit is per person');
select tests.throws($$select public.gmail_oauth_begin(tests.id('H'), tests.hash('s3'), tests.verifier('s3'))$$,
  'duplicate key', 'a state can''t be registered twice');

-- -----------------------------------------------------------------------------
-- Parked grants: only the user who started can complete
-- -----------------------------------------------------------------------------

select public.gmail_store_pending_grant(tests.id('G'), tests.hash('ticket-1'), 'Gita@Gmail.com',
  array['https://www.googleapis.com/auth/gmail.readonly'], tests.sealed('g-token-1'));
select tests.throws($$select public.gmail_store_pending_grant(tests.id('G'), tests.hash('ticket-raw'), 'gita@gmail.com',
                      array['https://www.googleapis.com/auth/gmail.readonly'], '1//raw-refresh-token')$$,
  'check constraint', 'a raw (unencrypted) refresh token is refused');

-- H holds G's ticket (e.g. G's browser was tricked into H's flow): refused,
-- the grant destroyed and handed back for revocation under its owner.
select tests.eq((select row(outcome, connection_id, account_email, refresh_token_enc, replaced_token_enc, owner_id)::text
                 from public.gmail_complete_grant(tests.id('H'), tests.hash('ticket-1'))),
  row('wrong_user', null::uuid, null::text, tests.sealed('g-token-1'), null::text, tests.id('G'))::text,
  'another user can''t complete a grant; it comes back to be revoked');
select tests.eq((select outcome from public.gmail_complete_grant(tests.id('G'), tests.hash('ticket-1'))), 'unknown',
  'and it is gone: not even its owner can use it afterwards');
select tests.eq((select count(*) from public.source_connections where provider = 'gmail' and user_id in (tests.id('G'), tests.id('H'))),
  0::bigint, 'nothing was connected');

select public.gmail_store_pending_grant(tests.id('G'), tests.hash('ticket-old'), 'gita@gmail.com',
  array['https://www.googleapis.com/auth/gmail.readonly'], tests.sealed('g-token-old'));
reset role;
update friday_private.gmail_pending_grants set expires_at = now() - interval '1 second' where ticket_hash = tests.hash('ticket-old');
set role service_role;
select tests.eq((select row(outcome, refresh_token_enc, owner_id)::text from public.gmail_complete_grant(tests.id('G'), tests.hash('ticket-old'))),
  row('expired', tests.sealed('g-token-old'), tests.id('G'))::text, 'an expired grant isn''t connected; its token comes back to be revoked');

select public.gmail_store_pending_grant(tests.id('G'), tests.hash('ticket-stale'), 'gita@gmail.com',
  array['https://www.googleapis.com/auth/gmail.readonly'], tests.sealed('g-token-stale'));
reset role;
update friday_private.gmail_pending_grants set expires_at = now() - interval '1 second' where ticket_hash = tests.hash('ticket-stale');
set role service_role;
select tests.eq((select array_agg(refresh_token_enc) from public.gmail_take_expired_grants(tests.id('H'))), null::text[],
  'sweeping abandoned grants only touches the caller''s own');
select tests.eq((select array_agg(refresh_token_enc) from public.gmail_take_expired_grants(tests.id('G'))),
  array[tests.sealed('g-token-stale')], 'abandoned grants are swept and handed back to be revoked');

-- -----------------------------------------------------------------------------
-- Connecting, reconnecting, switching accounts
-- -----------------------------------------------------------------------------

select public.gmail_store_pending_grant(tests.id('G'), tests.hash('ticket-2'), 'gita@gmail.com',
  array['https://www.googleapis.com/auth/gmail.readonly'], tests.sealed('g-token-2'));
insert into tests.ids
select 'G:gmail', connection_id from public.gmail_complete_grant(tests.id('G'), tests.hash('ticket-2'));
select tests.eq((select row(provider, source_type, status, account_email, label, scopes, connected_at is not null)::text
                 from public.source_connections where id = tests.id('G:gmail')),
  row('gmail', 'email', 'active', 'gita@gmail.com', 'gita@gmail.com', array['https://www.googleapis.com/auth/gmail.readonly'], true)::text,
  'completing as the right user connects Gmail read-only');
select tests.eq((select row(connection_id, account_email, refresh_token_enc)::text from public.gmail_get_credentials(tests.id('G'))),
  row(tests.id('G:gmail'), 'gita@gmail.com', tests.sealed('g-token-2'))::text, 'the server gets back exactly the sealed token');
select tests.eq((select count(*) from public.gmail_get_credentials(tests.id('H'))), 0::bigint,
  'and nothing for anyone else');

-- The same Gmail again (e.g. after Google dropped the token): same connection, new token.
select public.gmail_store_pending_grant(tests.id('G'), tests.hash('ticket-3'), 'gita@gmail.com',
  array['https://www.googleapis.com/auth/gmail.readonly'], tests.sealed('g-token-3'));
select tests.eq((select row(outcome, connection_id, replaced_token_enc)::text from public.gmail_complete_grant(tests.id('G'), tests.hash('ticket-3'))),
  row('ok', tests.id('G:gmail'), tests.sealed('g-token-2'))::text,
  'reconnecting the same Gmail keeps the connection and hands back the old token to revoke');
select tests.eq((select refresh_token_enc from public.gmail_get_credentials(tests.id('G'))), tests.sealed('g-token-3'),
  'only the new token is stored');

-- A different Gmail address replaces the connection (one live Gmail per person).
select public.gmail_store_pending_grant(tests.id('G'), tests.hash('ticket-4'), 'gita.work@gmail.com',
  array['https://www.googleapis.com/auth/gmail.readonly'], tests.sealed('g-token-4'));
insert into tests.ids
select 'G:gmail2', connection_id from public.gmail_complete_grant(tests.id('G'), tests.hash('ticket-4'))
where replaced_token_enc = tests.sealed('g-token-3');
select tests.eq((select string_agg(account_email || ':' || status, ', ' order by connected_at) from public.source_connections
                 where user_id = tests.id('G') and provider = 'gmail'),
  'gita@gmail.com:disconnected, gita.work@gmail.com:active', 'switching Gmail accounts disconnects the old one');
reset role;
select tests.eq((select count(*) from friday_private.gmail_credentials where user_id = tests.id('G')), 1::bigint,
  'and keeps no credential for it');
select tests.throws($$insert into public.source_connections (user_id, source_type, label, provider, account_email, status)
                      values (tests.id('G'), 'email', 'x@gmail.com', 'gmail', 'x@gmail.com', 'active')$$,
  'source_connections_one_live_gmail', 'the database allows one live Gmail connection per person');
select tests.throws($$insert into friday_private.gmail_credentials (connection_id, user_id, refresh_token_enc)
                      values (tests.id('G:gmail2'), tests.id('H'), tests.sealed('h'))$$,
  'gmail_credentials', 'a credential can''t be attached to someone else''s connection');
set role service_role;

-- H connects too, so isolation can be checked both ways.
select public.gmail_store_pending_grant(tests.id('H'), tests.hash('ticket-h'), 'hari@gmail.com',
  array['https://www.googleapis.com/auth/gmail.readonly'], tests.sealed('h-token-1'));
insert into tests.ids
select 'H:gmail', connection_id from public.gmail_complete_grant(tests.id('H'), tests.hash('ticket-h'));

-- -----------------------------------------------------------------------------
-- What each person sees (RLS)
-- -----------------------------------------------------------------------------

reset role;
set role authenticated;
select tests.login(tests.id('G'));
select tests.eq((select string_agg(account_email || ':' || status, ', ' order by connected_at) from public.source_connections where provider = 'gmail'),
  'gita@gmail.com:disconnected, gita.work@gmail.com:active', 'G sees only G''s Gmail connections');
select tests.login(tests.id('H'));
select tests.eq((select string_agg(account_email, ', ') from public.source_connections where provider = 'gmail'),
  'hari@gmail.com', 'H sees only H''s');
select tests.throws($$update public.source_connections set status = 'active' where id = tests.id('H:gmail')$$, 'permission denied',
  'clients can''t change a connection''s status');
reset role;

-- -----------------------------------------------------------------------------
-- Google stops accepting the token; checks; isolation of the server calls
-- -----------------------------------------------------------------------------

set role service_role;
select tests.as_server();
select public.gmail_mark_needs_reconnect(tests.id('H'), tests.id('G:gmail2'), 'invalid_grant');
select tests.eq((select status from public.source_connections where id = tests.id('G:gmail2')), 'active',
  'a call naming the wrong user changes nothing on another person''s connection');
select public.gmail_record_check(tests.id('H'), tests.id('G:gmail2'));
select tests.eq((select last_checked_at from public.source_connections where id = tests.id('G:gmail2')), null::timestamptz,
  'nor records a check on it');

select public.gmail_record_check(tests.id('G'), tests.id('G:gmail2'));
select tests.eq((select last_checked_at is not null from public.source_connections where id = tests.id('G:gmail2')), true,
  'a successful check is recorded');

select public.gmail_mark_needs_reconnect(tests.id('G'), tests.id('G:gmail2'), 'invalid_grant');
select tests.eq((select row(status, last_error_code)::text from public.source_connections where id = tests.id('G:gmail2')),
  row('needs_reconnect', 'invalid_grant')::text, 'a refused token asks the person to reconnect');
select tests.eq((select count(*) from public.gmail_get_credentials(tests.id('G'))), 0::bigint,
  'and the useless credential is deleted');
select tests.throws($$select public.gmail_mark_needs_reconnect(tests.id('G'), tests.id('G:gmail2'), 'Bearer abc.def')$$,
  'check constraint', 'error codes are short codes, never free text (or tokens)');

-- -----------------------------------------------------------------------------
-- Disconnect
-- -----------------------------------------------------------------------------

select tests.eq((select count(*) from generate_series(3, 7) n, public.gmail_oauth_consume(tests.hash('s' || n)) c where c.outcome = 'ok'),
  5::bigint, 'the open attempts complete');
select tests.eq(public.gmail_oauth_begin(tests.id('G'), tests.hash('s-late'), tests.verifier('s-late'), 600) > now(), true,
  'so a new attempt can start');
select public.gmail_store_pending_grant(tests.id('G'), tests.hash('ticket-5'), 'gita@gmail.com',
  array['https://www.googleapis.com/auth/gmail.readonly'], tests.sealed('g-token-5'));
-- Reconnect, so there is a credential and a parked grant to remove.
select public.gmail_store_pending_grant(tests.id('G'), tests.hash('ticket-6'), 'gita.work@gmail.com',
  array['https://www.googleapis.com/auth/gmail.readonly'], tests.sealed('g-token-6'));
select tests.eq((select row(outcome, connection_id)::text from public.gmail_complete_grant(tests.id('G'), tests.hash('ticket-6'))),
  row('ok', tests.id('G:gmail2'))::text, 'reconnecting after "needs reconnect" reuses the connection');

select tests.eq((select array_agg(refresh_token_enc order by refresh_token_enc) from public.gmail_disconnect(tests.id('G'))),
  (select array_agg(t order by t) from unnest(array[tests.sealed('g-token-6'), tests.sealed('g-token-5')]) t),
  'disconnecting hands back every stored token (credential and parked grant) to revoke');
select tests.eq(tests.private_rows(tests.id('G')), 0::bigint, 'and deletes every secret: credentials, grants and OAuth state');
select tests.eq((select count(*) from public.source_connections where user_id = tests.id('G') and provider = 'gmail' and status <> 'disconnected'),
  0::bigint, 'no Gmail connection is live afterwards');
select tests.eq((select disconnected_at is not null from public.source_connections where id = tests.id('G:gmail2')), true,
  'the connection stays, marked disconnected, for history');
select tests.eq((select count(*) from public.gmail_disconnect(tests.id('G'))), 0::bigint, 'disconnecting again is harmless');
select tests.eq((select count(*) from public.gmail_get_credentials(tests.id('G'))), 0::bigint,
  'a disconnected account has no credentials to fetch with');
select tests.eq((select count(*) from public.gmail_get_credentials(tests.id('H'))), 1::bigint,
  'H''s connection is untouched by G''s disconnect');
select tests.eq((select outcome from public.gmail_complete_grant(tests.id('G'), tests.hash('ticket-5'))), 'unknown',
  'a grant parked before disconnecting can''t be completed afterwards');
select tests.eq((select outcome from public.gmail_oauth_consume(tests.hash('s-late'))), 'unknown',
  'nor can an OAuth attempt started before it');
reset role;

-- -----------------------------------------------------------------------------
-- Deleting all data, and deleting the account
-- -----------------------------------------------------------------------------

set role authenticated;
select tests.login(tests.id('H'));
select public.delete_all_my_data();
reset role;
select tests.eq(tests.private_rows(tests.id('H')), 0::bigint, 'deleting all my data removes Gmail secrets too');
select tests.eq((select count(*) from public.source_connections where user_id = tests.id('H')), 0::bigint,
  'and the connection');

set role service_role;
select tests.as_server();
select public.gmail_store_pending_grant(tests.id('H'), tests.hash('ticket-h2'), 'hari@gmail.com',
  array['https://www.googleapis.com/auth/gmail.readonly'], tests.sealed('h-token-2'));
select tests.eq((select outcome from public.gmail_complete_grant(tests.id('H'), tests.hash('ticket-h2'))), 'ok', 'H connects again');
reset role;
delete from auth.users where id = tests.id('H');
select tests.eq(tests.private_rows(tests.id('H')), 0::bigint, 'deleting the account removes every Gmail secret');

\echo All Gmail connection tests passed.
