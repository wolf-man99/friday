-- =============================================================================
-- Friday 0006 — Gmail import: every transaction is recorded or reviewed
--
-- Builds on 0005. An email that looks like a transaction but couldn't be read
-- completely (no clear debit/credit, or no amount Friday could read) is no
-- longer dropped: it's kept with what was read and goes to the review queue,
-- where the person fills in the rest and records it, or ignores it.
--   * gmail_import_items: a read email needs only its bank and date; the
--     direction and amount may be unknown (the import boundary then asks)
--   * gmail_import_jobs: honest counts — declined (no money moved), failed
--     (couldn't be imported at all) and why emails were left out
--     (skip_reasons: OTPs, statements, offers, notices…)
--   * gmail_import_run: if recording an email fails, it's sent to review with
--     the facts the boundary accepts instead of being lost
--
-- Additive and re-runnable. Run after 0005. Nothing here changes a balance.
-- =============================================================================

alter table friday_private.gmail_import_items drop constraint if exists gmail_import_items_parsed_complete;
alter table friday_private.gmail_import_items add constraint gmail_import_items_parsed_complete
  check (state <> 'parsed' or (institution_key is not null and occurred_at is not null));

alter table public.gmail_import_jobs add column if not exists declined integer not null default 0;
alter table public.gmail_import_jobs add column if not exists failed integer not null default 0;
alter table public.gmail_import_jobs add column if not exists skip_reasons jsonb not null default '{}'::jsonb;

-- Results for a batch of emails: each one's facts, or why it isn't a
-- transaction (otp, statement, promotion, not_a_transaction, no_amount, …).
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
      -- Direction and amount may be unknown: the import boundary sends those to review.
      update friday_private.gmail_import_items i set
        state = 'parsed',
        institution_key = v_alert ->> 'institutionKey',
        institution_name = left(v_alert ->> 'institutionName', 80),
        instrument = coalesce(v_alert ->> 'instrument', 'unknown'),
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
    skipped = (select count(*) from friday_private.gmail_import_items i where i.job_id = p_job_id and i.state = 'skipped'),
    skip_reasons = coalesce((
      select jsonb_object_agg(r.skip_reason, r.n) from (
        select coalesce(i.skip_reason, 'not_a_transaction') as skip_reason, count(*) as n
        from friday_private.gmail_import_items i
        where i.job_id = p_job_id and i.state = 'skipped'
        group by 1) r), '{}'::jsonb)
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
  v_hint text;
  v_event uuid;
  v_status text;
  v_replayed boolean;
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
    v_event := null;
    v_hint := left(v_item.institution_name || case when coalesce(v_item.account_mask, '') <> '' then ' ••' || v_item.account_mask else '' end, 60);

    select * into v_alias from public.import_account_aliases al
    where al.user_id = p_user_id and al.source_type = 'email' and al.institution_key = v_item.institution_key
      and al.instrument = v_item.instrument and al.account_mask = coalesce(v_item.account_mask, '');

    -- The person chose to ignore this account or card.
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
      select r.event_id, r.processing_status, r.replayed into v_event, v_status, v_replayed
      from public.ingest_source_event_for(
        p_user_id, 'email', v_item.message_id, v_job.connection_id, v_item.reference, null,
        v_kind, v_item.amount_minor, coalesce(v_item.currency, 'INR'), v_item.occurred_at, v_item.merchant,
        v_hint, v_account, v_destination, v_category, v_item.entry_status, v_item.confidence) r;
    exception when others then
      v_event := null;
    end;

    if v_event is null then
      -- Something in what was read didn't fit: keep the email in review with
      -- the plainest facts, rather than lose it.
      begin
        select r.event_id, r.processing_status, r.replayed into v_event, v_status, v_replayed
        from public.ingest_source_event_for(
          p_user_id, 'email', v_item.message_id, v_job.connection_id, null, null,
          null, v_item.amount_minor, 'INR', coalesce(v_item.occurred_at, now()), v_item.merchant,
          v_hint, null, null, null, 'posted', 0) r;
      exception when others then
        v_event := null;
      end;
    end if;

    v_outcome := case
      when v_event is null then 'failed'
      when v_status = 'imported' and v_replayed then 'matched'
      when v_status = 'imported'
           and exists (select 1 from public.source_events e where e.id = v_event and e.link_type = 'matched') then 'matched'
      when v_status = 'imported' then 'recorded'
      when v_status = 'needs_review' then 'needs_review'
      else 'ignored' end;
    update friday_private.gmail_import_items set
      state = 'done', outcome = v_outcome, event_id = v_event,
      event_created = v_event is not null and not coalesce(v_replayed, false)
    where job_id = p_job_id and message_id = v_item.message_id;
  end loop;

  select count(*) into v_remaining from friday_private.gmail_import_items i where i.job_id = p_job_id and i.state = 'parsed';
  update public.gmail_import_jobs j set
    recorded = (select count(*) from friday_private.gmail_import_items i where i.job_id = p_job_id and i.outcome = 'recorded'),
    matched  = (select count(*) from friday_private.gmail_import_items i where i.job_id = p_job_id and i.outcome = 'matched'),
    review   = (select count(*) from friday_private.gmail_import_items i where i.job_id = p_job_id and i.outcome = 'needs_review'),
    -- Declined or failed payments: no money moved, nothing to record.
    declined = (select count(*) from friday_private.gmail_import_items i where i.job_id = p_job_id and i.outcome = 'ignored'),
    ignored  = (select count(*) from friday_private.gmail_import_items i where i.job_id = p_job_id and i.outcome = 'skipped_account'),
    failed   = (select count(*) from friday_private.gmail_import_items i where i.job_id = p_job_id and i.outcome = 'failed'),
    status = case when v_remaining = 0 then 'done' else j.status end,
    finished_at = case when v_remaining = 0 then now() else j.finished_at end
  where j.id = p_job_id
  returning * into v_job;

  return query select v_processed, v_remaining, v_job.status;
end;
$$;

revoke all on function
  public.gmail_import_save(uuid, uuid, jsonb),
  public.gmail_import_run(uuid, uuid, integer)
  from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function
      public.gmail_import_save(uuid, uuid, jsonb),
      public.gmail_import_run(uuid, uuid, integer)
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
  if has_table_privilege('authenticated', 'public.gmail_import_jobs', 'update')
     or has_table_privilege('anon', 'public.gmail_import_jobs', 'select') then
    raise exception 'Migration check failed: import jobs must be read-only to signed-in users and closed to visitors';
  end if;
end
$$;

notify pgrst, 'reload schema';
