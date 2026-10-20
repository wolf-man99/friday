-- =============================================================================
-- Friday 0005 — Import past transactions from Gmail
--
-- Builds on 0003's import boundary (source_events + ingest_source_event_for,
-- which decides "record it" or "review it, and why") and 0004's Gmail
-- connection. Adds:
--   * accounts.balance_from: when history older than an account's start is
--     imported, the account's balance stays exactly what it was — entries
--     before balance_from count in spending, not in the balance (the starting
--     balance already includes them)
--   * import_account_aliases: which Friday account a bank/card number seen in
--     email belongs to (or that it's ignored), confirmed by the person once
--   * gmail_import_jobs: one import of chosen months, with its progress
--   * friday_private.gmail_import_items: what was read from each email
--     (parsed facts only — never the email itself)
--   * service-role-only functions for each step: begin, add messages, save
--     parsed results, list discovered accounts, apply the person's choices,
--     import in batches, undo
--
-- Additive and re-runnable. Nothing here changes an existing balance.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Balances that ignore history from before a date
-- -----------------------------------------------------------------------------

alter table public.accounts add column if not exists balance_from date;

-- Same columns as 0003 (balance_from appended): every balance term counts only
-- entries dated (in the person's time zone) on or after balance_from, when set.
create or replace view public.account_balances
with (security_invoker = true)
as
select
  a.id,
  a.user_id,
  a.name,
  a.type,
  a.currency,
  a.color,
  a.status,
  a.sort_order,
  a.opening_balance_minor,
  a.opening_date,
  coalesce(t.income_minor, 0)::bigint    as income_minor,
  coalesce(t.expense_minor, 0)::bigint   as expense_minor,
  coalesce(tin.amount_minor, 0)::bigint  as transfers_in_minor,
  coalesce(tout.amount_minor, 0)::bigint as transfers_out_minor,
  b.balance_minor,
  a.institution_name,
  a.credit_limit_minor,
  coalesce(t.refunds_minor, 0)::bigint          as refunds_minor,
  coalesce(t.reversed_income_minor, 0)::bigint  as reversed_income_minor,
  (coalesce(t.pending_minor, 0) + coalesce(tin.pending_minor, 0) - coalesce(tout.pending_minor, 0))::bigint
                                                as pending_minor,
  (coalesce(r.transactions, 0) + coalesce(r.transfers, 0))::bigint as review_count,
  (case when a.type = 'credit_card' then greatest(-b.balance_minor, 0) end)::bigint as outstanding_minor,
  (case when a.type = 'credit_card' and a.credit_limit_minor is not null
        then a.credit_limit_minor - greatest(-b.balance_minor, 0) end)::bigint as available_credit_minor,
  a.balance_from
from public.accounts a
left join lateral (
  select coalesce((select p.timezone from public.profiles p where p.id = a.user_id), 'UTC') as zone
) tz on true
left join lateral (
  select
    sum(x.amount_minor) filter (where x.type = 'income')  as income_minor,
    sum(x.amount_minor) filter (where x.type = 'expense') as expense_minor,
    sum(x.amount_minor) filter (where x.type = 'refund' or (x.type = 'reversal' and x.base_type = 'expense'))
                                                          as refunds_minor,
    sum(x.amount_minor) filter (where x.type = 'reversal' and x.base_type = 'income')
                                                          as reversed_income_minor,
    sum(case when x.type in ('income', 'refund') or (x.type = 'reversal' and x.base_type = 'expense')
             then x.amount_minor else -x.amount_minor end) filter (where x.status = 'pending')
                                                          as pending_minor
  from public.transactions x
  where x.account_id = a.id and x.deleted_at is null and x.status in ('posted', 'pending')
    and (a.balance_from is null or (x.occurred_at at time zone tz.zone)::date >= a.balance_from)
) t on true
left join lateral (
  select sum(x.amount_minor) as amount_minor,
         sum(x.amount_minor) filter (where x.status = 'pending') as pending_minor
  from public.transfers x
  where x.destination_account_id = a.id and x.deleted_at is null and x.status in ('posted', 'pending')
    and (a.balance_from is null or (x.occurred_at at time zone tz.zone)::date >= a.balance_from)
) tin on true
left join lateral (
  select sum(x.amount_minor) as amount_minor,
         sum(x.amount_minor) filter (where x.status = 'pending') as pending_minor
  from public.transfers x
  where x.source_account_id = a.id and x.deleted_at is null and x.status in ('posted', 'pending')
    and (a.balance_from is null or (x.occurred_at at time zone tz.zone)::date >= a.balance_from)
) tout on true
left join lateral (
  select
    (select count(*) from public.transactions x
     where x.account_id = a.id and x.deleted_at is null and x.status = 'needs_review') as transactions,
    (select count(*) from public.transfers x
     where (x.source_account_id = a.id or x.destination_account_id = a.id)
       and x.deleted_at is null and x.status = 'needs_review') as transfers
) r on true
cross join lateral (
  select (a.opening_balance_minor
    + coalesce(t.income_minor, 0)
    - coalesce(t.expense_minor, 0)
    + coalesce(t.refunds_minor, 0)
    - coalesce(t.reversed_income_minor, 0)
    + coalesce(tin.amount_minor, 0)
    - coalesce(tout.amount_minor, 0))::bigint as balance_minor
) b;

revoke all on public.account_balances from anon, authenticated, public;
grant select on public.account_balances to authenticated;

-- What an account's counted entries before a date add up to (money in positive).
create or replace function friday_private.account_net_before(p_user_id uuid, p_account_id uuid, p_before date, p_zone text)
returns bigint
language sql
stable
set search_path = ''
as $$
  select
    coalesce((
      select sum(case when x.type in ('income', 'refund') or (x.type = 'reversal' and x.base_type = 'expense')
                      then x.amount_minor else -x.amount_minor end)
      from public.transactions x
      where x.user_id = p_user_id and x.account_id = p_account_id and x.deleted_at is null
        and x.status in ('posted', 'pending') and (x.occurred_at at time zone p_zone)::date < p_before), 0)
    + coalesce((
      select sum(x.amount_minor) from public.transfers x
      where x.user_id = p_user_id and x.destination_account_id = p_account_id and x.deleted_at is null
        and x.status in ('posted', 'pending') and (x.occurred_at at time zone p_zone)::date < p_before), 0)
    - coalesce((
      select sum(x.amount_minor) from public.transfers x
      where x.user_id = p_user_id and x.source_account_id = p_account_id and x.deleted_at is null
        and x.status in ('posted', 'pending') and (x.occurred_at at time zone p_zone)::date < p_before), 0);
$$;
revoke all on function friday_private.account_net_before(uuid, uuid, date, text) from public;

-- -----------------------------------------------------------------------------
-- Which Friday account an account or card number seen in email belongs to
-- -----------------------------------------------------------------------------

create table if not exists public.import_account_aliases (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  source_type      text not null default 'email' check (source_type = 'email'),
  institution_key  text not null check (institution_key ~ '^[a-z0-9_]{1,40}$'),
  institution_name text not null check (char_length(institution_name) between 1 and 80),
  instrument       text not null check (instrument in ('bank', 'credit_card', 'debit_card', 'wallet', 'unknown')),
  -- Digits as the email shows them ('' when it shows none, e.g. a wallet).
  account_mask     text not null default '' check (account_mask ~ '^[0-9]{0,6}$'),
  account_id       uuid,
  ignored          boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint import_account_aliases_unique unique (user_id, source_type, institution_key, instrument, account_mask),
  constraint import_account_aliases_account_fk foreign key (account_id, user_id)
    references public.accounts (id, user_id) on delete set null (account_id),
  constraint import_account_aliases_choice check (not (ignored and account_id is not null))
);

drop trigger if exists import_account_aliases_updated_at on public.import_account_aliases;
create trigger import_account_aliases_updated_at before update on public.import_account_aliases
  for each row execute function public.set_updated_at();

alter table public.import_account_aliases enable row level security;
drop policy if exists import_account_aliases_select_own on public.import_account_aliases;
create policy import_account_aliases_select_own on public.import_account_aliases
  for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.import_account_aliases from anon, authenticated, public;
grant select on public.import_account_aliases to authenticated;

-- -----------------------------------------------------------------------------
-- Import jobs (visible to their owner) and their items (private)
-- -----------------------------------------------------------------------------

create table if not exists public.gmail_import_jobs (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  connection_id  uuid not null,
  -- 'YYYY-MM', in the person's time zone.
  months         text[] not null check (cardinality(months) between 1 and 3),
  status         text not null default 'listing'
                 check (status in ('listing', 'scanning', 'confirm_accounts', 'importing', 'done', 'undone', 'cancelled', 'failed')),
  total_messages integer not null default 0 check (total_messages >= 0),
  scanned        integer not null default 0 check (scanned >= 0),
  skipped        integer not null default 0 check (skipped >= 0),
  recorded       integer not null default 0 check (recorded >= 0),
  matched        integer not null default 0 check (matched >= 0),
  review         integer not null default 0 check (review >= 0),
  ignored        integer not null default 0 check (ignored >= 0),
  -- More alert emails than one import reads; the newest were kept.
  truncated      boolean not null default false,
  error_code     text check (error_code is null or error_code ~ '^[a-z_]{1,40}$'),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  finished_at    timestamptz,
  undone_at      timestamptz,
  constraint gmail_import_jobs_id_user_unique unique (id, user_id),
  constraint gmail_import_jobs_connection_fk foreign key (connection_id, user_id)
    references public.source_connections (id, user_id) on delete cascade
);

-- One import in progress per person.
create unique index if not exists gmail_import_jobs_one_active
  on public.gmail_import_jobs (user_id)
  where status in ('listing', 'scanning', 'confirm_accounts', 'importing');
create index if not exists gmail_import_jobs_user_idx on public.gmail_import_jobs (user_id, created_at desc);

drop trigger if exists gmail_import_jobs_updated_at on public.gmail_import_jobs;
create trigger gmail_import_jobs_updated_at before update on public.gmail_import_jobs
  for each row execute function public.set_updated_at();

alter table public.gmail_import_jobs enable row level security;
drop policy if exists gmail_import_jobs_select_own on public.gmail_import_jobs;
create policy gmail_import_jobs_select_own on public.gmail_import_jobs
  for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.gmail_import_jobs from anon, authenticated, public;
grant select on public.gmail_import_jobs to authenticated;

create table if not exists friday_private.gmail_import_items (
  job_id           uuid not null,
  user_id          uuid not null,
  message_id       text not null check (message_id ~ '^[A-Za-z0-9]{1,64}$'),
  state            text not null default 'pending' check (state in ('pending', 'skipped', 'parsed', 'done')),
  skip_reason      text check (skip_reason is null or skip_reason ~ '^[a-z_]{1,40}$'),
  institution_key  text check (institution_key is null or institution_key ~ '^[a-z0-9_]{1,40}$'),
  institution_name text check (institution_name is null or char_length(institution_name) <= 80),
  instrument       text check (instrument is null or instrument in ('bank', 'credit_card', 'debit_card', 'wallet', 'unknown')),
  account_mask     text check (account_mask is null or account_mask ~ '^[0-9]{0,6}$'),
  kind             text check (kind is null or kind in ('expense', 'income', 'refund', 'transfer')),
  transfer_hint    text check (transfer_hint is null or transfer_hint in ('card_payment', 'cash_withdrawal', 'self')),
  amount_minor     bigint check (amount_minor is null or amount_minor > 0),
  currency         text check (currency is null or currency ~ '^[A-Z]{3}$'),
  occurred_at      timestamptz,
  merchant         text check (merchant is null or char_length(merchant) <= 120),
  reference        text check (reference is null or char_length(reference) <= 60),
  entry_status     text check (entry_status is null or entry_status in ('posted', 'pending', 'declined')),
  category_hint    text check (category_hint is null or char_length(category_hint) <= 60),
  confidence       numeric(4, 3) check (confidence is null or confidence between 0 and 1),
  sender_verified  boolean,
  event_id         uuid,
  -- This import created that evidence (a re-import finds the earlier import's).
  event_created    boolean not null default false,
  outcome          text check (outcome is null or outcome in ('recorded', 'matched', 'needs_review', 'ignored', 'skipped_account', 'failed')),
  primary key (job_id, message_id),
  constraint gmail_import_items_job_fk foreign key (job_id, user_id)
    references public.gmail_import_jobs (id, user_id) on delete cascade,
  constraint gmail_import_items_parsed_complete check (
    state <> 'parsed' or (institution_key is not null and kind is not null and amount_minor is not null and occurred_at is not null))
);
create index if not exists gmail_import_items_state_idx on friday_private.gmail_import_items (job_id, state);
alter table friday_private.gmail_import_items add column if not exists event_created boolean not null default false;

alter table friday_private.gmail_import_items enable row level security;
revoke all on friday_private.gmail_import_items from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on friday_private.gmail_import_items from service_role;
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Steps (service role only; the Edge Function calls them for the signed-in user)
-- -----------------------------------------------------------------------------

drop function if exists public.gmail_import_begin(uuid, text[]);
drop function if exists public.gmail_import_add_messages(uuid, uuid, text[], boolean);
drop function if exists public.gmail_import_pending(uuid, uuid, integer);
drop function if exists public.gmail_import_save(uuid, uuid, jsonb);
drop function if exists public.gmail_import_accounts(uuid, uuid);
drop function if exists public.gmail_import_apply_accounts(uuid, uuid, jsonb);
drop function if exists public.gmail_import_run(uuid, uuid, integer);
drop function if exists public.gmail_import_undo(uuid, uuid);
drop function if exists public.gmail_import_cancel(uuid, uuid);
drop function if exists public.gmail_import_fail(uuid, uuid, text);

-- The person's time zone (imports are in their months, not UTC's).
create or replace function friday_private.user_zone(p_user_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce((select p.timezone from public.profiles p where p.id = p_user_id), 'UTC');
$$;
revoke all on function friday_private.user_zone(uuid) from public;

-- A job of the caller's, locked, in one of the expected states.
create or replace function friday_private.gmail_import_job(p_user_id uuid, p_job_id uuid, p_states text[])
returns public.gmail_import_jobs
language plpgsql
set search_path = ''
as $$
declare
  v_job public.gmail_import_jobs%rowtype;
begin
  select * into v_job from public.gmail_import_jobs j
  where j.id = p_job_id and j.user_id = p_user_id
  for update;
  if not found then
    raise exception 'That import no longer exists' using errcode = 'P0002';
  end if;
  if not (v_job.status = any (p_states)) then
    raise exception 'That import is %, so it can''t do that now', replace(v_job.status, '_', ' ') using errcode = '55000';
  end if;
  return v_job;
end;
$$;
revoke all on function friday_private.gmail_import_job(uuid, uuid, text[]) from public;

-- Starts an import of whole months (this month to today, or either of the two
-- before it). Returns each month's time range, for the Gmail search.
create or replace function public.gmail_import_begin(p_user_id uuid, p_months text[])
returns table (job_id uuid, connection_id uuid, month text, range_start timestamptz, range_end timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_zone text := friday_private.user_zone(p_user_id);
  v_this_month date := date_trunc('month', (now() at time zone friday_private.user_zone(p_user_id)))::date;
  v_connection uuid;
  v_months text[];
  v_month text;
  v_job uuid;
begin
  perform public.gmail_require_service_role();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('friday:gmail-import:' || p_user_id::text, 0));

  select c.id into v_connection from public.source_connections c
  where c.user_id = p_user_id and c.provider = 'gmail' and c.status = 'active';
  if v_connection is null then
    raise exception 'Connect Gmail first' using errcode = '55000';
  end if;

  select array_agg(distinct m order by m) into v_months from unnest(p_months) m;
  if v_months is null or cardinality(v_months) = 0 then
    raise exception 'Choose at least one month' using errcode = '22023';
  end if;
  foreach v_month in array v_months loop
    if v_month !~ '^\d{4}-(0[1-9]|1[0-2])$'
       or to_date(v_month || '-01', 'YYYY-MM-DD') not between (v_this_month - interval '2 months')::date and v_this_month then
      raise exception 'Friday imports this month and the two before it' using errcode = '22023';
    end if;
  end loop;

  -- An import left unfinished (a day old, or from a connection since replaced) gives way.
  update public.gmail_import_jobs j set status = 'cancelled'
  where j.user_id = p_user_id and j.status in ('listing', 'scanning', 'confirm_accounts', 'importing')
    and (j.connection_id <> v_connection or j.updated_at < now() - interval '1 day');
  if exists (select 1 from public.gmail_import_jobs j
             where j.user_id = p_user_id and j.status in ('listing', 'scanning', 'confirm_accounts', 'importing')) then
    raise exception 'An import is already in progress' using errcode = '55000';
  end if;

  insert into public.gmail_import_jobs (user_id, connection_id, months)
  values (p_user_id, v_connection, v_months)
  returning id into v_job;

  return query
  select v_job, v_connection, m,
         (to_date(m || '-01', 'YYYY-MM-DD')::timestamp at time zone v_zone),
         least((to_date(m || '-01', 'YYYY-MM-DD') + interval '1 month')::timestamp at time zone v_zone, now())
  from unnest(v_months) m
  order by m;
end;
$$;

-- The Gmail messages found for the job (ids only). truncated: there were more.
create or replace function public.gmail_import_add_messages(p_user_id uuid, p_job_id uuid, p_message_ids text[], p_truncated boolean default false)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total integer;
begin
  perform public.gmail_require_service_role();
  perform friday_private.gmail_import_job(p_user_id, p_job_id, array['listing']);

  insert into friday_private.gmail_import_items (job_id, user_id, message_id)
  select p_job_id, p_user_id, m from unnest(coalesce(p_message_ids, '{}')) m
  on conflict do nothing;

  select count(*) into v_total from friday_private.gmail_import_items i where i.job_id = p_job_id;
  update public.gmail_import_jobs set
    total_messages = v_total,
    truncated = coalesce(p_truncated, false),
    status = case when v_total = 0 then 'done' else 'scanning' end,
    finished_at = case when v_total = 0 then now() end
  where id = p_job_id;
  return v_total;
end;
$$;

-- The next emails to read, with the person's time zone (to read dates in).
create or replace function public.gmail_import_pending(p_user_id uuid, p_job_id uuid, p_limit integer default 20)
returns table (message_id text, time_zone text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform public.gmail_require_service_role();
  perform friday_private.gmail_import_job(p_user_id, p_job_id, array['scanning']);
  return query
  select i.message_id, friday_private.user_zone(p_user_id) from friday_private.gmail_import_items i
  where i.job_id = p_job_id and i.state = 'pending'
  order by i.message_id
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
end;
$$;

-- What was read from a batch of emails: [{ messageId, skip } | { messageId, alert: {...} }].
-- When nothing is left to read, the job moves on to confirming accounts.
create or replace function public.gmail_import_save(p_user_id uuid, p_job_id uuid, p_items jsonb)
returns table (scanned integer, total integer, status text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_item jsonb;
  v_alert jsonb;
  v_job public.gmail_import_jobs%rowtype;
begin
  perform public.gmail_require_service_role();
  perform friday_private.gmail_import_job(p_user_id, p_job_id, array['scanning']);
  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'Expected a list of results' using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_alert := v_item -> 'alert';
    if v_alert is null or jsonb_typeof(v_alert) <> 'object' then
      update friday_private.gmail_import_items i set
        state = 'skipped', skip_reason = coalesce(left(v_item ->> 'skip', 40), 'not_a_transaction')
      where i.job_id = p_job_id and i.message_id = v_item ->> 'messageId' and i.state = 'pending';
    else
      update friday_private.gmail_import_items i set
        state = 'parsed',
        institution_key = v_alert ->> 'institutionKey',
        institution_name = left(v_alert ->> 'institutionName', 80),
        instrument = v_alert ->> 'instrument',
        account_mask = nullif(v_alert ->> 'accountMask', ''),
        kind = v_alert ->> 'kind',
        transfer_hint = v_alert ->> 'transferHint',
        amount_minor = (v_alert ->> 'amountMinor')::bigint,
        currency = coalesce(v_alert ->> 'currency', 'INR'),
        occurred_at = (v_alert ->> 'occurredAt')::timestamptz,
        merchant = left(v_alert ->> 'merchant', 120),
        reference = left(v_alert ->> 'reference', 60),
        entry_status = coalesce(v_alert ->> 'entryStatus', 'posted'),
        category_hint = left(v_alert ->> 'categoryHint', 60),
        confidence = round(least(greatest(coalesce((v_alert ->> 'confidence')::numeric, 0), 0), 1), 3),
        sender_verified = coalesce((v_alert ->> 'senderVerified')::boolean, false)
      where i.job_id = p_job_id and i.message_id = v_item ->> 'messageId' and i.state = 'pending';
    end if;
  end loop;

  update public.gmail_import_jobs j set
    scanned = (select count(*) from friday_private.gmail_import_items i where i.job_id = p_job_id and i.state <> 'pending'),
    skipped = (select count(*) from friday_private.gmail_import_items i where i.job_id = p_job_id and i.state = 'skipped')
  where j.id = p_job_id
  returning * into v_job;

  if not exists (select 1 from friday_private.gmail_import_items i where i.job_id = p_job_id and i.state = 'pending') then
    if exists (select 1 from friday_private.gmail_import_items i where i.job_id = p_job_id and i.state = 'parsed') then
      update public.gmail_import_jobs j set status = 'confirm_accounts' where j.id = p_job_id returning * into v_job;
    else
      update public.gmail_import_jobs j set status = 'done', finished_at = now() where j.id = p_job_id returning * into v_job;
    end if;
  end if;

  return query select v_job.scanned, v_job.total_messages, v_job.status;
end;
$$;

-- The accounts and cards the emails mention, with what Friday suggests for each:
-- the account already linked to it, an existing account that looks like it,
-- or a new one to create.
create or replace function public.gmail_import_accounts(p_user_id uuid, p_job_id uuid)
returns table (
  institution_key text,
  institution_name text,
  instrument text,
  account_mask text,
  messages integer,
  first_at timestamptz,
  last_at timestamptz,
  linked_account_id uuid,
  linked_ignored boolean,
  suggested_account_id uuid,
  suggested_name text,
  suggested_type text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform public.gmail_require_service_role();
  perform friday_private.gmail_import_job(p_user_id, p_job_id, array['confirm_accounts', 'importing', 'done']);

  return query
  with groups as (
    select i.institution_key, max(i.institution_name) as institution_name, i.instrument,
           coalesce(i.account_mask, '') as account_mask,
           count(*)::integer as messages, min(i.occurred_at) as first_at, max(i.occurred_at) as last_at
    from friday_private.gmail_import_items i
    where i.job_id = p_job_id and i.state in ('parsed', 'done')
    group by i.institution_key, i.instrument, coalesce(i.account_mask, '')
  )
  select g.institution_key, g.institution_name, g.instrument, g.account_mask, g.messages, g.first_at, g.last_at,
         al.account_id, coalesce(al.ignored, false),
         coalesce(al.account_id, guess.id),
         case g.instrument
           when 'credit_card' then g.institution_name || ' card' || case when g.account_mask <> '' then ' ••' || g.account_mask else '' end
           when 'wallet' then g.institution_name || ' wallet'
           when 'unknown' then g.institution_name
           else g.institution_name || case when g.account_mask <> '' then ' ••' || g.account_mask else '' end
         end,
         case g.instrument when 'credit_card' then 'credit_card' when 'wallet' then 'wallet'
                           when 'unknown' then null else 'bank' end
  from groups g
  left join public.import_account_aliases al
    on al.user_id = p_user_id and al.source_type = 'email' and al.institution_key = g.institution_key
   and al.instrument = g.instrument and al.account_mask = g.account_mask
  left join lateral (
    -- An active account of the right kind whose name or bank matches; the
    -- number in its name counts most. Debit cards belong to bank accounts.
    select a.id from public.accounts a
    where a.user_id = p_user_id and a.status = 'active'
      and a.type = case g.instrument when 'credit_card' then 'credit_card' when 'wallet' then 'wallet' else 'bank' end
      and (
        (g.account_mask <> '' and a.name like '%' || g.account_mask || '%')
        or lower(coalesce(a.institution_name, '')) = lower(g.institution_name)
        or lower(a.name) like '%' || lower(split_part(g.institution_name, ' ', 1)) || '%'
      )
    order by (g.account_mask <> '' and a.name like '%' || g.account_mask || '%') desc,
             (lower(coalesce(a.institution_name, '')) = lower(g.institution_name)) desc,
             a.sort_order
    limit 1
  ) guess on al.id is null
  order by g.messages desc, g.institution_name, g.account_mask;
end;
$$;

-- The person's choice for each account the emails mention:
--   [{ institutionKey, instrument, accountMask, action: 'link'|'create'|'ignore'|'review',
--      accountId?, name?, type?, openingBalanceMinor? }]
-- link: this number is that account. If the imported months start before the
--   account's start date, the account's balance is kept exactly as it is
--   (balance_from) and the older entries count in spending only.
-- create: a new account starting on the first imported day.
-- ignore: never import this number. review: import without an account (each
--   transaction waits in the review queue).
create or replace function public.gmail_import_apply_accounts(p_user_id uuid, p_job_id uuid, p_decisions jsonb)
returns table (created_accounts integer, linked_accounts integer, kept_balances integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_job public.gmail_import_jobs%rowtype;
  v_zone text := friday_private.user_zone(p_user_id);
  v_history_start date;
  v_group record;
  v_decision jsonb;
  v_action text;
  v_account public.accounts%rowtype;
  v_type text;
  v_name text;
  v_created integer := 0;
  v_linked integer := 0;
  v_kept integer := 0;
  v_colors text[] := array['sky', 'lime', 'pink', 'purple', 'yellow', 'mint', 'orange', 'peach'];
begin
  perform public.gmail_require_service_role();
  v_job := friday_private.gmail_import_job(p_user_id, p_job_id, array['confirm_accounts']);
  if jsonb_typeof(p_decisions) <> 'array' then
    raise exception 'Expected a list of choices' using errcode = '22023';
  end if;
  v_history_start := to_date(v_job.months[1] || '-01', 'YYYY-MM-DD');

  for v_group in
    select i.institution_key, max(i.institution_name) as institution_name, i.instrument,
           coalesce(i.account_mask, '') as account_mask
    from friday_private.gmail_import_items i
    where i.job_id = p_job_id and i.state = 'parsed'
    group by i.institution_key, i.instrument, coalesce(i.account_mask, '')
  loop
    select d into v_decision from jsonb_array_elements(p_decisions) d
    where d ->> 'institutionKey' = v_group.institution_key and d ->> 'instrument' = v_group.instrument
      and coalesce(d ->> 'accountMask', '') = v_group.account_mask
    limit 1;
    v_action := v_decision ->> 'action';
    if v_action is null or v_action not in ('link', 'create', 'ignore', 'review') then
      raise exception 'Choose what to do with % %', v_group.institution_name,
        case when v_group.account_mask <> '' then '••' || v_group.account_mask else '' end using errcode = '22023';
    end if;

    if v_action = 'review' then
      delete from public.import_account_aliases al
      where al.user_id = p_user_id and al.source_type = 'email' and al.institution_key = v_group.institution_key
        and al.instrument = v_group.instrument and al.account_mask = v_group.account_mask;
      continue;
    end if;

    if v_action = 'ignore' then
      insert into public.import_account_aliases (user_id, institution_key, institution_name, instrument, account_mask, account_id, ignored)
      values (p_user_id, v_group.institution_key, v_group.institution_name, v_group.instrument, v_group.account_mask, null, true)
      on conflict on constraint import_account_aliases_unique
      do update set account_id = null, ignored = true, institution_name = excluded.institution_name;
      continue;
    end if;

    if v_action = 'create' then
      v_type := coalesce(v_decision ->> 'type', case v_group.instrument when 'credit_card' then 'credit_card' when 'wallet' then 'wallet' else 'bank' end);
      if v_type not in ('bank', 'credit_card', 'wallet') then
        raise exception 'A new account is a bank account, a card or a wallet' using errcode = '22023';
      end if;
      v_name := left(btrim(coalesce(nullif(btrim(v_decision ->> 'name'), ''), v_group.institution_name)), 60);
      insert into public.accounts (user_id, name, type, institution_name, opening_balance_minor, opening_date, color, sort_order)
      values (
        p_user_id, v_name, v_type, v_group.institution_name,
        coalesce((v_decision ->> 'openingBalanceMinor')::bigint, 0), v_history_start,
        v_colors[1 + (select count(*) from public.accounts a where a.user_id = p_user_id)::integer % 8],
        coalesce((select max(a.sort_order) + 1 from public.accounts a where a.user_id = p_user_id), 0))
      returning * into v_account;
      v_created := v_created + 1;
    else
      select * into v_account from public.accounts a
      where a.id = (v_decision ->> 'accountId')::uuid and a.user_id = p_user_id and a.status = 'active'
      for update;
      if not found then
        raise exception 'Choose one of your active accounts for % %', v_group.institution_name,
          case when v_group.account_mask <> '' then '••' || v_group.account_mask else '' end using errcode = '22023';
      end if;
      v_linked := v_linked + 1;

      -- History older than the account's start: keep today's balance exactly.
      if v_account.opening_date > v_history_start then
        if v_account.balance_from is null then
          update public.accounts set
            opening_balance_minor = opening_balance_minor
              + friday_private.account_net_before(p_user_id, v_account.id, v_account.opening_date, v_zone),
            balance_from = v_account.opening_date,
            opening_date = v_history_start
          where id = v_account.id;
        else
          update public.accounts set opening_date = v_history_start where id = v_account.id;
        end if;
        v_kept := v_kept + 1;
      end if;
    end if;

    insert into public.import_account_aliases (user_id, institution_key, institution_name, instrument, account_mask, account_id, ignored)
    values (p_user_id, v_group.institution_key, v_group.institution_name, v_group.instrument, v_group.account_mask, v_account.id, false)
    on conflict on constraint import_account_aliases_unique
    do update set account_id = excluded.account_id, ignored = false, institution_name = excluded.institution_name;
  end loop;

  update public.gmail_import_jobs set status = 'importing' where id = p_job_id;
  return query select v_created, v_linked, v_kept;
end;
$$;

-- Imports the next batch through the import boundary (which records it or
-- sends it to review). Done when nothing is left.
create or replace function public.gmail_import_run(p_user_id uuid, p_job_id uuid, p_limit integer default 40)
returns table (processed integer, remaining integer, status text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_job public.gmail_import_jobs%rowtype;
  v_item friday_private.gmail_import_items%rowtype;
  v_alias public.import_account_aliases%rowtype;
  v_account uuid;
  v_destination uuid;
  v_category uuid;
  v_kind text;
  v_result record;
  v_outcome text;
  v_processed integer := 0;
  v_remaining integer;
begin
  perform public.gmail_require_service_role();
  v_job := friday_private.gmail_import_job(p_user_id, p_job_id, array['importing']);

  for v_item in
    select * from friday_private.gmail_import_items i
    where i.job_id = p_job_id and i.state = 'parsed'
    order by i.occurred_at, i.message_id
    limit least(greatest(coalesce(p_limit, 40), 1), 100)
  loop
    v_processed := v_processed + 1;
    v_account := null;
    v_destination := null;
    v_category := null;
    v_kind := v_item.kind;
    v_alias := null;

    select * into v_alias from public.import_account_aliases al
    where al.user_id = p_user_id and al.source_type = 'email' and al.institution_key = v_item.institution_key
      and al.instrument = v_item.instrument and al.account_mask = coalesce(v_item.account_mask, '');

    if v_alias.ignored then
      update friday_private.gmail_import_items set state = 'done', outcome = 'skipped_account'
      where job_id = p_job_id and message_id = v_item.message_id;
      continue;
    end if;
    v_account := v_alias.account_id;

    -- Money arriving on a card is almost always a bill payment: the import
    -- boundary asks about "income" on a card as a possible transfer.
    if v_item.kind = 'transfer' and v_item.transfer_hint = 'card_payment' and v_item.instrument = 'credit_card' then
      v_kind := 'income';
    elsif v_item.kind = 'transfer' and v_item.transfer_hint = 'cash_withdrawal' then
      -- Into the person's cash account, when there's exactly one.
      select (array_agg(a.id))[1] into v_destination from public.accounts a
      where a.user_id = p_user_id and a.status = 'active' and a.type = 'cash'
      having count(*) = 1;
    end if;

    if v_kind in ('expense', 'income') then
      select c.id into v_category from public.categories c
      where c.user_id = p_user_id and not c.is_archived and c.transaction_type = v_kind
        and lower(c.name) = lower(v_item.category_hint);
      if v_category is null and v_item.merchant is not null then
        -- What the person filed this merchant under most often.
        select t.category_id into v_category from public.transactions t
        join public.categories c on c.id = t.category_id and not c.is_archived
        where t.user_id = p_user_id and t.type = v_kind and t.deleted_at is null and t.category_id is not null
          and lower(t.merchant) = lower(v_item.merchant)
        group by t.category_id
        order by count(*) desc
        limit 1;
      end if;
    end if;

    begin
      select * into v_result from public.ingest_source_event_for(
        p_user_id, 'email', v_item.message_id, v_job.connection_id, v_item.reference, null,
        v_kind, v_item.amount_minor, coalesce(v_item.currency, 'INR'), v_item.occurred_at, v_item.merchant,
        left(v_item.institution_name || case when coalesce(v_item.account_mask, '') <> '' then ' ••' || v_item.account_mask else '' end, 60),
        v_account, v_destination, v_category, v_item.entry_status, v_item.confidence);
      v_outcome := case
        when v_result.processing_status = 'imported' and v_result.replayed then 'matched'
        when v_result.processing_status = 'imported'
             and exists (select 1 from public.source_events e where e.id = v_result.event_id and e.link_type = 'matched') then 'matched'
        when v_result.processing_status = 'imported' then 'recorded'
        when v_result.processing_status = 'needs_review' then 'needs_review'
        else 'ignored' end;
      update friday_private.gmail_import_items set
        state = 'done', outcome = v_outcome, event_id = v_result.event_id, event_created = not v_result.replayed
      where job_id = p_job_id and message_id = v_item.message_id;
    exception when others then
      update friday_private.gmail_import_items set state = 'done', outcome = 'failed'
      where job_id = p_job_id and message_id = v_item.message_id;
    end;
  end loop;

  select count(*) into v_remaining from friday_private.gmail_import_items i where i.job_id = p_job_id and i.state = 'parsed';
  update public.gmail_import_jobs j set
    recorded = (select count(*) from friday_private.gmail_import_items i where i.job_id = p_job_id and i.outcome = 'recorded'),
    matched  = (select count(*) from friday_private.gmail_import_items i where i.job_id = p_job_id and i.outcome = 'matched'),
    review   = (select count(*) from friday_private.gmail_import_items i where i.job_id = p_job_id and i.outcome in ('needs_review', 'failed')),
    ignored  = (select count(*) from friday_private.gmail_import_items i where i.job_id = p_job_id and i.outcome in ('ignored', 'skipped_account')),
    status = case when v_remaining = 0 then 'done' else j.status end,
    finished_at = case when v_remaining = 0 then now() else j.finished_at end
  where j.id = p_job_id
  returning * into v_job;

  return query select v_processed, v_remaining, v_job.status;
end;
$$;

-- Undoes a finished import: deletes the entries it created (except any a
-- refund or reversal now depends on), takes its items out of the review
-- queue, and forgets its evidence so the months can be imported again.
-- Accounts and account links it created stay.
create or replace function public.gmail_import_undo(p_user_id uuid, p_job_id uuid)
returns table (removed_entries integer, kept_entries integer, removed_events integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_event public.source_events%rowtype;
  v_removed integer := 0;
  v_kept integer := 0;
  v_events integer := 0;
  v_keep boolean;
begin
  perform public.gmail_require_service_role();
  perform friday_private.gmail_import_job(p_user_id, p_job_id, array['done']);
  perform public.lock_user_imports(p_user_id);
  perform public.set_change_reason('Gmail import undone');

  for v_event in
    select e.* from public.source_events e
    join friday_private.gmail_import_items i on i.event_id = e.id and i.event_created
    where i.job_id = p_job_id and e.user_id = p_user_id
  loop
    v_keep := false;
    if v_event.link_type = 'created' and v_event.resulting_transaction_id is not null then
      if exists (select 1 from public.transactions r
                 where r.user_id = p_user_id and r.related_transaction_id = v_event.resulting_transaction_id
                   and r.deleted_at is null and r.status <> 'voided') then
        v_keep := true;
      else
        begin
          update public.transactions set deleted_at = now()
          where id = v_event.resulting_transaction_id and user_id = p_user_id and deleted_at is null;
          v_removed := v_removed + 1;
        exception when others then
          v_keep := true;
        end;
      end if;
    elsif v_event.link_type = 'created' and v_event.resulting_transfer_id is not null then
      update public.transfers set deleted_at = now()
      where id = v_event.resulting_transfer_id and user_id = p_user_id and deleted_at is null;
      v_removed := v_removed + 1;
    end if;

    if v_keep then
      v_kept := v_kept + 1;
    else
      delete from public.source_events where id = v_event.id;
      v_events := v_events + 1;
    end if;
  end loop;

  update public.gmail_import_jobs set status = 'undone', undone_at = now() where id = p_job_id;
  return query select v_removed, v_kept, v_events;
end;
$$;

-- Stops an import that hasn't started recording yet.
create or replace function public.gmail_import_cancel(p_user_id uuid, p_job_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.gmail_require_service_role();
  perform friday_private.gmail_import_job(p_user_id, p_job_id, array['listing', 'scanning', 'confirm_accounts']);
  delete from friday_private.gmail_import_items where job_id = p_job_id;
  update public.gmail_import_jobs set status = 'cancelled', finished_at = now() where id = p_job_id;
end;
$$;

-- Gmail failed while listing or reading: the job ends, with a short code.
create or replace function public.gmail_import_fail(p_user_id uuid, p_job_id uuid, p_error_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.gmail_require_service_role();
  perform friday_private.gmail_import_job(p_user_id, p_job_id, array['listing', 'scanning']);
  update public.gmail_import_jobs set status = 'failed', error_code = left(p_error_code, 40), finished_at = now()
  where id = p_job_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Deleting all data removes imports and account links too
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
  delete from friday_private.gmail_import_items where user_id = v_uid;
  delete from public.gmail_import_jobs where user_id = v_uid;
  delete from public.import_account_aliases where user_id = v_uid;
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
  public.gmail_import_begin(uuid, text[]),
  public.gmail_import_add_messages(uuid, uuid, text[], boolean),
  public.gmail_import_pending(uuid, uuid, integer),
  public.gmail_import_save(uuid, uuid, jsonb),
  public.gmail_import_accounts(uuid, uuid),
  public.gmail_import_apply_accounts(uuid, uuid, jsonb),
  public.gmail_import_run(uuid, uuid, integer),
  public.gmail_import_undo(uuid, uuid),
  public.gmail_import_cancel(uuid, uuid),
  public.gmail_import_fail(uuid, uuid, text)
  from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function
      public.gmail_import_begin(uuid, text[]),
      public.gmail_import_add_messages(uuid, uuid, text[], boolean),
      public.gmail_import_pending(uuid, uuid, integer),
      public.gmail_import_save(uuid, uuid, jsonb),
      public.gmail_import_accounts(uuid, uuid),
      public.gmail_import_apply_accounts(uuid, uuid, jsonb),
      public.gmail_import_run(uuid, uuid, integer),
      public.gmail_import_undo(uuid, uuid),
      public.gmail_import_cancel(uuid, uuid),
      public.gmail_import_fail(uuid, uuid, text)
      to service_role;
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Safety checks: fail the migration rather than expose anything.
-- -----------------------------------------------------------------------------

do $$
declare
  v_fn regprocedure;
begin
  for v_fn in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'gmail\_import\_%'
  loop
    if has_function_privilege('anon', v_fn, 'execute') or has_function_privilege('authenticated', v_fn, 'execute') then
      raise exception 'Migration check failed: % must not be callable by anon or authenticated', v_fn;
    end if;
  end loop;

  if has_table_privilege('authenticated', 'public.gmail_import_jobs', 'insert')
     or has_table_privilege('authenticated', 'public.gmail_import_jobs', 'update')
     or has_table_privilege('authenticated', 'public.import_account_aliases', 'insert')
     or has_table_privilege('authenticated', 'public.import_account_aliases', 'update')
     or has_table_privilege('anon', 'public.gmail_import_jobs', 'select')
     or has_table_privilege('anon', 'public.import_account_aliases', 'select') then
    raise exception 'Migration check failed: import tables must be read-only to signed-in users and closed to visitors';
  end if;
  if has_table_privilege('authenticated', 'friday_private.gmail_import_items', 'select') then
    raise exception 'Migration check failed: import items must not be readable by clients';
  end if;
end
$$;

notify pgrst, 'reload schema';
