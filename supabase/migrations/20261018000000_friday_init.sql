-- =============================================================================
-- Friday — initial schema
--
-- Ledger rules (see docs/financial-rules.md):
--   * Money is stored as integer minor units (paise for INR). Never floats.
--   * Income/expense amounts are positive magnitudes; direction comes from type.
--   * Transfers are their own table and never count as income or expense.
--   * Balances are derived: opening + income − expense + transfers in − out.
--   * Recurring rules are templates. Only an explicit confirm creates a
--     transaction, and each (rule, due date) can be confirmed at most once.
--   * Every user-owned row carries user_id and is protected by RLS. Composite
--     foreign keys on (id, user_id) make cross-user references impossible.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Shared helpers
-- -----------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Profiles
-- -----------------------------------------------------------------------------

create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text check (display_name is null or char_length(display_name) <= 80),
  timezone      text not null default 'Asia/Kolkata',
  base_currency char(3) not null default 'INR' check (base_currency ~ '^[A-Z]{3}$'),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create or replace function public.validate_profile()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'Unknown timezone: %', new.timezone using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger profiles_validate before insert or update on public.profiles
  for each row execute function public.validate_profile();
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Accounts
--
-- Sign convention: balance_minor is the account's net position.
--   cash / bank / other: positive = money you have.
--   credit_card:         negative = amount owed. A card's opening balance is
--                        stored as the negative of what was owed on that day.
-- -----------------------------------------------------------------------------

create table public.accounts (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name                  text not null check (char_length(btrim(name)) between 1 and 60),
  type                  text not null check (type in ('cash', 'bank', 'credit_card', 'other')),
  currency              char(3) not null default 'INR',
  opening_balance_minor bigint not null default 0
                        check (abs(opening_balance_minor) <= 10000000000000),
  opening_date          date not null default current_date,
  color                 text not null default 'orange' check (char_length(color) <= 20),
  status                text not null default 'active' check (status in ('active', 'archived')),
  sort_order            integer not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- v1 only supports INR. Relax this constraint when multi-currency lands.
  constraint accounts_currency_supported check (currency in ('INR')),
  constraint accounts_id_user_unique unique (id, user_id)
);

create index accounts_user_idx on public.accounts (user_id, status, sort_order);

create trigger accounts_updated_at before update on public.accounts
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Categories
--
-- Defaults are copied per user at sign-up (is_default = true) so they can be
-- renamed or archived like any other category, and so every category has an
-- owner that the composite foreign keys can check.
-- -----------------------------------------------------------------------------

create table public.categories (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name             text not null check (char_length(btrim(name)) between 1 and 40),
  transaction_type text not null check (transaction_type in ('income', 'expense')),
  icon             text not null default 'tag' check (char_length(icon) <= 40),
  color            text not null default 'orange' check (char_length(color) <= 20),
  is_default       boolean not null default false,
  is_archived      boolean not null default false,
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint categories_id_user_unique unique (id, user_id),
  -- Lets transactions reference (category, owner, type) so a category can only
  -- be attached to transactions of its own type.
  constraint categories_id_user_type_unique unique (id, user_id, transaction_type)
);

create unique index categories_active_name_unique
  on public.categories (user_id, transaction_type, lower(btrim(name)))
  where not is_archived;

create trigger categories_updated_at before update on public.categories
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Transactions (income and expense only)
-- -----------------------------------------------------------------------------

create table public.transactions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  account_id   uuid not null,
  type         text not null check (type in ('income', 'expense')),
  amount_minor bigint not null check (amount_minor > 0 and amount_minor <= 10000000000000),
  -- Filled from the account by validate_transaction() when omitted.
  currency     char(3) not null,
  category_id  uuid,
  occurred_at  timestamptz not null default now(),
  note         text check (note is null or char_length(note) <= 500),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  constraint transactions_id_user_unique unique (id, user_id),
  constraint transactions_account_fk foreign key (account_id, user_id)
    references public.accounts (id, user_id),
  constraint transactions_category_fk foreign key (category_id, user_id, type)
    references public.categories (id, user_id, transaction_type)
);

create index transactions_user_occurred_idx
  on public.transactions (user_id, occurred_at desc) where deleted_at is null;
create index transactions_account_idx on public.transactions (account_id);
create index transactions_category_idx on public.transactions (category_id);

create or replace function public.validate_transaction()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_account public.accounts%rowtype;
  v_category_archived boolean;
begin
  select * into v_account
  from public.accounts
  where id = new.account_id and user_id = new.user_id;

  if not found then
    raise exception 'Choose one of your accounts' using errcode = '23503';
  end if;

  new.currency := coalesce(new.currency, v_account.currency);
  if new.currency <> v_account.currency then
    raise exception 'Transaction currency must match the account currency' using errcode = '22023';
  end if;

  if v_account.status = 'archived'
     and (tg_op = 'INSERT' or new.account_id is distinct from old.account_id) then
    raise exception 'That account is archived' using errcode = '22023';
  end if;

  if new.category_id is not null
     and (tg_op = 'INSERT' or new.category_id is distinct from old.category_id) then
    select is_archived into v_category_archived
    from public.categories
    where id = new.category_id and user_id = new.user_id;
    if v_category_archived then
      raise exception 'That category is archived' using errcode = '22023';
    end if;
  end if;

  return new;
end;
$$;

create trigger transactions_validate before insert or update on public.transactions
  for each row execute function public.validate_transaction();
create trigger transactions_updated_at before update on public.transactions
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Transfers: one row = one logical movement between two of the user's accounts.
-- -----------------------------------------------------------------------------

create table public.transfers (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null default auth.uid() references auth.users (id) on delete cascade,
  source_account_id      uuid not null,
  destination_account_id uuid not null,
  amount_minor           bigint not null check (amount_minor > 0 and amount_minor <= 10000000000000),
  currency               char(3) not null,
  occurred_at            timestamptz not null default now(),
  note                   text check (note is null or char_length(note) <= 500),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz,
  constraint transfers_distinct_accounts check (source_account_id <> destination_account_id),
  constraint transfers_source_fk foreign key (source_account_id, user_id)
    references public.accounts (id, user_id),
  constraint transfers_destination_fk foreign key (destination_account_id, user_id)
    references public.accounts (id, user_id)
);

create index transfers_user_occurred_idx
  on public.transfers (user_id, occurred_at desc) where deleted_at is null;
create index transfers_source_idx on public.transfers (source_account_id);
create index transfers_destination_idx on public.transfers (destination_account_id);

create or replace function public.validate_transfer()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_source public.accounts%rowtype;
  v_destination public.accounts%rowtype;
begin
  select * into v_source from public.accounts
  where id = new.source_account_id and user_id = new.user_id;
  if not found then
    raise exception 'Choose a source account' using errcode = '23503';
  end if;

  select * into v_destination from public.accounts
  where id = new.destination_account_id and user_id = new.user_id;
  if not found then
    raise exception 'Choose a destination account' using errcode = '23503';
  end if;

  if v_source.currency <> v_destination.currency then
    raise exception 'Both accounts must use the same currency' using errcode = '22023';
  end if;

  new.currency := coalesce(new.currency, v_source.currency);
  if new.currency <> v_source.currency then
    raise exception 'Transfer currency must match the accounts' using errcode = '22023';
  end if;

  if (v_source.status = 'archived'
      and (tg_op = 'INSERT' or new.source_account_id is distinct from old.source_account_id))
     or (v_destination.status = 'archived'
      and (tg_op = 'INSERT' or new.destination_account_id is distinct from old.destination_account_id)) then
    raise exception 'That account is archived' using errcode = '22023';
  end if;

  return new;
end;
$$;

create trigger transfers_validate before insert or update on public.transfers
  for each row execute function public.validate_transfer();
create trigger transfers_updated_at before update on public.transfers
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Recurring rules and occurrences
-- -----------------------------------------------------------------------------

create table public.recurring_rules (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name           text not null check (char_length(btrim(name)) between 1 and 60),
  type           text not null check (type in ('income', 'expense')),
  amount_minor   bigint not null check (amount_minor > 0 and amount_minor <= 10000000000000),
  account_id     uuid not null,
  category_id    uuid,
  note           text check (note is null or char_length(note) <= 500),
  cadence        text not null check (cadence in ('daily', 'weekly', 'monthly', 'yearly')),
  interval_count integer not null default 1 check (interval_count between 1 and 52),
  -- The schedule anchor. Due dates are start_date + n × (interval × cadence),
  -- always computed from the anchor so month-end dates don't drift.
  start_date     date not null,
  -- First due date that has not been turned into an occurrence yet.
  next_due_date  date not null,
  end_date       date,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint recurring_rules_id_user_unique unique (id, user_id),
  constraint recurring_rules_end_after_start check (end_date is null or end_date >= start_date),
  constraint recurring_rules_next_after_start check (next_due_date >= start_date),
  constraint recurring_rules_account_fk foreign key (account_id, user_id)
    references public.accounts (id, user_id),
  constraint recurring_rules_category_fk foreign key (category_id, user_id, type)
    references public.categories (id, user_id, transaction_type)
);

create index recurring_rules_user_due_idx on public.recurring_rules (user_id, active, next_due_date);

create table public.recurring_occurrences (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  rule_id        uuid not null,
  due_date       date not null,
  status         text not null default 'due' check (status in ('due', 'confirmed', 'skipped')),
  transaction_id uuid,
  resolved_at    timestamptz,
  created_at     timestamptz not null default now(),
  constraint recurring_occurrences_rule_date_unique unique (rule_id, due_date),
  constraint recurring_occurrences_confirmed_has_transaction
    check ((status = 'confirmed') = (transaction_id is not null)),
  constraint recurring_occurrences_rule_fk foreign key (rule_id, user_id)
    references public.recurring_rules (id, user_id) on delete cascade,
  constraint recurring_occurrences_transaction_fk foreign key (transaction_id, user_id)
    references public.transactions (id, user_id)
);

create unique index recurring_occurrences_transaction_unique
  on public.recurring_occurrences (transaction_id) where transaction_id is not null;
create index recurring_occurrences_user_status_idx
  on public.recurring_occurrences (user_id, status, due_date);

-- n-th due date of a schedule (n = 0 is the anchor itself).
create or replace function public.recurrence_date(
  p_start date, p_cadence text, p_interval integer, p_n integer
)
returns date
language sql
immutable
set search_path = ''
as $$
  select (p_start + case p_cadence
    when 'daily'   then make_interval(days   => p_interval * p_n)
    when 'weekly'  then make_interval(weeks  => p_interval * p_n)
    when 'monthly' then make_interval(months => p_interval * p_n)
    when 'yearly'  then make_interval(years  => p_interval * p_n)
  end)::date;
$$;

-- First due date of a schedule that is strictly after p_after
-- (or the anchor itself when p_after is before it).
create or replace function public.recurrence_next_after(
  p_start date, p_cadence text, p_interval integer, p_after date
)
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_n integer;
  v_date date;
begin
  if p_after < p_start then
    return p_start;
  end if;

  -- Jump close to the answer, then step forward.
  v_n := case p_cadence
    when 'daily'   then (p_after - p_start) / p_interval
    when 'weekly'  then (p_after - p_start) / (7 * p_interval)
    when 'monthly' then ((extract(year from p_after) - extract(year from p_start)) * 12
                        + extract(month from p_after) - extract(month from p_start))::integer / p_interval
    when 'yearly'  then (extract(year from p_after) - extract(year from p_start))::integer / p_interval
  end;
  v_n := greatest(v_n - 1, 0);

  loop
    v_date := public.recurrence_date(p_start, p_cadence, p_interval, v_n);
    exit when v_date > p_after;
    v_n := v_n + 1;
  end loop;

  return v_date;
end;
$$;

create or replace function public.prepare_recurring_rule()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_last_due date;
  v_today date;
begin
  if tg_op = 'INSERT' then
    new.next_due_date := new.start_date;
  elsif new.start_date is distinct from old.start_date
     or new.cadence is distinct from old.cadence
     or new.interval_count is distinct from old.interval_count then
    -- Schedule changed: continue after the last occurrence already generated.
    select max(due_date) into v_last_due
    from public.recurring_occurrences where rule_id = new.id;
    new.next_due_date := public.recurrence_next_after(
      new.start_date, new.cadence, new.interval_count,
      coalesce(v_last_due, new.start_date - 1));
  elsif new.active and not old.active then
    -- Resumed after a pause: don't back-fill the dates missed while paused.
    select (now() at time zone p.timezone)::date into v_today
    from public.profiles p where p.id = new.user_id;
    new.next_due_date := public.recurrence_next_after(
      new.start_date, new.cadence, new.interval_count,
      greatest(new.next_due_date, coalesce(v_today, current_date)) - 1);
  end if;
  return new;
end;
$$;

create trigger recurring_rules_prepare before insert or update on public.recurring_rules
  for each row execute function public.prepare_recurring_rule();
create trigger recurring_rules_updated_at before update on public.recurring_rules
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Default categories and sign-up
-- -----------------------------------------------------------------------------

create or replace function public.seed_default_categories(p_user_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.categories (user_id, name, transaction_type, icon, color, is_default, sort_order)
  select p_user_id, d.name, d.transaction_type, d.icon, d.color, true, d.sort_order
  from (values
    ('Food & dining',     'expense', 'utensils',        'orange', 10),
    ('Groceries',         'expense', 'shopping-basket', 'lime',   20),
    ('Transport',         'expense', 'bus',             'purple', 30),
    ('Shopping',          'expense', 'shopping-bag',    'pink',   40),
    ('Bills & utilities', 'expense', 'receipt',         'yellow', 50),
    ('Rent & home',       'expense', 'home',            'sky',    60),
    ('Health',            'expense', 'heart-pulse',     'mint',   70),
    ('Fun & leisure',     'expense', 'clapperboard',    'pink',   80),
    ('Travel',            'expense', 'plane',           'sky',    90),
    ('Education',         'expense', 'graduation-cap',  'purple', 100),
    ('Personal care',     'expense', 'sparkles',        'peach',  110),
    ('Subscriptions',     'expense', 'repeat',          'lime',   120),
    ('Gifts & giving',    'expense', 'gift',            'orange', 130),
    ('Other',             'expense', 'shapes',          'peach',  900),
    ('Salary',            'income',  'briefcase',       'lime',   10),
    ('Freelance',         'income',  'laptop',          'purple', 20),
    ('Interest',          'income',  'percent',         'sky',    30),
    ('Refunds',           'income',  'undo',            'yellow', 40),
    ('Gifts received',    'income',  'gift',            'pink',   50),
    ('Other income',      'income',  'shapes',          'peach',  900)
  ) as d (name, transaction_type, icon, color, sort_order)
  where not exists (
    select 1 from public.categories c
    where c.user_id = p_user_id and c.is_default
  );
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    nullif(left(coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)), 80), '')
  )
  on conflict (id) do nothing;
  perform public.seed_default_categories(new.id);
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Self-heal for a signed-in user whose profile is missing (e.g. created
-- before this migration ran). Only ever touches the caller's own rows.
create or replace function public.ensure_profile()
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;

  insert into public.profiles (id) values (v_uid) on conflict (id) do nothing;
  perform public.seed_default_categories(v_uid);

  select * into v_profile from public.profiles where id = v_uid;
  return v_profile;
end;
$$;

-- -----------------------------------------------------------------------------
-- Derived views (security_invoker so the caller's RLS applies)
-- -----------------------------------------------------------------------------

create view public.account_balances
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
  coalesce(t.income_minor, 0)::bigint        as income_minor,
  coalesce(t.expense_minor, 0)::bigint       as expense_minor,
  coalesce(tin.amount_minor, 0)::bigint      as transfers_in_minor,
  coalesce(tout.amount_minor, 0)::bigint     as transfers_out_minor,
  (a.opening_balance_minor
    + coalesce(t.income_minor, 0)
    - coalesce(t.expense_minor, 0)
    + coalesce(tin.amount_minor, 0)
    - coalesce(tout.amount_minor, 0))::bigint as balance_minor
from public.accounts a
left join lateral (
  select
    sum(x.amount_minor) filter (where x.type = 'income')  as income_minor,
    sum(x.amount_minor) filter (where x.type = 'expense') as expense_minor
  from public.transactions x
  where x.account_id = a.id and x.deleted_at is null
) t on true
left join lateral (
  select sum(x.amount_minor) as amount_minor
  from public.transfers x
  where x.destination_account_id = a.id and x.deleted_at is null
) tin on true
left join lateral (
  select sum(x.amount_minor) as amount_minor
  from public.transfers x
  where x.source_account_id = a.id and x.deleted_at is null
) tout on true;

-- One feed of everything that happened, for the Transactions screen.
-- kind = 'income' | 'expense' | 'transfer'. For transfers, account_id is the
-- source and counter_account_id the destination.
create view public.ledger_entries
with (security_invoker = true)
as
select
  t.id,
  t.user_id,
  t.type          as kind,
  t.account_id,
  null::uuid      as counter_account_id,
  t.category_id,
  t.amount_minor,
  t.currency,
  t.occurred_at,
  t.note,
  t.created_at,
  t.updated_at
from public.transactions t
where t.deleted_at is null
union all
select
  x.id,
  x.user_id,
  'transfer'::text,
  x.source_account_id,
  x.destination_account_id,
  null::uuid,
  x.amount_minor,
  x.currency,
  x.occurred_at,
  x.note,
  x.created_at,
  x.updated_at
from public.transfers x
where x.deleted_at is null;

-- -----------------------------------------------------------------------------
-- Reporting RPCs. Ranges are half-open [p_from, p_to) in UTC; the client turns
-- the user's local reporting dates into these instants using profile.timezone.
-- Transfers are excluded from income and expense by construction.
-- -----------------------------------------------------------------------------

create or replace function public.period_summary(p_from timestamptz, p_to timestamptz)
returns table (
  income_minor bigint,
  expense_minor bigint,
  net_minor bigint,
  income_count bigint,
  expense_count bigint,
  transfer_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with t as (
    select
      coalesce(sum(amount_minor) filter (where type = 'income'), 0)::bigint  as income_minor,
      coalesce(sum(amount_minor) filter (where type = 'expense'), 0)::bigint as expense_minor,
      count(*) filter (where type = 'income')                                as income_count,
      count(*) filter (where type = 'expense')                               as expense_count
    from public.transactions
    where user_id = auth.uid()
      and deleted_at is null
      and occurred_at >= p_from and occurred_at < p_to
  ),
  x as (
    select count(*) as transfer_count
    from public.transfers
    where user_id = auth.uid()
      and deleted_at is null
      and occurred_at >= p_from and occurred_at < p_to
  )
  select t.income_minor, t.expense_minor, t.income_minor - t.expense_minor,
         t.income_count, t.expense_count, x.transfer_count
  from t, x;
$$;

create or replace function public.category_breakdown(
  p_from timestamptz,
  p_to timestamptz,
  p_type text default 'expense'
)
returns table (category_id uuid, total_minor bigint, transaction_count bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select category_id, sum(amount_minor)::bigint, count(*)
  from public.transactions
  where user_id = auth.uid()
    and deleted_at is null
    and type = p_type
    and occurred_at >= p_from and occurred_at < p_to
  group by category_id
  order by 2 desc;
$$;

-- Income/expense per local calendar bucket (day | week | month) in the
-- profile's timezone, including empty buckets.
create or replace function public.cashflow_trend(
  p_from timestamptz,
  p_to timestamptz,
  p_bucket text default 'month'
)
returns table (bucket_start date, income_minor bigint, expense_minor bigint)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_tz text;
begin
  if p_bucket not in ('day', 'week', 'month') then
    raise exception 'Unsupported bucket: %', p_bucket using errcode = '22023';
  end if;

  select timezone into v_tz from public.profiles where id = auth.uid();
  v_tz := coalesce(v_tz, 'UTC');

  return query
  with buckets as (
    select generate_series(
      date_trunc(p_bucket, p_from at time zone v_tz),
      date_trunc(p_bucket, (p_to - interval '1 microsecond') at time zone v_tz),
      ('1 ' || p_bucket)::interval
    )::date as bucket_start
  ),
  agg as (
    select
      date_trunc(p_bucket, t.occurred_at at time zone v_tz)::date as bucket_start,
      sum(t.amount_minor) filter (where t.type = 'income')  as income_minor,
      sum(t.amount_minor) filter (where t.type = 'expense') as expense_minor
    from public.transactions t
    where t.user_id = auth.uid()
      and t.deleted_at is null
      and t.occurred_at >= p_from and t.occurred_at < p_to
    group by 1
  )
  select b.bucket_start,
         coalesce(a.income_minor, 0)::bigint,
         coalesce(a.expense_minor, 0)::bigint
  from buckets b
  left join agg a using (bucket_start)
  order by b.bucket_start;
end;
$$;

-- -----------------------------------------------------------------------------
-- Recurring workflow RPCs
-- -----------------------------------------------------------------------------

-- Turns every rule whose next due date has arrived (in the user's timezone)
-- into 'due' occurrences. Never creates transactions. Safe to call repeatedly.
create or replace function public.sync_recurring_occurrences()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_today date;
  v_rule record;
  v_due date;
  v_created integer := 0;
  v_guard integer;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;

  select (now() at time zone p.timezone)::date into v_today
  from public.profiles p where p.id = v_uid;
  v_today := coalesce(v_today, current_date);

  for v_rule in
    select * from public.recurring_rules
    where user_id = v_uid and active and next_due_date <= v_today
    for update
  loop
    v_due := v_rule.next_due_date;
    v_guard := 0;
    while v_due <= v_today
      and (v_rule.end_date is null or v_due <= v_rule.end_date)
      and v_guard < 400
    loop
      insert into public.recurring_occurrences (user_id, rule_id, due_date)
      values (v_uid, v_rule.id, v_due)
      on conflict (rule_id, due_date) do nothing;
      if found then
        v_created := v_created + 1;
      end if;
      v_due := public.recurrence_next_after(
        v_rule.start_date, v_rule.cadence, v_rule.interval_count, v_due);
      v_guard := v_guard + 1;
    end loop;

    update public.recurring_rules set next_due_date = v_due where id = v_rule.id;
  end loop;

  return v_created;
end;
$$;

-- Returns the occurrence for (rule, due date), creating it when the date is
-- the rule's next due date (lets the user act on an upcoming item early).
-- Locks the rule row so concurrent confirm/skip calls serialise.
create or replace function public.lock_recurring_occurrence(p_rule_id uuid, p_due_date date)
returns public.recurring_occurrences
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_rule public.recurring_rules%rowtype;
  v_occurrence public.recurring_occurrences%rowtype;
begin
  select * into v_rule from public.recurring_rules
  where id = p_rule_id and user_id = auth.uid()
  for update;
  if not found then
    raise exception 'Recurring item not found' using errcode = 'P0002';
  end if;

  select * into v_occurrence from public.recurring_occurrences
  where rule_id = p_rule_id and due_date = p_due_date
  for update;

  if not found then
    if p_due_date <> v_rule.next_due_date then
      raise exception 'That date is not due for this recurring item' using errcode = '22023';
    end if;
    if v_rule.end_date is not null and p_due_date > v_rule.end_date then
      raise exception 'This recurring item has ended' using errcode = '22023';
    end if;

    insert into public.recurring_occurrences (user_id, rule_id, due_date)
    values (v_rule.user_id, v_rule.id, p_due_date)
    returning * into v_occurrence;

    update public.recurring_rules
    set next_due_date = public.recurrence_next_after(
      v_rule.start_date, v_rule.cadence, v_rule.interval_count, p_due_date)
    where id = v_rule.id;
  end if;

  return v_occurrence;
end;
$$;

-- Posts exactly one transaction for an occurrence. Calling it again for an
-- already-confirmed occurrence returns the original transaction id.
create or replace function public.confirm_recurring_occurrence(
  p_rule_id uuid,
  p_due_date date,
  p_amount_minor bigint default null,
  p_account_id uuid default null,
  p_category_id uuid default null,
  p_occurred_at timestamptz default null,
  p_note text default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_rule public.recurring_rules%rowtype;
  v_occurrence public.recurring_occurrences%rowtype;
  v_transaction_id uuid;
begin
  v_occurrence := public.lock_recurring_occurrence(p_rule_id, p_due_date);

  if v_occurrence.status = 'confirmed' then
    return v_occurrence.transaction_id;
  elsif v_occurrence.status = 'skipped' then
    raise exception 'This occurrence was skipped' using errcode = '22023';
  end if;

  select * into v_rule from public.recurring_rules where id = p_rule_id;

  insert into public.transactions (user_id, account_id, type, amount_minor, category_id, occurred_at, note)
  values (
    v_rule.user_id,
    coalesce(p_account_id, v_rule.account_id),
    v_rule.type,
    coalesce(p_amount_minor, v_rule.amount_minor),
    case when p_category_id is not null then p_category_id else v_rule.category_id end,
    coalesce(p_occurred_at, now()),
    coalesce(p_note, v_rule.note, v_rule.name)
  )
  returning id into v_transaction_id;

  update public.recurring_occurrences
  set status = 'confirmed', transaction_id = v_transaction_id, resolved_at = now()
  where id = v_occurrence.id;

  return v_transaction_id;
end;
$$;

create or replace function public.skip_recurring_occurrence(p_rule_id uuid, p_due_date date)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_occurrence public.recurring_occurrences%rowtype;
begin
  v_occurrence := public.lock_recurring_occurrence(p_rule_id, p_due_date);

  if v_occurrence.status = 'confirmed' then
    raise exception 'This occurrence was already recorded' using errcode = '22023';
  end if;

  update public.recurring_occurrences
  set status = 'skipped', resolved_at = coalesce(resolved_at, now())
  where id = v_occurrence.id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Data deletion: wipes the caller's financial data (keeps the login and
-- profile). Deleting the login itself is done from the Supabase dashboard.
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

  delete from public.recurring_occurrences where user_id = v_uid;
  delete from public.recurring_rules where user_id = v_uid;
  delete from public.transfers where user_id = v_uid;
  delete from public.transactions where user_id = v_uid;
  delete from public.accounts where user_id = v_uid;
  delete from public.categories where user_id = v_uid;
  perform public.seed_default_categories(v_uid);
end;
$$;

-- -----------------------------------------------------------------------------
-- Row level security
-- -----------------------------------------------------------------------------

alter table public.profiles              enable row level security;
alter table public.accounts              enable row level security;
alter table public.categories            enable row level security;
alter table public.transactions          enable row level security;
alter table public.transfers             enable row level security;
alter table public.recurring_rules       enable row level security;
alter table public.recurring_occurrences enable row level security;

create policy profiles_select_own on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check (id = (select auth.uid()));
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Accounts and categories are archived, not deleted, once referenced; the
-- foreign keys reject deleting anything a transaction still points to.
create policy accounts_select_own on public.accounts
  for select to authenticated using (user_id = (select auth.uid()));
create policy accounts_insert_own on public.accounts
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy accounts_update_own on public.accounts
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy accounts_delete_own on public.accounts
  for delete to authenticated using (user_id = (select auth.uid()));

create policy categories_select_own on public.categories
  for select to authenticated using (user_id = (select auth.uid()));
create policy categories_insert_own on public.categories
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy categories_update_own on public.categories
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy categories_delete_own on public.categories
  for delete to authenticated using (user_id = (select auth.uid()));

-- Transactions and transfers are soft-deleted (deleted_at), so there is no
-- delete policy: hard deletes are only possible through delete_all_my_data().
create policy transactions_select_own on public.transactions
  for select to authenticated using (user_id = (select auth.uid()));
create policy transactions_insert_own on public.transactions
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy transactions_update_own on public.transactions
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy transfers_select_own on public.transfers
  for select to authenticated using (user_id = (select auth.uid()));
create policy transfers_insert_own on public.transfers
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy transfers_update_own on public.transfers
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy recurring_rules_select_own on public.recurring_rules
  for select to authenticated using (user_id = (select auth.uid()));
create policy recurring_rules_insert_own on public.recurring_rules
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy recurring_rules_update_own on public.recurring_rules
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy recurring_rules_delete_own on public.recurring_rules
  for delete to authenticated using (user_id = (select auth.uid()));

create policy recurring_occurrences_select_own on public.recurring_occurrences
  for select to authenticated using (user_id = (select auth.uid()));
create policy recurring_occurrences_insert_own on public.recurring_occurrences
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy recurring_occurrences_update_own on public.recurring_occurrences
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- -----------------------------------------------------------------------------
-- Grants: nothing for anon; signed-in users get only the verbs the product
-- needs (Supabase's defaults grant everything), and RLS then limits rows.
-- -----------------------------------------------------------------------------

revoke all on public.profiles, public.accounts, public.categories, public.transactions,
  public.transfers, public.recurring_rules, public.recurring_occurrences,
  public.account_balances, public.ledger_entries
  from anon, authenticated, public;

grant usage on schema public to authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select, insert, update, delete on public.accounts to authenticated;
grant select, insert, update, delete on public.categories to authenticated;
grant select, insert, update on public.transactions to authenticated;
grant select, insert, update on public.transfers to authenticated;
grant select, insert, update, delete on public.recurring_rules to authenticated;
grant select, insert, update on public.recurring_occurrences to authenticated;
grant select on public.account_balances, public.ledger_entries to authenticated;

revoke execute on function
  public.set_updated_at(),
  public.validate_profile(),
  public.validate_transaction(),
  public.validate_transfer(),
  public.prepare_recurring_rule(),
  public.handle_new_user(),
  public.seed_default_categories(uuid),
  public.recurrence_date(date, text, integer, integer),
  public.recurrence_next_after(date, text, integer, date),
  public.lock_recurring_occurrence(uuid, date),
  public.ensure_profile(),
  public.period_summary(timestamptz, timestamptz),
  public.category_breakdown(timestamptz, timestamptz, text),
  public.cashflow_trend(timestamptz, timestamptz, text),
  public.sync_recurring_occurrences(),
  public.confirm_recurring_occurrence(uuid, date, bigint, uuid, uuid, timestamptz, text),
  public.skip_recurring_occurrence(uuid, date),
  public.delete_all_my_data()
  from public, anon;

-- Internal helpers stay off the API for signed-in users too.
revoke execute on function
  public.seed_default_categories(uuid),
  public.handle_new_user()
  from authenticated;

grant execute on function
  public.recurrence_date(date, text, integer, integer),
  public.recurrence_next_after(date, text, integer, date),
  public.lock_recurring_occurrence(uuid, date),
  public.ensure_profile(),
  public.period_summary(timestamptz, timestamptz),
  public.category_breakdown(timestamptz, timestamptz, text),
  public.cashflow_trend(timestamptz, timestamptz, text),
  public.sync_recurring_occurrences(),
  public.confirm_recurring_occurrence(uuid, date, bigint, uuid, uuid, timestamptz, text),
  public.skip_recurring_occurrence(uuid, date),
  public.delete_all_my_data()
  to authenticated;

-- -----------------------------------------------------------------------------
-- Backfill users who signed up before this migration ran.
-- -----------------------------------------------------------------------------

insert into public.profiles (id, display_name)
select u.id, nullif(left(split_part(u.email, '@', 1), 80), '')
from auth.users u
on conflict (id) do nothing;

select public.seed_default_categories(u.id) from auth.users u;
