-- =============================================================================
-- Friday 0002 — capture service
--
-- Adds what fast, safe transaction capture needs, on top of 0001:
--   * merchant, idempotency_key and created_via on transactions/transfers
--   * a user-configured default account on profiles
--   * ledger_audit: an append-only trail of every create/update/void/restore
--   * record_entry():      the one write path for new entries; idempotent
--   * update_entry():      edits with optimistic concurrency (no lost updates)
--   * set_entry_voided():  void / restore (Undo), idempotent
--
-- Additive only: existing rows keep their values. Safe to re-run.
-- Balances stay derived from the ledger (account_balances), so no write here
-- can apply a balance change twice.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Columns, constraints, indexes
-- -----------------------------------------------------------------------------

alter table public.transactions
  add column if not exists merchant text,
  add column if not exists idempotency_key uuid,
  add column if not exists created_via text not null default 'manual';

alter table public.transfers
  add column if not exists idempotency_key uuid,
  add column if not exists created_via text not null default 'manual';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'transactions_merchant_length') then
    alter table public.transactions add constraint transactions_merchant_length
      check (merchant is null or char_length(btrim(merchant)) between 1 and 120);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'transactions_created_via_check') then
    alter table public.transactions add constraint transactions_created_via_check
      check (created_via in ('manual', 'quick_add', 'recurring', 'import'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'transfers_created_via_check') then
    alter table public.transfers add constraint transfers_created_via_check
      check (created_via in ('manual', 'quick_add', 'recurring', 'import'));
  end if;
end
$$;

-- One committed entry per (user, request key). Old rows have no key.
create unique index if not exists transactions_idempotency_unique
  on public.transactions (user_id, idempotency_key) where idempotency_key is not null;
create unique index if not exists transfers_idempotency_unique
  on public.transfers (user_id, idempotency_key) where idempotency_key is not null;

-- Category suggestions look up a user's history by merchant.
create index if not exists transactions_user_merchant_idx
  on public.transactions (user_id, lower(merchant))
  where merchant is not null and deleted_at is null;

alter table public.profiles
  add column if not exists default_account_id uuid references public.accounts (id) on delete set null;

-- The default account must be one of the user's own active accounts.
create or replace function public.validate_profile()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'Unknown timezone: %', new.timezone using errcode = '22023';
  end if;
  if new.default_account_id is not null
     and (tg_op = 'INSERT' or new.default_account_id is distinct from old.default_account_id)
     and not exists (
       select 1 from public.accounts a
       where a.id = new.default_account_id and a.user_id = new.id and a.status = 'active'
     ) then
    raise exception 'Choose one of your active accounts as the default' using errcode = '22023';
  end if;
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Audit trail
-- -----------------------------------------------------------------------------

create table if not exists public.ledger_audit (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references auth.users (id) on delete cascade,
  entity         text not null check (entity in ('transaction', 'transfer')),
  entity_id      uuid not null,
  action         text not null check (action in ('create', 'update', 'void', 'restore')),
  changed_fields text[] not null default '{}',
  -- Financial facts only. Note and merchant text are never copied here.
  snapshot       jsonb not null,
  created_at     timestamptz not null default now()
);

create index if not exists ledger_audit_entity_idx
  on public.ledger_audit (user_id, entity, entity_id, id);

alter table public.ledger_audit enable row level security;
drop policy if exists ledger_audit_select_own on public.ledger_audit;
create policy ledger_audit_select_own on public.ledger_audit
  for select to authenticated using (user_id = (select auth.uid()));

revoke all on public.ledger_audit from anon, authenticated, public;
grant select on public.ledger_audit to authenticated;

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
                           'source_account_id', 'destination_account_id', 'occurred_at', 'note', 'merchant'];
  v_changed text[] := '{}';
  v_action text;
  v_field text;
begin
  if tg_op = 'INSERT' then
    v_action := 'create';
  elsif old.deleted_at is null and new.deleted_at is not null then
    v_action := 'void';
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
    v_action := 'update';
  end if;

  insert into public.ledger_audit (user_id, entity, entity_id, action, changed_fields, snapshot)
  values (
    new.user_id, v_entity, new.id, v_action, v_changed,
    jsonb_strip_nulls(jsonb_build_object(
      'type', v_new ->> 'type',
      'amount_minor', (v_new ->> 'amount_minor')::bigint,
      'currency', v_new ->> 'currency',
      'account_id', v_new ->> 'account_id',
      'category_id', v_new ->> 'category_id',
      'source_account_id', v_new ->> 'source_account_id',
      'destination_account_id', v_new ->> 'destination_account_id',
      'occurred_at', v_new ->> 'occurred_at',
      'has_note', (v_new ->> 'note') is not null,
      'has_merchant', (v_new ->> 'merchant') is not null,
      'created_via', v_new ->> 'created_via'
    ))
  );
  return null;
end;
$$;

drop trigger if exists transactions_audit on public.transactions;
create trigger transactions_audit after insert or update on public.transactions
  for each row execute function public.audit_ledger_change();
drop trigger if exists transfers_audit on public.transfers;
create trigger transfers_audit after insert or update on public.transfers
  for each row execute function public.audit_ledger_change();

-- -----------------------------------------------------------------------------
-- Feed view: adds merchant (columns can only be appended)
-- -----------------------------------------------------------------------------

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
  t.merchant
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
  null::text
from public.transfers x
where x.deleted_at is null;

-- -----------------------------------------------------------------------------
-- record_entry: the single write path for new income, expenses and transfers.
--
-- Idempotent per (user, p_idempotency_key): a retry after a lost response, a
-- double tap or two devices replaying the same request all return the entry
-- that was committed first, with created = false. matches = false means the
-- key was already used for different financial details, so the caller must
-- not assume its new values were saved.
-- -----------------------------------------------------------------------------

create or replace function public.record_entry(
  p_idempotency_key uuid,
  p_kind text,
  p_amount_minor bigint,
  p_account_id uuid,
  p_destination_account_id uuid default null,
  p_category_id uuid default null,
  p_occurred_at timestamptz default null,
  p_note text default null,
  p_merchant text default null,
  p_created_via text default 'quick_add'
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
  if p_kind is null or p_kind not in ('income', 'expense', 'transfer') then
    raise exception 'Choose expense, income or transfer' using errcode = '22023';
  end if;
  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'Amount must be more than zero' using errcode = '22023';
  end if;
  if p_account_id is null then
    raise exception 'Choose an account' using errcode = '22023';
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
        and p_category_id is not distinct from v_tx.category_id,
      v_tx.deleted_at is not null,
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
      v_tr.deleted_at is not null,
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
      occurred_at, note, idempotency_key, created_via)
    values (
      v_uid, p_account_id, p_destination_account_id, p_amount_minor,
      coalesce(p_occurred_at, now()), v_note, p_idempotency_key, p_created_via)
    returning * into v_tr;
    return query select 'transfer'::text, v_tr.id, true, true, false, v_tr.updated_at;
  else
    insert into public.transactions (
      user_id, account_id, type, amount_minor, category_id,
      occurred_at, note, merchant, idempotency_key, created_via)
    values (
      v_uid, p_account_id, p_kind, p_amount_minor, p_category_id,
      coalesce(p_occurred_at, now()), v_note, v_merchant, p_idempotency_key, p_created_via)
    returning * into v_tx;
    return query select v_tx.type, v_tx.id, true, true, false, v_tx.updated_at;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- update_entry: edit with optimistic concurrency. Pass the updated_at you
-- loaded; if the entry changed since (another tab or device), nothing is
-- written and the caller is told to reload. The error uses PostgREST's custom
-- code PT409 (HTTP 409). Not 40001: PostgREST retries serialization failures,
-- so a deliberate conflict raised as 40001 would retry forever.
-- -----------------------------------------------------------------------------

create or replace function public.update_entry(
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
  p_merchant text default null
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
  elsif p_kind in ('income', 'expense') and p_new_kind in ('income', 'expense') then
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
    update public.transactions set
      type = p_new_kind,
      account_id = p_account_id,
      amount_minor = p_amount_minor,
      category_id = p_category_id,
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

-- -----------------------------------------------------------------------------
-- set_entry_voided: Undo / delete (void) and restore. Idempotent: voiding a
-- voided entry or restoring a live one changes nothing.
-- -----------------------------------------------------------------------------

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
  elsif p_kind in ('income', 'expense') then
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

-- -----------------------------------------------------------------------------
-- Recurring confirmations now say where they came from; data deletion also
-- clears the audit trail.
-- -----------------------------------------------------------------------------

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

  insert into public.transactions (user_id, account_id, type, amount_minor, category_id, occurred_at, note, created_via)
  values (
    v_rule.user_id,
    coalesce(p_account_id, v_rule.account_id),
    v_rule.type,
    coalesce(p_amount_minor, v_rule.amount_minor),
    case when p_category_id is not null then p_category_id else v_rule.category_id end,
    coalesce(p_occurred_at, now()),
    coalesce(p_note, v_rule.note, v_rule.name),
    'recurring'
  )
  returning id into v_transaction_id;

  update public.recurring_occurrences
  set status = 'confirmed', transaction_id = v_transaction_id, resolved_at = now()
  where id = v_occurrence.id;

  return v_transaction_id;
end;
$$;

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
  public.audit_ledger_change(),
  public.record_entry(uuid, text, bigint, uuid, uuid, uuid, timestamptz, text, text, text),
  public.update_entry(text, uuid, timestamptz, text, bigint, uuid, uuid, uuid, timestamptz, text, text),
  public.set_entry_voided(text, uuid, boolean)
  from public, anon;

revoke execute on function public.audit_ledger_change() from authenticated;

grant execute on function
  public.record_entry(uuid, text, bigint, uuid, uuid, uuid, timestamptz, text, text, text),
  public.update_entry(text, uuid, timestamptz, text, bigint, uuid, uuid, uuid, timestamptz, text, text),
  public.set_entry_voided(text, uuid, boolean)
  to authenticated;
