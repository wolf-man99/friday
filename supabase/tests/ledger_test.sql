-- Integration tests for the Friday schema: ledger maths, constraints, RLS and
-- the recurring workflow. Run with scripts/test-db.sh (needs a local
-- PostgreSQL); every assertion raises on failure.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
set client_min_messages = notice;

-- -----------------------------------------------------------------------------
-- Test helpers
-- -----------------------------------------------------------------------------

create schema tests;
grant usage on schema tests to anon, authenticated;

create function tests.eq(actual anyelement, expected anyelement, label text)
returns void language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL %: expected %, got %', label, expected, actual;
  end if;
  raise notice 'ok - %', label;
end;
$$;

-- Runs p_sql and passes only if it fails with a message containing p_fragment.
create function tests.throws(p_sql text, p_fragment text, label text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if position(lower(p_fragment) in lower(sqlerrm)) > 0 then
      raise notice 'ok - %', label;
      return;
    end if;
    raise exception 'FAIL %: expected error containing "%", got "%"', label, p_fragment, sqlerrm;
  end;
  raise exception 'FAIL %: expected an error, statement succeeded', label;
end;
$$;

create function tests.login(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, false);
$$;

grant execute on all functions in schema tests to anon, authenticated;

-- Shared ids, readable from any role.
create table tests.ids (key text primary key, id uuid not null);
grant select, insert on tests.ids to authenticated;

create function tests.id(p_key text) returns uuid language sql stable as $$
  select id from tests.ids where key = p_key;
$$;

-- "Today" as the database sees it for the test user (Asia/Kolkata default).
create function tests.today() returns date language sql stable as $$
  select (now() at time zone 'Asia/Kolkata')::date;
$$;

-- -----------------------------------------------------------------------------
-- Sign-up creates a profile and default categories
-- -----------------------------------------------------------------------------

insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'asha@example.com', '{"display_name":"Asha"}'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'bilal@example.com', '{}');

insert into tests.ids values
  ('A', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('B', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

select tests.eq((select display_name from public.profiles where id = tests.id('A')), 'Asha', 'profile uses display_name metadata');
select tests.eq((select display_name from public.profiles where id = tests.id('B')), 'bilal', 'profile falls back to email name');
select tests.eq((select timezone from public.profiles where id = tests.id('A')), 'Asia/Kolkata', 'default timezone');
select tests.eq((select count(*) from public.categories where user_id = tests.id('A') and transaction_type = 'expense'), 14::bigint, 'expense defaults seeded');
select tests.eq((select count(*) from public.categories where user_id = tests.id('A') and transaction_type = 'income'), 6::bigint, 'income defaults seeded');

-- -----------------------------------------------------------------------------
-- User A builds a small ledger
-- -----------------------------------------------------------------------------

set role authenticated;
select tests.login(tests.id('A'));

select tests.throws($$update public.profiles set timezone = 'Mars/Olympus' where id = auth.uid()$$,
  'Unknown timezone', 'invalid timezone rejected');

with a as (
  insert into public.accounts (name, type, opening_balance_minor) values
    ('HDFC Savings', 'bank', 5000000),
    ('Wallet', 'cash', 200000),
    ('Amex', 'credit_card', -1500000)
  returning name, id
)
insert into tests.ids select name, id from a;

insert into tests.ids
select 'cat:' || name, id from public.categories where user_id = auth.uid();

-- Salary in, two purchases, two transfers (top up wallet, pay the card).
with t as (
  insert into public.transactions (account_id, type, amount_minor, category_id, occurred_at, note) values
    (tests.id('HDFC Savings'), 'income',  8000000, tests.id('cat:Salary'),        now() - interval '2 days', 'October salary'),
    (tests.id('Wallet'),       'expense',  125050, tests.id('cat:Food & dining'), now() - interval '1 day',  'Dosa + coffee'),
    (tests.id('Amex'),         'expense',  300000, tests.id('cat:Shopping'),      now(),                     'Shoes')
  returning note, id
)
insert into tests.ids select note, id from t;

select tests.eq((select currency::text from public.transactions where id = tests.id('Shoes')), 'INR', 'currency filled from account');

insert into public.transfers (source_account_id, destination_account_id, amount_minor, note) values
  (tests.id('HDFC Savings'), tests.id('Wallet'), 1000000, 'ATM'),
  (tests.id('HDFC Savings'), tests.id('Amex'),    300000, 'Card bill');

-- Balances: opening + income − expense + transfers in − transfers out.
select tests.eq((select balance_minor from public.account_balances where id = tests.id('HDFC Savings')),
  5000000 + 8000000 - 1000000 - 300000::bigint, 'bank balance');
select tests.eq((select balance_minor from public.account_balances where id = tests.id('Wallet')),
  200000 - 125050 + 1000000::bigint, 'cash balance');
select tests.eq((select balance_minor from public.account_balances where id = tests.id('Amex')),
  -1500000 - 300000 + 300000::bigint, 'card balance (negative = owed)');

-- Transfers never count as income or expense.
select tests.eq((select row(income_minor, expense_minor, net_minor, transfer_count)::text
                 from public.period_summary(now() - interval '7 days', now() + interval '1 minute')),
  row(8000000::bigint, 425050::bigint, 7574950::bigint, 2::bigint)::text, 'period summary excludes transfers');

select tests.eq((select string_agg(total_minor::text, ',' order by total_minor desc)
                 from public.category_breakdown(now() - interval '7 days', now() + interval '1 minute')),
  '300000,125050', 'category breakdown is expense-only');

select tests.eq((select count(*) from public.ledger_entries), 5::bigint, 'ledger feed has 3 transactions + 2 transfers');
select tests.eq((select count(*) from public.ledger_entries where kind = 'transfer'
                   and (account_id = tests.id('Amex') or counter_account_id = tests.id('Amex'))), 1::bigint,
  'feed filter finds transfers on either side');

-- Three local (IST) calendar months → three buckets, empty ones included.
select tests.eq((select count(*) from public.cashflow_trend(
    (date_trunc('month', now() at time zone 'Asia/Kolkata') - interval '2 months') at time zone 'Asia/Kolkata',
    (date_trunc('month', now() at time zone 'Asia/Kolkata') + interval '1 month') at time zone 'Asia/Kolkata',
    'month')),
  3::bigint, 'trend returns empty months too');
select tests.eq((select sum(income_minor) from public.cashflow_trend(now() - interval '7 days', now() + interval '1 minute', 'day')),
  8000000::numeric, 'daily trend sums income');
select tests.throws($$select * from public.cashflow_trend(now(), now() + interval '1 day', 'hour')$$,
  'Unsupported bucket', 'trend rejects unknown bucket');

-- -----------------------------------------------------------------------------
-- Constraints
-- -----------------------------------------------------------------------------

select tests.throws($$insert into public.transactions (account_id, type, amount_minor) values (tests.id('Wallet'), 'expense', 0)$$,
  'check constraint', 'zero amount rejected');
select tests.throws($$insert into public.transactions (account_id, type, amount_minor) values (tests.id('Wallet'), 'expense', -500)$$,
  'check constraint', 'negative amount rejected');
select tests.throws($$insert into public.transactions (account_id, type, amount_minor) values (tests.id('Wallet'), 'transfer', 500)$$,
  'check constraint', 'transactions cannot be transfers');
select tests.throws($$insert into public.transactions (account_id, type, amount_minor, category_id) values (tests.id('Wallet'), 'expense', 500, tests.id('cat:Salary'))$$,
  'foreign key', 'income category cannot tag an expense');
select tests.throws($$update public.transactions set type = 'income' where id = tests.id('Shoes')$$,
  'foreign key', 'changing type keeps category compatible');
select tests.throws($$insert into public.transfers (source_account_id, destination_account_id, amount_minor) values (tests.id('Wallet'), tests.id('Wallet'), 500)$$,
  'transfers_distinct_accounts', 'transfer needs two different accounts');
select tests.throws($$insert into public.transfers (source_account_id, destination_account_id, amount_minor) values (tests.id('Wallet'), tests.id('Amex'), 0)$$,
  'check constraint', 'transfer amount must be positive');
select tests.throws($$insert into public.accounts (name, type, currency) values ('Euro', 'bank', 'EUR')$$,
  'accounts_currency_supported', 'v1 accounts are INR only');
select tests.throws($$insert into public.transactions (account_id, type, amount_minor, currency) values (tests.id('Wallet'), 'expense', 500, 'USD')$$,
  'must match the account currency', 'transaction currency must match account');

-- Archived accounts and categories keep history but take no new entries.
insert into public.accounts (name, type) values ('Old wallet', 'cash');
insert into tests.ids select 'Old wallet', id from public.accounts where name = 'Old wallet';
insert into public.transactions (account_id, type, amount_minor, note) values (tests.id('Old wallet'), 'expense', 1000, 'before archive');
update public.accounts set status = 'archived' where id = tests.id('Old wallet');
select tests.throws($$insert into public.transactions (account_id, type, amount_minor) values (tests.id('Old wallet'), 'expense', 500)$$,
  'archived', 'archived account takes no new transactions');
update public.transactions set note = 'edited after archive' where note = 'before archive';
select tests.eq((select count(*) from public.transactions where note = 'edited after archive'), 1::bigint, 'history on archived account stays editable');
select tests.throws($$delete from public.accounts where id = tests.id('Old wallet')$$,
  'foreign key', 'referenced account cannot be deleted');

update public.categories set is_archived = true where id = tests.id('cat:Shopping');
select tests.throws($$insert into public.transactions (account_id, type, amount_minor, category_id) values (tests.id('Wallet'), 'expense', 500, tests.id('cat:Shopping'))$$,
  'archived', 'archived category takes no new transactions');
update public.transactions set note = 'Running shoes' where id = tests.id('Shoes');
select tests.eq((select category_id from public.transactions where id = tests.id('Shoes')), tests.id('cat:Shopping'),
  'historical transaction keeps archived category');
update public.categories set is_archived = false where id = tests.id('cat:Shopping');

-- -----------------------------------------------------------------------------
-- Soft delete and restore
-- -----------------------------------------------------------------------------

update public.transactions set deleted_at = now() where id = tests.id('Dosa + coffee');
select tests.eq((select balance_minor from public.account_balances where id = tests.id('Wallet')),
  1200000::bigint, 'deleted expense no longer affects balance');
select tests.eq((select expense_minor from public.period_summary(now() - interval '7 days', now() + interval '1 minute')),
  301000::bigint, 'deleted expense no longer affects summary');
update public.transactions set deleted_at = null where id = tests.id('Dosa + coffee');
select tests.eq((select balance_minor from public.account_balances where id = tests.id('Wallet')),
  1074950::bigint, 'restored expense counts again');
select tests.throws($$delete from public.transactions where id = tests.id('Dosa + coffee')$$,
  'permission denied', 'transactions cannot be hard-deleted by the client');

-- -----------------------------------------------------------------------------
-- Recurrence date maths (no drift at month ends, leap years)
-- -----------------------------------------------------------------------------

select tests.eq(public.recurrence_next_after('2026-01-31', 'monthly', 1, '2026-01-31'), '2026-02-28'::date, 'Jan 31 → Feb 28');
select tests.eq(public.recurrence_next_after('2026-01-31', 'monthly', 1, '2026-02-28'), '2026-03-31'::date, 'Feb 28 → Mar 31 (anchored, no drift)');
select tests.eq(public.recurrence_next_after('2026-01-31', 'monthly', 3, '2026-01-31'), '2026-04-30'::date, 'quarterly');
select tests.eq(public.recurrence_next_after('2026-01-05', 'weekly', 2, '2026-01-05'), '2026-01-19'::date, 'fortnightly');
select tests.eq(public.recurrence_next_after('2026-01-05', 'daily', 1, '2026-03-01'), '2026-03-02'::date, 'daily');
select tests.eq(public.recurrence_next_after('2024-02-29', 'yearly', 1, '2024-02-29'), '2025-02-28'::date, 'leap day → Feb 28');
select tests.eq(public.recurrence_next_after('2024-02-29', 'yearly', 1, '2027-03-01'), '2028-02-29'::date, 'leap day returns in leap year');
select tests.eq(public.recurrence_next_after('2026-05-10', 'monthly', 1, '2026-01-01'), '2026-05-10'::date, 'before anchor → anchor');

-- -----------------------------------------------------------------------------
-- Recurring workflow
-- -----------------------------------------------------------------------------

insert into public.recurring_rules (name, type, amount_minor, account_id, category_id, cadence, start_date)
values ('Rent', 'expense', 2500000, tests.id('HDFC Savings'), tests.id('cat:Rent & home'), 'monthly',
        (tests.today() - interval '2 months')::date);
insert into tests.ids select 'rule:Rent', id from public.recurring_rules where name = 'Rent';

select tests.eq((select next_due_date from public.recurring_rules where id = tests.id('rule:Rent')),
  (tests.today() - interval '2 months')::date, 'new rule is due on its start date');
select tests.eq((select count(*) from public.transactions where note = 'Rent'), 0::bigint, 'a rule alone posts nothing');

select tests.eq(public.sync_recurring_occurrences(), 3, 'sync creates the three due occurrences');
select tests.eq(public.sync_recurring_occurrences(), 0, 'sync is idempotent');
select tests.eq((select count(*) from public.transactions where note = 'Rent'), 0::bigint, 'due occurrences are not transactions');
select tests.eq((select next_due_date from public.recurring_rules where id = tests.id('rule:Rent')),
  public.recurrence_next_after((tests.today() - interval '2 months')::date, 'monthly', 1, tests.today()), 'next due advanced past today');

-- Confirm twice → exactly one transaction.
insert into tests.ids values ('rent:first',
  public.confirm_recurring_occurrence(tests.id('rule:Rent'), (tests.today() - interval '2 months')::date));
select tests.eq(public.confirm_recurring_occurrence(tests.id('rule:Rent'), (tests.today() - interval '2 months')::date),
  tests.id('rent:first'), 'second confirm returns the same transaction');
select tests.eq((select count(*) from public.transactions where note = 'Rent'), 1::bigint, 'confirming twice posts once');
select tests.eq((select status from public.recurring_occurrences where transaction_id = tests.id('rent:first')), 'confirmed', 'occurrence marked confirmed');

-- Overrides on confirm.
select tests.eq(public.confirm_recurring_occurrence(tests.id('rule:Rent'), (tests.today() - interval '1 month')::date,
  p_amount_minor => 2600000, p_note => 'Rent incl. maintenance') is not null, true, 'confirm with overrides');
select tests.eq((select amount_minor from public.transactions where note = 'Rent incl. maintenance'), 2600000::bigint, 'confirm accepts amount override');

-- Skip, then guard against flipping.
select public.skip_recurring_occurrence(tests.id('rule:Rent'), tests.today());
select public.skip_recurring_occurrence(tests.id('rule:Rent'), tests.today());
select tests.eq((select status from public.recurring_occurrences where rule_id = tests.id('rule:Rent') and due_date = tests.today()), 'skipped', 'skip is idempotent');
select tests.throws($$select public.confirm_recurring_occurrence(tests.id('rule:Rent'), tests.today())$$, 'skipped', 'cannot confirm a skipped occurrence');
select tests.throws($$select public.skip_recurring_occurrence(tests.id('rule:Rent'), (tests.today() - interval '2 months')::date)$$, 'already recorded', 'cannot skip a confirmed occurrence');
select tests.throws($$select public.confirm_recurring_occurrence(tests.id('rule:Rent'), tests.today() + 3)$$, 'not due', 'off-schedule date rejected');

-- Acting early on the upcoming date materialises it and advances the rule.
select tests.eq(public.confirm_recurring_occurrence(tests.id('rule:Rent'),
  (select next_due_date from public.recurring_rules where id = tests.id('rule:Rent'))) is not null, true, 'confirm upcoming date early');
select tests.eq((select count(*) from public.recurring_occurrences where rule_id = tests.id('rule:Rent') and status = 'confirmed'), 3::bigint, 'early confirm recorded');
select tests.eq((select next_due_date from public.recurring_rules where id = tests.id('rule:Rent')) > tests.today() + 20, true, 'early confirm advances the rule');

-- Changing the schedule continues after the last generated occurrence.
update public.recurring_rules set cadence = 'weekly' where id = tests.id('rule:Rent');
select tests.eq((select next_due_date > (select max(due_date) from public.recurring_occurrences where rule_id = tests.id('rule:Rent'))
                 from public.recurring_rules where id = tests.id('rule:Rent')), true, 'schedule edit never re-issues past dates');

-- Pausing and resuming does not back-fill the paused period.
insert into public.recurring_rules (name, type, amount_minor, account_id, cadence, start_date)
values ('Gym', 'expense', 150000, tests.id('HDFC Savings'), 'daily', tests.today() - 10);
update public.recurring_rules set active = false where name = 'Gym';
update public.recurring_rules set active = true where name = 'Gym';
select tests.eq((select next_due_date from public.recurring_rules where name = 'Gym'), tests.today(), 'resume starts from today');

reset role;

-- -----------------------------------------------------------------------------
-- RLS: user B sees and touches nothing of user A's
-- -----------------------------------------------------------------------------

set role authenticated;
select tests.login(tests.id('B'));

select tests.eq((select count(*) from public.accounts), 0::bigint, 'B sees no accounts');
select tests.eq((select count(*) from public.transactions), 0::bigint, 'B sees no transactions');
select tests.eq((select count(*) from public.transfers), 0::bigint, 'B sees no transfers');
select tests.eq((select count(*) from public.account_balances), 0::bigint, 'B sees no balances');
select tests.eq((select count(*) from public.ledger_entries), 0::bigint, 'B sees no feed');
select tests.eq((select count(*) from public.recurring_rules), 0::bigint, 'B sees no rules');
select tests.eq((select count(*) from public.recurring_occurrences), 0::bigint, 'B sees no occurrences');
select tests.eq((select count(*) from public.profiles), 1::bigint, 'B sees only own profile');
select tests.eq((select count(*) from public.categories where user_id = tests.id('A')), 0::bigint, 'B sees none of A''s categories');
select tests.eq((select income_minor from public.period_summary('-infinity', 'infinity')), 0::bigint, 'B summary is empty');

select tests.throws($$insert into public.transactions (account_id, type, amount_minor) values (tests.id('Wallet'), 'expense', 100)$$,
  'Choose one of your accounts', 'B cannot post to A''s account');
select tests.throws($$insert into public.transactions (user_id, account_id, type, amount_minor) values (tests.id('A'), tests.id('Wallet'), 'expense', 100)$$,
  'Choose one of your accounts', 'B cannot write transactions as A');
select tests.throws($$insert into public.categories (user_id, name, transaction_type) values (tests.id('A'), 'Sneaky', 'expense')$$,
  'row-level security', 'B cannot create categories for A');

update public.transactions set amount_minor = 1 where id = tests.id('Shoes');
update public.accounts set opening_balance_minor = 0 where id = tests.id('Wallet');
delete from public.categories where user_id = tests.id('A');
select tests.throws($$select public.confirm_recurring_occurrence(tests.id('rule:Rent'), current_date)$$,
  'not found', 'B cannot confirm A''s recurring item');
select tests.throws($$select public.seed_default_categories(tests.id('A'))$$,
  'permission denied', 'seeding helper is not callable');

-- B builds own account and wipes own data; A must be untouched.
insert into public.accounts (name, type, opening_balance_minor) values ('B bank', 'bank', 1000);
select public.delete_all_my_data();
select tests.eq((select count(*) from public.accounts), 0::bigint, 'B wipe removed B''s accounts');
select tests.eq((select count(*) from public.categories), 20::bigint, 'B wipe re-seeded default categories');

reset role;

select tests.eq((select amount_minor from public.transactions where id = tests.id('Shoes')), 300000::bigint, 'A''s transaction untouched by B');
select tests.eq((select opening_balance_minor from public.accounts where id = tests.id('Wallet')), 200000::bigint, 'A''s account untouched by B');
select tests.eq((select count(*) from public.categories where user_id = tests.id('A')), 20::bigint, 'A''s categories untouched by B');
select tests.eq((select count(*) from public.accounts where user_id = tests.id('A')), 4::bigint, 'A''s accounts survive B''s wipe');

-- -----------------------------------------------------------------------------
-- Anonymous visitors get nothing
-- -----------------------------------------------------------------------------

set role anon;
select tests.throws($$select * from public.accounts$$, 'permission denied', 'anon cannot read accounts');
select tests.throws($$select * from public.account_balances$$, 'permission denied', 'anon cannot read balances');
select tests.throws($$select * from public.period_summary(now(), now())$$, 'permission denied', 'anon cannot call reports');
reset role;

\echo 'All ledger tests passed.'
