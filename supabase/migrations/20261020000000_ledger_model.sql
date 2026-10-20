-- =============================================================================
-- Friday 0003 — ledger model
--
-- The rules are in docs/ledger-model.md. In short:
--   * accounts: wallet type, institution name, credit limit (cards only)
--   * transactions: refund and reversal types linked to their original,
--     a status (pending | posted | needs_review | voided), where the entry came
--     from (source_type, source_confidence)
--   * transfers: the same status and source columns
--   * only "counted" entries (status posted or pending, not deleted) move
--     balances and insights; refunds and reversals net against the original's
--     side (spending or income) and are capped at the original amount
--   * source_connections / source_events: the boundary future imports deliver
--     evidence to; nothing reaches the ledger without passing its rules
--   * ledger_audit records status changes, the reason and the previous values
--
-- Additive and re-runnable. Existing entries become posted, manual entries;
-- no amount, date or balance changes. One visible, reversible change: the
-- seeded income category "Refunds" is archived (refunds now reduce spending
-- instead of counting as income); entries already in it are untouched and it
-- can be restored from Categories.
-- =============================================================================

-- Remember whether this is the first time 0003 runs (before it adds columns),
-- so one-time data changes below are skipped on re-runs.
select pg_catalog.set_config('friday.m0003_first_run', (not exists (
  select 1 from information_schema.columns
  where table_schema = 'public' and table_name = 'transactions' and column_name = 'status'
))::text, false);

-- -----------------------------------------------------------------------------
-- Accounts
-- -----------------------------------------------------------------------------

alter table public.accounts
  add column if not exists institution_name text,
  add column if not exists credit_limit_minor bigint;

alter table public.accounts drop constraint if exists accounts_type_check;
alter table public.accounts add constraint accounts_type_check
  check (type in ('bank', 'credit_card', 'wallet', 'cash', 'other'));

alter table public.accounts drop constraint if exists accounts_institution_length;
alter table public.accounts add constraint accounts_institution_length
  check (institution_name is null or char_length(btrim(institution_name)) between 1 and 60);

-- A credit limit only makes sense on a card. Available credit is derived from
-- it (account_balances.available_credit_minor), never stored.
alter table public.accounts drop constraint if exists accounts_credit_limit_valid;
alter table public.accounts add constraint accounts_credit_limit_valid
  check (credit_limit_minor is null
         or (type = 'credit_card' and credit_limit_minor > 0 and credit_limit_minor <= 10000000000000));

-- -----------------------------------------------------------------------------
-- Transactions: types, status, links, sources
-- -----------------------------------------------------------------------------

alter table public.transactions
  add column if not exists status text not null default 'posted',
  -- While voided: the status it had before, which Restore returns it to.
  add column if not exists voided_from text,
  add column if not exists related_transaction_id uuid,
  add column if not exists reversal_of_type text,
  add column if not exists source_type text not null default 'manual',
  add column if not exists source_confidence numeric(4, 3);

-- Which side of the books an entry belongs to. Refunds and reversals net
-- against their original's side; categories are checked against it.
-- Generated, so it can never disagree with type.
alter table public.transactions
  add column if not exists base_type text generated always as (
    case
      when type = 'income' then 'income'
      when type in ('expense', 'refund') then 'expense'
      when type = 'reversal' then reversal_of_type
    end
  ) stored;

alter table public.transactions drop constraint if exists transactions_type_check;
alter table public.transactions add constraint transactions_type_check
  check (type in ('income', 'expense', 'refund', 'reversal'));

alter table public.transactions drop constraint if exists transactions_status_check;
alter table public.transactions add constraint transactions_status_check
  check (status in ('pending', 'posted', 'needs_review', 'voided'));

alter table public.transactions drop constraint if exists transactions_voided_from_check;
alter table public.transactions add constraint transactions_voided_from_check
  check (voided_from is null or (status = 'voided' and voided_from in ('pending', 'posted', 'needs_review')));

alter table public.transactions drop constraint if exists transactions_source_type_check;
alter table public.transactions add constraint transactions_source_type_check
  check (source_type in ('manual', 'email', 'bank_import', 'wallet_import', 'other_import'));

alter table public.transactions drop constraint if exists transactions_source_confidence_range;
alter table public.transactions add constraint transactions_source_confidence_range
  check (source_confidence is null or source_confidence between 0 and 1);

-- Reversals always name their original; plain income/expense never point at one.
alter table public.transactions drop constraint if exists transactions_related_shape;
alter table public.transactions add constraint transactions_related_shape
  check (
    (type in ('income', 'expense') and related_transaction_id is null)
    or type = 'refund'
    or (type = 'reversal' and related_transaction_id is not null)
  );

alter table public.transactions drop constraint if exists transactions_reversal_side;
alter table public.transactions add constraint transactions_reversal_side
  check (
    (type = 'reversal' and reversal_of_type in ('income', 'expense'))
    or (type <> 'reversal' and reversal_of_type is null)
  );

alter table public.transactions drop constraint if exists transactions_not_self_related;
alter table public.transactions add constraint transactions_not_self_related
  check (related_transaction_id is distinct from id);

alter table public.transactions drop constraint if exists transactions_related_fk;
alter table public.transactions add constraint transactions_related_fk
  foreign key (related_transaction_id, user_id) references public.transactions (id, user_id);

-- Categories are matched on base_type, so a refund uses expense categories.
alter table public.transactions drop constraint if exists transactions_category_fk;
alter table public.transactions add constraint transactions_category_fk
  foreign key (category_id, user_id, base_type)
  references public.categories (id, user_id, transaction_type);

create index if not exists transactions_related_idx
  on public.transactions (related_transaction_id) where related_transaction_id is not null;
create index if not exists transactions_attention_idx
  on public.transactions (user_id, status)
  where status in ('pending', 'needs_review') and deleted_at is null;

-- -----------------------------------------------------------------------------
-- Transfers: status and sources
-- -----------------------------------------------------------------------------

alter table public.transfers
  add column if not exists status text not null default 'posted',
  add column if not exists voided_from text,
  add column if not exists source_type text not null default 'manual',
  add column if not exists source_confidence numeric(4, 3);

alter table public.transfers drop constraint if exists transfers_status_check;
alter table public.transfers add constraint transfers_status_check
  check (status in ('pending', 'posted', 'needs_review', 'voided'));

alter table public.transfers drop constraint if exists transfers_voided_from_check;
alter table public.transfers add constraint transfers_voided_from_check
  check (voided_from is null or (status = 'voided' and voided_from in ('pending', 'posted', 'needs_review')));

alter table public.transfers drop constraint if exists transfers_source_type_check;
alter table public.transfers add constraint transfers_source_type_check
  check (source_type in ('manual', 'email', 'bank_import', 'wallet_import', 'other_import'));

alter table public.transfers drop constraint if exists transfers_source_confidence_range;
alter table public.transfers add constraint transfers_source_confidence_range
  check (source_confidence is null or source_confidence between 0 and 1);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'transfers_id_user_unique') then
    alter table public.transfers add constraint transfers_id_user_unique unique (id, user_id);
  end if;
end
$$;

create index if not exists transfers_attention_idx
  on public.transfers (user_id, status)
  where status in ('pending', 'needs_review') and deleted_at is null;

-- -----------------------------------------------------------------------------
-- Shared rules
-- -----------------------------------------------------------------------------

-- Allowed status changes. Inserts may use any status.
create or replace function public.ledger_status_change_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_from = p_to
      or (p_from, p_to) in (
        ('pending', 'posted'), ('pending', 'voided'),
        ('posted', 'voided'),
        ('needs_review', 'posted'), ('needs_review', 'pending'), ('needs_review', 'voided'),
        -- Restore: back to the status it had before voiding (checked by the triggers).
        ('voided', 'posted'), ('voided', 'pending'), ('voided', 'needs_review')
      );
$$;

-- Rupees for error messages only (never stored or summed).
create or replace function public.format_minor(p_minor bigint)
returns text
language sql
immutable
set search_path = ''
as $$
  select '₹' || pg_catalog.to_char(p_minor / 100.0, 'FM999999999999990.00');
$$;

-- -----------------------------------------------------------------------------
-- Transaction validation (replaces 0001's)
-- -----------------------------------------------------------------------------

create or replace function public.validate_transaction()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_account public.accounts%rowtype;
  v_category_archived boolean;
  v_original public.transactions%rowtype;
  v_linked bigint;
  v_counted boolean := new.deleted_at is null and new.status in ('posted', 'pending');
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

  if tg_op = 'INSERT' then
    new.voided_from := null;
  else
    if new.status is distinct from old.status then
      if not public.ledger_status_change_allowed(old.status, new.status) then
        raise exception 'An entry can''t go from % to %', replace(old.status, '_', ' '), replace(new.status, '_', ' ')
          using errcode = '22023';
      end if;
      if old.status = 'voided' and new.status <> coalesce(old.voided_from, 'posted') then
        raise exception 'Restoring returns an entry to %', replace(coalesce(old.voided_from, 'posted'), '_', ' ')
          using errcode = '22023';
      end if;
    end if;
    new.voided_from := case
      when new.status <> 'voided' then null
      when old.status = 'voided' then old.voided_from
      else old.status
    end;
    if old.status = 'voided' and new.status = 'voided'
       and (new.amount_minor, new.account_id, new.occurred_at, new.type)
           is distinct from (old.amount_minor, old.account_id, old.occurred_at, old.type) then
      raise exception 'Restore this entry before editing it' using errcode = '22023';
    end if;
    if (new.source_type, new.created_via, new.idempotency_key)
       is distinct from (old.source_type, old.created_via, old.idempotency_key) then
      raise exception 'Where an entry came from can''t be changed' using errcode = '22023';
    end if;
    -- The only type change across families: income that was really a refund
    -- (make_refund), so old "refunds recorded as income" can be corrected.
    if new.type <> old.type and (old.type in ('refund', 'reversal') or new.type in ('refund', 'reversal'))
       and not (old.type = 'income' and new.type = 'refund'
                and coalesce(current_setting('friday.convert_to_refund', true), '') = 'on') then
      raise exception 'A refund or reversal can''t change type. Delete it and record the right entry.' using errcode = '22023';
    end if;
    -- A refund recorded without its purchase can be linked once, later.
    if new.related_transaction_id is distinct from old.related_transaction_id
       and not (old.related_transaction_id is null and new.type = 'refund') then
      raise exception 'A refund or reversal can''t be moved to another entry' using errcode = '22023';
    end if;
  end if;

  if new.type = 'reversal' and new.related_transaction_id is null then
    raise exception 'A reversal must point at the entry it reverses' using errcode = '22023';
  end if;
  if new.type in ('income', 'expense') then
    new.reversal_of_type := null;
  end if;

  if new.type in ('refund', 'reversal') and new.related_transaction_id is not null then
    -- Lock the original so concurrent refunds, and changes to the original,
    -- are checked one at a time. NO KEY UPDATE conflicts with the original's
    -- own UPDATE but not with foreign-key checks.
    select * into v_original
    from public.transactions
    where id = new.related_transaction_id and user_id = new.user_id
    for no key update;
    if not found then
      raise exception 'The original entry doesn''t exist' using errcode = '23503';
    end if;
    if v_original.type not in ('income', 'expense') then
      raise exception 'Refunds and reversals can only point at an income or an expense' using errcode = '22023';
    end if;
    if new.type = 'refund' and v_original.type <> 'expense' then
      raise exception 'Only a purchase (an expense) can be refunded' using errcode = '22023';
    end if;
    if new.currency <> v_original.currency then
      raise exception 'A refund or reversal must use the original''s currency' using errcode = '22023';
    end if;
    if new.type = 'reversal' then
      new.reversal_of_type := v_original.type;
      if new.account_id <> v_original.account_id then
        raise exception 'A reversal stays on the original''s account' using errcode = '22023';
      end if;
    end if;
    -- The original's category, always (kept in sync by sync_linked_entries).
    new.category_id := v_original.category_id;

    if v_counted then
      if v_original.deleted_at is not null or v_original.status <> 'posted' then
        raise exception 'Only a posted entry can be refunded or reversed' using errcode = '22023';
      end if;
      select coalesce(sum(t.amount_minor), 0) into v_linked
      from public.transactions t
      where t.related_transaction_id = v_original.id
        and t.id <> new.id
        and t.deleted_at is null
        and t.status in ('posted', 'pending');
      if v_linked + new.amount_minor > v_original.amount_minor then
        raise exception 'Only % is left to refund or reverse on that entry',
          public.format_minor(greatest(v_original.amount_minor - v_linked, 0))
          using errcode = '22023';
      end if;
    end if;
  elsif new.category_id is not null
     and (tg_op = 'INSERT' or new.category_id is distinct from old.category_id) then
    select is_archived into v_category_archived
    from public.categories
    where id = new.category_id and user_id = new.user_id;
    if v_category_archived then
      raise exception 'That category is archived' using errcode = '22023';
    end if;
  end if;

  -- An original with counted refunds/reversals must stay consistent with them.
  if tg_op = 'UPDATE' and old.type in ('income', 'expense') then
    select coalesce(sum(t.amount_minor), 0) into v_linked
    from public.transactions t
    where t.related_transaction_id = old.id
      and t.deleted_at is null
      and t.status in ('posted', 'pending');
    if v_linked > 0 then
      if new.type <> old.type or new.currency <> old.currency then
        raise exception 'This entry has refunds or reversals. Remove them before changing its type.' using errcode = '22023';
      end if;
      if new.deleted_at is not null or new.status <> 'posted' then
        raise exception 'This entry has refunds or reversals. Delete or void those first.' using errcode = '22023';
      end if;
      if new.amount_minor < v_linked then
        raise exception 'The amount can''t be less than the % already refunded or reversed', public.format_minor(v_linked)
          using errcode = '22023';
      end if;
      if new.account_id <> old.account_id and exists (
        select 1 from public.transactions t
        where t.related_transaction_id = old.id and t.type = 'reversal'
          and t.deleted_at is null and t.status in ('posted', 'pending')
      ) then
        raise exception 'This entry has a reversal on its account. Remove the reversal before moving it.' using errcode = '22023';
      end if;
    end if;
  end if;

  return new;
end;
$$;

-- Refunds and reversals carry their original's category: follow re-categorisation.
create or replace function public.sync_linked_entries()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.category_id is distinct from old.category_id and old.type in ('income', 'expense') then
    update public.transactions
    set category_id = new.category_id
    where related_transaction_id = new.id
      and user_id = new.user_id
      and category_id is distinct from new.category_id;
  end if;
  return null;
end;
$$;

drop trigger if exists transactions_sync_linked on public.transactions;
create trigger transactions_sync_linked after update of category_id on public.transactions
  for each row execute function public.sync_linked_entries();

-- -----------------------------------------------------------------------------
-- Transfer validation (replaces 0001's)
-- -----------------------------------------------------------------------------

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

  if tg_op = 'INSERT' then
    new.voided_from := null;
  else
    if new.status is distinct from old.status then
      if not public.ledger_status_change_allowed(old.status, new.status) then
        raise exception 'An entry can''t go from % to %', replace(old.status, '_', ' '), replace(new.status, '_', ' ')
          using errcode = '22023';
      end if;
      if old.status = 'voided' and new.status <> coalesce(old.voided_from, 'posted') then
        raise exception 'Restoring returns an entry to %', replace(coalesce(old.voided_from, 'posted'), '_', ' ')
          using errcode = '22023';
      end if;
    end if;
    new.voided_from := case
      when new.status <> 'voided' then null
      when old.status = 'voided' then old.voided_from
      else old.status
    end;
    if old.status = 'voided' and new.status = 'voided'
       and (new.amount_minor, new.source_account_id, new.destination_account_id, new.occurred_at)
           is distinct from (old.amount_minor, old.source_account_id, old.destination_account_id, old.occurred_at) then
      raise exception 'Restore this entry before editing it' using errcode = '22023';
    end if;
    if (new.source_type, new.created_via, new.idempotency_key)
       is distinct from (old.source_type, old.created_via, old.idempotency_key) then
      raise exception 'Where an entry came from can''t be changed' using errcode = '22023';
    end if;
  end if;

  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Audit: status changes, reasons and previous values
-- -----------------------------------------------------------------------------

alter table public.ledger_audit
  add column if not exists reason text,
  add column if not exists previous jsonb;

-- 'void' rows written before 0003 were deletions; new deletions are 'delete'.
alter table public.ledger_audit drop constraint if exists ledger_audit_action_check;
alter table public.ledger_audit add constraint ledger_audit_action_check
  check (action in ('create', 'update', 'status', 'delete', 'restore', 'void'));

alter table public.ledger_audit drop constraint if exists ledger_audit_reason_length;
alter table public.ledger_audit add constraint ledger_audit_reason_length
  check (reason is null or char_length(reason) <= 200);

-- Financial facts of a ledger row (never note or merchant text).
create or replace function public.ledger_facts(p_row jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'type', p_row ->> 'type',
    'amount_minor', (p_row ->> 'amount_minor')::bigint,
    'currency', p_row ->> 'currency',
    'account_id', p_row ->> 'account_id',
    'category_id', p_row ->> 'category_id',
    'source_account_id', p_row ->> 'source_account_id',
    'destination_account_id', p_row ->> 'destination_account_id',
    'occurred_at', p_row ->> 'occurred_at',
    'status', p_row ->> 'status',
    'related_transaction_id', p_row ->> 'related_transaction_id',
    'source_type', p_row ->> 'source_type',
    'has_note', (p_row ->> 'note') is not null,
    'has_merchant', (p_row ->> 'merchant') is not null,
    'created_via', p_row ->> 'created_via'
  ));
$$;

create or replace function public.audit_ledger_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entity text := case tg_table_name when 'transactions' then 'transaction' else 'transfer' end;
  v_new jsonb := to_jsonb(new);
  v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
  v_fields text[] := array['type', 'amount_minor', 'currency', 'account_id', 'category_id',
                           'source_account_id', 'destination_account_id', 'occurred_at', 'note', 'merchant',
                           'status', 'related_transaction_id', 'source_type'];
  v_changed text[] := '{}';
  v_action text;
  v_field text;
  v_reason text := nullif(left(btrim(current_setting('friday.change_reason', true)), 200), '');
begin
  if tg_op = 'INSERT' then
    v_action := 'create';
  elsif old.deleted_at is null and new.deleted_at is not null then
    v_action := 'delete';
  elsif old.deleted_at is not null and new.deleted_at is null then
    v_action := 'restore';
  else
    foreach v_field in array v_fields loop
      if (v_new -> v_field) is distinct from (v_old -> v_field) then
        v_changed := v_changed || v_field;
      end if;
    end loop;
    if cardinality(v_changed) = 0 then
      return null;
    end if;
    v_action := case when 'status' = any (v_changed) then 'status' else 'update' end;
  end if;

  insert into public.ledger_audit (user_id, entity, entity_id, action, changed_fields, snapshot, previous, reason)
  values (
    new.user_id, v_entity, new.id, v_action, v_changed,
    public.ledger_facts(v_new),
    case when tg_op = 'UPDATE' then public.ledger_facts(v_old) end,
    v_reason
  );
  return null;
end;
$$;

-- -----------------------------------------------------------------------------
-- Import boundary: connections and evidence
-- -----------------------------------------------------------------------------

-- A future Gmail inbox, bank feed or wallet export. Nothing creates these yet.
create table if not exists public.source_connections (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  source_type  text not null check (source_type in ('email', 'bank_import', 'wallet_import', 'other_import')),
  label        text not null check (char_length(btrim(label)) between 1 and 80),
  status       text not null default 'active' check (status in ('active', 'paused', 'disconnected')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint source_connections_id_user_unique unique (id, user_id)
);

drop trigger if exists source_connections_updated_at on public.source_connections;
create trigger source_connections_updated_at before update on public.source_connections
  for each row execute function public.set_updated_at();

-- One row per piece of evidence about a possible transaction. Keeps only the
-- parsed facts processing needs — never an email body.
create table if not exists public.source_events (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null references auth.users (id) on delete cascade,
  source_type               text not null check (source_type in ('email', 'bank_import', 'wallet_import', 'other_import')),
  source_connection_id      uuid,
  external_event_id         text not null check (char_length(external_event_id) between 1 and 200),
  external_transaction_id   text check (external_transaction_id is null or char_length(external_transaction_id) between 1 and 200),
  payload_fingerprint       text check (payload_fingerprint is null or char_length(payload_fingerprint) between 1 and 200),
  received_at               timestamptz not null default now(),
  parsed_at                 timestamptz,
  processing_status         text not null default 'received'
                            check (processing_status in ('received', 'parsed', 'needs_review', 'imported', 'ignored', 'failed')),
  confidence                numeric(4, 3) check (confidence is null or confidence between 0 and 1),
  -- Parsed facts
  parsed_kind               text check (parsed_kind is null or parsed_kind in ('expense', 'income', 'refund', 'reversal', 'transfer')),
  parsed_amount_minor       bigint check (parsed_amount_minor is null or parsed_amount_minor > 0),
  parsed_currency           char(3) check (parsed_currency is null or parsed_currency ~ '^[A-Z]{3}$'),
  parsed_occurred_at        timestamptz,
  parsed_merchant           text check (parsed_merchant is null or char_length(parsed_merchant) <= 120),
  parsed_account_hint       text check (parsed_account_hint is null or char_length(parsed_account_hint) <= 60),
  -- The transaction's state as the source reported it.
  parsed_entry_status       text check (parsed_entry_status is null
                              or parsed_entry_status in ('pending', 'posted', 'cancelled', 'declined')),
  -- Review
  review_reason             text check (review_reason is null or review_reason in (
                              'missing_details', 'unsupported_currency', 'unknown_account', 'needs_link',
                              'low_confidence', 'possible_duplicate', 'linked_entry_removed',
                              'possible_transfer', 'settlement_differs', 'before_tracking_start')),
  suggested_account_id      uuid,
  suggested_destination_account_id uuid,
  suggested_category_id     uuid,
  suggested_match_kind      text check (suggested_match_kind is null or suggested_match_kind in ('transaction', 'transfer')),
  suggested_match_id        uuid,
  -- Outcome
  resulting_transaction_id  uuid,
  resulting_transfer_id     uuid,
  link_type                 text check (link_type is null or link_type in ('created', 'matched')),
  linked_at                 timestamptz,
  error_code                text check (error_code is null or char_length(error_code) <= 60),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint source_events_one_result check (resulting_transaction_id is null or resulting_transfer_id is null),
  constraint source_events_link_consistent check (
    (link_type is null) = (resulting_transaction_id is null and resulting_transfer_id is null)
  ),
  constraint source_events_imported_has_result check (
    (processing_status = 'imported') = (link_type is not null)
  ),
  constraint source_events_connection_fk foreign key (source_connection_id, user_id)
    references public.source_connections (id, user_id),
  constraint source_events_transaction_fk foreign key (resulting_transaction_id, user_id)
    references public.transactions (id, user_id),
  constraint source_events_transfer_fk foreign key (resulting_transfer_id, user_id)
    references public.transfers (id, user_id),
  constraint source_events_suggested_account_fk foreign key (suggested_account_id, user_id)
    references public.accounts (id, user_id),
  constraint source_events_suggested_destination_fk foreign key (suggested_destination_account_id, user_id)
    references public.accounts (id, user_id),
  constraint source_events_suggested_category_fk foreign key (suggested_category_id, user_id)
    references public.categories (id, user_id)
);

-- A redelivered event is the same event: one row per stable source identifier.
create unique index if not exists source_events_external_unique
  on public.source_events (user_id, source_type,
    coalesce(source_connection_id, '00000000-0000-0000-0000-000000000000'::uuid), external_event_id);
create index if not exists source_events_external_transaction_idx
  on public.source_events (user_id, source_type, external_transaction_id)
  where external_transaction_id is not null;
create index if not exists source_events_fingerprint_idx
  on public.source_events (user_id, payload_fingerprint)
  where payload_fingerprint is not null;
create index if not exists source_events_queue_idx
  on public.source_events (user_id, processing_status, received_at desc);
create index if not exists source_events_resulting_transaction_idx
  on public.source_events (resulting_transaction_id) where resulting_transaction_id is not null;

drop trigger if exists source_events_updated_at on public.source_events;
create trigger source_events_updated_at before update on public.source_events
  for each row execute function public.set_updated_at();

alter table public.source_connections enable row level security;
alter table public.source_events enable row level security;

drop policy if exists source_connections_select_own on public.source_connections;
create policy source_connections_select_own on public.source_connections
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists source_events_select_own on public.source_events;
create policy source_events_select_own on public.source_events
  for select to authenticated using (user_id = (select auth.uid()));

-- Read-only to clients: evidence and its processing state only change
-- through the functions below.
revoke all on public.source_connections, public.source_events from anon, authenticated, public;
grant select on public.source_connections, public.source_events to authenticated;

-- -----------------------------------------------------------------------------
-- Read models
-- -----------------------------------------------------------------------------

-- Balance = opening + income − expenses + refunds/reversed purchases
--           − reversed income + transfers in − transfers out, counted entries only.
-- Columns are appended after 0001's so existing readers keep working.
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
        then a.credit_limit_minor - greatest(-b.balance_minor, 0) end)::bigint as available_credit_minor
from public.accounts a
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
) t on true
left join lateral (
  select sum(x.amount_minor) as amount_minor,
         sum(x.amount_minor) filter (where x.status = 'pending') as pending_minor
  from public.transfers x
  where x.destination_account_id = a.id and x.deleted_at is null and x.status in ('posted', 'pending')
) tin on true
left join lateral (
  select sum(x.amount_minor) as amount_minor,
         sum(x.amount_minor) filter (where x.status = 'pending') as pending_minor
  from public.transfers x
  where x.source_account_id = a.id and x.deleted_at is null and x.status in ('posted', 'pending')
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

-- Every non-deleted entry, whatever its status (voided ones stay visible).
create or replace view public.ledger_entries
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
  t.updated_at,
  t.merchant,
  t.status,
  t.source_type,
  t.created_via,
  t.related_transaction_id,
  t.base_type,
  t.source_confidence,
  t.voided_from
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
  x.updated_at,
  null::text,
  x.status,
  x.source_type,
  x.created_via,
  null::uuid,
  null::text,
  x.source_confidence,
  x.voided_from
from public.transfers x
where x.deleted_at is null;

-- -----------------------------------------------------------------------------
-- Reporting (counted entries only; transfers never count as income/spending)
--   spending = expenses − refunds − reversed purchases
--   income   = income − reversed income
-- A refund lands in the period it happens (money came back then). A reversal
-- is reported in its original's period: what was reversed never really
-- happened, so a salary bounced the next day doesn't show as +₹X one month
-- and −₹X the next. Balances are unaffected by this choice.
-- -----------------------------------------------------------------------------

create or replace view public.reporting_entries
with (security_invoker = true)
as
select
  t.id,
  t.user_id,
  t.type,
  t.base_type,
  t.account_id,
  t.category_id,
  t.amount_minor,
  t.status,
  t.occurred_at,
  coalesce(o.occurred_at, t.occurred_at) as reported_at
from public.transactions t
left join public.transactions o
  on t.type = 'reversal' and o.id = t.related_transaction_id and o.user_id = t.user_id
where t.deleted_at is null
  and t.status in ('posted', 'pending');

drop function if exists public.period_summary(timestamptz, timestamptz);
create function public.period_summary(p_from timestamptz, p_to timestamptz)
returns table (
  income_minor bigint,
  expense_minor bigint,
  net_minor bigint,
  income_count bigint,
  expense_count bigint,
  transfer_count bigint,
  refund_minor bigint,
  refund_count bigint,
  pending_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with t as (
    select
      coalesce(sum(amount_minor) filter (where type = 'income'), 0)
        - coalesce(sum(amount_minor) filter (where type = 'reversal' and base_type = 'income'), 0) as income_minor,
      coalesce(sum(amount_minor) filter (where type = 'expense'), 0)
        - coalesce(sum(amount_minor) filter (where base_type = 'expense' and type <> 'expense'), 0)
                                                                         as expense_minor,
      coalesce(sum(amount_minor) filter (where base_type = 'expense' and type <> 'expense'), 0)
                                                                         as refund_minor,
      count(*) filter (where type = 'income')                            as income_count,
      count(*) filter (where type = 'expense')                           as expense_count,
      count(*) filter (where base_type = 'expense' and type <> 'expense') as refund_count,
      count(*) filter (where status = 'pending')                         as pending_count
    from public.reporting_entries
    where user_id = auth.uid()
      and reported_at >= p_from and reported_at < p_to
  ),
  x as (
    select count(*) as transfer_count,
           count(*) filter (where status = 'pending') as pending_count
    from public.transfers
    where user_id = auth.uid()
      and deleted_at is null
      and status in ('posted', 'pending')
      and occurred_at >= p_from and occurred_at < p_to
  )
  select t.income_minor::bigint, t.expense_minor::bigint, (t.income_minor - t.expense_minor)::bigint,
         t.income_count, t.expense_count, x.transfer_count,
         t.refund_minor::bigint, t.refund_count, t.pending_count + x.pending_count
  from t, x;
$$;

-- Net per category: gross on the chosen side minus its refunds/reversals.
drop function if exists public.category_breakdown(timestamptz, timestamptz, text);
create function public.category_breakdown(
  p_from timestamptz,
  p_to timestamptz,
  p_type text default 'expense'
)
returns table (category_id uuid, total_minor bigint, transaction_count bigint, gross_minor bigint, refund_minor bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    category_id,
    (coalesce(sum(amount_minor) filter (where type = p_type), 0)
      - coalesce(sum(amount_minor) filter (where type <> p_type), 0))::bigint,
    count(*) filter (where type = p_type),
    coalesce(sum(amount_minor) filter (where type = p_type), 0)::bigint,
    coalesce(sum(amount_minor) filter (where type <> p_type), 0)::bigint
  from public.reporting_entries
  where user_id = auth.uid()
    and base_type = p_type
    and reported_at >= p_from and reported_at < p_to
  group by category_id
  order by 2 desc;
$$;

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
      date_trunc(p_bucket, t.reported_at at time zone v_tz)::date as bucket_start,
      coalesce(sum(t.amount_minor) filter (where t.type = 'income'), 0)
        - coalesce(sum(t.amount_minor) filter (where t.type = 'reversal' and t.base_type = 'income'), 0) as income_minor,
      coalesce(sum(t.amount_minor) filter (where t.type = 'expense'), 0)
        - coalesce(sum(t.amount_minor) filter (where t.base_type = 'expense' and t.type <> 'expense'), 0) as expense_minor
    from public.reporting_entries t
    where t.user_id = auth.uid()
      and t.reported_at >= p_from and t.reported_at < p_to
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

-- Money in/out per account for a period (counted entries).
create or replace function public.account_activity(p_from timestamptz, p_to timestamptz)
returns table (
  account_id uuid,
  money_in_minor bigint,
  money_out_minor bigint,
  transfers_in_minor bigint,
  transfers_out_minor bigint,
  entry_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with moves as (
    select t.account_id,
           case when t.type in ('income', 'refund') or (t.type = 'reversal' and t.base_type = 'expense')
                then t.amount_minor else 0 end as money_in,
           case when t.type = 'expense' or (t.type = 'reversal' and t.base_type = 'income')
                then t.amount_minor else 0 end as money_out,
           0::bigint as t_in, 0::bigint as t_out
    from public.transactions t
    where t.user_id = auth.uid() and t.deleted_at is null and t.status in ('posted', 'pending')
      and t.occurred_at >= p_from and t.occurred_at < p_to
    union all
    select x.destination_account_id, 0, 0, x.amount_minor, 0
    from public.transfers x
    where x.user_id = auth.uid() and x.deleted_at is null and x.status in ('posted', 'pending')
      and x.occurred_at >= p_from and x.occurred_at < p_to
    union all
    select x.source_account_id, 0, 0, 0, x.amount_minor
    from public.transfers x
    where x.user_id = auth.uid() and x.deleted_at is null and x.status in ('posted', 'pending')
      and x.occurred_at >= p_from and x.occurred_at < p_to
  )
  select account_id,
         sum(money_in)::bigint, sum(money_out)::bigint, sum(t_in)::bigint, sum(t_out)::bigint, count(*)
  from moves
  group by account_id
  order by sum(money_out) + sum(t_out) desc;
$$;

-- What needs a look, all time: review queue and pending entries.
create or replace function public.ledger_attention()
returns table (review_events bigint, review_entries bigint, pending_entries bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    (select count(*) from public.source_events
     where user_id = auth.uid() and processing_status = 'needs_review'),
    (select count(*) from public.transactions
     where user_id = auth.uid() and deleted_at is null and status = 'needs_review')
      + (select count(*) from public.transfers
         where user_id = auth.uid() and deleted_at is null and status = 'needs_review'),
    (select count(*) from public.transactions
     where user_id = auth.uid() and deleted_at is null and status = 'pending')
      + (select count(*) from public.transfers
         where user_id = auth.uid() and deleted_at is null and status = 'pending');
$$;

-- -----------------------------------------------------------------------------
-- Write path
-- -----------------------------------------------------------------------------

-- Sets the reason the audit trigger records for this transaction's changes.
create or replace function public.set_change_reason(p_reason text)
returns void
language sql
set search_path = ''
as $$
  select pg_catalog.set_config('friday.change_reason', coalesce(left(btrim(p_reason), 200), ''), true);
$$;

-- record_entry gains refunds/reversals, status and source. The old signature
-- is dropped so PostgREST never sees two overloads; old callers still match
-- because every new parameter has a default.
drop function if exists public.record_entry(uuid, text, bigint, uuid, uuid, uuid, timestamptz, text, text, text);
drop function if exists public.record_entry(uuid, text, bigint, uuid, uuid, uuid, timestamptz, text, text, text, uuid, text, text, numeric);

create function public.record_entry(
  p_idempotency_key uuid,
  p_kind text,
  p_amount_minor bigint,
  p_account_id uuid,
  p_destination_account_id uuid default null,
  p_category_id uuid default null,
  p_occurred_at timestamptz default null,
  p_note text default null,
  p_merchant text default null,
  p_created_via text default 'quick_add',
  p_related_transaction_id uuid default null,
  p_status text default 'posted',
  p_source_type text default 'manual',
  p_source_confidence numeric default null
)
returns table (kind text, id uuid, created boolean, matches boolean, voided boolean, updated_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_note text := nullif(btrim(p_note), '');
  v_merchant text := nullif(btrim(p_merchant), '');
  v_tx public.transactions%rowtype;
  v_tr public.transfers%rowtype;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  if p_idempotency_key is null then
    raise exception 'Missing request key' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('income', 'expense', 'transfer', 'refund', 'reversal') then
    raise exception 'Choose expense, income or transfer' using errcode = '22023';
  end if;
  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'Amount must be more than zero' using errcode = '22023';
  end if;
  if p_account_id is null then
    raise exception 'Choose an account' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('pending', 'posted', 'needs_review') then
    raise exception 'New entries are posted, pending or waiting for review' using errcode = '22023';
  end if;
  if p_kind = 'reversal' and p_related_transaction_id is null then
    raise exception 'A reversal must point at the entry it reverses' using errcode = '22023';
  end if;
  if p_kind in ('income', 'expense', 'transfer') and p_related_transaction_id is not null then
    raise exception 'Only refunds and reversals point at another entry' using errcode = '22023';
  end if;

  -- Serialise concurrent replays of the same request.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_uid::text || ':' || p_idempotency_key::text, 0));

  select * into v_tx from public.transactions t
  where t.user_id = v_uid and t.idempotency_key = p_idempotency_key;
  if found then
    return query select
      v_tx.type,
      v_tx.id,
      false,
      p_kind = v_tx.type
        and p_amount_minor = v_tx.amount_minor
        and p_account_id = v_tx.account_id
        and (case when v_tx.type in ('refund', 'reversal')
                  then p_related_transaction_id is not distinct from v_tx.related_transaction_id
                  else p_category_id is not distinct from v_tx.category_id end),
      v_tx.deleted_at is not null or v_tx.status = 'voided',
      v_tx.updated_at;
    return;
  end if;

  select * into v_tr from public.transfers x
  where x.user_id = v_uid and x.idempotency_key = p_idempotency_key;
  if found then
    return query select
      'transfer'::text,
      v_tr.id,
      false,
      p_kind = 'transfer'
        and p_amount_minor = v_tr.amount_minor
        and p_account_id = v_tr.source_account_id
        and p_destination_account_id is not distinct from v_tr.destination_account_id,
      v_tr.deleted_at is not null or v_tr.status = 'voided',
      v_tr.updated_at;
    return;
  end if;

  if p_kind = 'transfer' then
    if p_destination_account_id is null then
      raise exception 'Choose a destination account' using errcode = '22023';
    end if;
    if p_category_id is not null then
      raise exception 'Transfers don''t have a category' using errcode = '22023';
    end if;
    insert into public.transfers (
      user_id, source_account_id, destination_account_id, amount_minor,
      occurred_at, note, idempotency_key, created_via, status, source_type, source_confidence)
    values (
      v_uid, p_account_id, p_destination_account_id, p_amount_minor,
      coalesce(p_occurred_at, now()), v_note, p_idempotency_key, p_created_via,
      p_status, p_source_type, p_source_confidence)
    returning * into v_tr;
    return query select 'transfer'::text, v_tr.id, true, true, false, v_tr.updated_at;
  else
    insert into public.transactions (
      user_id, account_id, type, amount_minor, category_id,
      occurred_at, note, merchant, idempotency_key, created_via,
      related_transaction_id, status, source_type, source_confidence)
    values (
      v_uid, p_account_id, p_kind, p_amount_minor,
      case when p_kind in ('refund', 'reversal') and p_related_transaction_id is not null then null else p_category_id end,
      coalesce(p_occurred_at, now()), v_note, v_merchant, p_idempotency_key, p_created_via,
      p_related_transaction_id, p_status, p_source_type, p_source_confidence)
    returning * into v_tx;
    return query select v_tx.type, v_tx.id, true, true, false, v_tx.updated_at;
  end if;
end;
$$;

-- update_entry gains refunds/reversals and a reason for the audit trail.
drop function if exists public.update_entry(text, uuid, timestamptz, text, bigint, uuid, uuid, uuid, timestamptz, text, text);
drop function if exists public.update_entry(text, uuid, timestamptz, text, bigint, uuid, uuid, uuid, timestamptz, text, text, text);

create function public.update_entry(
  p_kind text,
  p_id uuid,
  p_expected_updated_at timestamptz,
  p_new_kind text,
  p_amount_minor bigint,
  p_account_id uuid,
  p_destination_account_id uuid default null,
  p_category_id uuid default null,
  p_occurred_at timestamptz default null,
  p_note text default null,
  p_merchant text default null,
  p_reason text default null
)
returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_tx public.transactions%rowtype;
  v_tr public.transfers%rowtype;
  v_updated timestamptz;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'Amount must be more than zero' using errcode = '22023';
  end if;
  if (p_kind = 'transfer') <> (p_new_kind = 'transfer') then
    raise exception 'A transfer can''t become income or an expense. Delete it and record a new entry.' using errcode = '22023';
  end if;
  perform public.set_change_reason(p_reason);

  if p_kind = 'transfer' then
    select * into v_tr from public.transfers x where x.id = p_id and x.user_id = v_uid for update;
    if not found then
      raise exception 'That entry no longer exists' using errcode = 'P0002';
    end if;
    if v_tr.deleted_at is not null then
      raise exception 'That entry was deleted' using errcode = '22023';
    end if;
    if p_expected_updated_at is not null and v_tr.updated_at <> p_expected_updated_at then
      raise exception 'This entry was changed somewhere else. Reload to see the latest version.' using errcode = 'PT409';
    end if;
    update public.transfers set
      source_account_id = p_account_id,
      destination_account_id = p_destination_account_id,
      amount_minor = p_amount_minor,
      occurred_at = coalesce(p_occurred_at, occurred_at),
      note = nullif(btrim(p_note), '')
    where id = p_id
    returning updated_at into v_updated;
  elsif p_kind in ('income', 'expense', 'refund', 'reversal') then
    -- Lock order: an original before its refunds/reversals, as everywhere else.
    perform 1 from public.transactions o
    where o.user_id = v_uid
      and o.id = (select t.related_transaction_id from public.transactions t where t.id = p_id and t.user_id = v_uid)
    for no key update;
    select * into v_tx from public.transactions t where t.id = p_id and t.user_id = v_uid for update;
    if not found then
      raise exception 'That entry no longer exists' using errcode = 'P0002';
    end if;
    if v_tx.deleted_at is not null then
      raise exception 'That entry was deleted' using errcode = '22023';
    end if;
    if p_expected_updated_at is not null and v_tx.updated_at <> p_expected_updated_at then
      raise exception 'This entry was changed somewhere else. Reload to see the latest version.' using errcode = 'PT409';
    end if;
    if v_tx.type in ('refund', 'reversal') or p_new_kind in ('refund', 'reversal') then
      if p_new_kind <> v_tx.type then
        raise exception 'A refund or reversal can''t change type. Delete it and record the right entry.' using errcode = '22023';
      end if;
    elsif p_new_kind not in ('income', 'expense') then
      raise exception 'Choose expense or income' using errcode = '22023';
    end if;
    update public.transactions set
      type = p_new_kind,
      account_id = p_account_id,
      amount_minor = p_amount_minor,
      -- Linked refunds and reversals take their original's category (trigger);
      -- a refund recorded without its purchase keeps the one chosen for it.
      category_id = case when v_tx.type = 'reversal' or v_tx.related_transaction_id is not null
                         then category_id else p_category_id end,
      occurred_at = coalesce(p_occurred_at, occurred_at),
      note = nullif(btrim(p_note), ''),
      merchant = nullif(btrim(p_merchant), '')
    where id = p_id
    returning updated_at into v_updated;
  else
    raise exception 'Choose expense, income or transfer' using errcode = '22023';
  end if;

  return v_updated;
end;
$$;

-- Delete (Undo) and restore, for every kind. Idempotent.
create or replace function public.set_entry_voided(p_kind text, p_id uuid, p_voided boolean)
returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_deleted timestamptz;
  v_updated timestamptz;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;

  if p_kind = 'transfer' then
    select deleted_at, updated_at into v_deleted, v_updated
    from public.transfers where id = p_id and user_id = v_uid for update;
  elsif p_kind in ('income', 'expense', 'refund', 'reversal') then
    -- Lock order: an original before its refunds/reversals, as everywhere else.
    perform 1 from public.transactions o
    where o.user_id = v_uid
      and o.id = (select t.related_transaction_id from public.transactions t where t.id = p_id and t.user_id = v_uid)
    for no key update;
    select deleted_at, updated_at into v_deleted, v_updated
    from public.transactions where id = p_id and user_id = v_uid for update;
  else
    raise exception 'Choose expense, income or transfer' using errcode = '22023';
  end if;
  if not found then
    raise exception 'That entry no longer exists' using errcode = 'P0002';
  end if;

  if (v_deleted is not null) = p_voided then
    return v_updated;
  end if;

  if p_kind = 'transfer' then
    update public.transfers set deleted_at = case when p_voided then now() end
    where id = p_id returning updated_at into v_updated;
  else
    update public.transactions set deleted_at = case when p_voided then now() end
    where id = p_id returning updated_at into v_updated;
  end if;
  return v_updated;
end;
$$;

-- Pending → posted, voiding, confirming a reviewed entry, restoring a voided one.
create or replace function public.set_entry_status(
  p_kind text,
  p_id uuid,
  p_status text,
  p_reason text default null,
  p_expected_updated_at timestamptz default null
)
returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_current text;
  v_deleted timestamptz;
  v_updated timestamptz;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  if p_status is null or p_status not in ('pending', 'posted', 'needs_review', 'voided') then
    raise exception 'Unknown status' using errcode = '22023';
  end if;

  if p_kind = 'transfer' then
    select status, deleted_at, updated_at into v_current, v_deleted, v_updated
    from public.transfers where id = p_id and user_id = v_uid for update;
  elsif p_kind in ('income', 'expense', 'refund', 'reversal') then
    -- Lock order: an original before its refunds/reversals, as everywhere else.
    perform 1 from public.transactions o
    where o.user_id = v_uid
      and o.id = (select t.related_transaction_id from public.transactions t where t.id = p_id and t.user_id = v_uid)
    for no key update;
    select status, deleted_at, updated_at into v_current, v_deleted, v_updated
    from public.transactions where id = p_id and user_id = v_uid for update;
  else
    raise exception 'Choose expense, income or transfer' using errcode = '22023';
  end if;
  if not found then
    raise exception 'That entry no longer exists' using errcode = 'P0002';
  end if;
  if v_deleted is not null then
    raise exception 'That entry was deleted' using errcode = '22023';
  end if;
  if v_current = p_status then
    return v_updated;
  end if;
  if p_expected_updated_at is not null and v_updated <> p_expected_updated_at then
    raise exception 'This entry was changed somewhere else. Reload to see the latest version.' using errcode = 'PT409';
  end if;
  if not public.ledger_status_change_allowed(v_current, p_status) then
    raise exception 'An entry can''t go from % to %', replace(v_current, '_', ' '), replace(p_status, '_', ' ')
      using errcode = '22023';
  end if;

  perform public.set_change_reason(p_reason);
  if p_kind = 'transfer' then
    update public.transfers set status = p_status where id = p_id returning updated_at into v_updated;
  else
    update public.transactions set status = p_status where id = p_id returning updated_at into v_updated;
  end if;
  return v_updated;
end;
$$;

-- The same as set_entry_voided (which predates the voided status and is
-- kept for older app versions): soft delete / Undo, and restore.
create or replace function public.set_entry_deleted(p_kind text, p_id uuid, p_deleted boolean)
returns timestamptz
language sql
security invoker
set search_path = ''
as $$
  select public.set_entry_voided(p_kind, p_id, p_deleted);
$$;

-- Corrects a refund that was recorded as income, or links a refund that was
-- recorded without its purchase. Either way the refund then nets against
-- spending (the purchase's category, or the expense category given), and the
-- usual checks apply: the purchase is a posted expense, the total refunded
-- never exceeds it.
create or replace function public.make_refund(
  p_id uuid,
  p_original_id uuid default null,
  p_category_id uuid default null,
  p_expected_updated_at timestamptz default null,
  p_reason text default null
)
returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_tx public.transactions%rowtype;
  v_updated timestamptz;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;

  -- Lock order: the purchase before the entry that becomes its refund.
  perform 1 from public.transactions o where o.id = p_original_id and o.user_id = v_uid for no key update;
  select * into v_tx from public.transactions t where t.id = p_id and t.user_id = v_uid for update;
  if not found then
    raise exception 'That entry no longer exists' using errcode = 'P0002';
  end if;
  if v_tx.deleted_at is not null then
    raise exception 'That entry was deleted' using errcode = '22023';
  end if;
  if v_tx.status = 'voided' then
    raise exception 'Restore this entry before changing it' using errcode = '22023';
  end if;
  if p_expected_updated_at is not null and v_tx.updated_at <> p_expected_updated_at then
    raise exception 'This entry was changed somewhere else. Reload to see the latest version.' using errcode = 'PT409';
  end if;
  perform public.set_change_reason(coalesce(p_reason, 'Recorded as a refund'));

  if v_tx.type = 'income' then
    perform pg_catalog.set_config('friday.convert_to_refund', 'on', true);
    update public.transactions set
      type = 'refund',
      related_transaction_id = p_original_id,
      category_id = case when p_original_id is null then p_category_id end
    where id = p_id
    returning updated_at into v_updated;
    perform pg_catalog.set_config('friday.convert_to_refund', '', true);
  elsif v_tx.type = 'refund' and v_tx.related_transaction_id is null then
    if p_original_id is null then
      raise exception 'Pick the purchase this refunds' using errcode = '22023';
    end if;
    update public.transactions set related_transaction_id = p_original_id
    where id = p_id
    returning updated_at into v_updated;
  else
    raise exception 'Only income, or a refund without its purchase, can be changed this way' using errcode = '22023';
  end if;
  return v_updated;
end;
$$;

-- -----------------------------------------------------------------------------
-- Ingestion: evidence in, at most one ledger entry out
--
-- Every path that reads match candidates and then writes (ingest, review
-- confirm/link/ignore) holds one per-user lock, so two pieces of evidence for
-- the same purchase can never both create an entry. Import volume per user is
-- tiny, so the lock costs nothing.
-- -----------------------------------------------------------------------------

create or replace function public.lock_user_imports(p_user_id uuid)
returns void
language sql
set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('friday:import:' || p_user_id::text, 0));
$$;

-- The integration point for future importers (Gmail, bank feeds). Callable by
-- the service role, or through submit_source_event for the caller's own data;
-- anything else is refused even if a grant is ever added by mistake.
-- Re-delivering the same event returns its first result unchanged.
create or replace function public.ingest_source_event_for(
  p_user_id uuid,
  p_source_type text,
  p_external_event_id text,
  p_source_connection_id uuid default null,
  p_external_transaction_id text default null,
  p_payload_fingerprint text default null,
  p_kind text default null,
  p_amount_minor bigint default null,
  p_currency text default 'INR',
  p_occurred_at timestamptz default null,
  p_merchant text default null,
  p_account_hint text default null,
  p_account_id uuid default null,
  p_destination_account_id uuid default null,
  p_category_id uuid default null,
  p_entry_status text default 'posted',
  p_confidence numeric default null
)
returns table (
  event_id uuid,
  processing_status text,
  review_reason text,
  entry_kind text,
  entry_id uuid,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_event public.source_events%rowtype;
  v_kind text := case when p_kind in ('expense', 'income', 'refund', 'reversal', 'transfer') then p_kind end;
  v_state text := case when p_entry_status in ('pending', 'posted', 'cancelled', 'declined') then p_entry_status else 'posted' end;
  v_currency text := upper(nullif(btrim(p_currency), ''));
  v_merchant text := left(nullif(btrim(p_merchant), ''), 120);
  v_hint text := left(nullif(btrim(p_account_hint), ''), 60);
  v_ext_event text := btrim(p_external_event_id);
  v_ext_tx text := left(nullif(btrim(p_external_transaction_id), ''), 200);
  v_fingerprint text := left(nullif(btrim(p_payload_fingerprint), ''), 200);
  v_amount_ok boolean := p_amount_minor is not null and p_amount_minor > 0 and p_amount_minor <= 10000000000000;
  v_account public.accounts%rowtype;
  v_destination uuid;
  v_category uuid;
  v_reason text;
  v_match_kind text;
  v_match_id uuid;
  v_prior public.source_events%rowtype;
  v_tx public.transactions%rowtype;
  v_tr public.transfers%rowtype;
  v_error text;
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') <> 'service_role'
     and coalesce(current_setting('friday.ingest_caller', true), '') <> 'submit' then
    raise exception 'Imports are delivered by Friday''s import service' using errcode = '42501';
  end if;
  if p_user_id is null or not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'Unknown user' using errcode = '22023';
  end if;
  if p_source_type is null or p_source_type not in ('email', 'bank_import', 'wallet_import', 'other_import') then
    raise exception 'Unknown source type' using errcode = '22023';
  end if;
  if v_ext_event is null or char_length(v_ext_event) not between 1 and 200 then
    raise exception 'Every event needs its source''s id' using errcode = '22023';
  end if;
  if p_confidence is not null and (p_confidence < 0 or p_confidence > 1) then
    raise exception 'Confidence must be between 0 and 1' using errcode = '22023';
  end if;
  if p_source_connection_id is not null and not exists (
    select 1 from public.source_connections c where c.id = p_source_connection_id and c.user_id = p_user_id
  ) then
    raise exception 'Unknown source connection' using errcode = '23503';
  end if;

  perform public.lock_user_imports(p_user_id);

  -- A redelivery is the same event: return what happened the first time.
  select * into v_event from public.source_events e
  where e.user_id = p_user_id and e.source_type = p_source_type
    and e.source_connection_id is not distinct from p_source_connection_id
    and e.external_event_id = v_ext_event;
  if found then
    return query select v_event.id, v_event.processing_status, v_event.review_reason,
      case when v_event.resulting_transfer_id is not null then 'transfer'
           when v_event.resulting_transaction_id is not null then
             (select t.type from public.transactions t where t.id = v_event.resulting_transaction_id) end,
      coalesce(v_event.resulting_transaction_id, v_event.resulting_transfer_id),
      true;
    return;
  end if;

  -- Resolve what the importer suggested — only the user's own active things.
  select a.* into v_account from public.accounts a
  where a.id = p_account_id and a.user_id = p_user_id and a.status = 'active'
    and a.currency = coalesce(v_currency, 'INR');
  select a.id into v_destination from public.accounts a
  where a.id = p_destination_account_id and a.user_id = p_user_id and a.status = 'active'
    and a.currency = coalesce(v_currency, 'INR') and a.id is distinct from v_account.id;
  select c.id into v_category from public.categories c
  where c.id = p_category_id and c.user_id = p_user_id and not c.is_archived
    and c.transaction_type = case v_kind when 'income' then 'income' when 'expense' then 'expense' when 'refund' then 'expense' end;

  insert into public.source_events (
    user_id, source_type, source_connection_id, external_event_id, external_transaction_id,
    payload_fingerprint, parsed_at, processing_status, confidence,
    parsed_kind, parsed_amount_minor, parsed_currency, parsed_occurred_at, parsed_merchant,
    parsed_account_hint, parsed_entry_status,
    suggested_account_id, suggested_destination_account_id, suggested_category_id)
  values (
    p_user_id, p_source_type, p_source_connection_id, v_ext_event, v_ext_tx,
    v_fingerprint, now(), 'parsed', p_confidence,
    v_kind, case when v_amount_ok then p_amount_minor end,
    case when v_currency ~ '^[A-Z]{3}$' then v_currency end, p_occurred_at, v_merchant,
    v_hint, v_state,
    v_account.id, v_destination, v_category)
  returning * into v_event;

  -- Evidence sharing a stable transaction id (within this source and
  -- connection) is about the same real transaction.
  if v_ext_tx is not null then
    select * into v_prior from public.source_events e
    where e.user_id = p_user_id and e.source_type = p_source_type
      and e.source_connection_id is not distinct from p_source_connection_id
      and e.external_transaction_id = v_ext_tx
      and e.id <> v_event.id
      and e.link_type is not null
    order by e.received_at
    limit 1;

    if found then
      if v_prior.resulting_transaction_id is not null then
        select * into v_tx from public.transactions t
        where t.id = v_prior.resulting_transaction_id and t.user_id = p_user_id for update;
        v_match_kind := 'transaction';
        v_match_id := v_tx.id;
        if v_tx.deleted_at is not null or v_tx.status = 'voided' then
          v_reason := 'linked_entry_removed';
        elsif v_kind is null then
          -- Without its direction, evidence can't safely change an entry.
          v_reason := 'missing_details';
        elsif v_kind <> v_tx.type then
          -- Same id, opposite direction: a credit-back or refund of it.
          v_reason := 'needs_link';
        elsif coalesce(v_currency, v_tx.currency) <> v_tx.currency then
          v_reason := 'unsupported_currency';
        elsif v_account.id is not null and v_account.id <> v_tx.account_id then
          v_reason := 'possible_duplicate';
        elsif v_state in ('cancelled', 'declined') then
          if v_tx.status = 'pending' then
            perform public.set_change_reason('Cancelled, per ' || replace(p_source_type, '_', ' '));
            update public.transactions set status = 'voided' where id = v_tx.id;
          elsif v_tx.status = 'posted' then
            v_reason := 'needs_link';
          end if;
        elsif v_state = 'posted' and v_tx.status = 'pending' then
          if v_amount_ok and abs(p_amount_minor - v_tx.amount_minor) * 4 > v_tx.amount_minor then
            v_reason := 'settlement_differs';
          else
            perform public.set_change_reason('Posted, per ' || replace(p_source_type, '_', ' '));
            update public.transactions set
              status = 'posted',
              amount_minor = case when v_amount_ok then p_amount_minor else amount_minor end
            where id = v_tx.id;
          end if;
        elsif v_amount_ok and p_amount_minor <> v_tx.amount_minor then
          v_reason := 'possible_duplicate';
        end if;
      else
        select * into v_tr from public.transfers x
        where x.id = v_prior.resulting_transfer_id and x.user_id = p_user_id for update;
        v_match_kind := 'transfer';
        v_match_id := v_tr.id;
        if v_tr.deleted_at is not null or v_tr.status = 'voided' then
          v_reason := 'linked_entry_removed';
        elsif v_kind is null then
          v_reason := 'missing_details';
        elsif v_kind <> 'transfer' then
          v_reason := 'needs_link';
        elsif (v_account.id is not null and v_account.id <> v_tr.source_account_id)
           or (v_destination is not null and v_destination <> v_tr.destination_account_id) then
          -- Same reference, other direction or accounts: money coming back, not a settlement.
          v_reason := 'needs_link';
        elsif coalesce(v_currency, v_tr.currency) <> v_tr.currency then
          v_reason := 'unsupported_currency';
        elsif v_state in ('cancelled', 'declined') then
          if v_tr.status = 'pending' then
            perform public.set_change_reason('Cancelled, per ' || replace(p_source_type, '_', ' '));
            update public.transfers set status = 'voided' where id = v_tr.id;
          elsif v_tr.status = 'posted' then
            v_reason := 'needs_link';
          end if;
        elsif v_state = 'posted' and v_tr.status = 'pending' then
          if v_amount_ok and abs(p_amount_minor - v_tr.amount_minor) * 4 > v_tr.amount_minor then
            v_reason := 'settlement_differs';
          else
            perform public.set_change_reason('Posted, per ' || replace(p_source_type, '_', ' '));
            update public.transfers set
              status = 'posted',
              amount_minor = case when v_amount_ok then p_amount_minor else amount_minor end
            where id = v_tr.id;
          end if;
        elsif v_amount_ok and p_amount_minor <> v_tr.amount_minor then
          v_reason := 'possible_duplicate';
        end if;
      end if;

      if v_reason is not null then
        update public.source_events set processing_status = 'needs_review', review_reason = v_reason,
          suggested_match_kind = v_match_kind, suggested_match_id = v_match_id
        where id = v_event.id returning * into v_event;
        return query select v_event.id, v_event.processing_status, v_event.review_reason, null::text, null::uuid, false;
        return;
      end if;
      update public.source_events set processing_status = 'imported', link_type = 'matched',
        resulting_transaction_id = case when v_match_kind = 'transaction' then v_match_id end,
        resulting_transfer_id = case when v_match_kind = 'transfer' then v_match_id end,
        linked_at = now()
      where id = v_event.id returning * into v_event;
      return query select v_event.id, v_event.processing_status, null::text,
        case when v_match_kind = 'transfer' then 'transfer' else v_tx.type end, v_match_id, false;
      return;
    end if;

    -- The same transaction is already waiting for review, or was ignored:
    -- keep the decision with the person.
    if exists (
      select 1 from public.source_events e
      where e.user_id = p_user_id and e.source_type = p_source_type
        and e.source_connection_id is not distinct from p_source_connection_id
        and e.external_transaction_id = v_ext_tx
        and e.id <> v_event.id
        and e.processing_status in ('needs_review', 'ignored')
    ) then
      v_reason := 'possible_duplicate';
    end if;
  end if;

  -- A cancellation or decline with nothing pending to cancel changes nothing.
  if v_reason is null and v_state in ('cancelled', 'declined') then
    update public.source_events set processing_status = 'ignored', error_code = 'nothing_to_cancel'
    where id = v_event.id returning * into v_event;
    return query select v_event.id, v_event.processing_status, null::text, null::text, null::uuid, false;
    return;
  end if;

  -- Anything uncertain waits for the person. No ledger entry is created.
  if v_reason is not null then
    null;
  elsif v_kind is null or not v_amount_ok or p_occurred_at is null then
    v_reason := 'missing_details';
  elsif v_currency is null or v_currency <> 'INR' then
    v_reason := 'unsupported_currency';
  elsif v_kind in ('refund', 'reversal') then
    v_reason := 'needs_link';
  elsif v_account.id is null or (v_kind = 'transfer' and v_destination is null) then
    v_reason := 'unknown_account';
  elsif v_kind = 'income' and v_account.type = 'credit_card' then
    -- Money "received" on a card is almost always a bill payment (a transfer).
    v_reason := 'possible_transfer';
  elsif (p_occurred_at at time zone coalesce((select timezone from public.profiles where id = p_user_id), 'UTC'))::date
        < v_account.opening_date then
    -- Already inside the opening balance the person entered.
    v_reason := 'before_tracking_start';
  elsif p_confidence is null or p_confidence < 0.9 then
    v_reason := 'low_confidence';
  elsif v_fingerprint is not null and exists (
    select 1 from public.source_events e
    where e.user_id = p_user_id and e.payload_fingerprint = v_fingerprint and e.id <> v_event.id
  ) then
    v_reason := 'possible_duplicate';
  end if;

  -- Lookalikes are never merged automatically (two real purchases can look
  -- identical): same account, amount and direction within 3 days; a pending
  -- entry this could be the settlement of; or evidence already in review.
  if v_reason is null and v_kind in ('expense', 'income') then
    select t.id into v_match_id from public.transactions t
    where t.user_id = p_user_id and t.account_id = v_account.id and t.type = v_kind
      and t.deleted_at is null and t.status <> 'voided'
      and (
        (t.amount_minor = p_amount_minor
         and t.occurred_at between p_occurred_at - interval '3 days' and p_occurred_at + interval '3 days')
        or (v_state = 'posted' and t.status = 'pending'
            and abs(t.amount_minor - p_amount_minor) * 2 <= t.amount_minor
            and t.occurred_at between p_occurred_at - interval '7 days' and p_occurred_at + interval '1 day')
      )
      and not exists (
        select 1 from public.source_events e
        where e.resulting_transaction_id = t.id and e.user_id = p_user_id
          and e.source_type = p_source_type
          and e.source_connection_id is not distinct from p_source_connection_id
          and e.external_transaction_id is not null and v_ext_tx is not null
          and e.external_transaction_id <> v_ext_tx
      )
    order by abs(extract(epoch from t.occurred_at - p_occurred_at))
    limit 1;
    if v_match_id is not null then
      v_match_kind := 'transaction';
      v_reason := 'possible_duplicate';
    end if;
  elsif v_reason is null and v_kind = 'transfer' then
    select x.id into v_match_id from public.transfers x
    where x.user_id = p_user_id and x.source_account_id = v_account.id and x.destination_account_id = v_destination
      and x.amount_minor = p_amount_minor and x.deleted_at is null and x.status <> 'voided'
      and x.occurred_at between p_occurred_at - interval '3 days' and p_occurred_at + interval '3 days'
    order by abs(extract(epoch from x.occurred_at - p_occurred_at))
    limit 1;
    if v_match_id is not null then
      v_match_kind := 'transfer';
      v_reason := 'possible_duplicate';
    end if;
  end if;
  if v_reason is null and exists (
    select 1 from public.source_events e
    where e.user_id = p_user_id and e.id <> v_event.id
      and e.processing_status = 'needs_review'
      and e.parsed_kind = v_kind and e.parsed_amount_minor = p_amount_minor
      and e.suggested_account_id is not distinct from v_account.id
      and e.parsed_occurred_at between p_occurred_at - interval '3 days' and p_occurred_at + interval '3 days'
  ) then
    v_reason := 'possible_duplicate';
  end if;

  if v_reason is not null then
    update public.source_events set processing_status = 'needs_review', review_reason = v_reason,
      suggested_match_kind = v_match_kind, suggested_match_id = v_match_id
    where id = v_event.id returning * into v_event;
    return query select v_event.id, v_event.processing_status, v_event.review_reason, null::text, null::uuid, false;
    return;
  end if;

  -- Confident, complete and not a lookalike: record it once. The event id is
  -- the idempotency key, so this entry can never be created twice. If the
  -- ledger refuses it, only the entry is rolled back: the evidence stays, in
  -- the review queue, with the reason.
  begin
    if v_kind = 'transfer' then
      insert into public.transfers (
        user_id, source_account_id, destination_account_id, amount_minor, occurred_at,
        idempotency_key, created_via, status, source_type, source_confidence)
      values (
        p_user_id, v_account.id, v_destination, p_amount_minor, p_occurred_at,
        v_event.id, 'import', v_state, p_source_type, p_confidence)
      returning * into v_tr;
      update public.source_events set processing_status = 'imported', link_type = 'created',
        resulting_transfer_id = v_tr.id, linked_at = now()
      where id = v_event.id returning * into v_event;
      return query select v_event.id, v_event.processing_status, null::text, 'transfer'::text, v_tr.id, false;
    else
      insert into public.transactions (
        user_id, account_id, type, amount_minor, category_id, occurred_at, merchant,
        idempotency_key, created_via, status, source_type, source_confidence)
      values (
        p_user_id, v_account.id, v_kind, p_amount_minor, v_category, p_occurred_at, v_merchant,
        v_event.id, 'import', v_state, p_source_type, p_confidence)
      returning * into v_tx;
      update public.source_events set processing_status = 'imported', link_type = 'created',
        resulting_transaction_id = v_tx.id, linked_at = now()
      where id = v_event.id returning * into v_event;
      return query select v_event.id, v_event.processing_status, null::text, v_tx.type, v_tx.id, false;
    end if;
  exception when others then
    get stacked diagnostics v_error = returned_sqlstate;
    update public.source_events set processing_status = 'needs_review', review_reason = 'missing_details',
      error_code = 'ledger_' || v_error
    where id = v_event.id returning * into v_event;
    return query select v_event.id, v_event.processing_status, v_event.review_reason, null::text, null::uuid, false;
  end;
end;
$$;

-- Signed-in users can submit evidence about their own money (tests, future
-- file imports). Same rules as the service path.
create or replace function public.submit_source_event(
  p_source_type text,
  p_external_event_id text,
  p_external_transaction_id text default null,
  p_payload_fingerprint text default null,
  p_kind text default null,
  p_amount_minor bigint default null,
  p_currency text default 'INR',
  p_occurred_at timestamptz default null,
  p_merchant text default null,
  p_account_hint text default null,
  p_account_id uuid default null,
  p_destination_account_id uuid default null,
  p_category_id uuid default null,
  p_entry_status text default 'posted',
  p_confidence numeric default null
)
returns table (
  event_id uuid,
  processing_status text,
  review_reason text,
  entry_kind text,
  entry_id uuid,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  perform pg_catalog.set_config('friday.ingest_caller', 'submit', true);
  return query select * from public.ingest_source_event_for(
    auth.uid(), p_source_type, p_external_event_id, null, p_external_transaction_id,
    p_payload_fingerprint, p_kind, p_amount_minor, p_currency, p_occurred_at, p_merchant,
    p_account_hint, p_account_id, p_destination_account_id, p_category_id, p_entry_status, p_confidence);
  perform pg_catalog.set_config('friday.ingest_caller', '', true);
end;
$$;

-- Review queue: confirm (optionally corrected) → exactly one ledger entry.
-- Re-confirming returns the entry already created.
create or replace function public.confirm_source_event(
  p_event_id uuid,
  p_kind text,
  p_amount_minor bigint,
  p_account_id uuid,
  p_destination_account_id uuid default null,
  p_category_id uuid default null,
  p_occurred_at timestamptz default null,
  p_merchant text default null,
  p_note text default null,
  p_related_transaction_id uuid default null,
  p_status text default 'posted'
)
returns table (kind text, id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_event public.source_events%rowtype;
  v_saved record;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  perform public.lock_user_imports(v_uid);

  select * into v_event from public.source_events e
  where e.id = p_event_id and e.user_id = v_uid
  for update;
  if not found then
    raise exception 'That item is no longer in your review queue' using errcode = 'P0002';
  end if;

  if v_event.resulting_transfer_id is not null then
    return query select 'transfer'::text, v_event.resulting_transfer_id;
    return;
  elsif v_event.resulting_transaction_id is not null then
    return query select t.type, t.id from public.transactions t where t.id = v_event.resulting_transaction_id;
    return;
  end if;

  if p_status is null or p_status not in ('posted', 'pending') then
    raise exception 'Confirmed entries are posted or pending' using errcode = '22023';
  end if;

  -- Other evidence for the same transaction already led to an entry: confirming
  -- this as a new purchase or income would count it twice. Money coming back
  -- for it (a refund or reversal of an entry) is a different entry and allowed.
  if v_event.external_transaction_id is not null
     and not (p_kind in ('refund', 'reversal') and p_related_transaction_id is not null)
     and exists (
    select 1 from public.source_events e
    left join public.transactions t on t.id = e.resulting_transaction_id
    left join public.transfers x on x.id = e.resulting_transfer_id
    where e.user_id = v_uid and e.id <> v_event.id
      and e.source_type = v_event.source_type
      and e.source_connection_id is not distinct from v_event.source_connection_id
      and e.external_transaction_id = v_event.external_transaction_id
      and e.link_type is not null
      and coalesce(t.deleted_at, x.deleted_at) is null
      and coalesce(t.status, x.status) <> 'voided'
  ) then
    raise exception 'This is the same transaction as an entry you already have. Use “Same as an existing entry” instead.'
      using errcode = '22023';
  end if;

  select * into v_saved from public.record_entry(
    p_idempotency_key => v_event.id,
    p_kind => p_kind,
    p_amount_minor => p_amount_minor,
    p_account_id => p_account_id,
    p_destination_account_id => p_destination_account_id,
    p_category_id => p_category_id,
    p_occurred_at => coalesce(p_occurred_at, v_event.parsed_occurred_at),
    p_note => p_note,
    p_merchant => p_merchant,
    p_created_via => 'import',
    p_related_transaction_id => p_related_transaction_id,
    p_status => p_status,
    p_source_type => v_event.source_type,
    p_source_confidence => v_event.confidence
  );

  update public.source_events set
    processing_status = 'imported',
    link_type = 'created',
    resulting_transaction_id = case when v_saved.kind <> 'transfer' then v_saved.id end,
    resulting_transfer_id = case when v_saved.kind = 'transfer' then v_saved.id end,
    linked_at = now(),
    review_reason = null
  where id = v_event.id;

  return query select v_saved.kind, v_saved.id;
end;
$$;

-- Review queue: this evidence is about an entry that already exists (the
-- same transaction). To record money coming back for a purchase, confirm the
-- event as a refund of it instead.
create or replace function public.link_source_event(p_event_id uuid, p_entry_kind text, p_entry_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_event public.source_events%rowtype;
  v_status text;
  v_deleted timestamptz;
  v_type text;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  perform public.lock_user_imports(v_uid);

  select * into v_event from public.source_events e
  where e.id = p_event_id and e.user_id = v_uid
  for update;
  if not found then
    raise exception 'That item is no longer in your review queue' using errcode = 'P0002';
  end if;

  if (p_entry_kind = 'transfer' and v_event.resulting_transfer_id = p_entry_id)
     or (p_entry_kind <> 'transfer' and v_event.resulting_transaction_id = p_entry_id) then
    return;
  end if;
  if v_event.link_type is not null then
    raise exception 'This item is already linked to another entry' using errcode = '22023';
  end if;
  if v_event.parsed_kind is not null and v_event.parsed_kind <> p_entry_kind then
    raise exception 'That entry is a %, but this looks like a %. To record money back for a purchase, confirm it as a refund instead.',
      replace(p_entry_kind, '_', ' '), replace(v_event.parsed_kind, '_', ' ') using errcode = '22023';
  end if;

  if p_entry_kind = 'transfer' then
    select status, deleted_at, 'transfer' into v_status, v_deleted, v_type from public.transfers
    where id = p_entry_id and user_id = v_uid for update;
  elsif p_entry_kind in ('income', 'expense', 'refund', 'reversal') then
    select status, deleted_at, type into v_status, v_deleted, v_type from public.transactions
    where id = p_entry_id and user_id = v_uid for update;
  else
    raise exception 'Choose an entry to link' using errcode = '22023';
  end if;
  if not found or v_deleted is not null then
    raise exception 'That entry no longer exists' using errcode = 'P0002';
  end if;
  -- Check against the entry itself, not the kind the caller named.
  if v_type <> p_entry_kind then
    raise exception 'That entry''s type is %, not %', v_type, p_entry_kind
      using errcode = '22023';
  end if;
  if v_status = 'voided' then
    raise exception 'That entry was voided. Restore it first, or confirm this as a new entry.' using errcode = '22023';
  end if;

  -- Settlement evidence for something still pending moves it to posted, at
  -- the settled amount when the evidence has one in the entry's currency.
  if v_event.parsed_entry_status = 'posted' and v_status = 'pending' then
    perform public.set_change_reason('Posted, per ' || replace(v_event.source_type, '_', ' '));
    if p_entry_kind = 'transfer' then
      update public.transfers set
        status = 'posted',
        amount_minor = case when v_event.parsed_currency is not distinct from currency or v_event.parsed_currency is null
                            then coalesce(v_event.parsed_amount_minor, amount_minor) else amount_minor end
      where id = p_entry_id;
    else
      update public.transactions set
        status = 'posted',
        amount_minor = case when v_event.parsed_currency is not distinct from currency or v_event.parsed_currency is null
                            then coalesce(v_event.parsed_amount_minor, amount_minor) else amount_minor end
      where id = p_entry_id;
    end if;
  end if;

  update public.source_events set
    processing_status = 'imported',
    link_type = 'matched',
    resulting_transaction_id = case when p_entry_kind <> 'transfer' then p_entry_id end,
    resulting_transfer_id = case when p_entry_kind = 'transfer' then p_entry_id end,
    linked_at = now(),
    review_reason = null
  where id = v_event.id;
end;
$$;

-- Review queue: not a transaction (a promo, a duplicate notification).
create or replace function public.ignore_source_event(p_event_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_event public.source_events%rowtype;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  perform public.lock_user_imports(v_uid);

  select * into v_event from public.source_events e
  where e.id = p_event_id and e.user_id = v_uid
  for update;
  if not found then
    raise exception 'That item is no longer in your review queue' using errcode = 'P0002';
  end if;
  if v_event.link_type is not null then
    raise exception 'This item is already recorded. Delete the entry instead.' using errcode = '22023';
  end if;

  update public.source_events set processing_status = 'ignored' where id = v_event.id;
end;
$$;

-- -----------------------------------------------------------------------------
-- New users no longer get an income category called "Refunds": a refund
-- reduces spending and is recorded against the purchase. Existing categories
-- are left as they are.
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
    ('Gifts received',    'income',  'gift',            'pink',   50),
    ('Other income',      'income',  'shapes',          'peach',  900)
  ) as d (name, transaction_type, icon, color, sort_order)
  where not exists (
    select 1 from public.categories c
    where c.user_id = p_user_id and c.is_default
  );
$$;

-- Visible and reversible (Categories → Show archived → Restore). Only the
-- untouched seeded default; a renamed or custom category is left alone.
update public.categories c
set is_archived = true
where current_setting('friday.m0003_first_run', true) = 'true'
  and c.is_default
  and c.transaction_type = 'income'
  and c.name = 'Refunds'
  and not c.is_archived
  -- A recurring item still using it would stop being confirmable.
  and not exists (select 1 from public.recurring_rules r where r.category_id = c.id);

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

revoke all on public.account_balances, public.ledger_entries, public.reporting_entries from anon, authenticated, public;
grant select on public.account_balances, public.ledger_entries, public.reporting_entries to authenticated;

revoke execute on function
  public.ledger_status_change_allowed(text, text),
  public.format_minor(bigint),
  public.lock_user_imports(uuid),
  public.validate_transaction(),
  public.validate_transfer(),
  public.sync_linked_entries(),
  public.ledger_facts(jsonb),
  public.audit_ledger_change(),
  public.set_change_reason(text),
  public.period_summary(timestamptz, timestamptz),
  public.category_breakdown(timestamptz, timestamptz, text),
  public.cashflow_trend(timestamptz, timestamptz, text),
  public.account_activity(timestamptz, timestamptz),
  public.ledger_attention(),
  public.record_entry(uuid, text, bigint, uuid, uuid, uuid, timestamptz, text, text, text, uuid, text, text, numeric),
  public.update_entry(text, uuid, timestamptz, text, bigint, uuid, uuid, uuid, timestamptz, text, text, text),
  public.set_entry_voided(text, uuid, boolean),
  public.set_entry_status(text, uuid, text, text, timestamptz),
  public.set_entry_deleted(text, uuid, boolean),
  public.make_refund(uuid, uuid, uuid, timestamptz, text),
  public.ingest_source_event_for(uuid, text, text, uuid, text, text, text, bigint, text, timestamptz, text, text, uuid, uuid, uuid, text, numeric),
  public.submit_source_event(text, text, text, text, text, bigint, text, timestamptz, text, text, uuid, uuid, uuid, text, numeric),
  public.confirm_source_event(uuid, text, bigint, uuid, uuid, uuid, timestamptz, text, text, uuid, text),
  public.link_source_event(uuid, text, uuid),
  public.ignore_source_event(uuid),
  public.seed_default_categories(uuid),
  public.delete_all_my_data()
  from public, anon;

-- Internal helpers stay off the API for signed-in users too.
revoke execute on function
  public.lock_user_imports(uuid),
  public.validate_transaction(),
  public.validate_transfer(),
  public.sync_linked_entries(),
  public.audit_ledger_change(),
  public.ingest_source_event_for(uuid, text, text, uuid, text, text, text, bigint, text, timestamptz, text, text, uuid, uuid, uuid, text, numeric),
  public.seed_default_categories(uuid)
  from authenticated;

grant execute on function
  public.ledger_status_change_allowed(text, text),
  public.format_minor(bigint),
  public.ledger_facts(jsonb),
  public.set_change_reason(text),
  public.period_summary(timestamptz, timestamptz),
  public.category_breakdown(timestamptz, timestamptz, text),
  public.cashflow_trend(timestamptz, timestamptz, text),
  public.account_activity(timestamptz, timestamptz),
  public.ledger_attention(),
  public.record_entry(uuid, text, bigint, uuid, uuid, uuid, timestamptz, text, text, text, uuid, text, text, numeric),
  public.update_entry(text, uuid, timestamptz, text, bigint, uuid, uuid, uuid, timestamptz, text, text, text),
  public.set_entry_voided(text, uuid, boolean),
  public.set_entry_status(text, uuid, text, text, timestamptz),
  public.set_entry_deleted(text, uuid, boolean),
  public.make_refund(uuid, uuid, uuid, timestamptz, text),
  public.submit_source_event(text, text, text, text, text, bigint, text, timestamptz, text, text, uuid, uuid, uuid, text, numeric),
  public.confirm_source_event(uuid, text, bigint, uuid, uuid, uuid, timestamptz, text, text, uuid, text),
  public.link_source_event(uuid, text, uuid),
  public.ignore_source_event(uuid),
  public.delete_all_my_data()
  to authenticated;

-- The future ingestion worker runs as the service role.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function
      public.ingest_source_event_for(uuid, text, text, uuid, text, text, text, bigint, text, timestamptz, text, text, uuid, uuid, uuid, text, numeric)
      to service_role;
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Safety checks: fail the migration rather than ship an exposed definer
-- function or a view that bypasses row-level security.
-- -----------------------------------------------------------------------------

do $$
declare
  v_fn text;
  v_view text;
begin
  foreach v_fn in array array[
    'public.ingest_source_event_for(uuid, text, text, uuid, text, text, text, bigint, text, timestamptz, text, text, uuid, uuid, uuid, text, numeric)',
    'public.lock_user_imports(uuid)',
    'public.audit_ledger_change()'
  ] loop
    if has_function_privilege('anon', v_fn, 'execute') or has_function_privilege('authenticated', v_fn, 'execute') then
      raise exception 'Migration check failed: % must not be callable by anon or authenticated', v_fn;
    end if;
  end loop;

  for v_view in
    select c.relname from pg_catalog.pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
      and not coalesce(c.reloptions @> array['security_invoker=true'], false)
  loop
    raise exception 'Migration check failed: view public.% must use security_invoker', v_view;
  end loop;

  if has_table_privilege('anon', 'public.source_events', 'select')
     or has_table_privilege('authenticated', 'public.source_events', 'insert')
     or has_table_privilege('authenticated', 'public.source_events', 'update') then
    raise exception 'Migration check failed: source_events must be read-only to clients';
  end if;
end
$$;

-- Have the API pick up the new columns and functions straight away.
notify pgrst, 'reload schema';
