-- LOCAL TESTING ONLY — never run this in the Supabase dashboard or against a
-- hosted project. Runs after the other tests (reuses their helpers).
--
-- Deleting an account (migration 0007): it goes with everything recorded on
-- it, other accounts keep their own entries, and only its owner can do it.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    raise exception 'STOP: tests/db/delete_account_test.sql is for local testing only. In Supabase, run only supabase/migrations/*.sql.';
  end if;
end
$$;

set client_min_messages = notice;

set role supabase_auth_admin;
insert into auth.users (id, email, raw_user_meta_data) values
  ('d1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1', 'dev@example.com', '{}'),
  ('d2d2d2d2-d2d2-d2d2-d2d2-d2d2d2d2d2d2', 'eve@example.com', '{}');
reset role;
insert into tests.ids values ('Del', 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1'), ('Eve', 'd2d2d2d2-d2d2-d2d2-d2d2-d2d2d2d2d2d2');

set role authenticated;
select tests.login(tests.id('Del'));
with made as (
  insert into public.accounts (name, type, opening_balance_minor) values
    ('Old bank', 'bank', 1000000), ('Card', 'credit_card', 0)
  returning case name when 'Old bank' then 'Del:bank' else 'Del:card' end as key, id
)
insert into tests.ids select key, id from made;
insert into tests.ids select 'Del:buy', id from public.record_entry(gen_random_uuid(), 'expense', 50000, tests.id('Del:bank'));
select from public.record_entry(gen_random_uuid(), 'refund', 10000, tests.id('Del:bank'), p_related_transaction_id => tests.id('Del:buy'));
select from public.record_entry(gen_random_uuid(), 'transfer', 20000, tests.id('Del:bank'), p_destination_account_id => tests.id('Del:card'));
select from public.record_entry(gen_random_uuid(), 'expense', 7000, tests.id('Del:card'));
update public.profiles set default_account_id = tests.id('Del:bank') where id = tests.id('Del');
reset role;
insert into public.import_account_aliases (user_id, institution_key, institution_name, instrument, account_mask, account_id)
values (tests.id('Del'), 'hdfc', 'HDFC Bank', 'bank', '1234', tests.id('Del:bank'));

set role authenticated;
select tests.login(tests.id('Eve'));
select tests.throws($$select * from public.delete_account(tests.id('Del:bank'))$$, 'no longer exists',
  'nobody can delete someone else''s account');
reset role;
set role anon;
select tests.throws($$select * from public.delete_account(tests.id('Del:bank'))$$, 'permission denied', 'nor can a visitor');
reset role;

set role authenticated;
select tests.login(tests.id('Del'));
select tests.eq((select row(removed_entries, removed_transfers)::text from public.delete_account(tests.id('Del:bank'))),
  row(2, 1)::text, 'deleting an account removes its entries (with refunds of them) and its transfers');
select tests.eq((select count(*) from public.accounts where id = tests.id('Del:bank')), 0::bigint, 'the account is gone');
select tests.eq(tests.balance('Del:card'), -7000::bigint, 'the card keeps its own spending; the transfer from the deleted account is gone');
select tests.eq((select default_account_id from public.profiles where id = tests.id('Del')), null::uuid, 'it''s no longer the default account');
reset role;
select tests.eq((select count(*) from public.import_account_aliases where user_id = tests.id('Del')), 0::bigint,
  'and emails no longer link to it');
set role authenticated;
select tests.login(tests.id('Del'));
select tests.throws($$select * from public.delete_account(tests.id('Del:bank'))$$, 'no longer exists', 'it can only be deleted once');
reset role;

\echo All delete-account tests passed.
