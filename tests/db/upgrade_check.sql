-- LOCAL TESTING ONLY. Verifies the 0001-era fixture after all migrations.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    raise exception 'STOP: tests/db/upgrade_check.sql is for local testing only.';
  end if;
end
$$;

set client_min_messages = notice;

select tests.eq((select count(*) from public.transactions where user_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'), 3::bigint,
  'upgrade: legacy transactions kept');
select tests.eq((select string_agg(coalesce(note, '') || '/' || created_via || '/' || coalesce(idempotency_key::text, 'no-key'), ',' order by note)
                 from public.transactions where user_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'),
  'Old groceries/manual/no-key,Old refund/manual/no-key,Old salary/manual/no-key', 'upgrade: legacy rows get defaults, values untouched');
select tests.eq((select balance_minor from public.account_balances where id = 'd0000000-0000-0000-0000-000000000001'),
  1000000 - 12345 + 500000 + 2500 - 20000::bigint, 'upgrade: legacy bank balance unchanged');
select tests.eq((select balance_minor from public.account_balances where id = 'd0000000-0000-0000-0000-000000000002'),
  50000 + 20000::bigint, 'upgrade: legacy cash balance unchanged');
select tests.eq((select count(*) from public.ledger_entries where user_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd' and merchant is null), 4::bigint,
  'upgrade: legacy entries appear in the feed with no merchant');
select tests.eq((select default_account_id from public.profiles where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'), null::uuid,
  'upgrade: no default account is invented');
select tests.eq((select count(*) from public.ledger_audit where user_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'), 0::bigint,
  'upgrade: no audit rows are fabricated for history');

select tests.eq((select row(t.type, t.amount_minor, c.name, c.is_archived)::text
                 from public.transactions t join public.categories c on c.id = t.category_id
                 where t.id = 'd0000000-0000-0000-0000-000000000013'),
  row('income', 2500, 'Refunds', true)::text, 'upgrade: entries in the archived "Refunds" category are unchanged');

do $$ begin raise notice 'All upgrade checks passed.'; end $$;
