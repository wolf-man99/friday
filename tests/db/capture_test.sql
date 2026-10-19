-- LOCAL TESTING ONLY — never run this in the Supabase dashboard or against a
-- hosted project. Runs after ledger_test.sql (reuses its helpers and users).
--
-- Tests for the capture service (migration 0002): idempotent record_entry,
-- optimistic-concurrency update_entry, idempotent void/restore, the audit
-- trail, default accounts, and the accounting invariants under all of them.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    raise exception 'STOP: tests/db/capture_test.sql is for local testing only. In Supabase, run only supabase/migrations/*.sql.';
  end if;
end
$$;

set client_min_messages = notice;

create table tests.nums (key text primary key, n bigint);
grant select, insert, update on tests.nums to authenticated;
create function tests.num(p_key text) returns bigint language sql stable as $$
  select n from tests.nums where key = p_key;
$$;
create function tests.balance(p_account text) returns bigint language sql stable as $$
  select balance_minor from public.account_balances where id = tests.id(p_account);
$$;
create function tests.month_totals() returns table (income bigint, expense bigint) language sql stable as $$
  select income_minor, expense_minor from public.period_summary(now() - interval '400 days', now() + interval '1 day');
$$;
grant execute on all functions in schema tests to authenticated;

set role authenticated;
select tests.login(tests.id('A'));

insert into tests.nums select 'wallet0', tests.balance('Wallet');
insert into tests.nums select 'bank0', tests.balance('HDFC Savings');
insert into tests.nums select 'card0', tests.balance('Amex');
insert into tests.nums select 'income0', income from tests.month_totals();
insert into tests.nums select 'expense0', expense from tests.month_totals();

-- -----------------------------------------------------------------------------
-- record_entry: expenses, idempotency, mismatched replays
-- -----------------------------------------------------------------------------

insert into tests.ids select 'quick:coffee', id from public.record_entry(
  '11111111-1111-4111-8111-111111111111', 'expense', 25000, tests.id('Wallet'),
  p_category_id => tests.id('cat:Food & dining'), p_note => '  ', p_merchant => '  Blue Tokai ');

select tests.eq((select row(created_via, merchant, note)::text from public.transactions where id = tests.id('quick:coffee')),
  row('quick_add', 'Blue Tokai', null::text)::text, 'merchant trimmed, blank note stored as null, origin recorded');
select tests.eq(tests.balance('Wallet'), tests.num('wallet0') - 25000, 'expense reduces the account balance once');
select tests.eq((select expense from tests.month_totals()), tests.num('expense0') + 25000, 'expense raises expense total');

select tests.eq((select row(id, created, matches)::text from public.record_entry(
  '11111111-1111-4111-8111-111111111111', 'expense', 25000, tests.id('Wallet'),
  p_category_id => tests.id('cat:Food & dining'))),
  row(tests.id('quick:coffee'), false, true)::text, 'replaying a request returns the original entry');
select tests.eq((select count(*) from public.transactions where idempotency_key = '11111111-1111-4111-8111-111111111111'),
  1::bigint, 'a replayed request creates nothing new');
select tests.eq(tests.balance('Wallet'), tests.num('wallet0') - 25000, 'a replayed request does not move the balance again');

select tests.eq((select row(created, matches)::text from public.record_entry(
  '11111111-1111-4111-8111-111111111111', 'expense', 99900, tests.id('Wallet'))),
  row(false, false)::text, 'reusing a key with different details is reported, not saved');
select tests.eq((select amount_minor from public.transactions where id = tests.id('quick:coffee')), 25000::bigint,
  'the original entry is unchanged by a mismatched replay');
select tests.eq((select row(created, matches)::text from public.record_entry(
  '11111111-1111-4111-8111-111111111111', 'transfer', 25000, tests.id('Wallet'), tests.id('HDFC Savings'))),
  row(false, false)::text, 'a key used for an expense cannot become a transfer');

-- -----------------------------------------------------------------------------
-- record_entry: income and transfers
-- -----------------------------------------------------------------------------

insert into tests.ids select 'quick:refund', id from public.record_entry(
  '22222222-2222-4222-8222-222222222222', 'income', 5000, tests.id('Amex'),
  p_category_id => tests.id('cat:Refunds'));
select tests.eq(tests.balance('Amex'), tests.num('card0') + 5000, 'a refund to a card reduces what is owed');
select tests.eq((select income from tests.month_totals()), tests.num('income0') + 5000, 'income raises income total');

insert into tests.ids select 'quick:atm', id from public.record_entry(
  '33333333-3333-4333-8333-333333333333', 'transfer', 100000, tests.id('HDFC Savings'), tests.id('Wallet'));
select tests.eq(tests.balance('HDFC Savings'), tests.num('bank0') - 100000, 'transfer leaves the source');
select tests.eq(tests.balance('Wallet'), tests.num('wallet0') - 25000 + 100000, 'transfer reaches the destination');
select tests.eq((select row(income, expense)::text from tests.month_totals()),
  row(tests.num('income0') + 5000, tests.num('expense0') + 25000)::text, 'transfers change neither income nor expense');
select tests.eq((select created_via from public.transfers where id = tests.id('quick:atm')), 'quick_add', 'transfer origin recorded');
select tests.eq((select count(*) from public.record_entry(
  '33333333-3333-4333-8333-333333333333', 'transfer', 100000, tests.id('HDFC Savings'), tests.id('Wallet'))
  where not created and matches), 1::bigint, 'replaying a transfer returns the original');
select tests.eq((select count(*) from public.transfers where idempotency_key = '33333333-3333-4333-8333-333333333333'),
  1::bigint, 'a replayed transfer creates nothing new');

-- -----------------------------------------------------------------------------
-- record_entry: rejected input
-- -----------------------------------------------------------------------------

select tests.throws($$select * from public.record_entry('44444444-4444-4444-8444-444444444441', 'expense', 0, tests.id('Wallet'))$$,
  'more than zero', 'zero amount rejected');
select tests.throws($$select * from public.record_entry('44444444-4444-4444-8444-444444444442', 'expense', -100, tests.id('Wallet'))$$,
  'more than zero', 'negative amount rejected');
select tests.throws($$select * from public.record_entry('44444444-4444-4444-8444-444444444443', 'expense', 100000000000001, tests.id('Wallet'))$$,
  'check constraint', 'absurd amount rejected');
select tests.throws($$select * from public.record_entry('44444444-4444-4444-8444-444444444444', 'transfer', 100, tests.id('Wallet'), tests.id('Wallet'))$$,
  'transfers_distinct_accounts', 'same-account transfer rejected');
select tests.throws($$select * from public.record_entry('44444444-4444-4444-8444-444444444445', 'transfer', 100, tests.id('Wallet'))$$,
  'destination account', 'transfer needs a destination');
select tests.throws($$select * from public.record_entry('44444444-4444-4444-8444-444444444446', 'transfer', 100, tests.id('Wallet'), tests.id('Amex'), tests.id('cat:Shopping'))$$,
  'category', 'transfers take no category');
select tests.throws($$select * from public.record_entry('44444444-4444-4444-8444-444444444447', 'expense', 100, tests.id('Wallet'), p_category_id => tests.id('cat:Salary'))$$,
  'foreign key', 'income category rejected on an expense');
select tests.throws($$select * from public.record_entry('44444444-4444-4444-8444-444444444448', 'expense', 100, tests.id('Old wallet'))$$,
  'archived', 'archived account rejected');
select tests.throws($$select * from public.record_entry(null, 'expense', 100, tests.id('Wallet'))$$,
  'request key', 'a request key is required');
select tests.throws($$select * from public.record_entry('44444444-4444-4444-8444-444444444449', 'expense', 100, tests.id('Wallet'), p_merchant => repeat('m', 121))$$,
  'transactions_merchant_length', 'overlong merchant rejected');
select tests.eq((select count(*) from public.transactions where idempotency_key::text like '44444444-%'), 0::bigint,
  'rejected requests leave nothing behind');

-- -----------------------------------------------------------------------------
-- update_entry: edits recompute, never double count; stale edits are refused
-- -----------------------------------------------------------------------------

insert into tests.nums select 'coffee:v1', extract(epoch from updated_at) * 1000000
  from public.transactions where id = tests.id('quick:coffee');

select tests.eq(public.update_entry('expense', tests.id('quick:coffee'),
    (select updated_at from public.transactions where id = tests.id('quick:coffee')),
    'expense', 40000, tests.id('Wallet'), null, tests.id('cat:Food & dining'), null, 'Team coffee', 'Blue Tokai') is not null,
  true, 'edit with the current version succeeds');
select tests.eq(tests.balance('Wallet'), tests.num('wallet0') - 40000 + 100000, 'edited amount replaces the old one (no double count)');
select tests.eq((select expense from tests.month_totals()), tests.num('expense0') + 40000, 'expense total follows the edit');

select tests.throws($$select public.update_entry('expense', tests.id('quick:coffee'), to_timestamp(tests.num('coffee:v1') / 1000000.0),
    'expense', 1, tests.id('Wallet'))$$,
  'changed somewhere else', 'stale edit refused');
select tests.eq((select amount_minor from public.transactions where id = tests.id('quick:coffee')), 40000::bigint,
  'a refused edit writes nothing');

-- Expense → income: the old category type no longer fits.
select tests.throws($$select public.update_entry('expense', tests.id('quick:coffee'), null, 'income', 40000, tests.id('Wallet'), null, tests.id('cat:Food & dining'))$$,
  'foreign key', 'switching type with an incompatible category is refused');
select tests.eq(public.update_entry('expense', tests.id('quick:coffee'), null, 'income', 40000, tests.id('Wallet'), null, null) is not null, true, 'expense can be switched to income without a category');
select tests.eq((select row(income, expense)::text from tests.month_totals()),
  row(tests.num('income0') + 5000 + 40000, tests.num('expense0'))::text, 'switching to income moves it between totals');
select tests.eq(tests.balance('Wallet'), tests.num('wallet0') + 40000 + 100000, 'switching to income flips its balance effect');
select tests.eq(public.update_entry('income', tests.id('quick:coffee'), null, 'expense', 40000, tests.id('Wallet'), null, tests.id('cat:Food & dining')) is not null, true, 'and back to an expense with an expense category');

select tests.throws($$select public.update_entry('transfer', tests.id('quick:atm'), null, 'expense', 100, tests.id('Wallet'))$$,
  'can''t become', 'a transfer cannot be edited into an expense');
select tests.eq(public.update_entry('transfer', tests.id('quick:atm'), null, 'transfer', 150000, tests.id('HDFC Savings'), tests.id('Wallet')) is not null, true, 'transfer amount can be edited');
select tests.eq(tests.balance('HDFC Savings'), tests.num('bank0') - 150000, 'edited transfer: source moves once');
select tests.eq(tests.balance('Wallet'), tests.num('wallet0') - 40000 + 150000, 'edited transfer: destination moves once');

-- -----------------------------------------------------------------------------
-- set_entry_voided: Undo and restore, idempotent
-- -----------------------------------------------------------------------------

select tests.eq(public.set_entry_voided('expense', tests.id('quick:coffee'), true) is not null, true, 'void/restore call: true');
select tests.eq(tests.balance('Wallet'), tests.num('wallet0') + 150000, 'undo removes the expense from the balance');
select tests.eq((select expense from tests.month_totals()), tests.num('expense0'), 'undo removes it from totals');
select tests.eq(public.set_entry_voided('expense', tests.id('quick:coffee'), true) is not null, true, 'void/restore call: true');
select tests.eq(tests.balance('Wallet'), tests.num('wallet0') + 150000, 'a second undo changes nothing');
select tests.eq((select row(created, voided)::text from public.record_entry(
  '11111111-1111-4111-8111-111111111111', 'expense', 40000, tests.id('Wallet'), p_category_id => tests.id('cat:Food & dining'))),
  row(false, true)::text, 'replaying an undone request does not resurrect it');
select tests.eq(tests.balance('Wallet'), tests.num('wallet0') + 150000, 'still undone after the replay');
select tests.throws($$select public.update_entry('expense', tests.id('quick:coffee'), null, 'expense', 1, tests.id('Wallet'))$$,
  'was deleted', 'a voided entry cannot be edited');
select tests.eq(public.set_entry_voided('expense', tests.id('quick:coffee'), false) is not null, true, 'void/restore call: false');
select tests.eq(public.set_entry_voided('expense', tests.id('quick:coffee'), false) is not null, true, 'void/restore call: false');
select tests.eq(tests.balance('Wallet'), tests.num('wallet0') - 40000 + 150000, 'restore brings it back exactly once');

select tests.eq(public.set_entry_voided('transfer', tests.id('quick:atm'), true) is not null, true, 'void/restore call: true');
select tests.eq(tests.balance('HDFC Savings'), tests.num('bank0'), 'undoing a transfer restores the source');
select tests.eq(tests.balance('Wallet'), tests.num('wallet0') - 40000, 'undoing a transfer restores the destination');

-- -----------------------------------------------------------------------------
-- Audit trail
-- -----------------------------------------------------------------------------

select tests.eq((select string_agg(action, ',' order by id) from public.ledger_audit where entity_id = tests.id('quick:coffee')),
  'create,update,update,update,void,restore', 'every change to an entry is audited in order');
select tests.eq((select changed_fields from public.ledger_audit where entity_id = tests.id('quick:coffee') and action = 'update' order by id limit 1),
  array['amount_minor', 'note'], 'audit lists exactly the fields that changed');
select tests.eq((select bool_or(snapshot ? 'note' or snapshot ? 'merchant' or snapshot::text like '%Tokai%' or snapshot::text like '%Team coffee%')
                 from public.ledger_audit), false, 'audit never stores note or merchant text');
select tests.throws($$insert into public.ledger_audit (user_id, entity, entity_id, action, snapshot) values (auth.uid(), 'transaction', gen_random_uuid(), 'create', '{}')$$,
  'permission denied', 'clients cannot write to the audit trail');

-- -----------------------------------------------------------------------------
-- Recurring confirmations and the default account
-- -----------------------------------------------------------------------------

select tests.eq((select count(*) > 0 from public.transactions where created_via = 'recurring'), true,
  'recurring confirmations are marked as such');

update public.profiles set default_account_id = tests.id('Wallet') where id = auth.uid();
select tests.eq((select default_account_id from public.profiles where id = auth.uid()), tests.id('Wallet'), 'default account can be set');
select tests.throws($$update public.profiles set default_account_id = tests.id('Old wallet') where id = auth.uid()$$,
  'active accounts', 'an archived account cannot be the default');
update public.profiles set timezone = 'Asia/Kolkata' where id = auth.uid();
select tests.eq(true, true, 'other profile edits are unaffected by the default account check');

reset role;

-- -----------------------------------------------------------------------------
-- Another user: same request key, separate namespace; no access to A's entries
-- -----------------------------------------------------------------------------

set role authenticated;
select tests.login(tests.id('B'));

insert into public.accounts (name, type) values ('B cash', 'cash');
insert into tests.ids select 'B cash', id from public.accounts where name = 'B cash';

select tests.eq((select created from public.record_entry(
  '11111111-1111-4111-8111-111111111111', 'expense', 700, tests.id('B cash'))), true,
  'the same key from another user is a different request');
select tests.eq((select count(*) from public.transactions), 1::bigint, 'B sees only their own entry');
select tests.eq((select count(*) from public.ledger_audit), 1::bigint, 'B sees only their own audit rows');
select tests.throws($$select * from public.record_entry('55555555-5555-4555-8555-555555555555', 'expense', 100, tests.id('Wallet'))$$,
  'Choose one of your accounts', 'B cannot record against A''s account');
select tests.throws($$select public.update_entry('expense', tests.id('quick:coffee'), null, 'expense', 1, tests.id('B cash'))$$,
  'no longer exists', 'B cannot edit A''s entry');
select tests.throws($$select public.set_entry_voided('expense', tests.id('quick:coffee'), true)$$,
  'no longer exists', 'B cannot undo A''s entry');
select tests.throws($$update public.profiles set default_account_id = tests.id('Wallet') where id = auth.uid()$$,
  'active accounts', 'B cannot make A''s account their default');

reset role;
select tests.eq((select amount_minor from public.transactions where id = tests.id('quick:coffee')), 40000::bigint,
  'A''s entry untouched by B');

set role anon;
select tests.throws($$select * from public.record_entry('66666666-6666-4666-8666-666666666666', 'expense', 100, gen_random_uuid())$$,
  'permission denied', 'anonymous visitors cannot record entries');
reset role;

do $$ begin raise notice 'All capture tests passed.'; end $$;
