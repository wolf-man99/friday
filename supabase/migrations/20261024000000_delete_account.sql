-- =============================================================================
-- Friday 0007 — Delete an account
--
-- Archiving keeps an account and its history; deleting removes it for good,
-- with everything recorded on it: its income and expenses (and refunds or
-- reversals of them), transfers to or from it, its recurring items, and the
-- import evidence that created those entries. Import suggestions that pointed
-- at it are cleared, and email account links to it are forgotten.
--
-- Only the signed-in owner can delete their own account. Additive and
-- re-runnable.
-- =============================================================================

create or replace function public.delete_account(p_account_id uuid)
returns table (removed_entries integer, removed_transfers integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_tx uuid[];
  v_more uuid[];
  v_tr uuid[];
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  perform 1 from public.accounts a where a.id = p_account_id and a.user_id = v_uid for update;
  if not found then
    raise exception 'That account no longer exists' using errcode = 'P0002';
  end if;

  -- Its entries, and refunds or reversals of them (wherever they were recorded).
  select coalesce(array_agg(t.id), '{}') into v_tx from public.transactions t
  where t.user_id = v_uid and t.account_id = p_account_id;
  loop
    select coalesce(array_agg(t.id), '{}') into v_more from public.transactions t
    where t.user_id = v_uid and t.related_transaction_id = any (v_tx) and not (t.id = any (v_tx));
    exit when cardinality(v_more) = 0;
    v_tx := v_tx || v_more;
  end loop;
  select coalesce(array_agg(x.id), '{}') into v_tr from public.transfers x
  where x.user_id = v_uid and p_account_id in (x.source_account_id, x.destination_account_id);

  delete from public.source_events e
  where e.user_id = v_uid and (e.resulting_transaction_id = any (v_tx) or e.resulting_transfer_id = any (v_tr));
  update public.source_events e set suggested_account_id = null
  where e.user_id = v_uid and e.suggested_account_id = p_account_id;
  update public.source_events e set suggested_destination_account_id = null
  where e.user_id = v_uid and e.suggested_destination_account_id = p_account_id;

  delete from public.recurring_occurrences o where o.user_id = v_uid and o.transaction_id = any (v_tx);
  delete from public.recurring_rules r where r.user_id = v_uid and r.account_id = p_account_id;
  delete from public.transactions t where t.user_id = v_uid and t.id = any (v_tx);
  delete from public.transfers x where x.user_id = v_uid and x.id = any (v_tr);

  delete from public.import_account_aliases al where al.user_id = v_uid and al.account_id = p_account_id;
  update public.profiles set default_account_id = null where id = v_uid and default_account_id = p_account_id;
  delete from public.accounts a where a.id = p_account_id and a.user_id = v_uid;

  return query select cardinality(v_tx), cardinality(v_tr);
end;
$$;

revoke all on function public.delete_account(uuid) from public, anon;
grant execute on function public.delete_account(uuid) to authenticated;

notify pgrst, 'reload schema';
